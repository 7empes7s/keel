import { refuseIfSynced } from './syncedObjectGuard.mjs';

/** Spec M2.5. Non-overridable refusals. There is no override parameter by design. */
export function refuseUnsafeDeletion(resource, { breakGlassUserIds, keelAppIds, caPolicies }) {
  if (breakGlassUserIds.includes(resource.naturalKey) || breakGlassUserIds.includes(resource.payload?.id)) {
    return {
      refused: true,
      reason: `refusing to delete break-glass account ${resource.payload?.id ?? resource.naturalKey}`,
    };
  }

  if (resource.resourceType === 'conditionalAccessPolicy') {
    const currentPolicy = caPolicies.find((policy) => {
      const payload = policy.payload ?? policy;
      return policy.naturalKey === resource.naturalKey || payload.id === resource.payload?.id;
    }) ?? resource;
    const excluded = (currentPolicy.payload ?? currentPolicy).conditions?.users?.excludeUsers ?? [];
    const breakGlassUserId = breakGlassUserIds.find((id) => excluded.includes(id));
    if (breakGlassUserId) {
      return {
        refused: true,
        reason: `refusing to delete conditional access policy: break-glass account ${breakGlassUserId} is excluded`,
      };
    }
  }

  const synced = refuseIfSynced(resource);
  if (synced.refused) return synced;

  if (keelAppIds.includes(resource.naturalKey)
    || keelAppIds.includes(resource.payload?.id)
    || keelAppIds.includes(resource.payload?.appId)) {
    return {
      refused: true,
      reason: `refusing to delete KEEL app registration ${resource.payload?.appId ?? resource.payload?.id ?? resource.naturalKey}`,
    };
  }

  return { refused: false };
}
