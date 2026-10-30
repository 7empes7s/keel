/**
 * Wave 2 ENTRA: best-effort recreate of incomplete configurations.
 *
 * Design principle (coverage plan v3, 2026-10-14): an object KEEL can read but
 * not restore fully is backed up as an incomplete configuration. On restore
 * KEEL recreates it from what the backup holds, then lists every missing part
 * as a follow-up step: what is missing, why, the backed-up values a person
 * needs, and where in the admin center to do it.
 *
 * This module is the shared helper for that rule:
 *  - followUpSteps(): the steps for one backed-up object, from its
 *    completeness record (engine/coverage/completeness.mjs). A writer calls it
 *    after a recreate; a type with no writer gets the same steps plus one step
 *    for recreating the whole setting by hand (byHandSteps()).
 *  - recreateBody(): the create body built from what the backup holds, with
 *    server-owned fields and every value Microsoft never returns left out.
 *  - bestEffortCreate(): POST that body, read the object back, and return the
 *    applied entry with its follow-up steps. Writers in
 *    directoryPolicyOperations.mjs (and IDO's writers) use it for types that
 *    can only be written in part.
 *
 * Steps never carry a secret: a missing secret is named by its display name
 * and expiry only, which is what completeness.mjs extracts. Pure except
 * bestEffortCreate, which talks to the injected writer only.
 */
import { assessObject } from '../coverage/completeness.mjs';
import { createBodyProjection } from '../reconcile/writableProjection.mjs';

export const BEST_EFFORT_CONTRACT_VERSION = 1;

const ENTRA = 'Microsoft Entra admin center';
const INTUNE = 'Microsoft Intune admin center';
const M365 = 'Microsoft 365 admin center';
const EXCHANGE = 'Exchange admin center';
const DEFENDER = 'Microsoft Defender portal';
const SHAREPOINT = 'SharePoint admin center';
const TEAMS = 'Teams admin center';
const ENGAGE = 'Viva Engage';
const at = (center, ...steps) => [center, ...steps].join(' > ');

/**
 * Where a person finds each type in the admin centers. One entry per type that
 * can be incomplete; adminCenterPathFor() throws for any other type, so a new
 * incomplete type cannot ship without its path (the test walks the catalogue).
 */
