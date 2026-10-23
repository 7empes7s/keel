import { canonicalHash } from '../cir/canonicalHash.mjs';
import { CATALOG, catalogReadPath } from '../../tools/tenant-probe/catalog.mjs';
import { collectEntry, collectPerParent } from '../collect/entraAdapter.mjs';

const byType = new Map(CATALOG.map((entry) => [entry.type, entry]));

/**
 * Where each soft-deletable type's deleted items are listed and restored.
 * Directory objects use the directory deleted-items container; Conditional
 * Access policies have their own (roadmap task-152). The Conditional Access
 * routes and their API version are declarations to confirm against Microsoft
 * documentation before live qualification: they are fixture-tested only.
 */
export const DELETED_ITEM_ROUTES = Object.freeze({
  // Gap B4 (Q43 step 10): every directory deleted-items listing names its
  // fields. Graph's default projection of a deleted user omits deletedDateTime
  // (groups return it by default), and without it the retention deadline is
  // unprovable and the restore is refused. `select` always carries the id, the
  // natural-key fields and deletedDateTime.
  user: Object.freeze({
    version: 'v1.0',
    list: '/directory/deletedItems/microsoft.graph.user',
    select: 'id,userPrincipalName,displayName,deletedDateTime,onPremisesSyncEnabled,onPremisesImmutableId,accountEnabled,userType',
    restore: (id) => `/directory/deletedItems/${id}/restore`,
  }),
  group: Object.freeze({
    version: 'v1.0',
    list: '/directory/deletedItems/microsoft.graph.group',
    select: 'id,displayName,mailNickname,deletedDateTime,groupTypes,securityEnabled,mailEnabled,onPremisesSyncEnabled',
    restore: (id) => `/directory/deletedItems/${id}/restore`,
  }),
  application: Object.freeze({
    version: 'v1.0',
    list: '/directory/deletedItems/microsoft.graph.application',
    select: 'id,appId,displayName,deletedDateTime',
    restore: (id) => `/directory/deletedItems/${id}/restore`,
  }),
  conditionalAccessPolicy: Object.freeze({
    version: 'v1.0',
    list: '/identity/conditionalAccess/deletedItems/policies',
    restore: (id) => `/identity/conditionalAccess/deletedItems/policies/${encodeURIComponent(id)}/restore`,
  }),
});

export const SOFT_DELETABLE = new Set(Object.keys(DELETED_ITEM_ROUTES));

// Types whose deleted items are matched by a name that need not be unique.
const AMBIGUITY_REFUSED = new Set(['conditionalAccessPolicy']);

/** The deleted-items listing path for this type, with its `$select` when the route names one. */
export function deletedItemListPath(resourceType) {
  const route = DELETED_ITEM_ROUTES[resourceType];
  if (!route) throw new Error(`resource type ${resourceType} is not soft-deletable`);
  return route.select ? `${route.list}?$select=${route.select}` : route.list;
}

/** The restore route for a deleted item of this type (directory deleted items by default). */
export function deletedItemRestorePath(resourceType, deletedItemId) {
  const route = DELETED_ITEM_ROUTES[resourceType];
  return route ? route.restore(deletedItemId) : `/directory/deletedItems/${deletedItemId}/restore`;
}

/** Spec M2.4. Facts about the live tenant for the natural keys in a plan.
 * state: 'present' | 'soft-deleted' | 'absent'
 *
 * Roadmap task-64: a failed live listing still throws (presence itself is
 * unknown). A failed deleted-items listing is reported through
 * `onDeletedLookupFailure(resourceType, error)` when the caller supplies it, so
 * an absent object of that type is planned as "lookup failed", never as "not
 * found". Without the callback it throws, exactly as before.
 * `deletedNaturalKeyFor` keys deleted items (defaults to `naturalKeyFor`). */
export async function buildLiveIndex(reader, { resourceTypes, naturalKeyFor, deletedNaturalKeyFor = naturalKeyFor, onDeletedLookupFailure }) {
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

    // Issue #473: a kind read per parent (a policy set with its items, a
    // compliance policy with its settings) has `{parent}` in its path. The live
    // read lists the parents and reads each one, exactly as the collector does.
    const live = entry.parent
      ? await listPerParent(reader, entry)
      : entry.selectEach
        ? await listEachField(reader, entry)
        : await list(reader, entry.version, catalogReadPath(entry, entry.needsOrgId ? entry.path.replace('{org}', encodeURIComponent(await resolveOrganizationId())) : entry.path), entry);
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
      const route = DELETED_ITEM_ROUTES[resourceType];
      deleted = await list(reader, route.version, deletedItemListPath(resourceType));
    } catch (error) {
      if (!onDeletedLookupFailure) throw error;
      onDeletedLookupFailure(resourceType, error);
      continue;
    }
    for (const object of deleted) {
      // Gap B4: a deleted item is matched by the snapshot's source id first (its
      // name may have changed on deletion), then by its natural key.
      const naturalKey = deletedNaturalKeyFor(resourceType, object);
      const known = index.get(naturalKey);
      if (known?.state === 'present') continue;
      // Task-152: deleted Conditional Access policies are keyed by display name,
      // so two with one name cannot be told apart. Neither is chosen: the entry
      // is marked ambiguous and its restore is refused.
      if (known?.state === 'soft-deleted' && AMBIGUITY_REFUSED.has(resourceType)) {
        index.set(naturalKey, { ...known, ambiguous: true, candidates: [...(known.candidates ?? [known.deletedItemId]), object.id] });
        continue;
      }
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

async function listPerParent(reader, entry) {
  const { items, error, capped } = await collectPerParent(reader, entry);
  if (error) throw new Error(`listing ${entry.type} per parent failed: ${error.error ?? error.status ?? error}`);
  if (capped) throw new Error(`listing ${entry.type} per parent failed: pagination incomplete`);
  return items;
}

// Issue #447: a singleton read one field per request, as the collector reads it.
async function listEachField(reader, entry) {
  const { items, error, pages } = await collectEntry(reader, entry);
  // A 404 after a field was read is a failed read, not an absent singleton.
  if (error && entry.absentWhenNotFound && error.status === 404 && !(pages > 0)) return [];
  if (error) throw new Error(`listing ${entry.path} failed: ${error.error ?? error.status ?? error}`);
  return items;
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
