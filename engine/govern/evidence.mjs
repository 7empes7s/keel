import { envelopeForEvidence, redactPayload, createEventSink } from '../telemetry/events.mjs';
import { createHash } from 'node:crypto';
import { canonicalize } from '../cir/canonicalHash.mjs';

function evidenceHash({ prevHash, tenantRef, occurredAt, kind, subject, actor }) {
  return createHash('sha256')
    .update(
      `${prevHash ?? ''}${tenantRef}${occurredAt.toISOString()}${kind}`
      + `${JSON.stringify(canonicalize(subject, 'group'))}${actor}`,
    )
    .digest('hex');
}

/** Spec M2.6.4. Append-only, tamper-evident: each record embeds the previous record's hash. */
export async function appendEvidence(client, {
  tenantRef, kind, subject, actor,
  correlationId = process.env.KEEL_EVENT_CORRELATION_ID,
  eventSink = createEventSink(),
}) {
  let record;
  await client.query('BEGIN');
  try {
    record = await appendEvidenceInTransaction(client, { tenantRef, kind, subject, actor, correlationId });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  // A logging failure must never roll back or misreport committed audit evidence.
  try { eventSink(envelopeForEvidence(record)); } catch { /* best-effort projection */ }
  return record;
}

// The same append for a caller that already holds an open transaction (accepting a
// change writes its record in the same transaction as the accept). Every writer of the
// evidence table goes through here: it takes the tenant's lock, chains onto the stored
// head and moves the head, so the chain check sees one unbroken record.
export async function appendEvidenceInTransaction(client, {
  tenantRef, kind, subject, actor,
  correlationId = process.env.KEEL_EVENT_CORRELATION_ID,
}) {
  subject = redactPayload(subject);
  actor = redactPayload(actor);
  if (correlationId) {
    subject = { ...subject, _event: { version: 1, correlationId } };
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tenantRef]);
  const { rows: headRows } = await client.query(
    `SELECT head_hash, record_count
     FROM evidence_head
     WHERE tenant_ref = $1
     FOR UPDATE`,
    [tenantRef],
  );
  const prevHash = headRows[0]?.head_hash ?? null;
  const occurredAt = new Date();
  const recordHash = evidenceHash({ prevHash, tenantRef, occurredAt, kind, subject, actor });
  const { rows } = await client.query(
    `INSERT INTO evidence
       (tenant_ref, occurred_at, kind, subject, actor, prev_hash, record_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING seq`,
    [tenantRef, occurredAt, kind, subject, actor, prevHash, recordHash],
  );

  await client.query(
    `INSERT INTO evidence_head (tenant_ref, head_seq, head_hash, record_count)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_ref) DO UPDATE
     SET head_seq = EXCLUDED.head_seq,
         head_hash = EXCLUDED.head_hash,
         record_count = EXCLUDED.record_count,
         updated_at = now()`,
    [tenantRef, rows[0].seq, recordHash, BigInt(headRows[0]?.record_count ?? 0) + 1n],
  );

  return { seq: rows[0].seq, tenant_ref: tenantRef, occurred_at: occurredAt,
    kind, subject, actor, prev_hash: prevHash, record_hash: recordHash };
}

// Walks the chain from `start` (a prefix verified earlier: { seq, hash, count }) or from
// the first record, and checks the stored head against the walked tip. Records are read
// and hashed a page at a time, yielding between pages, so a full walk of a large record
// never holds the event loop (or memory) for the whole chain at once.
export const CHAIN_WALK_PAGE = 2000;