export const ADMIN_CENTER_PATHS = Object.freeze({
  // tenant settings
  domain: at(M365, 'Settings', 'Domains'),
  groupSetting: at(ENTRA, 'Groups', 'General'),
  organizationalBranding: at(ENTRA, 'Company branding', 'Default sign-in experience'),
  organizationalBrandingLocalization: at(ENTRA, 'Company branding', 'Customize by browser language'),
  groupLifecyclePolicy: at(ENTRA, 'Groups', 'Expiration'),
  administrativeUnit: at(ENTRA, 'Roles & admins', 'Admin units'),
  // users, groups, apps and admin roles
  user: at(ENTRA, 'Users', 'All users'),
  contact: at(M365, 'Users', 'Contacts'),
  application: at(ENTRA, 'App registrations'),
  servicePrincipal: at(ENTRA, 'Enterprise apps', 'All applications'),
  oauth2PermissionGrant: at(ENTRA, 'Enterprise apps', 'All applications', '<app>', 'Permissions'),
  identityProvider: at(ENTRA, 'External Identities', 'All identity providers'),
  certificateBasedAuthConfiguration: at(ENTRA, 'Security', 'Certificate authorities'),
  roleEligibilitySchedule: at(ENTRA, 'Identity Governance', 'Privileged Identity Management', 'Microsoft Entra roles', 'Assignments', 'Eligible assignments'),
  roleAssignmentSchedule: at(ENTRA, 'Identity Governance', 'Privileged Identity Management', 'Microsoft Entra roles', 'Assignments', 'Active assignments'),
  unifiedRoleManagementPolicy: at(ENTRA, 'Identity Governance', 'Privileged Identity Management', 'Microsoft Entra roles', 'Settings'),
  accessReviewScheduleDefinition: at(ENTRA, 'Identity Governance', 'Access reviews'),
  accessPackage: at(ENTRA, 'Identity Governance', 'Entitlement management', 'Access packages'),
  connectedOrganization: at(ENTRA, 'Identity Governance', 'Entitlement management', 'Connected organizations'),
  lifecycleWorkflow: at(ENTRA, 'Identity Governance', 'Lifecycle workflows', 'Workflows'),
  lifecycleWorkflowCustomTaskExtension: at(ENTRA, 'Identity Governance', 'Lifecycle workflows', 'Custom extensions'),
  lifecycleManagementSettings: at(ENTRA, 'Identity Governance', 'Lifecycle workflows', 'Workflow settings'),
  attributeSet: at(ENTRA, 'Protection', 'Custom security attributes'),
  customSecurityAttributeDefinition: at(ENTRA, 'Protection', 'Custom security attributes', '<attribute set>'),
  accessPackageCatalog: at(ENTRA, 'Identity Governance', 'Entitlement management', 'Catalogs'),
  accessPackageAssignmentPolicy: at(ENTRA, 'Identity Governance', 'Entitlement management', 'Access packages', '<package>', 'Policies'),
  accessPackageAssignment: at(ENTRA, 'Identity Governance', 'Entitlement management', 'Access packages', '<package>', 'Assignments'),
  accessPackageResourceRoleScope: at(ENTRA, 'Identity Governance', 'Entitlement management', 'Access packages', '<package>', 'Resource roles'),
  entitlementManagementSettings: at(ENTRA, 'Identity Governance', 'Entitlement management', 'Settings'),
  agreement: at(ENTRA, 'Identity Governance', 'Terms of use'),
  b2xIdentityUserFlow: at(ENTRA, 'External Identities', 'User flows'),
  identityApiConnector: at(ENTRA, 'External Identities', 'API connectors'),
  customAuthenticationExtension: at(ENTRA, 'Identity', 'External Identities', 'Custom authentication extensions'),
  externalIdentitiesPolicy: at(ENTRA, 'External Identities', 'External collaboration settings'),
  b2bManagementPolicy: at(ENTRA, 'External Identities', 'External collaboration settings', 'Collaboration restrictions'),
  accessReviewPolicy: at(ENTRA, 'Identity Governance', 'Access reviews', 'Settings'),
  identityUserFlowAttribute: at(ENTRA, 'External Identities', 'Custom user attributes'),
  externalDomainFederation: at(ENTRA, 'External Identities', 'All identity providers'),
  // These have no page in the admin center; Microsoft Graph or PowerShell is
  // the only way to manage them.
  servicePrincipalCreationPolicy: 'Microsoft Graph: /policies/servicePrincipalCreationPolicies (beta, signed in with an admin role; no admin center page)',
  permissionGrantPreApprovalPolicy: 'Microsoft Graph: /policies/permissionGrantPreApprovalPolicies (beta, no admin center page)',
  directoryRoleAccessReviewPolicy: 'Microsoft Graph: /policies/directoryRoleAccessReviewPolicy (beta, no admin center page)',
  multiTenantOrganizationIdentitySyncPolicyTemplate: 'Microsoft Graph: /policies/crossTenantAccessPolicy/templates/multiTenantOrganizationIdentitySynchronization (no admin center page)',
  multiTenantOrganizationPartnerConfigurationTemplate: 'Microsoft Graph: /policies/crossTenantAccessPolicy/templates/multiTenantOrganizationPartnerConfiguration (no admin center page)',
  authenticationEventListener: 'Microsoft Graph: /identity/authenticationEventListeners, set per app with a custom authentication extension (no admin center page)',
  // Exchange and Defender admin roles (remaining kinds, batch 5).
  exchangeRoleDefinition: 'Exchange Online PowerShell: New-ManagementRole from the same parent role (no admin center page for custom roles)',
  exchangeRoleAssignment: at(EXCHANGE, 'Roles', 'Admin roles', '<role group>', 'Permissions'),
  exchangeCustomAppScope: 'Exchange Online PowerShell: New-ManagementScope (no admin center page)',
  defenderRoleDefinition: at(DEFENDER, 'System', 'Permissions', 'Microsoft Defender XDR', 'Roles'),
  defenderRoleAssignment: at(DEFENDER, 'System', 'Permissions', 'Microsoft Defender XDR', 'Roles', '<role>', 'Assignments'),
  defenderCustomAppScope: 'Microsoft Graph lists them at /roleManagement/defender/customAppScopes (beta) but cannot write them; no admin center page',
  synchronizationJob: at(ENTRA, 'Enterprise apps', '<app>', 'Provisioning'),
  // sign-in and security policies
  authenticationStrengthPolicy: at(ENTRA, 'Protection', 'Conditional Access', 'Authentication strengths'),
  authenticationContextClassReference: at(ENTRA, 'Protection', 'Conditional Access', 'Authentication contexts'),
  deviceRegistrationPolicy: at(ENTRA, 'Devices', 'Device settings'),
  permissionGrantPolicy: at(ENTRA, 'Enterprise apps', 'Consent and permissions', 'User consent settings'),
  // These policies have no page in the admin center; Microsoft Graph or
  // PowerShell is the only way to manage them.
  activityBasedTimeoutPolicy: 'Microsoft Graph: /policies/activityBasedTimeoutPolicies (no admin center page)',
  claimsMappingPolicy: 'Microsoft Graph: /policies/claimsMappingPolicies, assigned per enterprise app (no admin center page)',
  homeRealmDiscoveryPolicy: 'Microsoft Graph: /policies/homeRealmDiscoveryPolicies, assigned per enterprise app (no admin center page)',
  tokenIssuancePolicy: 'Microsoft Graph: /policies/tokenIssuancePolicies, assigned per app registration (no admin center page)',
  tokenLifetimePolicy: 'Microsoft Graph: /policies/tokenLifetimePolicies, assigned per app registration (no admin center page)',
  featureRolloutPolicy: at(ENTRA, 'Hybrid management', 'Microsoft Entra Connect', 'Connect Sync', 'Enable staged rollout'),
  appManagementPolicy: 'Microsoft Graph: /policies/appManagementPolicies, assigned per app (no admin center page)',
  tenantAppManagementPolicy: 'Microsoft Graph: /policies/defaultAppManagementPolicy (no admin center page)',
  multiTenantOrganization: at(ENTRA, 'External Identities', 'Multitenant organization'),
  crossTenantIdentitySyncPolicyPartner: at(ENTRA, 'External Identities', 'Cross-tenant access settings', '<organization>', 'Cross-tenant sync'),
  // Intune device management
  deviceConfiguration: at(INTUNE, 'Devices', 'Configuration'),
  configurationPolicy: at(INTUNE, 'Devices', 'Configuration'),
  deviceEnrollmentConfiguration: at(INTUNE, 'Devices', 'Enrollment', 'Device platform restriction'),
  deviceManagementRoleDefinition: at(INTUNE, 'Tenant administration', 'Roles', 'All roles'),
  deviceCategory: at(INTUNE, 'Devices', 'Device categories'),
  termsAndConditions: at(INTUNE, 'Tenant administration', 'Terms and conditions'),
  windowsAutopilotDeploymentProfile: at(INTUNE, 'Devices', 'Enrollment', 'Windows', 'Deployment profiles'),
  deviceManagementIntent: at(INTUNE, 'Endpoint security', 'Security baselines'),
  mobileApp: at(INTUNE, 'Apps', 'All apps'),
  managedAppPolicy: at(INTUNE, 'Apps', 'App protection policies'),
  targetedManagedAppConfiguration: at(INTUNE, 'Apps', 'App configuration policies', 'Managed apps'),
  mobileAppConfiguration: at(INTUNE, 'Apps', 'App configuration policies', 'Managed devices'),
  deviceManagementScript: at(INTUNE, 'Devices', 'Scripts and remediations', 'Platform scripts'),
  deviceShellScript: at(INTUNE, 'Devices', 'macOS', 'Shell scripts'),
  deviceHealthScript: at(INTUNE, 'Devices', 'Scripts and remediations', 'Remediations'),
  deviceComplianceScript: at(INTUNE, 'Devices', 'Compliance', 'Scripts'),
  assignmentFilter: at(INTUNE, 'Tenant administration', 'Filters'),
  roleScopeTag: at(INTUNE, 'Tenant administration', 'Roles', 'Scope tags'),
  windowsFeatureUpdateProfile: at(INTUNE, 'Devices', 'Windows updates', 'Feature updates'),
  windowsQualityUpdateProfile: at(INTUNE, 'Devices', 'Windows updates', 'Quality updates'),
  windowsDriverUpdateProfile: at(INTUNE, 'Devices', 'Windows updates', 'Driver updates'),
  groupPolicyConfiguration: at(INTUNE, 'Devices', 'Configuration', 'Templates', 'Administrative templates'),
  groupPolicyUploadedDefinitionFile: at(INTUNE, 'Devices', 'Configuration', 'Import ADMX'),
  notificationMessageTemplate: at(INTUNE, 'Devices', 'Compliance', 'Notifications'),
  windowsAutopilotDeviceIdentity: at(INTUNE, 'Devices', 'Enrollment', 'Windows', 'Devices'),
  deviceManagementRoleAssignment: at(INTUNE, 'Tenant administration', 'Roles', '<role>', 'Assignments'),
  applePushNotificationCertificate: at(INTUNE, 'Devices', 'Enrollment', 'Apple', 'Apple MDM Push certificate'),
  mobileThreatDefenseConnector: at(INTUNE, 'Tenant administration', 'Connectors and tokens', 'Mobile Threat Defense'),
  deviceManagementPartner: at(INTUNE, 'Tenant administration', 'Connectors and tokens', 'Partner device management'),
  complianceManagementPartner: at(INTUNE, 'Tenant administration', 'Connectors and tokens', 'Partner compliance management'),
  remoteAssistancePartner: at(INTUNE, 'Tenant administration', 'Remote help'),
  deviceManagementExchangeConnector: at(INTUNE, 'Tenant administration', 'Connectors and tokens', 'Exchange on-premises connector'),
  onPremisesConditionalAccessSettings: at(INTUNE, 'Tenant administration', 'Exchange on-premises access'),
  mobileAppCategory: at(INTUNE, 'Apps', 'App categories'),
  intuneBrandingProfile: at(INTUNE, 'Tenant administration', 'Customization'),
  deviceManagementCompliancePolicy: at(INTUNE, 'Devices', 'Compliance', 'Policies'),
  deviceManagementReusablePolicySetting: at(INTUNE, 'Endpoint security', 'Firewall', 'Reusable settings'),
  policySet: at(INTUNE, 'Devices', 'Policy sets'),
  vppToken: at(INTUNE, 'Tenant administration', 'Connectors and tokens', 'Apple VPP tokens'),
  depOnboardingSetting: at(INTUNE, 'Devices', 'Enrollment', 'Apple', 'Enrollment program tokens'),
  androidManagedStoreAccountEnterpriseSettings: at(INTUNE, 'Tenant administration', 'Connectors and tokens', 'Managed Google Play'),
  managedDeviceCleanupRule: at(INTUNE, 'Devices', 'Device cleanup rules'),
  windowsQualityUpdatePolicy: at(INTUNE, 'Devices', 'Windows updates', 'Quality updates'),
  operationApprovalPolicy: at(INTUNE, 'Tenant administration', 'Multi Admin Approval', 'Access policies'),
  deviceCustomAttributeShellScript: at(INTUNE, 'Devices', 'macOS', 'Custom attributes'),
  // Remaining kinds, batch 6: Intune leftovers.
  deviceManagementSettings: at(INTUNE, 'Endpoint security', 'Device compliance', 'Compliance settings'),
  androidDeviceOwnerEnrollmentProfile: at(INTUNE, 'Devices', 'Enrollment', 'Android', 'Corporate-owned devices'),
  androidForWorkEnrollmentProfile: at(INTUNE, 'Devices', 'Enrollment', 'Android'),
  appleUserInitiatedEnrollmentProfile: at(INTUNE, 'Devices', 'Enrollment', 'Apple', 'Enrollment types'),
  androidForWorkSettings: at(INTUNE, 'Devices', 'Enrollment', 'Android'),
  deviceManagementDerivedCredentialSettings: at(INTUNE, 'Tenant administration', 'Connectors and tokens', 'Derived credentials'),
  microsoftTunnelConfiguration: at(INTUNE, 'Tenant administration', 'Microsoft Tunnel Gateway', 'Server configurations'),
  microsoftTunnelHealthThreshold: at(INTUNE, 'Tenant administration', 'Microsoft Tunnel Gateway', 'Health status'),
  iosLobAppProvisioningConfiguration: at(INTUNE, 'Apps', 'iOS/iPadOS', 'App provisioning profiles'),
  mobileAppRelationship: at(INTUNE, 'Apps', 'All apps', '<app>', 'Properties', 'Dependencies'),
  managedEBook: at(INTUNE, 'Apps', 'eBooks'),
  managedEBookCategory: at(INTUNE, 'Apps', 'eBooks', 'eBook categories'),
  cartToClassAssociation: 'Intune for Education: Groups > <class> > Device carts (no Intune admin center page)',
  windowsManagedAppProtection: at(INTUNE, 'Apps', 'App protection policies'),
  enterpriseCodeSigningCertificate: at(INTUNE, 'Tenant administration', 'Connectors and tokens', 'Windows enterprise certificate'),
  symantecCodeSigningCertificate: at(INTUNE, 'Tenant administration', 'Connectors and tokens', 'Windows Symantec certificate'),
  userExperienceAnalyticsBaseline: at(INTUNE, 'Reports', 'Endpoint analytics', 'Settings', 'Baselines'),
  // Remaining kinds, batch 7: Microsoft 365 settings.
  sharepointSettings: at(SHAREPOINT, 'Settings'),
  itemInsightsSettings: at(M365, 'Settings', 'Org settings', 'Search and intelligence'),
  externalConnection: at(M365, 'Copilot', 'Connectors'),
  simulationAutomation: at(DEFENDER, 'Email and collaboration', 'Attack simulation training', 'Automations'),
  attackSimulation: at(DEFENDER, 'Email and collaboration', 'Attack simulation training', 'Simulations'),
  attackSimulationPayload: at(DEFENDER, 'Email and collaboration', 'Attack simulation training', 'Content library', 'Payloads'),
  attackSimulationLoginPage: at(DEFENDER, 'Email and collaboration', 'Attack simulation training', 'Content library', 'Login pages'),
  attackSimulationLandingPage: at(DEFENDER, 'Email and collaboration', 'Attack simulation training', 'Content library', 'Landing pages'),
  attackSimulationNotification: at(DEFENDER, 'Email and collaboration', 'Attack simulation training', 'Content library', 'End user notifications'),
  // Remaining kinds, batch 8: the last readable kinds.
  hardwareConfiguration: at(INTUNE, 'Devices', 'Windows', 'Configuration', 'BIOS configurations and other settings'),
  certificateBasedApplicationConfiguration: 'Microsoft Graph: /directory/certificateAuthorities/certificateBasedApplicationConfigurations (beta, no admin center page)',
  signInIdentifier: at(ENTRA, 'External Identities', 'All identity providers', 'Sign-in identifiers'),
  verifiedIdProfile: at(ENTRA, 'Verified ID', 'Verification profiles'),
  externalOriginResourceConnector: 'Microsoft Graph: /identityGovernance/entitlementManagement/externalOriginResourceConnectors (beta, no admin center page)',
  lifecyclePolicy: at(ENTRA, 'Identity Governance', 'Lifecycle workflows', 'Lifecycle policies'),
  roleManagementCustomExtension: at(ENTRA, 'Identity Governance', 'Privileged Identity Management', 'Custom extensions'),
  privilegedAccessGroupResource: at(ENTRA, 'Identity Governance', 'Privileged Identity Management', 'Groups'),
  crossTenantM365Capability: at(ENTRA, 'External Identities', 'Cross-tenant access settings', 'Default settings'),
  entitlementManagementRoleAssignment: at(ENTRA, 'Identity Governance', 'Entitlement management', 'Catalogs', '<catalog>', 'Roles and administrators'),
  deviceTemplate: 'Microsoft Graph: /templates/deviceTemplates (beta, no admin center page)',
  securityZone: at(DEFENDER, 'Exposure management', 'Settings', 'Zones'),
  sharedEmailDomain: 'Microsoft Graph: /directory/sharedEmailDomains (beta, no admin center page)',
  schemaExtension: 'Microsoft Graph: /schemaExtensions (no admin center page)',
  // Remaining kinds, batch 9: settings that only lacked a read permission.
  formsSettings: at(M365, 'Settings', 'Org settings', 'Microsoft Forms'),
  todoSettings: at(M365, 'Settings', 'Org settings', 'Microsoft To Do'),
  microsoft365AppsInstallationOptions: at(M365, 'Settings', 'Org settings', 'Microsoft 365 installation options'),
  appsAndServicesSettings: at(M365, 'Settings', 'Org settings', 'User owned apps and services'),
  adminReportSettings: at(M365, 'Settings', 'Org settings', 'Reports'),
  profileCardProperty: 'Microsoft Graph: /admin/people/profileCardProperties (PowerShell, no admin center page)',
  pronounsSettings: at(M365, 'Settings', 'Org settings', 'Pronouns'),
  defenderDetectionRule: at(DEFENDER, 'Investigation and response', 'Hunting', 'Custom detection rules'),
  teamsCatalogApp: at(TEAMS, 'Teams apps', 'Manage apps'),
  engageCommunity: at(ENGAGE, 'Communities'),
});

