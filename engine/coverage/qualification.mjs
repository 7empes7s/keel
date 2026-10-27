/**
 * Roadmap task-63: the per-operation qualification (fidelity) ledger.
 *
 * One explicit row per catalogue type × operation. It answers, from declared
 * evidence only:
 *  - can this operation be performed (the task-52 capability claim);
 *  - which credential performs it;
 *  - what happens to the object id;
 *  - why a retry is safe;
 *  - whether the operation needs reference remapping, and whether that
 *    remapping is proven;
 *  - what fixture and live evidence back the claim.
 *
 * Three rules, mirroring capabilities.mjs:
 *
 * 1. Every catalogue type has an EXPLICIT decision in TYPE_DECISIONS below:
 *    'automated' (writes registered in capabilities.mjs), 'manual' (recovery
 *    stays a refusal plus human steps until a writer exists). Each type also
 *    has a completeness record (completeness.mjs) giving its coverage state
 *    and what is missing. buildOperationLedger() throws if a catalogue type is
 *    missing, so a new type can never be silently treated as either.
 * 2. descriptor.remappable is NOT a write gate. Remapping is qualified per
 *    (resourceType, operation), and only where an operation actually rewrites
 *    a reference to a different id. A same-tenant update whose references
 *    resolve to the ids already in the payload remaps nothing and needs no
 *    remapping proof. A rewrite to a different id (a new object, another
 *    tenant) requires a recorded proof for exactly that operation.
 * 3. Nothing here can raise a claim. A decision label, a passing fixture
 *    harness run or a ledger row never changes capabilityFor(); only
 *    capabilities.mjs's explicit registration and qualifyLiveEvidence() can.
 */
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { COMPLETENESS, completenessFor } from './completeness.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { reviewStateFor } from '../contracts/fieldProjection.mjs';
import {
  EDGE_OPERATIONS, OPERATIONS, capabilityFor, edgeCapabilityKey, isSupportedClaim,
} from './capabilities.mjs';
import { WKLD_WRITE_OPERATIONS } from '../restore/workloads/writeDeclarations.mjs';

export const LEDGER_CONTRACT_VERSION = 1;
// Coverage plan v3: no type is left 'unknown'. A type with no writer is
// 'manual', and engine/coverage/completeness.mjs says what is missing and why.
export const TYPE_DECISION_VALUES = Object.freeze(['automated', 'manual']);

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const automated = (resource, reason, { view = 'graph-rest-1.0', liveFailures = null } = {}) => ({
  decision: 'automated', docs: `${DOCS}/resources/${resource}?view=${view}`, reason, ...(liveFailures ? { liveFailures: Object.freeze(liveFailures) } : {}),
});
const manual = (reason, extra = {}) => ({ decision: 'manual', reason, ...extra });
// Coverage plan v3 (package INCOMPLETE): read in full and backed up as an
// incomplete configuration; recreated by hand from the backup until a
// best-effort writer is registered (Wave 2).
const incomplete = (reason) => manual(`incomplete configuration, backed up in full and recreated by hand from the backup until a best-effort writer is registered: ${reason}`);
// Issue #148: a registered write that failed its live run. `reason` quotes the
// committed demotion record verbatim (tools/qualification/entraLive.mjs checks
// that), `failedAt` is the day it was decided and `fix` names what is being
// changed. The write stays fixture-tested; the ledger row shows the failure.
const failedLive = (failedAt, reason, fix) => Object.freeze({ failedAt, reason, fix });
// Issue #148: a registered write that cannot be proven live on the test tenant
// because of the tenant or the service, not a KEEL bug (the drift cannot be made,
// or no write is ever planned). Same shape, with no fix and no demotion record:
// the write stays fixture-tested and the ledger row says why it is unproven.
const tenantLimit = (failedAt, reason) => Object.freeze({ failedAt, reason, fix: null });
// Wave 2 ENTRA: the four token and sign-in routing policies share one writer.
const STS_SUBSET = 'Wave 2 ENTRA subset: create and update of the name and definition (every definition entry must parse as JSON); a policy that was the organization default is recreated as an ordinary one and making it the default again is a follow-up step; which apps it is assigned to is set by hand; delete is not registered';

/**
 * The explicit per-type decision. Reviewed by hand, never derived from
 * CATALOG paths, descriptor.remappable or a fixture result. `softRestoreCandidate`
 * marks types Graph can restore from deleted items. That is a candidate for
 * investigation, not a capability. `liveFailures` (issue #148) records, per
 * operation, a registered write whose live run on the test tenant failed and
 * why; it never lowers the claim and is removed once a fresh capture promotes
 * the operation.
 */
