// Entra ID types. Priority comes from the catalogue's criticality and blast radius
// (see ../taxonomy.mjs) unless an entry sets its own.
export default Object.freeze({
  service: 'Entra',
  // Types by kind, in the order a list shows them: people and objects first, then
  // roles and access, then policies, then tenant-wide settings. taxonomy.test.mjs fails
  // on an entry that is in no group, so a new type has to be placed here. Every group
  // the service has is listed, even with no type yet: `match` places a kind Keel has
  // not mapped yet (see placeUnmapped in ../taxonomy.mjs).
  categories: Object.freeze([
    { key: 'people', name: 'Users and contacts', types: ['user', 'contact'], match: /^(user|contact|orgcontact|invitation)(?!flow)/ },
    { key: 'groups', name: 'Groups and administrative units', types: ['group', 'administrativeUnit', 'groupLifecyclePolicy', 'groupSetting', 'directorySettingTemplate', 'engageCommunity'], match: /^(group|administrativeunit|directorysettingtemplate|engagecommunity)(?!.*(membership|owner))/ },
    { key: 'memberships', name: 'Memberships and owners', types: ['groupMembership', 'groupTransitiveMembership', 'groupOwnership', 'applicationOwnership', 'servicePrincipalOwnership'], match: /membership|ownership|owner$/ },
    { key: 'roles', name: 'Admin roles', types: ['directoryRole', 'roleDefinition', 'directoryRoleTemplate', 'roleAssignment', 'roleEligibilitySchedule', 'roleAssignmentSchedule', 'unifiedRoleManagementPolicy', 'unifiedRoleManagementPolicyAssignment', 'privilegedAccessGroupResource', 'roleManagementCustomExtension', 'entitlementManagementRoleAssignment'], match: /^(?!.*accessreview)(directoryrole|roledefinition|roleassignment|roleeligibility|rolemanagement|unifiedrole|privilegedaccess|entitlementmanagementrole|role)/ },
    { key: 'apps', name: 'Apps and consent', types: ['application', 'servicePrincipal', 'oauth2PermissionGrant', 'appRoleGrant', 'permissionGrantPolicy', 'permissionGrantPreApprovalPolicy', 'adminConsentRequestPolicy', 'servicePrincipalCreationPolicy', 'appManagementPolicy', 'tenantAppManagementPolicy', 'certificateBasedApplicationConfiguration', 'claimsMappingPolicy', 'tokenIssuancePolicy', 'tokenLifetimePolicy', 'synchronizationJob'], match: /^application|serviceprincipal|oauth|consent|permissiongrant|approle|appmanagement|certificatebasedapplication|claimsmapping|tokenissuance|tokenlifetime|synchroni/ },
    { key: 'sign-in', name: 'Sign-in rules and methods', types: ['conditionalAccessPolicy', 'namedLocation', 'authenticationStrengthPolicy', 'authenticationContextClassReference', 'authenticationMethodsPolicy', 'identitySecurityDefaultsEnforcementPolicy', 'certificateBasedAuthConfiguration', 'signInIdentifier', 'activityBasedTimeoutPolicy', 'homeRealmDiscoveryPolicy', 'featureRolloutPolicy', 'deviceRegistrationPolicy', 'authenticationEventListener', 'customAuthenticationExtension'], match: /conditionalaccess|namedlocation|authentication(strength|method|context|event)|certificatebasedauth|customauthentication|signin|securitydefaults|homerealm|activitybasedtimeout|featurerollout|deviceregistration/ },
    { key: 'external', name: 'Guests and other tenants', types: ['identityProvider', 'externalDomainFederation', 'crossTenantAccessPolicy', 'crossTenantAccessPolicyConfigurationDefault', 'crossTenantAccessPolicyPartner', 'crossTenantIdentitySyncPolicyPartner', 'crossTenantM365Capability', 'multiTenantOrganization', 'multiTenantOrganizationIdentitySyncPolicyTemplate', 'multiTenantOrganizationPartnerConfigurationTemplate', 'authenticationFlowsPolicy', 'externalIdentitiesPolicy', 'b2bManagementPolicy', 'b2xIdentityUserFlow', 'identityUserFlowAttribute', 'identityApiConnector'], match: /crosstenant|externalidentit|externaldomain|b2b|b2c|b2x|federation|identityprovider|userflow|apiconnector|authenticationflows|multitenant/ },
    { key: 'governance', name: 'Access reviews and governance', types: ['accessReviewScheduleDefinition', 'accessReviewPolicy', 'directoryRoleAccessReviewPolicy', 'accessPackageCatalog', 'accessPackage', 'accessPackageAssignmentPolicy', 'accessPackageAssignment', 'accessPackageResourceRoleScope', 'connectedOrganization', 'externalOriginResourceConnector', 'entitlementManagementSettings', 'lifecycleWorkflow', 'lifecycleWorkflowCustomTaskExtension', 'lifecycleManagementSettings', 'lifecyclePolicy', 'agreement', 'verifiedIdProfile'], match: /accessreview|accesspackage|entitlement|connectedorganization|externalorigin|lifecycle|agreement|termsofuse|verifiedid/ },
    { key: 'tenant', name: 'Tenant and directory settings', types: ['organization', 'domain', 'sharedEmailDomain', 'subscribedSku', 'authorizationPolicy', 'organizationalBranding', 'organizationalBrandingLocalization', 'attributeSet', 'customSecurityAttributeDefinition', 'schemaExtension', 'deviceTemplate', 'profileCardProperty', 'pronounsSettings', 'adminReportSettings'], match: /^(organization|domain|subscribedsku|authorizationpolicy|sharedemaildomain|schemaextension|devicetemplate|profilecard|pronouns|adminreportsettings)|branding|customsecurityattribute|attributeset|directorysetting/ },
  ]),
  // Links between objects (who is in a group, who owns an app), as edge changes store
  // them (engine/govern/diffSnapshots.mjs). They are not catalogue types, so they live
  // here rather than in `entries`, and set their own priority.
  edges: Object.freeze({
    groupMembership: { name: 'Group membership', priority: 'high', reason: 'Changes who is in a group, and so what its members can reach.' },
    groupTransitiveMembership: { name: 'Nested group membership', priority: 'high', reason: 'Changes who is in a group through another group.' },
    groupOwnership: { name: 'Group owner', priority: 'high', reason: 'Owners can add anyone to the group.' },
    applicationOwnership: { name: 'App registration owner', priority: 'high', reason: 'Owners can add credentials to the app and act as it.' },
    servicePrincipalOwnership: { name: 'Enterprise app owner', priority: 'high', reason: 'Owners can change who can use the app and how it signs in.' },
    appRoleGrant: { name: 'App permission', priority: 'high', reason: 'Gives an app or person a permission on another app.' },
  }),
  entries: Object.freeze({
    // tenant
    organization: { name: 'Tenant profile' },
    domain: { name: 'Domain' },
    subscribedSku: { name: 'Licence subscription' },
    directorySettingTemplate: { name: 'Group setting template' },
    groupSetting: { name: 'Tenant-wide group setting' },
    organizationalBranding: { name: 'Company branding' },
    organizationalBrandingLocalization: { name: 'Company branding language' },
    groupLifecyclePolicy: { name: 'Group expiration policy' },

    // people, groups and apps
    user: { name: 'User' },
    group: { name: 'Group' },
    administrativeUnit: { name: 'Administrative unit' },
    contact: { name: 'Organizational contact' },
    application: { name: 'App registration' },
    servicePrincipal: { name: 'Enterprise app' },
    oauth2PermissionGrant: { name: 'Delegated app consent' },
    identityProvider: { name: 'External identity provider' },
    certificateBasedAuthConfiguration: { name: 'Certificate sign-in setting' },

    // admin roles
    directoryRole: { name: 'Built-in admin role' },
    // Holds Microsoft's built-in roles and the tenant's own. The kind reads as "Admin role";
    // one role reads as built-in or custom by its isBuiltIn flag (taxonomy objectTypeName).
    roleDefinition: { name: 'Admin role', builtInName: 'Built-in admin role', customName: 'Custom admin role' },
    directoryRoleTemplate: { name: 'Admin role template' },
    roleAssignment: { name: 'Admin role assignment' },
    roleEligibilitySchedule: { name: 'Eligible admin role' },
    roleAssignmentSchedule: { name: 'Time-limited admin role' },
    unifiedRoleManagementPolicy: { name: 'Admin role activation setting' },
    unifiedRoleManagementPolicyAssignment: { name: 'Role activation setting link' },

    // sign-in and security policies
    conditionalAccessPolicy: { name: 'Conditional Access policy' },
    authenticationStrengthPolicy: { name: 'Authentication strength' },
    namedLocation: { name: 'Named location' },
    authenticationContextClassReference: { name: 'Authentication context' },
    authenticationMethodsPolicy: { name: 'Authentication methods policy' },
    identitySecurityDefaultsEnforcementPolicy: { name: 'Security defaults' },
    authorizationPolicy: { name: 'User and guest permissions' },
    crossTenantAccessPolicy: { name: 'Cross-tenant access policy' },
    crossTenantAccessPolicyConfigurationDefault: { name: 'Cross-tenant access default' },
    crossTenantAccessPolicyPartner: { name: 'Cross-tenant access partner' },
    deviceRegistrationPolicy: { name: 'Device join and registration setting' },
    authenticationFlowsPolicy: { name: 'External user self sign-up setting' },
    permissionGrantPolicy: { name: 'App consent policy' },
    adminConsentRequestPolicy: { name: 'Admin consent request setting' },
    activityBasedTimeoutPolicy: { name: 'Idle sign-out policy' },
    claimsMappingPolicy: { name: 'Token claims mapping policy' },
    homeRealmDiscoveryPolicy: { name: 'Sign-in routing policy' },
    tokenIssuancePolicy: { name: 'Token issuance policy' },
    tokenLifetimePolicy: { name: 'Token lifetime policy' },
    featureRolloutPolicy: { name: 'Staged rollout of a sign-in feature' },

    // governance
    accessReviewScheduleDefinition: { name: 'Access review' },
    accessPackage: { name: 'Access package' },
    connectedOrganization: { name: 'Connected organization' },
    lifecycleWorkflow: { name: 'Lifecycle workflow' },
    lifecycleWorkflowCustomTaskExtension: { name: 'Lifecycle workflow extension' },
    lifecycleManagementSettings: { name: 'Lifecycle workflow setting' },
    attributeSet: { name: 'Custom security attribute set' },
    customSecurityAttributeDefinition: { name: 'Custom security attribute' },
    accessPackageCatalog: { name: 'Access package catalog' },
    accessPackageAssignmentPolicy: { name: 'Access package policy' },
    accessPackageAssignment: { name: 'Access package assignment' },
    entitlementManagementSettings: { name: 'Entitlement management setting' },
    agreement: { name: 'Terms of use' },
    appManagementPolicy: { name: 'App credential policy' },
    tenantAppManagementPolicy: { name: 'Default app credential rule' },
    multiTenantOrganization: { name: 'Multitenant organization' },
    b2xIdentityUserFlow: { name: 'Guest sign-up user flow' },
    identityApiConnector: { name: 'User flow API connector' },
    customAuthenticationExtension: { name: 'Custom authentication extension' },
    externalIdentitiesPolicy: { name: 'External user leave setting' },
    b2bManagementPolicy: { name: 'Guest invitation domain restriction' },
    servicePrincipalCreationPolicy: { name: 'App creation policy' },
    permissionGrantPreApprovalPolicy: { name: 'App permission pre-approval policy' },
    accessReviewPolicy: { name: 'Access review setting' },
    directoryRoleAccessReviewPolicy: { name: 'Admin role access review default' },
    multiTenantOrganizationIdentitySyncPolicyTemplate: { name: 'Multitenant organization sync template' },
    multiTenantOrganizationPartnerConfigurationTemplate: { name: 'Multitenant organization access template' },
    identityUserFlowAttribute: { name: 'User flow attribute' },
    authenticationEventListener: { name: 'Authentication event listener' },
    externalDomainFederation: { name: 'Guest SAML or WS-Fed sign-in' },
    crossTenantIdentitySyncPolicyPartner: { name: 'Cross-tenant sync partner' },
    synchronizationJob: { name: 'Provisioning or cross-tenant sync job' },
    accessPackageResourceRoleScope: { name: 'Access package resource role' },
    // Remaining kinds, batch 8.
    certificateBasedApplicationConfiguration: { name: 'App certificate authority trust' },
    signInIdentifier: { name: 'Sign-in identifier' },
    verifiedIdProfile: { name: 'Verified ID profile' },
    externalOriginResourceConnector: { name: 'Entitlement management outside connector' },
    lifecyclePolicy: { name: 'Lifecycle policy' },
    roleManagementCustomExtension: { name: 'PIM custom extension' },
    privilegedAccessGroupResource: { name: 'PIM managed group' },
    crossTenantM365Capability: { name: 'Default cross-tenant sharing setting' },
    entitlementManagementRoleAssignment: { name: 'Entitlement management role assignment' },
    deviceTemplate: { name: 'Device template' },
    sharedEmailDomain: { name: 'Shared email domain' },
    schemaExtension: { name: 'Schema extension' },
    // Remaining kinds, batch 9: Microsoft 365 admin center org settings and
    // Viva Engage communities (each has a Microsoft 365 group behind it).
    engageCommunity: { name: 'Viva Engage community' },
    profileCardProperty: { name: 'Profile card field' },
    pronounsSettings: { name: 'Pronouns setting' },
    adminReportSettings: { name: 'Usage report privacy setting' },
  }),
});
