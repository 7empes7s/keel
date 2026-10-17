import { DRIFT_ACTED_ON_PREDICATE, OPEN_DRIFT_PREDICATE } from './openDrift.mjs';
import { evaluateDrift } from '../policy/evaluate.mjs';
import { executeAutoRemediation } from '../policy/execute.mjs';

export async function createBaseline(client, { tenantRef, setBy }) {
  const { rows } = await client.query(
    `INSERT INTO baseline (tenant_ref, set_by) VALUES ($1, $2) RETURNING id`,
    [tenantRef, setBy],
  );
  return rows[0].id;
}

export async function seedBaselineFromSnapshot(client, { baselineId, snapshotId }) {
  await client.query(
    `INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id)
     SELECT $1, natural_key, id
     FROM resource_version
     WHERE snapshot_id = $2`,
    [baselineId, snapshotId],
  );
}

export async function getActiveBaseline(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT * FROM baseline WHERE tenant_ref = $1 AND active = true LIMIT 1`,
    [tenantRef],
  );
  return rows[0] ?? null;
}

export async function recordDrift(client, {
  tenantRef, baselineId, observedSnapshot, naturalKey, resourceType, changeType,
  beforeHash, afterHash, beforePayload, afterPayload, blastRadius,
}) {
  const rows = await reuseUndecidedDrift(client, {
    tenantRef, baselineId, naturalKey, changeType, beforeHash, afterHash,
  }) ?? (await client.query(
    `INSERT INTO drift
       (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
        before_hash, after_hash, before_payload, after_payload, blast_radius)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      tenantRef, baselineId, observedSnapshot, naturalKey, resourceType, changeType,
      beforeHash ?? null, afterHash ?? null, beforePayload ?? null, afterPayload ?? null, blastRadius,
    ],
  )).rows;
  // Policy evaluation is part of recording a newly detected drift row, rather
  // than a separate caller responsibility. That is what makes every drift
  // decision (including no match) explainable through the evidence chain.
  // A reused row is evaluated again on each run, as each run's new row was before, so
  // an auto remediation that was refused (kill switch, rate limit) is retried; one
  // still queued is returned as is (executeAutoRemediation), never queued twice.
  const { matches } = await evaluateDrift(client, { tenantRef, drift: rows[0] });
  // Plan task 19: evaluateDrift only recommends; an 'auto_remediate' outcome is acted
  // on here, immediately, by the same caller that recorded the drift — never a
  // separate, easy-to-forget wiring step.
  for (const match of matches) {
    if (match.outcome === 'auto_remediate') {
      await executeAutoRemediation(client, { tenantRef, drift: rows[0], policyId: match.policyId });
    }
  }
  return rows[0].id;
}

/**
 * A drift-detect run that still sees the same change keeps that change's row instead of
 * adding another one per run. The newest row for the resource against this baseline is
 * reused, unchanged, when it records the same difference (change type and both hashes)
 * and nothing has acted on it yet (DRIFT_ACTED_ON_PREDICATE: no disposition, not even an
 * expired ignore, and no finished or cancelled auto remediation). The row stays the record of when and in which collection
 * KEEL first saw the change. A row something acted on gets a new row when the change is
 * seen again, so a failed or undone auto remediation runs again for it. Returns the
 * reused row, or null when a new row is needed.
 */
async function reuseUndecidedDrift(client, {
  tenantRef, baselineId, naturalKey, changeType, beforeHash, afterHash,
}) {
  const { rows: [latest] } = await client.query(
    `SELECT d.*,
            ${DRIFT_ACTED_ON_PREDICATE} AS acted_on
       FROM drift d
      WHERE d.tenant_ref = $1 AND d.baseline_id = $2 AND d.natural_key = $3
      ORDER BY d.detected_at DESC, d.id DESC
      LIMIT 1`,
    [tenantRef, baselineId, naturalKey],
  );
  if (!latest || latest.acted_on) return null;
  if (latest.change_type !== changeType
    || latest.before_hash !== (beforeHash ?? null)
    || latest.after_hash !== (afterHash ?? null)) return null;
  const { acted_on: _actedOn, ...row } = latest;
  return [row];
}

export async function listOpenDrift(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT d.*
     FROM drift d
     WHERE d.tenant_ref = $1
       AND ${OPEN_DRIFT_PREDICATE}
     ORDER BY d.detected_at, d.id`,
    [tenantRef],
  );
  return rows;
}

/**
 * The open changes against one baseline, one row per resource. Drift-detect runs before
 * reuseUndecidedDrift recorded a fresh row for each difference they still saw, so an
 * older long-lived change can have a row per run. Only the newest row for a resource
 * says where it stands: open when it has no closing disposition, settled when it was
 * accepted or ignored. Ids are picked first so the payloads of superseded rows are never
 * read.
 */
export async function listLatestOpenDrift(client, { tenantRef, baselineId }) {
  const { rows } = await client.query(
    `WITH latest AS (
       SELECT DISTINCT ON (natural_key) id
         FROM drift
        WHERE tenant_ref = $1 AND baseline_id = $2
        ORDER BY natural_key, detected_at DESC, id DESC
     )
     SELECT d.*
       FROM drift d
       JOIN latest ON latest.id = d.id
      WHERE ${OPEN_DRIFT_PREDICATE}
      ORDER BY d.detected_at, d.id`,
    [tenantRef, baselineId],
  );
  return rows;
}

export async function recordDisposition(client, {
  driftId, action, actor, reason, expiresAt, planId,
}) {
  const { rows } = await client.query(
    `INSERT INTO disposition (drift_id, action, actor, reason, expires_at, plan_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [driftId, action, actor, reason, expiresAt ?? null, planId ?? null],
  );
  return rows[0].id;
}