async function walkChain(client, tenantRef, start = null, { pageSize = CHAIN_WALK_PAGE } = {}) {
  const limit = Math.max(1, Math.trunc(Number(pageSize)) || CHAIN_WALK_PAGE);
  let prevHash = start?.hash ?? null;
  let walked = 0n;
  let last = null;
  let after = start?.seq ?? null;
  for (;;) {
    const { rows } = await client.query(
      `SELECT seq, tenant_ref, occurred_at, kind, subject, actor, prev_hash, record_hash
       FROM evidence
       WHERE tenant_ref = $1 AND ($2::bigint IS NULL OR seq > $2)
       ORDER BY seq
       LIMIT ${limit}`,
      [tenantRef, after],
    );
    for (const row of rows) {
      const expectedHash = evidenceHash({
        prevHash,
        tenantRef: row.tenant_ref,
        occurredAt: row.occurred_at,
        kind: row.kind,
        subject: row.subject,
        actor: row.actor,
      });
      if (row.prev_hash !== prevHash || row.record_hash !== expectedHash) {
        return { result: { ok: false, brokenAtSeq: row.seq }, tip: null };
      }
      prevHash = row.record_hash;
    }
    walked += BigInt(rows.length);
    if (rows.length) {
      last = rows.at(-1);
      after = last.seq;
    }
    if (rows.length < limit) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const { rows: headRows } = await client.query(
    `SELECT head_seq, head_hash, record_count
     FROM evidence_head
     WHERE tenant_ref = $1`,
    [tenantRef],
  );

  const count = BigInt(start?.count ?? 0) + walked;
  const tip = last ? { seq: String(last.seq), hash: last.record_hash, count: String(count) } : start;
  const head = headRows[0];
  if (
    (count > 0n && !head)
    || (head && (
      String(head.head_seq) !== tip?.seq
      || head.head_hash !== tip?.hash
      || head.record_count !== String(count)
    ))
  ) {
    return {
      result: {
        ok: false,
        reason: 'truncated',
        expectedSeq: head?.head_seq ?? null,
        actualSeq: tip?.seq ?? null,
      },
      tip: null,
    };
  }

  return { result: { ok: true }, tip };
}

export async function verifyChain(client, { tenantRef }) {
  return (await walkChain(client, tenantRef)).result;
}

// Security audit run 2, finding 10: a page that shows chain integrity on every load must
// not re-hash the whole chain each time. After one full walk, a later call hashes only the
// records added since, provided the verified prefix is unchanged. "Unchanged" is checked
// by the database without loading any record: every UPDATE, or DELETE and re-INSERT,
// gives a row a new xmin, so the row count and a sum of per-row hashes of (seq, xmin) up
// to the verified tip fingerprint the stored prefix. The sum is additive, so moving the
// tip forward adds the new records' part instead of re-reading the whole prefix, and it
// needs no sort. Any mismatch, or a cache older than `fullEveryMs`, falls back to a full
// walk; a broken result is never cached.
//
// Call it inside one REPEATABLE READ transaction (verifyAnchoredChain does), so the
// fingerprint and the walk see the same rows.
//
// A long-lived caller (the portal) also runs refreshChainCache on a timer with a shorter
// `fullEveryMs`, so the periodic full walk happens there and never on a page load.
export const CHAIN_FULL_VERIFY_MS = 10 * 60 * 1000;

async function rangeFingerprint(client, tenantRef, afterSeq, throughSeq) {
  const { rows } = await client.query(
    `SELECT count(*)::text AS count,
            coalesce(sum(hashtextextended(seq::text || ':' || xmin::text, 0)), 0)::text AS versions
     FROM evidence
     WHERE tenant_ref = $1 AND ($2::bigint IS NULL OR seq > $2) AND seq <= $3`,
    [tenantRef, afterSeq, throughSeq],
  );
  return { count: rows[0].count, versions: rows[0].versions };
}

function addFingerprints(a, b) {
  return {
    count: String(BigInt(a.count) + BigInt(b.count)),
    versions: String(BigInt(a.versions) + BigInt(b.versions)),
  };
}

const sameFingerprint = (a, b) => a?.count === b?.count && a?.versions === b?.versions;

// Per cache: a generation per tenant, bumped whenever a broken result drops the entry, so
// a check that started before the break never writes a stale "ok" back; and the full
// walk in progress per tenant, so callers that find no entry share one walk instead of
// each walking the whole chain (the portal's warm-up at start and the first page loads).
// Kept on globalThis like the portal's cache: a bundler may load this module more than
// once (the portal's start-up timer and its pages are separate bundles), and every copy
// must see the same state.
const generations = (globalThis[Symbol.for('keel.evidenceChain.generations')] ??= new WeakMap());
const fullWalks = (globalThis[Symbol.for('keel.evidenceChain.fullWalks')] ??= new WeakMap());

function perCache(store, cache) {
  let map = store.get(cache);
  if (!map) store.set(cache, map = new Map());
  return map;
}

function invalidate(cache, tenantRef) {
  cache.delete(tenantRef);
  const gens = perCache(generations, cache);
  gens.set(tenantRef, (gens.get(tenantRef) ?? 0) + 1);
  perCache(fullWalks, cache).delete(tenantRef);
}

async function checkChain(client, { tenantRef, cache, now, fullEveryMs, pageSize }) {
  const generation = perCache(generations, cache).get(tenantRef) ?? 0;
  const entry = cache.get(tenantRef);
  let start = null;
  if (entry?.tip && now - entry.fullAt < fullEveryMs
    && sameFingerprint(await rangeFingerprint(client, tenantRef, null, entry.tip.seq), entry.fingerprint)) {
    start = entry.tip;
  }
  const { result, tip } = await walkChain(client, tenantRef, start, { pageSize });
  if (!result.ok || !tip) {
    invalidate(cache, tenantRef);
    return result;
  }
  if ((perCache(generations, cache).get(tenantRef) ?? 0) !== generation) return result;
  let fingerprint;
  if (!start) fingerprint = await rangeFingerprint(client, tenantRef, null, tip.seq);
  else if (tip.seq === start.seq) fingerprint = entry.fingerprint;
  else fingerprint = addFingerprints(entry.fingerprint, await rangeFingerprint(client, tenantRef, start.seq, tip.seq));
  // Never move the full-walk time backwards: a full walk that finished while this check
  // ran (the timer's) already wrote a newer one.
  const fullAt = start ? Math.max(entry.fullAt, cache.get(tenantRef)?.fullAt ?? 0) : now;
  cache.set(tenantRef, { tip, fingerprint, fullAt });
  return result;
}

export async function verifyChainCached(client, {
  tenantRef, cache, now = Date.now(), fullEveryMs = CHAIN_FULL_VERIFY_MS, pageSize = CHAIN_WALK_PAGE,
}) {
  const walks = perCache(fullWalks, cache);
  const cold = !cache.has(tenantRef);
  const running = walks.get(tenantRef);
  if (cold && running) {
    // Wait for the walk already running, then check in this caller's own snapshot: the
    // cache is warm by then, so that costs one fingerprint plus any new records, and an
    // edit committed after the shared walk began is still caught. A broken result stands
    // (a chain does not mend itself); a failed walk leaves this caller to check alone.
    const shared = await running.catch(() => null);
    if (shared && !shared.ok) return shared;
    return checkChain(client, { tenantRef, cache, now, fullEveryMs, pageSize });
  }
  const check = checkChain(client, { tenantRef, cache, now, fullEveryMs, pageSize });
  if (!cold) return check;
  walks.set(tenantRef, check);
  try { return await check; } finally { if (walks.get(tenantRef) === check) walks.delete(tenantRef); }
}

// The timer side of the cache, for a long-lived caller: one check in its own snapshot, with
// the full walk due `2 * refreshEveryMs` before a page load would fall back to doing it,
// so while the timer runs every refreshEveryMs no page load waits on a full walk.
export const CHAIN_REFRESH_MS = 60 * 1000;

export async function refreshChainCache(client, {
  tenantRef, cache, now = Date.now(), refreshEveryMs = CHAIN_REFRESH_MS, pageSize = CHAIN_WALK_PAGE,
}) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const result = await verifyChainCached(client, {
      tenantRef, cache, now, pageSize,
      fullEveryMs: Math.max(0, CHAIN_FULL_VERIFY_MS - 2 * refreshEveryMs),
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// This checks internal consistency only. Operator-facing verification uses
// verifyAnchoredChain in anchor.mjs to compare an independently trusted checkpoint.
