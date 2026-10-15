/**
 * Capability fragment: IDO (Wave 2). See ../capabilities.mjs registerCapabilityFragment for the entry shape.
 *
 * Each (type, operation) here is written by the writer registered for it in
 * engine/restore/writers/ido.mjs, which names the same handler. Data only: this
 * file never imports the registry (a cycle). Fixture-tested, not live-qualified.
 *
 * Identity objects: service principal update and delete, recreate of a deleted
 * user (disabled, credentials checklist), the Entra governance types the backup
 * holds in full, and add-only owner and app role grant edges. Intune: app
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
  { resourceType: 'attributeSet', operation: 'create', path: '/directory/attributeSets', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'attributeSet', operation: 'update', path: '/directory/attributeSets', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'customSecurityAttributeDefinition', operation: 'create', path: '/directory/customSecurityAttributeDefinitions', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'customSecurityAttributeDefinition', operation: 'update', path: '/directory/customSecurityAttributeDefinitions', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'accessPackageCatalog', operation: 'create', path: '/identityGovernance/entitlementManagement/catalogs', handler: IDENTITY, idOutcome: 'server-assigned', proofRef: IDENTITY_PROOF },
  { resourceType: 'accessPackageCatalog', operation: 'update', path: '/identityGovernance/entitlementManagement/catalogs', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'entitlementManagementSettings', operation: 'update', path: '/identityGovernance/entitlementManagement/settings', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'appManagementPolicy', operation: 'create', path: '/policies/appManagementPolicies', handler: IDENTITY, idOutcome: 'server-assigned', proofRef: IDENTITY_PROOF },
  { resourceType: 'appManagementPolicy', operation: 'update', path: '/policies/appManagementPolicies', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'tenantAppManagementPolicy', operation: 'update', path: '/policies/defaultAppManagementPolicy', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'multiTenantOrganization', operation: 'update', path: '/tenantRelationships/multiTenantOrganization', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'crossTenantIdentitySyncPolicyPartner', operation: 'create', path: '/policies/crossTenantAccessPolicy/partners/{tenantId}/identitySynchronization', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
  { resourceType: 'crossTenantIdentitySyncPolicyPartner', operation: 'update', path: '/policies/crossTenantAccessPolicy/partners/{tenantId}/identitySynchronization', handler: IDENTITY, idOutcome: 'preserved', proofRef: IDENTITY_PROOF },
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
  // Add-only identity edges: an edge is never removed, so edge-remove is not registered.
  { resourceType: 'application#appOwner', operation: 'edge-add', path: '/applications/{id}/owners/$ref', handler: EDGES, idOutcome: 'edge', proofRef: IDENTITY_PROOF },
  { resourceType: 'servicePrincipal#servicePrincipalOwner', operation: 'edge-add', path: '/servicePrincipals/{id}/owners/$ref', handler: EDGES, idOutcome: 'edge', proofRef: IDENTITY_PROOF },
  { resourceType: 'servicePrincipal#appRoleGrant', operation: 'edge-add', path: '/servicePrincipals/{id}/appRoleAssignments', handler: EDGES, idOutcome: 'edge', proofRef: IDENTITY_PROOF },
];
