/**
 * Gap register P4: docs/coverage.md, generated from code so it cannot drift.
 *
 * What is DERIVED from code (never typed here):
 *  - which configuration types exist and their family (buildOperationLedger,
 *    EXPANSION_INVENTORY);
 *  - each type's decision, automated or manual (TYPE_DECISIONS), and its coverage
 *    state and missing parts (completeness.mjs);
 *  - its backup tier and the default schedule of that tier (CATALOG, initialSchedules);
 *  - which restore operations are registered and the proof behind each, including
 *    recorded live failures (capabilities.mjs through the ledger);
 *  - the workloads, the settings each one reads and the writes each one declares
 *    (workloadContract.mjs, WORKLOAD_WRITE_OPERATIONS).
 *
 * What is WRITTEN here, by hand: the plain-English name of each type and, for
 * manual and partial types, why and what the reader should do.
 * The code's own reasons carry task numbers, API field names and HTTP details, so
 * they are not shown to readers. Each guide entry names the decision it was written
 * for; renderCoverageDoc() throws when the code's decision differs, or when a type
 * has no entry, so a changed or new type forces its text to be reviewed.
 *
 * Deterministic: no clock, no environment, no tenant. Same code, same bytes.
 *   node tools/coverage-doc.mjs           # rewrite docs/coverage.md
 *   node tools/coverage-doc.mjs --check   # exit 1 when the committed file is stale
 */
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { WORKLOADS, WORKLOAD_DESCRIPTORS } from '../collect/workloadContract.mjs';
import { initialSchedules } from '../store/scheduleSeed.mjs';
import { COVERAGE_STATES, REASON_WORDS } from './completeness.mjs';
import { EXPANSION_BATCHES, EXPANSION_INVENTORY, WORKLOAD_WRITE_OPERATIONS, buildOperationLedger } from './qualification.mjs';

const MS = 'microsoft';
const KEEL = 'keel';
// Coverage plan v3: backed up in full, but the best-effort writer is not built yet.
const NOT_BUILT = 'not-built';
const LIMIT_WORDS = Object.freeze({ [MS]: 'Microsoft limit', [KEEL]: 'KEEL choice', [NOT_BUILT]: 'not built yet' });
const STATE_WORDS = Object.freeze({
  full: 'Full', incomplete: 'Incomplete', 'microsoft-managed': 'Microsoft-managed', 'not-readable': 'Not readable',
});

const auto = (name, { keeps, todo = null } = {}) => Object.freeze({ decision: 'automated', name, keeps, todo });
const manual = (name, limit, why, todo) => Object.freeze({ decision: 'manual', name, limit, why, todo });

/**
 * One entry per configuration type. `limit` says whose limit makes a manual type
 * manual: MS (Microsoft offers no way for any tool to do it) or KEEL (a safety or
 * scope choice KEEL made). `keeps` is what an automated restore covers; `todo` is
 * what is left to the reader.
 */
