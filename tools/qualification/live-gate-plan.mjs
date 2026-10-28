#!/usr/bin/env node
/**
 * Issue #148: the Entra live-gate checklist, derived at run time.
 *
 *   node tools/qualification/live-gate-plan.mjs              # Markdown checklist for the operator
 *   node tools/qualification/live-gate-plan.mjs --json       # the same plan as JSON
 *   node tools/qualification/live-gate-plan.mjs --summary    # one line per step
 *
 * The list of operations is NEVER hand-kept. It is every row of the operation
 * ledger (engine/coverage/qualification.mjs buildOperationLedger) whose
 * decision is 'supported', plus every supported relationship edge row. A newly
 * registered write (capabilities.mjs) appears here with no edit to this file.
 *
 * What IS kept here is per-type guidance: which disposable fixture to use, which
 * reviewed field to drift and the break-glass precondition. A registered type
 * with no guidance still gets a full step, built from generic text and from the
 * catalogue's blast radius. A type whose blast radius is 'tenant-lockout' and
 * that has no guidance is treated as lockout-sensitive, so it runs last and
 * names the break-glass precondition until someone reviews it.
 *
 * Order: everything that is not lockout-sensitive first (by catalogue blast
 * radius, then batch, then type, then operation); then the lockout-sensitive
 * types (authorization policy, PIM rules, authentication methods, security
 * defaults, Conditional Access, then the Conditional Access enforcement step).
 *
 * Nothing here contacts a tenant. It prints commands for the operator to run on
 * the test tenant, and every command names the test-tenant precondition.
 */
import { pathToFileURL } from 'node:url';

import { CATALOG } from '../tenant-probe/catalog.mjs';
import { CONSTANT_KEY_TYPES, ID_KEY_TYPES } from '../../engine/cir/naturalKey.mjs';
import { buildExpansionInventory, buildOperationLedger } from '../../engine/coverage/qualification.mjs';
import { ENFORCEMENT_STEP } from '../../engine/restore/conditionalAccessEnforcement.mjs';
import { DIRECTORY_POLICY_RECORDS } from '../../engine/restore/directoryPolicyOperations.mjs';
import { TENANT_POLICY_RECORDS } from '../../engine/restore/tenantPolicyOperations.mjs';

export const LIVE_GATE_PLAN_VERSION = 1;
export const LIVE_GATE_ISSUE = 148;
/** Where committed captures and demotion records go (one pair of files per operation). */
export const ENTRA_LIVE_EVIDENCE_DIR = 'docs/release/qualifications/entra-live';
export const FIXTURE_PREFIX = 'KEEL-RT-148';

const BLAST_RANK = Object.freeze({ cosmetic: 0, 'access-affecting': 1, 'tenant-lockout': 2 });
const OPERATION_RANK = Object.freeze({ create: 0, update: 1, 'restore-soft-deleted': 2, delete: 3, 'edge-add': 4, 'edge-remove': 5 });

const SINGLETON_TYPES = new Set([
  ...CONSTANT_KEY_TYPES,
  ...CATALOG.filter((entry) => entry.singleton === true).map((entry) => entry.type),
  ...TENANT_POLICY_RECORDS.filter((entry) => !entry.route.includes('{')).map((entry) => entry.resourceType)
    .filter((type) => type !== 'crossTenantAccessPolicyPartner'),
]);
const TENANT_POLICY_LOCKOUT = new Set(TENANT_POLICY_RECORDS.filter((entry) => entry.lockout).map((entry) => entry.resourceType));

const BREAK_GLASS_COMMON = [
  'Run `node cli/keel-breakglass.mjs report --config "$COLLECTOR"`: every registered break-glass account must read ready. Stop if any is not, or if readiness is unknown.',
  'Marouane keeps a second, separate Global Administrator session signed in to the test tenant for the whole step, and is reachable to undo the change by hand.',
  'Never touch the break-glass accounts, the operator\'s admin account or the Global Reader account.',
];

/**
 * Reviewed per-type guidance. Keys are resource types (or edge capability
 * keys). `kind` is how the capture checks the fixture: 'named-object' (its name
 * starts KEEL-RT- or keel-rehearsal-), 'tenant-setting' (a tenant-wide object
 * that cannot be disposable; the capture needs --allow-tenant-setting) or
 * 'by-reference' (an object with no name of its own that only points at
 * fixtures; the capture needs --allow-by-reference).
 */
