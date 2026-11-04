/** Catalogue family: Entra governance (wave 1: CAT-ENTRA). See ../catalog.mjs for the entry shape. */
export default [
  // Lifecycle workflows (joiner, mover, leaver). Needs an Entra ID Governance
  // licence; a tenant without one answers with an error, which is reported.
  // A workflow's tasks are a separate collection, listed only when expanded.
  { type: 'lifecycleWorkflow', path: '/identityGovernance/lifecycleWorkflows/workflows', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    query: '$expand=tasks',
    note: 'A leaver workflow can disable or delete accounts on its own schedule.' },
  { type: 'lifecycleWorkflowCustomTaskExtension', path: '/identityGovernance/lifecycleWorkflows/customTaskExtensions', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'lifecycleManagementSettings', path: '/identityGovernance/lifecycleWorkflows/settings', version: 'v1.0', singleton: true, criticality: 'tier3', blastRadius: 'cosmetic' },
  // Custom security attributes. Reading them needs the attribute definition
  // reader grant, which Global Administrator does not include. Allowed values
  // are a separate collection, listed only when expanded.
  { type: 'attributeSet', path: '/directory/attributeSets', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'customSecurityAttributeDefinition', path: '/directory/customSecurityAttributeDefinitions', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    query: '$expand=allowedValues',
    note: 'Definitions can be deactivated but never deleted.' },
  // Entitlement management, beside accessPackage and connectedOrganization.
  { type: 'accessPackageCatalog', path: '/identityGovernance/entitlementManagement/catalogs', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  // A policy names its access package only when expanded.
  { type: 'accessPackageAssignmentPolicy', path: '/identityGovernance/entitlementManagement/assignmentPolicies', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    query: '$expand=accessPackage' },
  // Who holds which access package. The target and package are listed only
  // when expanded.
  { type: 'accessPackageAssignment', path: '/identityGovernance/entitlementManagement/assignments', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    query: '$expand=target,accessPackage',
    note: 'Restored by request through the assignment policy, never copied.' },
  { type: 'entitlementManagementSettings', path: '/identityGovernance/entitlementManagement/settings', version: 'v1.0', singleton: true, criticality: 'tier3', blastRadius: 'cosmetic' },
  // Terms of use. Needs Entra ID P1. The agreement documents are files on a
  // separate route.
  { type: 'agreement', path: '/identityGovernance/termsOfUse/agreements', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'Conditional Access can require acceptance, so a missing agreement blocks sign-in.' },
  // App management policies: credential rules for applications and service
  // principals. The tenant default is a singleton.
  { type: 'appManagementPolicy', path: '/policies/appManagementPolicies', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'tenantAppManagementPolicy', path: '/policies/defaultAppManagementPolicy', version: 'v1.0', singleton: true, criticality: 'tier2', blastRadius: 'access-affecting' },
  // Cross-tenant synchronization, tenant level: the multitenant organization.
  // Per-partner sync settings are in entra-per-parent.mjs; the sync template
  // is four segments deep, past what discovery walks.
  { type: 'multiTenantOrganization', path: '/tenantRelationships/multiTenantOrganization', version: 'v1.0', singleton: true, criticality: 'tier2', blastRadius: 'access-affecting' },
  // Self-service sign-up user flows for guests, and the API connectors they call.
  // Issue #995: a flow's parts are separate routes, read per flow: the identity
  // providers guests may sign up with (id, name and kind only, never a client id
  // or secret), the attributes it asks for in order, its languages, and which API
  // connector runs at which step (each connector's id and name only). A restore
  // reads live flows with the same parts (liveItemReads).
  { type: 'b2xIdentityUserFlow', path: '/identity/b2xUserFlows', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    itemReads: [
      { as: 'identityProviders', path: '/identity/b2xUserFlows/{item}/identityProviders', fields: ['id', 'name', 'type'] },
      { as: 'userAttributeAssignments', path: '/identity/b2xUserFlows/{item}/userAttributeAssignments?$expand=userAttribute' },
      { as: 'languages', path: '/identity/b2xUserFlows/{item}/languages', fields: ['id', 'displayName', 'isEnabled'], sortBy: 'id' },
      { as: 'apiConnectorConfiguration', single: true, field: 'apiConnectorConfiguration', fields: ['id', 'displayName'],
        path: '/identity/b2xUserFlows/{item}?$expand=apiConnectorConfiguration/postFederationSignup,apiConnectorConfiguration/postAttributeCollection' },
    ],
    liveItemReads: true,
    note: 'A flow is backed up with its identity providers, attributes (in order), languages and API connector steps. Custom page text and identity provider secrets are not.' },
  { type: 'identityApiConnector', path: '/identity/apiConnectors', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'The connector password or certificate is never returned.' },
];
