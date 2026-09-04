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
export async function appendEvidence(client, { tenantRef, kind, subject, actor }) {
  const { rows: headRows } = await client.query(
    `SELECT record_hash
     FROM evidence
     WHERE tenant_ref = $1
     ORDER BY seq DESC
     LIMIT 1
     FOR UPDATE`,
    [tenantRef],
  );
  const prevHash = headRows[0]?.record_hash ?? null;
  const occurredAt = new Date();

  await client.query(
    `INSERT INTO evidence
       (tenant_ref, occurred_at, kind, subject, actor, prev_hash, record_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      tenantRef,
      occurredAt,
      kind,
      subject,
      actor,
      prevHash,
      evidenceHash({ prevHash, tenantRef, occurredAt, kind, subject, actor }),
    ],
  );
}

export async function verifyChain(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT seq, tenant_ref, occurred_at, kind, subject, actor, prev_hash, record_hash
     FROM evidence
     WHERE tenant_ref = $1
     ORDER BY seq`,
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

  return { ok: true };
}