export function adminCenterPathFor(resourceType) {
  const path = ADMIN_CENTER_PATHS[resourceType];
  if (typeof path !== 'string') throw new Error(`${resourceType}: no admin center path; add one to ADMIN_CENTER_PATHS in engine/restore/bestEffortRecreate.mjs`);
  return path;
}

/**
 * The completion requirement a missing part maps to. The two app credential
 * parts keep the requirement names completion.mjs already uses, so a named
 * step replaces the generic item instead of duplicating it.
 */
const PART_REQUIREMENTS = Object.freeze({
  'Client secrets': 'passwordCredentials',
  Certificates: 'keyCredentials',
  'Client secret': 'clientSecret',
  'Password or certificate': 'connectorCredential',
});

// Parts that are a record only: nothing a person can set again.
const NOT_ACTIONABLE = new Set(['read-only', 'microsoft-managed']);

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const requirementFor = (part) => PART_REQUIREMENTS[part] ?? `followUp:${slug(part)}`;
const kindFor = (part) => {
  if (part.reason !== 'secret') return 'follow-up';
  return /certificate/i.test(part.part) && !/password/i.test(part.part) ? 'certificate' : 'credential';
};

const quote = (value) => `"${value}"`;
function itemWords(items) {
  return items.map((entry) => (entry.expires ? `${quote(entry.name)} (the backed-up one expires ${entry.expires})` : quote(entry.name))).join(', ');
}

