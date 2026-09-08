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

async function appendAcceptanceEvidence(client, {
  tenantRef, drift, resourceVersionId, actor,
}) {
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
  const kind = 'disposition';
  const subject = {
    driftId: drift.id,
    naturalKey: drift.natural_key,
    resourceType: drift.resource_type,
    changeType: drift.change_type,
    beforeHash: drift.before_hash,
    afterHash: drift.after_hash,
    resourceVersionId,
  };

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

/** Spec M2.6.1. Accept repoints exactly ONE baseline_resource row — never the whole baseline. */
export async function acceptDrift(client, { driftId, actor, reason }) {
  await client.query('BEGIN');
  try {
    const { rows: driftRows } = await client.query(
      `SELECT *
       FROM drift
       WHERE id = $1
       FOR UPDATE`,
      [driftId],
    );
    const drift = driftRows[0];
    if (!drift) throw new Error(`drift not found: ${driftId}`);

    let resourceVersionId = null;
    if (drift.change_type !== 'removed') {
      const { rows: resourceVersionRows } = await client.query(
        `SELECT id
         FROM resource_version
         WHERE snapshot_id = $1 AND natural_key = $2`,
        [drift.observed_snapshot, drift.natural_key],
      );
      resourceVersionId = resourceVersionRows[0]?.id;
      if (!resourceVersionId) {
        throw new Error(`observed resource version not found for drift: ${driftId}`);
      }
    }

    if (drift.change_type === 'added') {
      await client.query(
        `INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id)
         VALUES ($1,$2,$3)`,
        [drift.baseline_id, drift.natural_key, resourceVersionId],
      );
    } else if (drift.change_type === 'removed') {
      const result = await client.query(
        `DELETE FROM baseline_resource
         WHERE baseline_id = $1 AND natural_key = $2`,
        [drift.baseline_id, drift.natural_key],
      );
      if (result.rowCount !== 1) {
        throw new Error(`baseline resource not found for removed drift: ${driftId}`);
      }
    } else if (drift.change_type === 'modified') {
      const result = await client.query(
        `UPDATE baseline_resource
         SET resource_version_id = $3
         WHERE baseline_id = $1 AND natural_key = $2`,
        [drift.baseline_id, drift.natural_key, resourceVersionId],
      );
      if (result.rowCount !== 1) {
        throw new Error(`baseline resource not found for modified drift: ${driftId}`);
      }
    } else {
      throw new Error(`unknown drift change type: ${drift.change_type}`);
    }

    await client.query(
      `INSERT INTO disposition (drift_id, action, actor, reason)
       VALUES ($1, 'accept', $2, $3)`,
      [driftId, actor, reason],
    );
    await appendAcceptanceEvidence(client, {
      tenantRef: drift.tenant_ref,
      drift,
      resourceVersionId,
      actor,
    });

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function seedFromSnapshot(client, {
  tenantRef, snapshotId, setBy, label, description,
}) {
  await client.query('BEGIN');
  try {
    await client.query(
      `UPDATE baseline
       SET active = false
       WHERE tenant_ref = $1 AND active = true`,
      [tenantRef],
    );
    const { rows } = await client.query(
      `INSERT INTO baseline (tenant_ref, set_by, label, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [tenantRef, setBy, label ?? null, description ?? null],
    );
    const baselineId = rows[0].id;
    await client.query(
      `INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id)
       SELECT $1, natural_key, id
       FROM resource_version
       WHERE snapshot_id = $2`,
      [baselineId, snapshotId],
    );
    await client.query('COMMIT');
    return baselineId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** All baselines for a tenant, newest first, with a resource_count. Named and anonymous alike. */
export async function listBaselines(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT b.id, b.label, b.description, b.set_at, b.set_by, b.active,
            count(br.natural_key)::int AS resource_count
     FROM baseline b
     LEFT JOIN baseline_resource br ON br.baseline_id = b.id
     WHERE b.tenant_ref = $1
     GROUP BY b.id
     ORDER BY b.set_at DESC, b.id DESC`,
    [tenantRef],
  );
  return rows;
}

export async function getBaselineByLabel(client, { tenantRef, label }) {
  const { rows } = await client.query(
    `SELECT * FROM baseline WHERE tenant_ref = $1 AND label = $2 LIMIT 1`,
    [tenantRef, label],
  );
  return rows[0] ?? null;
}

/**
 * Makes one baseline active and deactivates the previously active one, atomically.
 * The partial unique index (tenant_ref) WHERE active allows at most one active row per
 * tenant, so the target is validated and locked BEFORE anything is deactivated: if the
 * target doesn't exist the whole transaction rolls back before it ever touches the
 * currently active baseline. That is the failure mode to avoid — a tenant left with
 * ZERO active baselines, which would make drift detection throw `no active baseline`.
 */
export async function activateBaseline(client, { tenantRef, baselineId }) {
  await client.query('BEGIN');
  try {
    const { rows: targetRows } = await client.query(
      `SELECT id FROM baseline WHERE id = $1 AND tenant_ref = $2 FOR UPDATE`,
      [baselineId, tenantRef],
    );
    if (!targetRows[0]) {
      throw new Error(`baseline not found for tenant: ${baselineId}`);
    }

    await client.query(
      `SELECT id FROM baseline WHERE tenant_ref = $1 AND active = true FOR UPDATE`,
      [tenantRef],
    );

    await client.query(
      `UPDATE baseline
       SET active = false
       WHERE tenant_ref = $1 AND active = true AND id <> $2`,
      [tenantRef, baselineId],
    );

    const { rowCount } = await client.query(
      `UPDATE baseline SET active = true WHERE id = $1 AND tenant_ref = $2`,
      [baselineId, tenantRef],
    );
    if (rowCount !== 1) {
      throw new Error(`failed to activate baseline: ${baselineId}`);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
