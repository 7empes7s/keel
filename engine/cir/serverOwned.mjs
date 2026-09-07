/** Spec M2.3. Three field classes, single source of truth for hashing AND PATCH projection.
 *  - serverOwned: Graph sets it, we cannot. Excluded from the hash and from PATCH bodies.
 *  - immutable:   settable at create, NOT patchable. IN the hash (a change is real drift),
 *                 excluded from PATCH, and reported as not-auto-remediable.
 *  - everything else is writable: in the hash and in PATCH bodies.
 *
 * group classification corrected 2026-09-07 per group-update.md's PATCH table: mailNickname and
 * securityEnabled are writable, not immutable; server-owned fields (classification, mail,
 * onPremisesX, securityIdentifier, theme, etc.) were previously unclassified, which caused
 * applyEngine.mjs's update-verify step to see them as spurious residual drift.
 */

export const SERVER_OWNED_ALWAYS = new Set([
  'id',
  'createdDateTime',
  'modifiedDateTime',
  'deletedDateTime',
  'renewedDateTime',
]);

const RESOURCE_TYPES = [
  'user',
  'authenticationStrengthPolicy',
  'group',
  'roleAssignment',
  'namedLocation',
  'conditionalAccessPolicy',
];

export const SERVER_OWNED = new Map(
  RESOURCE_TYPES.map((resourceType) => [resourceType, new Set()]),
);
SERVER_OWNED.set('group', new Set([
  'classification', 'creationOptions', 'expirationDateTime', 'infoCatalogs', 'mail',
  'onPremisesDomainName', 'onPremisesLastSyncDateTime', 'onPremisesNetBiosName',
  'onPremisesProvisioningErrors', 'onPremisesSamAccountName', 'onPremisesSecurityIdentifier',
  'onPremisesSyncEnabled', 'proxyAddresses', 'resourceBehaviorOptions', 'resourceProvisioningOptions',
  'securityIdentifier', 'serviceProvisioningErrors', 'theme',
]));

SERVER_OWNED.set('user', new Set([
  'onPremisesSyncEnabled', 'onPremisesImmutableId', 'userType', 'assignedLicenses',
]));

SERVER_OWNED.set('conditionalAccessPolicy', new Set(['templateId']));

export const IMMUTABLE = new Map(
  RESOURCE_TYPES.map((resourceType) => [resourceType, new Set()]),
);
IMMUTABLE.set('group', new Set(['mailEnabled', 'groupTypes', 'isAssignableToRole']));

IMMUTABLE.set('roleAssignment', new Set([
  'principalId', 'principalOrganizationId', 'directoryScopeId', 'roleDefinitionId',
]));

IMMUTABLE.set('authenticationStrengthPolicy', new Set(['allowedCombinations']));

// namedLocation needs no entries — every field it collects (displayName, isTrusted,
// ipRanges, countriesAndRegions, includeUnknownCountriesAndRegions) is writable, so
// the empty default SERVER_OWNED/IMMUTABLE sets are already correct.

/** @returns {'serverOwned' | 'immutable' | 'writable'} */
export function fieldClass(path, resourceType) {
  if (!SERVER_OWNED.has(resourceType) || !IMMUTABLE.has(resourceType)) {
    throw new Error(`unknown resourceType: ${resourceType}`);
  }

  if (
    /(^|\.)@odata\./.test(path)
    || (!path.includes('.') && SERVER_OWNED_ALWAYS.has(path))
    || SERVER_OWNED.get(resourceType).has(path)
  ) {
    return 'serverOwned';
  }
  if (IMMUTABLE.get(resourceType).has(path)) {
    return 'immutable';
  }
  return 'writable';
}