function describe(part, items, portalPath) {
  const where = `in the ${portalPath}`;
  switch (part.reason) {
    case 'secret':
      return items
        ? `${part.part} cannot be restored because Microsoft never returns them. Create a new one for each of ${itemWords(items)} ${where}, then give it to every service that used the old one`
        : `${part.part} cannot be restored because Microsoft never returns it. Enter it again ${where}`;
    case 'other-route':
      return `${part.part} is stored separately and is not in the backup yet. Set it again ${where}`;
    case 'binary-route':
      return `${part.part} is a file the backup does not hold. Upload it again ${where}`;
    case 'read-only':
      return `${part.part} cannot be written back by any tool. Check it ${where}; it is a record only`;
    case 'microsoft-managed':
      return `${part.part} is set by Microsoft. Nothing to do; check it ${where}`;
    default:
      return `${part.part} is in the backup, but KEEL does not write it yet. Set it again by hand ${where}, using the backed-up values`;
  }
}

/**
 * The follow-up steps one backed-up object leaves after KEEL recreated or
 * restored it. `decision` is the type's qualification decision
 * ({ decision: 'automated' | 'manual' }). Each step:
 *   { kind, actionable, requirement, part, reason, why, values, portalPath, description }
 * `kind` is 'credential' or 'certificate' for a secret, otherwise 'follow-up';
 * `actionable` is false for a part that is a record only (history, a value
 * Microsoft sets).
 * `values` are the backed-up values the step needs (the secret names and
 * expiries, or the whole held body for a by-hand recreate), never a secret.
 */