export const TYPE_GUIDE = Object.freeze({
  // ---- tenant settings
  organization: manual('Tenant profile', MS,
    'This is the tenant itself. Microsoft does not let any tool recreate or replace it.',
    'Nothing to restore. Use the backup as a record of the tenant details at that time.'),
  domain: manual('Domains', MS,
    'Adding a domain needs proof that you own it, through a DNS record that only you can publish.',
    'Add the domain in the Microsoft 365 admin center, publish the DNS record it asks for, and verify it. Domains must be back before users and mail that use them.'),
  subscribedSku: manual('Licence subscriptions', MS,
    'Licences are bought from Microsoft, not configured.',
    'Use the backup to see which licences you had and how many. Buy or reactivate them before restoring users, because a user restore can only assign licences you hold.'),
  directorySettingTemplate: manual('Group setting templates', MS,
    'Microsoft publishes these templates. They are the same in every tenant and nobody can edit them.',
    'Nothing to restore.'),
  groupSetting: auto('Tenant-wide group settings', {
    keeps: 'Puts changed tenant-wide group settings back, and removes ones added since the backup.',
    todo: 'A setting that was deleted, and settings on a single group, are recreated by hand from the backup.',
  }),
  organizationalBranding: auto('Company branding', {
    keeps: 'Puts the sign-in page text, colours and layout back, and uploads the background image, banner logo, square logos, favicon and custom stylesheet again when they changed (tested against a simulated tenant only).',
    todo: 'The header logo, and any file that was not set or was over 1 MB at backup time, are uploaded by hand in the Entra admin center. A tenant with no branding gets none from KEEL.',
  }),
  organizationalBrandingLocalization: auto('Company branding per language', {
    keeps: 'Puts the sign-in page text, colours and layout of each existing language back, and uploads its images and stylesheet again when they changed (tested against a simulated tenant only).',
    todo: 'The header logo is uploaded by hand, and a language that was added or removed is added or removed by hand.',
  }),
  groupLifecyclePolicy: auto('Group expiration policy', {
    keeps: 'Puts the policy back only when that makes group expiry less aggressive.',
    todo: 'A shorter lifetime, more groups covered or a removed notice address could expire and delete groups, so KEEL leaves that change to a person. A missing policy, and the list of groups it covers, are set by hand.',
  }),
  administrativeUnit: auto('Administrative units', {
    keeps: 'Puts the name and description back.',
    todo: 'Members, admins scoped to the unit, dynamic membership rules and a deleted unit are restored by hand from the backup.',
  }),

  // ---- users, groups, apps and admin roles
  user: auto('Users', {
    keeps: 'Puts reviewed user details back, brings deleted users back from the recycle bin, adds missing licences, and recreates a permanently deleted user with sign-in off and a checklist of what the person needs.',
    todo: 'A recreated user needs a new password or Temporary Access Pass and must register MFA again, because Microsoft never lets anyone read them; KEEL lists these as follow-up items and leaves sign-in off until then. Users synced from on-premises Active Directory are restored there, and guests are invited again.',
  }),
  group: auto('Groups', {
    keeps: 'Recreates groups, puts their settings back, removes groups added since the backup, brings deleted groups back, and restores members and owners.',
  }),
  contact: manual('Organizational contacts', MS,
    'These contacts come from directory sync, and Microsoft makes them read-only for every tool.',
    'Restore them at their source, usually on-premises Active Directory or Exchange, and let sync bring them back.'),
  application: auto('App registrations', {
    keeps: 'Recreates app registrations, puts their settings back, and brings deleted ones back from the recycle bin.',
    todo: 'Microsoft never lets anyone read client secrets or certificates, so after a recreate create new ones and update every service that used them. KEEL lists these as follow-up items. Removing extra apps is done by hand.',
  }),
  servicePrincipal: auto('Enterprise apps', {
    keeps: 'Recreates an enterprise app for its app registration, puts reviewed settings back on an existing one, and removes an app added since the backup.',
    todo: 'Whether an app can sign in is shown as a difference and changed by hand. Enterprise apps for Microsoft services and managed identities are never removed by KEEL.',
  }),
  oauth2PermissionGrant: auto('Delegated app consents', {
    keeps: 'Grants delegated consent again with the permissions the backup had, as part of an approved restore, and changes a consent back. A re-run never adds a second consent.',
    todo: 'Removing a consent added since the backup is done by hand. A consent for an app that was recreated in the same restore is granted by hand.',
  }),
  identityProvider: manual('External identity providers', MS,
    'Microsoft never lets anyone read the client secret of an identity provider.',
    'Recreate the provider in the Entra admin center using the settings in the backup, and enter a fresh secret from the provider.'),
  certificateBasedAuthConfiguration: manual('Certificate sign-in settings', NOT_BUILT,
    'A wrong certificate trust setting can lock everyone out, and KEEL has no safe way to test the change first.',
    'Restore the certificate authorities by hand in the Entra admin center using the backup, and test sign-in before closing the session.'),
  directoryRole: manual('Built-in admin roles', MS,
    'Microsoft provides the built-in roles. They are switched on from Microsoft\'s templates, never written.',
    'Nothing to restore. Who holds each role is restored with role assignments.'),
  roleDefinition: auto('Custom admin roles', {
    keeps: 'Recreates custom roles and puts their permissions back. The dry run lists permissions a restore adds and removes.',
    todo: 'Built-in roles cannot be changed by anyone. Custom roles need an Entra ID P1 or P2 licence. Removing extra custom roles is done by hand.',
  }),
  directoryRoleTemplate: manual('Admin role templates', MS,
    'Microsoft publishes these templates. They are the same in every tenant.',
    'Nothing to restore.'),
  roleAssignment: auto('Admin role assignments', {
    keeps: 'Recreates admin role assignments, changes them back and removes ones added since the backup.',
  }),
  roleEligibilitySchedule: auto('Eligible admin roles', {
    keeps: 'Makes people eligible for an admin role again, keeping the original end date.',
    todo: 'Expired eligibilities and ones inherited through a group are not restored. Changing or removing an eligibility is done by hand.',
  }),
  roleAssignmentSchedule: manual('Time-limited active admin roles', NOT_BUILT,
    'Restoring a time-limited active role safely needs an expiry check and a guard against replaying a past activation. That is not built yet. Permanent assignments are covered by admin role assignments.',
    'Use the backup to see who held which role until when, then assign it again in Privileged Identity Management.'),
  unifiedRoleManagementPolicy: auto('Admin role activation settings', {
    keeps: 'Puts activation rules back: how long a role lasts, what activation needs, and who approves.',
    todo: 'A restore that would weaken protection is not written: KEEL lists it for a person to decide. Approvers must still exist.',
  }),
  unifiedRoleManagementPolicyAssignment: manual('Role-to-settings links', MS,
    'Entra links exactly one settings policy to each role itself. Nobody writes the link.',
    'Nothing to restore. The settings are restored with admin role activation settings.'),
  accessReviewScheduleDefinition: manual('Access reviews', NOT_BUILT,
    'The history and decisions of past reviews cannot be recreated by anyone. Only the review setup could be, and KEEL has not built that yet.',
    'Recreate the review in the Entra admin center using the setup in the backup. Keep the backup as the record of past decisions.'),
  accessPackage: manual('Access packages', NOT_BUILT,
    'An access package depends on its catalog, policies and resource roles, which are backed up but not restored yet.',
    'Recreate the package in Entra ID Governance using the backup as a guide, starting with its catalog.'),
  connectedOrganization: manual('Connected organizations', NOT_BUILT,
    'These point to other organizations\' tenants, which KEEL cannot check from yours.',
    'Recreate them by hand in Entra ID Governance using the backup.'),
  lifecycleWorkflow: auto('Lifecycle workflows', {
    keeps: 'Recreates workflows with their tasks and puts their settings back. A recreated workflow is always off.',
    todo: 'A restore never turns a workflow on. Check who it applies to, then turn it on in Entra ID Governance.',
  }),
  lifecycleWorkflowCustomTaskExtension: auto('Lifecycle workflow extensions', {
    keeps: 'Recreates extensions and puts their settings back.',
    todo: 'Make sure the Logic App each extension calls still exists in its Azure subscription.',
  }),
  lifecycleManagementSettings: auto('Lifecycle workflow settings', {
    keeps: 'Puts the settings back.',
  }),
  attributeSet: auto('Custom security attribute sets', {
    keeps: 'Puts the description and size limit of an existing set back.',
    todo: 'An attribute set can never be deleted once it exists, so a missing one is recreated by hand after a review, in the Entra admin center.',
  }),
  customSecurityAttributeDefinition: auto('Custom security attributes', {
    keeps: 'Puts the description and status of an existing attribute back, and adds or turns off its allowed values.',
    todo: 'An attribute can never be deleted once it exists, so a missing one is recreated by hand after a review, inside its attribute set. Values assigned to users and apps are not backed up.',
  }),
  accessPackageCatalog: auto('Access package catalogs', {
    keeps: 'Recreates catalogs and puts their settings back.',
    todo: 'The groups, apps and sites a catalog holds are not backed up yet, so add them again by hand.',
  }),
  accessPackageAssignmentPolicy: manual('Access package policies', NOT_BUILT,
    'A policy belongs to an access package, and access packages are not restored yet.',
    'Recreate the access package first, then its policies, using the backup.'),
  accessPackageAssignment: manual('Access package assignments', NOT_BUILT,
    'Access is granted through a request against a policy, never copied, and access packages are not restored yet.',
    'Use the backup to see who held which access package, then assign it again in Entra ID Governance.'),
  entitlementManagementSettings: auto('Entitlement management settings', {
    keeps: 'Puts the settings back.',
  }),
  agreement: manual('Terms of use', NOT_BUILT,
    'The agreement documents are files that are not backed up yet, and nobody can recreate who accepted them.',
    'Upload the documents again and recreate the terms of use in the Entra admin center using the backup. Users will be asked to accept again.'),
  b2xIdentityUserFlow: manual('Guest sign-up user flows', NOT_BUILT,
    'The languages, attributes and API connectors a flow uses are not backed up yet.',
    'Recreate the user flow in the Entra admin center using the backup.'),
  identityApiConnector: manual('API connectors for user flows', NOT_BUILT,
    'The password or certificate a connector uses can never be read back.',
    'Recreate the connector using the backup, and enter its password or certificate again.'),
  customAuthenticationExtension: manual('Custom authentication extensions', NOT_BUILT,
    'KEEL backs these up but does not restore them yet.',
    'Recreate the extension in the Entra admin center from the backup, then check that its endpoint still answers. Sign-ins and workflows that call it need it back first.'),
  accessPackageResourceRoleScope: manual('Access package resource roles', NOT_BUILT,
    'A role can only be added once its group, app or site is in the package\'s catalog, and access packages are not restored yet.',
    'Recreate the access package first, then add the same groups, apps and sites with the roles in the backup.'),
  synchronizationJob: manual('Provisioning and cross-tenant sync jobs', NOT_BUILT,
    'A job\'s attribute mappings are stored separately, its sign-in details can never be read back, and a running job changes accounts in another directory.',
    'Set up provisioning again on the enterprise app using the backup as a guide, check its mappings, then start it.'),

  // ---- sign-in and security policies
  conditionalAccessPolicy: auto('Conditional Access policies', {
    keeps: 'Recreates policies, puts their settings back, removes ones added since the backup, and brings deleted ones back. Every write lands in report-only mode.',
    todo: 'Turning a restored policy on is a separate, approved step that first checks the break-glass accounts can still sign in.',
  }),
  authenticationStrengthPolicy: auto('Authentication strengths', {
    keeps: 'Recreates custom authentication strengths and puts their settings back.',
    todo: 'Built-in strengths cannot be changed by anyone. A change to the allowed sign-in method combinations is reported, not restored: set it by hand. Removing extra strengths is done by hand.',
  }),
  namedLocation: auto('Named locations', {
    keeps: 'Recreates named locations, puts their settings back and removes ones added since the backup.',
  }),
  authenticationContextClassReference: manual('Authentication contexts', NOT_BUILT,
    'Each context has a fixed slot that Conditional Access policies and SharePoint labels point to. KEEL cannot yet check what uses a slot before changing it.',
    'Restore the name and description by hand in the Entra admin center, keeping each one in the same slot as in the backup.'),
  authenticationMethodsPolicy: auto('Authentication methods', {
    keeps: 'Puts the authentication methods policy and each method\'s settings back, only when the break-glass accounts can still sign in afterwards.',
    todo: 'A method that no longer exists in your tenant is not added back.',
  }),
  identitySecurityDefaultsEnforcementPolicy: auto('Security defaults', {
    keeps: 'Turns security defaults on or off as in the backup, only when the break-glass accounts can still sign in afterwards.',
  }),
  authorizationPolicy: auto('User and guest permissions', {
    keeps: 'Puts guest invitation, self-service, consent and default user permission settings back, only when the break-glass accounts can still sign in afterwards.',
  }),
  crossTenantAccessPolicy: auto('Cross-tenant access', {
    keeps: 'Puts the list of allowed Microsoft clouds back.',
  }),
  crossTenantAccessPolicyConfigurationDefault: auto('Cross-tenant access defaults', {
    keeps: 'Puts the default guest collaboration, direct connect and inbound trust settings back.',
  }),
  crossTenantAccessPolicyPartner: auto('Cross-tenant access per organization', {
    keeps: 'Recreates partner organization settings and puts their settings back.',
    todo: 'A partner tenant that no longer exists cannot be added. Removing extra partners is done by hand.',
  }),
  deviceRegistrationPolicy: manual('Device join and registration settings', KEEL,
    'These settings decide who may join devices and whether joining needs MFA. A wrong write could stop admins joining devices or quietly drop the MFA requirement, so KEEL only backs them up.',
    'Compare the backup with the current settings in the Entra admin center under Devices, and change them there.'),
  authenticationFlowsPolicy: auto('External user self sign-up', {
    keeps: 'Puts back whether external users may sign themselves up.',
    todo: 'The sign-up user flows themselves are restored by hand (see guest sign-up user flows).',
  }),
  permissionGrantPolicy: auto('App consent policies', {
    keeps: 'Recreates custom app consent policies and puts their name and description back. When the backup holds their include and exclude rules, it puts those back and removes rules added since the backup (tested against a simulated tenant only).',
    todo: 'Microsoft\'s built-in policies cannot be changed by anyone. Rules the backup does not hold yet are set by hand.',
  }),
  adminConsentRequestPolicy: auto('Admin consent requests', {
    keeps: 'Puts the admin consent request workflow back, including who reviews requests.',
  }),
  activityBasedTimeoutPolicy: manual('Idle sign-out policy', NOT_BUILT,
    'The whole policy is backed up, but KEEL does not yet tell a tenant-wide policy from one set on a single app, so it has no safe restore yet.',
    'Recreate the policy by hand using the backup.'),
  claimsMappingPolicy: auto('Token claims mapping', {
    keeps: 'Recreates the policy and puts its name and settings back (tested against a simulated tenant only).',
    todo: 'Which apps use the policy is set again by hand. A policy that was the organization default comes back as an ordinary one; make it the default again by hand after checking it.',
  }),
  homeRealmDiscoveryPolicy: auto('Sign-in routing (home realm discovery)', {
    keeps: 'Recreates the policy and puts its name and settings back (tested against a simulated tenant only).',
    todo: 'Which apps use the policy is set again by hand. A policy that was the organization default comes back as an ordinary one; make it the default again by hand after checking it. Test a federated sign-in after the restore.',
  }),
  tokenIssuancePolicy: auto('Token issuance policy', {
    keeps: 'Recreates the policy and puts its name and settings back (tested against a simulated tenant only).',
    todo: 'Which apps use the policy is set again by hand. A policy that was the organization default comes back as an ordinary one; make it the default again by hand after checking it.',
  }),
  tokenLifetimePolicy: auto('Token lifetime policy', {
    keeps: 'Recreates the policy and puts its name and settings back (tested against a simulated tenant only).',
    todo: 'Which apps use the policy is set again by hand. A policy that was the organization default comes back as an ordinary one; make it the default again by hand after checking it.',
  }),
  featureRolloutPolicy: manual('Staged rollout of sign-in features', NOT_BUILT,
    'Which groups a rollout covers is stored separately, and KEEL has not built a safe writer for it.',
    'Recreate the rollout by hand using the backup, then add the same groups.'),
  appManagementPolicy: auto('App credential policies', {
    keeps: 'Recreates the policies and puts their rules back.',
    todo: 'Which apps each policy applies to is not backed up yet, so assign the policies again by hand.',
  }),
  tenantAppManagementPolicy: manual('Default app credential rules', NOT_BUILT,
    'A stricter default can stop every app from adding a secret or certificate, so KEEL will not write it without a review step, which is not built yet.',
    'Set the default rules again in the Entra admin center using the backup.'),
  multiTenantOrganization: auto('Multitenant organization', {
    keeps: 'Puts the name and description back.',
    todo: 'Member tenants and their acceptance are set by each tenant, so add or re-invite them by hand.',
  }),
  crossTenantIdentitySyncPolicyPartner: manual('Cross-tenant sync per organization', NOT_BUILT,
    'These settings let a partner tenant sync its users into yours, so KEEL will not write them without a review step, which is not built yet.',
    'Set the partner\'s sync settings again in the Entra admin center under cross-tenant access settings, using the backup.'),

  // ---- Intune device management
  deviceConfiguration: auto('Device configuration profiles', {
    keeps: 'Recreates profiles, puts their settings and assignments back, and removes an unassigned profile added since the backup.',
    todo: 'Profiles that carry passwords or certificates (Wi-Fi, VPN, certificate, email), and any value Microsoft never returns, are finished by hand. A profile added since the backup that is still assigned is removed by hand.',
  }),
  deviceCompliancePolicy: auto('Device compliance policies', {
    keeps: 'Recreates policies, with their actions for noncompliant devices, puts their settings and assignments back, and removes an unassigned policy added since the backup.',
    todo: 'A policy added since the backup that is still assigned is removed by hand.',
  }),
  configurationPolicy: auto('Settings catalog policies', {
    keeps: 'Recreates policies, puts their settings and assignments back, and removes an unassigned policy added since the backup.',
    todo: 'Secret settings are never returned by Microsoft, so enter them again by hand. A policy added since the backup that is still assigned is removed by hand.',
  }),
  deviceEnrollmentConfiguration: manual('Enrollment restrictions', MS,
    'The default restrictions exist in every tenant and cannot be created by anyone, and the order of custom ones is set by a separate action KEEL does not write.',
    'Restore by hand in the Intune admin center from the backup, which includes each restriction\'s assignments and order.'),
  deviceManagementRoleDefinition: manual('Intune admin roles', KEEL,
    'These roles decide who can manage devices, so a change needs a person to review it. Who holds each role is backed up as Intune admin role assignments.',
    'Review the roles in the backup and recreate them in the Intune admin center, then assign them again.'),
  deviceCategory: auto('Device categories', {
    keeps: 'Recreates categories and puts their names and descriptions back.',
    todo: 'Devices are put in a category when they enroll, which no restore can redo. Devices pick it up at their next enrollment, or an admin sets it on each device.',
  }),
  termsAndConditions: manual('Terms and conditions', MS,
    'Who accepted cannot be recreated: a recreated policy asks every user to accept again.',
    'Recreate the terms by hand from the backup and tell users they will be asked to accept again.'),
  windowsAutopilotDeploymentProfile: manual('Windows Autopilot profiles', KEEL,
    'Microsoft offers these only through a preview API, and a profile applies to registered device hardware that KEEL does not back up.',
    'Recreate the profile by hand from the backup, which includes its assignments.'),
  deviceManagementIntent: manual('Security baselines (older format)', KEEL,
    'This older format is preview-only and replaced by the settings catalog, and its settings are stored separately and not backed up.',
    'Rebuild the baseline in the settings catalog. KEEL restores settings catalog policies.'),
  managedDevice: manual('Enrolled devices', MS,
    'A device record is created by the device when it enrolls. It is state, not configuration.',
    'Nothing to restore. Devices enroll again on their own once enrollment settings are back.'),
  mobileApp: manual('Apps', KEEL,
    'App packages are content, not configuration, and KEEL does not back them up.',
    'Add the apps again in the Intune admin center from their store or package, using the backup as the list.'),
  managedAppPolicy: auto('App protection policies', {
    keeps: 'Puts the settings of iOS and Android app protection policies back, recreates them when the backup holds their protected apps, and removes an unassigned policy added since the backup.',
    todo: 'The list of protected apps is not backed up yet, so a missing policy is recreated by hand until it is. Windows protection policies are restored by hand.',
  }),
  targetedManagedAppConfiguration: auto('Managed app configuration', {
    keeps: 'Puts the settings back, recreates a configuration when the backup holds its apps, and removes an unassigned one added since the backup.',
    todo: 'The apps it targets are not backed up yet, so a missing configuration is recreated by hand until they are.',
  }),
  mobileAppConfiguration: auto('App configuration for managed devices', {
    keeps: 'Recreates configurations and puts their settings back when the app they configure exists, and removes an unassigned one added since the backup.',
    todo: 'Add the app first. Values Microsoft never returns are entered again by hand.',
  }),
  // Wave 1: backed up, no restore built yet.
  deviceManagementScript: manual('Windows PowerShell scripts', NOT_BUILT,
    'KEEL backs these up but does not restore them yet.',
    'Recreate the script in the Intune admin center from the backup, then assign it to the groups and schedule in the backup.'),
  deviceShellScript: manual('macOS shell scripts', NOT_BUILT,
    'KEEL backs these up but does not restore them yet.',
    'Recreate the script in the Intune admin center from the backup, then assign it to the groups and schedule in the backup.'),
  deviceHealthScript: manual('Remediations', NOT_BUILT,
    'KEEL backs these up but does not restore them yet. Remediations published by Microsoft are not yours to restore.',
    'Recreate your own remediations in the Intune admin center from the backup, then assign them to the groups and schedule in the backup.'),
  deviceComplianceScript: manual('Custom compliance scripts', NOT_BUILT,
    'KEEL backs these up but does not restore them yet.',
    'Recreate the script in the Intune admin center from the backup. Compliance policies that use it need it back first.'),
  assignmentFilter: auto('Assignment filters', {
    keeps: 'Recreates filters and puts their rules back.',
    todo: 'A filter is never moved to another platform; recreate it by hand if its platform changed.',
  }),
  roleScopeTag: auto('Scope tags', {
    keeps: 'Recreates your own tags and puts their names back.',
    todo: 'The built-in Default tag exists in every tenant and is never written.',
  }),
  windowsFeatureUpdateProfile: auto('Windows feature update profiles', {
    keeps: 'Recreates profiles, puts their settings back, and removes an unassigned profile added since the backup.',
    todo: 'Who a profile is assigned to is backed up but not put back yet, so assign it again by hand from the backup.',
  }),
  windowsQualityUpdateProfile: auto('Windows quality update profiles', {
    keeps: 'Recreates profiles, puts their settings back, and removes an unassigned profile added since the backup.',
    todo: 'Who a profile is assigned to is backed up but not put back yet, so assign it again by hand from the backup.',
  }),
  windowsDriverUpdateProfile: auto('Windows driver update profiles', {
    keeps: 'Recreates profiles, puts their settings back, and removes an unassigned profile added since the backup.',
    todo: 'Driver approvals are not backed up yet, so approve the drivers again by hand. Who a profile is assigned to is backed up but not put back yet, so assign it again by hand from the backup.',
  }),
  groupPolicyConfiguration: manual('Administrative templates', NOT_BUILT,
    'KEEL backs up each template and its settings but does not restore them yet. The values entered for each setting are not backed up.',
    'Recreate the template in the Intune admin center, using the backup for which settings were turned on and who it was assigned to.'),
  groupPolicyUploadedDefinitionFile: manual('Imported administrative template files', NOT_BUILT,
    'KEEL backs up the list of imported files but does not restore them yet. The file content is not backed up.',
    'Import the files again in the Intune admin center from your own copy.'),
  notificationMessageTemplate: auto('Compliance notification emails', {
    keeps: 'Recreates templates and puts their settings and the message text for each language back.',
  }),
  windowsAutopilotDeviceIdentity: manual('Windows Autopilot devices', MS,
    'Microsoft never returns the hardware hash that registers a device, so no tool can register it again from a backup.',
    'Use the backup as the list of devices. Import each device again from its hardware hash, taken on the device or from your vendor.'),
  deviceManagementRoleAssignment: manual('Intune admin role assignments', KEEL,
    'These decide who can manage devices, so a change needs a person to review it.',
    'Review who held each Intune admin role in the backup and assign the roles again in the Intune admin center.'),
  applePushNotificationCertificate: manual('Apple push certificate', MS,
    'Apple issues this certificate. No tool can upload it from a backup, and a new certificate from a different Apple ID cuts off every Apple device.',
    'Use the backup for the Apple ID and expiry date. Renew the certificate at Apple with that same Apple ID and upload it in the Intune admin center before it expires.'),
  mobileThreatDefenseConnector: manual('Mobile threat defense connectors', NOT_BUILT,
    'KEEL backs these up but does not restore them yet. The connection is completed from the partner\'s console.',
    'Set up the connector again from the partner\'s console, then turn on the settings the backup shows. Compliance policies that use the partner\'s threat level need it back first.'),
  deviceManagementPartner: manual('Device management partners', NOT_BUILT,
    'KEEL backs these up but does not restore them yet. The connection is completed from the partner\'s console.',
    'Connect the partner again from its console, using the backup for the settings.'),
  complianceManagementPartner: manual('Compliance partners', NOT_BUILT,
    'KEEL backs these up but does not restore them yet. The connection is completed from the partner\'s console.',
    'Connect the partner again from its console, using the backup for the settings and the groups it applies to.'),
  remoteAssistancePartner: manual('Remote help partners', NOT_BUILT,
    'KEEL backs these up but does not restore them yet. Onboarding is completed from the partner\'s console.',
    'Onboard the partner again from its console, using the backup for the settings.'),
  deviceManagementExchangeConnector: manual('Exchange on-premises connectors', MS,
    'The connector is a program installed on an Exchange server. No tool can install it from a backup.',
    'Use the backup for the server and settings. Download the connector from the Intune admin center and install it on that server again.'),
  onPremisesConditionalAccessSettings: manual('Exchange on-premises access settings', NOT_BUILT,
    'KEEL backs these up but does not restore them yet.',
    'Put the settings back in the Intune admin center from the backup.'),
  mobileAppCategory: manual('App categories', NOT_BUILT,
    'KEEL backs these up but does not restore them yet. The built-in categories come with every tenant.',
    'Recreate your own categories in the Intune admin center from the backup, then add the apps to them again.'),
  intuneBrandingProfile: manual('Company Portal branding', NOT_BUILT,
    'KEEL backs up the branding settings but does not restore them yet. The logo images are not backed up.',
    'Recreate the branding in the Intune admin center from the backup, upload the logos from your own copy, and assign it to the groups in the backup.'),
  deviceManagementCompliancePolicy: manual('Settings catalog compliance policies', NOT_BUILT,
    'KEEL backs up the settings but does not restore them yet. The actions for noncompliance and who the policy is assigned to are not backed up yet.',
    'Recreate the policy in the Intune admin center from the backup, add its actions for noncompliance, and assign it again. Conditional Access that requires compliant devices needs it back first.'),
  deviceManagementReusablePolicySetting: auto('Reusable settings groups', {
    keeps: 'Recreates groups and puts their settings back, before the settings catalog policies that use them.',
    todo: 'A group is never moved to another setting definition; recreate it by hand if that changed.',
  }),
  policySet: manual('Policy sets', NOT_BUILT,
    'KEEL backs up each set\'s name and settings but not yet the apps and policies in it.',
    'Recreate the set in the Intune admin center, add the same apps and policies, and assign it again.'),
  vppToken: manual('Apple Volume Purchase tokens', MS,
    'Apple issues the token. No tool can upload it from a backup, and the token itself is never read.',
    'Use the backup for the Apple ID, organization and expiry. Download a new token from Apple Business Manager with that Apple ID and upload it in the Intune admin center.'),
  depOnboardingSetting: manual('Apple automated enrollment tokens', MS,
    'Apple issues the token. No tool can upload it from a backup, and Microsoft never returns the token file.',
    'Use the backup for the Apple ID and expiry. Download a new token from Apple Business Manager with that Apple ID, upload it in the Intune admin center, then recreate its enrollment profiles.'),
  androidManagedStoreAccountEnterpriseSettings: manual('Managed Google Play connection', MS,
    'The connection is made by signing in to Google. No tool can make it from a backup, and the enrollment codes are not backed up.',
    'Use the backup for the Google account and settings. Connect Managed Google Play again in the Intune admin center with that account, then turn on the same enrollment options.'),
  managedDeviceCleanupRule: auto('Device cleanup rules', {
    keeps: 'Puts a rule\'s settings back when that makes it wait as long or longer before retiring devices.',
    todo: 'A deleted rule, and a rule the backup has retiring devices sooner than now, are set by hand in the Intune admin center from the backup, because a shorter wait can retire devices at once.',
  }),
  windowsQualityUpdatePolicy: auto('Windows hotpatch update policies', {
    keeps: 'Recreates policies and puts their settings back.',
    todo: 'Who a policy is assigned to is not backed up yet, so assign it again by hand.',
  }),
  operationApprovalPolicy: manual('Multi admin approval policies', NOT_BUILT,
    'KEEL backs these up but does not restore them yet. They decide which changes need a second admin, so a person should review them.',
    'Recreate each policy in the Intune admin center from the backup, with the same approver groups.'),
  deviceCustomAttributeShellScript: manual('macOS custom attribute scripts', NOT_BUILT,
    'KEEL backs up the script settings but not yet the script body or who it is assigned to.',
    'Recreate the script in the Intune admin center from your own copy of the script, using the backup for its settings, and assign it again.'),
  externalIdentitiesPolicy: auto('External user leave settings', {
    keeps: 'Puts back whether external users can leave your organization themselves, and whether their data is removed when they do.',
  }),
  b2bManagementPolicy: manual('Guest invitation domain restrictions', NOT_BUILT,
    'KEEL backs up the allowed or blocked guest domains but does not restore them yet.',
    'Set the same allowed or blocked domains in the Entra admin center, under External collaboration settings, from the backup.'),
  servicePrincipalCreationPolicy: manual('App creation policies', NOT_BUILT,
    'KEEL backs up each policy\'s name and settings but not yet its include and exclude conditions.',
    'Recreate the policy with PowerShell from the backup, then add its conditions again. There is no admin center page for it.'),
  permissionGrantPreApprovalPolicy: manual('App permission pre-approval policies', NOT_BUILT,
    'KEEL backs these up but does not restore them yet.',
    'Recreate each policy with PowerShell from the backup. There is no admin center page for it.'),
  accessReviewPolicy: auto('Access review settings', {
    keeps: 'Puts back whether group owners can manage access reviews of their groups.',
  }),
  directoryRoleAccessReviewPolicy: auto('Admin role access review defaults', {
    keeps: 'Puts back the default settings of access reviews of admin roles.',
    todo: 'Reviews already running keep the settings they started with.',
  }),
  multiTenantOrganizationIdentitySyncPolicyTemplate: auto('Multitenant organization sync template', {
    keeps: 'Puts back the user sync settings a tenant gets when it joins your multitenant organization.',
    todo: 'Tenants that already joined keep their own settings; change those per organization.',
  }),
  multiTenantOrganizationPartnerConfigurationTemplate: auto('Multitenant organization access template', {
    keeps: 'Puts back the cross-tenant access settings a tenant gets when it joins your multitenant organization.',
    todo: 'Tenants that already joined keep their own settings; change those per organization.',
  }),
  identityUserFlowAttribute: manual('User flow attributes', NOT_BUILT,
    'KEEL backs up the custom attributes but does not restore them yet. The built-in attributes are set by Microsoft.',
    'Recreate each custom attribute in the Entra admin center, under External Identities, Custom user attributes, from the backup, before the user flows that collect it.'),
  authenticationEventListener: manual('Authentication event listeners', NOT_BUILT,
    'KEEL backs these up but does not restore them yet. Each one points to a custom authentication extension.',
    'Recreate the custom authentication extension first, then the listener with PowerShell from the backup, for the same apps.'),
  externalDomainFederation: manual('Guest SAML or WS-Fed sign-in', NOT_BUILT,
    'KEEL backs up each partner\'s federation settings and public signing certificate but does not restore them yet.',
    'Recreate the identity provider in the Entra admin center, under External Identities, All identity providers, from the backup, and check the partner\'s metadata is still current.'),
  exchangeRoleDefinition: manual('Exchange admin roles', NOT_BUILT,
    'KEEL backs up the custom roles but does not restore them yet. The built-in roles are set by Microsoft.',
    'Recreate each custom role with Exchange Online PowerShell from the backup, from the same parent role, before the role groups or apps that use it.'),
  exchangeRoleAssignment: manual('Exchange admin role assignments', NOT_BUILT,
    'KEEL backs up who holds each Exchange role and over which scope, but does not restore them yet. Admin access needs a privilege review first.',
    'Check the backup with the person who approves admin access, then add the role groups, people or apps again in the Exchange admin center, under Roles, Admin roles, or with Exchange Online PowerShell.'),
  exchangeCustomAppScope: manual('Exchange app access scopes', NOT_BUILT,
    'KEEL backs these up but does not restore them yet. They limit which mailboxes an app role reaches.',
    'Recreate each scope with Exchange Online PowerShell from the backup, before the app role assignments that use it. There is no admin center page for it.'),
  defenderRoleDefinition: manual('Defender admin roles', NOT_BUILT,
    'KEEL backs these up but does not restore them yet.',
    'Recreate each role in the Microsoft Defender portal, under System, Permissions, Microsoft Defender XDR, Roles, from the backup.'),
  defenderRoleAssignment: manual('Defender admin role assignments', NOT_BUILT,
    'KEEL backs up who holds each Defender role and for which data sources, but does not restore them yet. Admin access needs a privilege review first.',
    'Check the backup with the person who approves admin access, then add the assignments again in the Microsoft Defender portal, under the role, Assignments.'),
  defenderCustomAppScope: manual('Defender app access scopes', NOT_BUILT,
    'KEEL backs these up but does not restore them yet.',
    'Recreate each scope with PowerShell from the backup, before the assignments that use it. There is no admin center page for it.'),
});

