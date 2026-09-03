/**
 * M1-scope resource catalog: Entra ID and Intune.
 *
 * This is the read-side of the adapter contract in spec §7, reduced to what a
 * measurement pass needs. `criticality` and `blastRadius` are the spec's
 * declared values, carried here so the probe can report scale per tier rather
 * than as one undifferentiated object count.
 *
 * `pageCap` bounds collections that can run to tens of thousands of objects.
 * Where a cap is set the probe still reports the true total via $count, so a
 * capped enumeration yields an accurate size with a sampled payload.
 */

export const CATALOG = [
  // ---------------------------------------------------------------- tenant
  { type: 'organization', path: '/organization', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'domain', path: '/domains', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout',
    note: 'Missing domains were a named cause of the CoreView UPN failures.' },
  { type: 'subscribedSku', path: '/subscribedSkus', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    note: 'Licence availability is a hard precondition for user restore.' },
  { type: 'directorySettingTemplate', path: '/directorySettingTemplates', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic' },
  { type: 'groupSetting', path: '/groupSettings', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },

  // ------------------------------------------------------------ principals
  { type: 'user', path: '/users', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    select: 'id,userPrincipalName,displayName,accountEnabled,onPremisesSyncEnabled,onPremisesImmutableId,userType,usageLocation,assignedLicenses,employeeId,createdDateTime',
    pageCap: 20,
    note: 'onPremisesSyncEnabled drives the AD-sync guard — synced users must not be cloud-restored.' },
  { type: 'group', path: '/groups', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    select: 'id,displayName,mailNickname,groupTypes,securityEnabled,mailEnabled,membershipRule,membershipRuleProcessingState,onPremisesSyncEnabled,isAssignableToRole,visibility,createdDateTime',
    pageCap: 20 },
  { type: 'administrativeUnit', path: '/directory/administrativeUnits', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'contact', path: '/contacts', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic', pageCap: 5 },

  // -------------------------------------------------------------- identity
  { type: 'application', path: '/applications', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    pageCap: 20,
    note: 'Secret values are unrecoverable — cross-tenant needs the re-issue workflow (spec §9.5).' },
  { type: 'servicePrincipal', path: '/servicePrincipals', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    select: 'id,appId,displayName,servicePrincipalType,accountEnabled,appRoleAssignmentRequired,tags,signInAudience',
    pageCap: 20 },
  { type: 'oauth2PermissionGrant', path: '/oauth2PermissionGrants', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    pageCap: 20,
    note: 'Delegated consent. Cross-tenant these must be re-granted, not copied.' },
  { type: 'identityProvider', path: '/identity/identityProviders', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'certificateBasedAuthConfiguration', path: '/organization/{org}/certificateBasedAuthConfiguration', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout', needsOrgId: true },

  // ------------------------------------------------------------------ RBAC
  { type: 'directoryRole', path: '/directoryRoles', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'roleDefinition', path: '/roleManagement/directory/roleDefinitions', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'roleAssignment', path: '/roleManagement/directory/roleAssignments', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout',
    pageCap: 20,
    note: 'Break-glass accounts live here. The invariant in spec §10.4 reads this set.' },
  { type: 'roleEligibilitySchedule', path: '/roleManagement/directory/roleEligibilitySchedules', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout',
    note: 'PIM. Requires Entra ID P2; absence here is a licensing signal, not a coverage gap.' },

  // ---------------------------------------------------- conditional access
  { type: 'conditionalAccessPolicy', path: '/identity/conditionalAccess/policies', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout',
    note: 'Always restored report-only (spec §10.2).' },
  { type: 'namedLocation', path: '/identity/conditionalAccess/namedLocations', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'authenticationContextClassReference', path: '/identity/conditionalAccess/authenticationContextClassReferences', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },

  // -------------------------------------------------------------- policies
  { type: 'authenticationMethodsPolicy', path: '/policies/authenticationMethodsPolicy', version: 'v1.0', singleton: true, criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'authorizationPolicy', path: '/policies/authorizationPolicy', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout' },
  { type: 'crossTenantAccessPolicy', path: '/policies/crossTenantAccessPolicy', version: 'v1.0', singleton: true, criticality: 'tier1', blastRadius: 'access-affecting' },
  { type: 'crossTenantAccessPolicyPartner', path: '/policies/crossTenantAccessPolicy/partners', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting' },
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

  // ---------------------------------------------------------------- Intune
  { type: 'deviceConfiguration', path: '/deviceManagement/deviceConfigurations', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'deviceCompliancePolicy', path: '/deviceManagement/deviceCompliancePolicies', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    note: 'Compliance feeds CA. A wrong compliance policy locks users out indirectly.' },
  { type: 'configurationPolicy', path: '/deviceManagement/configurationPolicies', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'Settings catalog. Beta-only; a fidelity risk the spec flags.' },
  { type: 'deviceEnrollmentConfiguration', path: '/deviceManagement/deviceEnrollmentConfigurations', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'deviceManagementRoleDefinition', path: '/deviceManagement/roleDefinitions', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting' },
  { type: 'deviceCategory', path: '/deviceManagement/deviceCategories', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic' },
  { type: 'termsAndConditions', path: '/deviceManagement/termsAndConditions', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic' },
  { type: 'windowsAutopilotDeploymentProfile', path: '/deviceManagement/windowsAutopilotDeploymentProfiles', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'deviceManagementIntent', path: '/deviceManagement/intents', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'managedDevice', path: '/deviceManagement/managedDevices', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic', pageCap: 5,
    note: 'Device records are re-enrolled, not restored. Counted for scale only.' },
  { type: 'mobileApp', path: '/deviceAppManagement/mobileApps', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting', pageCap: 20 },
  { type: 'managedAppPolicy', path: '/deviceAppManagement/managedAppPolicies', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'targetedManagedAppConfiguration', path: '/deviceAppManagement/targetedManagedAppConfigurations', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'mobileAppConfiguration', path: '/deviceAppManagement/mobileAppConfigurations', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
];

/** Directory object types whose ids other resources reference by GUID. */
export const REFERENCEABLE_TYPES = new Set([
  'user',
  'group',
  'application',
  'servicePrincipal',
  'administrativeUnit',
  'roleDefinition',
  'namedLocation',
  'deviceCompliancePolicy',
  'deviceConfiguration',
  'domain',
  'subscribedSku',
]);
