/**
 * Issue #1076: the deleted items a backup lists beside the snapshot, so the
 * Changes list can say until when a removed user, group, app or Conditional
 * Access policy can still be recovered. Only types this backup read in full are
 * listed (a type it skipped or failed keeps its last listing), through the same
 * routes and `$select` the restore plan uses. Read-only: a listing never writes.
 */
import { DELETED_ITEM_ROUTES, SOFT_DELETABLE, deletedItemListPath } from './liveState.mjs';

const READ_TYPES = new Set(['complete', 'complete-empty']);

/** [{ resourceType, outcome: 'complete' | 'failed', items: [{ sourceId, deletedAt }] }] */
export async function readDeletedItems(reader, { coverageDigest = {} } = {}) {
  const reads = [];
  for (const resourceType of SOFT_DELETABLE) {
    if (!READ_TYPES.has(coverageDigest?.[resourceType]?.outcome)) continue;
    let listing;
    try {
      listing = await reader.collect(DELETED_ITEM_ROUTES[resourceType].version, deletedItemListPath(resourceType));
    } catch (error) {
      listing = { error: { error: error?.message ?? String(error) } };
    }
    if (listing?.error || !Array.isArray(listing?.items)) {
      reads.push({ resourceType, outcome: 'failed', items: [] });
      continue;
    }
    reads.push({
      resourceType,
      outcome: 'complete',
      items: listing.items
        .filter((item) => typeof item?.id === 'string' && item.id.length > 0)
        .map((item) => ({
          sourceId: item.id.toLowerCase(),
          deletedAt: typeof item.deletedDateTime === 'string' ? item.deletedDateTime : null,
        })),
    });
  }
  return reads;
}