export function followUpSteps(resourceType, payload, decision, options = {}) {
  const assessed = assessObject(resourceType, payload, decision, options);
  if (!assessed.incomplete) return [];
  const portalPath = adminCenterPathFor(resourceType);
  return assessed.missing.map((part) => {
    const whole = part.part === 'The whole setting';
    const items = part.items ?? null;
    return Object.freeze({
      kind: kindFor(part),
      actionable: !NOT_ACTIONABLE.has(part.reason),
      requirement: whole ? 'followUp:recreate-by-hand' : requirementFor(part.part),
      part: part.part,
      reason: part.reason,
      why: part.why,
      values: whole ? recreateBody(resourceType, payload) : items,
      portalPath,
      description: whole
        ? `KEEL does not write this setting yet. Recreate it by hand ${`in the ${portalPath}`}, using the backed-up values`
        : describe(part, items, portalPath),
    });
  });
}

/**
 * Steps for a type KEEL cannot write at all: recreate the whole setting by hand
 * from the backup, then the missing parts. Same as followUpSteps() for a
 * manual type; named for readers of a dry run.
 */
export function byHandSteps(resourceType, payload, decision, options = {}) {
  if (decision?.decision === 'automated') throw new Error(`${resourceType} has a writer; use followUpSteps after it runs`);
  return followUpSteps(resourceType, payload, decision, options);
}

