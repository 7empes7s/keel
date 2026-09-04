/** Spec M2.7. A snapshot is prunable ONLY if nothing depends on it. Retention that deletes
 * the baseline out from under the governance loop is data loss, not cleanup. */
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

export async function pruneSnapshots(client, { tenantRef, policy, now }) {
  await client.query('BEGIN');
  try {
    const { rows: referencedSnapshots } = await client.query(
      `SELECT DISTINCT snapshot_id
       FROM (
         SELECT rv.snapshot_id
         FROM baseline_resource br
         JOIN baseline b ON b.id = br.baseline_id
         JOIN resource_version rv ON rv.id = br.resource_version_id
         WHERE b.active
         UNION
         SELECT d.observed_snapshot AS snapshot_id
         FROM drift d
         WHERE NOT EXISTS (
           SELECT 1 FROM disposition p WHERE p.drift_id = d.id
         )
         UNION
         SELECT p.source_snapshot AS snapshot_id
         FROM plan p
       ) AS referenced_snapshots`,
    );
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
    const prunableSnapshotIds = snapshots
      .filter((snapshot) => isPrunable(snapshot, { now, referencedSnapshotIds, policy }))
      .map((snapshot) => snapshot.id);

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
      await client.query('DELETE FROM snapshot WHERE id = ANY($1::uuid[])', [prunableSnapshotIds]);
    }

    await client.query('COMMIT');
    return prunableSnapshotIds;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
