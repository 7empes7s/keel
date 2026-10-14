/**
 * Catalogue family: Entra objects read per parent object (wave 1 CAT-ENTRA
 * follow-up). `parent` names the list read first, the parent field put into
 * `{parent}` and the field each object is tagged with; see ../catalog.mjs.
 */
export default [
  // Each partner's cross-tenant sync settings; a partner without them
  // answers 404, which is an observed absence.
  { type: 'crossTenantIdentitySyncPolicyPartner', path: '/policies/crossTenantAccessPolicy/partners/{parent}/identitySynchronization', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    parent: { path: '/policies/crossTenantAccessPolicy/partners', key: 'tenantId', as: 'tenantId' },
    absentWhenNotFound: true,
    note: 'Whether users from the partner tenant are synced into this one.' },
  // Provisioning and cross-tenant sync jobs. Only service principals made from
  // an app template (gallery apps, cross-tenant sync) are read, so a tenant
  // with thousands of Microsoft service principals costs one read each for
  // the few that can sync, not thousands.
  { type: 'synchronizationJob', path: '/servicePrincipals/{parent}/synchronization/jobs', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    parent: { path: '/servicePrincipals', select: 'id,applicationTemplateId', query: '$top=999', key: 'id', as: 'servicePrincipalId', requires: 'applicationTemplateId' },
    absentWhenNotFound: true,
    note: 'A running job creates and updates accounts in another directory.' },
  // The groups, apps and sites roles an access package grants. Graph lists
  // them only when one package is read with this expand.
  { type: 'accessPackageResourceRoleScope', path: '/identityGovernance/entitlementManagement/accessPackages/{parent}', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting',
    parent: { path: '/identityGovernance/entitlementManagement/accessPackages', select: 'id', key: 'id', as: 'accessPackageId' },
    query: '$expand=resourceRoleScopes($expand=role,scope)', childField: 'resourceRoleScopes' },
];
