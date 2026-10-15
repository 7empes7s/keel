/** Spec M2.7. A snapshot is prunable ONLY if nothing depends on it. Retention that deletes
 * the baseline out from under the governance loop is data loss, not cleanup.
 * Roadmap task-71: an active incident retention pin is such a dependency — it
 * supersedes routine retention until an authorized release.
 *
 * Wave 2 RET: what routine retention keeps is a rotation policy per scope
 * (./rotation.mjs: daily/weekly/monthly/yearly counts, keep within N days, keep
 * forever; default 14/8/12/7), and an active legal hold keeps everything in its scope.
 * Content item versions rotate the same way (engine/content/retention.mjs). runPrune
 * writes the report of what goes, what stays and why before it deletes anything, and
 * deletes only with `apply`; the dry run and the real run share one plan. */
import { CONTENT_WORKLOADS } from '../content/store.mjs';
import { createPgContentIndex } from '../content/index.mjs';
import { planContentRetention } from '../content/retention.mjs';
import { describeScope, matchingHolds, normalizePolicy, reasonKind, resolvePolicy, rotationReasons } from './rotation.mjs';

export { DEFAULT_ROTATION } from './rotation.mjs';

// Settings snapshots in a policy or hold scope: workload 'config', container = tier.
export const SNAPSHOT_WORKLOAD = 'config';
// An unfinished snapshot this young may still be running, so it is kept.
const IN_PROGRESS_MS = 24 * 60 * 60 * 1000;