const FAMILY_HEADINGS = Object.freeze({
  'identity-application': 'Users, groups, apps and admin roles',
  policy: 'Sign-in and security policies',
  'administrative-configuration': 'Tenant settings',
  'device-management': 'Intune device management',
});

/** Workload guidance, keyed by WORKLOADS. Names and the hand step only. */
export const WORKLOAD_GUIDE = Object.freeze({
  'sharepoint-site-settings': Object.freeze({ name: 'SharePoint settings',
    todo: 'Settings KEEL does not restore are changed by hand in the SharePoint admin center using the backup.' }),
  'teams-settings': Object.freeze({ name: 'Teams settings and membership',
    todo: 'Settings KEEL does not restore are changed by hand in the Teams admin center using the backup.' }),
  'exchange-mailbox-settings': Object.freeze({ name: 'Exchange mailbox settings',
    todo: 'Settings KEEL does not restore are changed by hand in the Exchange admin center using the backup.' }),
  'onedrive-site-settings': Object.freeze({ name: 'OneDrive settings',
    todo: 'KEEL does not restore OneDrive settings. Change them by hand in the SharePoint admin center using the backup.' }),
  'purview-labels': Object.freeze({ name: 'Purview sensitivity labels',
    todo: 'KEEL only restores label names and tooltips, and adds labels back to a publishing policy. It never weakens a label or unpublishes one: those changes, and new labels, are made by hand in the Purview portal.' }),
  'exchange-mail-flow': Object.freeze({ name: 'Exchange mail flow and protection',
    todo: 'Domains, anti-spam, anti-phish, malware, DKIM, Safe Links and Safe Attachments policies, a rule turned on or off, and a deleted rule or connector are changed by hand in the Exchange admin center or Microsoft Defender portal using the backup. Any change to a mail flow rule other than its comment needs a second approver. Safe Links and Safe Attachments are backed up only when the tenant has Defender for Office 365.' }),
  'teams-org-policies': Object.freeze({ name: 'Teams organization policies',
    todo: 'Meeting policies are changed by hand in the Teams admin center using the backup, because Teams refuses changes to them from KEEL. Which users and groups a policy is assigned to, and settings KEEL does not restore, are changed by hand too. A deleted named messaging policy is recreated assigned to nobody. Turning transcription on for guests needs a second approver.' }),
  'purview-retention-dlp': Object.freeze({ name: 'Purview retention and data loss prevention',
    todo: 'Shorter retention, a deleting retention action and a released hold need a second approver; a preservation lock is never changed. A deleted policy or rule, and settings KEEL does not restore, are changed by hand in the Purview portal using the backup. Data loss prevention policies are backed up only when the tenant\'s licence includes it.' }),
  'exchange-extended': Object.freeze({ name: 'Exchange protection rules, address lists, mobile and retention settings',
    todo: 'A rule turned on or off, a deleted object, and settings KEEL does not restore are changed by hand in the Exchange admin center or Microsoft Defender portal using the backup. Any change to a spam, anti-phish or Safe Attachments rule other than its comment needs a second approver. Safe Links and Safe Attachments rules and the Defender preset rules are backed up only when the tenant has Defender for Office 365.' }),
  'teams-voice-policies': Object.freeze({ name: 'Teams calling, voice and live event policies',
    todo: 'The policies assigned to users and groups, and settings KEEL does not restore, are changed by hand in the Teams admin center using the backup. A deleted named policy is recreated assigned to nobody. A live event video provider\'s API token is never backed up: enter it again.' }),
  'purview-governance': Object.freeze({ name: 'Purview retention labels, auto-labeling and eDiscovery',
    todo: 'KEEL restores only a retention label\'s text and duration; a shorter duration needs a second approver. Deleted labels, auto-labeling and eDiscovery cases are recreated by hand in the Purview portal using the backup. eDiscovery cases are backed up as their settings and holds, never their searches or evidence. Auto-labeling and eDiscovery (Premium) are backed up only when the tenant\'s licence includes them.' }),
  'power-platform-settings': Object.freeze({ name: 'Power Platform and Power BI settings',
    todo: 'KEEL does not restore these yet. Change them by hand in the Power Platform admin center or the Fabric admin portal using the backup.' }),
});

