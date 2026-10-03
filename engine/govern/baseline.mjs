import { createHash } from 'node:crypto';
import { canonicalize } from '../cir/canonicalHash.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { appendEvidence } from './evidence.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A baseline represents the whole estate, so a source is safe only when every
 * descriptor explicitly reports a successful collection. A completed snapshot
 * alone proves only that collection finished; it does not prove its coverage.
 */
export function isEligibleBaselineSource(snapshot, { tenantRef }) {
  if (!snapshot
    || snapshot.tenant_ref !== tenantRef
    || snapshot.status !== 'complete'
    || snapshot.completed_at === null
    || snapshot.completed_at === undefined
    || !isRecord(snapshot.coverage_digest)) {
    return false;
  }

  return DESCRIPTORS.every(({ type }) => {
    const coverage = snapshot.coverage_digest[type];
    // A completed empty read is a strict coverage success, exactly like a
    // non-empty one; partial, failed and not-requested never qualify.
    return isRecord(coverage) && (coverage.outcome === 'complete' || coverage.outcome === 'complete-empty');
  });
}

/**
 * The portal's baseline picker and seedFromSnapshot share this contract. Keep
 * tier-filtered snapshots available to restore/history callers; this list is
 * specifically for whole-estate baseline sources.
 */
export async function listEligibleBaselineSnapshots(client, { tenantRef, limit = 50 }) {
  const { rows } = await client.query(
    `SELECT s.id, s.tenant_ref, s.status, s.started_at, s.completed_at,
            s.coverage_digest, count(rv.id)::int AS resource_count
     FROM snapshot s
     LEFT JOIN resource_version rv ON rv.snapshot_id = s.id
     WHERE s.tenant_ref = $1
     GROUP BY s.id
     ORDER BY s.started_at DESC`,
    [tenantRef],
  );
  return rows
    .filter((snapshot) => isEligibleBaselineSource(snapshot, { tenantRef }))
    .slice(0, limit);
}

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
    // Task-87: a superseded baseline version is preserved evidence. Accepting a change
    // into it would rewrite what that version recorded, so it is refused.
    const { rows: frozenRows } = await client.query(
      'SELECT superseded_at FROM baseline WHERE id = $1 FOR UPDATE',
      [drift.baseline_id],
    );
    if (frozenRows[0]?.superseded_at) {
      throw new Error(`baseline ${drift.baseline_id} was superseded by a re-snapshot; it is read-only`);
    }

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

/**
 * Task-87: what a baseline captured, from the snapshot it was seeded from. The capture
 * time is the snapshot's completion (the basis of the baseline's age), and the scope is
 * the collection window plus the types it read completely.
 */
export function captureFromSnapshot(snapshot) {
  const digest = isRecord(snapshot.coverage_digest) ? snapshot.coverage_digest : {};
  const types = Object.keys(digest)
    .filter((type) => isRecord(digest[type])
      && (digest[type].outcome === 'complete' || digest[type].outcome === 'complete-empty'))
    .sort();
  return {
    capturedAt: snapshot.completed_at,
    scope: {
      startedAt: new Date(snapshot.started_at).toISOString(),
      completedAt: new Date(snapshot.completed_at).toISOString(),
      types,
    },
  };
}

async function lockEligibleSnapshot(client, { tenantRef, snapshotId }) {
  const { rows: snapshotRows } = await client.query(
    `SELECT id, tenant_ref, status, started_at, completed_at, coverage_digest
     FROM snapshot
     WHERE id = $1
     FOR UPDATE`,
    [snapshotId],
  );
  const snapshot = snapshotRows[0];
  if (!isEligibleBaselineSource(snapshot, { tenantRef })) {
    throw new Error(`snapshot is not an eligible whole-estate baseline source: ${snapshotId}`);
  }
  return snapshot;
}