export const FIXTURE_GUIDANCE = Object.freeze({
  group: {
    kind: 'named-object', fixture: `security group ${FIXTURE_PREFIX}-group (mail nickname ${FIXTURE_PREFIX}-group), no members`,
    select: `${FIXTURE_PREFIX}-group`, drift: 'change its description',
  },
  'group#member': {
    kind: 'named-object', fixture: `group ${FIXTURE_PREFIX}-group and the existing fixture user keel-rt-20260908-carla as its member`,
    select: `${FIXTURE_PREFIX}-group`, add: 'remove carla from the group after the snapshot', remove: 'add carla to the group after the snapshot (the snapshot has no members)',
  },
  'group#owner': {
    kind: 'named-object', fixture: `group ${FIXTURE_PREFIX}-group and the existing fixture user keel-rt-20260908-carla as its owner`,
    select: `${FIXTURE_PREFIX}-group`, add: 'remove carla as owner after the snapshot', remove: 'add carla as owner after the snapshot (the snapshot has no owners)',
  },
  user: {
    kind: 'named-object', fixture: 'the existing cloud-only fixture user keel-rt-20260908-carla (never a synced user)',
    select: 'carla\'s user principal name', drift: 'change her department, and remove one directly assigned licence if she has one',
  },
  application: {
    kind: 'named-object', fixture: `app registration ${FIXTURE_PREFIX}-app with no secrets, certificates or API permissions`,
    select: `the appId of ${FIXTURE_PREFIX}-app`, drift: 'change its display name to end in -drifted',
    note: 'A recreated app gets a new appId; KEEL lists the credential completion items. Nothing consumes this app.',
  },
  servicePrincipal: {
    kind: 'named-object', fixture: `the enterprise application for ${FIXTURE_PREFIX}-app`,
    select: `the appId of ${FIXTURE_PREFIX}-app`,
    note: 'Create runs after the application create step: delete the enterprise application only, keep the app registration.',
  },
  administrativeUnit: {
    kind: 'named-object', fixture: `administrative unit ${FIXTURE_PREFIX}-unit with no members (the role steps later scope the fixture role to it)`,
    select: `${FIXTURE_PREFIX}-unit`, drift: 'change its description',
  },
  groupSetting: {
    kind: 'tenant-setting', fixture: 'the tenant-wide Group.Unified directory setting',
    select: 'Group.Unified', drift: 'flip EnableGroupCreation and put nothing else back by hand',
    note: 'Delete removes the tenant-wide setting and the restore cannot recreate it (create is not registered); only run delete if decision D-148b allows it, and have its values written down to recreate by hand.',
  },
  // The catalogue rates the role and Conditional Access building blocks as able to
  // lock the tenant out, so they stay lockout-sensitive: they run late, alone and
  // after the break-glass check. Only an explicit `lockout: false` with a
  // `lockoutReason` may lower that (none does today).
  roleDefinition: {
    kind: 'named-object',
    fixture: `custom role ${FIXTURE_PREFIX}-role with one harmless permission (microsoft.directory/groups/basic/update: group names and descriptions), assigned to nobody`,
    select: `${FIXTURE_PREFIX}-role`, drift: 'change its description',
    breakGlass: 'The fixture role holds no permission that affects sign-in, credentials or roles, and is never assigned to a break-glass account.',
    note: 'Needs an Entra ID P1 or P2 licence in the test tenant.',
  },
  roleAssignment: {
    kind: 'by-reference', fixture: `${FIXTURE_PREFIX}-role assigned to keel-rt-20260908-carla, scoped to administrative unit ${FIXTURE_PREFIX}-unit (never tenant-wide)`,
    select: 'the assignment key KEEL shows for carla and the fixture role', drift: 'none: update is checked by re-running restore over an unchanged assignment and is captured only if KEEL writes',
    breakGlass: 'Never a built-in privileged role and never a break-glass principal: only the fixture role and the fixture user. The capture checks both names in the snapshot.',
  },
  roleEligibilitySchedule: {
    kind: 'by-reference', fixture: `a time-bound PIM eligibility for keel-rt-20260908-carla to ${FIXTURE_PREFIX}-role, scoped to ${FIXTURE_PREFIX}-unit, ending in 30 days`,
    select: 'the eligibility id KEEL shows for carla and the fixture role',
    breakGlass: 'Never a built-in privileged role and never a break-glass principal: only the fixture role and the fixture user. The capture checks both names in the snapshot.',
  },
  oauth2PermissionGrant: {
    kind: 'by-reference',
    fixture: `a delegated consent (consentType Principal) for a KEEL-RT- app with no other permissions, for one keel-rt- fixture user, to Microsoft Graph with scope openid only`,
    select: 'the grant id KEEL shows for the fixture app', drift: 'change its scope (for example openid profile)',
    note: 'The capture checks that the client app and the user are KEEL-RT fixtures (no role is involved). Never a grant for Keel\'s own apps, a non-fixture app or user, or all users.',
  },
  namedLocation: {
    kind: 'named-object', fixture: `IP named location ${FIXTURE_PREFIX}-location (203.0.113.0/24, not trusted), referenced by no policy`,
    select: `${FIXTURE_PREFIX}-location`, drift: 'add the range 198.51.100.0/24',
    breakGlass: 'The fixture location is referenced by no Conditional Access policy, so no sign-in decision depends on it. Check that in the portal before the write.',
  },
  authenticationStrengthPolicy: {
    kind: 'named-object', fixture: `custom authentication strength ${FIXTURE_PREFIX}-strength (FIDO2 only), referenced by no policy`,
    select: `${FIXTURE_PREFIX}-strength`, drift: 'change its description',
    breakGlass: 'The fixture strength is referenced by no Conditional Access policy, so no sign-in requires it. Check that in the portal before the write.',
  },
  crossTenantAccessPolicy: { kind: 'tenant-setting', fixture: 'the tenant cross-tenant access policy', select: 'crossTenantAccessPolicy', drift: 'none expected: allowedCloudEndpoints is usually empty; add one cloud only if decision D-148b allows it' },
  crossTenantAccessPolicyConfigurationDefault: {
    kind: 'tenant-setting', fixture: 'the tenant default cross-tenant settings', select: 'crossTenantAccessPolicyConfigurationDefault',
    drift: 'turn inbound trust of MFA from other tenants on or off',
  },
  crossTenantAccessPolicyPartner: {
    kind: 'tenant-setting', fixture: 'a partner entry for a Microsoft-owned tenant id Marouane chooses (decision D-148b)',
    select: 'the partner tenant id (pseudonymized in the evidence)', drift: 'turn its inbound MFA trust on or off',
    note: 'Graph refuses a tenantId that does not exist. Remove the partner entry afterwards.',
  },
  adminConsentRequestPolicy: {
    kind: 'tenant-setting', fixture: 'the tenant admin consent request policy', select: 'adminConsentRequestPolicy',
    drift: 'change requestDurationInDays',
  },
  deviceCompliancePolicy: {
    kind: 'named-object', fixture: `Windows compliance policy ${FIXTURE_PREFIX}-compliance, assigned to group ${FIXTURE_PREFIX}-group only`,
    select: `${FIXTURE_PREFIX}-compliance`, drift: 'lower its minimum password length',
  },
  deviceConfiguration: {
    kind: 'named-object', fixture: `Windows device restriction profile ${FIXTURE_PREFIX}-restrictions, assigned to group ${FIXTURE_PREFIX}-group only`,
    select: `${FIXTURE_PREFIX}-restrictions`, drift: 'block the camera',
  },
  configurationPolicy: {
    kind: 'named-object', fixture: `settings catalog policy ${FIXTURE_PREFIX}-settings (one Defender setting), assigned to group ${FIXTURE_PREFIX}-group only`,
    select: `${FIXTURE_PREFIX}-settings`, drift: 'switch its one setting off',
  },
  // Restore gaps, batch 1: Intune tenant settings. None is assigned or used by a device in the test tenant.
  deviceCategory: {
    kind: 'named-object', fixture: `device category ${FIXTURE_PREFIX}-category (no devices are in it)`,
    select: `${FIXTURE_PREFIX}-category`, drift: 'change its description',
  },
  deviceManagementReusablePolicySetting: {
    kind: 'named-object', fixture: `firewall reusable settings group ${FIXTURE_PREFIX}-addresses (one address, 203.0.113.10), used by no policy`,
    select: `${FIXTURE_PREFIX}-addresses`, drift: 'change its description',
  },
  windowsQualityUpdatePolicy: {
    kind: 'named-object', fixture: `Windows hotpatch quality update policy ${FIXTURE_PREFIX}-hotpatch, assigned to nobody`,
    select: `${FIXTURE_PREFIX}-hotpatch`, drift: 'change its description',
  },
  managedDeviceCleanupRule: {
    kind: 'named-object', fixture: `device cleanup rule ${FIXTURE_PREFIX}-cleanup for one platform the test tenant has no devices on (for example macOS), 270 days`,
    select: `${FIXTURE_PREFIX}-cleanup`, drift: 'lower it to 180 days: the restore puts back 270 (longer only; a shorter backup value is refused)',
    note: 'Update only: a deleted rule is recreated by hand. The test tenant has no managed devices, so no device can be retired.',
  },
  // Restore gaps, batch 4: scripts and remediations. Each is assigned to
  // nobody, so no device runs it; each body only prints or exits 0.
  deviceManagementScript: {
    kind: 'named-object', fixture: `Windows PowerShell script ${FIXTURE_PREFIX}-script (body: Write-Output 'KEEL-RT'), assigned to nobody`,
    select: `${FIXTURE_PREFIX}-script`, drift: 'delete it: the restore recreates it with the same script body',
  },
  deviceShellScript: {
    kind: 'named-object', fixture: `macOS shell script ${FIXTURE_PREFIX}-shell (body: echo KEEL-RT), assigned to nobody`,
    select: `${FIXTURE_PREFIX}-shell`, drift: 'change its description',
  },
  deviceHealthScript: {
    kind: 'named-object', fixture: `remediation ${FIXTURE_PREFIX}-remediation (detection and fix scripts both: exit 0), assigned to nobody`,
    select: `${FIXTURE_PREFIX}-remediation`, drift: 'delete it: the restore recreates it with both script bodies',
  },
  deviceComplianceScript: {
    kind: 'named-object', fixture: `custom compliance script ${FIXTURE_PREFIX}-compliance-script (body: return @{}), used by no compliance policy`,
    select: `${FIXTURE_PREFIX}-compliance-script`, drift: 'change its description',
  },
  // Restore gaps, batch 5: a custom attribute script and an administrative
  // template, each assigned to nobody, so no device runs or applies them.
  deviceCustomAttributeShellScript: {
    kind: 'named-object', fixture: `macOS custom attribute script ${FIXTURE_PREFIX}-attribute (attribute ${FIXTURE_PREFIX}Attribute, type string, body: echo KEEL-RT), assigned to nobody`,
    select: `${FIXTURE_PREFIX}-attribute`, drift: 'delete it: the restore recreates it with the same script body',
  },
  groupPolicyConfiguration: {
    kind: 'named-object', fixture: `administrative template ${FIXTURE_PREFIX}-admx with one setting turned on that has a text value (for example a Microsoft Edge home page set to https://example.com), assigned to nobody`,
    select: `${FIXTURE_PREFIX}-admx`, drift: 'delete it: the restore recreates it with the same setting and value',
    note: 'Use a built-in setting, not one from an imported template file.',
  },
  // Restore gaps, batch 6: an app category, an Autopilot profile and a policy
  // set, each assigned to nobody, so no device or app is affected.
  mobileAppCategory: {
    kind: 'named-object', fixture: `app category ${FIXTURE_PREFIX}-apps (no app is in it)`,
    select: `${FIXTURE_PREFIX}-apps`, drift: 'delete it: the restore recreates it with the same name',
  },
  windowsAutopilotDeploymentProfile: {
    kind: 'named-object', fixture: `Windows Autopilot profile ${FIXTURE_PREFIX}-autopilot (Microsoft Entra joined, device name template KEELRT-%RAND:4%), assigned to nobody`,
    select: `${FIXTURE_PREFIX}-autopilot`, drift: 'change its device name template: the restore puts back KEELRT-%RAND:4%',
    note: 'Assigned to nobody and the test tenant has no registered Autopilot devices, so no device picks it up.',
  },
  policySet: {
    kind: 'named-object', fixture: `policy set ${FIXTURE_PREFIX}-set holding one existing ${FIXTURE_PREFIX}- device configuration profile, assigned to nobody`,
    select: `${FIXTURE_PREFIX}-set`, drift: 'delete it: the restore recreates it and adds the same profile back',
    note: 'Back up after the set holds its profile; the profile itself is not deleted.',
  },
  // Restore gaps, batch 7: a settings catalog compliance policy assigned to
  // nobody, so no device is judged by it and Conditional Access never sees it.
  deviceManagementCompliancePolicy: {
    kind: 'named-object', fixture: `Linux settings catalog compliance policy ${FIXTURE_PREFIX}-compliance (one setting: device encryption required; actions: block after 0 hours and email the user after 24 hours with any notification template), assigned to nobody`,
    select: `${FIXTURE_PREFIX}-compliance`, drift: 'change its description and the block grace period to 72 hours: the restore puts back both (0 hours)',
    note: 'Assigned to nobody and the test tenant has no Linux devices. Back up after restore gaps batch 7 deploys, since only then are the actions read.',
  },
  // Restore gaps, batch 8: an e-book category, a Microsoft Tunnel server
  // configuration no site uses, and an Apple user enrollment profile assigned
  // to nobody, so no device, user or connection is affected.
  managedEBookCategory: {
    kind: 'named-object', fixture: `e-book category ${FIXTURE_PREFIX}-books (no book is in it)`,
    select: `${FIXTURE_PREFIX}-books`, drift: 'delete it: the restore recreates it with the same name',
  },
  microsoftTunnelConfiguration: {
    kind: 'named-object', fixture: `Microsoft Tunnel server configuration ${FIXTURE_PREFIX}-tunnel (network 10.99.0.0/24, DNS server 10.99.0.1, port 443, one included route 10.98.0.0/16), used by no site`,
    select: `${FIXTURE_PREFIX}-tunnel`, drift: 'delete it: the restore recreates it with the same network, DNS server, route and port',
    note: 'No site or server points to it, so no device connects through it.',
  },
  appleUserInitiatedEnrollmentProfile: {
    kind: 'named-object', fixture: `Apple user enrollment profile ${FIXTURE_PREFIX}-apple-enroll (iOS/iPadOS, company devices may use device enrollment, personal devices account driven user enrollment, default device), assigned to nobody`,
    select: `${FIXTURE_PREFIX}-apple-enroll`, drift: 'change its description and default enrollment type: the restore puts back both',
    note: 'Assigned to nobody, so no user is offered it. If Intune refuses to create it (for example without an Apple MDM push certificate), record that and skip this kind.',
  },
  // Restore gaps, batch 9: a Company Portal branding profile assigned to no
  // group (never the default one) and an Exchange app access scope that no app
  // role assignment uses, so no user, app or mailbox is affected.
  intuneBrandingProfile: {
    kind: 'named-object', fixture: `Company Portal branding profile ${FIXTURE_PREFIX}-branding (organization name ${FIXTURE_PREFIX} IT, theme colour #1B2A4A, help desk name and email, no logos), assigned to no group`,
    select: `${FIXTURE_PREFIX}-branding`, drift: 'delete it: the restore recreates it with the same name, colour and contact details; then change its contact name and theme colour: the restore puts back both',
    note: 'Never the default branding profile, which every user sees: KEEL refuses to write it. Logos are not backed up, so the fixture has none.',
  },
  exchangeCustomAppScope: {
    kind: 'named-object', fixture: `Exchange app access scope ${FIXTURE_PREFIX}-app-scope (recipient scope, filter PrimarySmtpAddress -like 'keel-rt-scope-none*', which matches no mailbox), used by no app role assignment`,
    select: `${FIXTURE_PREFIX}-app-scope`, drift: 'delete it: the restore recreates it with the same name and filter; then change its filter: the restore puts it back',
    note: 'A separate scope: never the existing scope that limits the mail fixture app to keel-rt- mailboxes. No app role assignment names it, so no app reaches any mailbox through it.',
  },
  // Restore gaps, batch 10: a custom Endpoint analytics baseline, a cart
  // association with no devices or classes, and two Android enrollment
  // profiles nobody enrolls with. No device, user or class is affected.
  userExperienceAnalyticsBaseline: {
    kind: 'named-object', fixture: `custom Endpoint analytics baseline ${FIXTURE_PREFIX}-baseline`,
    select: `${FIXTURE_PREFIX}-baseline`, drift: 'delete it: the restore recreates it with the same name; then rename it: the restore puts the name back',
    note: 'Never a built-in baseline: KEEL refuses to write it. If Endpoint analytics is not set up in the test tenant and the create is refused, record that and skip this kind.',
  },
  cartToClassAssociation: {
    kind: 'named-object', fixture: `classroom cart association ${FIXTURE_PREFIX}-cart (description Fixture, no devices, no classes)`,
    select: `${FIXTURE_PREFIX}-cart`, drift: 'delete it: the restore recreates it with the same name and description; then change its description: the restore puts it back',
    note: 'Names no device and no class, so nothing changes for any device. If Intune refuses to create it (for example without Intune for Education), record that and skip this kind.',
  },
  androidForWorkEnrollmentProfile: {
    kind: 'named-object', fixture: `legacy Android work profile enrollment profile ${FIXTURE_PREFIX}-android-work (description Fixture), with no token handed out`,
    select: `${FIXTURE_PREFIX}-android-work`, drift: 'delete it: the restore recreates it with the same name and description; then change its description: the restore puts it back',
    note: 'No device enrolls with it. This legacy profile kind needs the legacy Android work profile connection; if Intune refuses to create it, record that and skip this kind.',
  },
  androidDeviceOwnerEnrollmentProfile: {
    kind: 'named-object', fixture: `Android Enterprise dedicated device enrollment profile ${FIXTURE_PREFIX}-android-owner (device name template KEEL-RT-{{SERIAL}}, no Wi-Fi), with no token handed out`,
    select: `${FIXTURE_PREFIX}-android-owner`, drift: 'delete it: the restore recreates it with the same mode and name template; then change its description and name template: the restore puts back both',
    note: 'No device enrolls with it, and it joins no Wi-Fi network (a secured network is refused because its password is not backed up). Needs the managed Google Play connection; if Intune refuses to create it, record that and skip this kind.',
  },
  // Restore gaps, batch 11: an imported ADMX file no template uses, and a BIOS
  // configuration assigned to nobody. No device is affected.
  groupPolicyUploadedDefinitionFile: {
    kind: 'named-object', fixture: `imported ADMX file ${FIXTURE_PREFIX.toLowerCase()}-fixture.admx with its en-US ADML file (one setting under its own namespace and category, used by no template)`,
    select: `${FIXTURE_PREFIX.toLowerCase()}-fixture.admx`, drift: 'delete it: the restore uploads it again with the same ADMX and ADML content, and it reads as Available',
    note: 'Back it up after this batch is deployed: an older backup holds no file content and is refused. Its namespace and prefix are KEEL-RT only, so no Microsoft or real template collides.',
  },
  hardwareConfiguration: {
    kind: 'named-object', fixture: `BIOS configuration ${FIXTURE_PREFIX}-bios (per-device password on), assigned to nobody`,
    select: `${FIXTURE_PREFIX}-bios`, drift: 'change its description: the restore puts it back',
    note: 'Update only: a deleted configuration is imported again by hand. If Intune refuses to create it without a real OEM settings file, record that and skip this kind. Never assign it.',
  },
  // Restore gaps, batch 17: tenant-wide settings, approved by the user on
  // 2026-10-22 for a live proof. Each drifts one harmless value and is set back
  // to its original right after the run. None turns on anything that blocks
  // access, and Conditional Access is never touched.
  deviceManagementSettings: {
    kind: 'tenant-setting', fixture: 'the Intune tenant compliance settings (how long a device may go without checking in before it is not compliant)',
    select: 'deviceManagementSettings', drift: 'change settings.deviceComplianceCheckinThresholdDays by a few days (for example 30 to 25); write the original down first; never change secureByDefault or the device cleanup window',
    note: 'The test tenant has no managed devices, so no device changes compliance. Set the original value back right after the run.',
  },
  microsoftTunnelHealthThreshold: {
    kind: 'tenant-setting', fixture: 'one Microsoft Tunnel health limit (for example the CPU usage check)',
    select: 'microsoftTunnelHealthThreshold', drift: 'change its healthyThreshold by a few points; write the original down first',
    note: 'Only changes when a Tunnel server reads as healthy in reports; the test tenant runs no Tunnel server. If Graph lists no limits, record that and skip this kind.',
  },
  onPremisesConditionalAccessSettings: {
    kind: 'tenant-setting', fixture: 'the Exchange on-premises access settings (off)',
    select: 'onPremisesConditionalAccessSettings', drift: 'switch overrideDefaultRule to the other value while enabled stays false; write the original down first; never set enabled to true',
    note: 'Stays off the whole time, so no device or mailbox is affected; the test tenant has no Exchange on-premises server. Set the original value back right after the run.',
  },
  sharepointSettings: {
    kind: 'tenant-setting', fixture: 'the SharePoint tenant settings other than sharing (Loop, site creation, idle session sign-out)',
    select: 'sharepointSettings', drift: 'switch isLoopEnabled to the other value; write the original down first; never change legacy authentication, unmanaged sync or any sharing field',
    note: 'Set the original value back right after the run.',
  },
  // Restore gaps, batch 20: Microsoft 365 admin center org settings, each
  // drifted by one harmless value and set back right after the run.
  formsSettings: {
    kind: 'tenant-setting', fixture: 'the Microsoft Forms org settings',
    select: 'formsSettings', drift: 'switch settings.isBingImageSearchEnabled to the other value; write the original down first; never change an external sharing field or the phishing scan',
    note: 'Set the original value back right after the run.',
  },
  microsoft365AppsInstallationOptions: {
    kind: 'tenant-setting', fixture: 'the Microsoft 365 Apps installation options',
    select: 'microsoft365AppsInstallationOptions', drift: 'switch appsForWindows.isVisioEnabled to the other value; write the original down first',
    note: 'Only what people may install themselves from the portal changes, for a few minutes; installed apps are not touched. Set the original value back right after the run.',
  },
  appsAndServicesSettings: {
    kind: 'tenant-setting', fixture: 'the user owned apps and services settings',
    select: 'appsAndServicesSettings', drift: 'switch settings.isAppAndServicesTrialEnabled to the other value; write the original down first; never turn the Office Store on',
    note: 'Set the original value back right after the run.',
  },
  adminReportSettings: {
    kind: 'tenant-setting', fixture: 'the usage report privacy setting',
    select: 'adminReportSettings', drift: 'if displayConcealedNames is false, set it to true (the restore puts back false only if it is not withheld, so expect a manual step instead); if it is true, set it to false and let the restore hide names again',
    note: 'Set the original value back right after the run.',
  },
  pronounsSettings: {
    kind: 'tenant-setting', fixture: 'the pronouns org setting',
    select: 'pronounsSettings', drift: 'switch isEnabledInOrganization to the other value; write the original down first',
    note: 'Set the original value back right after the run.',
  },
  engageCommunity: {
    kind: 'named-object', fixture: `private Viva Engage community ${FIXTURE_PREFIX}-community (description Fixture), owned by a test user`,
    select: `${FIXTURE_PREFIX}-community`, drift: 'change its description: the restore puts it back; never make it public',
    note: 'Update only: a deleted community is not recreated. Delete the community (and its group) after the run.',
  },
  // Restore gaps, batch 12: a Windows app protection policy and an iOS
  // provisioning profile, both assigned to nobody. No device or user is affected.
  windowsManagedAppProtection: {
    kind: 'named-object', fixture: `Windows app protection policy ${FIXTURE_PREFIX}-win-mam covering Microsoft Edge (printing blocked, no wipe version, no wipe action), assigned to nobody`,
    select: `${FIXTURE_PREFIX}-win-mam`, drift: 'delete it: the restore recreates it with Edge as its app; then turn printing back on: the restore blocks it again',
    note: 'Back it up after this batch is deployed: an older backup holds no apps and a recreate is refused. Never assign it. If the tenant has no Windows MAM (Edge for Business) support, record that and skip this kind.',
  },
  iosLobAppProvisioningConfiguration: {
    kind: 'named-object', fixture: `iOS app provisioning profile ${FIXTURE_PREFIX}-ios-prov with a test .mobileprovision file, assigned to nobody`,
    select: `${FIXTURE_PREFIX}-ios-prov`, drift: 'delete it: the restore uploads it again with the same file; then change its description: the restore puts it back',
    note: 'Back it up after this batch is deployed: an older backup may hold no file and is refused. Intune may refuse a file that is not signed by Apple; if it does, record that and skip this kind. Never assign it.',
  },
  // Restore gaps, batch 13: a dependency between two fixture apps, neither
  // assigned. No device installs or uninstalls anything.
  mobileAppRelationship: {
    kind: 'named-object', fixture: `two web link apps ${FIXTURE_PREFIX}-app-main and ${FIXTURE_PREFIX}-app-dep, neither assigned, with ${FIXTURE_PREFIX}-app-main depending on ${FIXTURE_PREFIX}-app-dep (detect only)`,
    select: `${FIXTURE_PREFIX}-app-main`, drift: 'remove the dependency: the restore adds it back; then set it to install automatically: the restore sets it back to detect; then delete both apps and restore them with the dependency in one run: the dependency comes back between the two new apps',
    note: 'Use a dependency, never a supersedence set to replace (that uninstalls apps on devices). Never assign either app. If Intune refuses a dependency on a web link app, use two unassigned line-of-business test apps instead, or record that and skip this kind.',
  },
  // Restore gaps, batch 18: two unassigned fixture apps, one recreated in full
  // (a web link) and one as a shell waiting for its package (a Win32 app with
  // no file). Neither is ever assigned, so no device installs anything.
  mobileApp: {
    kind: 'named-object', fixture: `a web link app ${FIXTURE_PREFIX}-app-web (https://example.com/) in the app category ${FIXTURE_PREFIX}-cat and the built-in category Business, and a Win32 app shell ${FIXTURE_PREFIX}-app-win32 with no file uploaded, a file-exists detection rule and an install command that only echoes, both assigned to nobody`,
    select: `${FIXTURE_PREFIX}-app-web`, drift: 'delete both: the restore adds the web link back with its settings and in both its categories, and the Win32 app back as a shell with its commands and detection rule, plus an "upload the package" step; then change the web link\'s description and take it out of Business: the restore puts both back',
    note: 'Never assign either app. Never upload a real package to the shell. Delete both fixtures after the run if the queue item says so.',
  },
  // Restore gaps, batch 2: Entra ID tenant singletons. None touches sign-in,
  // Conditional Access or any account; each is set back to its value after the run.
  externalIdentitiesPolicy: {
    kind: 'tenant-setting', fixture: 'the tenant external identities policy (whether external users can leave the organization themselves)',
    select: 'externalIdentitiesPolicy', drift: 'switch allowExternalIdentitiesToLeave to the other value; write the original down first',
  },
  accessReviewPolicy: {
    kind: 'tenant-setting', fixture: 'the tenant access review settings (whether group owners can manage access reviews)',
    select: 'accessReviewPolicy', drift: 'switch isGroupOwnerManagementEnabled to the other value; write the original down first',
  },
  directoryRoleAccessReviewPolicy: {
    kind: 'tenant-setting', fixture: 'the tenant default settings of admin role access reviews',
    select: 'directoryRoleAccessReviewPolicy', drift: 'change settings.instanceDurationInDays (for example 14 to 7); write the original down first',
    note: 'No review is created or changed. If GET answers 404, the tenant has no such policy: report this step as blocked.',
  },
  multiTenantOrganizationIdentitySyncPolicyTemplate: {
    kind: 'tenant-setting', fixture: 'the multitenant organization user sync template', select: 'multiTenantOrganizationIdentitySyncPolicyTemplate',
    drift: 'switch userSyncInbound.isSyncAllowed to the other value; write the original down first',
    note: 'It only applies to tenants that join a multitenant organization later; the test tenant has no partner tenants joining.',
  },
  multiTenantOrganizationPartnerConfigurationTemplate: {
    kind: 'tenant-setting', fixture: 'the multitenant organization cross-tenant access template', select: 'multiTenantOrganizationPartnerConfigurationTemplate',
    drift: 'switch automaticUserConsentSettings.inboundAllowed to the other value; never change inboundTrust; write the original down first',
    note: 'It only applies to tenants that join a multitenant organization later; existing partner settings are not touched.',
  },
  // Restore gaps, batch 3: guest and app consent settings. None touches
  // Conditional Access or any account.
  b2bManagementPolicy: {
    kind: 'tenant-setting', fixture: 'the tenant guest invitation domain restriction (the one b2bManagementPolicy)',
    select: 'the policy id KEEL shows for b2bManagementPolicy',
    drift: `add keel-rt-blocked.example to BlockedDomains (or remove it if the backup holds it); write the original definition down first`,
    note: 'Only the definition is written. If the tenant has no policy, set one blocked domain keel-rt-blocked.example in the admin center first. Never block or allow a real domain.',
  },
  permissionGrantPreApprovalPolicy: {
    kind: 'tenant-setting', fixture: 'a pre-approval policy assigned to no app: one condition, scopeType chat, Microsoft Graph application permission ChatMessage.Read.Chat',
    select: 'the policy id KEEL shows for the fixture', drift: 'change the condition scopeType from chat to group',
    note: 'Never assign it to a service principal: unassigned, it pre-approves nothing. Delete it at the end.',
  },
  externalDomainFederation: {
    kind: 'named-object', fixture: `a SAML federation ${FIXTURE_PREFIX}-fed for the domain keel-rt-fed.example (sign-in https://keel-rt-fed.example/sso, a self-signed certificate)`,
    select: `${FIXTURE_PREFIX}-fed`, drift: 'change its passiveSignInUri to https://keel-rt-fed.example/drifted',
    note: 'Update only: a deleted federation is set up again by hand. No guest is invited from the domain. Delete it at the end.',
  },
  // Issue #156: basic tenant settings. None can lock anyone out.
  organizationalBranding: {
    kind: 'tenant-setting', fixture: 'the tenant default company branding (sign-in page)', select: 'organizationalBranding',
    drift: 'change its sign-in page text; write the original text down first',
    note: 'If GET /organization/{id}/branding answers 404 but the tenant has language 0, that language is the default branding: back it up, drift and restore it, and capture with --fixture organizationalBranding. If there is no language 0 either, there is nothing to update: report this step as blocked.',
  },
  organizationalBrandingLocalization: {
    kind: 'tenant-setting', fixture: 'one existing branding localization; if there is none, add fr-FR with sign-in page text KEEL-RT-148 before the snapshot',
    select: 'the language of that localization, for example fr-FR', drift: 'change its sign-in page text',
    note: 'Remove the fr-FR localization at the end if this run added it.',
  },
  // Gap M6 (#199): each uploaded branding file is journaled as its own write,
  // keyed organizationalBranding#file:<language>/<file> (language 0 is the
  // default branding). It belongs to a tenant-wide setting, so it can never
  // carry a KEEL-RT name: the capture needs --allow-tenant-setting.
  'organizationalBranding#file': {
    kind: 'tenant-setting', fixture: 'one file (for example the favicon) of the fr-FR branding localization from the step above, or of the default branding',
    select: 'organizationalBranding#file:fr-FR/favicon (the language, then the file)', drift: 'upload a different favicon for that language; keep the original file',
    note: 'A restore of the branding journals each file it uploads apart from the text and colours: capture it with --resource-type \'organizationalBranding#file\', not as the localization.',
  },
  groupLifecyclePolicy: {
    kind: 'tenant-setting', fixture: 'the tenant group expiration policy; if there is none, create one for Selected groups holding only KEEL-RT-148-group, lifetime 365 days',
    select: 'the policy id KEEL shows (it has no name)', drift: 'make the lifetime LONGER (for example 400 days), never shorter: a shorter lifetime can expire and delete Microsoft 365 groups',
    note: 'KEEL guards this write because it can delete groups. Delete the policy at the end if this run created it.',
  },
  authenticationFlowsPolicy: {
    kind: 'tenant-setting', fixture: 'the tenant authentication flows policy (self-service sign-up for external users)', select: 'authenticationFlowsPolicy',
    drift: 'switch self-service sign-up on or off',
  },
  authorizationPolicy: {
    kind: 'tenant-setting', lockout: true, fixture: 'the tenant authorization policy', select: 'authorizationPolicy',
    drift: 'change allowInvitesFrom (guest invitations) only; never touch default user role permissions',
    breakGlass: 'The lockout gate must allow the write. Only guest invitation settings change, which no break-glass sign-in depends on.',
  },
  unifiedRoleManagementPolicy: {
    kind: 'tenant-setting', lockout: true, fixture: `the PIM settings policy of ${FIXTURE_PREFIX}-role (never a built-in role's policy)`,
    select: `the PIM policy id of ${FIXTURE_PREFIX}-role`, drift: 'turn off "require MFA on activation"; the restore turns it back on',
    breakGlass: 'No break-glass account is eligible for or assigned the fixture role. KEEL refuses any change that weakens protection.',
  },
  authenticationMethodsPolicy: {
    kind: 'tenant-setting', lockout: true, fixture: 'the tenant authentication methods policy',
    select: 'authenticationMethodsPolicy', drift: 'switch one method the break-glass accounts do not use (for example SMS) on or off; never FIDO2 or the methods they sign in with',
    breakGlass: 'The break-glass readiness report must name the methods each break-glass account signs in with, and none of them is the drifted method. The lockout gate checks readiness under the proposed policy.',
  },
  identitySecurityDefaultsEnforcementPolicy: {
    kind: 'tenant-setting', lockout: true, fixture: 'the tenant security defaults setting', select: 'identitySecurityDefaultsEnforcementPolicy',
    drift: 'only possible when the tenant has no Conditional Access policy turned on; otherwise Entra refuses the change. If so, report this step as blocked (not failed) and do not demote it',
    breakGlass: 'Security defaults force MFA registration for every account: confirm both break-glass accounts have a registered method before the write.',
  },
  conditionalAccessPolicy: {
    kind: 'named-object', lockout: true,
    fixture: `Conditional Access policy ${FIXTURE_PREFIX}-ca: report-only, block access, users = group ${FIXTURE_PREFIX}-ca-users (holding only keel-rt-20260908-carla), excluding every break-glass account, all cloud apps`,
    select: `${FIXTURE_PREFIX}-ca`, drift: 'change its display name to end in -drifted',
    breakGlass: 'The fixture policy targets only the fixture group and excludes every break-glass account. KEEL writes it report-only; the lockout gate must allow it.',
    restoreBefore: 'Turn the fixture policy on (it blocks only carla) BEFORE the snapshot, so the backup has it enabled; after the snapshot delete it (soft delete only). The restore brings it back report-only and leaves the "turn on" item the next step uses.',
  },
});