const OPERATION_WORDS = Object.freeze({
  create: 'recreate if deleted',
  update: 'put changed settings back',
  delete: 'remove ones added since',
  'restore-soft-deleted': 'bring back from deleted items',
});
const OPERATION_NOUNS = Object.freeze({
  create: 'recreating', update: 'putting settings back', delete: 'removing extras', 'restore-soft-deleted': 'bringing back from deleted items',
  'edge-add': 'adding members or owners', 'edge-remove': 'removing members or owners',
});
// Product names keep their capital when a read's name is used mid-sentence.
const PROPER_START = /^(SharePoint|Exchange|OneDrive|Teams|DKIM|Safe|Microsoft)\b/;
const TIER_WORDS = Object.freeze({ tier1: 'Tier 1, critical', tier2: 'Tier 2, important', tier3: 'Tier 3, low impact' });
const EVERY = Object.freeze({ hour: 'every hour', day: 'daily', week: 'weekly' });
const WRITE_VERBS = Object.freeze({ update: 'Put back', add: 'Add back', remove: 'Remove extras from' });

function tierCadence() {
  const cadence = {};
  for (const row of initialSchedules(new Date('2000-01-01T00:00:00.000Z'))) {
    if (row.jobKind === 'collect') cadence[row.tier] = EVERY[row.cadence.every] ?? `every ${row.cadence.every}`;
  }
  return cadence;
}

