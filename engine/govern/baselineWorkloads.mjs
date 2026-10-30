// engine/govern/baselineWorkloads.mjs
//
// Service settings inside the approved setup. A baseline captured from a backup holds
// the Microsoft Graph settings of that backup (baseline_resource) and, from here, the
// Exchange, SharePoint and OneDrive, Teams, Purview and Power Platform settings of the
// service reads nearest it (baseline_workload). The baseline's observation_scope lists
// each service read it captured (`workloads`) and each service it could not, because
// no usable read exists yet (`workloadsNotRead`).
//
// Workload drift compares each read with workload_approved (workloadApproved.mjs).
// Making a baseline the active one copies the services it holds into workload_approved,
// so service changes are accepted or undone against the approved setup on the
// Baselines page, like Entra ID and Intune changes. A service the baseline does not
// hold keeps the approved setup it had.
import { USABLE_OUTCOMES, waitingChanges } from './workloadApproved.mjs';
import { DRIFT_WORKLOADS } from './workloadDrift.mjs';

/** Every service workload a baseline can hold, sorted. (A function: the modules import
 * each other, so DRIFT_WORKLOADS is read at call time.) */
export const baselineWorkloads = () => Object.keys(DRIFT_WORKLOADS).sort();

/**
 * For each service workload, the usable read nearest the backup that finished at `at`:
 * the newest one at or before it or, when there is none, the first one after it. A
 * complete read is preferred to a partial one on the same side, since the baseline
 * treats the read as the whole list.
 * Returns { reads: [{ workload, collectionId, outcome, collectedAt }], notRead: [workload] }.
 */
export async function nearestWorkloadReads(client, { tenantRef, at }) {
  const all = baselineWorkloads();
  const { rows } = await client.query(
    `SELECT DISTINCT ON (workload) id, workload, outcome, created_at
       FROM workload_collection
      WHERE tenant_ref = $1 AND workload = ANY($2::text[]) AND outcome = ANY($3::text[])
      ORDER BY workload,
               (created_at <= $4) DESC,
               (outcome = 'partial') ASC,
               CASE WHEN created_at <= $4 THEN created_at END DESC,
               created_at ASC, id DESC`,
    [tenantRef, all, USABLE_OUTCOMES, at],
  );
  const reads = rows.map((row) => ({
    workload: row.workload,
    collectionId: row.id,
    outcome: row.outcome,
    collectedAt: new Date(row.created_at).toISOString(),
  }));
  const found = new Set(reads.map((read) => read.workload));
  return { reads, notRead: all.filter((workload) => !found.has(workload)) };
}

/**
 * Copies every setting of `reads` into the baseline. Runs inside the caller's
 * transaction. Returns the scope entries: each read with its setting count.
 */
export async function captureWorkloadReads(client, { tenantRef, baselineId, reads }) {
  const captured = [];
  for (const read of reads) {
    await client.query(
      `INSERT INTO baseline_workload (baseline_id, workload, resource_key, collection_id)
       SELECT $1, $2, resource_key, collection_id FROM workload_observation WHERE collection_id = $3`,
      [baselineId, read.workload, read.collectionId],
    );
    // A change still waiting for review keeps its earlier value, as when the approved
    // setup is first taken (workloadApproved.mjs), so capturing never quietly approves it.
    for (const change of await waitingChanges(client, { tenantRef, workload: read.workload, collectionId: read.collectionId })) {
      if (change.change_type === 'added') {
        await client.query(
          'DELETE FROM baseline_workload WHERE baseline_id = $1 AND workload = $2 AND resource_key = $3',
          [baselineId, read.workload, change.resource_key],
        );
      } else {
        await client.query(
          `INSERT INTO baseline_workload (baseline_id, workload, resource_key, collection_id)
           SELECT $1, $2, resource_key, collection_id FROM workload_observation WHERE collection_id = $3 AND resource_key = $4
           ON CONFLICT (baseline_id, workload, resource_key) DO UPDATE SET collection_id = EXCLUDED.collection_id`,
          [baselineId, read.workload, change.previous_collection_id, change.resource_key],
        );
      }
    }
    const { rows: [{ settings }] } = await client.query(
      'SELECT count(*)::int AS settings FROM baseline_workload WHERE baseline_id = $1 AND workload = $2',
      [baselineId, read.workload],
    );
    captured.push({ ...read, settings });
  }
  return captured;
}

/** Copies another baseline version's service settings (a reinstate). Returns the row count. */
export async function copyBaselineWorkloads(client, { fromBaselineId, toBaselineId }) {
  const { rowCount } = await client.query(
    `INSERT INTO baseline_workload (baseline_id, workload, resource_key, collection_id)
     SELECT $1, workload, resource_key, collection_id FROM baseline_workload WHERE baseline_id = $2`,
    [toBaselineId, fromBaselineId],
  );
  return rowCount;
}

/**
 * Makes the services a baseline holds the approved setup drift compares with: for each
 * service in its observation_scope.workloads, workload_approved is replaced by the
 * baseline's rows (a service captured empty approves nothing). A service the baseline
 * does not hold is left as it is. Runs inside the caller's transaction. Returns the
 * workloads applied.
 */
export async function applyBaselineWorkloads(client, { tenantRef, baselineId }) {
  const { rows: [baseline] } = await client.query(
    'SELECT id, version, observation_scope FROM baseline WHERE id = $1 AND tenant_ref = $2',
    [baselineId, tenantRef],
  );
  const held = Array.isArray(baseline?.observation_scope?.workloads) ? baseline.observation_scope.workloads : [];
  const applied = [];
  for (const entry of held) {
    if (!entry || typeof entry.workload !== 'string' || typeof entry.collectionId !== 'string') continue;
    await client.query(
      `INSERT INTO workload_approved_setup (tenant_ref, workload, seeded_from) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_ref, workload) DO UPDATE SET seeded_from = EXCLUDED.seeded_from, seeded_at = now()`,
      [tenantRef, entry.workload, entry.collectionId],
    );
    await client.query('DELETE FROM workload_approved WHERE tenant_ref = $1 AND workload = $2', [tenantRef, entry.workload]);
    await client.query(
      `INSERT INTO workload_approved (tenant_ref, workload, resource_key, fields, field_coverage, collection_id, reason)
       SELECT $1, bw.workload, bw.resource_key, o.fields, o.field_coverage, bw.collection_id, $4
         FROM baseline_workload bw
         JOIN workload_observation o ON o.collection_id = bw.collection_id AND o.resource_key = bw.resource_key
        WHERE bw.baseline_id = $2 AND bw.workload = $3`,
      [tenantRef, baselineId, entry.workload, `approved setup v${Number(baseline.version ?? 1)}`],
    );
    applied.push(entry.workload);
  }
  return applied;
}