/** The supported ledger rows, plus edges: the only source of operations. */
export function registeredOperations({ ledger = buildOperationLedger() } = {}) {
  const rows = [
    ...ledger.types.flatMap((type) => type.operations),
    ...ledger.edges,
  ];
  return rows.filter((row) => row.decision === 'supported');
}

function batchOf(resourceType, inventory) {
  if (resourceType.includes('#')) return 'relationship';
  for (const batch of inventory.batches) {
    if (batch.types.some((entry) => entry.resourceType === resourceType)) return batch.id;
  }
  return 'unbatched';
}

function blastRadiusOf(resourceType) {
  const base = resourceType.split('#')[0];
  return CATALOG.find((entry) => entry.type === base)?.blastRadius ?? 'access-affecting';
}

/**
 * Issue #295: id-keyed types that still carry a display name of their own. The
 * token lifetime, token issuance, claims mapping and home realm discovery
 * policies are keyed by id (names are not unique) but point at no principal or
 * role, so the capture checks their display name (KEEL-RT-...) as for a named
 * object, never --allow-by-reference.
 */
const NAMED_ID_KEY_TYPES = new Set(Object.values(DIRECTORY_POLICY_RECORDS)
  .filter((record) => record.family === 'sts-policy')
  .map((record) => record.resourceType));