const cell = (text) => String(text).replace(/\|/g, '\\|');
const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** The guide entry for a type, checked against the code's current decision. */
function guideFor(type, decision, guide) {
  const entry = guide[type];
  if (!entry) throw new Error(`docs/coverage.md: no plain-English entry for configuration type ${type}; add one to TYPE_GUIDE`);
  if (entry.decision !== decision) {
    throw new Error(`docs/coverage.md: the text for ${type} was written for '${entry.decision}' but the code now says '${decision}'; review TYPE_GUIDE`);
  }
  return entry;
}

function proofText(rows) {
  const failed = rows.filter((row) => row.live.result === 'failed');
  const proven = rows.filter((row) => row.live.result === 'qualified');
  const parts = [];
  if (proven.length === rows.length) parts.push('Proven on a live tenant');
  else if (proven.length > 0) parts.push(`Proven on a live tenant: ${list(proven.map((row) => OPERATION_NOUNS[row.operation]))}`);
  if (proven.length < rows.length) parts.push('Tested against a simulated tenant');
  for (const row of failed) parts.push(`live test of ${OPERATION_NOUNS[row.operation]} failed on ${row.live.failedAt}, fix in progress`);
  return parts.join('; ');
}

function typeRow(ledgerType, entry, { cadence, edges }) {
  const catalog = CATALOG.find((candidate) => candidate.type === ledgerType.resourceType);
  const tier = catalog?.criticality;
  const backup = tier ? `Yes (${TIER_WORDS[tier]}, ${cadence[tier]})` : 'Yes';
  let restore;
  let proof;
  if (ledgerType.decision === 'automated') {
    const supported = ledgerType.operations.filter((row) => row.decision === 'supported');
    const typeEdges = ledgerType.resourceType === 'group' ? edges.filter((row) => row.decision === 'supported') : [];
    const words = supported.map((row) => OPERATION_WORDS[row.operation]);
    if (typeEdges.length > 0) words.push('add and remove members and owners');
    restore = `Yes: ${words.join('; ')}`;
    proof = proofText([...supported, ...typeEdges]);
  } else {
    restore = ledgerType.completeness.state === 'microsoft-managed' ? 'Nothing to restore' : `By hand (${LIMIT_WORDS[entry.limit]})`;
    proof = 'None';
  }
  const coverage = STATE_WORDS[ledgerType.completeness.state];
  return `| ${cell(entry.name)} | ${cell(backup)} | ${cell(coverage)} | ${cell(restore)} | ${cell(proof)} |`;
}

