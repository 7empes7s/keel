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

export async function verifyChain(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT seq, tenant_ref, occurred_at, kind, subject, actor, prev_hash, record_hash
     FROM evidence
     WHERE tenant_ref = $1
     ORDER BY seq`,
    [tenantRef],
  );
  const { rows: headRows } = await client.query(
    `SELECT head_seq, head_hash, record_count
     FROM evidence_head
     WHERE tenant_ref = $1`,
    [tenantRef],
  );

  let prevHash = null;
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
      return { ok: false, brokenAtSeq: row.seq };
    }
    prevHash = row.record_hash;
  }

  const head = headRows[0];
  const actualHead = rows.at(-1);
  if (
    (rows.length && !head)
    || (head && (
      head.head_seq !== actualHead?.seq
      || head.head_hash !== actualHead?.record_hash
      || head.record_count !== String(rows.length)
    ))
  ) {
    return {
      ok: false,
      reason: 'truncated',
      expectedSeq: head?.head_seq ?? null,
      actualSeq: actualHead?.seq ?? null,
    };
  }

  return { ok: true };
}

// Residual risk: an actor with write access to both evidence and evidence_head can still forge a
// consistent chain. The anchor raises the bar from deleting a row to rewriting the whole chain and
// its anchor atomically; genuine non-repudiation needs periodic anchoring outside this database,
// signing the head hash to an append-only external store. That is out of M2 scope.
