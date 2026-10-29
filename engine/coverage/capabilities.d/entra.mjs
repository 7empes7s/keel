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
  permissionGrantPolicy: '/policies/permissionGrantPolicies',
  oauth2PermissionGrant: '/oauth2PermissionGrants',
  // Restore gaps, batch 21 (beta).
  servicePrincipalCreationPolicy: '/policies/servicePrincipalCreationPolicies',
});

export default Object.entries(ENTRA_WRITE_PATHS).flatMap(([resourceType, path]) => ENTRA_WRITE_OPERATIONS.map((operation) => ({
  resourceType, operation, path, handler: ENTRA_HANDLER,
  idOutcome: operation === 'create' ? 'server-assigned' : 'preserved',
  proofRef: ENTRA_PROOF,
})));