/** The parts a restore cannot bring back, with why, after the setting itself. */
function missingLines(ledgerType) {
  const parts = ledgerType.completeness.missing.filter((item) => item.part !== 'The whole setting');
  if (parts.length === 0) return [];
  return [`  - *Not brought back:* ${parts.map((item) => `${item.part.charAt(0).toLowerCase()}${item.part.slice(1)} (${REASON_WORDS[item.reason]})`).join('; ')}.`];
}

function notesFor(ledgerType, entry) {
  if (entry.decision === 'automated') {
    const lines = [`- **${entry.name}.** ${entry.keeps}`, ...missingLines(ledgerType)];
    if (entry.todo) lines.push(`  - *You do:* ${entry.todo}`);
    return lines;
  }
  return [`- **${entry.name}** (${LIMIT_WORDS[entry.limit]}). ${entry.why}`, ...missingLines(ledgerType), `  - *You do:* ${entry.todo}`];
}

/**
 * Per workload, in WORKLOADS order: its plain name, the settings it backs up, the
 * writes KEEL declares for it (verb, setting, and the restores that must be proven
 * first) and the hand step. The Restore page and the coverage doc both read this.
 */
export function workloadRestoreGuide(guide = WORKLOAD_GUIDE) {
  const writesByWorkload = new Map();
  for (const [id, write] of Object.entries(WORKLOAD_WRITE_OPERATIONS)) {
    if (!writesByWorkload.has(write.workload)) writesByWorkload.set(write.workload, []);
    writesByWorkload.get(write.workload).push({ id, ...write });
  }
  const writeName = (id) => {
    const write = WORKLOAD_WRITE_OPERATIONS[id];
    const read = WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === write.readBack);
    return PROPER_START.test(read.resource) ? read.resource : `${read.resource.charAt(0).toLowerCase()}${read.resource.slice(1)}`;
  };
  return WORKLOADS.map((workload) => {
    const entry = guide[workload];
    if (!entry) throw new Error(`docs/coverage.md: no plain-English entry for workload ${workload}; add one to WORKLOAD_GUIDE`);
    const reads = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === workload).map((read) => read.resource);
    const writes = (writesByWorkload.get(workload) ?? []).map((write) => {
      const verb = WRITE_VERBS[write.id.split('.').at(-1)];
      if (!verb) throw new Error(`docs/coverage.md: no plain verb for workload write ${write.id}`);
      const name = write.name ?? WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === write.readBack).resource;
      return { verb, name, after: (write.requires ?? []).map(writeName) };
    });
    return { workload, name: entry.name, reads, writes, todo: entry.todo };
  });
}

