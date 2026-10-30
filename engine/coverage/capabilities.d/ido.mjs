/**
 * Capability fragment: IDO (Wave 2). See ../capabilities.mjs registerCapabilityFragment for the entry shape.
 *
 * Each (type, operation) here is written by the writer registered for it in
 * engine/restore/writers/ido.mjs, which names the same handler. Data only: this
 * file never imports the registry (a cycle). Fixture-tested, not live-qualified.
 *
 * Identity objects: service principal update and delete, recreate of a deleted
 * user (disabled, credentials checklist), the Entra governance types the backup
 * holds in full (attribute sets and custom security attributes: update only), and add-only owner and app role grant edges. Intune: app
 * protection, app configuration, update profiles, filters, scope tags and
 * notification templates, plus delete of an unassigned policy.
 */
const IDENTITY = 'engine/restore/identityObjectOperations.mjs#applyIdentityObjectWrite';
const INTUNE = 'engine/restore/intuneOperations.mjs#applyIntuneExtendedWrite';
const EDGES = 'engine/restore/identityObjectOperations.mjs#applyIdentityEdges';
const IDENTITY_PROOF = 'engine/restore/identityObjectOperations.test.mjs';
const INTUNE_PROOF = 'engine/restore/intuneExtended.test.mjs';

export default [
  { resourceType: 'servicePrincipal', operation: 'update', path: '/servicePrincipals', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'servicePrincipal', operation: 'delete', path: '/servicePrincipals', handler: IDENTITY, idOutcome: 'terminal', proofRef: IDENTITY_PROOF },
  { resourceType: 'lifecycleWorkflow', operation: 'create', path: '/identityGovernance/lifecycleWorkflows/workflows', handler: IDENTITY, idOutcome: 'server-assigned', proofRef: IDENTITY_PROOF },
  { resourceType: 'lifecycleWorkflow', operation: 'update', path: '/identityGovernance/lifecycleWorkflows/workflows', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'lifecycleWorkflowCustomTaskExtension', operation: 'create', path: '/identityGovernance/lifecycleWorkflows/customTaskExtensions', handler: IDENTITY, idOutcome: 'server-assigned', proofRef: IDENTITY_PROOF },
  { resourceType: 'lifecycleWorkflowCustomTaskExtension', operation: 'update', path: '/identityGovernance/lifecycleWorkflows/customTaskExtensions', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'lifecycleManagementSettings', operation: 'update', path: '/identityGovernance/lifecycleWorkflows/settings', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'attributeSet', operation: 'update', path: '/directory/attributeSets', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'customSecurityAttributeDefinition', operation: 'update', path: '/directory/customSecurityAttributeDefinitions', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'accessPackageCatalog', operation: 'create', path: '/identityGovernance/entitlementManagement/catalogs', handler: IDENTITY, idOutcome: 'server-assigned', proofRef: IDENTITY_PROOF },
  { resourceType: 'accessPackageCatalog', operation: 'update', path: '/identityGovernance/entitlementManagement/catalogs', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'entitlementManagementSettings', operation: 'update', path: '/identityGovernance/entitlementManagement/settings', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'appManagementPolicy', operation: 'create', path: '/policies/appManagementPolicies', handler: IDENTITY, idOutcome: 'server-assigned', proofRef: IDENTITY_PROOF },
  { resourceType: 'appManagementPolicy', operation: 'update', path: '/policies/appManagementPolicies', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'multiTenantOrganization', operation: 'update', path: '/tenantRelationships/multiTenantOrganization', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  // Restore gaps, batch 2: Entra ID tenant singletons.
  { resourceType: 'externalIdentitiesPolicy', operation: 'update', path: '/policies/externalIdentitiesPolicy', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'accessReviewPolicy', operation: 'update', path: '/policies/accessReviewPolicy', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'directoryRoleAccessReviewPolicy', operation: 'update', path: '/policies/directoryRoleAccessReviewPolicy', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'multiTenantOrganizationIdentitySyncPolicyTemplate', operation: 'update', path: '/policies/crossTenantAccessPolicy/templates/multiTenantOrganizationIdentitySynchronization', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  // Restore gaps, batch 3: guest and app consent settings.
  { resourceType: 'permissionGrantPreApprovalPolicy', operation: 'create', path: '/policies/permissionGrantPreApprovalPolicies', handler: IDENTITY, idOutcome: 'server-assigned', proofRef: IDENTITY_PROOF },
  { resourceType: 'permissionGrantPreApprovalPolicy', operation: 'update', path: '/policies/permissionGrantPreApprovalPolicies', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'externalDomainFederation', operation: 'update', path: '/directory/federationConfigurations/graph.samlOrWsFedExternalDomainFederation', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'multiTenantOrganizationPartnerConfigurationTemplate', operation: 'update', path: '/policies/crossTenantAccessPolicy/templates/multiTenantOrganizationPartnerConfiguration', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'user', operation: 'create', path: '/users', handler: IDENTITY, idOutcome: 'server-assigned', proofRef: IDENTITY_PROOF },
  { resourceType: 'deviceCompliancePolicy', operation: 'delete', path: '/deviceManagement/deviceCompliancePolicies', handler: INTUNE, idOutcome: 'terminal', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceConfiguration', operation: 'delete', path: '/deviceManagement/deviceConfigurations', handler: INTUNE, idOutcome: 'terminal', proofRef: INTUNE_PROOF },
  { resourceType: 'configurationPolicy', operation: 'delete', path: '/deviceManagement/configurationPolicies', handler: INTUNE, idOutcome: 'terminal', proofRef: INTUNE_PROOF },
  { resourceType: 'managedAppPolicy', operation: 'create', path: '/deviceAppManagement/managedAppPolicies', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'managedAppPolicy', operation: 'update', path: '/deviceAppManagement/managedAppPolicies', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'managedAppPolicy', operation: 'delete', path: '/deviceAppManagement/managedAppPolicies', handler: INTUNE, idOutcome: 'terminal', proofRef: INTUNE_PROOF },
  { resourceType: 'targetedManagedAppConfiguration', operation: 'create', path: '/deviceAppManagement/targetedManagedAppConfigurations', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'targetedManagedAppConfiguration', operation: 'update', path: '/deviceAppManagement/targetedManagedAppConfigurations', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'targetedManagedAppConfiguration', operation: 'delete', path: '/deviceAppManagement/targetedManagedAppConfigurations', handler: INTUNE, idOutcome: 'terminal', proofRef: INTUNE_PROOF },
  { resourceType: 'mobileAppConfiguration', operation: 'create', path: '/deviceAppManagement/mobileAppConfigurations', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'mobileAppConfiguration', operation: 'update', path: '/deviceAppManagement/mobileAppConfigurations', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'mobileAppConfiguration', operation: 'delete', path: '/deviceAppManagement/mobileAppConfigurations', handler: INTUNE, idOutcome: 'terminal', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsFeatureUpdateProfile', operation: 'create', path: '/deviceManagement/windowsFeatureUpdateProfiles', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsFeatureUpdateProfile', operation: 'update', path: '/deviceManagement/windowsFeatureUpdateProfiles', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsFeatureUpdateProfile', operation: 'delete', path: '/deviceManagement/windowsFeatureUpdateProfiles', handler: INTUNE, idOutcome: 'terminal', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsQualityUpdateProfile', operation: 'create', path: '/deviceManagement/windowsQualityUpdateProfiles', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsQualityUpdateProfile', operation: 'update', path: '/deviceManagement/windowsQualityUpdateProfiles', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsQualityUpdateProfile', operation: 'delete', path: '/deviceManagement/windowsQualityUpdateProfiles', handler: INTUNE, idOutcome: 'terminal', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsDriverUpdateProfile', operation: 'create', path: '/deviceManagement/windowsDriverUpdateProfiles', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsDriverUpdateProfile', operation: 'update', path: '/deviceManagement/windowsDriverUpdateProfiles', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsDriverUpdateProfile', operation: 'delete', path: '/deviceManagement/windowsDriverUpdateProfiles', handler: INTUNE, idOutcome: 'terminal', proofRef: INTUNE_PROOF },
  { resourceType: 'assignmentFilter', operation: 'create', path: '/deviceManagement/assignmentFilters', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'assignmentFilter', operation: 'update', path: '/deviceManagement/assignmentFilters', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'roleScopeTag', operation: 'create', path: '/deviceManagement/roleScopeTags', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'roleScopeTag', operation: 'update', path: '/deviceManagement/roleScopeTags', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'notificationMessageTemplate', operation: 'create', path: '/deviceManagement/notificationMessageTemplates', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'notificationMessageTemplate', operation: 'update', path: '/deviceManagement/notificationMessageTemplates', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Restore gaps, batch 1: Intune tenant settings.
  { resourceType: 'deviceManagementReusablePolicySetting', operation: 'create', path: '/deviceManagement/reusablePolicySettings', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceManagementReusablePolicySetting', operation: 'update', path: '/deviceManagement/reusablePolicySettings', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsQualityUpdatePolicy', operation: 'create', path: '/deviceManagement/windowsQualityUpdatePolicies', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsQualityUpdatePolicy', operation: 'update', path: '/deviceManagement/windowsQualityUpdatePolicies', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceCategory', operation: 'create', path: '/deviceManagement/deviceCategories', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceCategory', operation: 'update', path: '/deviceManagement/deviceCategories', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'managedDeviceCleanupRule', operation: 'update', path: '/deviceManagement/managedDeviceCleanupRules', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Restore gaps, batch 4: scripts and remediations.
  { resourceType: 'deviceManagementScript', operation: 'create', path: '/deviceManagement/deviceManagementScripts', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceManagementScript', operation: 'update', path: '/deviceManagement/deviceManagementScripts', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceShellScript', operation: 'create', path: '/deviceManagement/deviceShellScripts', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceShellScript', operation: 'update', path: '/deviceManagement/deviceShellScripts', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceHealthScript', operation: 'create', path: '/deviceManagement/deviceHealthScripts', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceHealthScript', operation: 'update', path: '/deviceManagement/deviceHealthScripts', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceComplianceScript', operation: 'create', path: '/deviceManagement/deviceComplianceScripts', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceComplianceScript', operation: 'update', path: '/deviceManagement/deviceComplianceScripts', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Restore gaps, batch 5: macOS custom attribute scripts and administrative templates.
  { resourceType: 'deviceCustomAttributeShellScript', operation: 'create', path: '/deviceManagement/deviceCustomAttributeShellScripts', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceCustomAttributeShellScript', operation: 'update', path: '/deviceManagement/deviceCustomAttributeShellScripts', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'groupPolicyConfiguration', operation: 'create', path: '/deviceManagement/groupPolicyConfigurations', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'groupPolicyConfiguration', operation: 'update', path: '/deviceManagement/groupPolicyConfigurations', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Restore gaps, batch 6: app categories, Autopilot profiles and policy sets.
  { resourceType: 'mobileAppCategory', operation: 'create', path: '/deviceAppManagement/mobileAppCategories', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'mobileAppCategory', operation: 'update', path: '/deviceAppManagement/mobileAppCategories', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsAutopilotDeploymentProfile', operation: 'create', path: '/deviceManagement/windowsAutopilotDeploymentProfiles', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsAutopilotDeploymentProfile', operation: 'update', path: '/deviceManagement/windowsAutopilotDeploymentProfiles', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'policySet', operation: 'create', path: '/deviceAppManagement/policySets', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'policySet', operation: 'update', path: '/deviceAppManagement/policySets', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Restore gaps, batch 7: settings catalog compliance policies.
  { resourceType: 'deviceManagementCompliancePolicy', operation: 'create', path: '/deviceManagement/compliancePolicies', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceManagementCompliancePolicy', operation: 'update', path: '/deviceManagement/compliancePolicies', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Restore gaps, batch 8: e-book categories, Microsoft Tunnel configurations and Apple user enrollment profiles.
  { resourceType: 'managedEBookCategory', operation: 'create', path: '/deviceAppManagement/managedEBookCategories', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'managedEBookCategory', operation: 'update', path: '/deviceAppManagement/managedEBookCategories', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'microsoftTunnelConfiguration', operation: 'create', path: '/deviceManagement/microsoftTunnelConfigurations', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'microsoftTunnelConfiguration', operation: 'update', path: '/deviceManagement/microsoftTunnelConfigurations', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'appleUserInitiatedEnrollmentProfile', operation: 'create', path: '/deviceManagement/appleUserInitiatedEnrollmentProfiles', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'appleUserInitiatedEnrollmentProfile', operation: 'update', path: '/deviceManagement/appleUserInitiatedEnrollmentProfiles', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Restore gaps, batch 9: Company Portal branding (not the default) and Exchange app access scopes.
  { resourceType: 'intuneBrandingProfile', operation: 'create', path: '/deviceManagement/intuneBrandingProfiles', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'intuneBrandingProfile', operation: 'update', path: '/deviceManagement/intuneBrandingProfiles', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'exchangeCustomAppScope', operation: 'create', path: '/roleManagement/exchange/customAppScopes', handler: IDENTITY, idOutcome: 'server-assigned', proofRef: IDENTITY_PROOF },
  { resourceType: 'exchangeCustomAppScope', operation: 'update', path: '/roleManagement/exchange/customAppScopes', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  // Restore gaps, batch 21: custom Defender XDR roles.
  { resourceType: 'defenderRoleDefinition', operation: 'create', path: '/roleManagement/defender/roleDefinitions', handler: IDENTITY, idOutcome: 'server-assigned', proofRef: IDENTITY_PROOF },
  { resourceType: 'defenderRoleDefinition', operation: 'update', path: '/roleManagement/defender/roleDefinitions', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  // Restore gaps, batch 10: Endpoint analytics baselines, classroom carts and Android enrollment profiles.
  { resourceType: 'userExperienceAnalyticsBaseline', operation: 'create', path: '/deviceManagement/userExperienceAnalyticsBaselines', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'userExperienceAnalyticsBaseline', operation: 'update', path: '/deviceManagement/userExperienceAnalyticsBaselines', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'cartToClassAssociation', operation: 'create', path: '/deviceManagement/cartToClassAssociations', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'cartToClassAssociation', operation: 'update', path: '/deviceManagement/cartToClassAssociations', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'androidForWorkEnrollmentProfile', operation: 'create', path: '/deviceManagement/androidForWorkEnrollmentProfiles', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'androidForWorkEnrollmentProfile', operation: 'update', path: '/deviceManagement/androidForWorkEnrollmentProfiles', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'androidDeviceOwnerEnrollmentProfile', operation: 'create', path: '/deviceManagement/androidDeviceOwnerEnrollmentProfiles', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'androidDeviceOwnerEnrollmentProfile', operation: 'update', path: '/deviceManagement/androidDeviceOwnerEnrollmentProfiles', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Restore gaps, batch 11: imported ADMX files (create) and BIOS configurations (update).
  { resourceType: 'groupPolicyUploadedDefinitionFile', operation: 'create', path: '/deviceManagement/groupPolicyUploadedDefinitionFiles', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'hardwareConfiguration', operation: 'update', path: '/deviceManagement/hardwareConfigurations', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Restore gaps, batch 17: tenant-wide settings, updated in place.
  { resourceType: 'deviceManagementSettings', operation: 'update', path: '/deviceManagement', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'microsoftTunnelHealthThreshold', operation: 'update', path: '/deviceManagement/microsoftTunnelHealthThresholds', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'onPremisesConditionalAccessSettings', operation: 'update', path: '/deviceManagement/conditionalAccessSettings', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'sharepointSettings', operation: 'update', path: '/admin/sharepoint/settings', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  // Restore gaps, batch 20: Microsoft 365 admin center org settings and Viva Engage communities, updated in place.
  { resourceType: 'formsSettings', operation: 'update', path: '/admin/forms', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'microsoft365AppsInstallationOptions', operation: 'update', path: '/admin/microsoft365Apps/installationOptions', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'appsAndServicesSettings', operation: 'update', path: '/admin/appsAndServices', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'adminReportSettings', operation: 'update', path: '/admin/reportSettings', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'pronounsSettings', operation: 'update', path: '/admin/people/pronouns', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'engageCommunity', operation: 'update', path: '/employeeExperience/communities', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  // Approval-held kinds (restore/approvalHeld.mjs): device join settings, the default app
  // credential rules and custom Intune admin roles, written behind the restore approval.
  { resourceType: 'deviceRegistrationPolicy', operation: 'update', path: '/policies/deviceRegistrationPolicy', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'tenantAppManagementPolicy', operation: 'update', path: '/policies/defaultAppManagementPolicy', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'deviceManagementRoleDefinition', operation: 'create', path: '/deviceManagement/roleDefinitions', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'deviceManagementRoleDefinition', operation: 'update', path: '/deviceManagement/roleDefinitions', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Restore gaps, batch 12: Windows app protection policies and iOS app provisioning profiles.
  { resourceType: 'windowsManagedAppProtection', operation: 'create', path: '/deviceAppManagement/windowsManagedAppProtections', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'windowsManagedAppProtection', operation: 'update', path: '/deviceAppManagement/windowsManagedAppProtections', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  { resourceType: 'iosLobAppProvisioningConfiguration', operation: 'create', path: '/deviceAppManagement/iosLobAppProvisioningConfigurations', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'iosLobAppProvisioningConfiguration', operation: 'update', path: '/deviceAppManagement/iosLobAppProvisioningConfigurations', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Restore gaps, batch 13: app dependencies and supersedence.
  { resourceType: 'mobileAppRelationship', operation: 'create', path: '/deviceAppManagement/mobileApps/{appId}/updateRelationships', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'mobileAppRelationship', operation: 'update', path: '/deviceAppManagement/mobileApps/{appId}/updateRelationships', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Only the undo of a link a restore created (the record refuses any other delete).
  { resourceType: 'mobileAppRelationship', operation: 'delete', path: '/deviceAppManagement/mobileApps/{appId}/updateRelationships', handler: INTUNE, idOutcome: 'terminal', proofRef: INTUNE_PROOF },
  // Restore gaps, batch 18: Intune apps (a Win32 or line-of-business app without its package).
  { resourceType: 'mobileApp', operation: 'create', path: '/deviceAppManagement/mobileApps', handler: INTUNE, idOutcome: 'server-assigned', proofRef: INTUNE_PROOF },
  { resourceType: 'mobileApp', operation: 'update', path: '/deviceAppManagement/mobileApps', handler: INTUNE, idOutcome: 'preserved', proofRef: INTUNE_PROOF },
  // Add-only identity edges: an edge is never removed, so edge-remove is not registered.
  { resourceType: 'application#appOwner', operation: 'edge-add', path: '/applications/{id}/owners/$ref', handler: EDGES, idOutcome: 'edge', proofRef: IDENTITY_PROOF },
  { resourceType: 'servicePrincipal#servicePrincipalOwner', operation: 'edge-add', path: '/servicePrincipals/{id}/owners/$ref', handler: EDGES, idOutcome: 'edge', proofRef: IDENTITY_PROOF },
  { resourceType: 'servicePrincipal#appRoleGrant', operation: 'edge-add', path: '/servicePrincipals/{id}/appRoleAssignments', handler: EDGES, idOutcome: 'edge', proofRef: IDENTITY_PROOF },
];