// Fields the backup holds that are never part of a create body: identity and
// timestamps Graph assigns, and the credential arrays Microsoft returns without
// their secret values.
const NEVER_SENT = new Set([
  'id', 'createdDateTime', 'modifiedDateTime', 'lastModifiedDateTime', 'deletedDateTime', 'renewedDateTime',
  'passwordCredentials', 'keyCredentials',
]);

/**
 * The body a recreate sends: what the backup holds, minus server-owned fields
 * (the field projection), OData annotations, the NEVER_SENT fields and any
 * `exclude`d ones. Only `fields`, when given, are kept.
 */
export function recreateBody(resourceType, payload, { fields = null, exclude = [] } = {}) {
  let projected;
  try {
    projected = createBodyProjection(payload ?? {}, resourceType);
  } catch {
    projected = { ...(payload ?? {}) };
  }
  const skip = new Set([...NEVER_SENT, ...exclude]);
  const body = {};
  for (const [key, value] of Object.entries(projected)) {
    if (skip.has(key) || key.includes('@odata.')) continue;
    if (fields && !fields.includes(key)) continue;
    if (value === undefined) continue;
    body[key] = value;
  }
  return body;
}

/**
 * Creates one object from what the backup holds and reads it back.
 * `match(existing)` (optional) adopts an existing object instead of creating a
 * twin: a re-run after a create finds the object it made. Returns
 * { applied: { naturalKey, targetId, followUp } } or { failed }. The caller
 * runs its own guards and journal; this function writes exactly one POST.
 */
export async function bestEffortCreate(writer, resource, {
  path, version = 'v1.0', body, decision, match = null, retryOperation = (operation) => operation(),
}) {
  const { naturalKey, resourceType } = resource;
  const followUp = followUpSteps(resourceType, resource.payload, decision);
  if (match) {
    const listed = await retryOperation(() => writer.read(version, path));
    if (listed?.ok !== true) return { failed: { naturalKey, error: `could not list ${path} to look for an existing ${resourceType}: ${JSON.stringify(listed?.body ?? listed?.error ?? null)}` } };
    const existing = (listed.body?.value ?? []).filter(match);
    if (existing.length > 1) return { failed: { naturalKey, error: `${existing.length} existing ${resourceType} objects match the backup, so KEEL cannot tell which one to keep` } };
    if (existing.length === 1) return { applied: { naturalKey, targetId: existing[0].id ?? null, followUp, adopted: true } };
  }
  const created = await retryOperation(() => writer.write(version, path, { method: 'POST', body }));
  if (!created?.ok) return { failed: { naturalKey, error: JSON.stringify(created?.body ?? created?.error ?? null), status: created?.status }, result: created };
  return { applied: { naturalKey, targetId: created.body?.id ?? null, followUp }, created: created.body ?? null };
}
