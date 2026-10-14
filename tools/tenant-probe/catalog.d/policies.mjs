/** Catalogue family: Tenant-wide policies. See ../catalog.mjs for the entry shape. */
export default [
  { type: 'authenticationMethodsPolicy', path: '/policies/authenticationMethodsPolicy', version: 'v1.0', singleton: true, criticality: 'tier1', blastRadius: 'tenant-lockout' },
  // Roadmap task-149: security defaults. Read by the restore sign-in path gate
  // since M2; collected as a resource from task-149 on.
  { type: 'identitySecurityDefaultsEnforcementPolicy', path: '/policies/identitySecurityDefaultsEnforcementPolicy', version: 'v1.0', singleton: true, criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'authorizationPolicy', path: '/policies/authorizationPolicy', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'crossTenantAccessPolicy', path: '/policies/crossTenantAccessPolicy', version: 'v1.0', singleton: true, criticality: 'tier1', blastRadius: 'access-affecting' },
  // Roadmap task-149: the default B2B and inbound-trust settings that apply to
  // every external tenant without a partner entry. The root
  // crossTenantAccessPolicy object does not carry them.
  { type: 'crossTenantAccessPolicyConfigurationDefault', path: '/policies/crossTenantAccessPolicy/default', version: 'v1.0', singleton: true, criticality: 'tier1', blastRadius: 'access-affecting' },
  { type: 'crossTenantAccessPolicyPartner', path: '/policies/crossTenantAccessPolicy/partners', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting' },
  // Issue #156: who may register and join devices, and whether joining needs MFA.
  { type: 'deviceRegistrationPolicy', path: '/policies/deviceRegistrationPolicy', version: 'v1.0', singleton: true, criticality: 'tier1', blastRadius: 'access-affecting' },
  // Issue #156: whether external users may sign themselves up through user flows.
  { type: 'authenticationFlowsPolicy', path: '/policies/authenticationFlowsPolicy', version: 'v1.0', singleton: true, criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'permissionGrantPolicy', path: '/policies/permissionGrantPolicies', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'adminConsentRequestPolicy', path: '/policies/adminConsentRequestPolicy', version: 'v1.0', singleton: true, criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'activityBasedTimeoutPolicy', path: '/policies/activityBasedTimeoutPolicies', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'claimsMappingPolicy', path: '/policies/claimsMappingPolicies', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'homeRealmDiscoveryPolicy', path: '/policies/homeRealmDiscoveryPolicies', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'tokenIssuancePolicy', path: '/policies/tokenIssuancePolicies', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'tokenLifetimePolicy', path: '/policies/tokenLifetimePolicies', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'featureRolloutPolicy', path: '/policies/featureRolloutPolicies', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic' },
  { type: 'accessReviewScheduleDefinition', path: '/identityGovernance/accessReviews/definitions', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'accessPackage', path: '/identityGovernance/entitlementManagement/accessPackages', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'connectedOrganization', path: '/identityGovernance/entitlementManagement/connectedOrganizations', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
];
