/**
 * Capability fragment: ENTRA (Wave 2). See ../capabilities.mjs registerCapabilityFragment for the entry shape.
 *
 * Create and update of the directory policies and delegated consents written
 * by engine/restore/directoryPolicyOperations.mjs (registered in
 * engine/restore/writers/entra.mjs under the same handler). Delete is not
 * registered: removing a token or sign-in routing policy, an app consent
 * policy or a consent changes sign-in for every app that uses it, and KEEL has
 * no qualified guard for that. Fixture-tested only; each type's live check is
 * its own operator queue item. Data only (no imports), per the fragment rule.
 */
export const ENTRA_HANDLER = 'engine/restore/directoryPolicyOperations.mjs#applyDirectoryPolicyWrite';
export const ENTRA_PROOF = 'engine/roadmap/entra-directory-writers.test.mjs';
export const ENTRA_WRITE_OPERATIONS = Object.freeze(['create', 'update']);
export const ENTRA_WRITE_PATHS = Object.freeze({
  tokenLifetimePolicy: '/policies/tokenLifetimePolicies',
  tokenIssuancePolicy: '/policies/tokenIssuancePolicies',
  claimsMappingPolicy: '/policies/claimsMappingPolicies',
  homeRealmDiscoveryPolicy: '/policies/homeRealmDiscoveryPolicies',
  activityBasedTimeoutPolicy: '/policies/activityBasedTimeoutPolicies',
  permissionGrantPolicy: '/policies/permissionGrantPolicies',
  oauth2PermissionGrant: '/oauth2PermissionGrants',
});

/**
 * Issue #994: authentication contexts and staged rollout
 * (engine/restore/signInSettingsOperations.mjs). A context is upserted under its
 * own id (c1..c99), so even a create keeps the backup's id. A rollout create gets
 * a new id. Delete is not registered for either.
 */
export const SIGN_IN_HANDLER = 'engine/restore/signInSettingsOperations.mjs#applySignInSettingWrite';
export const SIGN_IN_PROOF = 'engine/roadmap/sign-in-settings.test.mjs';
export const SIGN_IN_WRITE_PATHS = Object.freeze({
  authenticationContextClassReference: '/identity/conditionalAccess/authenticationContextClassReferences',
  featureRolloutPolicy: '/policies/featureRolloutPolicies',
});

export default [
  ...Object.entries(ENTRA_WRITE_PATHS).flatMap(([resourceType, path]) => ENTRA_WRITE_OPERATIONS.map((operation) => ({
    resourceType, operation, path, handler: ENTRA_HANDLER,
    idOutcome: operation === 'create' ? 'server-assigned' : 'preserved',
    proofRef: ENTRA_PROOF,
  }))),
  ...Object.entries(SIGN_IN_WRITE_PATHS).flatMap(([resourceType, path]) => ENTRA_WRITE_OPERATIONS.map((operation) => ({
    resourceType, operation, path, handler: SIGN_IN_HANDLER,
    idOutcome: operation === 'create' && resourceType === 'featureRolloutPolicy' ? 'server-assigned' : 'preserved',
    proofRef: SIGN_IN_PROOF,
  }))),
];
