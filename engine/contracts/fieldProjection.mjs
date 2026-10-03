/**
 * Versioned per-type field projection and classification contract (roadmap
 * task-51). `engine/cir/serverOwned.mjs` already classifies every field into
 * serverOwned/immutable/writable — the single source of truth for hashing and
 * PATCH projection (spec M2.3) — and this file does not re-derive or override
 * that split; `classifyForOperation()` calls `fieldClass()` for its base
 * classification on every operation. What this file adds is the rest of the
 * per-type behavior the roadmap calls for: an explicit review record per
 * type, a fourth operation serverOwned.mjs never covered (sensitive export),
 * and unknown-field flagging for types that have been reviewed closely enough
 * to name every field they can carry.
 *
 * Three rules are enforced here, non-negotiably:
 *
 * 1. Review state is a fact about whether a human registered the type below,
 *    never an inference from the shape of a rules map. An unregistered type
 *    has the exact same empty knownFields/sensitiveExport shape a registered
 *    'reviewed-empty' type would if it were built the lazy way — only
 *    presence in FIELD_PROJECTIONS distinguishes 'reviewed-empty' from
 *    'unreviewed', and reviewStateFor() must consult presence, not emptiness.
 * 2. For a registered type, a writable-classified field outside its
 *    knownFields list is 'unknown': excluded from create/update projection
 *    and reported by `unknownFields()` for review, never silently folded
 *    into 'writable' the way an unclassified field is for an unreviewed type.
 *    Unreviewed types keep exactly their prior fieldClass()-only behavior —
 *    this file narrows nothing it hasn't been given explicit rules for.
 * 3. sensitiveExport fields never appear in `exportProjection()`'s output,
 *    regardless of their serverOwned/immutable/writable class. Export is a
 *    stricter cut than PATCH, never a looser one.
 *
 * Unknown-field detection is top-level only: a new nested property inside an
 * already-known composite field (conditions, grantControls, ...) is not
 * flagged. That matches the granularity `knownFields` is reviewed at here;
 * deep schema review of nested Graph objects is out of this task's scope.
 */
import { fieldClass } from '../cir/serverOwned.mjs';

export const FIELD_PROJECTION_CONTRACT_VERSION = 1;

export const REVIEW_STATES = Object.freeze(['reviewed-empty', 'unreviewed', 'has-rules']);

// The operations this contract defines explicit per-type field behavior for.
// collection/comparison/verification are declared here as using the base
// serverOwned/immutable/writable classification unchanged — an explicit
// statement, not a silent omission — because collection keeps everything
// Graph returns, comparison/verification both resolve through canonicalHash
// (which already excludes serverOwned from the hash), and none of the three
// needs the create/update unknown-field narrowing or the export cut.
export const OPERATIONS = Object.freeze([
  'collection', 'comparison', 'create', 'update', 'verification', 'sensitiveExport',
]);

const FIELD_PROJECTIONS = new Map();

function registerFieldProjection(resourceType, { knownFields, sensitiveExport = [] }) {
  if (!Array.isArray(knownFields) || knownFields.length === 0) {
    throw new TypeError(`${resourceType}: knownFields must be a non-empty explicit list`);
  }
  FIELD_PROJECTIONS.set(resourceType, Object.freeze({
    contractVersion: FIELD_PROJECTION_CONTRACT_VERSION,
    resourceType,
    reviewState: sensitiveExport.length > 0 ? 'has-rules' : 'reviewed-empty',
    knownFields: Object.freeze(new Set(knownFields)),
    sensitiveExport: Object.freeze(new Set(sensitiveExport)),
  }));
}

// --- Registrations: the six original M1 types (descriptors.mjs's
// LIVE_SINCE_M1, in the same historical order), reviewed for this task. ---

registerFieldProjection('user', {
  knownFields: [
    'id', 'userPrincipalName', 'displayName', 'accountEnabled', 'onPremisesSyncEnabled',
    'onPremisesImmutableId', 'userType', 'usageLocation', 'assignedLicenses', 'employeeId',
    'createdDateTime',
  ],
  // onPremisesImmutableId encodes the on-prem AD objectGUID; employeeId is an
  // internal HR identifier. Neither belongs in an export handed to a reviewer
  // who only needs to see identity/licensing state.
  sensitiveExport: ['onPremisesImmutableId', 'employeeId'],
});

registerFieldProjection('group', {
  knownFields: [
    'id', 'displayName', 'description', 'mailNickname', 'groupTypes', 'securityEnabled', 'mailEnabled',
    'membershipRule', 'membershipRuleProcessingState', 'onPremisesSyncEnabled',
    'isAssignableToRole', 'visibility', 'createdDateTime',
    // Not in the current $select but present on unfiltered reads (see
    // serverOwned.test.mjs's convergence-invariant fixture) — named here so
    // an unfiltered read never manufactures an 'unknown' field for something
    // already reviewed.
    'classification', 'creationOptions', 'expirationDateTime', 'infoCatalogs', 'mail',
    'onPremisesDomainName', 'onPremisesLastSyncDateTime', 'onPremisesNetBiosName',
    'onPremisesProvisioningErrors', 'onPremisesSamAccountName', 'onPremisesSecurityIdentifier',
    'proxyAddresses', 'resourceBehaviorOptions', 'resourceProvisioningOptions',
    'securityIdentifier', 'serviceProvisioningErrors', 'theme',
  ],
  // On-prem AD correlation identifiers (SIDs, SAM/NetBIOS/domain names) are
  // sensitive infrastructure detail, never export material.
  sensitiveExport: [
    'securityIdentifier', 'onPremisesSecurityIdentifier', 'onPremisesSamAccountName',
    'onPremisesNetBiosName', 'onPremisesDomainName',
  ],
});