export async function seedFromSnapshot(client, {
  tenantRef, snapshotId, setBy, label, description,
}) {
  await client.query('BEGIN');
  try {
    const snapshot = await lockEligibleSnapshot(client, { tenantRef, snapshotId });
    const capture = captureFromSnapshot(snapshot);

    await client.query(
      `UPDATE baseline
       SET active = false
       WHERE tenant_ref = $1 AND active = true`,
      [tenantRef],
    );
    const { rows } = await client.query(
      `INSERT INTO baseline
         (tenant_ref, set_by, label, description, source_snapshot_id, captured_at, observation_scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [tenantRef, setBy, label ?? null, description ?? null, snapshotId, capture.capturedAt, capture.scope],
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

function versionLabel(previousLabel, version) {
  if (typeof previousLabel !== 'string' || previousLabel.length === 0) return null;
  return `${previousLabel.replace(/ \(v\d+\)$/, '')} (v${version})`;
}

/**
 * Task-87: re-snapshot a baseline as a new version. The previous version is preserved:
 * its row and every baseline_resource row it holds stay exactly as they were, it only
 * gains superseded_at (which makes it read-only to acceptDrift) and loses `active` if
 * the new version takes over. The new version names the one it supersedes, so the
 * history is a chain, and the transition is recorded in the audit record.
 */
export async function resnapshotBaseline(client, {
  tenantRef, baselineId, snapshotId, setBy, label, description,
}) {
  assertTenantRef(tenantRef);
  let created;
  let previous;
  let preserved;
  await client.query('BEGIN');
  try {
    const { rows: previousRows } = await client.query(
      'SELECT * FROM baseline WHERE id = $1 AND tenant_ref = $2 FOR UPDATE',
      [baselineId, tenantRef],
    );
    previous = previousRows[0];
    if (!previous) throw new Error(`baseline not found for tenant: ${baselineId}`);
    if (previous.superseded_at) {
      throw new Error(`baseline ${baselineId} was already re-snapshotted; re-snapshot its latest version`);
    }

    const snapshot = await lockEligibleSnapshot(client, { tenantRef, snapshotId });
    if (previous.source_snapshot_id && String(previous.source_snapshot_id) === String(snapshot.id)) {
      throw new Error(`baseline ${baselineId} was already captured from snapshot ${snapshotId}`);
    }
    if (previous.captured_at && new Date(snapshot.completed_at) <= new Date(previous.captured_at)) {
      throw new Error(`snapshot ${snapshotId} is not newer than the capture it would replace`);
    }
    const capture = captureFromSnapshot(snapshot);
    const version = Number(previous.version ?? 1) + 1;

    const { rows: countRows } = await client.query(
      'SELECT count(*)::int AS count FROM baseline_resource WHERE baseline_id = $1',
      [baselineId],
    );
    preserved = countRows[0].count;

    await client.query(
      'UPDATE baseline SET superseded_at = now(), active = false WHERE id = $1',
      [baselineId],
    );
    const { rows } = await client.query(
      `INSERT INTO baseline
         (tenant_ref, set_by, label, description, source_snapshot_id, captured_at,
          observation_scope, version, supersedes_id, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, version, active`,
      [
        tenantRef, setBy, label ?? versionLabel(previous.label, version),
        description ?? previous.description ?? null, snapshotId, capture.capturedAt,
        capture.scope, version, baselineId, previous.active,
      ],
    );
    created = rows[0];
    await client.query(
      `INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id)
       SELECT $1, natural_key, id
       FROM resource_version
       WHERE snapshot_id = $2`,
      [created.id, snapshotId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  await appendEvidence(client, {
    tenantRef,
    kind: 'baseline-resnapshot',
    actor: setBy,
    subject: {
      baselineId: created.id,
      version: created.version,
      supersedesBaselineId: baselineId,
      sourceSnapshotId: snapshotId,
      preservedResourceCount: preserved,
      active: created.active,
    },
  });
  return { id: created.id, version: created.version, supersedesId: baselineId, active: created.active };
}

/**
 * Server-side authorization for a re-snapshot: the requester must hold baseline-create
 * now. A read-only viewer is refused before anything is read or written; the portal
 * route and the worker check the same capability (engine/authz/jobCapabilities.mjs).
 */
export async function replaceBaseline(client, { principalId, at = new Date(), ...params }) {
  const principal = await findPrincipalById(client, principalId);
  if (!principal || !(await can(client, principal, 'baseline-create', at))) {
    throw new Error('forbidden: re-snapshotting a baseline requires baseline-create');
  }
  return resnapshotBaseline(client, { ...params, setBy: principalId });
}

/** All baselines for a tenant, newest first, with a resource_count. Named and anonymous alike. */
export async function listBaselines(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT b.id, b.label, b.description, b.set_at, b.set_by, b.active,
            b.source_snapshot_id, b.captured_at, b.observation_scope, b.version,
            b.supersedes_id, b.superseded_at,
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
      `SELECT id, superseded_at FROM baseline WHERE id = $1 AND tenant_ref = $2 FOR UPDATE`,
      [baselineId, tenantRef],
    );
    if (!targetRows[0]) {
      throw new Error(`baseline not found for tenant: ${baselineId}`);
    }
    // Task-87: a superseded version is kept as history, not measured against again
    // (accepting a change into it is refused), so only a latest version is activated.
    if (targetRows[0].superseded_at) {
      throw new Error(`baseline ${baselineId} was superseded by a re-snapshot; activate its latest version`);
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
