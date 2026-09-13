import { canonicalHash } from '../cir/canonicalHash.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';

const byType = new Map(CATALOG.map((entry) => [entry.type, entry]));

export const SOFT_DELETABLE = new Set(['user', 'group', 'application']);

/** Spec M2.4. Facts about the live tenant for the natural keys in a plan.
 * state: 'present' | 'soft-deleted' | 'absent' */
export async function buildLiveIndex(reader, { resourceTypes, naturalKeyFor }) {
  const index = new Map();

  for (const resourceType of resourceTypes) {
    const entry = byType.get(resourceType);
    if (!entry) throw new Error(`resource type ${resourceType} not found in tenant-probe CATALOG`);

    const path = entry.select ? `${entry.path}?$select=${entry.select}` : entry.path;
    const live = await list(reader, entry.version, path);
    for (const object of live) {
      index.set(naturalKeyFor(resourceType, object), {
        targetId: object.id,
        payloadHash: canonicalHash(object, resourceType),
        payload: object,
        state: 'present',
      });
    }

    if (!SOFT_DELETABLE.has(resourceType)) continue;

    const deleted = await list(
      reader,
      'v1.0',
      `/directory/deletedItems/microsoft.graph.${resourceType}`,
    );
    for (const object of deleted) {
      const naturalKey = naturalKeyFor(resourceType, object);
      if (index.get(naturalKey)?.state === 'present') continue;
      index.set(naturalKey, {
        targetId: object.id,
        payloadHash: canonicalHash(object, resourceType),
        payload: object,
        state: 'soft-deleted',
        deletedItemId: object.id,
      });
    }
  }

  return index;
}

async function list(reader, version, path) {
  const { items, error } = await reader.collect(version, path);
  if (error) throw new Error(`listing ${path} failed: ${error.error ?? error.status ?? error}`);
  return items;
}
