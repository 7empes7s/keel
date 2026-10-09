import { canonicalHash } from '../cir/canonicalHash.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';

const byType = new Map(CATALOG.map((entry) => [entry.type, entry]));

export const SOFT_DELETABLE = new Set(['user', 'group', 'application']);

/** Spec M2.4. Facts about the live tenant for the natural keys in a plan.
 * state: 'present' | 'soft-deleted' | 'absent'
 *
 * Roadmap task-64: a failed live listing still throws (presence itself is
 * unknown). A failed deleted-items listing is reported through
 * `onDeletedLookupFailure(resourceType, error)` when the caller supplies it, so
 * an absent object of that type is planned as "lookup failed", never as "not
 * found". Without the callback it throws, exactly as before. */
export async function buildLiveIndex(reader, { resourceTypes, naturalKeyFor, onDeletedLookupFailure }) {
  const index = new Map();
  // Issue #156: types under /organization/{id} (company branding and its
  // languages, and the certificate-based authentication configuration) need
  // the directory's id. It is read from the target tenant once, only when such
  // a type is planned.
  let organizationId = null;
  const resolveOrganizationId = async () => {
    if (organizationId) return organizationId;
    const [organization] = await list(reader, 'v1.0', '/organization');
    if (typeof organization?.id !== 'string' || organization.id.length === 0) {
      throw new Error('listing /organization returned no organization id');
    }
    organizationId = organization.id;
    return organizationId;
  };

  for (const resourceType of resourceTypes) {
    const entry = byType.get(resourceType);
    if (!entry) throw new Error(`resource type ${resourceType} not found in tenant-probe CATALOG`);

    const basePath = entry.needsOrgId ? entry.path.replace('{org}', encodeURIComponent(await resolveOrganizationId())) : entry.path;
    const path = entry.select ? `${basePath}?$select=${entry.select}` : basePath;
    const live = await list(reader, entry.version, path, entry);
    for (const object of live) {
      index.set(naturalKeyFor(resourceType, object), {
        targetId: object.id,
        payloadHash: canonicalHash(object, resourceType),
        payload: object,
        state: 'present',
      });
    }

    if (!SOFT_DELETABLE.has(resourceType)) continue;

    let deleted;
    try {
      deleted = await list(
        reader,
        'v1.0',
        `/directory/deletedItems/microsoft.graph.${resourceType}`,
      );
    } catch (error) {
      if (!onDeletedLookupFailure) throw error;
      onDeletedLookupFailure(resourceType, error);
      continue;
    }
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

async function list(reader, version, path, entry = null) {
  const { items, error } = entry?.acceptLanguage
    ? await reader.collect(version, path, { acceptLanguage: entry.acceptLanguage })
    : await reader.collect(version, path);
  // Issue #156: a type Graph answers with 404 when it was never set up (company
  // branding) is absent, the same observation the snapshot collector records.
  if (error && entry?.absentWhenNotFound && error.status === 404) return [];
  if (error) throw new Error(`listing ${path} failed: ${error.error ?? error.status ?? error}`);
  return items;
}
