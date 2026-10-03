import { canonicalHash } from '../cir/canonicalHash.mjs';
import { naturalKeyFor } from '../cir/naturalKey.mjs';
import { SOFT_DELETABLE, buildLiveIndex } from './liveState.mjs';
import { selectRecoveryMechanism } from '../restore/recoveryMechanism.mjs';
import { decideVerb } from './verb.mjs';

function keyForLiveObject(targetResources) {
  const naturalKeyByTypeAndId = new Map();
  const symbolById = new Map();
  const targetByNaturalKey = new Map(targetResources.map((resource) => [resource.naturalKey, resource]));

  for (const resource of targetResources) {
    if (typeof resource.sourceId !== 'string') continue;
    naturalKeyByTypeAndId.set(`${resource.resourceType}:${resource.sourceId}`, resource.naturalKey);
    symbolById.set(resource.sourceId.toLowerCase(), resource.naturalKey);
  }

  return {
    targetByNaturalKey,
    naturalKeyForLiveObject(resourceType, object) {
      const known = naturalKeyByTypeAndId.get(`${resourceType}:${object.id}`);
      if (known) return known;

      const naturalKey = naturalKeyFor(resourceType, object, {
        resolveSymbol: (id) => symbolById.get(id.toLowerCase()) ?? null,
      });
      return resourceType === 'roleAssignment' ? naturalKey : `${resourceType}:${naturalKey}`;
    },
  };
}

/** Builds the one executable reconciliation plan for both restore and remediation.
 * Current facts are collected with the reader, desired state comes from the supplied
 * resource set, and decideVerb remains the only write-verb table. */
export async function buildReconciliationPlan(reader, resources, { targetResources = [], nativeLookups = null, now = new Date() } = {}) {
  const { targetByNaturalKey, naturalKeyForLiveObject } = keyForLiveObject(targetResources);
  const resourceTypes = [...new Set(resources.map((resource) => resource.resourceType))];
  // Task-64: a failed deleted-items read is kept per type, so an absent object
  // of that type is refused rather than recreated beside a possible original.
  const deletedLookupFailures = new Map();
  const liveIndex = await buildLiveIndex(reader, {
    resourceTypes,
    naturalKeyFor: naturalKeyForLiveObject,
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
    const decision = decideVerb({
      desired,
      live,
      softDeleted: current?.state === 'soft-deleted',
    });
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
