import { sameContent } from '../cir/canonicalHash.mjs';

/**
 * SQL predicate: this drift row (alias `d`) records a change in content. A 'modified'
 * row marked same_content (schema.d/77) only had different stored hashes; it is never
 * listed, counted or acted on as a change. NULL (not checked yet) is kept.
 */
export const RECORDED_CHANGE_PREDICATE = '(d.same_content IS NOT TRUE)';

/** SQL predicate for an open drift. Consumers must alias the drift table as `d`. */
export const OPEN_DRIFT_PREDICATE = `
  (${RECORDED_CHANGE_PREDICATE} AND (
    NOT EXISTS (
      SELECT 1 FROM disposition p WHERE p.drift_id = d.id
    )
    OR (
      EXISTS (
        SELECT 1 FROM disposition p
        WHERE p.drift_id = d.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM disposition p
        WHERE p.drift_id = d.id
          AND (p.action <> 'ignore' OR p.expires_at IS NULL OR p.expires_at > now())
      )
    )
  ))
`;

/**
 * SQL predicate: something has already acted on this drift row (alias `d`): a decision
 * (any disposition, even an expired ignore) or an auto remediation that has finished,
 * including one whose job ended without recording its outcome (a cancelled job).
 * Drift detection never reuses such a row for a change it sees again.
 */
export const DRIFT_ACTED_ON_PREDICATE = `
  (
    EXISTS (SELECT 1 FROM disposition p WHERE p.drift_id = d.id)
    OR EXISTS (
      SELECT 1 FROM auto_remediation_execution e
        JOIN job j ON j.id = e.job_id
       WHERE e.drift_id = d.id
         AND (e.status IN ('executed', 'failed') OR j.status IN ('succeeded', 'failed', 'cancelled'))
    )
  )
`;

/**
 * SQL predicate: this drift row (alias `d`) is ignored right now. It has an ignore that
 * has not expired, no other kind of decision, and no finished or cancelled auto
 * remediation. Drift detection keeps such a row for the same change seen again, so the
 * change stays ignored until the setting changes again or the ignore runs out.
 */
export const DRIFT_IGNORED_PREDICATE = `
  (
    EXISTS (
      SELECT 1 FROM disposition p
       WHERE p.drift_id = d.id AND p.action = 'ignore'
         AND (p.expires_at IS NULL OR p.expires_at > now())
    )
    AND NOT EXISTS (
      SELECT 1 FROM disposition p WHERE p.drift_id = d.id AND p.action <> 'ignore'
    )
    AND NOT EXISTS (
      SELECT 1 FROM auto_remediation_execution e
        JOIN job j ON j.id = e.job_id
       WHERE e.drift_id = d.id
         AND (e.status IN ('executed', 'failed') OR j.status IN ('succeeded', 'failed', 'cancelled'))
    )
  )
`;

/**
 * Checks every 'modified' drift row of the tenant not checked yet (same_content NULL,
 * schema.d/77) and marks whether its two payloads hold the same content under the
 * current field rules (cir/canonicalHash.mjs sameContent). A row recorded only because
 * a stored hash predates a server-owned rule is marked true and drops out of every
 * list of changes; the row itself is kept. Drift detection calls this after recording,
 * and open-drift evaluation before it reads, so rows from before the check are marked
 * by the first of either after a deploy. Batched so
 * the payloads of many rows are never held at once. Returns how many rows were marked
 * the same content.
 */
export async function markSameContentDrift(client, { tenantRef, batchSize = 200 }) {
  let marked = 0;
  let after = null;
  for (;;) {
    // Keyset on id, so each batch starts where the last stopped (drift_unchecked_idx).
    const { rows } = await client.query(
      `SELECT id, resource_type, before_hash, after_hash, before_payload, after_payload
         FROM drift
        WHERE tenant_ref = $1 AND change_type = 'modified' AND same_content IS NULL
          AND before_payload IS NOT NULL AND after_payload IS NOT NULL
          AND ($3::uuid IS NULL OR id > $3::uuid)
        ORDER BY id
        LIMIT $2`,
      [tenantRef, batchSize, after],
    );
    if (rows.length === 0) return marked;
    after = rows[rows.length - 1].id;
    const same = rows.filter((row) => sameContent(
      { payload_hash: row.before_hash, payload: row.before_payload },
      { payload_hash: row.after_hash, payload: row.after_payload },
      row.resource_type,
    )).map((row) => row.id);
    const ids = rows.map((row) => row.id);
    await client.query(
      'UPDATE drift SET same_content = (id = ANY($2::uuid[])) WHERE id = ANY($1::uuid[])',
      [ids, same],
    );
    marked += same.length;
  }
}
