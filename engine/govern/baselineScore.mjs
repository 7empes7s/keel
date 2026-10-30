/**
 * How much of the tenant matches the approved setup, as a percentage, and its history.
 *
 * The score is settings that match ÷ settings judged, per Microsoft service and overall
 * (the rules are in baselineScoreRules.mjs, which the Approved setup page uses too, so a
 * stored point and the page agree).
 *
 * After each backup's drift detection and each run of service reads, one point is
 * stored (baseline_score_point, schema.d/86): the overall count and one per service.
 * It reads Keel's own database only, for the whole tenant.
 */
export { kindMatch, matchPercent, overallCount, scoreByService } from './baselineScoreRules.mjs';
import { matchPercent, overallCount, scoreByService } from './baselineScoreRules.mjs';
import { listLatestOpenDrift, getActiveBaseline } from '../store/governance.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';

// Alert states of a service read change still waiting for a person (as listed on the
// Changes page, portal/lib/service-changes.ts).
export const OPEN_ALERT_STATES = Object.freeze(['open', 'reopened', 'acknowledged']);
// A workload run whose settings can be compared (as on What's protected).
const USABLE_READS = Object.freeze(['complete', 'complete-empty', 'partial']);

/**
 * The base of each service read's score, by workload: how many settings the newest read
 * found, and its open changes by kind. The changes are counted with no time window or
 * row limit, so a difference that has stayed open for months still counts as not
 * matching. The newest change per resource counts, while its alert still waits.
 */
export async function loadServiceReadTotals(client, tenantRef) {
  const { rows: heldRows } = await client.query(
    `WITH latest AS (
       SELECT DISTINCT ON (workload) id, workload FROM workload_collection
        WHERE tenant_ref = $1
        ORDER BY workload, created_at DESC, id DESC
     )
     SELECT latest.workload, count(o.*)::int AS count
       FROM latest LEFT JOIN workload_observation o ON o.collection_id = latest.id
      GROUP BY latest.workload`,
    [tenantRef],
  );
  const { rows: openRows } = await client.query(
    `SELECT workload, change_type, count(*)::int AS count FROM (
       SELECT DISTINCT ON (d.workload, d.resource_key) d.workload, d.change_type, a.state AS alert_state
         FROM workload_drift d
         JOIN workload_collection c ON c.id = d.collection_id
         LEFT JOIN alert a ON a.tenant_ref = d.tenant_ref AND a.resource_key = d.workload || ':' || d.resource_key
                          AND a.control = 'baseline' AND a.condition = 'drift'
        WHERE d.tenant_ref = $1
        ORDER BY d.workload, d.resource_key, c.observed_to DESC, d.detected_at DESC
     ) newest
     WHERE alert_state IS NULL OR alert_state = ANY($2::text[])
     GROUP BY workload, change_type`,
    [tenantRef, OPEN_ALERT_STATES],
  );
  const open = {};
  for (const row of openRows) {
    const tally = open[String(row.workload)] ??= { added: 0, modified: 0, removed: 0 };
    const kind = String(row.change_type);
    if (Object.hasOwn(tally, kind)) tally[kind] += Number(row.count ?? 0);
  }
  return { held: Object.fromEntries(heldRows.map((row) => [String(row.workload), Number(row.count ?? 0)])), open };
}

/** The tenant's score now, for every reader (no entity scope): null with no approved setup. */
export async function computeBaselineScore(client, { tenantRef }) {
  assertTenantRef(tenantRef);
  const baseline = await getActiveBaseline(client, { tenantRef });
  if (!baseline) return null;
  const [{ rows: heldRows }, drift, { rows: latestReads }, totals] = await Promise.all([
    client.query(
      `SELECT rv.resource_type, count(*)::int AS count FROM baseline_resource br
         JOIN resource_version rv ON rv.id = br.resource_version_id
        WHERE br.baseline_id = $1
        GROUP BY rv.resource_type`,
      [baseline.id],
    ),
    listLatestOpenDrift(client, { tenantRef, baselineId: baseline.id }),
    client.query(
      `SELECT DISTINCT ON (workload) workload, outcome FROM workload_collection
        WHERE tenant_ref = $1 ORDER BY workload, created_at DESC, id DESC`,
      [tenantRef],
    ),
    loadServiceReadTotals(client, tenantRef),
  ]);
  const changes = {};
  for (const row of drift) {
    const tally = changes[row.resource_type] ??= { added: 0, modified: 0, removed: 0 };
    tally[Object.hasOwn(tally, row.change_type) ? row.change_type : 'modified'] += 1;
  }
  const reads = latestReads.map((row) => ({
    type: String(row.workload),
    read: USABLE_READS.includes(row.outcome),
    itemCount: totals.held[row.workload] ?? null,
    open: totals.open[row.workload] ?? { added: 0, modified: 0, removed: 0 },
  }));
  const counts = scoreByService({
    captured: Array.isArray(baseline.observation_scope?.types) ? baseline.observation_scope.types : [],
    held: Object.fromEntries(heldRows.map((row) => [String(row.resource_type), Number(row.count ?? 0)])),
    changes,
    reads,
  });
  return { baselineId: String(baseline.id), overall: overallCount(counts), services: Object.fromEntries(counts) };
}

export const SCORE_TRIGGERS = Object.freeze(['backup', 'service-read']);

/**
 * Stores one score point for the run that just finished: `trigger` is 'backup' (drift
 * detection after a backup, `sourceId` its snapshot) or 'service-read' (a run of service
 * reads). Nothing is stored without an approved setup, or when nothing could be judged.
 * Returns the stored point, or null.
 */
export async function recordBaselineScore(client, { tenantRef, trigger, sourceId = null, now = new Date() }) {
  if (!SCORE_TRIGGERS.includes(trigger)) throw new Error(`unknown score trigger: ${trigger}`);
  const score = await computeBaselineScore(client, { tenantRef });
  if (!score?.overall) return null;
  const { rows: [row] } = await client.query(
    `INSERT INTO baseline_score_point (tenant_ref, baseline_id, recorded_at, trigger, source_id, matching, judged, services)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [tenantRef, score.baselineId, now, trigger, sourceId === null ? null : String(sourceId),
      score.overall.matching, score.overall.judged, JSON.stringify(score.services)],
  );
  return pointFromRow(row);
}

function pointFromRow(row) {
  const services = row.services ?? {};
  return {
    id: String(row.id),
    baselineId: String(row.baseline_id),
    recordedAt: (row.recorded_at instanceof Date ? row.recorded_at : new Date(row.recorded_at)).toISOString(),
    trigger: row.trigger,
    sourceId: row.source_id ?? null,
    matching: Number(row.matching),
    judged: Number(row.judged),
    percent: matchPercent({ matching: Number(row.matching), judged: Number(row.judged) }),
    services: Object.fromEntries(Object.entries(services).map(([code, count]) => [code, {
      matching: Number(count?.matching ?? 0),
      judged: Number(count?.judged ?? 0),
      percent: matchPercent({ matching: Number(count?.matching ?? 0), judged: Number(count?.judged ?? 0) }),
    }])),
  };
}

/** Stored points, oldest first: the newest `limit` of them. */
export async function listBaselineScorePoints(client, { tenantRef, limit = 500 }) {
  assertTenantRef(tenantRef);
  const { rows } = await client.query(
    `SELECT * FROM (
       SELECT * FROM baseline_score_point WHERE tenant_ref = $1
        ORDER BY recorded_at DESC, id DESC LIMIT $2
     ) newest ORDER BY recorded_at, id`,
    [tenantRef, limit],
  );
  return rows.map(pointFromRow);
}
