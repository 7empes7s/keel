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
  // Issue #156. A branding localization's id is its language (for example
  // fr-FR), the same in every tenant. A group expiration policy's id is the
  // only identity it has: it carries no name.
  'organizationalBrandingLocalization', 'groupLifecyclePolicy',
  // Roadmap task-151: PIM role settings, the policy-to-role bindings and active
  // schedules. Every role policy is named "DirectoryRole", so a display name
  // would collide; Entra creates the policies and never replaces them, so the
  // id is stable for the tenant's lifetime. A restore into another tenant
  // finds no policy under that key and is refused (policies are never created).
  'unifiedRoleManagementPolicy', 'unifiedRoleManagementPolicyAssignment', 'roleAssignmentSchedule',
  // Wave 1 CAT-INTUNE: names are unmeasured, and the built-in Default scope tag
  // and Microsoft-published remediations carry the same name in every tenant.
  'deviceManagementScript', 'deviceShellScript', 'deviceHealthScript', 'deviceComplianceScript',
  'assignmentFilter', 'roleScopeTag', 'windowsFeatureUpdateProfile', 'windowsQualityUpdateProfile',
  'windowsDriverUpdateProfile', 'groupPolicyConfiguration', 'groupPolicyUploadedDefinitionFile',
  'notificationMessageTemplate', 'windowsAutopilotDeviceIdentity', 'deviceManagementRoleAssignment',
  // Wave 1 CAT-ENTRA: Entra governance collections. An attribute set's id is
  // its name and a custom security attribute's id is set_name, both chosen by
  // the admin; the others are tenant-assigned ids.
  'lifecycleWorkflow', 'lifecycleWorkflowCustomTaskExtension', 'attributeSet', 'customSecurityAttributeDefinition',
  'accessPackageCatalog', 'accessPackageAssignmentPolicy', 'accessPackageAssignment', 'agreement',
  'appManagementPolicy', 'b2xIdentityUserFlow', 'identityApiConnector',
  // Read per parent: a sync job id embeds its template and service principal,
  // and a resource role scope id is a GUID.
  'synchronizationJob', 'accessPackageResourceRoleScope',
  // Remaining kinds, batch 1: names are unmeasured, and built-in app categories
  // carry the same name in every tenant.
  'mobileThreatDefenseConnector', 'deviceManagementPartner', 'complianceManagementPartner', 'remoteAssistancePartner',
  'deviceManagementExchangeConnector', 'mobileAppCategory', 'intuneBrandingProfile', 'customAuthenticationExtension',
  // Remaining kinds, batch 3: names are unmeasured and Apple tokens carry no name.
  'deviceManagementCompliancePolicy', 'deviceManagementReusablePolicySetting', 'policySet', 'vppToken', 'depOnboardingSetting',
  'managedDeviceCleanupRule', 'windowsQualityUpdatePolicy', 'operationApprovalPolicy', 'deviceCustomAttributeShellScript',
  // Remaining kinds, batch 4: names are unmeasured, and built-in user flow
  // attributes carry the same name in every tenant.
  'b2bManagementPolicy', 'servicePrincipalCreationPolicy', 'permissionGrantPreApprovalPolicy',
  'identityUserFlowAttribute', 'authenticationEventListener', 'externalDomainFederation',
  // Remaining kinds, batch 5: built-in Exchange roles carry the same name in every tenant.
  'exchangeRoleDefinition', 'exchangeRoleAssignment', 'exchangeCustomAppScope',
  'defenderRoleDefinition', 'defenderRoleAssignment', 'defenderCustomAppScope',
  // Remaining kinds, batch 6: Intune names are unmeasured, and built-in baselines
  // carry the same name in every tenant.
  'androidDeviceOwnerEnrollmentProfile', 'androidForWorkEnrollmentProfile', 'appleUserInitiatedEnrollmentProfile',
  'deviceManagementDerivedCredentialSettings', 'microsoftTunnelConfiguration', 'microsoftTunnelHealthThreshold',
  'iosLobAppProvisioningConfiguration', 'mobileAppRelationship', 'managedEBook', 'managedEBookCategory',
  'cartToClassAssociation', 'windowsManagedAppProtection', 'enterpriseCodeSigningCertificate',
  'userExperienceAnalyticsBaseline',
  // Remaining kinds, batch 7: Microsoft 365 settings. A connection's id is the
  // name its admin chose; simulation names are unmeasured.
  'externalConnection', 'simulationAutomation', 'attackSimulation',
]);

// Tenant singletons: exactly one object per tenant, so the type name is the
// key. Keyed here, not only in canonicalize.mjs's keyFor(), so a live object
// read by the reconciliation plan (which calls naturalKeyFor directly) gets
// the same key as its snapshot (roadmap task-149).
export const CONSTANT_KEY_TYPES = new Set([
  'certificateBasedAuthConfiguration', 'adminConsentRequestPolicy',
  'identitySecurityDefaultsEnforcementPolicy', 'crossTenantAccessPolicyConfigurationDefault',
  // Issue #156: the default company branding, device registration and
  // authentication flows policies.
  'organizationalBranding', 'deviceRegistrationPolicy', 'authenticationFlowsPolicy',
  // Wave 1 CAT-ENTRA: Entra governance singletons.
  'lifecycleManagementSettings', 'entitlementManagementSettings', 'tenantAppManagementPolicy',
  'multiTenantOrganization',
  // Remaining kinds, batch 1: Intune tenant singletons.
  'applePushNotificationCertificate', 'onPremisesConditionalAccessSettings',
  // Remaining kinds, batch 3: the Managed Google Play binding.
  'androidManagedStoreAccountEnterpriseSettings',
  // Remaining kinds, batch 4: Entra ID tenant singletons.
  'externalIdentitiesPolicy', 'accessReviewPolicy', 'directoryRoleAccessReviewPolicy',
  'multiTenantOrganizationIdentitySyncPolicyTemplate', 'multiTenantOrganizationPartnerConfigurationTemplate',
  // Remaining kinds, batch 6: Intune tenant singletons.
  'deviceManagementSettings', 'androidForWorkSettings', 'symantecCodeSigningCertificate',
  // Remaining kinds, batch 7: Microsoft 365 tenant singletons.
  'sharepointSettings', 'itemInsightsSettings',
]);

const PARTNER_KEY_TYPES = new Set(['crossTenantAccessPolicyPartner', 'crossTenantIdentitySyncPolicyPartner']);

export function naturalKeyFor(type, obj, ctx) {
  if (CONSTANT_KEY_TYPES.has(type)) return type;
  // A partner has no id or name: Graph identifies it by the partner's tenantId
  // (see canonicalize.mjs's keyFor()). Its sync settings are the same.
  if (PARTNER_KEY_TYPES.has(type) && typeof obj?.tenantId === 'string') return obj.tenantId;
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
