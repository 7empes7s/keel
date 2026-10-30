// engine/govern/workloadDrift.mjs
//
// Workload drift: after each workload collection, compare it with the previous usable
// run of the same workload (compareWorkloads, the Compare page's own diff), record one
// workload_drift row per changed resource and raise a `baseline / drift` alert for it,
// the alert configuration drift raises (cli/keel-drift.mjs, syncDriftAlerts).
//
// Each read is compared with the workload's approved setup (workloadApproved.mjs), as
// configuration drift is compared with the active baseline. A difference stays a change
// until a person accepts it (it joins the approved setup) or undoes it (the workload
// restore puts the approved value back); the read that matches the approved setup again
// resolves the alert. A difference already recorded and still waiting is not recorded
// again on every read. The approved setup is taken the first time drift runs for a
// workload, from the read before (so that read's change still shows) or, on a first
// read, from that read.
import { compareWorkloads } from './compare.mjs';
import { USABLE_OUTCOMES, WAITING_ALERT_STATES, getApprovedSetup, loadApprovedSide, seedApprovedSetup } from './workloadApproved.mjs';
import { BLAST_SEVERITY, applyConditionEvent } from '../notify/alerts.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { SHAREPOINT_WORKLOAD } from '../collect/workloads/sharepoint.mjs';
import { SHAREPOINT_STRUCTURE_WORKLOAD, TEMPLATE_STORAGE_FIELDS } from '../collect/workloads/sharepointStructure.mjs';

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
  // A site template is kept whole for a restore but compared through its summaries
  // (lists, columns, content types, navigation): the XML moves with every PnP version.
  [SHAREPOINT_STRUCTURE_WORKLOAD]: {
    volatile: new Set([...MOVES_ON_ITS_OWN, ...TEMPLATE_STORAGE_FIELDS]),
    cosmetic: new Set([...NAMES, 'Title', 'title', 'PreviewImageUrl', 'PreviewImageAltText', 'LogoUrl']),
  },
});

const USABLE = USABLE_OUTCOMES;
// Stored jsonb reorders object keys, so compare with keys sorted.
const canonical = (value) => JSON.stringify(value ?? null, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]))
  : inner));
const COMPLETE = ['complete', 'complete-empty'];
const CHANGE_TYPE = { added: 'added', removed: 'removed', changed: 'modified' };

function blastRadius(item, rules) {
  if (item.changeType === 'added') return 'cosmetic';
  if (item.changeType === 'removed') return 'access-affecting';
  return item.fields.every((field) => rules.cosmetic.has(field.path)) ? 'cosmetic' : 'access-affecting';
}

/**
 * The differences between one resource's approved value and a read of it, as drift
 * compares them (the workload's volatile fields left out): [{ path, kind, before, after }],
 * before being the approved value. The Changes page shows these, so the details match
 * what an undo from the approved setup puts back even after a new baseline repointed it.
 * Null for a workload drift does not track or when either side is missing.
 */
export function approvedDifferences(workload, approved, current) {
  const rules = DRIFT_WORKLOADS[workload];
  if (!rules || !approved || !current) return null;
  const strip = (value) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !rules.volatile.has(key)));
  const side = (row) => new Map([[workload, {
    collectionId: null, outcome: 'complete', at: null,
    observations: [{ resourceKey: 'resource', fields: strip(row.fields), fieldCoverage: strip(row.fieldCoverage) }],
  }]]);
  const group = compareWorkloads(side(approved), side(current)).groups.find((entry) => entry.workload === workload);
  return group?.items?.[0]?.fields ?? [];
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
 * Detects drift for one recorded workload collection against the workload's approved
 * setup. Idempotent: rows are unique per run and resource, a difference already
 * recorded and still waiting is not recorded again, and alert events derive from the
 * run id and resource key.
 * Returns { status, previousCollectionId, drift, outstanding, resolved, truncated }:
 * status is 'not-tracked', 'not-usable', 'first-run' or 'detected'; `drift` holds the
 * differences recorded by this run, `outstanding` counts every difference this read
 * still shows, and `resolved` counts the changes this read found put back or accepted.
 */
