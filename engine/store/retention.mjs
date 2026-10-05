/** Spec M2.7. A snapshot is prunable ONLY if nothing depends on it. Retention that deletes
 * the baseline out from under the governance loop is data loss, not cleanup.
 * Roadmap task-71: an active incident retention pin is such a dependency — it
 * supersedes routine retention until an authorized release. */
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
// (resource_version, resource_reference, relationship_edge_set) go with it instead;
// retention.test.mjs checks this list against the schema's foreign keys.
const REFERENCED_SNAPSHOTS_SQL = `
  SELECT DISTINCT snapshot_id
  FROM (
    SELECT rv.snapshot_id
    FROM baseline_resource br
    JOIN resource_version rv ON rv.id = br.resource_version_id
    UNION
    SELECT b.source_snapshot_id AS snapshot_id
    FROM baseline b
    WHERE b.source_snapshot_id IS NOT NULL
    UNION
    SELECT d.observed_snapshot AS snapshot_id
    FROM drift d
    UNION
    SELECT p.source_snapshot AS snapshot_id
    FROM plan p
    UNION
    SELECT r.snapshot_id
    FROM restore_dry_run r
    UNION
    SELECT rs.source_snapshot AS snapshot_id
    FROM resource_symbol rs
    WHERE rs.source_snapshot IS NOT NULL
    UNION
    SELECT la.source_snapshot AS snapshot_id
    FROM resource_lineage_alias la
    WHERE la.source_snapshot IS NOT NULL
    UNION
    SELECT rp.snapshot_id
    FROM retention_pin rp
    WHERE rp.released_at IS NULL
  ) AS referenced_snapshots`;

/** The snapshots pruneSnapshots would delete, without deleting anything. The CLI's
 * --dry-run uses this, so a dry run and a real run always pick the same set. */
export async function listPrunableSnapshots(client, { tenantRef, policy, now }) {
  const { rows: referencedSnapshots } = await client.query(REFERENCED_SNAPSHOTS_SQL);
  const referencedSnapshotIds = new Set(referencedSnapshots.map(({ snapshot_id }) => snapshot_id));

  const { rows: snapshots } = await client.query(
    `SELECT s.*,
            CASE
              WHEN COALESCE(bool_or(rv.criticality = 'tier3'), false) THEN 'tier3'
              WHEN COALESCE(bool_or(rv.criticality = 'tier2'), false) THEN 'tier2'
              ELSE 'tier1'
            END AS tier
     FROM snapshot s
     LEFT JOIN resource_version rv ON rv.snapshot_id = s.id
     WHERE s.tenant_ref = $1
     GROUP BY s.id
     ORDER BY s.started_at`,
    [tenantRef],
  );
  return snapshots
    .filter((snapshot) => isPrunable(snapshot, { now, referencedSnapshotIds, policy }))
    .map((snapshot) => snapshot.id);
}

export async function pruneSnapshots(client, { tenantRef, policy, now }) {
  await client.query('BEGIN');
  try {
    const prunableSnapshotIds = await listPrunableSnapshots(client, { tenantRef, policy, now });

    if (prunableSnapshotIds.length) {
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
      await client.query('DELETE FROM snapshot WHERE id = ANY($1::uuid[])', [prunableSnapshotIds]);
    }

    await client.query('COMMIT');
    return prunableSnapshotIds;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