export const TYPE_DECISIONS = Object.freeze({
  organization: manual('the tenant object itself; it is never recreated'),
  domain: manual('requires DNS ownership verification outside Graph'),
  subscribedSku: manual('licences are purchased, not configured'),
  directorySettingTemplate: manual('Microsoft-published template catalogue'),
  // Issue #156: basic tenant settings.
  organizationalBranding: automated('organizationalbranding', 'issue-156 subset: update of the default sign-in page text, colours and layout; its logos, background image, favicon and custom stylesheet are backed up and uploaded back (fixture-tested, not yet live)'),
  organizationalBrandingLocalization: automated('organizationalbrandinglocalization', 'issue-156 subset: update of an existing language\'s sign-in page text, colours and layout; its images and stylesheet are backed up and uploaded back (fixture-tested, not yet live); adding or removing a language is by hand'),
  groupLifecyclePolicy: automated('grouplifecyclepolicy', 'issue-156 subset: update only when the restore makes group expiry less aggressive; a shorter lifetime, wider scope or a dropped renewal notice address could delete groups and is left to a person'),
  groupSetting: automated('groupsetting', 'task-109 subset: update and delete of tenant-wide settings only; the template is never written and a delete needs a complete snapshot observation'),
  user: automated('user', 'task-150 subset: update of reviewed attributes, soft-delete restore and add-only licences; Wave 2: a permanently deleted user is recreated disabled with a password nobody sees and a credentials checklist'),
  group: automated('group', 'create/update/delete/restore and member/owner edges are registered'),
  administrativeUnit: automated('administrativeunit', 'task-109 subset: update of displayName and description only; membership and scoped roles are not written'),
  contact: manual('organizational contacts are directory-synchronised and read-only in Graph'),
  application: automated('application', 'task-107 subset: create/update/restore-soft-deleted are registered; delete is not, and credentials are never written'),
  servicePrincipal: automated('serviceprincipal', 'task-107 subset: create bound to its application by appId; Wave 2: update of reviewed attributes and delete of an application\'s own service principal'),
  // Wave 2 ENTRA: written through engine/restore/directoryPolicyOperations.mjs.
  oauth2PermissionGrant: automated('oauth2permissiongrant', 'Wave 2 ENTRA subset: create and update of a delegated consent (scopes as the backup had them), matched on app, resource, consent type and user so a re-run never adds a second grant; delete is not registered'),
  identityProvider: manual('client secrets are never readable'),
  certificateBasedAuthConfiguration: incomplete('a wrong certificate trust setting can lock every user out, and there is no simulation gate for it yet'),
  directoryRole: manual('built-in roles are activated from templates, never authored'),
  roleDefinition: automated('unifiedroledefinition', 'task-151 subset: create and update of custom roles; built-in roles are immutable and refused, delete is not registered'),
  directoryRoleTemplate: manual('Microsoft-published template catalogue'),
  roleAssignment: automated('unifiedroleassignment', 'create/update/delete are registered', {
    liveFailures: {
      update: tenantLimit('2026-10-09', 'tenant limit: the runbook drift planned no write (Q43 step 36); every real field of a role assignment (principalId, roleDefinitionId, directoryScopeId) is immutable, so an update sends an empty body and reports not-remediable, and there is nothing it can change live'),
    },
  }),
  roleEligibilitySchedule: automated('unifiedroleeligibilityschedule', 'task-151 subset: create through an adminAssign schedule request that keeps the snapshot end date; update and removal are not registered'),
  // Roadmap task-151: PIM role settings, their role bindings and active schedules.
  unifiedRoleManagementPolicy: automated('unifiedrolemanagementpolicy', 'task-151 subset: update of the reviewed expiration, enablement and approval rules; a change that weakens protection is reported, never written'),
  unifiedRoleManagementPolicyAssignment: manual('Entra binds one settings policy to each role; the binding is read to name the role, never written'),
  roleAssignmentSchedule: incomplete('a time-bound active assignment needs the eligibility expiry contract plus a check that an activation is not replayed'),
  conditionalAccessPolicy: automated('conditionalaccesspolicy', 'create/update/delete/restore-soft-deleted are registered; writes land report-only, and turning a policy on is a separate approved step behind the break-glass lockout gate'),
  authenticationStrengthPolicy: automated('authenticationstrengthpolicy', 'task-108 subset: create/update of custom strengths only; built-in strengths are immutable and refused, delete is not registered'),
  namedLocation: automated('namedlocation', 'create/update/delete are registered'),
  authenticationContextClassReference: incomplete('ids c1..c99 are fixed per tenant and referenced by Conditional Access policies and SharePoint labels'),
  authenticationMethodsPolicy: automated('authenticationmethodspolicy', 'task-149: update of the policy and its method configurations, only behind the break-glass lockout gate'),
  identitySecurityDefaultsEnforcementPolicy: automated('identitysecuritydefaultsenforcementpolicy', 'task-149: update of isEnabled, only behind the break-glass lockout gate', {
    liveFailures: {
      update: tenantLimit('2026-10-14', 'tenant limit: Entra refuses to change security defaults while any Conditional Access policy is on (8 are on in the test tenant), so the drift cannot be made and the update cannot run live; turning every Conditional Access policy off is outside the test tenant rules (Q48 step 47)'),
    },
  }),
  authorizationPolicy: automated('authorizationpolicy', 'task-149: update of guest, consent and default user permission settings, only behind the break-glass lockout gate'),
  crossTenantAccessPolicy: automated('crosstenantaccesspolicy', 'task-149: update of allowedCloudEndpoints'),
  crossTenantAccessPolicyConfigurationDefault: automated('crosstenantaccesspolicyconfigurationdefault', 'task-149: update of the default B2B, direct connect and inbound trust settings'),
  crossTenantAccessPolicyPartner: automated('crosstenantaccesspolicyconfigurationpartner', 'task-149: create and update; delete is not registered'),
  permissionGrantPolicy: automated('permissiongrantpolicy', 'Wave 2 ENTRA subset: create and update of custom app consent policies, with their include and exclude rules when the backup holds them (missing ones added, extra ones removed); built-in microsoft-* policies are skipped; delete is not registered'),
  adminConsentRequestPolicy: automated('adminconsentrequestpolicy', 'task-149: update (PUT) of the whole policy'),
  // Issue #156.
  authenticationFlowsPolicy: automated('authenticationflowspolicy', 'issue-156: update of whether external users may sign themselves up through user flows', {
    liveFailures: {
      update: tenantLimit('2026-10-13', 'tenant limit: the test tenant refuses the self-service sign-up drift (500 AADB2C90063, Q43 and Q45 step 32), so there is no drift for the update to restore'),
    },
  }),
  deviceRegistrationPolicy: manual('backed up, never written: these settings decide who may register and join devices and whether joining needs MFA, so a wrong write could block admins from joining devices or silently drop the MFA requirement, so it is changed by hand', {
    docs: `${DOCS}/resources/deviceregistrationpolicy?view=graph-rest-1.0`,
  }),
  activityBasedTimeoutPolicy: incomplete('the definition string is not parsed and the app assignments are a separate edge not yet collected'),
  claimsMappingPolicy: automated('claimsmappingpolicy', STS_SUBSET),
  homeRealmDiscoveryPolicy: automated('homerealmdiscoverypolicy', STS_SUBSET),
  tokenIssuancePolicy: automated('tokenissuancepolicy', STS_SUBSET),
  tokenLifetimePolicy: automated('tokenlifetimepolicy', STS_SUBSET),
  featureRolloutPolicy: incomplete('the groups a rollout applies to are a separate edge not yet collected'),
  accessReviewScheduleDefinition: incomplete('past review instances and decisions cannot be recreated; only the definition can'),
  accessPackage: incomplete('its catalog, policies, assignments and resource roles are their own types, none of which has a writer yet'),
  connectedOrganization: incomplete('its sponsors are separate collections, and its identity sources point at tenants that cannot be checked from this one'),
  // Wave 1 CAT-ENTRA: Entra governance types, backed up in full with no writer yet.
  lifecycleWorkflow: automated('identitygovernance-workflow', 'Wave 2: created switched off with its tasks, updated in place or as a new version; a restore never switches a workflow on'),
  lifecycleWorkflowCustomTaskExtension: automated('identitygovernance-customtaskextension', 'Wave 2: create and update; the Logic App it calls is checked by hand'),
  lifecycleManagementSettings: automated('identitygovernance-lifecyclemanagementsettings', 'Wave 2: update in place'),
  attributeSet: automated('attributeset', 'Wave 2: update only; an attribute set can never be deleted once created, so a create needs a review step'),
  customSecurityAttributeDefinition: automated('customsecurityattributedefinition', 'Wave 2: update, and allowed values added or switched off; a definition can never be deleted once created, so a create needs a review step'),
  accessPackageCatalog: automated('accesspackagecatalog', 'Wave 2: create and update; the resources a catalog holds are a separate collection not yet collected'),
  accessPackageAssignmentPolicy: incomplete('a policy belongs to an access package, which has no writer yet'),
  accessPackageAssignment: incomplete('an assignment is granted through a request against its policy, never copied'),
  entitlementManagementSettings: automated('entitlementmanagementsettings', 'Wave 2: update in place'),
  agreement: incomplete('the agreement documents are files on a separate route, and acceptances cannot be recreated'),
  appManagementPolicy: automated('appmanagementpolicy', 'Wave 2: create and update; the apps a policy applies to are a separate edge not yet collected'),
  tenantAppManagementPolicy: incomplete('a stricter default can block every app from adding a secret or certificate, so an update needs a review step'),
  multiTenantOrganization: automated('multitenantorganization', 'Wave 2: update of name and description; member tenants and their acceptance are never written'),
  b2xIdentityUserFlow: incomplete('the languages, attributes and API connector bindings of a flow are separate collections not yet collected'),
  identityApiConnector: incomplete('the connector password or certificate is never returned'),
  // Read per parent object.
  accessPackageResourceRoleScope: incomplete('a resource role is added through a request once its resource is in the catalog, and access packages have no writer yet'),
  synchronizationJob: incomplete('its schema is a separate collection, its credentials are never returned, and a started job writes accounts in another directory'),
  crossTenantIdentitySyncPolicyPartner: incomplete('it lets a partner tenant sync its users into this one, so an update needs a review step'),
  // Issue #155: the first Intune restore subset. Every other Intune type is
  // manual by decision, with its reason; none is left unknown.
  deviceConfiguration: automated('intune-deviceconfig-deviceconfiguration', 'issue-155 subset: create and update with assignments; profiles that carry credentials or certificates (Wi-Fi, VPN, certificate, email) and any value Graph never returns stay manual'),
  deviceCompliancePolicy: automated('intune-deviceconfig-devicecompliancepolicy', 'issue-155 subset: create (with its actions for noncompliance) and update with assignments; Wave 2: delete of a policy that is no longer assigned'),
  configurationPolicy: automated('intune-deviceconfigv2-devicemanagementconfigurationpolicy', 'issue-155 subset: create and update of the whole policy and its settings, with assignments, through Graph beta (the settings catalog has no v1.0 API); secret settings stay manual', { view: 'graph-rest-beta' }),
  deviceEnrollmentConfiguration: manual('the default enrollment restrictions exist in every tenant and cannot be created, and custom ones are ordered through a separate priority action KEEL does not write; restore by hand from the backup, which includes their assignments'),
  deviceManagementRoleDefinition: manual('Intune admin roles decide who can manage devices: a change needs a privilege review; their role assignments are backed up separately'),
  deviceCategory: automated('intune-shared-devicecategory', 'restore gaps batch 1: create and update of the name and description; which devices are in a category is set at enrollment and is not restored'),
  termsAndConditions: manual('acceptance by users cannot be recreated: a recreated policy asks every user to accept again'),
  windowsAutopilotDeploymentProfile: automated('intune-enrollment-windowsautopilotdeploymentprofile', 'restore gaps batch 6: create and update of the profile through Graph beta, keeping its kind; the registered devices it applies to are not backed up, and who it is assigned to is written one assignment at a time (batch 15)', { view: 'graph-rest-beta' }),
  deviceManagementIntent: manual('security baseline intents are beta-only and replaced by the settings catalog, and their settings are a separate collection that is not backed up'),
  managedDevice: manual('device state, enrolled by the device, not configuration'),
  mobileApp: automated('intune-apps-mobileapp', 'restore gaps batch 18: create and update of store, web, Microsoft 365 Apps, Edge and WinGet apps with their assignments; Win32 and line-of-business apps are recreated without their package and unassigned until it is uploaded; apps synced from Apple, Google or Microsoft are never created'),
  managedAppPolicy: automated('intune-mam-managedapppolicy', 'Wave 2: iOS and Android app protection create, update and delete; a create needs the protected apps in the backup (read per policy from restore gaps batch 13); other kinds stay manual'),
  targetedManagedAppConfiguration: automated('intune-mam-targetedmanagedappconfiguration', 'Wave 2: create, update and delete; a create needs the targeted apps in the backup (read per configuration from restore gaps batch 13)'),
  mobileAppConfiguration: automated('intune-apps-manageddevicemobileappconfiguration', 'Wave 2: create, update and delete when the apps it targets exist in the target; values Graph never returns stay manual'),
  // Wave 1 CAT-INTUNE: backed up read-only; no writer is built yet.
  // Restore gaps batch 4: the script body is read per script, so the script itself is restored.
  deviceManagementScript: automated('intune-shared-devicemanagementscript', 'restore gaps batch 4: create and update of the script and its settings through Graph beta; a backup without the script body is refused; batch 14: who it runs on is assigned again through /assign', { view: 'graph-rest-beta' }),
  deviceShellScript: automated('intune-devices-deviceshellscript', 'restore gaps batch 4: create and update of the script and its settings through Graph beta; a backup without the script body is refused; batch 14: who it runs on is assigned again through /assign', { view: 'graph-rest-beta' }),
  deviceHealthScript: automated('intune-devices-devicehealthscript', 'restore gaps batch 4: create and update of the detection and remediation scripts and their settings through Graph beta; Microsoft-published remediations are never written; batch 14: who it runs on, its schedule and whether its fix runs are assigned again through /assign', { view: 'graph-rest-beta' }),
  deviceComplianceScript: automated('intune-devices-devicecompliancescript', 'restore gaps batch 4: create and update of the discovery script and its settings through Graph beta, before the compliance policies that use it; a backup without the script body is refused; batch 14: who it runs on is assigned again through /assign', { view: 'graph-rest-beta' }),
  assignmentFilter: automated('intune-policyset-deviceandappmanagementassignmentfilter', 'Wave 2: create and update through Graph beta; the platform is never changed', { view: 'graph-rest-beta' }),
  roleScopeTag: automated('intune-rbac-rolescopetag', 'Wave 2: create and update through Graph beta; the built-in Default tag is never written', { view: 'graph-rest-beta' }),
  windowsFeatureUpdateProfile: automated('intune-softwareupdate-windowsfeatureupdateprofile', 'Wave 2: create, update and delete through Graph beta; restore gaps batch 14: assignments through /assign', { view: 'graph-rest-beta' }),
  windowsQualityUpdateProfile: automated('intune-softwareupdate-windowsqualityupdateprofile', 'Wave 2: create, update and delete through Graph beta; restore gaps batch 14: assignments through /assign', { view: 'graph-rest-beta' }),
  windowsDriverUpdateProfile: automated('intune-softwareupdate-windowsdriverupdateprofile', 'Wave 2: create, update and delete through Graph beta; driver approvals are not backed up; restore gaps batch 14: assignments through /assign', { view: 'graph-rest-beta' }),
  // Restore gaps batch 5: the values of each setting are read per setting, so the template is restored with them.
  groupPolicyConfiguration: automated('intune-grouppolicy-grouppolicyconfiguration', 'restore gaps batch 5: create and update of the template, its settings and the values entered for them through Graph beta; every setting it uses must exist in the target; a backup without the setting values is refused; issue #472: the settings are read per template, and a backup whose settings came through $expand (which returns none) is refused; batch 14: who it is assigned to is assigned again through /assign', { view: 'graph-rest-beta' }),
  groupPolicyUploadedDefinitionFile: automated('intune-grouppolicy-grouppolicyuploadeddefinitionfile', 'restore gaps batch 11: create of the imported ADMX file with its ADML language files through Graph beta; a backup without the file content is refused; the settings in it get new ids, so templates that used them are set up again', { view: 'graph-rest-beta' }),
  notificationMessageTemplate: automated('intune-notification-notificationmessagetemplate', 'Wave 2: create and update with the message text per language'),
  windowsAutopilotDeviceIdentity: manual('the hardware hash is never returned, so a registration is imported again from the device'),
  deviceManagementRoleAssignment: manual('Intune admin access needs a privilege review before it is granted again'),
  // Remaining kinds, batch 1: backed up read-only; no writer is built yet.
  applePushNotificationCertificate: manual('the certificate is renewed with Apple under the same Apple ID; no tool can upload it from a backup'),
  mobileThreatDefenseConnector: manual('no writer yet; a connector is set up from the partner\'s console'),
  deviceManagementPartner: manual('no writer yet; a partner connection is set up from the partner\'s console'),
  complianceManagementPartner: manual('no writer yet; a partner connection is set up from the partner\'s console'),
  remoteAssistancePartner: manual('no writer yet; the partner onboarding is completed in the partner\'s console'),
  deviceManagementExchangeConnector: manual('the connector is installed on an Exchange server, not configured through Graph'),
  onPremisesConditionalAccessSettings: automated('intune-onboarding-onpremisesconditionalaccesssettings', 'restore gaps batch 17: update in place of whether it is on and which groups it covers; a restore never turns it on'),
  mobileAppCategory: automated('intune-apps-mobileappcategory', 'restore gaps batch 6: create and update of the tenant\'s own categories; built-in categories are Microsoft-managed and never written'),
  intuneBrandingProfile: automated('intune-shared-intunebrandingprofile', 'restore gaps batch 9: create and update of a branding profile other than the default through Graph beta; logo images are not written; batch 14: who it is assigned to is assigned again through /assign; batch 17: the default profile is updated in place (never created)', { view: 'graph-rest-beta' }),
  customAuthenticationExtension: manual('no writer yet; the endpoint\'s own sign-in settings are checked by hand'),
  // Remaining kinds, batch 3: Intune tenant settings, backed up read-only; no writer is built yet.
  deviceManagementCompliancePolicy: automated('intune-deviceconfigv2-devicemanagementcompliancepolicy', 'restore gaps batch 7: create and update of the policy with its settings and actions for noncompliance through Graph beta; batch 15: who it is assigned to is assigned again through /assign', { view: 'graph-rest-beta' }),
  deviceManagementReusablePolicySetting: automated('intune-deviceconfigv2-devicemanagementreusablepolicysetting', 'restore gaps batch 1: create and update through Graph beta, before the settings catalog policies that use it; its setting definition is never changed', { view: 'graph-rest-beta' }),
  policySet: automated('intune-policyset-policyset', 'restore gaps batch 6: create and update of the set and the apps and policies in it through Graph beta; each must exist in the target with the same id; batch 16: who it is assigned to is assigned again through the set\'s update action', { view: 'graph-rest-beta' }),
  vppToken: manual('Apple issues the token; no tool can upload it from a backup'),
  depOnboardingSetting: manual('Apple issues the token; no tool can upload it from a backup'),
  androidManagedStoreAccountEnterpriseSettings: manual('the binding is made by signing in to Google; no tool can make it from a backup'),
  managedDeviceCleanupRule: automated('intune-devices-manageddevicecleanuprule', 'restore gaps batch 1: update through Graph beta, only when it makes the rule wait as long or longer before retiring devices; a deleted rule is recreated by hand', { view: 'graph-rest-beta' }),
  windowsQualityUpdatePolicy: automated('intune-softwareupdate-windowsqualityupdatepolicy', 'restore gaps batch 1: create and update through Graph beta; who it is assigned to is not backed up yet', { view: 'graph-rest-beta' }),
  operationApprovalPolicy: manual('approval rules need a person to review them before they are set again'),
  deviceCustomAttributeShellScript: automated('intune-devices-devicecustomattributeshellscript', 'restore gaps batch 5: create and update of the script and its settings through Graph beta; a backup without the script body is refused; batch 15: who it runs on is assigned again through /assign', { view: 'graph-rest-beta' }),
  // Remaining kinds, batch 4: Entra ID tenant settings, backed up read-only; restore gaps batch 2 writes the singletons.
  externalIdentitiesPolicy: automated('externalidentitiespolicy', 'restore gaps batch 2: update in place through Graph beta of whether external users can leave and whether their data is removed', { view: 'graph-rest-beta' }),
  b2bManagementPolicy: automated('b2bmanagementpolicy', 'restore gaps batch 3: update in place through Graph beta of the guest invitation domain lists (the definition); a deleted policy is set again by hand', { view: 'graph-rest-beta' }),
  servicePrincipalCreationPolicy: manual('no writer yet; beta only, and the include and exclude conditions are read per policy'),
  permissionGrantPreApprovalPolicy: automated('permissiongrantpreapprovalpolicy', 'restore gaps batch 3: create and update through Graph beta of the pre-approved conditions; which app it is assigned to is not backed up yet', { view: 'graph-rest-beta' }),
  accessReviewPolicy: automated('accessreviewpolicy', 'restore gaps batch 2: update in place through Graph beta of whether group owners manage access reviews', { view: 'graph-rest-beta' }),
  directoryRoleAccessReviewPolicy: automated('directoryroleaccessreviewpolicy', 'restore gaps batch 2: update in place through Graph beta of the default settings of admin role access reviews', { view: 'graph-rest-beta' }),
  multiTenantOrganizationIdentitySyncPolicyTemplate: automated('multitenantorganizationidentitysyncpolicytemplate', 'restore gaps batch 2: update in place; the template only affects tenants that join later'),
  multiTenantOrganizationPartnerConfigurationTemplate: automated('multitenantorganizationpartnerconfigurationtemplate', 'restore gaps batch 2: update in place; the template only affects tenants that join later'),
  identityUserFlowAttribute: manual('no writer yet; built-in attributes are Microsoft-managed'),
  authenticationEventListener: manual('no writer yet; it points to a custom authentication extension, which is not restored yet'),
  externalDomainFederation: automated('samlorwsfedexternaldomainfederation', 'restore gaps batch 3: update in place of the federation settings and public signing certificate; its domains are not backed up yet, so a deleted federation is set up again by hand'),
  // Remaining kinds, batch 5: Exchange and Defender admin roles, backed up read-only; no writer is built yet.
  exchangeRoleDefinition: manual('no writer yet; beta only, and built-in roles are Microsoft-managed'),
  exchangeRoleAssignment: manual('Exchange admin access needs a privilege review before it is granted again'),
  exchangeCustomAppScope: automated('customappscope', 'restore gaps batch 9: create and update of the name and recipient filter through Graph beta; the app role assignments that use it are not written', { view: 'graph-rest-beta' }),
  defenderRoleDefinition: manual('no writer yet; beta only'),
  defenderRoleAssignment: manual('Defender admin access needs a privilege review before it is granted again'),
  defenderCustomAppScope: manual('no writer yet; beta only'),
  // Remaining kinds, batch 6: Intune leftovers, backed up read-only; no writer is built yet.
  deviceManagementSettings: automated('intune-shared-devicemanagement', 'restore gaps batch 17: update in place through Graph beta of the compliance settings; devices with no compliance policy are never turned compliant; the device cleanup window is the device cleanup rules', { view: 'graph-rest-beta' }),
  androidDeviceOwnerEnrollmentProfile: automated('intune-androidforwork-androiddeviceownerenrollmentprofile', 'restore gaps batch 10: create and update of the profile through Graph beta; the enrollment token, QR code and Wi-Fi password are not backed up, so a profile on a secured Wi-Fi network is recreated by hand', { view: 'graph-rest-beta' }),
  androidForWorkEnrollmentProfile: automated('intune-androidforwork-androidforworkenrollmentprofile', 'restore gaps batch 10: create and update of the name and description through Graph beta; a recreated profile gets a new enrollment token by hand', { view: 'graph-rest-beta' }),
  appleUserInitiatedEnrollmentProfile: automated('intune-enrollment-appleuserinitiatedenrollmentprofile', 'restore gaps batch 8: create and update of the profile through Graph beta; its place in the priority order and who it is assigned to are set again by hand', { view: 'graph-rest-beta' }),
  androidForWorkSettings: manual('the binding is made by signing in to Google; no tool can make it from a backup'),
  deviceManagementDerivedCredentialSettings: manual('no writer yet; beta only, and the issuer is set up with the partner first'),
  microsoftTunnelConfiguration: automated('intune-mstunnel-microsofttunnelconfiguration', 'restore gaps batch 8: create and update of the network, DNS, routes and port through Graph beta; the sites and servers that use it are not written', { view: 'graph-rest-beta' }),
  microsoftTunnelHealthThreshold: automated('intune-mstunnel-microsofttunnelhealththreshold', 'restore gaps batch 17: update in place through Graph beta of the healthy and unhealthy limits; the defaults are Microsoft\'s', { view: 'graph-rest-beta' }),
  iosLobAppProvisioningConfiguration: automated('intune-apps-ioslobappprovisioningconfiguration', 'restore gaps batch 12: create and update of the name, description, scope tags and profile file through Graph beta; a backup without the file, an expired file, or one older than the live profile is never written; batch 16: who it is assigned to is assigned again through /assign', { view: 'graph-rest-beta' }),
  mobileAppRelationship: automated('intune-apps-mobileapprelationship', 'restore gaps batch 13: create and update of a dependency or supersedence between two apps through Graph beta; both apps must already be in Intune', { view: 'graph-rest-beta' }),
  managedEBook: manual('no writer yet; beta only, and books come from the store'),
  managedEBookCategory: automated('intune-books-managedebookcategory', 'restore gaps batch 8: create and update of the name through Graph beta; which books are in a category is not written', { view: 'graph-rest-beta' }),
  cartToClassAssociation: automated('intune-education-carttoclassassociation', 'restore gaps batch 10: create and update of the name, description, devices and classes through Graph beta; the devices and classes must still exist', { view: 'graph-rest-beta' }),
  windowsManagedAppProtection: automated('intune-mam-windowsmanagedappprotection', 'restore gaps batch 12: create and update of the policy and the apps it covers through Graph beta; a create needs the apps in the backup (read per policy from batch 12); batch 15: who it is assigned to is assigned again through /assign', { view: 'graph-rest-beta' }),
  enterpriseCodeSigningCertificate: manual('no writer yet; beta only'),
  symantecCodeSigningCertificate: manual('the certificate file and its password are secrets and are not backed up'),
  userExperienceAnalyticsBaseline: automated('intune-devices-userexperienceanalyticsbaseline', 'restore gaps batch 10: create and update of the name of a custom baseline through Graph beta; built-in baselines are Microsoft-managed and never written', { view: 'graph-rest-beta' }),
  // Remaining kinds, batch 7: Microsoft 365 settings, backed up read-only; no writer is built yet.
  sharepointSettings: automated('sharepointsettings', 'restore gaps batch 17: update in place of the settings other than sharing (the SharePoint workload restores those); a restore never turns legacy authentication on, lets unmanaged devices sync or drops the guest account match'),
  itemInsightsSettings: manual('no writer yet'),
  externalConnection: manual('no writer yet; the schema and items are read per connection'),
  simulationAutomation: manual('no writer yet; automations are created in the Defender portal'),
  attackSimulation: manual('no writer yet; a simulation is launched again, not restored'),
  // Remaining kinds, batch 8: the last readable kinds, backed up read-only; no writer is built yet.
  hardwareConfiguration: automated('intune-deviceconfig-hardwareconfiguration', 'restore gaps batch 11: update in place of the name, description, scope tags and per-device password setting through Graph beta; per-device BIOS passwords are never turned off; the settings file is not backed up, so a deleted configuration is imported again by hand', { view: 'graph-rest-beta' }),
  certificateBasedApplicationConfiguration: manual('no writer yet; beta only'),
  signInIdentifier: manual('no writer yet; beta only'),
  verifiedIdProfile: manual('no writer yet; beta only'),
  externalOriginResourceConnector: manual('no writer yet; beta only'),
  lifecyclePolicy: manual('no writer yet; beta only'),
  roleManagementCustomExtension: manual('no writer yet; the Logic App address is not backed up'),
  privilegedAccessGroupResource: manual('no writer yet; beta only'),
  crossTenantM365Capability: manual('no writer yet; beta only'),
  entitlementManagementRoleAssignment: manual('no writer yet; beta only, listed one role at a time'),
  deviceTemplate: manual('no writer yet; beta only'),
  securityZone: manual('no writer yet; beta only'),
  sharedEmailDomain: manual('no writer yet; beta only'),
  schemaExtension: manual('no writer yet; only extensions owned by this tenant\'s apps are read'),
});