/** The reviewed guidance for a type, or generic guidance derived from the catalogue. */
export function guidanceFor(resourceType) {
  const reviewed = FIXTURE_GUIDANCE[resourceType];
  if (reviewed) {
    // The catalogue's tenant-lockout rating (and a lockout-gated tenant policy)
    // is never dropped silently: only `lockout: false` with a stated reason lowers it.
    const rated = TENANT_POLICY_LOCKOUT.has(resourceType) || blastRadiusOf(resourceType) === 'tenant-lockout';
    if (reviewed.lockout === false && rated && !(typeof reviewed.lockoutReason === 'string' && reviewed.lockoutReason.length > 0)) {
      throw new Error(`${resourceType}: lockout: false needs a lockoutReason, because the catalogue rates it tenant-lockout`);
    }
    const lockout = reviewed.lockout === false ? false : (reviewed.lockout === true || rated);
    return { ...reviewed, lockout, reviewed: true };
  }
  const singleton = SINGLETON_TYPES.has(resourceType);
  const lockout = TENANT_POLICY_LOCKOUT.has(resourceType) || blastRadiusOf(resourceType) === 'tenant-lockout';
  const idKeyed = ID_KEY_TYPES.has(resourceType);
  const namedById = idKeyed && NAMED_ID_KEY_TYPES.has(resourceType);
  return {
    reviewed: false,
    kind: singleton ? 'tenant-setting' : idKeyed && !namedById ? 'by-reference' : 'named-object',
    lockout,
    // An id-keyed type with no name of its own has nothing to make disposable: the operator picks the object.
    fixture: singleton ? `the tenant's one ${resourceType} object`
      : namedById ? `a disposable ${resourceType} whose display name starts KEEL-RT- (it is keyed by its id)`
        : idKeyed ? `an existing ${resourceType} that only touches KEEL-RT fixtures (it has no name of its own)`
          : `a disposable ${resourceType} named ${FIXTURE_PREFIX}-${resourceType}`,
    select: singleton ? resourceType : idKeyed ? `the ${resourceType} id KEEL shows` : `${FIXTURE_PREFIX}-${resourceType}`,
    drift: 'change one field the restore writes (see the type\'s operation record)',
    breakGlass: lockout ? 'Not reviewed for this type yet: treat it as able to lock people out. Get decision D-148a extended to this type before running it.' : null,
    note: 'No reviewed guidance yet for this type: read its roadmap doc before running, and add an entry to FIXTURE_GUIDANCE.',
  };
}

