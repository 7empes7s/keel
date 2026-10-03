/** Spec M2.3. Three field classes, single source of truth for hashing AND PATCH projection.
 *  - serverOwned: Graph sets it, we cannot. Excluded from the hash and from PATCH bodies.
 *  - immutable:   settable at create, NOT patchable. IN the hash (a change is real drift),
 *                 excluded from PATCH, and reported as not-auto-remediable.
 *  - everything else is writable: in the hash and in PATCH bodies.
 *
 * fieldClass() below remains the only place these three classes are decided — do not
 * duplicate this split elsewhere. engine/contracts/fieldProjection.mjs (roadmap task-51)
 * builds on top of it for the operations this file does not cover: sensitive-export
 * exclusion and per-type unknown-field flagging for create/update, for types reviewed
 * closely enough to name every field they can carry. It never redefines serverOwned/
 * immutable/writable itself.
 *
 * group classification corrected 2026-09-07 per group-update.md's PATCH table: mailNickname and
 * securityEnabled are writable, not immutable; server-owned fields (classification, mail,
 * onPremisesX, securityIdentifier, theme, etc.) were previously unclassified, which caused
 * applyEngine.mjs's update-verify step to see them as spurious residual drift.
 *
 * RESOURCE_TYPES widened 2026-09-08 from the original 6 to all 28 currently-enabled types,
 * derived from engine/collect/descriptors.mjs's DESCRIPTORS (the single source of truth for
 * "what's collected" — see that file's own header for the per-type measurement behind the
 * widening). Retyping the 28 names by hand here would be a third source of truth that could
 * silently drift from collection; importing keeps this file locked to whatever is actually
 * collected.
 *
 * The 22 newly-added types get EMPTY SERVER_OWNED and IMMUTABLE sets (the Map below defaults
 * every RESOURCE_TYPES entry to `new Set()`, then only group/user/conditionalAccessPolicy/
 * roleAssignment/authenticationStrengthPolicy override it — the 22 new types fall through to
 * that empty default and are never overridden). Reasoning and its limit:
 *   - All 22 are fidelity 'read-only' in descriptors.mjs — none has a write path in
 *     applyEngine.mjs's pathFor() — so IMMUTABLE is irrelevant for them: nothing in this set
 *     is ever PATCHed, so there's no PATCH-body projection or not-auto-remediable reporting to
 *     get right or wrong.
 *   - SERVER_OWNED therefore only affects HASHING for these 22. With empty sets, only
 *     SERVER_OWNED_ALWAYS (id/createdDateTime/modifiedDateTime/deletedDateTime/renewedDateTime)
 *     is excluded from their canonical hash — nothing type-specific is.
 *   - CONSEQUENCE: if one of these 22 types carries a volatile server-managed field that is NOT
 *     in SERVER_OWNED_ALWAYS (e.g. a sync timestamp, a service-computed status, a Graph-assigned
 *     identifier local to that type), canonicalHash() will include it, and that field's normal
 *     server-side churn will read as FALSE DRIFT — drift reported on a resource nobody actually
 *     changed. That's a correctness/trust problem, not a safety one (these types have no write
 *     path, so nothing can be mis-restored), and the fix is to classify that specific field for
 *     that specific type once it's observed, the same way group/user/conditionalAccessPolicy
 *     were classified above.
 *   - So: false drift reported on any of these 22 types should be investigated FIRST as a
 *     classification gap in this file, not accepted at face value as real tenant drift.
 */

import { DESCRIPTORS } from '../collect/descriptors.mjs';

export const SERVER_OWNED_ALWAYS = new Set([
  'id',
  'createdDateTime',
  'modifiedDateTime',
  'lastModifiedDateTime',
  'deletedDateTime',
  'renewedDateTime',
]);

const RESOURCE_TYPES = DESCRIPTORS.map((descriptor) => descriptor.type);

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

// Roadmap task-107. Immutable, not serverOwned, so the configuration hash is
// unchanged for every stored snapshot (no legacy re-hash) and a change to these
// fields still reads as real drift, reported not-auto-remediable. appId and
// publisherDomain are assigned by Entra; credential material can never be read
// back (Graph returns hints and key metadata, never a secret or private key), so
// no PATCH may carry it. The create path drops them too (qualification.mjs's
// CREATE_EXCLUDED_FIELDS) and a recreate leaves owned credential completion items.
IMMUTABLE.set('application', new Set(['appId', 'publisherDomain', 'passwordCredentials', 'keyCredentials']));
// A service principal is bound to its application by appId for its whole life;
// the rest is published from the application, never authored on the principal.
IMMUTABLE.set('servicePrincipal', new Set([
  'appId', 'appDisplayName', 'appOwnerOrganizationId', 'servicePrincipalNames', 'servicePrincipalType',
  'signInAudience', 'appRoles', 'oauth2PermissionScopes', 'passwordCredentials', 'keyCredentials',
]));

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
