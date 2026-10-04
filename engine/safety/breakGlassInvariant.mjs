/** Spec §10.4 — a precondition to be arranged, never relaxed. Failure aborts
 * the run; there is no override parameter on this function by design. */
export function assertBreakGlassCoverage({ breakGlassUserIds, caPoliciesInRestoreSet }) {
  if (breakGlassUserIds.length < 2) {
    return { ok: false, reason: `only ${breakGlassUserIds.length} break-glass account(s) found in the target tenant, need at least 2` };
  }
  for (const policy of caPoliciesInRestoreSet) {
    const excluded = new Set(policy.conditions?.users?.excludeUsers ?? []);
    for (const bg of breakGlassUserIds) {
      if (!excluded.has(bg)) {
        return { ok: false, reason: `break-glass account ${bg} is not excluded from policy ${policy.naturalKey}` };
      }
    }
  }
  return { ok: true };
}

/**
 * Roadmap task-94: how one enforced policy treats one emergency account, as one of
 * 'excluded' | 'applies' | 'not-applicable' | 'unknown'. It never collapses an unread
 * condition into "excluded": an excluded group whose membership KEEL has not read
 * completely, or included groups or roles it cannot resolve, stay unknown.
 *
 * `groupMembers(groupId)` returns true / false when the group's (transitive)
 * membership is known and null when it is not; `roleTemplates` is the set of role
 * template ids the account actively holds, or null when role assignments are unknown.
 */
export function policyTreatment(policy, accountId, { groupMembers = () => null, roleTemplates = null } = {}) {
  const users = policy?.conditions?.users;
  if (!users || typeof users !== 'object') return { treatment: 'unknown', reason: 'user-conditions-unreadable' };
  const id = String(accountId).toLowerCase();
  const lower = (list) => (Array.isArray(list) ? list.map((value) => String(value).toLowerCase()) : []);
  if (lower(users.excludeUsers).includes(id)) return { treatment: 'excluded', reason: 'excluded-directly' };
  let unresolved = false;
  for (const group of lower(users.excludeGroups)) {
    const member = groupMembers(group);
    if (member === true) return { treatment: 'excluded', reason: 'excluded-through-group', group };
    if (member === null) unresolved = true;
  }
  const excludedRoles = lower(users.excludeRoles);
  if (excludedRoles.length) {
    if (roleTemplates === null) unresolved = true;
    else if (excludedRoles.some((role) => roleTemplates.has(role))) return { treatment: 'excluded', reason: 'excluded-through-role' };
  }
  const includeUsers = lower(users.includeUsers);
  if (includeUsers.includes('all') || includeUsers.includes(id)) {
    return unresolved ? { treatment: 'unknown', reason: 'exclusion-membership-unread' } : { treatment: 'applies', reason: 'included' };
  }
  for (const group of lower(users.includeGroups)) {
    const member = groupMembers(group);
    if (member === true) return unresolved ? { treatment: 'unknown', reason: 'exclusion-membership-unread' } : { treatment: 'applies', reason: 'included-through-group', group };
    if (member === null) unresolved = true;
  }
  const includedRoles = lower(users.includeRoles);
  if (includedRoles.length) {
    if (roleTemplates === null) unresolved = true;
    else if (includedRoles.some((role) => roleTemplates.has(role))) {
      return unresolved ? { treatment: 'unknown', reason: 'exclusion-membership-unread' } : { treatment: 'applies', reason: 'included-through-role' };
    }
  }
  // A guest or external-user condition does not reach a member account; the identity
  // dimension separately fails an emergency account that is a guest.
  return unresolved ? { treatment: 'unknown', reason: 'inclusion-membership-unread' } : { treatment: 'not-applicable', reason: 'not-included' };
}