const capture = (resourceType, operation, guidance, key) => {
  const flags = guidance.kind === 'tenant-setting' ? ' --allow-tenant-setting' : guidance.kind === 'by-reference' ? ' --allow-by-reference' : '';
  return `node tools/qualification/entraLive.mjs capture --restore-ref "$A" --resource-type '${resourceType}' --operation ${operation}`
    + ` --fixture '${key}' --target-config "$RESTORER" --build "$B" --out "$OUT"${flags}`;
};

/** The file name stem of one operation's evidence (an edge key's # becomes a dot). */
export const evidenceStem = (resourceType, operation) => `${resourceType.replace('#', '.')}.${operation}`;

function setupFor(resourceType, operation, guidance, key) {
  const restoreRun = [
    'node cli/keel-collect.mjs --config "$COLLECTOR"   # note the snapshot id as S',
    '# now change the tenant as in "Before the restore"',
    `node cli/keel-restore.mjs --snapshot-id "$S" --select '${key}' --collector-config "$COLLECTOR" --target-config "$RESTORER" --persist-artifact "$A" --requested-by keel-operator`,
    '# Marouane approves artifact A in the portal (Restore, review). The requester can never approve it.',
    'node cli/keel-restore.mjs --artifact "$A" --enforce',
  ];
  switch (operation) {
    case 'create':
      return {
        before: guidance.kind === 'tenant-setting'
          ? 'Remove the object (it is recreated from the snapshot).'
          : 'Delete the fixture, then permanently delete it from deleted items, so the restore has to create it.',
        commands: restoreRun,
        cleanup: guidance.kind === 'tenant-setting' ? 'Confirm the recreated object matches the value written down before the run.' : 'Keep the recreated fixture: the next steps use it. It is removed in the end-of-run cleanup.',
      };
    case 'update':
      return {
        before: `Drift the fixture: ${guidance.drift ?? 'change one field the restore writes'}.`,
        commands: restoreRun,
        cleanup: guidance.kind === 'tenant-setting' ? 'None: the restore put the original value back. Read it once to confirm.' : 'Keep the fixture for later steps, or delete it at the end of the run.',
      };
    case 'restore-soft-deleted':
      return {
        before: guidance.restoreBefore ?? 'Delete the fixture (soft delete only: it must stay in deleted items).',
        commands: restoreRun,
        cleanup: 'Keep the fixture for later steps, or delete it and permanently delete it from deleted items at the end.',
      };
    case 'delete':
      return {
        before: 'Take the snapshot BEFORE the fixture exists. Then create the fixture, so the snapshot says it should not exist.',
        commands: [
          'node cli/keel-collect.mjs --config "$COLLECTOR"   # snapshot S, taken before the fixture exists',
          'node cli/keel-baseline-create.mjs --snapshot-id "$S" --supersedes "$BASELINE" --set-by keel-operator --label live-gate-148',
          'node cli/keel-baseline-activate.mjs --baseline-id "$NEW_BASELINE" --config "$COLLECTOR"   # the version the line above printed',
          '# now create the fixture',
          'node cli/keel-drift.mjs detect --config "$COLLECTOR"',
          'node cli/keel-drift.mjs list --config "$COLLECTOR"   # note the drift id D for the fixture',
          'node cli/keel-remediate.mjs --drift-id "$D" --collector-config "$COLLECTOR" --target-config "$RESTORER"   # dry run; note its artifact id as A',
          '# Marouane approves artifact A in the portal (Restore, review).',
          'node cli/keel-restore.mjs --artifact "$A" --enforce',
        ],
        cleanup: 'Reinstate the baseline version that was active before (`node cli/keel-baseline-activate.mjs --baseline-id "$BASELINE" --reinstate --actor keel-operator --reason "live gate 148 delete step done" --config "$COLLECTOR"`): it is superseded, so it is copied into a new latest version and that one is activated. Permanently delete the fixture from deleted items if it is there.',
      };
    case 'edge-add':
      return {
        before: guidance.add ?? 'Remove the relationship after the snapshot.',
        commands: restoreRun,
        cleanup: 'Remove the fixture user from the group again.',
      };
    case 'edge-remove':
      return {
        before: guidance.remove ?? 'Add the relationship after the snapshot.',
        commands: restoreRun,
        cleanup: 'None: the restore removed it. Read the group once to confirm.',
      };
    default:
      return { before: 'No reviewed procedure for this operation.', commands: restoreRun, cleanup: 'Remove what the step created.' };
  }
}