// Why a retried operation can never double-apply — each names the mechanism in
// applyEngine.mjs / relationshipWriter.mjs that makes it so.
const IDEMPOTENCY = Object.freeze({
  create: 'natural-key reconciled: the target is re-collected before every run, so an existing object is updated, never re-created',
  update: 'full-state PATCH verified by read-back; repeating it converges',
  delete: 'verified by a read-back 404; an already-absent object is a no-op',
  'restore-soft-deleted': 'verified present after restore; an already-restored object takes the update path',
  'edge-add': 'precondition read; an ambiguous outcome is re-read, never re-sent',
  'edge-remove': 'precondition read; an ambiguous outcome is re-read, never re-sent',
});

// Which operations ever rewrite references in their payload (applyEngine.mjs's
// rewriteReferences call sites). Delete and edge operations write no payload.
const REWRITES_REFERENCES = new Set(['create', 'update', 'restore-soft-deleted']);

// resourceType -> Map<operation, { proofRef }>
const REMAPPING_PROOFS = new Map();

/**
 * Records that rewriting references to a DIFFERENT id has been proven for
 * exactly this (resourceType, operation), through the production applyWave
 * path. A proof for one operation never covers another.
 */
export function recordRemappingProof(resourceType, operation, proofRef) {
  if (!REWRITES_REFERENCES.has(operation)) {
    throw new TypeError(`${resourceType} ${operation}: this operation writes no references, so there is nothing to remap`);
  }
  if (!isSupportedClaim(capabilityFor(resourceType, operation).claim)) {
    throw new Error(`${resourceType} ${operation}: remapping proof requires a registered write capability first`);
  }
  if (typeof proofRef !== 'string' || proofRef.length === 0) {
    throw new TypeError(`${resourceType} ${operation}: remapping proof requires a proofRef`);
  }
  if (!REMAPPING_PROOFS.has(resourceType)) REMAPPING_PROOFS.set(resourceType, new Map());
  REMAPPING_PROOFS.get(resourceType).set(operation, Object.freeze({ proofRef }));
}

/** The remapping qualification applyWave consults when a rewrite changes an id. */
export function remappingFor(resourceType, operation) {
  if (!REWRITES_REFERENCES.has(operation)) return Object.freeze({ requirement: 'none', qualified: true, proofRef: null });
  const proof = REMAPPING_PROOFS.get(resourceType)?.get(operation) ?? null;
  return Object.freeze({ requirement: 'when-a-reference-id-changes', qualified: proof !== null, proofRef: proof?.proofRef ?? null });
}

// Remapping proven against the production applyWave path. Each proofRef names
// the test that rewrites a reference to a different target id for exactly this
// operation and asserts the written payload carries it.
recordRemappingProof('group', 'create', 'engine/restore/applyPatches.test.mjs');
recordRemappingProof('roleAssignment', 'create', 'engine/restore/applyEngine.test.mjs');
recordRemappingProof('conditionalAccessPolicy', 'create', 'cli/keel-restore.test.mjs');
recordRemappingProof('conditionalAccessPolicy', 'update', 'engine/roadmap/fidelity-ledger.test.mjs');
// Roadmap task-107: a service principal created for an application recreated in
// the same run carries that application's NEW appId (EXPLICIT_REFERENCES below).
recordRemappingProof('servicePrincipal', 'create', 'engine/roadmap/fidelity-expansion.test.mjs');
// Roadmap task-151: an eligibility whose group or custom role was recreated in
// the same run is requested for the NEW principal and role ids.
recordRemappingProof('roleEligibilitySchedule', 'create', 'engine/roadmap/admin-role-fidelity.test.mjs');

function sourceFor(type, decision) {
  const entry = CATALOG.find((candidate) => candidate.type === type);
  return Object.freeze({
    graphPath: entry?.path ?? null,
    apiVersion: entry?.version ?? null,
    docs: decision.docs ?? null,
  });
}

/** The row's live evidence: a qualified record, a recorded live failure (issue #148), or nothing. */
function liveFor(capability, failure) {
  if (capability.claim === 'live-qualified') return { result: 'qualified', proofRef: capability.proofRef };
  if (failure) return { result: 'failed', proofRef: null, failedAt: failure.failedAt, reason: failure.reason, fix: failure.fix ?? null };
  return { result: 'none', proofRef: null };
}

function rowFor(resourceType, operation, { capabilityKey = resourceType, decision }) {
  const capability = capabilityFor(capabilityKey, operation);
  const supported = isSupportedClaim(capability.claim);
  const remapping = supported ? remappingFor(capabilityKey, operation) : null;
  return Object.freeze({
    resourceType: capabilityKey,
    operation,
    // A row is 'supported' only through a registered capability; otherwise the
    // type's explicit decision ('manual') stands for the operation.
    decision: supported ? 'supported' : decision.decision === 'automated' ? 'unsupported' : decision.decision,
    claim: capability.claim,
    credentialMode: capability.credentialMode,
    idOutcome: capability.idOutcome,
    idempotency: supported ? IDEMPOTENCY[operation] : null,
    remapping,
    fieldClassification: reviewStateFor(resourceType),
    fixture: capability.claim === 'fixture-tested' || capability.claim === 'live-qualified'
      ? { result: 'passed', proofRef: capability.claim === 'fixture-tested' ? capability.proofRef : null }
      : { result: 'none', proofRef: null },
    live: liveFor(capability, decision.liveFailures?.[operation]),
    softRestoreCandidate: operation === 'restore-soft-deleted' && decision.softRestoreCandidate === true && !supported,
  });
}

/**
 * The full ledger: every catalogue type (and every collecting descriptor) ×
 * OPERATIONS, plus the registered relationship edge operations. Throws when
 * any type lacks an explicit decision.
 */
