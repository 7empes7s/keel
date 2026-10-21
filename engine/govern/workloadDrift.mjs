// engine/govern/workloadDrift.mjs
//
// Workload drift: after each workload collection, compare it with the previous usable
// run of the same workload (compareWorkloads, the Compare page's own diff), record one
// workload_drift row per changed resource and raise a `baseline / drift` alert for it,
// the alert configuration drift raises (cli/keel-drift.mjs, syncDriftAlerts).
//
// Configuration drift is measured against the active baseline and resolves when the
// resource matches it again. Workload settings have no baseline: a run that shows no
// further change does not mean the change was undone, so a workload drift alert stays
// open until a person acknowledges or resolves it. A later change to the same resource
// refires it.
import { compareWorkloads } from './compare.mjs';
import { BLAST_SEVERITY, applyConditionEvent } from '../notify/alerts.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { SHAREPOINT_WORKLOAD } from '../collect/workloads/sharepoint.mjs';

// Fields that move on their own, without a setting changing: the time Microsoft last
// saved the object and its version tag.
const MOVES_ON_ITS_OWN = ['WhenChangedUTC', 'lastModifiedTime', 'lastModifiedDateTime', 'etag'];
// A change limited to these fields renames or re-describes a resource; anything else
// changes how it behaves or who can reach what.
const NAMES = ['displayName', 'DisplayName', 'name', 'Name', 'description', 'Description', 'Comment', 'webUrl'];

const DEFAULT_RULES = Object.freeze({ volatile: new Set(MOVES_ON_ITS_OWN), cosmetic: new Set(NAMES) });

// Workloads whose runs raise drift: every workload Keel collects, so the Changes page
// covers every service. SharePoint keeps its own rules: a site's lastModifiedDateTime
// moves on every content edit.
export const DRIFT_WORKLOADS = Object.freeze({
  ...Object.fromEntries(WORKLOAD_COLLECTORS.map((entry) => [entry.workload, DEFAULT_RULES])),
  [SHAREPOINT_WORKLOAD]: {
    volatile: new Set(['lastModifiedDateTime']),
    // A change limited to these fields renames a site; anything else (app grants,
    // tenant sharing settings) changes who can reach what.
    cosmetic: new Set(['displayName', 'name', 'webUrl', 'hostname', 'createdDateTime']),
  },
});

const USABLE = ['complete', 'complete-empty', 'partial'];
const CHANGE_TYPE = { added: 'added', removed: 'removed', changed: 'modified' };

function blastRadius(item, rules) {
  if (item.changeType === 'added') return 'cosmetic';
  if (item.changeType === 'removed') return 'access-affecting';
  return item.fields.every((field) => rules.cosmetic.has(field.path)) ? 'cosmetic' : 'access-affecting';
}

async function loadSide(client, run, rules) {
  const { rows } = await client.query(
    'SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1',
    [run.id],
  );
  const strip = (value) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !rules.volatile.has(key)));
  return new Map([[run.workload, {
    collectionId: run.id,
    outcome: run.outcome,
    at: run.created_at,
    observations: rows.map((row) => ({ resourceKey: row.resource_key, fields: strip(row.fields), fieldCoverage: strip(row.field_coverage) })),
  }]]);
}

/**
 * Detects drift for one recorded workload collection. Idempotent: rows are unique per
 * run and resource, and alert events derive from the run id and resource key.
 * Returns { status, previousCollectionId, drift, truncated }, where status is
 * 'not-tracked', 'not-usable', 'first-run' or 'detected'.
 */
export async function detectWorkloadDrift(client, { collectionId, hysteresis, notify = null }) {
  const { rows: [run] } = await client.query('SELECT * FROM workload_collection WHERE id = $1', [collectionId]);
  if (!run) throw new Error(`workload collection not found: ${collectionId}`);
  const rules = DRIFT_WORKLOADS[run.workload];
  const empty = { previousCollectionId: null, drift: [], truncated: 0 };
  if (!rules) return { status: 'not-tracked', ...empty };
  if (!USABLE.includes(run.outcome)) return { status: 'not-usable', ...empty };

  const { rows: [previous] } = await client.query(
    `SELECT * FROM workload_collection
      WHERE tenant_ref = $1 AND workload = $2 AND outcome = ANY($3) AND (created_at, id) < ($4, $5)
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [run.tenant_ref, run.workload, USABLE, run.created_at, run.id],
  );
  if (!previous) return { status: 'first-run', ...empty };

  const result = compareWorkloads(await loadSide(client, previous, rules), await loadSide(client, run, rules));
  const group = result.groups.find((entry) => entry.workload === run.workload);
  const items = group?.state === 'compared' ? group.items : [];
  const drift = items.map((item) => ({
    naturalKey: `${run.workload}:${item.resourceKey}`,
    resourceKey: item.resourceKey,
    resourceType: run.workload,
    changeType: CHANGE_TYPE[item.changeType],
    fields: item.fields ?? [],
    blastRadius: blastRadius({ ...item, fields: item.fields ?? [] }, rules),
  }));

  await client.query('BEGIN');
  try {
    for (const item of drift) {
      await client.query(
        `INSERT INTO workload_drift
           (tenant_ref, workload, collection_id, previous_collection_id, resource_key, change_type, fields, blast_radius)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (collection_id, resource_key) DO NOTHING`,
        [run.tenant_ref, run.workload, run.id, previous.id, item.resourceKey, item.changeType, JSON.stringify(item.fields), item.blastRadius],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  // Observed when the run finished reading, so re-detecting an older run later cannot
  // pass for a newer occurrence.
  for (const item of drift) {
    await applyConditionEvent(client, {
      tenantRef: run.tenant_ref,
      resourceKey: item.naturalKey,
      control: 'baseline',
      condition: 'drift',
      status: 'firing',
      eventId: `workload-drift:${run.id}:${item.resourceKey}`,
      occurredAt: run.observed_to,
      severity: BLAST_SEVERITY[item.blastRadius] ?? 'warning',
      detail: {
        resourceType: item.resourceType, changeType: item.changeType, workloadCollectionId: run.id,
        previousCollectionId: previous.id, fields: item.fields.map((field) => field.path),
      },
      source: 'workload-drift',
      hysteresis,
      notify,
    });
  }
  return { status: 'detected', previousCollectionId: previous.id, drift, truncated: (group?.total ?? 0) - items.length };
}
