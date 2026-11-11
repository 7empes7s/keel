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

/**
 * Issue #1072: custom authentication extensions and authentication event listeners
 * (engine/restore/signInExtensionOperations.mjs). An extension is never created: a
 * create updates the live extension with the backup's name, or is a step for a
 * person, so its id is the target's own. A listener create gets a new id. Delete is
 * not registered for either.
 */
export const SIGN_IN_EXTENSION_HANDLER = 'engine/restore/signInExtensionOperations.mjs#applySignInExtensionWrite';
const SIGN_IN_EXTENSION_PROOF = 'engine/roadmap/sign-in-extensions.test.mjs';
const SIGN_IN_EXTENSION_WRITE_PATHS = Object.freeze({
  customAuthenticationExtension: '/identity/customAuthenticationExtensions',
  authenticationEventListener: '/identity/authenticationEventListeners',
});

/**
 * Issue #1075: Entra directory settings named by a fixed name (sign-in
 * identifiers, default cross-tenant capabilities, profile card fields;
 * engine/restore/directorySettingOperations.mjs) and four directory objects
 * (Verified ID profiles, lifecycle policies, device templates, schema extensions;
 * engine/restore/directoryObjectOperations.mjs). A Verified ID profile create
 * updates the live one with the backup's name; a schema extension is created
 * under the backup's id; a profile card field under its directory field. Delete
 * is not registered for any of them.
 */
export const DIRECTORY_SETTING_HANDLER = 'engine/restore/directorySettingOperations.mjs#applyDirectorySettingWrite';
export const DIRECTORY_OBJECT_HANDLER = 'engine/restore/directoryObjectOperations.mjs#applyDirectoryObjectWrite';
const DIRECTORY_PROOF = 'engine/roadmap/entra-directory-settings.test.mjs';
const DIRECTORY_WRITES = Object.freeze([
  ['signInIdentifier', '/identity/signInIdentifiers', ['update'], DIRECTORY_SETTING_HANDLER],
  ['crossTenantM365Capability', '/policies/crossTenantAccessPolicy/default/m365Capabilities', ['update'], DIRECTORY_SETTING_HANDLER],
  ['profileCardProperty', '/admin/people/profileCardProperties', ['create', 'update'], DIRECTORY_SETTING_HANDLER],
  ['verifiedIdProfile', '/identity/verifiedId/profiles', ['create', 'update'], DIRECTORY_OBJECT_HANDLER],
  ['lifecyclePolicy', '/identityGovernance/lifecycleWorkflows/lifecyclePolicies', ['create', 'update'], DIRECTORY_OBJECT_HANDLER],
  ['deviceTemplate', '/templates/deviceTemplates', ['create'], DIRECTORY_OBJECT_HANDLER],
  ['schemaExtension', '/schemaExtensions', ['create'], DIRECTORY_OBJECT_HANDLER],
]);
const SERVER_ASSIGNED_CREATES = new Set(['lifecyclePolicy', 'deviceTemplate']);

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
  ...Object.entries(SIGN_IN_EXTENSION_WRITE_PATHS).flatMap(([resourceType, path]) => ENTRA_WRITE_OPERATIONS.map((operation) => ({
    resourceType, operation, path, handler: SIGN_IN_EXTENSION_HANDLER,
    idOutcome: operation === 'create' && resourceType === 'authenticationEventListener' ? 'server-assigned' : 'preserved',
    proofRef: SIGN_IN_EXTENSION_PROOF,
  }))),
  ...DIRECTORY_WRITES.flatMap(([resourceType, path, operations, handler]) => operations.map((operation) => ({
    resourceType, operation, path, handler,
    idOutcome: operation === 'create' && SERVER_ASSIGNED_CREATES.has(resourceType) ? 'server-assigned' : 'preserved',
    proofRef: DIRECTORY_PROOF,
  }))),
];
