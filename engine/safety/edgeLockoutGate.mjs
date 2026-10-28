/**
 * Security audit run 2, finding 1: group member edges can lock a tenant out.
 *
 * A member restore that removes a break-glass account from the group that gives
 * it Global Administrator, or from a group a Conditional Access policy excludes,
 * takes away the way back in. Two checks close that:
 *
 * 1. The planner never removes a protected principal from any edge set. The
 *    protected list is the Global Administrator principals AND the registered
 *    break-glass accounts (`protectedEdgePrincipalIds`), and it never removes a
 *    member from a group that itself holds Global Administrator
 *    (relationshipWriter.mjs).
 * 2. Every other member write that can change break-glass readiness goes through
 *    the break-glass lockout gate, evaluated with the membership as it would be
 *    after the writes (`gateRelationshipOperations`): adds and removes on a group
 *    a Conditional Access policy includes or excludes, and removes on a group
 *    that holds a directory role or can hold one. A gate whose inputs could not
 *    be read refuses them, and also every removal, because the registered
 *    break-glass accounts are then unknown.
 *
 * Pure over its inputs; never calls Microsoft.
 */
import { breakGlassLockoutGate } from './lockoutGate.mjs';
import { globalAdministratorPrincipalIds } from './protectedPrincipals.mjs';
import { relationshipOperationKey } from '../restore/relationshipWriter.mjs';

const lower = (id) => (typeof id === 'string' && id.length > 0 ? id.toLowerCase() : null);

/** Global Administrator principals plus the registered break-glass accounts, without duplicates. */
export function protectedEdgePrincipalIds(targetResources, breakGlassAccountIds = []) {
  const ids = [];
  for (const id of [...globalAdministratorPrincipalIds(targetResources), ...breakGlassAccountIds]) {
    const key = lower(id);
    if (key && !ids.includes(key)) ids.push(key);
  }
  return ids;
}

/** Ids of groups any live Conditional Access policy includes or excludes. */
export function conditionalAccessGroupIds(targetResources) {
  const ids = new Set();
  for (const resource of targetResources ?? []) {
    if (resource?.resourceType !== 'conditionalAccessPolicy') continue;
    const users = resource.payload?.conditions?.users ?? {};
    for (const list of [users.includeGroups, users.excludeGroups]) {
      if (Array.isArray(list)) for (const id of list) { const key = lower(id); if (key) ids.add(key); }
    }
  }
  return ids;
}

/** Ids of groups that hold a directory role, or are role-assignable and so exist to hold one. */
export function privilegedGroupIds(targetResources) {
  const groups = new Map();
  const principals = new Set();
  for (const resource of targetResources ?? []) {
    if (resource?.resourceType === 'group') {
      const id = lower(resource.sourceId ?? resource.payload?.id);
      if (id) groups.set(id, resource.payload?.isAssignableToRole === true);
    } else if (resource?.resourceType === 'roleAssignment' || resource?.resourceType === 'roleEligibilitySchedule') {
      const id = lower(resource.payload?.principalId);
      if (id) principals.add(id);
    }
  }
  const ids = new Set();
  for (const [id, assignable] of groups) if (assignable || principals.has(id)) ids.add(id);
  // A role holder that is not in the group read is still treated as a group here:
  // users never parent a member edge, so the extra ids cannot widen anything.
  for (const id of principals) ids.add(id);
  return ids;
}

const isUserKey = (naturalKey) => typeof naturalKey === 'string' && naturalKey.startsWith('user:');

/**
 * The membership lookup as it would be after `operations` (member edges only,
 * each with its parent's live id in `parentId`). An answer the writes could have
 * changed but that cannot be worked out reads as null (unknown), which the gate
 * treats as not ready.
 */
export function withProposedMembership(groupMembers, operations) {
  const byGroup = new Map();
  for (const op of operations) {
    if (op.family !== 'member' || !op.parentId) continue;
    const list = byGroup.get(op.parentId) ?? [];
    list.push(op);
    byGroup.set(op.parentId, list);
  }
  return (group, accountId) => {
    const before = groupMembers(group, accountId);
    const ops = byGroup.get(lower(group));
    if (!ops) return before;
    const account = lower(accountId);
    let after = before;
    for (const op of ops) {
      const target = lower(op.targetId);
      if (target && target === account) {
        // Added directly: a member. Removed directly: it may still be a member through a nested group.
        if (op.action === 'add') return true;
        after = null;
        continue;
      }
      if (isUserKey(op.targetNaturalKey)) continue; // another user: this account's membership is unchanged
      // A nested group (or an object of unknown type) joins or leaves: the account
      // may come or go with it.
      if (op.action === 'add' && after !== true) after = null;
      if (op.action === 'remove' && after !== false) after = null;
    }
    return after;
  };
}

/**
 * Splits planned edge operations into those that may run and refusals.
 *
 * - `operations`: planRelationshipOperations() output.
 * - `parentTargetIds`: Map parent natural key -> live group id.
 * - `caGroupIds`, `privilegedGroupIds`: Sets of lower-case group ids.
 * - `inputs`: loadLockoutGateInputs() output, or null with `loadError` when it could not be read.
 */
export function gateRelationshipOperations({
  operations, parentTargetIds = new Map(), caGroupIds = new Set(), privilegedGroupIds: privileged = new Set(),
  inputs = null, loadError = null,
}) {
  const withParent = operations.map((op) => ({ op, parentId: lower(parentTargetIds.get(op.parentNaturalKey) ?? null) }));
  const gated = ({ op, parentId }) => op.family === 'member' && parentId !== null
    && (caGroupIds.has(parentId) || (op.action === 'remove' && privileged.has(parentId)));
  const refuse = (entries, reason) => entries.map(({ op }) => ({ naturalKey: relationshipOperationKey(op), reason }));

  if (!inputs) {
    const reason = `break-glass accounts could not be read${loadError ? ` (${loadError})` : ''}, so this membership change cannot be shown to keep emergency access`;
    const blocked = withParent.filter((entry) => gated(entry) || entry.op.action === 'remove');
    return { operations: withParent.filter((entry) => !blocked.includes(entry)).map(({ op }) => op), refusals: refuse(blocked, `lockout-gate: ${reason}`) };
  }
  const blockedEntries = withParent.filter(gated);
  if (blockedEntries.length === 0) return { operations, refusals: [] };
  const groupMembers = withProposedMembership(inputs.groupMembers ?? (() => null),
    blockedEntries.map(({ op, parentId }) => ({ ...op, parentId })));
  const verdict = breakGlassLockoutGate({ ...inputs, groupMembers }).evaluate({ resourceType: 'groupMembership', desired: null });
  if (verdict.allowed) return { operations, refusals: [] };
  return {
    operations: withParent.filter((entry) => !blockedEntries.includes(entry)).map(({ op }) => op),
    refusals: refuse(blockedEntries, `lockout-gate: group membership change withheld: ${verdict.reason}`),
  };
}