/** The workload section: settings read, writes declared, and what is left to the reader. */
function workloadSection(guide) {
  const lines = [
    '## Microsoft 365 workloads',
    '',
    'KEEL backs up the configuration of these workloads, listed below. It also backs up their content in a separate nightly run at 01:00 UTC, with delta sync and deduplication:',
    '',
    '- Exchange Online: mail folders and messages, calendars and contacts, including archive mailboxes.',
    '- OneDrive: files.',
    '- SharePoint: sites, lists and list items, document libraries and files with their versions.',
    '- Teams: teams, channels (standard, private and shared), channel members, tabs and apps. Channel files are covered through the team site in SharePoint.',
    '- Planner and group conversations: plans, buckets and tasks with their details; conversations, threads, posts and attachments.',
    '',
    'Teams chat and channel messages are not backed up: Microsoft must first approve the Teams export API for your tenant.',
    '',
    'A content scope can narrow the content backup to mailboxes, OneDrives, sites and groups whose names start with a set prefix. Teams has no name filter and is always read in full. The KEEL test tenant uses this to back up only its test content.',
    '',
    'Each workload ships switched off. KEEL turns a backup on for your tenant only after a live read from your tenant is checked, and turns a restore on only after a live write and read-back on your tenant is checked, at most 30 days old. A test against a simulated tenant never switches anything on.',
    '',
  ];
  for (const entry of workloadRestoreGuide(guide)) {
    lines.push(`### ${entry.name}`, '');
    lines.push('**Backed up:**', '');
    for (const read of entry.reads) lines.push(`- ${read}`);
    lines.push('');
    if (entry.writes.length === 0) {
      lines.push('**KEEL can restore:** nothing yet.', '');
    } else {
      lines.push('**KEEL can restore:**', '');
      for (const write of entry.writes) {
        lines.push(`- ${write.verb}: ${write.name}${write.after.length ? ` (switched on only after the restore of ${list(write.after)} is proven)` : ''}`);
      }
      lines.push('');
    }
    lines.push(`**You do:** ${entry.todo}`, '');
  }
  return lines;
}