/**
 * Issue #641: the key `keel-restore --select` and `entraLive capture --fixture`
 * take. A snapshot stores every object under `<type>:<natural key>`
 * (engine/cir/canonicalize.mjs), so a bare name is never in the candidate set.
 *  - A select that is a description, not a key, stays a placeholder the operator fills in.
 *  - A relationship edge (`group#member`) is restored through its parent group.
 *  - A singleton keyed by its type name is `<type>:<type>`. A singleton keyed by
 *    its display name (authorizationPolicy, say) has a key Graph decides, so it
 *    stays a placeholder rather than a guess.
 *  - An id-keyed kind (deviceCategory, roleDefinition, ...) is stored under its
 *    Graph id, which only the snapshot knows: a placeholder too.
 */
export function restoreKeyFor(resourceType, select) {
  if (/\s/.test(select)) return `<natural key: ${select}>`;
  const type = resourceType.split('#')[0];
  if (select === type && !CONSTANT_KEY_TYPES.has(type)) {
    return `<natural key: the key KEEL shows for the tenant's one ${type} object (it starts ${type}:)>`;
  }
  // These kinds are keyed by their Graph id (a role definition by its template
  // id), never by the fixture's name, so the name alone is never in the snapshot.
  if (ID_KEY_TYPES.has(type) || type === 'roleDefinition') {
    return `<natural key: the id KEEL shows for ${select} (it starts ${type}:)>`;
  }
  return `${type}:${select}`;
}

