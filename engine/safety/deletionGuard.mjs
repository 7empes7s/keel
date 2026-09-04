import { refuseIfSynced } from './syncedObjectGuard.mjs';

/** Spec M2.5. Non-overridable refusals. There is no override parameter by design. */
export function refuseUnsafeDeletion(resource, { breakGlassUserIds, breakGlassGroupIds, keelAppIds, caPolicies }) {
  if (!Array.isArray(breakGlassUserIds) || breakGlassUserIds.length === 0) {
    throw new Error('breakGlassUserIds must contain at least one break-glass account before deletion');
  }

  const breakGlassAccount = matchingId([
    resource.naturalKey,
    resource.payload?.id,
    resource.payload?.userPrincipalName,
    resource.targetId,
    resource.live?.targetId,
  ], breakGlassUserIds);
  if (breakGlassAccount) {
    return {
      refused: true,
      reason: `refusing to delete break-glass account ${breakGlassAccount}`,
    };
  }

  if (resource.resourceType === 'conditionalAccessPolicy') {
    const currentPolicy = (caPolicies ?? []).find((policy) => {
      const payload = policy.payload ?? policy;
      return idsMatch(policy.naturalKey, resource.naturalKey)
        || idsMatch(payload.id, resource.payload?.id)
        || idsMatch(payload.id, resource.targetId);
    });
    if (!currentPolicy) {
      return { refused: true, reason: 'cannot verify break-glass exclusions for this policy' };
    }

    const users = (currentPolicy.payload ?? currentPolicy).conditions?.users ?? {};
    const breakGlassUserId = matchingId(users.excludeUsers, breakGlassUserIds);
    if (breakGlassUserId) {
      return {
        refused: true,
        reason: `refusing to delete conditional access policy: ${breakGlassUserId} is excluded by conditions.users.excludeUsers`,
      };
    }

    const breakGlassGroupId = matchingId(users.excludeGroups, breakGlassGroupIds ?? []);
    if (breakGlassGroupId) {
      return {
        refused: true,
        reason: `refusing to delete conditional access policy: ${breakGlassGroupId} is excluded by conditions.users.excludeGroups`,
      };
    }

    const excludedRoleId = firstId(users.excludeRoles);
    if (excludedRoleId) {
      return {
        refused: true,
        reason: `refusing to delete conditional access policy: ${excludedRoleId} is excluded by conditions.users.excludeRoles`,
      };
    }
  }

  if (resource.resourceType === 'group') {
    const groupId = matchingId([
      resource.payload?.id,
      resource.targetId,
      resource.live?.targetId,
    ], (caPolicies ?? []).flatMap((policy) => {
      const payload = policy.payload ?? policy;
      return payload.conditions?.users?.excludeGroups ?? [];
    }));
    if (groupId) {
      const policy = (caPolicies ?? []).find((candidate) => {
        const payload = candidate.payload ?? candidate;
        return matchingId(payload.conditions?.users?.excludeGroups, [groupId]);
      });
      const policyPayload = policy?.payload ?? policy;
      return {
        refused: true,
        reason: `refusing to delete group ${groupId}: it is excluded by conditional access policy ${policy?.naturalKey ?? policyPayload?.id}`,
      };
    }
  }

  const synced = refuseIfSynced(resource);
  if (synced.refused) return synced;

  const keelAppId = matchingId([
    resource.naturalKey,
    resource.payload?.id,
    resource.payload?.appId,
  ], keelAppIds ?? []);
  if (keelAppId) {
    return {
      refused: true,
      reason: `refusing to delete KEEL app registration ${keelAppId}`,
    };
  }

  return { refused: false };
}

function idsMatch(left, right) {
  return typeof left === 'string'
    && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

function matchingId(actualIds, expectedIds) {
  if (!Array.isArray(actualIds) || !Array.isArray(expectedIds)) return null;
  return actualIds.find((actualId) => expectedIds.some((expectedId) => idsMatch(actualId, expectedId))) ?? null;
}

function firstId(ids) {
  return Array.isArray(ids) ? ids.find((id) => typeof id === 'string') ?? null : null;
}
