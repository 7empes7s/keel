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
  subject = redactPayload(subject);
  actor = redactPayload(actor);
  if (correlationId) {
    subject = { ...subject, _event: { version: 1, correlationId } };
  }
  let record;
  await client.query('BEGIN');
  try {
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

    record = { seq: rows[0].seq, tenant_ref: tenantRef, occurred_at: occurredAt,
      kind, subject, actor, prev_hash: prevHash, record_hash: recordHash };
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  // A logging failure must never roll back or misreport committed audit evidence.
  try { eventSink(envelopeForEvidence(record)); } catch { /* best-effort projection */ }
  return record;
}

// Walks the chain from `start` (a prefix verified earlier: { seq, hash, count }) or from
// the first record, and checks the stored head against the walked tip.
async function walkChain(client, tenantRef, start = null) {
  const { rows } = await client.query(
    `SELECT seq, tenant_ref, occurred_at, kind, subject, actor, prev_hash, record_hash
     FROM evidence
     WHERE tenant_ref = $1 AND ($2::bigint IS NULL OR seq > $2)
     ORDER BY seq`,
    [tenantRef, start?.seq ?? null],
  );
  const { rows: headRows } = await client.query(
    `SELECT head_seq, head_hash, record_count
     FROM evidence_head
     WHERE tenant_ref = $1`,
    [tenantRef],
  );

  let prevHash = start?.hash ?? null;
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

  const count = BigInt(start?.count ?? 0) + BigInt(rows.length);
  const last = rows.at(-1);
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
// gives a row a new xmin, so the ordered list of xmins (and the row count) up to the
// verified tip is a fingerprint of the stored prefix. Any mismatch, or a cache older than
// `fullEveryMs`, falls back to a full walk; a broken result is never cached.
//
// Call it inside one REPEATABLE READ transaction (verifyAnchoredChain does), so the
// fingerprint and the walk see the same rows.
export const CHAIN_FULL_VERIFY_MS = 10 * 60 * 1000;

async function prefixFingerprint(client, tenantRef, throughSeq) {
  const { rows } = await client.query(
    `SELECT count(*)::text AS count, md5(string_agg(xmin::text, ',' ORDER BY seq)) AS versions
     FROM evidence
     WHERE tenant_ref = $1 AND seq <= $2`,
    [tenantRef, throughSeq],
  );
  return `${rows[0].count}:${rows[0].versions ?? ''}`;
}

export async function verifyChainCached(client, {
  tenantRef, cache, now = Date.now(), fullEveryMs = CHAIN_FULL_VERIFY_MS,
}) {
  const entry = cache.get(tenantRef);
  let start = null;
  if (entry?.tip && now - entry.fullAt < fullEveryMs
    && await prefixFingerprint(client, tenantRef, entry.tip.seq) === entry.fingerprint) {
    start = entry.tip;
  }
  const { result, tip } = await walkChain(client, tenantRef, start);
  if (!result.ok || !tip) {
    cache.delete(tenantRef);
    return result;
  }
  const fingerprint = start && tip.seq === start.seq
    ? entry.fingerprint
    : await prefixFingerprint(client, tenantRef, tip.seq);
  cache.set(tenantRef, { tip, fingerprint, fullAt: start ? entry.fullAt : now });
  return result;
}

// This checks internal consistency only. Operator-facing verification uses
// verifyAnchoredChain in anchor.mjs to compare an independently trusted checkpoint.