function stepFor(row, inventory) {
  const { resourceType, operation } = row;
  const guidance = guidanceFor(resourceType);
  // A delete needs an object the snapshot does not have: a second fixture, so the
  // one the other steps use is never deleted.
  const separate = operation === 'delete' && guidance.kind === 'named-object';
  const select = separate ? `${guidance.select}-delete` : guidance.select;
  const key = restoreKeyFor(resourceType, select);
  const setup = setupFor(resourceType, operation, guidance, key);
  const stem = evidenceStem(resourceType, operation);
  return {
    id: `${resourceType}:${operation}`,
    resourceType,
    operation,
    batch: batchOf(resourceType, inventory),
    blastRadius: blastRadiusOf(resourceType),
    claim: row.claim,
    alreadyLive: row.claim === 'live-qualified',
    lockoutSensitive: guidance.lockout,
    reviewedGuidance: guidance.reviewed,
    fixtureKind: guidance.kind,
    testObject: separate ? `a second fixture like the one above (${guidance.fixture}), named ${guidance.select}-delete, created after the snapshot` : guidance.fixture,
    select,
    key,
    breakGlass: guidance.lockout ? [...BREAK_GLASS_COMMON, guidance.breakGlass ?? ''].filter(Boolean) : null,
    sharedRunAllowed: !guidance.lockout && operation !== 'delete',
    before: setup.before,
    commands: [...setup.commands, capture(resourceType, operation, guidance, key)],
    cleanup: setup.cleanup,
    evidence: [`$OUT/${stem}.json (the signed record)`, `$OUT/${stem}.capture.json (the pseudonymized journal entry it binds)`],
    promote: `node tools/qualification/entraLive.mjs promote --evidence "$OUT/${stem}.json"`,
    onFailure: `node tools/qualification/entraLive.mjs demote --resource-type '${resourceType}' --operation ${operation} --restore-ref "$A" --reason '<what failed, in plain words>' --out "$OUT"`,
    note: guidance.note ?? null,
  };
}

function enforcementStep() {
  const guidance = guidanceFor('conditionalAccessPolicy');
  const key = restoreKeyFor('conditionalAccessPolicy', `${FIXTURE_PREFIX}-ca`);
  return {
    id: `conditionalAccessPolicy:${ENFORCEMENT_STEP}`,
    resourceType: 'conditionalAccessPolicy',
    operation: ENFORCEMENT_STEP,
    batch: 'policy',
    blastRadius: 'tenant-lockout',
    claim: null,
    alreadyLive: false,
    lockoutSensitive: true,
    reviewedGuidance: true,
    fixtureKind: 'named-object',
    testObject: `${FIXTURE_PREFIX}-ca, restored report-only by the restore-soft-deleted step from a snapshot where it was turned on (for carla only)`,
    select: `${FIXTURE_PREFIX}-ca`,
    key,
    breakGlass: [...BREAK_GLASS_COMMON, guidance.breakGlass, 'This is the one step that turns a policy ON. It blocks only carla. The lockout gate runs at planning and again at execution.'],
    sharedRunAllowed: false,
    before: 'Run right after the Conditional Access restore-soft-deleted step, whose restore left an open "turn on" item for the policy.',
    commands: [
      `node cli/keel-restore.mjs --enforce-conditional-access "$A" --policy '${key}' --persist-artifact "$E" --requested-by keel-operator`,
      '# Marouane approves artifact E in the portal (Restore, review).',
      'node cli/keel-restore.mjs --artifact "$E" --enforce',
      `node tools/qualification/entraLive.mjs capture --restore-ref "$E" --resource-type conditionalAccessPolicy --operation ${ENFORCEMENT_STEP} --fixture '${key}' --target-config "$RESTORER" --build "$B" --out "$OUT"`,
    ],
    cleanup: `Delete ${FIXTURE_PREFIX}-ca and permanently delete it from deleted items. Confirm carla can sign in again.`,
    evidence: [`$OUT/conditionalAccessPolicy.${ENFORCEMENT_STEP}.json`, `$OUT/conditionalAccessPolicy.${ENFORCEMENT_STEP}.capture.json`],
    promote: null,
    promoteNote: 'Not a ledger row: turning a policy on is a separate approved step, not a registered capability. The capture is kept with the Conditional Access records as evidence; promote refuses it.',
    onFailure: `node tools/qualification/entraLive.mjs demote --resource-type conditionalAccessPolicy --operation ${ENFORCEMENT_STEP} --restore-ref "$E" --reason '<what failed>' --out "$OUT"`,
    note: 'If the write could not be confirmed, KEEL says "may be ON": turn the policy off by hand at once and report.',
  };
}

