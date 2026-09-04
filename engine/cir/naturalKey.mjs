/**
 * Wraps tenant-probe's naturalKey() with a roleAssignment case. A roleAssignment
 * has no displayName — its identity is the relationship (role, principal, scope)
 * it represents, so its key is composed from the OTHER objects' already-assigned
 * keys (spec §6.1: "where names are not unique, qualify by parent scope").
 */
import { naturalKey as baseNaturalKey } from '../../tools/tenant-probe/references.mjs';

export function naturalKeyFor(type, obj, ctx) {
  if (type === 'roleAssignment') return roleAssignmentKey(obj, ctx);
  return baseNaturalKey(type, obj);
}

function roleAssignmentKey(obj, { resolveSymbol }) {
  const role = resolveSymbol(obj.roleDefinitionId) ?? `unknown:${obj.roleDefinitionId}`;
  const principal = resolveSymbol(obj.principalId) ?? `unknown:${obj.principalId}`;
  const scope =
    obj.directoryScopeId && obj.directoryScopeId !== '/'
      ? (resolveSymbol(obj.directoryScopeId) ?? obj.directoryScopeId)
      : '/';
  return `roleAssignment:${role}@${principal}@${scope}`;
}
