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

const auto = (name, { keeps, todo = null, words = null } = {}) => Object.freeze({ decision: 'automated', name, keeps, todo, words });
const manual = (name, limit, why, todo) => Object.freeze({ decision: 'manual', name, limit, why, todo });

/**
 * One entry per configuration type. `limit` says whose limit makes a manual type
 * manual: MS (Microsoft offers no way for any tool to do it) or KEEL (a safety or
 * scope choice KEEL made). `keeps` is what an automated restore covers; `todo` is
 * what is left to the reader; `words` replaces how the table names one
 * operation when the type does less than the usual words say.
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
    keeps: 'Puts the default guest collaboration and direct connect settings back.',
    todo: 'Inbound trust (accepting another tenant\'s MFA and device claims) is never changed by a restore. If it differs from the backup, change it by hand in Cross-tenant access settings.',
  }),
  crossTenantAccessPolicyPartner: auto('Cross-tenant access per organization', {
    keeps: 'Recreates partner organization settings and puts their settings back.',
    todo: 'A partner tenant that no longer exists cannot be added. Removing extra partners is done by hand. Inbound trust is never changed by a restore; change it by hand if it differs.',
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
  windowsAutopilotDeploymentProfile: auto('Windows Autopilot profiles', {
    keeps: 'Recreates profiles and puts their settings (out-of-box experience, device name template, language) and who they are assigned to back, keeping each profile\'s kind.',
    todo: 'Who a profile is assigned to is put back only when it is picked for a restore, and each group must still exist in the target. The registered device hardware is not backed up; devices are imported again from the devices themselves.',
  }),
  deviceManagementIntent: manual('Security baselines (older format)', KEEL,
    'This older format is preview-only and replaced by the settings catalog, and its settings are stored separately and not backed up.',
    'Rebuild the baseline in the settings catalog. KEEL restores settings catalog policies.'),
  managedDevice: manual('Enrolled devices', MS,
    'A device record is created by the device when it enrolls. It is state, not configuration.',
    'Nothing to restore. Devices enroll again on their own once enrollment settings are back.'),
  mobileApp: auto('Apps', {
    keeps: 'Adds store apps, web links, Microsoft 365 Apps, Edge and WinGet apps again with their settings and who they are assigned to, and puts changed settings back. Win32 and line-of-business apps come back with their install commands, detection rules and other settings, unassigned. Each app is put back in its app categories.',
    todo: 'Microsoft never returns an app\'s package (the installer file): upload it again for each recreated Win32 or line-of-business app, then assign it as the restore lists. Intune does not let such an app be changed until its package is uploaded, so a restore lists a step for it instead. Apps from Apple Business Manager or managed Google Play are synced again there; KEEL then puts back who they are assigned to. An uninstall assignment is never written: it removes the app and its data from devices. A category that is no longer in Intune is listed as a step: restore it first. Dependencies and supersedence are restored on their own.',
  }),
  managedAppPolicy: auto('App protection policies', {
    keeps: 'Puts the settings of iOS and Android app protection policies back, recreates them with the apps they protect, and removes an unassigned policy added since the backup.',
    todo: 'A backup taken before the protected apps were read cannot recreate a policy; take a new backup. Windows Information Protection policies are restored by hand. Windows app protection policies are restored on their own.',
  }),
  targetedManagedAppConfiguration: auto('Managed app configuration', {
    keeps: 'Puts the settings back, recreates a configuration with the apps it targets, and removes an unassigned one added since the backup.',
    todo: 'A backup taken before the targeted apps were read cannot recreate a configuration; take a new backup.',
  }),
  mobileAppConfiguration: auto('App configuration for managed devices', {
    keeps: 'Recreates configurations and puts their settings back when the app they configure exists, and removes an unassigned one added since the backup.',
    todo: 'Add the app first. Values Microsoft never returns are entered again by hand.',
  }),
  // Wave 1: backed up, no restore built yet.
  // Restore gaps batch 4: the script body is backed up per script.
  deviceManagementScript: auto('Windows PowerShell scripts', {
    keeps: 'Recreates scripts and puts the script, its settings and who it runs on back.',
    todo: 'Who a script runs on is put back only when the script is picked for a restore, and each group must still exist in the target. A backup taken before scripts were read in full holds only the settings; take a new backup.',
  }),
  deviceShellScript: auto('macOS shell scripts', {
    keeps: 'Recreates scripts and puts the script, its settings and who it runs on back.',
    todo: 'Who a script runs on is put back only when the script is picked for a restore, and each group must still exist in the target. A backup taken before scripts were read in full holds only the settings; take a new backup.',
  }),
  deviceHealthScript: auto('Remediations', {
    keeps: 'Recreates your own remediations and puts the detection and fix scripts, their settings, who they run on and their schedule back. Remediations published by Microsoft are left alone.',
    todo: 'Who a remediation runs on is put back only when it is picked for a restore, and each group must still exist in the target.',
  }),
  deviceComplianceScript: auto('Custom compliance scripts', {
    keeps: 'Recreates scripts and puts the script, its settings and who it runs on back, before the compliance policies that use them.',
    todo: 'Who a script runs on is put back only when the script is picked for a restore. A backup taken before scripts were read in full holds only the settings; take a new backup.',
  }),
  assignmentFilter: auto('Assignment filters', {
    keeps: 'Recreates filters and puts their rules back.',
    todo: 'A filter is never moved to another platform; recreate it by hand if its platform changed.',
  }),
  roleScopeTag: auto('Scope tags', {
    keeps: 'Recreates your own tags and puts their names back.',
    todo: 'The built-in Default tag exists in every tenant and is never written.',
  }),
  windowsFeatureUpdateProfile: auto('Windows feature update profiles', {
    keeps: 'Recreates profiles, puts their settings and who they are assigned to back, and removes an unassigned profile added since the backup.',
    todo: 'Who a profile is assigned to is put back only when it is picked for a restore, and each group must still exist in the target.',
  }),
  windowsQualityUpdateProfile: auto('Windows quality update profiles', {
    keeps: 'Recreates profiles, puts their settings and who they are assigned to back, and removes an unassigned profile added since the backup.',
    todo: 'Who a profile is assigned to is put back only when it is picked for a restore, and each group must still exist in the target.',
  }),
  windowsDriverUpdateProfile: auto('Windows driver update profiles', {
    keeps: 'Recreates profiles, puts their settings and who they are assigned to back, and removes an unassigned profile added since the backup.',
    todo: 'Driver approvals are not backed up yet, so approve the drivers again by hand. Who a profile is assigned to is put back only when it is picked for a restore.',
  }),
  // Restore gaps batch 5: the values of each setting are backed up per setting.
  groupPolicyConfiguration: auto('Administrative templates', {
    keeps: 'Recreates templates and puts back which settings are turned on or off, the values entered for them and who the template is assigned to.',
    todo: 'Who a template is assigned to is put back only when it is picked for a restore. A setting from an imported template file needs that file imported first. A backup taken before setting values were read is refused; take a new backup.',
  }),
  groupPolicyUploadedDefinitionFile: auto('Imported administrative template files', {
    keeps: 'Imports a deleted ADMX file again, with its ADML language files, from the backup.',
    todo: 'Intune gives the settings in a re-imported file new ids, so administrative templates that used them are set up again by hand. A file is never changed in place: upload a new version in the Intune admin center, under Devices, Configuration, Import ADMX. A backup taken before the file content was read is refused; take a new backup.',
  }),
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
  onPremisesConditionalAccessSettings: auto('Exchange on-premises access settings', {
    keeps: 'Puts back whether Exchange on-premises access control is on and which groups it covers or leaves out.',
    todo: 'A restore never turns it on, because that could block mail on devices that are not managed: turn it on by hand in the Intune admin center, under Tenant administration, Connectors and tokens, Exchange on-premises access.',
  }),
  mobileAppCategory: auto('App categories', {
    keeps: 'Recreates your own categories and puts their names back. The built-in categories come with every tenant and are never changed.',
    todo: 'Which apps are in a category is set on each app; add the apps to a recreated category again by hand.',
  }),
  intuneBrandingProfile: auto('Company Portal branding', {
    keeps: 'Recreates branding profiles for your groups and puts back their name, colours, contact details, links and Company Portal options. The default branding, which every user sees, is put back in place.',
    todo: 'Logo images are not backed up: upload them again from your own copy. Who a profile is assigned to is put back only when it is picked for a restore.',
  }),
  deviceManagementCompliancePolicy: auto('Settings catalog compliance policies', {
    keeps: 'Recreates policies and puts back their settings, actions for noncompliance (block, emails, grace periods) and who they are assigned to.',
    todo: 'Who a policy is assigned to is put back only when it is picked for a restore, from backups taken after assignments were read; Conditional Access that requires compliant devices needs it assigned first. A backup taken before the actions for noncompliance were read cannot recreate a policy; take a new backup.',
  }),
  deviceManagementReusablePolicySetting: auto('Reusable settings groups', {
    keeps: 'Recreates groups and puts their settings back, before the settings catalog policies that use them.',
    todo: 'A group is never moved to another setting definition; recreate it by hand if that changed.',
  }),
  policySet: auto('Policy sets', {
    keeps: 'Recreates sets and puts back their names, the apps and policies in them, and who they are assigned to.',
    todo: 'Every app and policy in a set must be back first with the same id. Who a set is assigned to is put back only when it is picked for a restore, from backups taken after assignments were read. A backup taken before the apps and policies in a set were read is refused; take a new backup.',
  }),
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
  // Restore gaps batch 5: the script body is backed up per script.
  deviceCustomAttributeShellScript: auto('macOS custom attribute scripts', {
    keeps: 'Recreates scripts and puts the script, its settings and who it runs on back.',
    todo: 'Who a script runs on is put back only when the script is picked for a restore, from backups taken after assignments were read. A backup taken before scripts were read in full holds only the settings; take a new backup.',
  }),
  externalIdentitiesPolicy: auto('External user leave settings', {
    keeps: 'Puts back whether external users can leave your organization themselves, and whether their data is removed when they do.',
  }),
  b2bManagementPolicy: auto('Guest invitation domain restrictions', {
    keeps: 'Puts back the list of domains guests may, or may not, be invited from.',
    todo: 'If the restriction was removed completely, set the domains again in the Entra admin center, under External collaboration settings.',
  }),
  servicePrincipalCreationPolicy: manual('App creation policies', NOT_BUILT,
    'KEEL backs up each policy\'s name and settings but not yet its include and exclude conditions.',
    'Recreate the policy with PowerShell from the backup, then add its conditions again. There is no admin center page for it.'),
  permissionGrantPreApprovalPolicy: auto('App permission pre-approval policies', {
    keeps: 'Puts back which app permissions are pre-approved, and where (chats, teams or the whole organization).',
    todo: 'A policy only works once it is assigned to its app. Assign a recreated policy to the app again with PowerShell.',
  }),
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
  externalDomainFederation: auto('Guest SAML or WS-Fed sign-in', {
    keeps: 'Puts back each partner\'s name and sign-in protocol.',
    todo: 'KEEL never puts back a partner\'s sign-in addresses or signing certificate, so a changed backup cannot send guests to another sign-in page. Check those with the partner and set them in the Entra admin center, under External Identities, All identity providers. A deleted partner is set up again there too, with its domains.',
  }),
  exchangeRoleDefinition: manual('Exchange admin roles', NOT_BUILT,
    'KEEL backs up the custom roles but does not restore them yet. The built-in roles are set by Microsoft.',
    'Recreate each custom role with Exchange Online PowerShell from the backup, from the same parent role, before the role groups or apps that use it.'),
  exchangeRoleAssignment: manual('Exchange admin role assignments', NOT_BUILT,
    'KEEL backs up who holds each Exchange role and over which scope, but does not restore them yet. Admin access needs a privilege review first.',
    'Check the backup with the person who approves admin access, then add the role groups, people or apps again in the Exchange admin center, under Roles, Admin roles, or with Exchange Online PowerShell.'),
  exchangeCustomAppScope: auto('Exchange app access scopes', {
    keeps: 'Recreates scopes and puts back their name and which mailboxes they cover (the recipient filter).',
    todo: 'An app role assignment points to its scope by id and is not restored: point the assignment at a recreated scope again with Exchange Online PowerShell.',
  }),
  defenderRoleDefinition: manual('Defender admin roles', NOT_BUILT,
    'KEEL backs these up but does not restore them yet.',
    'Recreate each role in the Microsoft Defender portal, under System, Permissions, Microsoft Defender XDR, Roles, from the backup.'),
  defenderRoleAssignment: manual('Defender admin role assignments', NOT_BUILT,
    'KEEL backs up who holds each Defender role and for which data sources, but does not restore them yet. Admin access needs a privilege review first.',
    'Check the backup with the person who approves admin access, then add the assignments again in the Microsoft Defender portal, under the role, Assignments.'),
  defenderCustomAppScope: manual('Defender app access scopes', NOT_BUILT,
    'KEEL backs these up but does not restore them yet.',
    'Recreate each scope with PowerShell from the backup, before the assignments that use it. There is no admin center page for it.'),
  deviceManagementSettings: auto('Intune tenant settings', {
    keeps: 'Puts back the compliance settings, such as how devices with no compliance policy are marked and how long a device may go without checking in. The device cleanup window is put back with the device cleanup rules.',
    todo: 'A restore never marks devices with no compliance policy as compliant: change that by hand in the Intune admin center, under Endpoint security, Device compliance, Compliance settings. The Company Portal contact details are put back with the default branding profile.',
  }),
  androidDeviceOwnerEnrollmentProfile: auto('Android Enterprise enrollment profiles', {
    keeps: 'Recreates profiles and puts back their name, description, device name template and Wi-Fi network; the enrollment mode is set when a profile is recreated. A profile on a secured Wi-Fi network is recreated by hand, because the Wi-Fi password is not backed up.',
    todo: 'A recreated profile has a new enrollment token and QR code: make a token in the Intune admin center, under Devices, Enrollment, Android, and hand it out again. Recreate a profile on a secured Wi-Fi network by hand and type the password again.',
  }),
  androidForWorkEnrollmentProfile: auto('Android work profile enrollment profiles', {
    keeps: 'Recreates profiles and puts back their name and description.',
    todo: 'A recreated profile has no enrollment token: make one in the Intune admin center, under Devices, Enrollment, Android, and hand it out again.',
  }),
  appleUserInitiatedEnrollmentProfile: auto('Apple user enrollment profiles', {
    keeps: 'Recreates profiles and puts their settings back (name, description, which enrollment types users may pick and the default).',
    todo: 'A recreated profile goes to the end of the priority order and is assigned to nobody: set its priority and assign it again by hand from the backup.',
  }),
  androidForWorkSettings: manual('Android work profile connection', MS,
    'The legacy work profile connection is made by signing in to Google. No tool can make it from a backup.',
    'Use the backup for the Google account and target groups, connect again in the Intune admin center with that account, and turn on the same enrollment options.'),
  deviceManagementDerivedCredentialSettings: manual('Derived credential issuers', NOT_BUILT,
    'KEEL backs up the issuer settings but does not restore them yet.',
    'Set the same issuer, help page and renewal threshold in the Intune admin center, under Tenant administration, Connectors and tokens, Derived credentials, from the backup.'),
  microsoftTunnelConfiguration: auto('Microsoft Tunnel server configurations', {
    keeps: 'Recreates configurations and puts back their network, DNS servers, routes and port.',
    todo: 'A site points to its configuration by id: point the site at a recreated configuration again by hand.',
  }),
  microsoftTunnelHealthThreshold: auto('Microsoft Tunnel health thresholds', {
    keeps: 'Puts back the healthy and unhealthy limits of each health check.',
  }),
  iosLobAppProvisioningConfiguration: auto('Apple app provisioning profiles', {
    keeps: 'Recreates profiles and puts back their name, description, scope tags, the profile file from Apple and who they are assigned to.',
    todo: 'Who a profile is assigned to is put back only when it is picked for a restore, from backups taken after assignments were read. An expired file, or one that expires before the profile in Intune now, is never uploaded: renew it with Apple and upload it in the Intune admin center, under Apps, iOS/iPadOS, App provisioning profiles. A backup taken before the profile file was read is refused; take a new backup.',
  }),
  mobileAppRelationship: auto('App dependencies and supersedence', {
    keeps: 'Puts back which app depends on or replaces which, and how (install automatically or detect; update or replace), when both apps are in Intune, including apps the same restore added again. Undoing a restore takes out a link it added.',
    words: { delete: 'take out a link a restore added, when that restore is undone' },
    todo: 'An app KEEL cannot add again (a synced app) is added by hand first: a link to a missing app is not written. Intune links only Win32 apps, so a link to any other kind of app is a step for a person. Setting an app to replace another uninstalls the older app on devices, so that needs the separate content approval.',
  }),
  managedEBook: manual('Managed e-books', NOT_BUILT,
    'KEEL backs up each book\'s details but not yet who it is assigned to, and does not restore it yet.',
    'Sync the books again from Apple Business Manager in the Intune admin center, under Apps, eBooks, and assign them again from the backup.'),
  managedEBookCategory: auto('E-book categories', {
    keeps: 'Recreates categories and puts their names back.',
    todo: 'Which books are in a category is set on each book; add the books to a recreated category again by hand.',
  }),
  cartToClassAssociation: auto('Classroom device cart assignments', {
    keeps: 'Recreates cart assignments and puts back their name, description, devices and classes.',
    todo: 'Devices and classes are named by id and are not restored by KEEL: if a device or class was removed, add the cart to the new class again in Intune for Education.',
  }),
  windowsManagedAppProtection: auto('Windows app protection policies', {
    keeps: 'Recreates policies and puts back their settings, the apps they cover and who they are assigned to.',
    todo: 'Who a policy is assigned to is put back only when it is picked for a restore, from backups taken after assignments were read. A backup taken before the apps were read is refused for a recreate; take a new backup.',
  }),
  enterpriseCodeSigningCertificate: manual('Windows code signing certificates', NOT_BUILT,
    'KEEL backs up each public certificate but does not restore it yet.',
    'Upload the same certificate again in the Intune admin center, under Tenant administration, Connectors and tokens, Windows enterprise certificate, from the backup.'),
  symantecCodeSigningCertificate: manual('Symantec code signing certificate', KEEL,
    'KEEL backs up the certificate\'s subject, issuer and expiry but never the certificate file or its password.',
    'Upload the certificate again from your own copy in the Intune admin center, under Tenant administration, Connectors and tokens, Windows Symantec certificate, and check its expiry against the backup.'),
  userExperienceAnalyticsBaseline: auto('Endpoint analytics baselines', {
    keeps: 'Recreates custom baselines and puts their names back. The built-in baseline is set by Microsoft and never changed.',
    todo: 'A recreated baseline takes today\'s scores to compare against, not the scores it held before; compare against the backup by hand if you need the old ones.',
  }),
  sharepointSettings: auto('SharePoint and OneDrive tenant settings', {
    keeps: 'Puts back the tenant-wide SharePoint and OneDrive settings, such as site creation, sync app limits, idle session sign-out, Loop and storage limits. The sharing settings are put back by the SharePoint service backup.',
    todo: 'A restore never turns legacy authentication on, lets devices outside the domain sync, or lets a guest invitation be accepted by another account: when the backup does, nothing is written and you set those by hand in the SharePoint admin center, under Policies, Access control.',
  }),
  itemInsightsSettings: manual('Item insights setting', NOT_BUILT,
    'KEEL backs up whether people cards and search show the documents a person worked on, and the group it is turned off for, but does not restore it yet.',
    'Set the same value in the Microsoft 365 admin center, under Settings, Org settings, Search and intelligence, from the backup, and pick the same group again.'),
  externalConnection: manual('Copilot connectors', NOT_BUILT,
    'KEEL backs up each connection\'s name, description and allowed apps but not its schema or the items pushed into it, and does not restore it yet.',
    'Recreate the connector in the Microsoft 365 admin center, under Copilot, Connectors, from the backup, then let it sync its items again.'),
  simulationAutomation: manual('Attack simulation automations', NOT_BUILT,
    'KEEL backs up each automation\'s name and status but does not restore it yet.',
    'Recreate the automation in the Microsoft Defender portal, under Email and collaboration, Attack simulation training, Automations, from the backup.'),
  attackSimulation: manual('Attack simulations', NOT_BUILT,
    'KEEL backs up each simulation\'s settings and targets but not its results, and does not restore it yet.',
    'Launch the simulation again in the Microsoft Defender portal, under Email and collaboration, Attack simulation training, Simulations, with the same technique, payload and targets from the backup.'),
  // Remaining kinds, batch 8.
  hardwareConfiguration: auto('BIOS configurations', {
    keeps: 'Puts back each BIOS configuration\'s name, description, scope tags and whether every device gets its own BIOS password.',
    todo: 'The settings file is not backed up, because it can hold the BIOS password: a deleted configuration is created again in the Intune admin center, under Devices, Windows, Configuration, BIOS configurations and other settings, with the file from your own copy. KEEL never turns per-device BIOS passwords off; do that there by hand if it is wanted.',
  }),
  certificateBasedApplicationConfiguration: manual('App certificate authority trust', NOT_BUILT,
    'KEEL backs up which apps have a certificate authority trust list, but not the authorities on it, and does not restore it yet.',
    'Create the configuration again with PowerShell, then add the same certificate authorities from your own copies.'),
  signInIdentifier: manual('Sign-in identifiers', NOT_BUILT,
    'KEEL backs up which identifiers people can sign in with (email, user name, custom user name) and whether each is on, but does not restore them yet.',
    'Turn the same identifiers on or off in the Entra admin center, under External Identities, from the backup.'),
  verifiedIdProfile: manual('Verified ID profiles', NOT_BUILT,
    'KEEL backs up each verification profile\'s accepted issuer, claims and Face Check setting but does not restore it yet.',
    'Create the profile again in the Entra admin center, under Verified ID, from the backup.'),
  externalOriginResourceConnector: manual('Entitlement management outside connectors', NOT_BUILT,
    'KEEL backs up each connector to resources outside Entra ID but does not restore it yet.',
    'Create the connector again with PowerShell from the backup.'),
  lifecyclePolicy: manual('Lifecycle policies', NOT_BUILT,
    'KEEL backs up each lifecycle policy\'s scope, grace period and action (such as disabling accounts that stopped signing in), but not its rules or past versions, and does not restore it yet.',
    'Create the policy again in the Entra admin center, under Identity Governance, Lifecycle workflows, from the backup, and leave it off until you have checked who it covers.'),
  roleManagementCustomExtension: manual('PIM custom extensions', NOT_BUILT,
    'KEEL backs up each extension\'s name and how it signs in, but not the Logic App address it calls, which can hold an access key. It does not restore it yet.',
    'Create the extension again in the Entra admin center, under Privileged Identity Management, and pick the same Logic App.'),
  privilegedAccessGroupResource: manual('PIM managed groups', NOT_BUILT,
    'KEEL backs up which groups are managed by Privileged Identity Management. A group comes back under it when it gets its first eligible member.',
    'Add an eligible member to each group again in the Entra admin center, under Privileged Identity Management, Groups.'),
  crossTenantM365Capability: manual('Default cross-tenant sharing settings', NOT_BUILT,
    'KEEL backs up the default calendar sharing, mail tips and room booking settings for other tenants but does not restore them yet.',
    'Set the same values with PowerShell from the backup.'),
  entitlementManagementRoleAssignment: manual('Entitlement management role assignments', NOT_BUILT,
    'KEEL backs up who is a catalog owner, catalog reader or access package manager, and over which catalog, but does not restore it yet.',
    'Add the same people to the same roles in the Entra admin center, under Identity Governance, Entitlement management, from the backup.'),
  deviceTemplate: manual('Device templates', NOT_BUILT,
    'KEEL backs up each device template\'s maker, model and operating system but not its owners or the devices made from it, and does not restore it yet.',
    'Create the template again with PowerShell from the backup, then add its owners.'),
  securityZone: manual('Exposure management zones', NOT_BUILT,
    'KEEL backs up each zone\'s name and description but not the environments in it, and does not restore it yet.',
    'Create the zone again in the Microsoft Defender portal, under Exposure management, and add the same environments.'),
  sharedEmailDomain: manual('Shared email domains', NOT_BUILT,
    'KEEL backs up which shared email domains the tenant uses. Microsoft sets them up; there is nothing to restore.',
    'Ask Microsoft support if a shared domain is missing.'),
  schemaExtension: manual('Schema extensions', NOT_BUILT,
    'KEEL backs up the schema extensions this tenant\'s own apps defined, but not the values stored in them on users and groups, and does not restore them yet.',
    'Create the extension again with PowerShell, with the same id, owner app and properties from the backup.'),
  // Remaining kinds, batch 9: read once the Collector holds the read permission.
  formsSettings: manual('Microsoft Forms settings', NOT_BUILT,
    'KEEL backs up the tenant-wide Forms settings, such as sharing forms outside the organisation and phishing scans, but not the forms or their answers, and does not restore them yet.',
    'Set the same values in the Microsoft 365 admin center, under Settings, Org settings, Microsoft Forms, from the backup.'),
  todoSettings: manual('Microsoft To Do settings', NOT_BUILT,
    'KEEL backs up whether To Do lists can be shared with or joined by people outside the organisation, and push notifications, but does not restore them yet.',
    'Set the same values in the Microsoft 365 admin center, under Settings, Org settings, Microsoft To Do, from the backup.'),
  microsoft365AppsInstallationOptions: manual('Microsoft 365 Apps installation options', NOT_BUILT,
    'KEEL backs up which Microsoft 365 apps people can install themselves and the update channel, but does not restore them yet.',
    'Set the same values in the Microsoft 365 admin center, under Settings, Org settings, Microsoft 365 installation options, from the backup.'),
  appsAndServicesSettings: manual('User owned apps and services', NOT_BUILT,
    'KEEL backs up whether people can use the Office Store and start app trials, but does not restore it yet.',
    'Set the same values in the Microsoft 365 admin center, under Settings, Org settings, User owned apps and services, from the backup.'),
  adminReportSettings: manual('Usage report privacy', NOT_BUILT,
    'KEEL backs up whether usage reports show real user, group and site names, but does not restore it yet.',
    'Set the same value in the Microsoft 365 admin center, under Settings, Org settings, Reports, from the backup.'),
  profileCardProperty: manual('Profile card fields', NOT_BUILT,
    'KEEL backs up the extra directory fields shown on profile cards and their labels, but does not restore them yet.',
    'Add the same fields again with PowerShell (New-MgAdminPeopleProfileCardProperty) from the backup.'),
  pronounsSettings: manual('Pronouns setting', NOT_BUILT,
    'KEEL backs up whether people can add pronouns to their profile, but does not restore it yet.',
    'Set the same value in the Microsoft 365 admin center, under Settings, Org settings, Pronouns, from the backup.'),
  defenderDetectionRule: manual('Defender custom detection rules', NOT_BUILT,
    'KEEL backs up each custom detection rule: its hunting query, schedule, alert details and response actions. It does not restore them yet.',
    'Create the rule again in the Microsoft Defender portal, under Hunting, Custom detection rules, from the backup. Leave it off until you have checked its response actions, because a rule can isolate devices or disable users.'),
  teamsCatalogApp: manual('Teams custom apps', NOT_BUILT,
    'KEEL backs up each app your organisation uploaded to Teams, with its versions and publishing state, but not the app package, which Microsoft does not give out. It does not restore them yet.',
    'Upload the app package again in the Teams admin center, under Teams apps, Manage apps, from your own copy, then check its details against the backup.'),
  engageCommunity: manual('Viva Engage communities', NOT_BUILT,
    'KEEL backs up each community\'s name, description and privacy, but not its posts, files or members, and does not restore it yet.',
    'Create the community again in Viva Engage with the same name, description and privacy from the backup, then add its owners and members.'),
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
  'exchange-role-groups': Object.freeze({ name: 'Exchange admin role groups',
    todo: 'KEEL does not restore role groups. A deleted group, its roles and its members are put back by hand in the Exchange admin center using the backup. Microsoft\'s built-in groups cannot be deleted, only their members changed.' }),
  'sharepoint-structure': Object.freeze({ name: 'SharePoint site structure',
    todo: 'KEEL adds back what a named site is missing (lists, libraries, site columns and content types) and puts its navigation back, but never changes or deletes an existing list, column or content type: those differences are listed for you to apply by hand. A re-added list comes back empty; its files and items come back from the content backup. Permissions, webhooks, custom actions, features and site settings are put back by hand. A site script or design comes back with a new id; who may use a design, and who may join a hub, are granted again by hand. Site templates are backed up only for the sites named in the backup scope. The term store is backed up separately.' }),
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
  for (const row of failed) {
    // No fix means the test tenant cannot run it (a tenant limit), not a bug.
    if (row.live.fix) parts.push(`live test of ${OPERATION_NOUNS[row.operation]} failed on ${row.live.failedAt}, fix in progress`);
    else parts.push(`live test of ${OPERATION_NOUNS[row.operation]} not possible on our test tenant (checked ${row.live.failedAt})`);
  }
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
    const words = supported.map((row) => entry.words?.[row.operation] ?? OPERATION_WORDS[row.operation]);
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
    'Teams chat and channel messages are not backed up: Microsoft must first approve the Teams export API for your tenant. Once they are, KEEL can restore a channel\'s messages into a new channel, "<name> (restored <date>)", with their original authors and times, through Microsoft\'s message import API. Reactions, cards and live @mentions are not brought back (a mention stays as bold text).',
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
