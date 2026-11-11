/**
 * Issue #1076: storage of the deleted items a backup listed
 * (engine/reconcile/deletedItems.mjs). Each object keeps one row, refreshed by
 * every listing that names it, and each type its latest complete listing, so the
 * table grows with deletions, not with backups. A failed listing changes nothing.
 */

/** Records one backup's listings. `reads` as readDeletedItems returns them. */
export async function recordDeletedItems(client, { tenantRef, snapshotId, reads, readAt = new Date() }) {
  for (const read of reads ?? []) {
    if (read.outcome !== 'complete') continue;
    for (const item of read.items) {
      await client.query(
        `INSERT INTO deleted_item (tenant_ref, resource_type, source_id, deleted_at, last_snapshot_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_ref, resource_type, source_id) DO UPDATE
           SET deleted_at = EXCLUDED.deleted_at, last_snapshot_id = EXCLUDED.last_snapshot_id`,
        [tenantRef, read.resourceType, item.sourceId.toLowerCase(), item.deletedAt ?? null, snapshotId],
      );
    }
    await client.query(
      `INSERT INTO deleted_item_read (tenant_ref, resource_type, snapshot_id, read_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_ref, resource_type) DO UPDATE SET snapshot_id = EXCLUDED.snapshot_id, read_at = EXCLUDED.read_at`,
      [tenantRef, read.resourceType, snapshotId, readAt],
    );
  }
}

/**
 * The deleted date of each of these objects that the latest complete listing of
 * its type still named: a Map of `${resourceType}|${sourceId}` (lowercase id) to
 * an ISO date. An object listed without a deleted date is left out. One query.
 */
export async function currentDeletedItems(client, { tenantRef, sourceIds }) {
  const ids = [...new Set((sourceIds ?? []).filter((id) => typeof id === 'string' && id.length > 0).map((id) => id.toLowerCase()))];
  if (ids.length === 0) return new Map();
  const { rows } = await client.query(
    `SELECT i.resource_type, i.source_id, i.deleted_at
       FROM deleted_item i
       JOIN deleted_item_read r
         ON r.tenant_ref = i.tenant_ref AND r.resource_type = i.resource_type AND r.snapshot_id = i.last_snapshot_id
      WHERE i.tenant_ref = $1 AND i.source_id = ANY($2::text[]) AND i.deleted_at IS NOT NULL`,
    [tenantRef, ids],
  );
  return new Map(rows.map((row) => [`${row.resource_type}|${row.source_id}`, new Date(row.deleted_at).toISOString()]));
}