export function buildOperationLedger({ decisions = TYPE_DECISIONS } = {}) {
  const types = [...new Set([...CATALOG.map((entry) => entry.type), ...DESCRIPTORS.map((descriptor) => descriptor.type)])];
  const missing = types.filter((type) => !decisions[type]);
  if (missing.length > 0) throw new Error(`no explicit qualification decision for: ${missing.join(', ')}`);
  for (const [type, decision] of Object.entries(decisions)) {
    if (!TYPE_DECISION_VALUES.includes(decision.decision)) throw new Error(`${type}: invalid decision ${decision.decision}`);
  }
  const extraRecords = Object.keys(COMPLETENESS).filter((type) => !types.includes(type));
  if (extraRecords.length > 0) throw new Error(`completeness records for types not in the catalogue: ${extraRecords.join(', ')}`);

  const rows = types.map((type) => {
    const decision = decisions[type];
    const operations = OPERATIONS.map((operation) => rowFor(type, operation, { decision }));
    if (decision.decision === 'automated') {
      // A type marked automated must actually have at least one registered
      // operation; the label alone proves nothing.
      if (!operations.some((row) => row.decision === 'supported')) {
        throw new Error(`${type} is marked automated but has no registered write capability`);
      }
    } else if (operations.some((row) => row.decision === 'supported')) {
      throw new Error(`${type} has a registered write capability but is marked ${decision.decision}`);
    }
    // A live failure can only be recorded against a registered write; a note
    // left behind after a registration is removed would describe nothing.
    for (const [operation, failure] of Object.entries(decision.liveFailures ?? {})) {
      if (!operations.some((row) => row.operation === operation && row.decision === 'supported')) {
        throw new Error(`${type}: liveFailures.${operation} names an operation that is not a registered write`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(failure?.failedAt ?? '') || typeof failure.reason !== 'string' || failure.reason.length === 0) {
        throw new Error(`${type}: liveFailures.${operation} needs a failedAt date and a reason`);
      }
    }
    return Object.freeze({
      resourceType: type,
      decision: decision.decision,
      reason: decision.reason,
      softRestoreCandidate: decision.softRestoreCandidate === true,
      completeness: completenessFor(type, decision),
      source: sourceFor(type, decision),
      operations: Object.freeze(operations),
    });
  });

  const edges = ['member', 'owner'].flatMap((family) => EDGE_OPERATIONS.map((operation) => rowFor('group', operation, {
    capabilityKey: edgeCapabilityKey('group', family), decision: decisions.group,
  })));

  return Object.freeze({ contractVersion: LEDGER_CONTRACT_VERSION, types: Object.freeze(rows), edges: Object.freeze(edges) });
}

/** The type's completeness without the per-object item extractors (safe to serialise). */
function plainCompleteness(resourceType, decision) {
  const { state, recreate, missing, why } = completenessFor(resourceType, decision);
  return Object.freeze({
    state, recreate, ...(why ? { why } : {}),
    missing: Object.freeze(missing.map((item) => Object.freeze({ part: item.part, reason: item.reason, perObject: typeof item.items === 'function' }))),
  });
}

/** The compact per-type decision the coverage report and portal show. */
export function qualificationFor(resourceType, { decisions = TYPE_DECISIONS } = {}) {
  const decision = decisions[resourceType];
  if (!decision) return Object.freeze({ decision: 'unknown', reason: 'no explicit decision recorded', softRestoreCandidate: false, remapping: {} });
  const remapping = {};
  for (const operation of REWRITES_REFERENCES) {
    if (isSupportedClaim(capabilityFor(resourceType, operation).claim)) remapping[operation] = remappingFor(resourceType, operation).qualified;
  }
  return Object.freeze({
    decision: decision.decision,
    reason: decision.reason,
    softRestoreCandidate: decision.softRestoreCandidate === true,
    remapping: Object.freeze(remapping),
    // Coverage plan v3: the coverage state and the parts a restore cannot bring back.
    completeness: plainCompleteness(resourceType, decision),
    // Roadmap task-107: the type's expansion batch and its derived restore scope.
    expansion: expansionFor(resourceType),
  });
}

/**
 * Roadmap task-103: workload configuration WRITES, qualified per operation.
 *
 * These are not catalogue types and never enter TYPE_DECISIONS or the Entra
 * capability registry. Each declared write is disabled until:
 *  - the read it verifies through is enabled in the task-101 workload ledger
 *    (live-qualified, grants confirmed); and
 *  - a non-synthetic live write capture from THIS tenant, at the version in use,
 *    no older than 30 days, wrote the setting and read it back.
 * A fixture run proves the code path only: it yields `fixture-tested`, which is
 * still disabled. Nothing here sends a request.
 */
export const WORKLOAD_WRITE_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// SharePoint REST writes on a site (gap 4). The version is the REST API itself, not a
// Graph version; a capture records the same string.
export const SHAREPOINT_REST_VERSION = 'sharepoint-rest';
const SHAREPOINT_REST_DOCS = 'https://learn.microsoft.com/en-us/sharepoint/dev/sp-add-ins';
function sharePointSitePermissionWrite(id, name, endpoint, fields) {
  return {
    [id]: Object.freeze({
      workload: 'sharepoint-site-settings',
      resourceType: 'sharepointSitePermission',
      name,
      method: 'POST',
      endpoint,
      version: SHAREPOINT_REST_VERSION,
      readBack: 'sharepoint.site-permissions',
      fields: Object.freeze([...fields]),
      rbac: Object.freeze({ permissions: ['Sites.FullControl.All'], roles: [] }),
      source: id === 'sharepoint.site-role-definitions.add' || id === 'sharepoint.site-role-assignments.add'
        ? `${SHAREPOINT_REST_DOCS}/set-custom-permissions-on-a-list-by-using-the-rest-interface`
        : 'https://learn.microsoft.com/en-us/previous-versions/office/developer/sharepoint-rest-reference/dn531432(v=office.15)',
    }),
  };
}

export const WORKLOAD_WRITE_OPERATIONS = Object.freeze({
  'sharepoint.tenant-settings.update': Object.freeze({
    workload: 'sharepoint-site-settings',
    resourceType: 'sharepointTenantSettings',
    method: 'PATCH',
    endpoint: '/admin/sharepoint/settings',
    version: 'v1.0',
    readBack: 'sharepoint.tenant-settings',
    fields: Object.freeze([
      'sharingCapability', 'sharingDomainRestrictionMode', 'sharingAllowedDomainList', 'sharingBlockedDomainList',
      'isResharingByExternalUsersEnabled',
    ]),
    rbac: Object.freeze({ permissions: ['SharePointTenantSettings.ReadWrite.All'], roles: ['SharePoint Administrator'] }),
    source: `${DOCS}/sharepointsettings-update?view=graph-rest-1.0`,
  }),
  // Gap 5 (site permissions audit, 2026-10-15): site app grants (Sites.Selected).
  // Add re-creates a grant missing since the backup; update raises a grant's role
  // back to the backup's. Neither ever grants more than the backup held, and KEEL
  // never removes a grant. Each has its own proof.
  'sharepoint.site-permissions.add': Object.freeze({
    workload: 'sharepoint-site-settings',
    resourceType: 'sharepointSiteAppGrant',
    method: 'POST',
    endpoint: '/sites/{site-id}/permissions',
    version: 'v1.0',
    readBack: 'sharepoint.site-permissions',
    fields: Object.freeze(['roles', 'grantedToIdentities']),
    rbac: Object.freeze({ permissions: ['Sites.FullControl.All'], roles: [] }),
    source: `${DOCS}/site-post-permissions?view=graph-rest-1.0`,
  }),
  'sharepoint.site-permissions.update': Object.freeze({
    workload: 'sharepoint-site-settings',
    resourceType: 'sharepointSiteAppGrant',
    method: 'PATCH',
    endpoint: '/sites/{site-id}/permissions/{permission-id}',
    version: 'v1.0',
    readBack: 'sharepoint.site-permissions',
    fields: Object.freeze(['roles']),
    rbac: Object.freeze({ permissions: ['Sites.FullControl.All'], roles: [] }),
    source: `${DOCS}/site-update-permission?view=graph-rest-1.0`,
  }),
  // Gap 4 (site permissions audit, 2026-10-15): SharePoint groups, members, site
  // collection admins, permission levels and role assignments, through SharePoint
  // REST as the Restorer (SharePoint Online Sites.FullControl.All). Each only adds
  // what the content backup's `site/permissions` item holds: KEEL never removes a
  // member, admin or role, or changes an existing group or permission level.
  // `name` is the plain-English name docs/coverage.md uses; the read-back gate is
  // the site permissions read, and the capture reads each write back through REST.
  ...sharePointSitePermissionWrite('sharepoint.site-role-definitions.add', 'SharePoint custom permission levels', '/_api/web/roledefinitions', ['Name', 'Description', 'Order', 'BasePermissions']),
  ...sharePointSitePermissionWrite('sharepoint.site-groups.add', 'SharePoint site groups', '/_api/web/sitegroups', [
    'Title', 'Description', 'AllowMembersEditMembership', 'AllowRequestToJoinLeave', 'AutoAcceptRequestToJoinLeave',
    'OnlyAllowMembersViewMembership', 'RequestToJoinLeaveEmailSetting']),
  ...sharePointSitePermissionWrite('sharepoint.site-group-members.add', 'SharePoint site group members', '/_api/web/sitegroups/getbyid({group-id})/users', ['LoginName']),
  ...sharePointSitePermissionWrite('sharepoint.site-admins.add', 'SharePoint site collection admins', '/_api/web/siteusers/getbyid({user-id})', ['IsSiteAdmin']),
  ...sharePointSitePermissionWrite('sharepoint.site-role-assignments.add', 'SharePoint role assignments on sites and lists',
    '/_api/web/roleassignments/addroleassignment(principalid={principal-id},roledefid={role-id})', []),
  // Roadmap task-104: Teams settings and structural membership. Each is its own
  // operation with its own proof. `requires` names the SharePoint write: Teams
  // activates only after SharePoint is qualified, and SharePoint proof is never
  // Teams proof (evidence counts only for the operationId it names).
  'teams.settings.update': Object.freeze({
    workload: 'teams-settings',
    resourceType: 'teamsTeamSettings',
    method: 'PATCH',
    endpoint: '/teams/{team-id}',
    version: 'v1.0',
    readBack: 'teams.settings',
    fields: Object.freeze(['memberSettings', 'guestSettings', 'messagingSettings', 'funSettings', 'discoverySettings']),
    rbac: Object.freeze({ permissions: ['TeamSettings.ReadWrite.All'], roles: [] }),
    requires: Object.freeze(['sharepoint.tenant-settings.update']),
    source: `${DOCS}/team-update?view=graph-rest-1.0`,
  }),
  'teams.membership.add': Object.freeze({
    workload: 'teams-settings',
    resourceType: 'teamsMembership',
    method: 'POST',
    endpoint: '/teams/{team-id}/members',
    version: 'v1.0',
    readBack: 'teams.membership',
    fields: Object.freeze(['roles']),
    rbac: Object.freeze({ permissions: ['TeamMember.ReadWrite.All'], roles: [] }),
    requires: Object.freeze(['sharepoint.tenant-settings.update']),
    source: `${DOCS}/team-post-members?view=graph-rest-1.0`,
  }),
  'teams.membership.update': Object.freeze({
    workload: 'teams-settings',
    resourceType: 'teamsMembership',
    method: 'PATCH',
    endpoint: '/teams/{team-id}/members/{membership-id}',
    version: 'v1.0',
    readBack: 'teams.membership',
    fields: Object.freeze(['roles']),
    rbac: Object.freeze({ permissions: ['TeamMember.ReadWrite.All'], roles: [] }),
    requires: Object.freeze(['sharepoint.tenant-settings.update']),
    source: `${DOCS}/team-update-members?view=graph-rest-1.0`,
  }),
  'teams.membership.remove': Object.freeze({
    workload: 'teams-settings',
    resourceType: 'teamsMembership',
    method: 'DELETE',
    endpoint: '/teams/{team-id}/members/{membership-id}',
    version: 'v1.0',
    readBack: 'teams.membership',
    fields: Object.freeze([]),
    rbac: Object.freeze({ permissions: ['TeamMember.ReadWrite.All'], roles: [] }),
    requires: Object.freeze(['sharepoint.tenant-settings.update']),
    source: `${DOCS}/team-delete-members?view=graph-rest-1.0`,
  }),
  // Roadmap task-105: Exchange mailbox and organization configuration. Four
  // distinct operations, each with its own proof. Every one requires the Teams
  // settings write first (which itself requires SharePoint), and every one needs
  // the restorer's grants OBSERVED (`grantsRequired`): unknown RBAC blocks the write.
  // Cmdlet writes are bound to the ExchangeOnlineManagement version in use.
  'exchange.mailbox-settings.update': Object.freeze({
    workload: 'exchange-mailbox-settings',
    resourceType: 'exchangeMailboxSettings',
    method: 'PATCH',
    endpoint: '/users/{user-id}/mailboxSettings',
    version: 'v1.0',
    readBack: 'exchange.mailbox-settings',
    fields: Object.freeze(['automaticRepliesSetting', 'timeZone', 'language', 'workingHours', 'dateFormat', 'timeFormat', 'delegateMeetingMessageDeliveryOptions']),
    rbac: Object.freeze({ permissions: ['MailboxSettings.ReadWrite'], roles: [] }),
    grantsRequired: true,
    requires: Object.freeze(['teams.settings.update']),
    source: `${DOCS}/user-update-mailboxsettings?view=graph-rest-1.0`,
  }),
  'exchange.client-access.update': Object.freeze({
    workload: 'exchange-mailbox-settings',
    resourceType: 'exchangeClientAccess',
    kind: 'cmdlet',
    method: 'Set-CASMailbox',
    module: 'ExchangeOnlineManagement',
    readBack: 'exchange.client-access',
    fields: Object.freeze(['OWAEnabled', 'ActiveSyncEnabled', 'PopEnabled', 'ImapEnabled', 'MAPIEnabled', 'EwsEnabled', 'SmtpClientAuthenticationDisabled']),
    rbac: Object.freeze({ permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] }),
    grantsRequired: true,
    requires: Object.freeze(['teams.settings.update']),
    source: 'https://learn.microsoft.com/en-us/powershell/module/exchange/set-casmailbox',
  }),
  'exchange.mailbox-retention.update': Object.freeze({
    workload: 'exchange-mailbox-settings',
    resourceType: 'exchangeMailboxRetention',
    kind: 'cmdlet',
    method: 'Set-Mailbox',
    module: 'ExchangeOnlineManagement',
    readBack: 'exchange.mailbox-hold',
    fields: Object.freeze(['LitigationHoldEnabled', 'RetentionHoldEnabled', 'SingleItemRecoveryEnabled', 'RetainDeletedItemsFor']),
    rbac: Object.freeze({ permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] }),
    grantsRequired: true,
    requires: Object.freeze(['teams.settings.update']),
    source: 'https://learn.microsoft.com/en-us/powershell/module/exchange/set-mailbox',
  }),
  'exchange.organization-config.update': Object.freeze({
    workload: 'exchange-mailbox-settings',
    resourceType: 'exchangeOrganizationConfig',
    kind: 'cmdlet',
    method: 'Set-OrganizationConfig',
    module: 'ExchangeOnlineManagement',
    readBack: 'exchange.organization-config',
    // Allowlist of one (gap W7): the large-audience mail tip threshold. Every other
    // organization setting is observed and left to an administrator.
    fields: Object.freeze(['MailTipsLargeAudienceThreshold']),
    rbac: Object.freeze({ permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] }),
    grantsRequired: true,
    requires: Object.freeze(['teams.settings.update']),
    source: 'https://learn.microsoft.com/en-us/powershell/module/exchange/set-organizationconfig',
  }),
  // Roadmap task-106: Purview sensitivity label configuration. Two operations, each
  // with its own proof. They run in the Security & Compliance session of the same
  // module, so they require the Exchange cmdlet write first (which requires Teams,
  // then SharePoint); Exchange proof is never Purview proof. Only display text and
  // adding a label to a policy are writable: nothing KEEL writes can weaken a label's
  // protection or unpublish a label. No OneDrive write is declared.
  'purview.label.update': Object.freeze({
    workload: 'purview-labels',
    resourceType: 'purviewLabel',
    kind: 'cmdlet',
    method: 'Set-Label',
    module: 'ExchangeOnlineManagement',
    readBack: 'purview.label-definitions',
    fields: Object.freeze(['DisplayName', 'Tooltip', 'Comment']),
    rbac: Object.freeze({ permissions: ['Exchange.ManageAsApp'], roles: ['Compliance Administrator'] }),
    grantsRequired: true,
    requires: Object.freeze(['exchange.client-access.update']),
    source: 'https://learn.microsoft.com/en-us/powershell/module/exchange/set-label',
  }),
  'purview.label-policy.update': Object.freeze({
    workload: 'purview-labels',
    resourceType: 'purviewLabelPolicy',
    kind: 'cmdlet',
    method: 'Set-LabelPolicy',
    module: 'ExchangeOnlineManagement',
    readBack: 'purview.label-publication',
    fields: Object.freeze(['AddLabels']),
    rbac: Object.freeze({ permissions: ['Exchange.ManageAsApp'], roles: ['Compliance Administrator'] }),
    grantsRequired: true,
    requires: Object.freeze(['exchange.client-access.update']),
    source: 'https://learn.microsoft.com/en-us/powershell/module/exchange/set-labelpolicy',
  }),
  // Wave 2 WKLD: mail flow, Exchange settings, Teams org-wide and voice policies,
  // Purview retention, DLP and retention labels (restore/workloads/writeDeclarations.mjs).
  ...WKLD_WRITE_OPERATIONS,
});

/** The version a write runs under now: its Graph version, or its module's version. */
function writeVersion(declared, runtime) {
  if (declared.kind === 'cmdlet') return runtime?.modules?.[declared.module] ?? null;
  return declared.version;
}

function writeEvidenceProblems(item, { tenantRef, version, now }) {
  const problems = [];
  if (item.synthetic !== false) problems.push('synthetic evidence (a fixture run) is never live qualification');
  if (item.kind !== 'live-write-capture') problems.push(`${item.kind ?? 'unlabelled'} evidence is not a live write capture`);
  if (!tenantRef || item.tenantRef !== tenantRef) problems.push('captured in a different tenant, or no tenant was named');
  const at = Date.parse(item.capturedAt ?? '');
  if (Number.isNaN(at)) problems.push('no capture time');
  else if (at > now.getTime()) problems.push('captured in the future');
  else if (now.getTime() - at > WORKLOAD_WRITE_EVIDENCE_MAX_AGE_MS) problems.push('older than 30 days');
  if (version === null) problems.push('the version in use now is unknown');
  else if (item.version !== version) problems.push(`captured at version ${item.version ?? 'unknown'}, not ${version}`);
  if (item.ok !== true) problems.push('the write failed');
  if (item.readBackVerified !== true) problems.push('the write was not read back and verified');
  return problems;
}

/**
 * Whether one workload write may run. `readLedger` is the task-101 ledger;
 * `evidence` is every fixture result and write capture for this operation.
 */
/**
 * `runtime.modules` gives the module versions in use now (a cmdlet write is bound
 * to its module version). `grants` is what the RESTORER app is observed to hold
 * ({ permissions, roles }); a write declared `grantsRequired` stays disabled while
 * it is unknown or short of the declared RBAC.
 */
export function workloadWriteQualification(operationId, { readLedger = null, evidence = [], tenantRef = null, now = new Date(), runtime = {}, grants = null, _seen = new Set() } = {}) {
  const declared = WORKLOAD_WRITE_OPERATIONS[operationId];
  if (!declared) {
    return Object.freeze({ operationId, state: 'undeclared', enabled: false, reasons: [`${operationId} is not a declared workload write`], proof: { fixture: null, live: null } });
  }
  const mine = evidence.filter((item) => item.operationId === operationId);
  const fixture = mine.find((item) => item.kind === 'fixture' && item.ok === true) ?? null;
  const reasons = [];
  let live = null;
  for (const item of mine.filter((candidate) => candidate.kind !== 'fixture')) {
    const problems = writeEvidenceProblems(item, { tenantRef, version: writeVersion(declared, runtime), now });
    if (problems.length === 0) { live = item; break; }
    reasons.push(`${item.proofRef ?? 'capture'}: ${problems.join('; ')}`);
  }
  const readRow = (readLedger?.rows ?? []).find((row) => row.id === declared.readBack) ?? null;
  const readEnabled = readRow?.enabled === true && (!tenantRef || readLedger?.tenantRef === tenantRef);
  if (!readEnabled) reasons.push(`${declared.readBack} (the read-back) is ${readRow?.state ?? 'not in the ledger'}, not enabled for this tenant`);
  // A prerequisite workload write must itself be enabled. Its proof is evaluated
  // for its own operationId and never transfers to this one.
  let prerequisitesEnabled = true;
  for (const required of declared.requires ?? []) {
    if (_seen.has(required)) throw new Error(`${operationId}: circular workload write prerequisite ${required}`);
    const prerequisite = workloadWriteQualification(required, { readLedger, evidence, tenantRef, now, runtime, grants, _seen: new Set([..._seen, operationId]) });
    if (!prerequisite.enabled) {
      prerequisitesEnabled = false;
      reasons.push(`${required} must be live-qualified first (it is ${prerequisite.state})`);
    }
  }

  // Task-105: unknown RBAC blocks a write that declares it needs observed grants.
  let grantsSatisfied = true;
  if (declared.grantsRequired) {
    if (!grants || !Array.isArray(grants.permissions) || !Array.isArray(grants.roles)) {
      grantsSatisfied = false;
      reasons.push('the restorer\'s grants are unknown; its permissions and roles must be observed before this write');
    } else {
      const missing = [
        ...declared.rbac.permissions.filter((name) => !grants.permissions.includes(name)),
        ...declared.rbac.roles.filter((name) => !grants.roles.includes(name)),
      ];
      if (missing.length) {
        grantsSatisfied = false;
        reasons.push(`the restorer lacks ${missing.join(', ')}`);
      }
    }
  }

  let state;
  if (live) state = 'live-qualified';
  else if (fixture) { state = 'fixture-tested'; reasons.push('fixture proof only: a live write capture from this tenant is required'); }
  else { state = 'disabled'; reasons.push('no proof yet'); }
  return Object.freeze({
    operationId,
    state,
    enabled: state === 'live-qualified' && readEnabled && prerequisitesEnabled && grantsSatisfied,
    reasons: Object.freeze(reasons),
    proof: Object.freeze({
      fixture: fixture ? { proofRef: fixture.proofRef ?? null } : null,
      live: live ? { proofRef: live.proofRef ?? null, capturedAt: live.capturedAt } : null,
    }),
  });
}

