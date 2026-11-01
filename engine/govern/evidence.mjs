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
export async function appendEvidence(client, { eventSink = createEventSink(), ...entry }) {
  let written;
  await client.query('BEGIN');
  try {
    written = await appendEvidenceInTransaction(client, { ...entry, eventSink });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  written.emit();
  return written.record;
}

/**
 * The same record, written inside a transaction the caller has open, so the record and
 * the change it describes commit or roll back together. The caller calls `emit()` after
 * its COMMIT (never after a ROLLBACK) to project the record as an event.
 */
export async function appendEvidenceInTransaction(client, {
  tenantRef, kind, subject, actor,
  correlationId = process.env.KEEL_EVENT_CORRELATION_ID,
  eventSink = createEventSink(),
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

  const record = { seq: rows[0].seq, tenant_ref: tenantRef, occurred_at: occurredAt,
    kind, subject, actor, prev_hash: prevHash, record_hash: recordHash };
  // A logging failure must never roll back or misreport committed audit evidence.
  const emit = () => { try { eventSink(envelopeForEvidence(record)); } catch { /* best-effort projection */ } };
  return { record, emit };
}

// A known break: a stretch of the chain that a code bug broke (31 Oct 2026: accepting a
// change wrote its record without the tenant lock and without moving the head, PR #876).
// Old records are never edited, so the explanation is a new record of its own, appended
// through the normal locked writer. The check accepts a break only when:
//   - its seq is listed in an explanation record written after it (the explanation itself
//     must pass the walk like any other record);
//   - the broken record is consistent with its own stored prev_hash; and
//   - that prev_hash is the hash of an earlier record inside the explained stretch (from
//     earliestPrevSeq on), which is exactly what the bug produced: a record chained onto
//     a stale head.
// The explanation also pins the whole stretch: a digest over every (seq, record_hash) from
// earliestPrevSeq through throughSeq and their count. The accept records the bug wrote
// are orphans (no later record chains onto them), so without the pin one could be edited
// and re-hashed, or deleted, and the check would not notice.
// Any other break, inside or outside the stretch, still fails the check. The explanation
// also names how far the stored head's record count fell behind (the bypassing writer
// never counted its records), so the count is checked against head + that shortfall.
export const CHAIN_BREAK_EXPLAINED = 'chain-break-explained';

const SEQ_TEXT = /^[1-9][0-9]*$/;
const COUNT_TEXT = /^(0|[1-9][0-9]*)$/;
const MAX_EXPLAINED_BREAKS = 100_000;

function parseExplanation(row) {
  const s = row.subject ?? {};
  const seqs = [s.fromSeq, s.throughSeq, s.earliestPrevSeq];
  if (!seqs.every((value) => typeof value === 'string' && SEQ_TEXT.test(value))) return null;
  if (typeof s.headCountShortBy !== 'string' || !COUNT_TEXT.test(s.headCountShortBy)) return null;
  if (typeof s.stretchDigest !== 'string' || !/^[a-f0-9]{64}$/.test(s.stretchDigest)) return null;
  if (typeof s.stretchRows !== 'string' || !SEQ_TEXT.test(s.stretchRows)) return null;
  if (!Array.isArray(s.breakSeqs) || !s.breakSeqs.length || s.breakSeqs.length > MAX_EXPLAINED_BREAKS) return null;
  const from = BigInt(s.fromSeq);
  const through = BigInt(s.throughSeq);
  const earliest = BigInt(s.earliestPrevSeq);
  const seq = BigInt(row.seq);
  if (!(earliest < from && from <= through && through < seq)) return null;
  const breaks = new Set();
  for (const value of s.breakSeqs) {
    if (typeof value !== 'string' || !SEQ_TEXT.test(value)) return null;
    const at = BigInt(value);
    if (at < from || at > through) return null;
    breaks.add(value);
  }
  return {
    seq: String(row.seq),
    from, through, earliest, breaks,
    shortBy: BigInt(s.headCountShortBy),
    digest: s.stretchDigest,
    rows: BigInt(s.stretchRows),
    // Filled during the walk: the stretch's hashes, digest and row count.
    hashes: new Set(),
    running: createHash('sha256'),
    seen: 0n,
    summary: {
      explainedBySeq: String(row.seq),
      explainedAt: new Date(row.occurred_at).toISOString(),
      fromSeq: s.fromSeq,
      throughSeq: s.throughSeq,
      breakCount: breaks.size,
      ...(typeof s.cause === 'string' ? { cause: s.cause } : {}),
      ...(typeof s.fixRef === 'string' ? { fixRef: s.fixRef } : {}),
      ...(typeof s.firstBreakAt === 'string' ? { firstBreakAt: s.firstBreakAt } : {}),
      ...(typeof s.lastBreakAt === 'string' ? { lastBreakAt: s.lastBreakAt } : {}),
    },
  };
}

const stretchLine = (seq, recordHash) => `${seq}:${recordHash}\n`;

async function loadExplanations(client, tenantRef, afterSeq) {
  const { rows } = await client.query(
    `SELECT seq, occurred_at, subject
     FROM evidence
     WHERE tenant_ref = $1 AND kind = $2 AND ($3::bigint IS NULL OR seq > $3)
     ORDER BY seq`,
    [tenantRef, CHAIN_BREAK_EXPLAINED, afterSeq],
  );
  return rows.map(parseExplanation).filter(Boolean);
}

// Walks the chain from `start` (a prefix verified earlier: { seq, hash, count } plus any
// known breaks it carried) or from the first record, and checks the stored head against
// the walked tip. Records are read and hashed a page at a time, yielding between pages,
// so a full walk of a large record never holds the event loop (or memory) for the whole
// chain at once.
export const CHAIN_WALK_PAGE = 2000;

async function walkChain(client, tenantRef, start = null, { pageSize = CHAIN_WALK_PAGE } = {}) {
  const limit = Math.max(1, Math.trunc(Number(pageSize)) || CHAIN_WALK_PAGE);
  const explanations = await loadExplanations(client, tenantRef, start?.seq ?? null);
  // An explanation whose stretch reaches back into the verified prefix needs the hashes
  // of that prefix: walk the whole chain instead.
  if (start && explanations.some((e) => e.earliest <= BigInt(start.seq))) {
    return walkChain(client, tenantRef, null, { pageSize });
  }
  const explainedBy = new Map();
  for (const e of explanations) for (const at of e.breaks) if (!explainedBy.has(at)) explainedBy.set(at, e);
  const walkedExplanations = new Set();

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
      const fields = {
        tenantRef: row.tenant_ref,
        occurredAt: row.occurred_at,
        kind: row.kind,
        subject: row.subject,
        actor: row.actor,
      };
      const seq = String(row.seq);
      if (row.prev_hash !== prevHash || row.record_hash !== evidenceHash({ prevHash, ...fields })) {
        const e = explainedBy.get(seq);
        const known = e
          && typeof row.prev_hash === 'string'
          && e.hashes.has(row.prev_hash)
          && row.record_hash === evidenceHash({ prevHash: row.prev_hash, ...fields });
        if (!known) return { result: { ok: false, brokenAtSeq: row.seq }, tip: null };
      }
      if (explanations.length) {
        const at = BigInt(row.seq);
        for (const e of explanations) {
          if (at < e.earliest || at > e.through) continue;
          e.hashes.add(row.record_hash);
          e.running.update(stretchLine(seq, row.record_hash));
          e.seen += 1n;
        }
      }
      if (row.kind === CHAIN_BREAK_EXPLAINED) walkedExplanations.add(seq);
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
  // Only explanations the walk itself verified count (in one snapshot, every loaded one is).
  const missing = explanations.find((e) => !walkedExplanations.has(e.seq));
  if (missing) return { result: { ok: false, brokenAtSeq: missing.seq }, tip: null };
  // Every record in an explained stretch must be exactly the one the explanation pinned.
  const changed = explanations.find((e) => e.seen !== e.rows || e.running.digest('hex') !== e.digest);
  if (changed) return { result: { ok: false, brokenAtSeq: changed.seq, reason: 'explained-stretch-changed' }, tip: null };
  const verified = explanations;
  const knownBreaks = [...(start?.knownBreaks ?? []), ...verified.map((e) => e.summary)];
  const shortBy = BigInt(start?.shortBy ?? 0) + verified.reduce((sum, e) => sum + e.shortBy, 0n);

  const { rows: headRows } = await client.query(
    `SELECT head_seq, head_hash, record_count
     FROM evidence_head
     WHERE tenant_ref = $1`,
    [tenantRef],
  );

  const count = BigInt(start?.count ?? 0) + walked;
  const tip = last
    ? { seq: String(last.seq), hash: last.record_hash, count: String(count), knownBreaks, shortBy: String(shortBy) }
    : start;
  const head = headRows[0];
  if (
    (count > 0n && !head)
    || (head && (
      String(head.head_seq) !== tip?.seq
      || head.head_hash !== tip?.hash
      || BigInt(head.record_count) + shortBy !== count
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

  return { result: knownBreaks.length ? { ok: true, knownBreaks } : { ok: true }, tip };
}

export async function verifyChain(client, { tenantRef }) {
  return (await walkChain(client, tenantRef)).result;
}

// Writes the explanation record for a stretch broken by a code bug, after checking that
// every break in the chain is inside the stretch and has the bug's shape (see
// CHAIN_BREAK_EXPLAINED above). Nothing old is edited: the explanation is appended
// through appendEvidenceInTransaction, under the tenant lock held for the whole check,
// so no record lands between the check and the write. Without `write` it only reports
// what it would record. It refuses (writes nothing) when:
//   - the chain has no break, or a break outside the stretch, or one without the shape;
//   - the stored head is not on the last record (the explanation would chain onto a
//     stale head and add a break of its own);
//   - an explanation record already exists.
export async function explainChainBreaks(client, {
  tenantRef, fromSeq, throughSeq, cause, fixRef, actor, write = false, pageSize = CHAIN_WALK_PAGE,
}) {
  for (const [name, value] of [['fromSeq', fromSeq], ['throughSeq', throughSeq]]) {
    if (typeof value !== 'string' || !SEQ_TEXT.test(value)) throw new Error(`${name} must be a record number`);
  }
  for (const [name, value] of [['cause', cause], ['fixRef', fixRef], ['actor', actor]]) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`);
  }
  const from = BigInt(fromSeq);
  const through = BigInt(throughSeq);
  if (from > through) throw new Error('fromSeq must not be after throughSeq');
  const limit = Math.max(1, Math.trunc(Number(pageSize)) || CHAIN_WALK_PAGE);

  let emit = null;
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tenantRef]);
    const refuse = (reason, extra = {}) => ({ ok: false, written: false, refused: reason, ...extra });
    const { rows: existing } = await client.query(
      'SELECT seq FROM evidence WHERE tenant_ref = $1 AND kind = $2 LIMIT 1',
      [tenantRef, CHAIN_BREAK_EXPLAINED],
    );
    let outcome;
    if (existing.length) {
      outcome = refuse('already-explained', { explainedBySeq: String(existing[0].seq) });
    } else {
      const seqOfHash = new Map();
      const walkedRows = [];
      const breaks = [];
      let prevHash = null;
      let count = 0n;
      let last = null;
      let after = null;
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
          const fields = {
            tenantRef: row.tenant_ref, occurredAt: row.occurred_at, kind: row.kind, subject: row.subject, actor: row.actor,
          };
          if (row.prev_hash !== prevHash || row.record_hash !== evidenceHash({ prevHash, ...fields })) {
            breaks.push({
              seq: String(row.seq),
              at: new Date(row.occurred_at).toISOString(),
              selfConsistent: typeof row.prev_hash === 'string'
                && row.record_hash === evidenceHash({ prevHash: row.prev_hash, ...fields }),
              chainedOnto: seqOfHash.get(row.prev_hash) ?? null,
            });
          }
          seqOfHash.set(row.record_hash, String(row.seq));
          walkedRows.push([BigInt(row.seq), row.record_hash]);
          prevHash = row.record_hash;
        }
        count += BigInt(rows.length);
        if (rows.length) {
          last = rows.at(-1);
          after = last.seq;
        }
        if (rows.length < limit) break;
      }
      const { rows: [head] } = await client.query(
        'SELECT head_seq, head_hash, record_count FROM evidence_head WHERE tenant_ref = $1 FOR UPDATE',
        [tenantRef],
      );
      const outside = breaks.filter((b) => BigInt(b.seq) < from || BigInt(b.seq) > through);
      const misshapen = breaks.filter((b) => !b.selfConsistent || b.chainedOnto === null || BigInt(b.chainedOnto) >= BigInt(b.seq));
      const shortBy = head ? count - BigInt(head.record_count) : null;
      const report = {
        records: String(count),
        breaks: breaks.length,
        firstBreak: breaks[0]?.seq ?? null,
        lastBreak: breaks.at(-1)?.seq ?? null,
        headSeq: head ? String(head.head_seq) : null,
        lastSeq: last ? String(last.seq) : null,
        headCountShortBy: shortBy === null ? null : String(shortBy),
      };
      if (!breaks.length) outcome = refuse('no-breaks', report);
      else if (outside.length) outcome = refuse('break-outside-range', { ...report, outside: outside.slice(0, 20).map((b) => b.seq), outsideCount: outside.length });
      else if (misshapen.length) outcome = refuse('break-not-explained-by-bug', { ...report, misshapen: misshapen.slice(0, 20), misshapenCount: misshapen.length });
      else if (!head || String(head.head_seq) !== String(last.seq) || head.head_hash !== last.record_hash) outcome = refuse('head-not-on-last-record', report);
      else if (shortBy < 0n) outcome = refuse('head-count-ahead', report);
      else {
        // The check keeps hashes from here on; it starts strictly before the stretch.
        const earliestPrevSeq = String(breaks.reduce((min, b) => (BigInt(b.chainedOnto) < min ? BigInt(b.chainedOnto) : min), from - 1n));
        const stretch = walkedRows.filter(([at]) => at >= BigInt(earliestPrevSeq) && at <= through);
        const digest = createHash('sha256');
        for (const [at, hash] of stretch) digest.update(stretchLine(String(at), hash));
        const subject = {
          summary: `${breaks.length} records between ${fromSeq} and ${throughSeq} were chained onto an older record because of a code bug, not a change to the records.`,
          cause: cause.trim(),
          fixRef: fixRef.trim(),
          fromSeq, throughSeq,
          earliestPrevSeq,
          breakSeqs: breaks.map((b) => b.seq),
          firstBreakAt: breaks[0].at,
          lastBreakAt: breaks.at(-1).at,
          headCountShortBy: String(shortBy),
          stretchDigest: digest.digest('hex'),
          stretchRows: String(stretch.length),
          headSeqBefore: String(head.head_seq),
          recordsBefore: String(count),
        };
        if (!write) {
          outcome = { ok: true, written: false, ...report, earliestPrevSeq };
        } else {
          const written = await appendEvidenceInTransaction(client, { tenantRef, kind: CHAIN_BREAK_EXPLAINED, subject, actor });
          ({ emit } = written);
          const { record } = written;
          outcome = { ok: true, written: true, explainedBySeq: String(record.seq), ...report, earliestPrevSeq };
        }
      }
    }
    await client.query(outcome.written ? 'COMMIT' : 'ROLLBACK');
    // The event goes out only after the record is committed, like every other writer.
    emit?.();
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
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
