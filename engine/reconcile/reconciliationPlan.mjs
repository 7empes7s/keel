import { canonicalHash } from '../cir/canonicalHash.mjs';
import { naturalKeyFor } from '../cir/naturalKey.mjs';
import { SOFT_DELETABLE, buildLiveIndex } from './liveState.mjs';
import { selectRecoveryMechanism } from '../restore/recoveryMechanism.mjs';
import { decideVerb } from './verb.mjs';
import { licencePlan } from '../restore/userOperations.mjs';

// Roadmap task-150: licences are left out of the hash, so an object whose only
// difference is a licence the snapshot held and live lacks is planned as an update.
function licenceDecision(resource, current, decision) {
  if (decision.verb !== 'noop' || current?.state !== 'present') return decision;
  if (resource.resourceType !== 'user' && resource.resourceType !== 'group') return decision;
  const { add } = licencePlan(resource.payload, current.payload, { resourceType: resource.resourceType });
  if (add.length === 0) return decision;
  return { verb: 'update', reason: `licences differ: ${add.map((licence) => licence.skuId).join(', ')} held in the snapshot, missing live` };
}

/** The object id a snapshot or live resource carries, lower-cased, or null. */
function objectIdOf(resource) {
  const id = resource.sourceId ?? resource.payload?.id;
  return typeof id === 'string' && id.length > 0 ? id.toLowerCase() : null;
}

/** Live objects are matched to a plan by object id before natural key, so a type
 * keyed by display name (Conditional Access policies, named locations,
 * authentication strengths, groups) survives a rename.
 *
 * Same-tenant restore (`sameTenant`): a live object whose id a snapshot resource
 * carries IS that resource, whatever it is called now, so it takes the snapshot's
 * key and is planned as an update that puts the name back, never as a create of a
 * duplicate beside it. Cross-tenant restores keep the natural key: the ids differ.
 * The live tenant's own ids (targetResources) come second, so the live object's
 * current name never hides the snapshot's. */
function keyForLiveObject(targetResources, resources, { sameTenant }) {
  const naturalKeyByTypeAndId = new Map();
  const symbolById = new Map();
  const targetByNaturalKey = new Map(targetResources.map((resource) => [resource.naturalKey, resource]));
  const index = (resource) => {
    const id = objectIdOf(resource);
    if (!id) return;
    const typeAndId = `${resource.resourceType}:${id}`;
    if (!naturalKeyByTypeAndId.has(typeAndId)) naturalKeyByTypeAndId.set(typeAndId, resource.naturalKey);
    if (!symbolById.has(id)) symbolById.set(id, resource.naturalKey);
  };

  if (sameTenant) for (const resource of resources) index(resource);
  for (const resource of targetResources) index(resource);
  // Gap B4: the target's current collection never holds a deleted item, so a
  // deleted item is matched by the SNAPSHOT's source id (the same tenant keeps
  // the id through a soft delete) before its natural key, which Entra may have
  // changed on deletion.
  const snapshotKeyByTypeAndId = new Map();
  for (const resource of resources) {
    if (typeof resource.sourceId !== 'string' || resource.sourceId.length === 0) continue;
    snapshotKeyByTypeAndId.set(`${resource.resourceType}:${resource.sourceId.toLowerCase()}`, resource.naturalKey);
  }

  function naturalKeyForLiveObject(resourceType, object) {
    const known = typeof object.id === 'string' ? naturalKeyByTypeAndId.get(`${resourceType}:${object.id.toLowerCase()}`) : undefined;
    if (known) return known;

    const naturalKey = naturalKeyFor(resourceType, object, {
      resolveSymbol: (id) => symbolById.get(id.toLowerCase()) ?? null,
    });
    return resourceType === 'roleAssignment' ? naturalKey : `${resourceType}:${naturalKey}`;
  }

  return {
    targetByNaturalKey,
    naturalKeyForLiveObject,
    naturalKeyForDeletedObject(resourceType, object) {
      const id = typeof object?.id === 'string' ? object.id.toLowerCase() : null;
      return (id && snapshotKeyByTypeAndId.get(`${resourceType}:${id}`)) ?? naturalKeyForLiveObject(resourceType, object);
    },
  };
}

/** Builds the one executable reconciliation plan for both restore and remediation.
 * Current facts are collected with the reader, desired state comes from the supplied
 * resource set, and decideVerb remains the only write-verb table. */
export async function buildReconciliationPlan(reader, resources, { targetResources = [], sameTenant = false, nativeLookups = null, now = new Date() } = {}) {
  const { targetByNaturalKey, naturalKeyForLiveObject, naturalKeyForDeletedObject } = keyForLiveObject(targetResources, resources, { sameTenant });
  const resourceTypes = [...new Set(resources.map((resource) => resource.resourceType))];
  // Task-64: a failed deleted-items read is kept per type, so an absent object
  // of that type is refused rather than recreated beside a possible original.
  const deletedLookupFailures = new Map();
  const liveIndex = await buildLiveIndex(reader, {
    resourceTypes,
    naturalKeyFor: naturalKeyForLiveObject,
    deletedNaturalKeyFor: naturalKeyForDeletedObject,
    onDeletedLookupFailure: (resourceType, error) => deletedLookupFailures.set(resourceType, error.message),
  });
  const resolved = [];
  const noops = [];

  for (const resource of resources) {
    const current = liveIndex.get(resource.naturalKey) ?? null;
    const desired = resource.payload === null
      ? null
      : { payloadHash: resource.payloadHash ?? canonicalHash(resource.payload, resource.resourceType) };
    const live = current?.state === 'present' ? { payloadHash: current.payloadHash } : null;
    const decision = licenceDecision(resource, current, decideVerb({
      desired,
      live,
      softDeleted: current?.state === 'soft-deleted',
    }));
    const targetResource = targetByNaturalKey.get(resource.naturalKey);
    const planned = {
      ...resource,
      references: resource.references?.length
        ? resource.references
        : targetResource?.references ?? resource.references ?? [],
      live: current,
      targetId: current?.targetId,
      deletedItemId: current?.deletedItemId,
      verb: decision.verb,
      verbReason: decision.reason,
    };
    planned.recovery = selectRecoveryMechanism(planned, {
      deletedLookup: !SOFT_DELETABLE.has(resource.resourceType)
        ? 'not-applicable'
        : deletedLookupFailures.has(resource.resourceType) ? 'failed' : 'ok',
      nativeLookup: nativeLookups?.get(resource.naturalKey) ?? null,
      now,
    });
    resolved.push(planned);
    if (decision.verb === 'noop') noops.push({ naturalKey: resource.naturalKey, reason: decision.reason });
  }

  return { resources: resolved, noops, liveIndex, deletedLookupFailures };
}