// The old per-tier "keep N days" rule, still accepted as `policy` by the snapshot planner.
const DEFAULT_RETENTION_DAYS = {
  tier1: 7,
  tier2: 90,
  tier3: 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function isPrunable(snapshot, { now, referencedSnapshotIds, policy }) {
  if (referencedSnapshotIds.has(snapshot.id)) return false;

  const retentionDays = (policy ?? DEFAULT_RETENTION_DAYS)[snapshot.tier];
  if (retentionDays === undefined) throw new Error(`no retention policy for ${snapshot.tier}`);

  const snapshotTime = new Date(
    snapshot.completed_at ?? snapshot.completedAt ?? snapshot.started_at ?? snapshot.startedAt,
  );
  return snapshotTime.getTime() < new Date(now).getTime() - retentionDays * DAY_MS;
}

// Every snapshot something outside the snapshot's own rows still points at. A row in
// any of these tables holds a foreign key into snapshot or resource_version, so
// deleting the snapshot would either lose history the governance loop reads or fail
// the whole prune on the constraint. Closed drift and superseded baselines count:
// they are the record of what was decided, not cleanup. The snapshot's own rows
// (resource_version, resource_reference, relationship_edge_set, branding_asset) go with it instead;
// retention.test.mjs checks this list against the schema's foreign keys.
const REFERENCED_SNAPSHOTS_SQL = `
  SELECT DISTINCT snapshot_id, source
  FROM (
    SELECT rv.snapshot_id, 'baseline' AS source
    FROM baseline_resource br
    JOIN resource_version rv ON rv.id = br.resource_version_id
    UNION
    SELECT b.source_snapshot_id AS snapshot_id, 'baseline' AS source
    FROM baseline b
    WHERE b.source_snapshot_id IS NOT NULL
    UNION
    SELECT d.observed_snapshot AS snapshot_id, 'drift' AS source
    FROM drift d
    UNION
    SELECT p.source_snapshot AS snapshot_id, 'plan' AS source
    FROM plan p
    UNION
    SELECT r.snapshot_id, 'restore dry run' AS source
    FROM restore_dry_run r
    UNION
    SELECT rs.source_snapshot AS snapshot_id, 'resource symbol' AS source
    FROM resource_symbol rs
    WHERE rs.source_snapshot IS NOT NULL
    UNION
    SELECT la.source_snapshot AS snapshot_id, 'lineage alias' AS source
    FROM resource_lineage_alias la
    WHERE la.source_snapshot IS NOT NULL
    UNION
    SELECT rp.snapshot_id, 'incident pin' AS source
    FROM retention_pin rp
    WHERE rp.released_at IS NULL
  ) AS referenced_snapshots`;

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function checkScope({ workload = null, container = null, itemKey = null }) {
  if (workload !== null && workload !== SNAPSHOT_WORKLOAD && !CONTENT_WORKLOADS.includes(workload)) {
    throw new TypeError(`workload must be ${SNAPSHOT_WORKLOAD} or one of ${CONTENT_WORKLOADS.join(', ')}`);
  }
  if (container !== null && (workload === null || !requireText(container, 'container'))) throw new TypeError('a container needs a workload');
  if (itemKey !== null && (container === null || !requireText(itemKey, 'itemKey'))) throw new TypeError('an item needs a container');
  return { workload, container, itemKey };
}

const policyFromRow = (row) => ({
  id: row.id, workload: row.workload, container: row.container, itemKey: row.item_key,
  daily: row.daily, weekly: row.weekly, monthly: row.monthly, yearly: row.yearly,
  keepWithinDays: row.keep_within_days, keepForever: row.keep_forever, setBy: row.set_by, setAt: row.set_at,
});

const holdFromRow = (row) => ({
  id: row.id, workload: row.workload, container: row.container, itemKey: row.item_key,
  reason: row.reason, placedBy: row.placed_by, placedAt: row.placed_at,
});

export async function loadRetentionPolicies(client, tenantRef) {
  const { rows } = await client.query('SELECT * FROM retention_policy WHERE tenant_ref = $1 ORDER BY set_at, id', [tenantRef]);
  return rows.map(policyFromRow);
}

/** Sets (or replaces) the policy for one scope. */
export async function setRetentionPolicy(client, { tenantRef, workload, container, itemKey, policy, setBy }) {
  const scope = checkScope({ workload, container, itemKey });
  const p = normalizePolicy(policy);
  const { rows: [row] } = await client.query(
    `INSERT INTO retention_policy
       (tenant_ref, workload, container, item_key, daily, weekly, monthly, yearly, keep_within_days, keep_forever, set_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tenant_ref, (coalesce(workload, '')), (coalesce(container, '')), (coalesce(item_key, '')))
     DO UPDATE SET daily = EXCLUDED.daily, weekly = EXCLUDED.weekly, monthly = EXCLUDED.monthly, yearly = EXCLUDED.yearly,
       keep_within_days = EXCLUDED.keep_within_days, keep_forever = EXCLUDED.keep_forever,
       set_by = EXCLUDED.set_by, set_at = now()
     RETURNING *`,
    [requireText(tenantRef, 'tenantRef'), scope.workload, scope.container, scope.itemKey,
      p.daily, p.weekly, p.monthly, p.yearly, p.keepWithinDays, p.keepForever, requireText(setBy, 'setBy')],
  );
  return policyFromRow(row);
}

export async function loadLegalHolds(client, tenantRef) {
  const { rows } = await client.query(
    'SELECT * FROM legal_hold WHERE tenant_ref = $1 AND released_at IS NULL ORDER BY placed_at, id',
    [tenantRef],
  );
  return rows.map(holdFromRow);
}

/** Holds everything in the scope (tenant, workload, container or item) until released. */
export async function placeLegalHold(client, { tenantRef, workload, container, itemKey, reason, placedBy }) {
  const scope = checkScope({ workload, container, itemKey });
  const { rows: [row] } = await client.query(
    `INSERT INTO legal_hold (tenant_ref, workload, container, item_key, reason, placed_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [requireText(tenantRef, 'tenantRef'), scope.workload, scope.container, scope.itemKey,
      requireText(reason, 'reason'), requireText(placedBy, 'placedBy')],
  );
  return holdFromRow(row);
}

export async function releaseLegalHold(client, { tenantRef, holdId, reason, releasedBy }) {
  const { rows } = await client.query(
    `UPDATE legal_hold SET released_at = now(), released_by = $3, release_reason = $4
     WHERE id = $2 AND tenant_ref = $1 AND released_at IS NULL RETURNING id`,
    [requireText(tenantRef, 'tenantRef'), holdId, requireText(releasedBy, 'releasedBy'), requireText(reason, 'reason')],
  );
  if (!rows.length) throw new Error('active legal hold not found');
  return rows[0].id;
}

// The old per-tier "keep N days" map ({ tier1: 7, ... }) as policies.
const tierDayPolicies = (policy) => Object.entries(policy).map(([tier, days]) => ({
  workload: SNAPSHOT_WORKLOAD, container: tier, itemKey: null, keepWithinDays: days,
}));

/**
 * Every snapshot of the tenant with keep or delete and the reasons. `policy` is the old
 * per-tier days map and replaces the stored policies when given; `policies` and
 * `holds` default to the tenant's stored ones.
 */
export async function planSnapshotRetention(client, { tenantRef, now, policy, policies, holds }) {
  const at = new Date(now);
  const effective = policy ? tierDayPolicies(policy) : (policies ?? await loadRetentionPolicies(client, tenantRef));
  const activeHolds = holds ?? await loadLegalHolds(client, tenantRef);

  const referencedBy = new Map();
  for (const { snapshot_id: id, source } of (await client.query(REFERENCED_SNAPSHOTS_SQL)).rows) {
    if (!referencedBy.has(id)) referencedBy.set(id, new Set());
    referencedBy.get(id).add(source);
  }

  const { rows: snapshots } = await client.query(
    `SELECT s.id, s.started_at, s.completed_at,
            CASE
              WHEN COALESCE(bool_or(rv.criticality = 'tier3'), false) THEN 'tier3'
              WHEN COALESCE(bool_or(rv.criticality = 'tier2'), false) THEN 'tier2'
              ELSE 'tier1'
            END AS tier
     FROM snapshot s
     LEFT JOIN resource_version rv ON rv.snapshot_id = s.id
     WHERE s.tenant_ref = $1
     GROUP BY s.id
     ORDER BY s.started_at, s.id`,
    [tenantRef],
  );

  const byTier = new Map();
  for (const snapshot of snapshots) {
    if (!byTier.has(snapshot.tier)) byTier.set(snapshot.tier, []);
    byTier.get(snapshot.tier).push(snapshot);
  }
  const decisions = new Map();
  for (const [tier, group] of byTier) {
    const { policy: tierPolicy } = resolvePolicy(effective, { workload: SNAPSHOT_WORKLOAD, container: tier, itemKey: null });
    const rotation = rotationReasons(group.map((s) => ({
      id: s.id, at: new Date(s.completed_at ?? s.started_at), rotates: s.completed_at !== null,
    })), tierPolicy, at);
    for (const s of group) {
      // A policy set on this one snapshot replaces its tier's rotation for it.
      const own = resolvePolicy(effective, { workload: SNAPSHOT_WORKLOAD, container: tier, itemKey: s.id });
      const policyReasons = own.rule?.itemKey != null
        ? rotationReasons([{ id: s.id, at: new Date(s.completed_at ?? s.started_at) }], own.policy, at).get(s.id)
        : rotation.get(s.id);
      const reasons = [
        ...[...(referencedBy.get(s.id) ?? [])].sort().map((source) => `referenced by ${source}`),
        ...matchingHolds(activeHolds, { workload: SNAPSHOT_WORKLOAD, container: tier, itemKey: s.id })
          .map((hold) => `legal hold: ${hold.reason}`),
        ...(s.completed_at === null && at - new Date(s.started_at) < IN_PROGRESS_MS ? ['in progress'] : []),
        ...policyReasons,
      ];
      const keep = reasons.length > 0;
      if (!keep) reasons.push(s.completed_at === null ? 'never completed' : `outside policy (${own.label})`);
      decisions.set(s.id, { id: s.id, tier, at: new Date(s.completed_at ?? s.started_at).toISOString(), keep, reasons });
    }
  }
  const entries = snapshots.map((s) => decisions.get(s.id));
  return { entries, delete: entries.filter((e) => !e.keep).map((e) => e.id) };
}

/** The snapshots pruneSnapshots would delete, without deleting anything. */
export async function listPrunableSnapshots(client, options) {
  return (await planSnapshotRetention(client, options)).delete;
}

async function deleteSnapshots(client, tenantRef, prunableSnapshotIds) {
  if (!prunableSnapshotIds.length) return;
  await client.query(
    `DELETE FROM resource_reference
     WHERE from_version IN (
       SELECT id FROM resource_version WHERE snapshot_id = ANY($1::uuid[])
     )`,
    [prunableSnapshotIds],
  );
  await client.query(
    'DELETE FROM resource_version WHERE snapshot_id = ANY($1::uuid[])',
    [prunableSnapshotIds],
  );
  // relationship_edge rows cascade from their set.
  await client.query(
    'DELETE FROM relationship_edge_set WHERE snapshot_id = ANY($1::uuid[])',
    [prunableSnapshotIds],
  );
  // Gap register M6: the snapshot's branding file rows go with it, then any
  // stored file of this tenant that no remaining snapshot points at.
  await client.query(
    'DELETE FROM branding_asset WHERE snapshot_id = ANY($1::uuid[])',
    [prunableSnapshotIds],
  );
  await client.query(
    `DELETE FROM branding_asset_blob b
     WHERE b.tenant_ref = $1
       AND NOT EXISTS (SELECT 1 FROM branding_asset a WHERE a.tenant_ref = b.tenant_ref AND a.sha256 = b.sha256)`,
    [tenantRef],
  );
  await client.query('DELETE FROM snapshot WHERE id = ANY($1::uuid[])', [prunableSnapshotIds]);
}

export async function pruneSnapshots(client, options) {
  await client.query('BEGIN');
  try {
    const prunableSnapshotIds = (await planSnapshotRetention(client, options)).delete;
    await deleteSnapshots(client, options.tenantRef, prunableSnapshotIds);
    await client.query('COMMIT');
    return prunableSnapshotIds;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * One prune run over snapshots and content. Plans with the stored policies and holds,
 * writes the report (what goes, what stays, why), and only with `apply` deletes
 * exactly what the report lists, all in one transaction. Without `apply` nothing is
 * deleted. Returns { reportId, report }.
 */
export async function runPrune(client, { tenantRef, now = new Date(), apply = false }) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`keel-prune:${tenantRef}`]);
    const policies = await loadRetentionPolicies(client, tenantRef);
    const holds = await loadLegalHolds(client, tenantRef);
    const snapshots = await planSnapshotRetention(client, { tenantRef, now, policies, holds });
    const content = await planContentRetention(client, { tenantRef, now, policies, holds });
    const snapshotsKept = {};
    for (const entry of snapshots.entries.filter((e) => e.keep)) {
      const kind = reasonKind(entry.reasons[0]);
      snapshotsKept[kind] = (snapshotsKept[kind] ?? 0) + 1;
    }
    const report = {
      tenantRef,
      mode: apply ? 'apply' : 'dry-run',
      at: new Date(now).toISOString(),
      policies: policies.length
        ? policies.map((rule) => resolvePolicy([rule], rule).label)
        : [resolvePolicy([], {}).label],
      holds: holds.map((hold) => ({ id: hold.id, scope: describeScope(hold), reason: hold.reason })),
      snapshots: { delete: snapshots.delete, kept: snapshotsKept, entries: snapshots.entries },
      content: {
        delete: content.deletions,
        kept: content.kept,
        keptVersions: content.keptVersions,
        singleVersionItems: content.singleVersionItems,
        chunks: content.chunks,
        freedBytes: content.freedBytes,
      },
    };
    const { rows: [{ id: reportId }] } = await client.query(
      `INSERT INTO retention_prune_report (tenant_ref, mode, snapshots_deleted, versions_deleted, chunks_deleted, report)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantRef, report.mode, snapshots.delete.length, content.delete.length, content.chunks.length, report],
    );
    if (apply) {
      await deleteSnapshots(client, tenantRef, snapshots.delete);
      if (content.delete.length) {
        const removed = await createPgContentIndex(client).deleteItems(content.delete);
        if (removed.items !== content.delete.length || removed.chunks.length !== content.chunks.length) {
          throw new Error('content prune removed something other than its report lists; nothing was deleted');
        }
      }
    }
    await client.query('COMMIT');
    return { reportId, report };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
