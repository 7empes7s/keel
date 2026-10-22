/**
 * Runs every registered control against the tenant's newest backups and records
 * each result (issue: the Compliance page stayed empty because nothing called
 * recordEvaluation outside tests).
 *
 * For each type a control needs, the evidence is the newest completed snapshot of
 * this tenant whose read of that type was complete. The observation is read from
 * that snapshot's own coverage digest, exactly as the Compliance reader matches it
 * back (baselineCompliance.mjs matchEvidence), and its resources are that
 * snapshot's rows of the type. A type no snapshot read in full is passed as
 * missing, so the control is recorded as 'unknown', never a guessed pass.
 *
 * Read-only toward the tenant: it reads Keel's own database and writes only
 * benchmark_evaluation rows and their evidence entries.
 */
import { readObservation } from '../contracts/observation.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { evaluateControl, recordEvaluation } from './evaluate.mjs';
import { listControls } from './registry.mjs';

// How many recent snapshots are searched for a complete read of a type. A type
// read only further back would be stale for every shipped control anyway.
const SNAPSHOT_LOOKBACK = 50;

async function newestCompleteRead(client, { tenantRef, resourceType, snapshots }) {
  for (const snapshot of snapshots) {
    const entry = snapshot.coverage_digest?.[resourceType];
    if (entry === undefined) continue;
    let observation;
    try {
      observation = readObservation(entry, {
        tenantRef,
        observationId: `${snapshot.id}:${resourceType}`,
        resourceType,
        snapshotWindow: { startedAt: snapshot.started_at, endedAt: snapshot.completed_at },
      });
    } catch {
      continue;
    }
    if (observation.completeness !== 'complete' || !observation.window) continue;
    const { rows } = await client.query(
      'SELECT payload FROM resource_version WHERE snapshot_id = $1 AND resource_type = $2 ORDER BY natural_key',
      [snapshot.id, resourceType],
    );
    return { observation, resources: rows.map((row) => row.payload), snapshotId: String(snapshot.id) };
  }
  return null;
}

/**
 * @returns {Promise<{ checked: number, pass: number, fail: number, unknown: number, notApplicable: number, notConfigured: number, evaluations: object[] }>}
 */
export async function runComplianceChecks(client, { tenantRef, actor, now = new Date(), controls = listControls() }) {
  assertTenantRef(tenantRef);
  if (typeof actor !== 'string' || actor.length === 0) throw new TypeError('runComplianceChecks requires an actor');
  const { rows: snapshots } = await client.query(
    `SELECT id, tenant_ref, started_at, completed_at, coverage_digest
       FROM snapshot
      WHERE tenant_ref = $1 AND completed_at IS NOT NULL AND completed_at <= $2
      ORDER BY completed_at DESC, id DESC
      LIMIT ${SNAPSHOT_LOOKBACK}`,
    [tenantRef, now],
  );

  const reads = new Map();
  const evaluations = [];
  for (const control of controls) {
    const observations = {};
    for (const { resourceType } of control.requiredObservations) {
      if (!reads.has(resourceType)) reads.set(resourceType, await newestCompleteRead(client, { tenantRef, resourceType, snapshots }));
      const read = reads.get(resourceType);
      if (read) observations[resourceType] = { observation: read.observation, resources: read.resources };
    }
    const result = evaluateControl({ controlId: control.controlId, tenantRef, observations, now });
    evaluations.push(await recordEvaluation(client, { tenantRef, result, actor }));
  }

  const count = (verdict) => evaluations.filter((evaluation) => evaluation.verdict === verdict).length;
  return {
    checked: evaluations.length,
    pass: count('pass'),
    fail: count('fail'),
    unknown: count('unknown'),
    notApplicable: count('not-applicable'),
    // Of the fails, those where the setting does not exist yet.
    notConfigured: evaluations.filter((evaluation) => evaluation.reason === 'not-configured').length,
    evaluations,
  };
}
