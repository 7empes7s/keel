/**
 * Wraps tenant-probe's naturalKey() with a roleAssignment case. A roleAssignment
 * has no displayName — its identity is the relationship (role, principal, scope)
 * it represents, so its key is composed from the OTHER objects' already-assigned
 * keys (spec §6.1: "where names are not unique, qualify by parent scope").
 */
import { naturalKey as baseNaturalKey } from '../../tools/tenant-probe/references.mjs';

// Phase 3 read-only inventory: unmeasured portable keys are deliberately not
// claimed. Graph ids distinguish duplicate display names and opaque grant /
// schedule identities. These keys are tenant-bound (except global templates)
// and descriptors keep remappable false until restore evidence exists.
export const ID_KEY_TYPES = new Set([
  'directorySettingTemplate', 'directoryRoleTemplate', 'oauth2PermissionGrant',
  'roleEligibilitySchedule', 'authenticationContextClassReference',
  'activityBasedTimeoutPolicy', 'claimsMappingPolicy', 'homeRealmDiscoveryPolicy',
  'tokenIssuancePolicy', 'tokenLifetimePolicy', 'featureRolloutPolicy',
  'accessPackage', 'connectedOrganization', 'deviceEnrollmentConfiguration',
  'deviceCategory', 'managedDevice', 'managedAppPolicy',
  'targetedManagedAppConfiguration', 'mobileAppConfiguration', 'termsAndConditions',
  'windowsAutopilotDeploymentProfile', 'deviceManagementIntent', 'contact',
]);

export function naturalKeyFor(type, obj, ctx) {
  if (type === 'certificateBasedAuthConfiguration') return 'certificateBasedAuthConfiguration';
  if (ID_KEY_TYPES.has(type)) {
    if (typeof obj.id !== 'string' || obj.id.length === 0) throw new Error(`missing id for ${type}`);
    return obj.id;
  }
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