// ---------------------------------------------------------------------------
// Roadmap task-107: measured Entra operation expansion batches.
//
// Every catalogue type is placed in exactly one batch with an explicit status:
//   qualified-subset — at least one operation is registered in capabilities.mjs
//                      (derived from the registry, never declared here);
//   manual           — recovery is a human step by design (TYPE_DECISIONS);
//   unsupported      — no Graph write route exists for the configuration;
//   research-needed  — a route may exist but its API, permission or safety
//                      contract has not been checked for KEEL.
// A non-qualified entry must name the API and permission reason. A status can
// never be raised by editing this table: buildExpansionInventory() throws when
// an entry claims more than the registry proves, and an entry carries no
// "restorable" flag at all — the restore scope is derived from registered
// operations only.

export const EXPANSION_CONTRACT_VERSION = 1;
export const EXPANSION_STATUSES = Object.freeze(['qualified-subset', 'manual', 'unsupported', 'research-needed']);

export const EXPANSION_BATCHES = Object.freeze([
  Object.freeze({ id: 'identity-application', label: 'Identity and applications', task: 'task-107' }),
  Object.freeze({ id: 'policy', label: 'Policies', task: 'task-108' }),
  Object.freeze({ id: 'administrative-configuration', label: 'Administrative configuration', task: 'task-109' }),
  // Intune is not an Entra family; it is accounted for here so no catalogue type
  // is silently left out, and no Entra batch is responsible for it.
  Object.freeze({ id: 'device-management', label: 'Device management (Intune, outside the Entra batches)', task: null }),
]);

const APP_RW = 'Application.ReadWrite.All (restorer); not verified as granted to the KEEL Restorer';
const research = (batch, api, permission, reason) => ({ batch, status: 'research-needed', api, permission, reason });
const notWritable = (batch, api, permission, reason) => ({ batch, status: 'unsupported', api, permission, reason });
const byHand = (batch, api, permission, reason) => ({ batch, status: 'manual', api, permission, reason });
const subset = (batch, api, permission, reason) => ({ batch, status: 'qualified-subset', api, permission, reason });

/**
 * The reviewed inventory. `api` names the Graph route a write would use (null
 * when none exists); `permission` names the least privilege a writer would need.
 * Documentation was not re-fetched in the task-107 session (learn.microsoft.com
 * is blocked from the build container), so every route here is a declaration
 * to confirm before any live qualification — see docs/roadmap/fidelity-expansion.md.
 */