// Reviewed types run in FIXTURE_GUIDANCE order (dependencies first: the fixture
// group before the Intune policies assigned to it, the custom role before its
// assignments). An unreviewed type runs after the reviewed ones of its class;
// an unreviewed lockout-sensitive type runs just before Conditional Access.
const GUIDANCE_ORDER = Object.keys(FIXTURE_GUIDANCE);

function sortKey(step) {
  const reviewedIndex = GUIDANCE_ORDER.indexOf(step.resourceType);
  let rank = reviewedIndex;
  if (reviewedIndex < 0) rank = step.lockoutSensitive ? GUIDANCE_ORDER.indexOf('conditionalAccessPolicy') - 0.5 : 1000 + (BLAST_RANK[step.blastRadius] ?? 1);
  const operationRank = step.operation === ENFORCEMENT_STEP ? 2.5 : (OPERATION_RANK[step.operation] ?? 50);
  return [step.lockoutSensitive ? 1 : 0, rank, step.batch, step.resourceType, operationRank];
}

function compare(left, right) {
  const a = sortKey(left);
  const b = sortKey(right);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    return typeof a[i] === 'number' ? a[i] - b[i] : String(a[i]).localeCompare(String(b[i]));
  }
  return 0;
}

/** The full checklist, derived from the ledger now. */
export function buildLiveGatePlan({ ledger = buildOperationLedger(), inventory = buildExpansionInventory() } = {}) {
  const operations = registeredOperations({ ledger });
  const steps = operations.map((row) => stepFor(row, inventory));
  if (operations.some((row) => row.resourceType === 'conditionalAccessPolicy' && row.operation === 'restore-soft-deleted')) {
    steps.push(enforcementStep());
  }
  steps.sort(compare);
  return {
    version: LIVE_GATE_PLAN_VERSION,
    issue: LIVE_GATE_ISSUE,
    ledgerContractVersion: ledger.contractVersion,
    operationCount: operations.length,
    stepCount: steps.length,
    preconditions: [
      'Test tenant only. The capture tool refuses any tenant whose reference is not the test tenant\'s.',
      'Run from your own checkout at the deployed build B (`git -C /opt/keel-live rev-parse HEAD`), never in /opt/keel.',
      'KEEL_QUALIFICATION_HMAC_KEY is set in the environment (signs the records); never print it.',
      'Captures are pseudonymized (#138): no raw tenant id, object id or host leaves the host. The capture tool checks this and refuses otherwise.',
      'Fixtures are only KEEL-RT-* or keel-rehearsal-* objects, or the tenant-wide settings named in decision D-148b.',
    ],
    variables: {
      B: 'the deployed build', COLLECTOR: '/etc/keel/tenant.json', RESTORER: '/etc/keel/restorer.json',
      OUT: 'a fresh evidence directory, e.g. ~/keel-148/<B>', S: 'the snapshot id from keel-collect',
      A: 'a fresh dry-run artifact id (uuidgen) per restore', E: 'a fresh artifact id for the enforcement step',
      BASELINE: 'the id of the baseline active before the run (delete steps only)', NEW_BASELINE: 'the baseline version a delete step creates',
      D: 'a drift id (delete steps only)',
    },
    steps,
    finalCleanup: [
      `Delete every ${FIXTURE_PREFIX}-* object the run created or recreated, and permanently delete each from deleted items.`,
      'Put back any tenant-wide setting to the value written down before the run, and read it once.',
      'Re-activate the baseline that was active before the run, if a delete step changed it.',
      'Check the break-glass readiness report one last time.',
    ],
  };
}

export function renderMarkdown(plan) {
  const lines = [
    `# Live gate #${plan.issue}: Entra writes on the test tenant`,
    '',
    `Generated from the operation ledger: ${plan.operationCount} registered operations, ${plan.stepCount} steps. Do them in this order.`,
    '',
    '## Before you start',
    '',
    ...plan.preconditions.map((line) => `- ${line}`),
    '',
    '## Variables',
    '',
    ...Object.entries(plan.variables).map(([name, meaning]) => `- \`$${name}\`: ${meaning}`),
    '',
  ];
  plan.steps.forEach((step, index) => {
    lines.push(`## ${index + 1}. ${step.resourceType} ${step.operation}${step.lockoutSensitive ? ' (lockout-sensitive)' : ''}`, '');
    if (step.alreadyLive) lines.push('- Already live-qualified: recapture only if the record is older than 30 days.');
    if (!step.reviewedGuidance) lines.push('- **No reviewed guidance for this type yet.** Read its roadmap doc first.');
    lines.push(`- Test object: ${step.testObject}`);
    lines.push(`- Select: ${step.key}`);
    lines.push(step.sharedRunAllowed
      ? '- Shared run: allowed (may share one snapshot and one restore with other shared steps)'
      : '- Shared run: no (runs alone, with its own snapshot and restore)');
    if (step.breakGlass) {
      lines.push('- Break-glass precondition:');
      for (const item of step.breakGlass) lines.push(`  - ${item}`);
    }
    lines.push(`- Before the restore: ${step.before}`);
    lines.push('- Commands:', '', '```sh', ...step.commands, '```', '');
    lines.push(`- Cleanup: ${step.cleanup}`);
    lines.push(`- Evidence: ${step.evidence.join('; ')}`);
    lines.push(step.promote ? `- Promote: \`${step.promote}\`` : `- Promote: none. ${step.promoteNote}`);
    lines.push(`- On failure: \`${step.onFailure}\``);
    if (step.note) lines.push(`- Note: ${step.note}`);
    lines.push('');
  });
  lines.push('## End of run', '', ...plan.finalCleanup.map((line) => `- ${line}`), '');
  return lines.join('\n');
}

export function main({ argv = process.argv.slice(2), out = console } = {}) {
  let plan;
  try {
    plan = buildLiveGatePlan();
  } catch (error) {
    out.error(error.message);
    return 1;
  }
  if (argv.includes('--json')) out.log(JSON.stringify(plan, null, 2));
  else if (argv.includes('--summary')) {
    out.log(`${plan.operationCount} registered operations, ${plan.stepCount} steps`);
    plan.steps.forEach((step, index) => out.log(`${String(index + 1).padStart(2)}. ${step.lockoutSensitive ? '[lockout] ' : ''}${step.resourceType} ${step.operation} (${step.claim ?? 'step'})`));
  } else out.log(renderMarkdown(plan));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
