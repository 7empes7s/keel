/** Catalogue family: Entra ID tenant settings (remaining kinds, batch 4). See ../catalog.mjs for the entry shape. */
// Read-only list or singleton reads. Each path is in the operator's export of
// what tenant discovery found readable but not backed up (Q100, run of
// 2026-10-19), so the grant each needs is one the Collector already holds
// (Policy.Read.All, IdentityUserFlow.Read.All, Directory.Read.All).
// Several are beta only, a fidelity risk the spec flags.
// No writer is built for any of them yet: the backup is a record to rebuild from.
// None of these objects holds a secret: a federation's signing certificate is
// the partner's public certificate.
export default [
  // External Identities: whether external users may leave the tenant themselves.
  { type: 'externalIdentitiesPolicy', path: '/policies/externalIdentitiesPolicy', version: 'beta', singleton: true,
    absentWhenNotFound: true, criticality: 'tier2', blastRadius: 'access-affecting' },
  // Collaboration restrictions: the domains guests may or may not be invited from.
  { type: 'b2bManagementPolicy', path: '/policies/b2bManagementPolicies', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'The allow or block list of guest domains is a JSON string in definition.' },
  // Who may create service principals for which apps.
  { type: 'servicePrincipalCreationPolicy', path: '/policies/servicePrincipalCreationPolicies', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'The include and exclude conditions are separate collections, read per policy and not backed up yet.' },
  // Pre-approved app permissions (for example Teams resource-specific consent).
  { type: 'permissionGrantPreApprovalPolicy', path: '/policies/permissionGrantPreApprovalPolicies', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting' },
  // Access review settings: whether group owners can manage reviews of their groups.
  // Same object as /identityGovernance/accessReviews/policy.
  { type: 'accessReviewPolicy', path: '/policies/accessReviewPolicy', version: 'beta', singleton: true,
    absentWhenNotFound: true, criticality: 'tier3', blastRadius: 'cosmetic' },
  // Default settings of access reviews of admin roles.
  { type: 'directoryRoleAccessReviewPolicy', path: '/policies/directoryRoleAccessReviewPolicy', version: 'beta', singleton: true,
    absentWhenNotFound: true, criticality: 'tier3', blastRadius: 'access-affecting' },
  // Multitenant organization templates: the user sync and cross-tenant access
  // settings a tenant gets when it joins the organization.
  { type: 'multiTenantOrganizationIdentitySyncPolicyTemplate', path: '/policies/crossTenantAccessPolicy/templates/multiTenantOrganizationIdentitySynchronization',
    version: 'v1.0', singleton: true, absentWhenNotFound: true, criticality: 'tier3', blastRadius: 'access-affecting',
    note: 'Applies to tenants that join later; existing partners keep their own settings.' },
  { type: 'multiTenantOrganizationPartnerConfigurationTemplate', path: '/policies/crossTenantAccessPolicy/templates/multiTenantOrganizationPartnerConfiguration',
    version: 'v1.0', singleton: true, absentWhenNotFound: true, criticality: 'tier3', blastRadius: 'access-affecting',
    note: 'Applies to tenants that join later; existing partners keep their own settings.' },
  // Attributes user flows collect at sign-up. Microsoft's built-in attributes
  // are listed beside the tenant's own.
  { type: 'identityUserFlowAttribute', path: '/identity/userFlowAttributes', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic',
    note: 'userFlowAttributeType tells built-in attributes from custom ones.' },
  // Which custom authentication extension runs at which sign-in event, for which apps.
  { type: 'authenticationEventListener', path: '/identity/authenticationEventListeners', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'Points to a custom authentication extension by id, so the extension is rebuilt first.' },
  // SAML or WS-Fed sign-in for guests from a partner's domains.
  { type: 'externalDomainFederation', path: '/directory/federationConfigurations', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'A missing federation stops guests from that domain signing in with their own identity provider.' },
];