export const EXPANSION_INVENTORY = Object.freeze({
  // ---- identity and applications (task-107)
  application: subset('identity-application', 'POST /applications; PATCH /applications/{id}; POST /directory/deletedItems/{id}/restore', APP_RW,
    'create, update and soft-delete restore are fixture-tested; delete is refused; secrets and certificates are never written and a recreate opens credential completion items'),
  servicePrincipal: subset('identity-application', 'POST /servicePrincipals; PATCH /servicePrincipals/{id}; DELETE /servicePrincipals/{id}', APP_RW,
    'create is fixture-tested and takes the appId of its application (remapped when the application was recreated); update of reviewed attributes and delete of an application\'s own service principal are fixture-tested; soft-delete restore is not qualified'),
  user: subset('identity-application', 'PATCH /users/{id}; POST /directory/deletedItems/{id}/restore; POST /users/{id}/assignLicense; POST /users', 'User.ReadWrite.All',
    'update of reviewed attributes, soft-delete restore, add-only licence assignment and a disabled recreate with a credentials checklist are fixture-tested; synced and guest users are refused'),
  group: subset('identity-application', 'POST/PATCH/DELETE /groups', 'Group.ReadWrite.All', 'registered before task-107'),
  contact: byHand('identity-application', null, 'none', 'organizational contacts are directory-synchronised and read-only in Graph'),
  oauth2PermissionGrant: subset('identity-application', 'POST /oauth2PermissionGrants; PATCH /oauth2PermissionGrants/{id}', 'DelegatedPermissionGrant.ReadWrite.All',
    'create and update are fixture-tested; a grant is written only inside an approved restore, matched on app, resource, consent type and user, and its scopes are written as backed up; delete is refused'),
  identityProvider: byHand('identity-application', 'POST /identity/identityProviders', 'IdentityProvider.ReadWrite.All', 'client secrets are never readable'),
  certificateBasedAuthConfiguration: research('identity-application', 'POST /organization/{id}/certificateBasedAuthConfiguration', 'Organization.ReadWrite.All',
    'tenant-lockout blast radius; no simulation gate for certificate trust changes exists'),
  directoryRole: byHand('identity-application', 'POST /directoryRoles (activate from template)', 'RoleManagement.ReadWrite.Directory', 'built-in roles are activated from templates, never authored'),
  // Roadmap task-151: the admin role model. Records, routes and the rule
  // review live in engine/restore/adminRoleOperations.mjs.
  roleDefinition: subset('identity-application', 'POST /roleManagement/directory/roleDefinitions; PATCH /roleManagement/directory/roleDefinitions/{id}', 'RoleManagement.ReadWrite.Directory',
    'create and update of custom roles are fixture-tested; the dry run lists the resource actions a write adds and removes; built-in roles are immutable and refused; delete is refused; Graph refuses a custom role without an Entra ID P1 or P2 licence'),
  directoryRoleTemplate: byHand('identity-application', null, 'none', 'Microsoft-published template catalogue'),
  roleAssignment: subset('identity-application', 'POST/DELETE /roleManagement/directory/roleAssignments', 'RoleManagement.ReadWrite.Directory', 'registered before task-107'),
  roleEligibilitySchedule: subset('identity-application', 'POST /roleManagement/directory/roleEligibilityScheduleRequests', 'RoleEligibilitySchedule.ReadWrite.Directory',
    'create (adminAssign with a justification) is fixture-tested and keeps the snapshot end date; an expired or group-inherited eligibility is not restored; an existing one is matched by principal, role and scope and never requested twice; update and removal are refused'),
  unifiedRoleManagementPolicy: subset('identity-application', 'PATCH /policies/roleManagementPolicies/{id}/rules/{ruleId}', 'RoleManagementPolicy.ReadWrite.Directory',
    'update of the expiration, enablement and approval rules is fixture-tested; a change that weakens protection is withheld as a manual step; approvers must exist; policies are never created or deleted'),
  unifiedRoleManagementPolicyAssignment: byHand('identity-application', null, 'none', 'Entra binds one settings policy to each role; the binding is read to name the role, never written'),
  roleAssignmentSchedule: research('identity-application', 'POST /roleManagement/directory/roleAssignmentScheduleRequests', 'RoleAssignmentSchedule.ReadWrite.Directory',
    'active time-bound assignments; permanent ones are restored as roleAssignment, and a time-bound restore needs the same request and expiry contract as eligibility plus a check that an activation is not replayed'),
  accessReviewScheduleDefinition: research('identity-application', 'POST /identityGovernance/accessReviews/definitions', 'AccessReview.ReadWrite.All',
    'review history and decisions cannot be recreated; only the definition could be'),
  accessPackage: research('identity-application', 'POST /identityGovernance/entitlementManagement/accessPackages', 'EntitlementManagement.ReadWrite.All',
    'depends on its catalog, policies and resource roles, none of which is restored yet'),
  connectedOrganization: research('identity-application', 'POST /identityGovernance/entitlementManagement/connectedOrganizations', 'EntitlementManagement.ReadWrite.All',
    'identity sources reference external tenants that cannot be verified from this tenant'),
  // Wave 1 CAT-ENTRA: backed up; no write is qualified yet.
  lifecycleWorkflow: subset('identity-application', 'POST /identityGovernance/lifecycleWorkflows/workflows; PATCH .../{id}; POST .../{id}/createNewVersion', 'LifecycleWorkflows.ReadWrite.All',
    'create (switched off) and update are fixture-tested; switching a workflow on is always left to a person'),
  lifecycleWorkflowCustomTaskExtension: subset('identity-application', 'POST /identityGovernance/lifecycleWorkflows/customTaskExtensions; PATCH .../{id}', 'LifecycleWorkflows.ReadWrite.All',
    'create and update are fixture-tested; the Logic App it calls cannot be verified from this tenant'),
  lifecycleManagementSettings: subset('identity-application', 'PATCH /identityGovernance/lifecycleWorkflows/settings', 'LifecycleWorkflows.ReadWrite.All',
    'update of the tenant singleton is fixture-tested'),
  attributeSet: subset('identity-application', 'PATCH /directory/attributeSets/{id}', 'CustomSecAttributeDefinition.ReadWrite.All',
    'update is fixture-tested; attribute sets cannot be deleted once created, so a create needs a review step that does not exist yet'),
  customSecurityAttributeDefinition: subset('identity-application', 'PATCH /directory/customSecurityAttributeDefinitions/{id}; POST/PATCH .../{id}/allowedValues', 'CustomSecAttributeDefinition.ReadWrite.All',
    'update and allowed values are fixture-tested; definitions cannot be deleted once created, so a create needs a review step that does not exist yet'),
  accessPackageCatalog: subset('identity-application', 'POST /identityGovernance/entitlementManagement/catalogs; PATCH .../{id}', 'EntitlementManagement.ReadWrite.All',
    'create and update are fixture-tested; the resources a catalog holds are a separate collection that is not backed up'),
  accessPackageAssignmentPolicy: research('identity-application', 'POST /identityGovernance/entitlementManagement/assignmentPolicies', 'EntitlementManagement.ReadWrite.All',
    'a policy belongs to an access package, which is not restored yet'),
  accessPackageAssignment: research('identity-application', 'POST /identityGovernance/entitlementManagement/assignmentRequests', 'EntitlementManagement.ReadWrite.All',
    'an assignment is granted through a request against its policy, never copied, and access packages are not restored yet'),
  entitlementManagementSettings: subset('identity-application', 'PATCH /identityGovernance/entitlementManagement/settings', 'EntitlementManagement.ReadWrite.All',
    'update of the tenant singleton is fixture-tested'),
  agreement: research('identity-application', 'POST /identityGovernance/termsOfUse/agreements', 'Agreement.ReadWrite.All',
    'the agreement documents are files on a separate route that is not backed up, and acceptances cannot be recreated'),
  b2xIdentityUserFlow: research('identity-application', 'POST /identity/b2xUserFlows', 'IdentityUserFlow.ReadWrite.All',
    'the languages, attributes and API connectors a flow uses are separate collections that are not backed up'),
  identityApiConnector: research('identity-application', 'POST /identity/apiConnectors', 'APIConnectors.ReadWrite.All',
    'the connector password or certificate is never readable'),
  accessPackageResourceRoleScope: research('identity-application', 'POST /identityGovernance/entitlementManagement/accessPackages/{id}/resourceRoleScopes', 'EntitlementManagement.ReadWrite.All',
    'the resource must be in the catalog first, and access packages are not restored yet'),
  synchronizationJob: research('identity-application', 'POST /servicePrincipals/{id}/synchronization/jobs', 'Synchronization.ReadWrite.All',
    'the schema is a separate collection that is not backed up, credentials are never readable, and a started job writes accounts in another directory'),
  // ---- policies (task-108)
  conditionalAccessPolicy: subset('policy', 'POST/PATCH/DELETE /identity/conditionalAccess/policies; POST /identity/conditionalAccess/deletedItems/policies/{id}/restore', 'Policy.ReadWrite.ConditionalAccess',
    'create, update, delete and soft-delete restore are fixture-tested; every write lands report-only, and turning a policy on is a separate approved step behind the break-glass lockout gate (task-152)'),
  namedLocation: subset('policy', 'POST/PATCH/DELETE /identity/conditionalAccess/namedLocations', 'Policy.ReadWrite.ConditionalAccess', 'registered before task-107'),
  // Roadmap task-108: the custom-strength subset; the operation records, their
  // subtype and field-projection binding live in engine/restore/policyOperations.mjs.
  authenticationStrengthPolicy: subset('policy', 'POST /policies/authenticationStrengthPolicies; PATCH /policies/authenticationStrengthPolicies/{id}', 'Policy.ReadWrite.ConditionalAccess',
    'create and update of custom strengths are fixture-tested; built-in strengths are immutable and refused; allowedCombinations changes only through updateAllowedCombinations, which is not qualified, so its drift is reported not remediable; delete is refused'),
  // The remaining policy family ledger after task-108: each stays research-needed
  // for the reason named, and every write to it is refused.
  authenticationContextClassReference: research('policy', 'PATCH /identity/conditionalAccess/authenticationContextClassReferences/{id}', 'Policy.ReadWrite.ConditionalAccess',
    'ids c1..c99 are fixed per tenant and referenced by CA policies and SharePoint labels; an upsert contract and a check of what consumes each id do not exist'),
  // Roadmap task-149: the tenant-wide security policies. Records, routes and the
  // lockout gate binding live in engine/restore/tenantPolicyOperations.mjs.
  authenticationMethodsPolicy: subset('policy', 'PATCH /policies/authenticationMethodsPolicy; PATCH /policies/authenticationMethodsPolicy/authenticationMethodConfigurations/{id}', 'Policy.ReadWrite.AuthenticationMethod',
    'update of the root settings and of existing method configurations is fixture-tested and runs only when the break-glass accounts stay ready under the proposed policy; a method missing from the live policy is refused'),
  identitySecurityDefaultsEnforcementPolicy: subset('policy', 'PATCH /policies/identitySecurityDefaultsEnforcementPolicy', 'Policy.ReadWrite.SecurityDefaults',
    'update of isEnabled is fixture-tested and runs only behind the break-glass lockout gate'),
  authorizationPolicy: subset('policy', 'PATCH /policies/authorizationPolicy', 'Policy.ReadWrite.Authorization',
    'update of guest invitation, self-service, consent and default user permission settings is fixture-tested and runs only behind the break-glass lockout gate'),
  crossTenantAccessPolicy: subset('policy', 'PATCH /policies/crossTenantAccessPolicy', 'Policy.ReadWrite.CrossTenantAccess',
    'update of allowedCloudEndpoints is fixture-tested; the default and partner settings are their own types'),
  crossTenantAccessPolicyConfigurationDefault: subset('policy', 'PATCH /policies/crossTenantAccessPolicy/default', 'Policy.ReadWrite.CrossTenantAccess',
    'update of the default B2B collaboration, direct connect, inbound trust, consent and tenant restriction settings is fixture-tested'),
  crossTenantAccessPolicyPartner: subset('policy', 'POST /policies/crossTenantAccessPolicy/partners; PATCH /policies/crossTenantAccessPolicy/partners/{tenantId}', 'Policy.ReadWrite.CrossTenantAccess',
    'create and update are fixture-tested and keyed by the partner tenantId; Graph refuses a tenantId that does not exist; delete is refused'),
  permissionGrantPolicy: subset('policy', 'POST /policies/permissionGrantPolicies; PATCH /policies/permissionGrantPolicies/{id}; POST .../{id}/includes|excludes', 'Policy.ReadWrite.PermissionGrant',
    'create and update of custom policies are fixture-tested; include and exclude rules are made to match the backup when it holds them (missing ones added, extra ones removed) and the whole rule sets are read back; built-in microsoft-* policies are skipped; delete is refused'),
  adminConsentRequestPolicy: subset('policy', 'PUT /policies/adminConsentRequestPolicy', 'Policy.ReadWrite.ConsentRequest',
    'update (a PUT of every writable field) is fixture-tested for the same tenant; reviewer queries are written as observed and are never remapped to another tenant'),
  // Issue #156: basic tenant settings in the policy family.
  authenticationFlowsPolicy: subset('policy', 'PATCH /policies/authenticationFlowsPolicy', 'Policy.ReadWrite.AuthenticationFlows',
    'update of selfServiceSignUp (whether external users may sign themselves up through user flows) is fixture-tested; the user flows themselves are their own type and are not written'),
  deviceRegistrationPolicy: byHand('policy', null, 'none',
    'backed up only: device join and registration settings, including whether joining needs MFA, are changed by hand so an admin is never locked out of joining devices and MFA is never weakened silently'),
  activityBasedTimeoutPolicy: research('policy', 'POST /policies/activityBasedTimeoutPolicies', 'Policy.ReadWrite.ApplicationConfiguration',
    'definition is a JSON string KEEL does not parse; a tenant-wide default and per-application assignment are not distinguished'),
  claimsMappingPolicy: subset('policy', 'POST /policies/claimsMappingPolicies; PATCH /policies/claimsMappingPolicies/{id}', 'Policy.ReadWrite.ApplicationConfiguration',
    'create and update of the name and definition are fixture-tested; every definition entry must parse; a recreate is never the organization default; app assignments are set by hand; delete is refused'),
  homeRealmDiscoveryPolicy: subset('policy', 'POST /policies/homeRealmDiscoveryPolicies; PATCH /policies/homeRealmDiscoveryPolicies/{id}', 'Policy.ReadWrite.ApplicationConfiguration',
    'create and update of the name and definition are fixture-tested; every definition entry must parse; a recreate is never the organization default; app assignments are set by hand; delete is refused'),
  tokenIssuancePolicy: subset('policy', 'POST /policies/tokenIssuancePolicies; PATCH /policies/tokenIssuancePolicies/{id}', 'Policy.ReadWrite.ApplicationConfiguration',
    'create and update of the name and definition are fixture-tested; every definition entry must parse; a recreate is never the organization default; app assignments are set by hand; delete is refused'),
  tokenLifetimePolicy: subset('policy', 'POST /policies/tokenLifetimePolicies; PATCH /policies/tokenLifetimePolicies/{id}', 'Policy.ReadWrite.ApplicationConfiguration',
    'create and update of the name and definition are fixture-tested; every definition entry must parse; a recreate is never the organization default; app assignments are set by hand; delete is refused'),
  featureRolloutPolicy: research('policy', 'POST /policies/featureRolloutPolicies', 'Policy.ReadWrite.FeatureRollout',
    'staged rollout of sign-in features; applies-to group membership is a separate edge with no qualified writer'),
  // Wave 1 CAT-ENTRA: backed up; no write is qualified yet.
  appManagementPolicy: subset('policy', 'POST /policies/appManagementPolicies; PATCH .../{id}', 'Policy.ReadWrite.ApplicationConfiguration',
    'create and update are fixture-tested; assignment to applications and service principals is a separate edge with no qualified writer'),
  tenantAppManagementPolicy: research('policy', 'PATCH /policies/defaultAppManagementPolicy', 'Policy.ReadWrite.ApplicationConfiguration',
    'a stricter default can block every app from adding a secret or certificate; an update needs a review step that does not exist yet'),
  multiTenantOrganization: subset('policy', 'PATCH /tenantRelationships/multiTenantOrganization', 'MultiTenantOrganization.ReadWrite.All',
    'update of name and description is fixture-tested; member tenants must each accept, which cannot be done from this tenant'),
  crossTenantIdentitySyncPolicyPartner: research('policy', 'PUT /policies/crossTenantAccessPolicy/partners/{tenantId}/identitySynchronization', 'Policy.ReadWrite.CrossTenantAccess',
    'it turns on user sync from a partner tenant; an update needs a review step that does not exist yet'),
  // ---- administrative configuration (task-109)
  organization: byHand('administrative-configuration', null, 'none', 'the tenant object itself; it is never recreated'),
  domain: byHand('administrative-configuration', 'POST /domains', 'Domain.ReadWrite.All', 'requires DNS ownership verification outside Graph'),
  subscribedSku: notWritable('administrative-configuration', null, 'none', 'licences are purchased, not configured'),
  directorySettingTemplate: byHand('administrative-configuration', null, 'none', 'Microsoft-published template catalogue; a global reference template is never written'),
  // Roadmap task-109: the operation records and their parent, dependency and
  // source-authority checks live in engine/restore/administrativeOperations.mjs.
  groupSetting: subset('administrative-configuration', 'PATCH /groupSettings/{id}; DELETE /groupSettings/{id}', 'GroupSettings.ReadWrite.All',
    'update and delete of tenant-wide settings are fixture-tested; the template is never written; create and group-scoped settings are not qualified'),
  administrativeUnit: subset('administrative-configuration', 'PATCH /directory/administrativeUnits/{id}', 'AdministrativeUnit.ReadWrite.All',
    'update of displayName and description is fixture-tested; create, delete, soft-delete restore, membership and scoped role members are not qualified'),
  // Issue #156: company branding and group expiration. Records live in
  // engine/restore/tenantPolicyOperations.mjs.
  organizationalBranding: subset('administrative-configuration', 'PATCH /organization/{id}/branding', 'OrganizationalBranding.ReadWrite.All',
    'update of the default sign-in page text, colours and layout is fixture-tested; logos, background image, favicon and custom stylesheet are uploaded with PUT /organization/{id}/branding/localizations/0/{file} (fixture-tested, not live)'),
  organizationalBrandingLocalization: subset('administrative-configuration', 'PATCH /organization/{id}/branding/localizations/{locale}', 'OrganizationalBranding.ReadWrite.All',
    'update of an existing language\'s text, colours and layout is fixture-tested; its images and stylesheet are uploaded with PUT /organization/{id}/branding/localizations/{locale}/{file} (fixture-tested, not live); adding or removing a language is by hand'),
  groupLifecyclePolicy: subset('administrative-configuration', 'PATCH /groupLifecyclePolicies/{id}', 'Directory.ReadWrite.All',
    'update is fixture-tested and runs only when it makes expiry less aggressive (a longer lifetime, fewer groups covered, no renewal notice address removed); create, delete and the list of selected groups are by hand'),
  // ---- device management (outside the Entra batches)
  // Issue #155: records, routes and the assignment writer live in
  // engine/restore/intuneOperations.mjs. The other Intune types are manual by
  // decision (TYPE_DECISIONS gives each reason); their assignments are backed up.
  deviceConfiguration: subset('device-management', 'POST /deviceManagement/deviceConfigurations; PATCH /deviceManagement/deviceConfigurations/{id}; POST .../{id}/assign; DELETE .../{id}', 'DeviceManagementConfiguration.ReadWrite.All',
    'create and update with assignments, and delete of an unassigned profile, are fixture-tested; credential and certificate profiles and any value Graph never returns stay manual'),
  deviceCompliancePolicy: subset('device-management', 'POST /deviceManagement/deviceCompliancePolicies; PATCH .../{id}; POST .../{id}/scheduleActionsForRules; POST .../{id}/assign; DELETE .../{id}', 'DeviceManagementConfiguration.ReadWrite.All',
    'create (with its actions for noncompliance, which Graph requires) and update with assignments, and delete of an unassigned policy, are fixture-tested'),
  configurationPolicy: subset('device-management', 'POST /deviceManagement/configurationPolicies (beta); PUT .../{id} (beta); POST .../{id}/assign (beta); DELETE .../{id} (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create and update of the whole policy and its settings with assignments, and delete of an unassigned policy, are fixture-tested through Graph beta, the only version with the settings catalog; secret settings stay manual'),
  deviceEnrollmentConfiguration: byHand('device-management', 'POST /deviceManagement/deviceEnrollmentConfigurations', 'DeviceManagementServiceConfig.ReadWrite.All',
    'default enrollment restrictions cannot be created and priority is a separate action; restored by hand'),
  deviceManagementRoleDefinition: byHand('device-management', 'POST /deviceManagement/roleDefinitions', 'DeviceManagementRBAC.ReadWrite.All',
    'Intune admin roles need a privilege review; their role assignments are backed up separately'),
  deviceCategory: subset('device-management', 'POST /deviceManagement/deviceCategories; PATCH .../{id}', 'DeviceManagementManagedDevices.ReadWrite.All',
    'create and update are fixture-tested; devices are put in a category at enrollment, which a restore cannot redo'),
  termsAndConditions: byHand('device-management', 'POST /deviceManagement/termsAndConditions', 'DeviceManagementServiceConfig.ReadWrite.All',
    'user acceptance cannot be recreated'),
  windowsAutopilotDeploymentProfile: subset('device-management', 'POST /deviceManagement/windowsAutopilotDeploymentProfiles (beta); PATCH .../{id} (beta); POST/DELETE .../{id}/assignments (beta)', 'DeviceManagementServiceConfig.ReadWrite.All',
    'create and update are fixture-tested; device hardware records are not backed up; assignments are written one at a time'),
  deviceManagementIntent: byHand('device-management', 'POST /deviceManagement/intents (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'beta-only, replaced by the settings catalog; intent settings are not backed up'),
  managedDevice: byHand('device-management', null, 'none', 'device state, enrolled by the device, not configuration'),
  mobileApp: subset('device-management', 'POST /deviceAppManagement/mobileApps; PATCH .../{id}; POST .../{id}/assign', 'DeviceManagementApps.ReadWrite.All',
    'create and update are fixture-tested; a Win32 or line-of-business app comes back without its package and is assigned only once it is uploaded; synced apps are never created'),
  managedAppPolicy: subset('device-management', 'POST /deviceAppManagement/{ios|android}ManagedAppProtections; PATCH .../{id}; POST .../{id}/targetApps; POST .../{id}/assign; DELETE .../{id}', 'DeviceManagementApps.ReadWrite.All',
    'create, update and delete of iOS and Android protection are fixture-tested; the protected apps are read per policy (restore gaps batch 13)'),
  targetedManagedAppConfiguration: subset('device-management', 'POST /deviceAppManagement/targetedManagedAppConfigurations; PATCH .../{id}; POST .../{id}/targetApps; DELETE .../{id}', 'DeviceManagementApps.ReadWrite.All',
    'create, update and delete are fixture-tested; the targeted apps are read per configuration (restore gaps batch 13)'),
  mobileAppConfiguration: subset('device-management', 'POST /deviceAppManagement/mobileAppConfigurations; PATCH .../{id}; DELETE .../{id}', 'DeviceManagementApps.ReadWrite.All',
    'create, update and delete are fixture-tested; every app it targets must already exist in the target'),
  // Wave 1 CAT-INTUNE scripts; restore gaps batch 4 reads each script's body and writes it back.
  deviceManagementScript: subset('device-management', 'POST /deviceManagement/deviceManagementScripts (beta); PATCH .../{id} (beta); POST .../{id}/assign (beta)', 'DeviceManagementScripts.ReadWrite.All',
    'create and update are fixture-tested; assignments are written through /assign'),
  deviceShellScript: subset('device-management', 'POST /deviceManagement/deviceShellScripts (beta); PATCH .../{id} (beta); POST .../{id}/assign (beta)', 'DeviceManagementScripts.ReadWrite.All',
    'create and update are fixture-tested; assignments are written through /assign'),
  deviceHealthScript: subset('device-management', 'POST /deviceManagement/deviceHealthScripts (beta); PATCH .../{id} (beta); POST .../{id}/assign (beta)', 'DeviceManagementScripts.ReadWrite.All',
    'create and update are fixture-tested; Microsoft-published remediations are skipped; assignments (with the schedule) are written through /assign'),
  deviceComplianceScript: subset('device-management', 'POST /deviceManagement/deviceComplianceScripts (beta); PATCH .../{id} (beta); POST .../{id}/assign (beta)', 'DeviceManagementScripts.ReadWrite.All',
    'create and update are fixture-tested; assignments are written through /assign'),
  assignmentFilter: subset('device-management', 'POST /deviceManagement/assignmentFilters (beta); PATCH .../{id} (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create and update are fixture-tested; the platform is never changed'),
  roleScopeTag: subset('device-management', 'POST /deviceManagement/roleScopeTags (beta); PATCH .../{id} (beta)', 'DeviceManagementRBAC.ReadWrite.All',
    'create and update are fixture-tested; the built-in Default tag is never written'),
  windowsFeatureUpdateProfile: subset('device-management', 'POST /deviceManagement/windowsFeatureUpdateProfiles (beta); PATCH/DELETE .../{id} (beta); POST .../{id}/assign (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create, update and delete are fixture-tested; assignments are written through /assign'),
  windowsQualityUpdateProfile: subset('device-management', 'POST /deviceManagement/windowsQualityUpdateProfiles (beta); PATCH/DELETE .../{id} (beta); POST .../{id}/assign (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create, update and delete are fixture-tested; assignments are written through /assign'),
  windowsDriverUpdateProfile: subset('device-management', 'POST /deviceManagement/windowsDriverUpdateProfiles (beta); PATCH/DELETE .../{id} (beta); POST .../{id}/assign (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create, update and delete are fixture-tested; driver approvals are not backed up; assignments are written through /assign'),
  groupPolicyConfiguration: subset('device-management', 'POST /deviceManagement/groupPolicyConfigurations (beta); PATCH .../{id} (beta); POST .../{id}/updateDefinitionValues (beta); POST .../{id}/assign (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create and update with settings and their values are fixture-tested; assignments are written through /assign'),
  groupPolicyUploadedDefinitionFile: subset('device-management', 'POST /deviceManagement/groupPolicyUploadedDefinitionFiles (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create with the ADMX and ADML file content is fixture-tested; never updated in place'),
  notificationMessageTemplate: subset('device-management', 'POST /deviceManagement/notificationMessageTemplates; PATCH .../{id}; POST/PATCH .../{id}/localizedNotificationMessages', 'DeviceManagementServiceConfig.ReadWrite.All',
    'create and update with the message text per language are fixture-tested'),
  windowsAutopilotDeviceIdentity: byHand('device-management', 'POST /deviceManagement/importedWindowsAutopilotDeviceIdentities', 'DeviceManagementServiceConfig.ReadWrite.All',
    'the hardware hash is never returned, so a registration is imported again from the device'),
  deviceManagementRoleAssignment: byHand('device-management', 'POST /deviceManagement/roleAssignments', 'DeviceManagementRBAC.ReadWrite.All',
    'Intune admin access needs a privilege review before it is granted again'),
  // Remaining kinds, batch 1: backed up read-only; manual until a writer is built.
  applePushNotificationCertificate: byHand('device-management', null, 'DeviceManagementServiceConfig.ReadWrite.All',
    'the certificate is renewed with Apple and uploaded in the Intune admin center; the backup keeps the Apple ID, topic and expiry'),
  mobileThreatDefenseConnector: byHand('device-management', 'POST /deviceManagement/mobileThreatDefenseConnectors', 'DeviceManagementServiceConfig.ReadWrite.All',
    'backed up; the connection is completed from the partner console'),
  deviceManagementPartner: byHand('device-management', 'POST /deviceManagement/deviceManagementPartners', 'DeviceManagementServiceConfig.ReadWrite.All',
    'backed up; the connection is completed from the partner console'),
  complianceManagementPartner: byHand('device-management', 'POST /deviceManagement/complianceManagementPartners', 'DeviceManagementServiceConfig.ReadWrite.All',
    'backed up; the connection is completed from the partner console'),
  remoteAssistancePartner: byHand('device-management', 'POST /deviceManagement/remoteAssistancePartners', 'DeviceManagementServiceConfig.ReadWrite.All',
    'backed up; onboarding is completed from the partner console'),
  deviceManagementExchangeConnector: byHand('device-management', null, 'DeviceManagementServiceConfig.ReadWrite.All',
    'backed up; the connector is installed on an Exchange server'),
  onPremisesConditionalAccessSettings: subset('device-management', 'PATCH /deviceManagement/conditionalAccessSettings', 'DeviceManagementConfiguration.ReadWrite.All',
    'update in place is fixture-tested; a restore never turns it on'),
  mobileAppCategory: subset('device-management', 'POST /deviceAppManagement/mobileAppCategories; PATCH .../{id}', 'DeviceManagementApps.ReadWrite.All',
    'create and update are fixture-tested; built-in categories are never written'),
  intuneBrandingProfile: subset('device-management', 'POST /deviceManagement/intuneBrandingProfiles (beta); PATCH .../{id} (beta); POST .../{id}/assign (beta)', 'DeviceManagementServiceConfig.ReadWrite.All',
    'create and update are fixture-tested; the default profile is updated in place only; logo images are not written; assignments are written through /assign'),
  customAuthenticationExtension: byHand('identity-application', 'POST /identity/customAuthenticationExtensions', 'CustomAuthenticationExtension.ReadWrite.All',
    'backed up; the endpoint and its sign-in settings are checked by hand before a recreate'),
  // Remaining kinds, batch 3: Intune tenant settings, backed up read-only; manual until a writer is built.
  deviceManagementCompliancePolicy: subset('device-management', 'POST /deviceManagement/compliancePolicies (beta); PUT .../{id} (beta); POST .../{id}/setScheduledActions (beta); POST .../{id}/assign (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create and update with settings and actions for noncompliance are fixture-tested; assignments are written through /assign'),
  deviceManagementReusablePolicySetting: subset('device-management', 'POST /deviceManagement/reusablePolicySettings (beta); PUT .../{id} (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create and update with the group\'s values are fixture-tested; the setting definition is never changed; a backup without the values is refused'),
  policySet: subset('device-management', 'POST /deviceAppManagement/policySets (beta); PATCH .../{id} (beta); POST .../{id}/update (beta)', 'DeviceManagementApps.ReadWrite.All',
    'create and update with the items in the set are fixture-tested; assignments are written through the update action'),
  vppToken: byHand('device-management', null, 'DeviceManagementServiceConfig.ReadWrite.All',
    'backed up without the token; a new token comes from Apple Business Manager'),
  depOnboardingSetting: byHand('device-management', null, 'DeviceManagementServiceConfig.ReadWrite.All',
    'backed up without the token; a new token comes from Apple Business Manager'),
  androidManagedStoreAccountEnterpriseSettings: byHand('device-management', null, 'DeviceManagementConfiguration.ReadWrite.All',
    'backed up without enrollment codes; the binding is made by signing in to Google'),
  managedDeviceCleanupRule: subset('device-management', 'PATCH /deviceManagement/managedDeviceCleanupRules/{id} (beta)', 'DeviceManagementManagedDevices.ReadWrite.All',
    'update is fixture-tested and never shortens how long a rule waits before retiring devices; create is not registered'),
  windowsQualityUpdatePolicy: subset('device-management', 'POST /deviceManagement/windowsQualityUpdatePolicies (beta); PATCH .../{id} (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create and update are fixture-tested; assignments are not backed up yet'),
  operationApprovalPolicy: byHand('device-management', 'POST /deviceManagement/operationApprovalPolicies (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'backed up; approval rules need a privilege review before they are set again'),
  deviceCustomAttributeShellScript: subset('device-management', 'POST /deviceManagement/deviceCustomAttributeShellScripts (beta); PATCH .../{id} (beta); POST .../{id}/assign (beta)', 'DeviceManagementScripts.ReadWrite.All',
    'create and update are fixture-tested; assignments are written through /assign'),
  // Remaining kinds, batch 4: Entra ID tenant settings, backed up read-only; manual until a writer is built.
  externalIdentitiesPolicy: subset('policy', 'PATCH /policies/externalIdentitiesPolicy (beta)', 'Policy.ReadWrite.ExternalIdentities',
    'update in place is fixture-tested; only the two leave settings are written'),
  b2bManagementPolicy: subset('policy', 'PATCH /policies/b2bManagementPolicies/{id} (beta)', 'Policy.ReadWrite.B2BManagementPolicy',
    'update in place of the definition is fixture-tested; a deleted policy is not recreated'),
  servicePrincipalCreationPolicy: byHand('policy', 'POST /policies/servicePrincipalCreationPolicies (beta)', 'Policy.ReadWrite.ApplicationConfiguration',
    'backed up; the include and exclude conditions are read per policy'),
  permissionGrantPreApprovalPolicy: subset('policy', 'POST /policies/permissionGrantPreApprovalPolicies (beta)', 'Policy.ReadWrite.PermissionGrant',
    'create and update of the conditions are fixture-tested; the assignment to an app is not backed up'),
  accessReviewPolicy: subset('identity-application', 'PATCH /policies/accessReviewPolicy (beta)', 'Policy.ReadWrite.AccessReview',
    'update in place is fixture-tested'),
  directoryRoleAccessReviewPolicy: subset('identity-application', 'PATCH /policies/directoryRoleAccessReviewPolicy (beta)', 'RoleManagement.ReadWrite.Directory',
    'update in place of the review settings is fixture-tested'),
  multiTenantOrganizationIdentitySyncPolicyTemplate: subset('policy', 'PATCH /policies/crossTenantAccessPolicy/templates/multiTenantOrganizationIdentitySynchronization', 'Policy.ReadWrite.CrossTenantAccess',
    'update in place is fixture-tested; it only affects tenants that join later'),
  multiTenantOrganizationPartnerConfigurationTemplate: subset('policy', 'PATCH /policies/crossTenantAccessPolicy/templates/multiTenantOrganizationPartnerConfiguration', 'Policy.ReadWrite.CrossTenantAccess',
    'update in place is fixture-tested; it only affects tenants that join later'),
  identityUserFlowAttribute: byHand('identity-application', 'POST /identity/userFlowAttributes', 'IdentityUserFlow.ReadWrite.All',
    'backed up; built-in attributes are listed beside custom ones'),
  authenticationEventListener: byHand('identity-application', 'POST /identity/authenticationEventListeners', 'EventListener.ReadWrite.All',
    'backed up; its custom authentication extension is recreated first'),
  externalDomainFederation: subset('policy', 'PATCH /directory/federationConfigurations/graph.samlOrWsFedExternalDomainFederation/{id}', 'Domain.ReadWrite.All',
    'update in place is fixture-tested; its domains are not backed up, so a deleted federation is not recreated'),
  // Remaining kinds, batch 5: Exchange and Defender admin roles, backed up read-only; manual until a writer is built.
  exchangeRoleDefinition: byHand('identity-application', 'New-ManagementRole (Exchange Online PowerShell)', 'Exchange Organization Management role',
    'backed up; built-in roles are listed beside custom ones'),
  exchangeRoleAssignment: byHand('identity-application', 'POST /roleManagement/exchange/roleAssignments (beta)', 'RoleManagement.ReadWrite.Exchange',
    'backed up; a privilege review comes before any grant'),
  exchangeCustomAppScope: subset('identity-application', 'POST /roleManagement/exchange/customAppScopes (beta); PATCH .../{id} (beta)', 'RoleManagement.ReadWrite.Exchange',
    'create and update are fixture-tested; the app role assignments that use it are not written'),
  defenderRoleDefinition: byHand('identity-application', 'POST /roleManagement/defender/roleDefinitions (beta)', 'RoleManagement.ReadWrite.Defender',
    'backed up; no writer yet'),
  defenderRoleAssignment: byHand('identity-application', 'POST /roleManagement/defender/roleAssignments (beta)', 'RoleManagement.ReadWrite.Defender',
    'backed up; a privilege review comes before any grant'),
  defenderCustomAppScope: byHand('identity-application', 'POST /roleManagement/defender/customAppScopes (beta)', 'RoleManagement.ReadWrite.Defender',
    'backed up; no writer yet'),
  // Remaining kinds, batch 6: Intune leftovers, backed up read-only; manual until a writer is built.
  deviceManagementSettings: subset('device-management', 'PATCH /deviceManagement (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'update in place of settings is fixture-tested; never loosens compliance'),
  androidDeviceOwnerEnrollmentProfile: subset('device-management', 'POST /deviceManagement/androidDeviceOwnerEnrollmentProfiles (beta); PATCH .../{id} (beta)', 'DeviceManagementServiceConfig.ReadWrite.All',
    'create and update are fixture-tested; the enrollment token, QR code and Wi-Fi password are not written'),
  androidForWorkEnrollmentProfile: subset('device-management', 'POST /deviceManagement/androidForWorkEnrollmentProfiles (beta); PATCH .../{id} (beta)', 'DeviceManagementServiceConfig.ReadWrite.All',
    'create and update are fixture-tested; the enrollment token and QR code are not written'),
  appleUserInitiatedEnrollmentProfile: subset('device-management', 'POST /deviceManagement/appleUserInitiatedEnrollmentProfiles (beta); PATCH .../{id} (beta)', 'DeviceManagementServiceConfig.ReadWrite.All',
    'create and update are fixture-tested; priority and assignments are not written'),
  androidForWorkSettings: byHand('device-management', null, 'DeviceManagementServiceConfig.ReadWrite.All',
    'backed up; the binding is made by signing in to Google'),
  deviceManagementDerivedCredentialSettings: byHand('device-management', 'POST /deviceManagement/derivedCredentials (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'backed up; no writer yet'),
  microsoftTunnelConfiguration: subset('device-management', 'POST /deviceManagement/microsoftTunnelConfigurations (beta); PATCH .../{id} (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create and update are fixture-tested; sites and servers are not written'),
  microsoftTunnelHealthThreshold: subset('device-management', 'PATCH /deviceManagement/microsoftTunnelHealthThresholds/{id} (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'update in place of the two limits is fixture-tested'),
  iosLobAppProvisioningConfiguration: subset('device-management', 'POST /deviceAppManagement/iosLobAppProvisioningConfigurations (beta); PATCH .../{id} (beta); POST .../{id}/assign (beta)', 'DeviceManagementApps.ReadWrite.All',
    'create and update with the profile file are fixture-tested; expired or older files are never written; assignments are written through /assign'),
  mobileAppRelationship: subset('device-management', 'POST /deviceAppManagement/mobileAppRelationships (beta); PATCH .../{id} (beta)', 'DeviceManagementApps.ReadWrite.All',
    'create and update are fixture-tested; both apps must already exist; a link already set between the same apps is skipped'),
  managedEBook: byHand('device-management', 'POST /deviceAppManagement/managedEBooks (beta)', 'DeviceManagementApps.ReadWrite.All',
    'backed up; no writer yet'),
  managedEBookCategory: subset('device-management', 'POST /deviceAppManagement/managedEBookCategories (beta); PATCH .../{id} (beta)', 'DeviceManagementApps.ReadWrite.All',
    'create and update are fixture-tested; which books are in a category is not written'),
  cartToClassAssociation: subset('device-management', 'POST /deviceManagement/cartToClassAssociations (beta); PATCH .../{id} (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create and update are fixture-tested; devices and classes are written by id and must still exist'),
  windowsManagedAppProtection: subset('device-management', 'POST /deviceAppManagement/windowsManagedAppProtections (beta); PATCH .../{id} (beta); POST .../{id}/targetApps (beta); POST .../{id}/assign (beta)', 'DeviceManagementApps.ReadWrite.All',
    'create and update with the apps it covers are fixture-tested; assignments are written through /assign'),
  enterpriseCodeSigningCertificate: byHand('device-management', 'POST /deviceAppManagement/enterpriseCodeSigningCertificates (beta)', 'DeviceManagementApps.ReadWrite.All',
    'backed up with the public certificate; no writer yet'),
  symantecCodeSigningCertificate: byHand('device-management', 'PATCH /deviceAppManagement/symantecCodeSigningCertificate (beta)', 'DeviceManagementApps.ReadWrite.All',
    'backed up without the certificate file or password'),
  userExperienceAnalyticsBaseline: subset('device-management', 'POST /deviceManagement/userExperienceAnalyticsBaselines (beta); PATCH .../{id} (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'create and update of custom baselines are fixture-tested; built-in baselines are never written'),
  // Remaining kinds, batch 7: Microsoft 365 settings, backed up read-only; manual until a writer is built.
  sharepointSettings: subset('administrative-configuration', 'PATCH /admin/sharepoint/settings', 'SharePointTenantSettings.ReadWrite.All',
    'update in place of the settings other than sharing is fixture-tested; the sharing fields stay with the SharePoint workload'),
  itemInsightsSettings: byHand('administrative-configuration', 'PATCH /admin/people/itemInsights', 'PeopleSettings.ReadWrite.All',
    'backed up; no writer yet'),
  externalConnection: byHand('administrative-configuration', 'POST /external/connections', 'ExternalConnection.ReadWrite.OwnedBy',
    'backed up without schema or items; no writer yet'),
  simulationAutomation: byHand('policy', null, 'AttackSimulation.ReadWrite.All',
    'backed up; Graph cannot create an automation'),
  attackSimulation: byHand('policy', 'POST /security/attackSimulation/simulations', 'AttackSimulation.ReadWrite.All',
    'backed up without results; no writer yet'),
  // Remaining kinds, batch 8: the last readable kinds, backed up read-only; manual until a writer is built.
  hardwareConfiguration: subset('device-management', 'PATCH /deviceManagement/hardwareConfigurations/{id} (beta)', 'DeviceManagementConfiguration.ReadWrite.All',
    'update is fixture-tested; the BIOS settings file is not backed up, so create is not written'),
  certificateBasedApplicationConfiguration: byHand('identity-application', 'POST /directory/certificateAuthorities/certificateBasedApplicationConfigurations (beta)', 'AppCertTrustConfiguration.ReadWrite.All',
    'backed up without the trusted authorities; no writer yet'),
  signInIdentifier: byHand('policy', 'PATCH /identity/signInIdentifiers/{id} (beta)', 'IdentityProvider.ReadWrite.All',
    'backed up; no writer yet'),
  verifiedIdProfile: byHand('identity-application', 'POST /identity/verifiedId/profiles (beta)', 'VerifiedId-Profile.ReadWrite.All',
    'backed up; no writer yet'),
  externalOriginResourceConnector: byHand('identity-application', 'POST /identityGovernance/entitlementManagement/externalOriginResourceConnectors (beta)', 'EntitlementManagement.ReadWrite.All',
    'backed up; no writer yet'),
  lifecyclePolicy: byHand('policy', 'POST /identityGovernance/lifecycleWorkflows/lifecyclePolicies (beta)', 'LifecycleWorkflows.ReadWrite.All',
    'backed up without rules or versions; no writer yet'),
  roleManagementCustomExtension: byHand('identity-application', 'POST /identityGovernance/privilegedAccess/customExtensions', 'RoleManagementPolicy.ReadWrite.Directory',
    'backed up without the Logic App address; no writer yet'),
  privilegedAccessGroupResource: byHand('identity-application', null, 'PrivilegedAccess.ReadWrite.AzureADGroup',
    'backed up; a group comes under PIM when it gets its first eligible or time-bound member'),
  crossTenantM365Capability: byHand('policy', 'PATCH /policies/crossTenantAccessPolicy/default/m365Capabilities/{id} (beta)', 'Policy.ReadWrite.CrossTenantAccess',
    'backed up; no writer yet'),
  entitlementManagementRoleAssignment: byHand('identity-application', 'POST /roleManagement/entitlementManagement/roleAssignments (beta)', 'EntitlementManagement.ReadWrite.All',
    'backed up one role at a time; no writer yet'),
  deviceTemplate: byHand('identity-application', 'POST /templates/deviceTemplates (beta)', 'DeviceTemplate.ReadWrite.All',
    'backed up without owners or devices; no writer yet'),
  securityZone: byHand('administrative-configuration', 'POST /security/zones (beta)', 'SecurityZone.ReadWrite.All',
    'backed up without its environments; no writer yet'),
  sharedEmailDomain: byHand('administrative-configuration', null, 'Domain.ReadWrite.All',
    'backed up; Microsoft provisions the domain'),
  schemaExtension: byHand('administrative-configuration', 'POST /schemaExtensions', 'Application.ReadWrite.All',
    'backed up for this tenant\'s apps only; no writer yet'),
});

const INVENTORY_FIELDS = new Set(['batch', 'status', 'api', 'permission', 'reason']);

/**
 * The restore scope a type has, derived from the registry alone:
 * 'full' only when every object operation is registered, 'partial' when some
 * are, 'none' otherwise. Nothing in EXPANSION_INVENTORY can set it.
 */
export function restoreScopeFor(resourceType) {
  const supported = OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor(resourceType, operation).claim));
  if (supported.length === 0) return 'none';
  return supported.length === OPERATIONS.length ? 'full' : 'partial';
}

/**
 * Validates and expands EXPANSION_INVENTORY into one record per catalogue type.
 * Throws when a type is missing or in two places, an entry carries an unknown
 * field, a status disagrees with the registry or TYPE_DECISIONS, or a
 * non-qualified entry lacks its API/permission reason.
 */
export function buildExpansionInventory({ inventory = EXPANSION_INVENTORY, decisions = TYPE_DECISIONS } = {}) {
  const types = [...new Set([...CATALOG.map((entry) => entry.type), ...DESCRIPTORS.map((descriptor) => descriptor.type)])];
  const missing = types.filter((type) => !inventory[type]);
  if (missing.length > 0) throw new Error(`no expansion batch entry for: ${missing.join(', ')}`);
  const extra = Object.keys(inventory).filter((type) => !types.includes(type));
  if (extra.length > 0) throw new Error(`expansion entries for types not in the catalogue: ${extra.join(', ')}`);
  const batchIds = new Set(EXPANSION_BATCHES.map((batch) => batch.id));

  const entries = types.map((type) => {
    const entry = inventory[type];
    const unknownKeys = Object.keys(entry).filter((key) => !INVENTORY_FIELDS.has(key));
    if (unknownKeys.length > 0) throw new Error(`${type}: expansion entry carries unrecognised fields ${unknownKeys.join(', ')} — a restore scope is derived, never declared`);
    if (!batchIds.has(entry.batch)) throw new Error(`${type}: unknown batch ${entry.batch}`);
    if (!EXPANSION_STATUSES.includes(entry.status)) throw new Error(`${type}: invalid status ${entry.status}`);
    if (typeof entry.reason !== 'string' || entry.reason.length === 0) throw new Error(`${type}: entry has no reason`);
    if (typeof entry.permission !== 'string' || entry.permission.length === 0) throw new Error(`${type}: entry has no permission reason`);
    if (entry.api !== null && (typeof entry.api !== 'string' || entry.api.length === 0)) throw new Error(`${type}: api must be a route or null`);

    const scope = restoreScopeFor(type);
    const registered = scope !== 'none';
    if (entry.status === 'qualified-subset' && !registered) {
      throw new Error(`${type} is marked qualified-subset but has no registered write capability`);
    }
    if (entry.status !== 'qualified-subset' && registered) {
      throw new Error(`${type} has a registered write capability but is marked ${entry.status}`);
    }
    const decision = decisions[type]?.decision;
    if (entry.status === 'manual' && decision !== 'manual') throw new Error(`${type} is manual in its batch but ${decision} in TYPE_DECISIONS`);
    if ((entry.status === 'research-needed' || entry.status === 'unsupported') && decision === 'automated') {
      throw new Error(`${type} is ${entry.status} in its batch but automated in TYPE_DECISIONS`);
    }
    if (entry.status === 'research-needed' && entry.api === null) {
      throw new Error(`${type}: a research-needed entry must name the API route to investigate`);
    }

    return Object.freeze({
      resourceType: type,
      batch: entry.batch,
      status: entry.status,
      restoreScope: scope,
      supportedOperations: Object.freeze(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor(type, operation).claim))),
      unsupportedOperations: Object.freeze(OPERATIONS.filter((operation) => !isSupportedClaim(capabilityFor(type, operation).claim))),
      api: entry.api,
      permission: entry.permission,
      reason: entry.reason,
    });
  });

  return Object.freeze({
    contractVersion: EXPANSION_CONTRACT_VERSION,
    batches: Object.freeze(EXPANSION_BATCHES.map((batch) => Object.freeze({
      ...batch,
      types: Object.freeze(entries.filter((entry) => entry.batch === batch.id)),
    }))),
  });
}

/**
 * Roadmap task-109: what KEEL cannot recover for a type of the administrative
 * batch, configuration and relationships alike. Kept apart from
 * EXPANSION_INVENTORY (whose entries refuse unrecognised fields), reviewed by
 * hand, and never summarised into a percentage. A type without an entry has
 * not been assessed, which is not the same as "nothing is lost".
 */
const lost = (kind, name, reason) => Object.freeze({ kind, name, reason });
export const UNRECOVERABLE_CONFIGURATION = Object.freeze({
  administrativeUnit: Object.freeze([
    lost('relationship', 'members', 'unit membership is a separate edge with no qualified writer; it is listed for manual repair'),
    lost('relationship', 'scopedRoleMembers', 'role assignments scoped to the unit are separate edges with no qualified writer'),
    lost('configuration', 'visibility, isMemberManagementRestricted', 'set only when a unit is created; drift is reported not remediable'),
    lost('configuration', 'membershipType, membershipRule, membershipRuleProcessingState', 'dynamic membership is not qualified for writing; drift is reported not remediable'),
    lost('configuration', 'deleted unit', 'create and soft-delete restore are not qualified; a missing unit is recreated by hand'),
  ]),
  groupSetting: Object.freeze([
    lost('relationship', 'templateId', 'bound to a Microsoft-published template for life; a setting on a different template is refused'),
    lost('configuration', 'values the snapshot never observed', 'a value the template gained after the snapshot would be reset by a write, so the update is refused'),
    lost('configuration', 'deleted setting', 'create is not qualified; a missing tenant-wide setting is recreated by hand from its template'),
    lost('relationship', 'group-scoped settings', 'settings under /groups/{id}/settings are not collected or written'),
  ]),
  directorySettingTemplate: Object.freeze([
    lost('configuration', 'template catalogue', 'Microsoft-published and identical in every tenant; never written'),
  ]),
  organization: Object.freeze([
    lost('configuration', 'tenant object', 'the tenant itself is never recreated or written'),
  ]),
  domain: Object.freeze([
    lost('configuration', 'domains', 'adding a domain needs DNS ownership verification outside Graph'),
  ]),
  subscribedSku: Object.freeze([
    lost('configuration', 'licences', 'licences are purchased, not configured'),
  ]),
  // Issue #156.
  organizationalBranding: Object.freeze([
    lost('configuration', 'header logo', 'not backed up; only its file path is kept'),
    lost('configuration', 'a file the backup did not have', 'a logo, image or stylesheet that was not set, too large (over 1 MB) or unreadable at backup time is never removed or written; the live one is kept'),
    lost('configuration', 'content customization', 'it nests uploaded-file paths beside its text, so it is backed up but never written'),
    lost('configuration', 'missing branding', 'a tenant with no branding gets none from KEEL; it is set up by hand'),
  ]),
  organizationalBrandingLocalization: Object.freeze([
    lost('configuration', 'header logo of each language', 'not backed up; only its file path is kept'),
    lost('configuration', 'added or removed languages', 'create and delete are not qualified; a missing language is added by hand'),
  ]),
  groupLifecyclePolicy: Object.freeze([
    lost('configuration', 'shorter lifetime, wider scope or fewer notice addresses', 'could expire and delete groups, so the restore is refused and left to a person'),
    lost('relationship', 'selected groups', 'which groups a Selected policy covers is changed through addGroup and removeGroup, which are not written'),
    lost('configuration', 'missing policy', 'create and delete are not qualified; a missing policy is recreated by hand'),
  ]),
  // Remaining kinds, batch 7.
  sharepointSettings: Object.freeze([
    lost('configuration', 'loosened access', 'a backup that turns legacy authentication on, lets unmanaged devices sync or drops the guest account match is withheld for a person'),
  ]),
  itemInsightsSettings: Object.freeze([
    lost('configuration', 'item insights setting', 'no writer yet; set by hand from the backup'),
    lost('relationship', 'disabledForGroup', 'names a group by id; the group is rebuilt first'),
  ]),
  externalConnection: Object.freeze([
    lost('configuration', 'connection', 'no writer yet; recreated by hand from the backup'),
    lost('relationship', 'schema and items', 'read per connection and not backed up; the connector syncs its items again'),
  ]),
  // Remaining kinds, batch 8.
  securityZone: Object.freeze([
    lost('configuration', 'zone', 'no writer yet; recreated by hand from the backup'),
    lost('relationship', 'environments', 'read per zone and not backed up; added to the zone again by hand'),
  ]),
  sharedEmailDomain: Object.freeze([
    lost('configuration', 'shared domain', 'Microsoft provisions it; there is nothing to write'),
  ]),
  schemaExtension: Object.freeze([
    lost('configuration', 'extension definition', 'no writer yet; created again by hand with the same id, owner app and properties'),
    lost('relationship', 'values stored on users and groups', 'the values live on each object, not in the definition, and are not restored'),
  ]),
});

/** The compact batch record the coverage report and portal show for one type. */
export function expansionFor(resourceType) {
  const entry = EXPANSION_INVENTORY[resourceType];
  if (!entry) return null;
  const batch = EXPANSION_BATCHES.find((candidate) => candidate.id === entry.batch);
  return Object.freeze({
    batch: entry.batch,
    batchLabel: batch?.label ?? entry.batch,
    status: entry.status,
    restoreScope: restoreScopeFor(resourceType),
    // Roadmap task-108: the subtypes registered operations are limited to
    // (e.g. custom authentication strengths), read from the registry.
    qualifiedSubtypes: qualifiedSubtypesFor(resourceType),
    // Roadmap task-109: null when the type has not been assessed.
    unrecoverable: UNRECOVERABLE_CONFIGURATION[resourceType] ?? null,
    reason: entry.reason,
  });
}

/** Distinct subtypes the type's registered operations are bound to; [] when none is. */
export function qualifiedSubtypesFor(resourceType) {
  const subtypes = OPERATIONS
    .map((operation) => capabilityFor(resourceType, operation))
    .filter((capability) => isSupportedClaim(capability.claim) && typeof capability.subtype === 'string')
    .map((capability) => capability.subtype);
  return Object.freeze([...new Set(subtypes)].sort());
}

// ---- write-path contracts for the task-107 subset

/**
 * Fields a create body never carries for a type, beyond the server-owned ones:
 * identifiers Entra assigns and credential material KEEL cannot read back.
 */
export const CREATE_EXCLUDED_FIELDS = Object.freeze({
  // createdByAppId names the app that created the object; Graph sets it and refuses
  // a create that sends it (live Q48, 2026-10-14).
  application: Object.freeze(['appId', 'publisherDomain', 'passwordCredentials', 'keyCredentials', 'createdByAppId']),
  // Roadmap task-108: computed by Entra from allowedCombinations; never sent.
  authenticationStrengthPolicy: Object.freeze(['policyType', 'requirementsSatisfied']),
  servicePrincipal: Object.freeze([
    'appDisplayName', 'appOwnerOrganizationId', 'servicePrincipalNames', 'servicePrincipalType',
    'signInAudience', 'appRoles', 'oauth2PermissionScopes', 'passwordCredentials', 'keyCredentials',
  ]),
});

/** The identifiers a created object reports beyond its object id, by type. */
export const ALTERNATE_IDENTIFIERS = Object.freeze({ application: Object.freeze(['appId']) });

/**
 * References the snapshot's GUID walk cannot see, declared explicitly. A
 * service principal points at its application by appId, not by object id;
 * the application's natural key is that appId, so the symbol is derived from
 * the payload. `identifier` says which of the target's identifiers the field
 * holds.
 */
export const EXPLICIT_REFERENCES = Object.freeze({
  servicePrincipal: Object.freeze([Object.freeze({ field: 'appId', targetType: 'application', identifier: 'appId' })]),
});

/** The resource's references plus its explicit ones (never duplicating a field). */
export function withExplicitReferences(resource) {
  const declared = EXPLICIT_REFERENCES[resource?.resourceType];
  const references = resource?.references ?? [];
  if (!declared || !resource.payload) return references;
  const extra = [];
  for (const ref of declared) {
    const value = resource.payload[ref.field];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (references.some((existing) => existing.field === ref.field)) continue;
    extra.push({ field: ref.field, symbol: `${ref.targetType}:${value}`, required: true, identifier: ref.identifier });
  }
  return extra.length === 0 ? references : [...references, ...extra];
}
