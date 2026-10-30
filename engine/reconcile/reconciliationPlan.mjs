import { canonicalHash } from '../cir/canonicalHash.mjs';
import { naturalKeyFor } from '../cir/naturalKey.mjs';
import { SOFT_DELETABLE, buildLiveIndex } from './liveState.mjs';
import { selectRecoveryMechanism } from '../restore/recoveryMechanism.mjs';
import { decideVerb } from './verb.mjs';
import { withLiveAppId } from './liveAppId.mjs';
import { licencePlan } from '../restore/userOperations.mjs';
import { adoptableLiveObject } from '../restore/directoryPolicyOperations.mjs';

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
 * current name never hides the snapshot's.
 *
 * Issue #485: an object an earlier restore created into this tenant has a new
 * id, so its backup key (built from the old id) matches nothing live. The ids
 * the journal recorded for each create (`createdTargetIds`, scoped to the
 * target tenant) come after the snapshot's own ids and before the live tenant's,
 * so the created object takes the backup's key and a re-run plans an update or
 * a noop, never a second create. */
function keyForLiveObject(targetResources, resources, { sameTenant, createdTargetIds = null }) {
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
  for (const resource of resources) {
    for (const id of createdTargetIds?.get(resource.naturalKey)?.targetIds ?? []) {
      index({ resourceType: resource.resourceType, naturalKey: resource.naturalKey, sourceId: id });
    }
  }
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
  // Issue #485: a created object that was deleted since is found the same way.
  for (const resource of resources) {
    for (const id of createdTargetIds?.get(resource.naturalKey)?.targetIds ?? []) {
      const typeAndId = `${resource.resourceType}:${id.toLowerCase()}`;
      if (!snapshotKeyByTypeAndId.has(typeAndId)) snapshotKeyByTypeAndId.set(typeAndId, resource.naturalKey);
    }
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

/** The name an object is known by, for adopting it after an earlier create. */
function nameOf(payload) {
  const name = payload?.displayName ?? payload?.name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim().toLowerCase() : null;
}

/** Issue #485: the one present live object of the resource's type that carries
 * the backup's name and that no planned resource already holds, or null. Two
 * candidates are never guessed between. */
function adoptByUniqueName(liveIndex, resource, plannedKeys, adoptedKeys) {
  const name = nameOf(resource.payload);
  if (!name) return null;
  const matches = [...liveIndex.entries()].filter(([key, entry]) => entry.state === 'present'
    && !plannedKeys.has(key)
    && !adoptedKeys.has(key)
    && key.startsWith(`${resource.resourceType}:`)
    && nameOf(entry.payload) === name);
  if (matches.length !== 1) return null;
  adoptedKeys.add(matches[0][0]);
  return matches[0][1];
}

/** The backup's hash under the current field rules. The live side is always hashed
 * fresh (liveState.mjs), so a hash stored under older rules (a field classified
 * server-owned since) would make identical content look different and plan an update
 * that writes nothing (cir/canonicalHash.mjs sameContent). The stored hash is used only
 * when the payload cannot be hashed. `current` is the live object it is compared with. */
function desiredHash(resource, current = null) {
  if (resource.payload == null) return resource.payloadHash;
  try {
    return canonicalHash(withLiveAppId(resource.payload, resource.resourceType, current), resource.resourceType);
  } catch (error) {
    if (typeof resource.payloadHash === 'string') return resource.payloadHash;
    throw error;
  }
}

/** Builds the one executable reconciliation plan for both restore and remediation.
 * Current facts are collected with the reader, desired state comes from the supplied
 * resource set, and decideVerb remains the only write-verb table. */
export async function buildReconciliationPlan(reader, resources, {
  targetResources = [], sameTenant = false, nativeLookups = null, createdTargetIds = null, now = new Date(),
} = {}) {
  const { targetByNaturalKey, naturalKeyForLiveObject, naturalKeyForDeletedObject } = keyForLiveObject(targetResources, resources, { sameTenant, createdTargetIds });
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
  const plannedKeys = new Set(resources.map((resource) => resource.naturalKey));
  const adoptedKeys = new Set();

  for (const resource of resources) {
    let current = liveIndex.get(resource.naturalKey) ?? null;
    const desiredFor = (live) => (resource.payload === null ? null : { payloadHash: desiredHash(resource, live) });
    const desired = desiredFor(current);
    const live = current?.state === 'present' ? { payloadHash: current.payloadHash } : null;
    let decision = licenceDecision(resource, current, decideVerb({
      desired,
      live,
      softDeleted: current?.state === 'soft-deleted',
    }));
    // Issue #294: a create the writer would answer by adopting a live twin
    // (an STS policy with the same name and definition, made by an earlier
    // run under a new id) writes nothing, so it is planned as a noop, never
    // as a recreate. A live object another planned resource holds is not one.
    if (decision.verb === 'create') {
      const candidates = [...liveIndex.entries()]
        .filter(([key, entry]) => entry.state === 'present' && !plannedKeys.has(key) && key.startsWith(`${resource.resourceType}:`));
      const adopted = adoptableLiveObject(resource.resourceType, resource.payload, candidates.map(([, entry]) => entry.payload));
      if (adopted) {
        current = candidates.find(([, entry]) => entry.payload === adopted)[1];
        decision = { verb: 'noop', reason: `adopts live ${adopted.id}: same name and definition as the backup, nothing to write` };
      }
    }
    // Issue #485: a create an earlier restore sent for this backup key may have
    // landed without recording its id (a lost response). The live object of
    // the same type with the same name, when exactly one exists and no other
    // planned resource holds it, is that object: it is updated, not duplicated.
    if (decision.verb === 'create' && createdTargetIds?.get(resource.naturalKey)?.unknownIdCreates > 0) {
      const adopted = adoptByUniqueName(liveIndex, resource, plannedKeys, adoptedKeys);
      if (adopted) {
        current = adopted;
        decision = decideVerb({ desired: desiredFor(adopted), live: { payloadHash: adopted.payloadHash }, softDeleted: false });
        decision = { ...decision, reason: `adopts live ${adopted.targetId}, created by an earlier restore of this backup: ${decision.reason}` };
      }
    }
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
