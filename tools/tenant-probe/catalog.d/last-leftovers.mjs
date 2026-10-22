/** Catalogue family: the last readable kinds (remaining kinds, batch 8). See ../catalog.mjs for the entry shape. */
// Read-only list reads. Each path is in the operator's export of what tenant
// discovery found readable but not backed up (Q104, run 3 of 2026-10-21), so
// the grant each needs is one the Collector already holds.
// Most are beta only, a fidelity risk the spec flags.
// No writer is built for any of them yet: the backup is a record to rebuild from.
// Secrets are left out with $select: the BIOS settings file of a hardware
// configuration (it can carry the BIOS password) and the endpoint of a PIM
// custom extension (a Logic App callback address can carry its signature).
// Left out on purpose (engine/discovery/notGaps.mjs says why): uploaded group
// policy object files and eSIM activation code pools hold secrets and little
// else; Windows 10X resource access profiles configure a product Microsoft
// never shipped.
export default [
  // BIOS settings Intune pushes to Dell, HP and other PCs. The settings file is
  // left out because it can carry the BIOS password.
  { type: 'hardwareConfiguration', path: '/deviceManagement/hardwareConfigurations', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting',
    select: 'id,createdDateTime,description,displayName,fileName,hardwareConfigurationFormat,lastModifiedDateTime,perDevicePasswordDisabled,roleScopeTagIds,version',
    note: 'The settings file is uploaded again from your own copy.' },
  // Which certificate authorities an app trusts for certificate sign-in.
  { type: 'certificateBasedApplicationConfiguration', path: '/directory/certificateAuthorities/certificateBasedApplicationConfigurations', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'The trusted authorities (public certificates) are read per configuration and not backed up yet.' },
  // Which identifiers people can sign in with (email, user name, custom user name).
  { type: 'signInIdentifier', path: '/identity/signInIdentifiers', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'Turning an identifier off stops everyone who signs in with it.' },
  // Verified ID verification profiles (Face Check, accepted issuers, claims).
  { type: 'verifiedIdProfile', path: '/identity/verifiedId/profiles', version: 'beta',
    criticality: 'tier3', blastRadius: 'access-affecting' },
  // Entitlement management connectors to resources outside Entra ID.
  { type: 'externalOriginResourceConnector', path: '/identityGovernance/entitlementManagement/externalOriginResourceConnectors', version: 'beta',
    criticality: 'tier3', blastRadius: 'access-affecting' },
  // Lifecycle policies, such as disabling accounts that have not signed in.
  { type: 'lifecyclePolicy', path: '/identityGovernance/lifecycleWorkflows/lifecyclePolicies', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'enforcementAction can disable or delete the accounts in scope; rules and versions are read per policy and not backed up yet.' },
  // Custom extensions PIM calls when a role is activated. The endpoint is left
  // out: a Logic App callback address can carry its access signature.
  { type: 'roleManagementCustomExtension', path: '/identityGovernance/privilegedAccess/customExtensions', version: 'v1.0',
    criticality: 'tier3', blastRadius: 'access-affecting',
    select: 'id,displayName,description,authenticationConfiguration,clientConfiguration,customAttributes,resourceType,type',
    note: 'The Logic App it calls is picked again by hand.' },
  // Groups brought under Privileged Identity Management for Groups.
  { type: 'privilegedAccessGroupResource', path: '/identityGovernance/privilegedAccess/group/resources', version: 'beta',
    criticality: 'tier3', blastRadius: 'access-affecting',
    note: 'Only the group id; the group is rebuilt first.' },
  // Default calendar sharing, mail tips and room booking with other tenants.
  { type: 'crossTenantM365Capability', path: '/policies/crossTenantAccessPolicy/default/m365Capabilities', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting',
    note: 'Opens free/busy and mail tips to every other tenant unless a partner setting says otherwise.' },
  // Who holds which entitlement management role (catalog owner, access package
  // manager). Graph lists assignments only for one role at a time.
  { type: 'entitlementManagementRoleAssignment', path: '/roleManagement/entitlementManagement/roleAssignments', version: 'beta',
    criticality: 'tier2', blastRadius: 'access-affecting',
    parent: { path: '/roleManagement/entitlementManagement/roleDefinitions', select: 'id', key: 'id', as: 'roleDefinitionId' },
    query: "$filter=roleDefinitionId eq '{parent}'",
    note: 'appScopeId names the catalog the role covers, so catalogs are rebuilt first.' },
  // Device templates for devices registered in bulk by their maker.
  { type: 'deviceTemplate', path: '/templates/deviceTemplates', version: 'beta',
    criticality: 'tier3', blastRadius: 'cosmetic' },
  // Exposure management zones that group cloud environments.
  { type: 'securityZone', path: '/security/zones', version: 'beta',
    criticality: 'tier3', blastRadius: 'cosmetic' },
  // Shared email domains the tenant sends from.
  { type: 'sharedEmailDomain', path: '/directory/sharedEmailDomains', version: 'beta',
    criticality: 'tier3', blastRadius: 'cosmetic' },
  // Schema extensions this tenant's own apps defined. Graph lists every
  // extension any app in any tenant made public (thousands), so only those
  // owned by one of this tenant's app registrations are read.
  { type: 'schemaExtension', path: '/schemaExtensions', version: 'v1.0',
    criticality: 'tier3', blastRadius: 'access-affecting',
    parent: { path: '/applications', select: 'id,appId', query: '$top=999', key: 'appId', as: 'ownerAppId' },
    query: "$filter=owner eq '{parent}'",
    note: 'Data stored in an extension on users or groups is lost if the extension is deleted.' },
];
