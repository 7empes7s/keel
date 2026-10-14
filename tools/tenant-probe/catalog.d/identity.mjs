/** Catalogue family: Identity. See ../catalog.mjs for the entry shape. */
export default [
  { type: 'application', path: '/applications', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    pageCap: 20,
    note: 'Secret values are unrecoverable — cross-tenant needs the re-issue workflow (spec §9.5).' },
  { type: 'servicePrincipal', path: '/servicePrincipals', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    // appRoles and oauth2PermissionScopes publish the permission ids that every
    // application's requiredResourceAccess points at. Without them, every
    // permission in the tenant reads as a dangling reference.
    select: 'id,appId,displayName,description,notes,servicePrincipalType,accountEnabled,appRoleAssignmentRequired,tags,signInAudience,appRoles,oauth2PermissionScopes',
    pageCap: 20 },
  { type: 'oauth2PermissionGrant', path: '/oauth2PermissionGrants', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting',
    pageCap: 20,
    note: 'Delegated consent. Cross-tenant these must be re-granted, not copied.' },
  { type: 'identityProvider', path: '/identity/identityProviders', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting' },
  { type: 'certificateBasedAuthConfiguration', path: '/organization/{org}/certificateBasedAuthConfiguration', version: 'v1.0', criticality: 'tier1', blastRadius: 'tenant-lockout', needsOrgId: true, singleton: true },
];
