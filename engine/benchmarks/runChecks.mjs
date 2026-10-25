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
 * A control resting on a service read (registry.mjs WORKLOAD_FACT_TYPES, such as the
 * Exchange mail protection policies) reads the newest run of that service read whose
 * kinds the control needs were read in full (newestWorkloadRead).
 *
 * A tenant's own checks (ownChecks.mjs) run with Keel's, read the same way.
 *
 * Read-only toward the tenant: it reads Keel's own database and writes only
 * benchmark_evaluation rows and their evidence entries.
 */
import { readObservation } from '../contracts/observation.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { evaluateControl, recordEvaluation } from './evaluate.mjs';
import { listOwnControls } from './ownChecks.mjs';
import { WORKLOAD_FACT_TYPES, listControls } from './registry.mjs';

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

const USABLE_RUNS = ['complete', 'complete-empty', 'partial'];

/**
 * Whether one service-read run read every kind in `parts` in full. A complete run read
 * everything. A partial run counts for a kind it read with no missing field, or found
 * not licensed (Safe Links without Defender for Office 365: there is nothing to read,
 * so the kind is empty, not unknown). A run that hit its object cap, or got objects it
 * could not identify, may be missing objects of any kind, so it counts for none.
 */
function readsInFull(run, parts) {
  if (run.outcome === 'complete' || run.outcome === 'complete-empty') return true;
  if (run.outcome !== 'partial') return false;
  const digest = run.digest ?? {};
  const discovery = digest.discovery ?? {};
  if (discovery.capped || discovery.unidentified) return false;
  return parts.every((part) => ['read', 'not-licensed'].includes(discovery.families?.[part]?.status)
    && Object.keys(digest.unknownFields?.[part] ?? {}).length === 0);
}

function workloadObservation(run, { tenantRef, resourceType, completeness }) {
  return {
    resourceType,
    tenantRef,
    window: { startedAt: new Date(run.observed_from).toISOString(), endedAt: new Date(run.observed_to).toISOString() },
    completeness,
  };
}

/**
 * The newest run of a service read that read the kinds a control needs in full, with
 * its stored objects of those kinds. When runs exist but none read them in full, the
 * newest is returned as partial (or failed) with no objects, so the control says the
 * read did not finish. Runs refused for lack of qualification read nothing and count
 * as no read at all.
 */
export async function newestWorkloadRead(client, { tenantRef, resourceType, parts, now }) {
  const { rows: runs } = await client.query(
    `SELECT id, outcome, observed_from, observed_to, digest
       FROM workload_collection
      WHERE tenant_ref = $1 AND workload = $2 AND outcome <> 'disabled' AND observed_to <= $3
      ORDER BY observed_to DESC, created_at DESC
      LIMIT ${SNAPSHOT_LOOKBACK}`,
    [tenantRef, resourceType, now],
  );
  const run = runs.find((candidate) => USABLE_RUNS.includes(candidate.outcome) && (!parts || readsInFull(candidate, parts)));
  if (!run) {
    if (!runs.length) return null;
    const completeness = runs[0].outcome === 'failed' ? 'failed' : 'partial';
    return { observation: workloadObservation(runs[0], { tenantRef, resourceType, completeness }), resources: [] };
  }
  const { rows } = await client.query(
    'SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key',
    [run.id],
  );
  const resources = rows
    .filter((row) => !parts || parts.includes(row.fields?.kind))
    .map((row) => ({ ...row.fields, id: row.resource_key }));
  return { observation: workloadObservation(run, { tenantRef, resourceType, completeness: 'complete' }), resources, collectionId: String(run.id) };
}

/**
 * @param {any} client
 * @param {{ tenantRef: string, actor: string, now?: Date, controls?: readonly any[] | null }} options
 * @returns {Promise<{ checked: number, pass: number, fail: number, unknown: number, notApplicable: number, notConfigured: number, evaluations: object[] }>}
 */
export async function runComplianceChecks(client, { tenantRef, actor, now = new Date(), controls = null }) {
  assertTenantRef(tenantRef);
  if (typeof actor !== 'string' || actor.length === 0) throw new TypeError('runComplianceChecks requires an actor');
  // Keel's own controls, then the checks this tenant wrote itself.
  controls ??= [...listControls(), ...await listOwnControls(client, { tenantRef })];
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
    for (const { resourceType, parts } of control.requiredObservations) {
      const key = parts ? `${resourceType}:${parts.join(',')}` : resourceType;
      if (!reads.has(key)) {
        reads.set(key, WORKLOAD_FACT_TYPES.has(resourceType)
          ? await newestWorkloadRead(client, { tenantRef, resourceType, parts, now })
          : await newestCompleteRead(client, { tenantRef, resourceType, snapshots }));
      }
      const read = reads.get(key);
      if (read) observations[resourceType] = { observation: read.observation, resources: read.resources };
    }
    const result = evaluateControl({ controlId: control.controlId, control, tenantRef, observations, now });
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