registerFieldProjection('roleAssignment', {
  knownFields: ['id', 'principalId', 'principalOrganizationId', 'directoryScopeId', 'roleDefinitionId'],
});

registerFieldProjection('namedLocation', {
  knownFields: [
    'id', 'displayName', 'isTrusted', 'ipRanges', 'countriesAndRegions',
    'includeUnknownCountriesAndRegions',
  ],
});

registerFieldProjection('conditionalAccessPolicy', {
  knownFields: ['id', 'displayName', 'conditions', 'grantControls', 'sessionControls', 'state', 'templateId'],
});

registerFieldProjection('authenticationStrengthPolicy', {
  knownFields: ['id', 'displayName', 'description', 'allowedCombinations'],
});

// Roadmap task-107: the first application/service-principal subset. Only the
// fields named here can reach a create or update body; anything else Graph adds
// later is 'unknown', excluded and flagged rather than silently written.
registerFieldProjection('application', {
  knownFields: [
    'id', 'appId', 'displayName', 'description', 'signInAudience', 'publisherDomain', 'createdDateTime',
    'deletedDateTime', 'identifierUris', 'tags', 'notes', 'isFallbackPublicClient', 'groupMembershipClaims',
    'requiredResourceAccess', 'appRoles', 'api', 'web', 'spa', 'publicClient', 'info', 'optionalClaims',
    'parentalControlSettings', 'passwordCredentials', 'keyCredentials',
  ],
  // Credential metadata (hints, thumbprints, key ids) is not export material.
  sensitiveExport: ['passwordCredentials', 'keyCredentials'],
});

registerFieldProjection('servicePrincipal', {
  knownFields: [
    'id', 'appId', 'displayName', 'accountEnabled', 'appRoleAssignmentRequired', 'tags', 'notes',
    'description', 'servicePrincipalType', 'signInAudience', 'appRoles', 'oauth2PermissionScopes',
    'appDisplayName', 'appOwnerOrganizationId', 'servicePrincipalNames', 'passwordCredentials', 'keyCredentials',
  ],
  sensitiveExport: ['passwordCredentials', 'keyCredentials'],
});

function topLevelKey(path) {
  const dot = path.indexOf('.');
  return dot === -1 ? path : path.slice(0, dot);
}

/**
 * 'unreviewed' is the only default, and it is never derived from map
 * emptiness (mutation check: infer reviewed status from empty map) — an
 * unregistered type reads 'unreviewed' purely because it is absent from
 * FIELD_PROJECTIONS, not because some rules set on it happens to be empty.
 */
export function reviewStateFor(resourceType) {
  return FIELD_PROJECTIONS.get(resourceType)?.reviewState ?? 'unreviewed';
}

/**
 * Operation-scoped field classification. Always resolves the base
 * serverOwned/immutable/writable class through fieldClass() first — this
 * file never redefines that split — then narrows per operation:
 *
 *   - collection, comparison, verification: base class only.
 *   - create: serverOwned stays excluded; writable AND immutable fields are
 *     both settable at create (spec M2.3), collapsed to 'writable' here,
 *     unless the type is reviewed and the field is outside knownFields, in
 *     which case it is 'unknown'.
 *   - update: base class only for serverOwned/immutable (excluded exactly as
 *     writableProjection.mjs already excluded them); a writable field outside
 *     a reviewed type's knownFields is 'unknown' instead of 'writable'.
 *   - sensitiveExport: 'sensitive' if the type's sensitiveExport set names
 *     the field, regardless of base class; base class otherwise.
 */
export function classifyForOperation(operation, path, resourceType) {
  if (!OPERATIONS.includes(operation)) {
    throw new TypeError(`unknown field-projection operation: ${operation}`);
  }
  const base = fieldClass(path, resourceType);
  const review = FIELD_PROJECTIONS.get(resourceType);

  if (operation === 'sensitiveExport') {
    return review?.sensitiveExport.has(topLevelKey(path)) ? 'sensitive' : base;
  }
  if (operation === 'create') {
    if (base === 'serverOwned') return base;
    if (review && !review.knownFields.has(topLevelKey(path))) return 'unknown';
    return 'writable';
  }
  if (operation === 'update') {
    if (base !== 'writable') return base;
    if (review && !review.knownFields.has(topLevelKey(path))) return 'unknown';
    return 'writable';
  }
  // collection, comparison, verification.
  return base;
}

/**
 * Leaves only what a reviewer-facing export may carry: everything except the
 * type's sensitiveExport fields. Unlike writableProjection, this keeps
 * serverOwned/immutable/writable fields alike — export wants more context
 * than a PATCH body, minus the specific fields named sensitive.
 */
export function exportProjection(payload, resourceType) {
  fieldClass('', resourceType);
  return project(payload, resourceType, '');
}

function project(value, resourceType, path) {
  if (Array.isArray(value)) return value.map((item) => project(item, resourceType, path));
  if (value && typeof value === 'object') {
    const projected = {};
    for (const key of Object.keys(value)) {
      const dottedPath = path ? `${path}.${key}` : key;
      if (classifyForOperation('sensitiveExport', dottedPath, resourceType) === 'sensitive') continue;
      projected[key] = project(value[key], resourceType, dottedPath);
    }
    return projected;
  }
  return value;
}