export async function detectWorkloadDrift(client, { collectionId, hysteresis, notify = null }) {
  const { rows: [run] } = await client.query('SELECT * FROM workload_collection WHERE id = $1', [collectionId]);
  if (!run) throw new Error(`workload collection not found: ${collectionId}`);
  const rules = DRIFT_WORKLOADS[run.workload];
  const empty = { previousCollectionId: null, drift: [], outstanding: 0, resolved: 0, truncated: 0 };
  if (!rules) return { status: 'not-tracked', ...empty };
  if (!USABLE.includes(run.outcome)) return { status: 'not-usable', ...empty };

  const { rows: [previous] } = await client.query(
    `SELECT * FROM workload_collection
      WHERE tenant_ref = $1 AND workload = $2 AND outcome = ANY($3) AND (created_at, id) < ($4, $5)
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [run.tenant_ref, run.workload, USABLE, run.created_at, run.id],
  );

  let setup = await getApprovedSetup(client, { tenantRef: run.tenant_ref, workload: run.workload });
  if (!setup) {
    await client.query('BEGIN');
    try {
      setup = await seedApprovedSetup(client, { tenantRef: run.tenant_ref, workload: run.workload, collectionId: (previous ?? run).id });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    if (!previous) return { status: 'first-run', ...empty };
  }

  const strip = (value) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !rules.volatile.has(key)));
  const approved = await loadApprovedSide(client, { setup, strip });
  const current = await loadSide(client, run, rules);
  const result = compareWorkloads(approved.side, current);
  const group = result.groups.find((entry) => entry.workload === run.workload);
  const items = group?.state === 'compared' ? group.items : [];
  const truncated = (group?.total ?? 0) - items.length;
  const outstanding = items.map((item) => ({
    naturalKey: `${run.workload}:${item.resourceKey}`,
    resourceKey: item.resourceKey,
    resourceType: run.workload,
    changeType: CHANGE_TYPE[item.changeType],
    fields: item.fields ?? [],
    blastRadius: blastRadius({ ...item, fields: item.fields ?? [] }, rules),
    // The read that holds the approved value: an undo restores from it.
    previousCollectionId: approved.sources.get(item.resourceKey) ?? setup.seeded_from,
  }));

  // The newest recorded change per resource and its alert, to tell a difference already
  // waiting for a person from a new one.
  const { rows: newest } = await client.query(
    `SELECT DISTINCT ON (d.resource_key) d.resource_key, d.change_type, d.fields, d.collection_id,
            a.state AS alert_state, a.condition_active
       FROM workload_drift d
       JOIN workload_collection c ON c.id = d.collection_id
       LEFT JOIN alert a ON a.tenant_ref = d.tenant_ref AND a.resource_key = d.workload || ':' || d.resource_key
                        AND a.control = 'baseline' AND a.condition = 'drift'
      WHERE d.tenant_ref = $1 AND d.workload = $2
      ORDER BY d.resource_key, c.created_at DESC, d.detected_at DESC`,
    [run.tenant_ref, run.workload],
  );
  const recorded = new Map(newest.map((row) => [row.resource_key, row]));
  const waiting = (row) => row && (row.alert_state === null || (WAITING_ALERT_STATES.includes(row.alert_state) && row.condition_active));
  const drift = outstanding.filter((item) => {
    const row = recorded.get(item.resourceKey);
    if (row?.collection_id === run.id) return true; // this run, detected again: idempotent below
    return !(waiting(row) && row.change_type === item.changeType && canonical(row.fields) === canonical(item.fields));
  });

  await client.query('BEGIN');
  try {
    for (const item of drift) {
      await client.query(
        `INSERT INTO workload_drift
           (tenant_ref, workload, collection_id, previous_collection_id, resource_key, change_type, fields, blast_radius, compared_with)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved') ON CONFLICT (collection_id, resource_key) DO NOTHING`,
        [run.tenant_ref, run.workload, run.id, item.previousCollectionId, item.resourceKey, item.changeType, JSON.stringify(item.fields), item.blastRadius],
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
        previousCollectionId: item.previousCollectionId, comparedWith: 'approved', fields: item.fields.map((field) => field.path),
      },
      source: 'workload-drift',
      hysteresis,
      notify,
    });
  }

  // A change this read no longer shows was put back or accepted: its alert resolves.
  // Only where the read can tell: the resource was read, or the read was complete. A
  // read whose differences were cut short resolves nothing.
  let resolved = 0;
  if (truncated === 0) {
    const still = new Set(outstanding.map((item) => item.resourceKey));
    const seen = new Set([...current.values()][0].observations.map((row) => row.resourceKey));
    const prefix = `${run.workload}:`;
    const { rows: active } = await client.query(
      `SELECT resource_key FROM alert
        WHERE tenant_ref = $1 AND control = 'baseline' AND condition = 'drift' AND condition_active
          AND left(resource_key, $2) = $3`,
      [run.tenant_ref, prefix.length, prefix],
    );
    for (const { resource_key: key } of active) {
      const resourceKey = key.slice(prefix.length);
      if (still.has(resourceKey) || !(seen.has(resourceKey) || COMPLETE.includes(run.outcome))) continue;
      const outcome = await applyConditionEvent(client, {
        tenantRef: run.tenant_ref,
        resourceKey: key,
        control: 'baseline',
        condition: 'drift',
        status: 'resolved',
        eventId: `workload-drift:${run.id}:${resourceKey}:matches`,
        occurredAt: run.observed_to,
        source: 'workload-drift',
        hysteresis,
        notify,
      });
      if (outcome?.outcome === 'resolved') resolved += 1;
    }
  }
  return {
    status: 'detected', previousCollectionId: previous?.id ?? null, drift, outstanding: outstanding.length, resolved, truncated,
  };
}