/** The whole document, as a string. Pure: depends on code only. */
export function renderCoverageDoc({ typeGuide = TYPE_GUIDE, workloadGuide = WORKLOAD_GUIDE } = {}) {
  const ledger = buildOperationLedger();
  const cadence = tierCadence();
  const known = new Set(ledger.types.map((row) => row.resourceType));
  const extra = Object.keys(typeGuide).filter((type) => !known.has(type));
  if (extra.length > 0) throw new Error(`docs/coverage.md: TYPE_GUIDE has text for types the code no longer has: ${extra.join(', ')}`);
  const extraWorkloads = Object.keys(workloadGuide).filter((workload) => !WORKLOADS.includes(workload));
  if (extraWorkloads.length > 0) throw new Error(`docs/coverage.md: WORKLOAD_GUIDE has text for unknown workloads: ${extraWorkloads.join(', ')}`);

  const counts = { automated: 0, manual: 0 };
  const states = Object.fromEntries(COVERAGE_STATES.map((state) => [state, 0]));
  for (const row of ledger.types) {
    counts[row.decision] += 1;
    states[row.completeness.state] += 1;
  }

  const lines = [
    '# What KEEL covers',
    '',
    '<!-- Generated by tools/coverage-doc.mjs from the code. Do not edit by hand: run `node tools/coverage-doc.mjs`. A test fails when this file is out of date. -->',
    '',
    'For every kind of Microsoft 365 setting, this page says whether KEEL backs it up, what KEEL can restore, how well that restore is proven, and what you do yourself.',
    '',
    `KEEL tracks ${ledger.types.length} kinds of Entra ID and Intune settings and backs up everything it can read of each one. ${states.full} are full, ${states.incomplete} incomplete, ${states['microsoft-managed']} Microsoft-managed and ${states['not-readable']} not readable. KEEL can restore ${counts.automated} at least in part; the other ${counts.manual} are restored by hand from the backup.`,
    '',
    '## How to read this page',
    '',
    '- **Backed up:** every kind listed here is backed up. The tier sets how often, on the default schedule (an operator can change it).',
    '- **Coverage:** one of four states.',
    '  - *Full:* KEEL restores it on its own and nothing is missing.',
    '  - *Incomplete:* the backup holds everything KEEL can read, but some parts cannot be brought back automatically. It is recreated from the backup, by KEEL or by hand, and the missing parts are listed below the table as follow-up steps. Each backup flags the incomplete objects it holds.',
    '  - *Microsoft-managed:* Microsoft owns it, so there is nothing to restore.',
    '  - *Not readable:* KEEL cannot read it, for the reason given.',
    '- **KEEL can restore:** what a KEEL restore does. "By hand" means a person restores it from the backup, for the reason given below the table. "Not built yet" means KEEL backs it up in full and will recreate it on its own once that restore is built.',
    '- **Proof:** "Tested against a simulated tenant" means the restore code has passed tests against a fake Microsoft service. It is not yet proven on a live tenant. A failed live test is listed with its date until a fix passes.',
    '- **Microsoft limit:** Microsoft offers no way for any tool to do this. KEEL cannot work around it; the steps say what to do instead.',
    '- **KEEL choice:** KEEL could write it, but leaves it to a person for safety or because part of it is not backed up.',
    '',
  ];

  for (const batch of EXPANSION_BATCHES) {
    const heading = FAMILY_HEADINGS[batch.id];
    if (!heading) throw new Error(`docs/coverage.md: no heading for family ${batch.id}; add one to FAMILY_HEADINGS`);
    const rows = ledger.types.filter((row) => EXPANSION_INVENTORY[row.resourceType]?.batch === batch.id);
    if (rows.length === 0) continue;
    lines.push(`## ${heading}`, '', '| Setting | Backed up | Coverage | KEEL can restore | Proof |', '| --- | --- | --- | --- | --- |');
    const notes = [];
    for (const row of rows) {
      const entry = guideFor(row.resourceType, row.decision, typeGuide);
      lines.push(typeRow(row, entry, { cadence, edges: ledger.edges }));
      notes.push(...notesFor(row, entry));
    }
    lines.push('', '### Details and what you do', '', ...notes, '');
  }
  const unplaced = ledger.types.filter((row) => !FAMILY_HEADINGS[EXPANSION_INVENTORY[row.resourceType]?.batch]);
  if (unplaced.length > 0) throw new Error(`docs/coverage.md: types in no family: ${unplaced.map((row) => row.resourceType).join(', ')}`);

  lines.push(...workloadSection(workloadGuide));
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
