/**
 * Backups beyond the Entra ID and Intune settings backup (the snapshot tables):
 *
 *  - service settings: one workload_collection row per workload run (Exchange,
 *    SharePoint, OneDrive, Teams, Purview, Power Platform), nightly at 02:00 UTC;
 *  - content: one content_run row per content workload per nightly run (mail, files,
 *    sites, Teams, Planner, group conversations), with the stored items in the
 *    content index (content_item).
 *
 * The reports that measure backups (Resilience freshness, Ask, the value report,
 * Incidents) read these through this module so every service is counted the same way.
 * A run is good when it finished: complete or complete-empty for service settings,
 * succeeded for content. A workload that only ever recorded `disabled` runs is switched
 * off (it waits on a live proof) and is not required. Every read is pinned to one
 * tenant_ref, and a database without the tables reads as no backups.
 */
import { assertTenantRef } from '../store/tenantRef.mjs';

const SETTINGS_SUCCESS = new Set(['complete', 'complete-empty']);
const CONTENT_SUCCESS = new Set(['succeeded']);

function iso(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function workloadDependency(workload) {
  return { key: `workload:${workload}`, kind: 'workload', workload };
}

export function contentDependency(workload) {
  return { key: `content:${workload}`, kind: 'content', workload };
}

export function isGoodSettingsRun(outcome) {
  return SETTINGS_SUCCESS.has(outcome);
}

export function isGoodContentRun(outcome) {
  return CONTENT_SUCCESS.has(outcome);
}

async function tablesPresent(client) {
  const { rows: [row] } = await client.query(
    `SELECT to_regclass('workload_collection') IS NOT NULL AS workload,
            to_regclass('content_run') IS NOT NULL AS content_run,
            to_regclass('content_item') IS NOT NULL AS content_item`,
  );
  return { workload: row?.workload === true, contentRun: row?.content_run === true, contentItem: row?.content_item === true };
}

/**
 * Record one content workload's run. Best effort for the caller: a database without
 * the table (or no database, in a dry run) records nothing and says so.
 */
export async function recordContentRun(client, { tenantRef, workload, outcome, items = 0, bytes = 0, reasons = [], namePrefix = null, startedAt, completedAt }) {
  if (!client) return { recorded: false, reason: 'no-database' };
  assertTenantRef(tenantRef);
  const { rows: [table] } = await client.query("SELECT to_regclass('content_run') IS NOT NULL AS present");
  if (!table?.present) return { recorded: false, reason: 'no-table' };
  await client.query(
    `INSERT INTO content_run (tenant_ref, workload, outcome, items, bytes, reasons, name_prefix, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
    [tenantRef, workload, String(outcome ?? 'failed'), Math.max(0, Number(items) || 0), Math.max(0, Number(bytes) || 0),
      JSON.stringify(Array.isArray(reasons) ? reasons.map(String) : []),
      typeof namePrefix === 'string' && namePrefix ? namePrefix : null, startedAt, completedAt],
  );
  return { recorded: true };
}

/**
 * Freshness observations for every service-settings and content run of the tenant:
 * the newest attempt and the newest good run per workload, in the shape
 * recoveryMetrics.computeFreshness reads.
 */
export async function loadServiceObservations(client, { tenantRef }) {
  assertTenantRef(tenantRef);
  const present = await tablesPresent(client);
  const required = [];
  const observations = [];
  if (present.workload) {
    const { rows } = await client.query(
      `WITH runs AS (
         SELECT id::text AS id, workload, outcome, observed_from, observed_to, created_at,
                outcome IN ('complete','complete-empty') AS good
           FROM workload_collection WHERE tenant_ref = $1 AND outcome <> 'disabled'
       )
       (SELECT DISTINCT ON (workload) * FROM runs ORDER BY workload, created_at DESC, id DESC)
       UNION ALL
       (SELECT DISTINCT ON (workload) * FROM runs WHERE good ORDER BY workload, created_at DESC, id DESC)`,
      [tenantRef],
    );
    for (const workload of [...new Set(rows.map((row) => row.workload))].sort()) required.push(workloadDependency(workload));
    for (const row of rows) {
      observations.push({
        dependency: workloadDependency(row.workload).key,
        observationId: `workload-collection:${row.id}`,
        snapshotId: null,
        outcome: row.outcome,
        success: row.good === true && iso(row.observed_from) !== null,
        startedAt: iso(row.observed_from),
        completedAt: iso(row.observed_to),
      });
    }
  }
  if (present.contentRun) {
    const { rows } = await client.query(
      `WITH runs AS (
         SELECT id::text AS id, workload, outcome, started_at, completed_at, outcome = 'succeeded' AS good
           FROM content_run WHERE tenant_ref = $1
       )
       (SELECT DISTINCT ON (workload) * FROM runs ORDER BY workload, completed_at DESC, id DESC)
       UNION ALL
       (SELECT DISTINCT ON (workload) * FROM runs WHERE good ORDER BY workload, completed_at DESC, id DESC)`,
      [tenantRef],
    );
    for (const workload of [...new Set(rows.map((row) => row.workload))].sort()) required.push(contentDependency(workload));
    for (const row of rows) {
      observations.push({
        dependency: contentDependency(row.workload).key,
        observationId: `content-run:${row.id}`,
        snapshotId: null,
        outcome: row.outcome,
        success: row.good === true && iso(row.started_at) !== null,
        startedAt: iso(row.started_at),
        completedAt: iso(row.completed_at),
      });
    }
  }
  return { required, observations };
}

/**
 * Per workload: the latest run and the last good run, with what the good run holds.
 * Service settings count the settings read (workload_observation rows). Content also
 * carries `stored`, the holdings in the content index for the workload, all time:
 * distinct items, item versions, containers (mailboxes, drives, sites, teams, plans),
 * bytes of all versions, and bytes newly written to storage (after deduplication).
 */
export async function loadServiceBackups(client, { tenantRef }) {
  assertTenantRef(tenantRef);
  const present = await tablesPresent(client);
  const settings = [];
  const content = [];
  if (present.workload) {
    const { rows } = await client.query(
      `WITH latest AS (
         SELECT DISTINCT ON (workload) workload, id::text AS id, outcome, observed_from, observed_to
           FROM workload_collection WHERE tenant_ref = $1
          ORDER BY workload, created_at DESC, id DESC
       ), good AS (
         SELECT DISTINCT ON (workload) workload, id::text AS id, outcome, observed_from, observed_to
           FROM workload_collection WHERE tenant_ref = $1 AND outcome IN ('complete','complete-empty')
          ORDER BY workload, created_at DESC, id DESC
       )
       SELECT l.workload, l.id AS latest_id, l.outcome AS latest_outcome, l.observed_to AS latest_at,
              g.id AS good_id, g.outcome AS good_outcome, g.observed_from AS good_from, g.observed_to AS good_to,
              (SELECT count(*)::int FROM workload_observation o WHERE o.collection_id::text = g.id) AS good_settings,
              EXISTS (SELECT 1 FROM workload_collection a WHERE a.tenant_ref = $1 AND a.workload = l.workload AND a.outcome <> 'disabled') AS switched_on
         FROM latest l LEFT JOIN good g ON g.workload = l.workload
        ORDER BY l.workload`,
      [tenantRef],
    );
    for (const row of rows) {
      settings.push({
        kind: 'service-settings',
        workload: row.workload,
        switchedOn: row.switched_on === true,
        latest: { id: row.latest_id, outcome: row.latest_outcome, at: iso(row.latest_at) },
        lastGood: row.good_id
          ? { id: row.good_id, outcome: row.good_outcome, from: iso(row.good_from), at: iso(row.good_to), settings: Number(row.good_settings ?? 0) }
          : null,
      });
    }
  }
  if (present.contentRun) {
    const { rows } = await client.query(
      `WITH latest AS (
         SELECT DISTINCT ON (workload) workload, id::text AS id, outcome, items, bytes, reasons, name_prefix, started_at, completed_at
           FROM content_run WHERE tenant_ref = $1
          ORDER BY workload, completed_at DESC, id DESC
       ), good AS (
         SELECT DISTINCT ON (workload) workload, id::text AS id, items, bytes, started_at, completed_at
           FROM content_run WHERE tenant_ref = $1 AND outcome = 'succeeded'
          ORDER BY workload, completed_at DESC, id DESC
       )
       SELECT l.workload, l.id AS latest_id, l.outcome AS latest_outcome, l.completed_at AS latest_at, l.reasons AS latest_reasons, l.name_prefix AS latest_prefix,
              g.id AS good_id, g.started_at AS good_from, g.completed_at AS good_to, g.items AS good_items, g.bytes AS good_bytes
         FROM latest l LEFT JOIN good g ON g.workload = l.workload
        ORDER BY l.workload`,
      [tenantRef],
    );
    for (const row of rows) {
      content.push({
        kind: 'content',
        workload: row.workload,
        switchedOn: true,
        latest: { id: row.latest_id, outcome: row.latest_outcome, at: iso(row.latest_at), reasons: Array.isArray(row.latest_reasons) ? row.latest_reasons : [], namePrefix: row.latest_prefix ?? null },
        lastGood: row.good_id
          ? { id: row.good_id, from: iso(row.good_from), at: iso(row.good_to), items: Number(row.good_items ?? 0), bytes: Number(row.good_bytes ?? 0) }
          : null,
        stored: null,
      });
    }
  }
  if (present.contentItem) {
    const { rows } = await client.query(
      `SELECT workload, count(*)::bigint AS versions, count(DISTINCT (container, item_key))::bigint AS items,
              count(DISTINCT container)::bigint AS containers, COALESCE(sum(bytes), 0)::bigint AS bytes,
              COALESCE(sum(new_bytes), 0)::bigint AS new_bytes, max(created_at) AS newest
         FROM content_item WHERE tenant_ref = $1 GROUP BY workload ORDER BY workload`,
      [tenantRef],
    );
    for (const row of rows) {
      const stored = {
        items: Number(row.items), versions: Number(row.versions), containers: Number(row.containers),
        bytes: Number(row.bytes), storedBytes: Number(row.new_bytes), newestAt: iso(row.newest),
      };
      const entry = content.find((candidate) => candidate.workload === row.workload);
      // Items stored before runs were recorded: the workload has content but no run on record.
      if (entry) entry.stored = stored;
      else content.push({ kind: 'content', workload: row.workload, switchedOn: true, latest: null, lastGood: null, stored });
    }
    content.sort((a, b) => a.workload.localeCompare(b.workload));
  }
  return { settings, content };
}
