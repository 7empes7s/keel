/**
 * Every Microsoft permission Keel's two apps use, in plain words: what it lets the
 * app do, what Keel uses it for, and which service it belongs to. The setup page
 * compares this list with what each app holds in the tenant, so the admin sees one
 * table: granted, missing, optional, or held but never used by Keel.
 *
 * The names here are declared elsewhere, where the code uses them: the collector's
 * reads (discovery/grants.mjs, collect/workloadContract.mjs, bootstrap/prerequisites.mjs)
 * and the restorer's writes (restore/*Operations.mjs, coverage/qualification.mjs,
 * restore/workloads/writeDeclarations.mjs). permissionCatalog.test.mjs checks both
 * ways, so a permission the code starts using cannot be missing here, and one it
 * stops using cannot linger as "needed".
 *
 * The content reader (the third app, which reads mail, files and Teams content) is
 * listed too, against its prerequisite in bootstrap/prerequisites.mjs. So are the admin
 * roles each app needs (type 'admin-role'): Microsoft's admin consent never assigns a
 * role, so the table shows them beside the permissions with their own fix link.
 */

// The Microsoft APIs Keel asks permissions of, by their well-known app ids.
export const PERMISSION_APIS = Object.freeze({
  graph: Object.freeze({ appId: '00000003-0000-0000-c000-000000000000', label: 'Microsoft Graph' }),
  exchange: Object.freeze({ appId: '00000002-0000-0ff1-ce00-000000000000', label: 'Exchange Online' }),
  sharepoint: Object.freeze({ appId: '00000003-0000-0ff1-ce00-000000000000', label: 'SharePoint' }),
  // Not APIs: where an admin role lives. Entra roles are directory roles; the Intune
  // role is granted to a group the app is in.
  directory: Object.freeze({ appId: null, label: 'Entra admin role' }),
  intune: Object.freeze({ appId: null, label: 'Intune role' }),
});

export function apiForAppId(appId) {
  if (!appId) return null;
  return Object.entries(PERMISSION_APIS).find(([, api]) => api.appId === appId)?.[0] ?? null;
}

// Services in the order the portal lists them, and the kinds of setting inside each,
// in order: people and groups first, then roles and apps, then policies and settings.
export const PERMISSION_SERVICES = Object.freeze([
  Object.freeze({ key: 'entra', label: 'Entra ID' }),
  Object.freeze({ key: 'governance', label: 'Identity governance' }),
  Object.freeze({ key: 'intune', label: 'Intune' }),
  Object.freeze({ key: 'exchange', label: 'Exchange' }),
  Object.freeze({ key: 'sharepoint', label: 'SharePoint and OneDrive' }),
  Object.freeze({ key: 'teams', label: 'Teams' }),
  Object.freeze({ key: 'planner', label: 'Planner and To Do' }),
  Object.freeze({ key: 'purview', label: 'Purview and security' }),
  Object.freeze({ key: 'other', label: 'Other Microsoft 365 services' }),
  Object.freeze({ key: 'reports', label: 'Audit logs, health and reports' }),
]);

export const PERMISSION_KINDS = Object.freeze([
  'Users', 'Groups', 'Memberships', 'Roles', 'Devices', 'Apps', 'Policies', 'Settings', 'Content',
]);

// How a permission is held: 'application' (the app acts as itself, granted by admin
// consent), 'delegated' (the app acts as a signed-in account, for settings Microsoft
// only shows to a user) or 'admin-role' (an Entra or Intune role assigned to the app;
// consent cannot grant it). No delegated permission is listed yet; the table already
// shows the type so delegated access can join it.
export const PERMISSION_TYPES = Object.freeze(['application', 'delegated', 'admin-role']);

// Entra role template ids: Microsoft-global constants, identical in every tenant. A
// built-in role's assignment names this id as its roleDefinitionId.
export const ADMIN_ROLE_TEMPLATES = Object.freeze({
  'Global Administrator': '62e90394-69f5-4237-9190-012177145e10',
  'Exchange Administrator': '29232cdf-9323-42fd-ade2-1d097af3e4de',
  'SharePoint Administrator': 'f28a1f50-f6e7-4571-818b-6a12f2af6b6c',
  'Teams Administrator': '69091246-20e8-4a56-aa4d-066075b2a7a8',
  'Compliance Administrator': '17315797-102d-40b4-93e0-432062caca18',
});

// need: 'required' when a backup or restore fails without it; 'optional' when it only
// adds a feature Keel is building (the page says what it unlocks).
const entry = (identity, api, name, service, kind, words, usedFor, need = 'required', type = 'application') =>
  Object.freeze({ identity, api, name, service, kind, words, usedFor, need, type });
const read = (name, service, kind, words, usedFor, need) => entry('collector', 'graph', name, service, kind, words, usedFor, need);
const write = (name, service, kind, words, usedFor, need) => entry('restorer', 'graph', name, service, kind, words, usedFor, need);
const content = (name, service, kind, words, usedFor, need) => entry('content-reader', 'graph', name, service, kind, words, usedFor, need);
// An Entra directory role ('directory', matched on its template id) or an Intune role
// ('intune', matched on its name).
const role = (identity, api, name, service, words, usedFor) => Object.freeze({
  ...entry(identity, api, name, service, 'Roles', words, usedFor, 'required', 'admin-role'),
  templateId: api === 'directory' ? ADMIN_ROLE_TEMPLATES[name] : null,
});

export const KEEL_PERMISSIONS = Object.freeze([
  // ---- Backup reader (collector): read-only.
  role('collector', 'intune', 'Read Only Operator', 'intune', 'Intune read-only role', 'Read Intune settings that need an Intune role as well as a permission'),
  role('collector', 'directory', 'Exchange Administrator', 'exchange', 'Exchange admin role', 'Read Exchange settings with admin commands; Microsoft has no read-only role that works for an app'),
  role('collector', 'directory', 'SharePoint Administrator', 'sharepoint', 'SharePoint admin role', 'Read SharePoint tenant and site admin settings'),
  role('collector', 'directory', 'Teams Administrator', 'teams', 'Teams admin role', 'Back up Teams meeting, messaging, calling and voice policies'),
  role('collector', 'directory', 'Compliance Administrator', 'purview', 'Compliance admin role', 'Back up retention, data loss prevention, label and eDiscovery settings'),
  read('User.Read.All', 'entra', 'Users', 'Read every user', 'Back up users and spot changes to them'),
  read('OrgContact.Read.All', 'entra', 'Users', 'Read organisation contacts', 'Back up external contacts in the directory'),
  read('PeopleSettings.Read.All', 'entra', 'Users', 'Read profile card settings', 'Back up profile card fields, pronouns and item insights'),
  read('Group.Read.All', 'entra', 'Groups', 'Read groups', 'Back up groups and their settings'),
  read('GroupMember.Read.All', 'entra', 'Memberships', 'Read group members', 'Back up who is in each group and team'),
  read('RoleManagement.Read.Directory', 'entra', 'Roles', 'Read admin roles', 'Back up admin roles and who holds them'),
  read('RoleManagement.Read.All', 'entra', 'Roles', 'Read roles in every service', 'Back up role settings outside Entra ID'),
  read('Device.Read.All', 'entra', 'Devices', 'Read devices in the directory', 'Back up device records'),
  read('Application.Read.All', 'entra', 'Apps', 'Read app registrations', 'Back up apps, their owners and permissions'),
  read('DelegatedPermissionGrant.Read.All', 'entra', 'Apps', 'Read user consents to apps', 'Back up which apps people allowed'),
  read('Policy.Read.All', 'entra', 'Policies', 'Read sign-in rules and other policies', 'Back up Conditional Access and tenant policies'),
  read('IdentityProvider.Read.All', 'entra', 'Policies', 'Read external sign-in providers', 'Back up Google, Facebook and other sign-in options'),
  read('CustomAuthenticationExtension.Read.All', 'entra', 'Policies', 'Read custom sign-in extensions', 'Back up sign-in extensions'),
  read('IdentityUserFlow.Read.All', 'entra', 'Policies', 'Read guest sign-up flows', 'Back up self-service sign-up'),
  read('APIConnectors.Read.All', 'entra', 'Policies', 'Read sign-up API connectors', 'Back up sign-up connectors'),
  read('Directory.Read.All', 'entra', 'Settings', 'Read directory settings', 'Back up directory settings and deleted items'),
  read('Organization.Read.All', 'entra', 'Settings', 'Read organisation details and licences', 'Back up tenant details and licences'),
  read('Domain.Read.All', 'entra', 'Settings', 'Read domains', 'Back up domains and federation'),
  read('CustomSecAttributeDefinition.Read.All', 'entra', 'Settings', 'Read custom security attributes', 'Back up attribute definitions'),
  read('MultiTenantOrganization.Read.All', 'entra', 'Settings', 'Read multitenant organisation', 'Back up linked tenants'),
  read('AccessReview.Read.All', 'governance', 'Policies', 'Read access reviews', 'Back up access reviews'),
  read('EntitlementManagement.Read.All', 'governance', 'Policies', 'Read access packages', 'Back up access packages and catalogs'),
  read('LifecycleWorkflows.Read.All', 'governance', 'Policies', 'Read joiner and leaver workflows', 'Back up lifecycle workflows'),
  read('PrivilegedAccess.Read.AzureADGroup', 'governance', 'Policies', 'Read groups under Privileged Identity Management', 'Back up which groups need approval or activation before someone joins them'),
  read('Agreement.Read.All', 'governance', 'Policies', 'Read terms of use', 'Back up terms of use'),
  read('DeviceManagementRBAC.Read.All', 'intune', 'Roles', 'Read Intune roles', 'Back up Intune roles and scope tags'),
  read('DeviceManagementManagedDevices.Read.All', 'intune', 'Devices', 'Read managed devices', 'Back up device categories and device settings'),
  read('CloudPC.Read.All', 'intune', 'Devices', 'Read Cloud PCs', 'Back up Windows 365 settings'),
  read('DeviceManagementApps.Read.All', 'intune', 'Apps', 'Read Intune apps', 'Back up app protection and app settings'),
  read('DeviceManagementConfiguration.Read.All', 'intune', 'Policies', 'Read Intune device settings', 'Back up device and compliance policies'),
  read('DeviceManagementServiceConfig.Read.All', 'intune', 'Settings', 'Read Intune enrolment settings', 'Back up enrolment and Autopilot settings'),
  read('MailboxSettings.Read', 'exchange', 'Settings', 'Read mailbox settings', 'Back up mailbox settings such as auto-replies'),
  entry('collector', 'exchange', 'Exchange.ManageAsApp', 'exchange', 'Settings', 'Run Exchange admin commands', 'Read Exchange and Purview settings; the Exchange role group limits it to reading'),
  read('Sites.Read.All', 'sharepoint', 'Settings', 'Read sites', 'Find sites and back up their settings'),
  read('Sites.FullControl.All', 'sharepoint', 'Settings', 'Full control of sites', 'Read which apps can reach each site; Microsoft offers no read-only permission for this'),
  read('SharePointTenantSettings.Read.All', 'sharepoint', 'Settings', 'Read SharePoint settings', 'Back up tenant-wide sharing and site settings'),
  read('TeamMember.Read.All', 'teams', 'Memberships', 'Read team members', 'Back up team owners and members'),
  read('AppCatalog.Read.All', 'teams', 'Apps', 'Read the Teams app catalogue', 'Back up the Teams apps your organisation uploaded'),
  read('Team.ReadBasic.All', 'teams', 'Settings', 'List teams', 'Find every team'),
  read('TeamSettings.Read.All', 'teams', 'Settings', 'Read team settings', 'Back up each team\'s settings'),
  read('TeamworkTag.Read.All', 'teams', 'Settings', 'Read team tags', 'Back up tags in each team'),
  read('OrgSettings-Todo.Read.All', 'planner', 'Settings', 'Read To Do settings', 'Back up whether To Do lists can be shared outside the organisation'),
  read('InformationProtectionPolicy.Read.All', 'purview', 'Policies', 'Read sensitivity labels', 'Back up sensitivity labels'),
  read('CustomDetection.Read.All', 'purview', 'Policies', 'Read custom detection rules', 'Back up Defender custom detection rules'),
  read('SecurityEvents.Read.All', 'purview', 'Settings', 'Read security settings', 'Back up security settings'),
  read('IdentityRiskEvent.Read.All', 'purview', 'Settings', 'Read risky sign-in detections', 'Back up Identity Protection settings'),
  read('Community.Read.All', 'other', 'Groups', 'Read Viva Engage communities', 'Back up Viva Engage communities'),
  read('OrgSettings-Microsoft365Install.Read.All', 'other', 'Apps', 'Read Microsoft 365 Apps install options', 'Back up which Office apps people can install themselves'),
  read('OrgSettings-AppsAndServices.Read.All', 'other', 'Apps', 'Read Office Store and trial settings', 'Back up whether people can use the Office Store and start trials'),
  read('Place.Read.All', 'other', 'Settings', 'Read rooms and buildings', 'Back up room lists'),
  read('Printer.Read.All', 'other', 'Settings', 'Read printers', 'Back up Universal Print settings'),
  read('ExternalConnection.Read.All', 'other', 'Settings', 'Read search connectors', 'Back up Microsoft Search connectors'),
  read('OrgSettings-Forms.Read.All', 'other', 'Settings', 'Read Microsoft Forms settings', 'Back up tenant-wide Forms settings'),
  read('AuditLog.Read.All', 'reports', 'Settings', 'Read Entra audit and sign-in logs', 'Show who changed an Entra ID or Intune setting'),
  read('AuditLogsQuery.Read.All', 'reports', 'Settings', 'Search the Purview audit log', 'Show who changed Exchange, SharePoint and Teams settings (coming soon)', 'optional'),
  read('ServiceHealth.Read.All', 'reports', 'Settings', 'Read service health', 'Explain failures caused by a Microsoft outage'),
  read('Reports.Read.All', 'reports', 'Settings', 'Read usage reports', 'Show usage next to your settings'),
  read('ReportSettings.Read.All', 'reports', 'Settings', 'Read the report privacy setting', 'Back up whether usage reports show real names'),

  // ---- Restore writer (restorer): changes settings, only after someone approves.
  role('restorer', 'directory', 'Exchange Administrator', 'exchange', 'Exchange admin role', 'Restore Exchange and email protection settings'),
  role('restorer', 'directory', 'SharePoint Administrator', 'sharepoint', 'SharePoint admin role', 'Restore SharePoint tenant settings'),
  role('restorer', 'directory', 'Teams Administrator', 'teams', 'Teams admin role', 'Restore Teams policies'),
  role('restorer', 'directory', 'Compliance Administrator', 'purview', 'Compliance admin role', 'Restore retention, data loss prevention and label settings'),
  write('User.ReadWrite.All', 'entra', 'Users', 'Change users', 'Restore users and their licences'),
  write('Group.ReadWrite.All', 'entra', 'Groups', 'Change groups', 'Restore groups and their members'),
  write('GroupSettings.ReadWrite.All', 'entra', 'Groups', 'Change group settings', 'Restore tenant-wide group settings'),
  write('AdministrativeUnit.ReadWrite.All', 'entra', 'Groups', 'Change administrative units', 'Restore administrative units'),
  write('Directory.ReadWrite.All', 'entra', 'Groups', 'Change the directory', 'Restore group expiry policy, the only setting with no narrower permission'),
  write('RoleManagement.ReadWrite.Directory', 'entra', 'Roles', 'Change admin roles', 'Restore admin roles and who holds them'),
  write('RoleEligibilitySchedule.ReadWrite.Directory', 'entra', 'Roles', 'Change who can activate a role', 'Restore role eligibility'),
  write('RoleManagementPolicy.ReadWrite.Directory', 'entra', 'Roles', 'Change role activation rules', 'Restore role activation settings'),
  write('RoleManagement.ReadWrite.Exchange', 'entra', 'Roles', 'Change Exchange app role scopes', 'Restore Exchange role scopes'),
  write('Application.ReadWrite.All', 'entra', 'Apps', 'Change app registrations', 'Restore apps and enterprise apps'),
  write('DelegatedPermissionGrant.ReadWrite.All', 'entra', 'Apps', 'Change user consents to apps', 'Restore app consents'),
  write('Policy.ReadWrite.ConditionalAccess', 'entra', 'Policies', 'Change sign-in rules', 'Restore Conditional Access policies and named locations'),
  write('Policy.ReadWrite.AuthenticationMethod', 'entra', 'Policies', 'Change sign-in methods', 'Restore which sign-in methods are allowed'),
  write('Policy.ReadWrite.AuthenticationFlows', 'entra', 'Policies', 'Change sign-in flows', 'Restore sign-in flow settings'),
  write('Policy.ReadWrite.SecurityDefaults', 'entra', 'Policies', 'Change security defaults', 'Restore security defaults'),
  write('Policy.ReadWrite.Authorization', 'entra', 'Policies', 'Change what users may do', 'Restore user and guest permissions'),
  write('Policy.ReadWrite.CrossTenantAccess', 'entra', 'Policies', 'Change cross-tenant access', 'Restore access with other tenants'),
  write('Policy.ReadWrite.ExternalIdentities', 'entra', 'Policies', 'Change guest settings', 'Restore external collaboration settings'),
  write('Policy.ReadWrite.B2BManagementPolicy', 'entra', 'Policies', 'Change guest invite rules', 'Restore who may invite guests'),
  write('Policy.ReadWrite.PermissionGrant', 'entra', 'Policies', 'Change app consent rules', 'Restore what users may consent to'),
  write('Policy.ReadWrite.ConsentRequest', 'entra', 'Policies', 'Change admin consent requests', 'Restore the consent request workflow'),
  write('Policy.ReadWrite.ApplicationConfiguration', 'entra', 'Policies', 'Change app sign-in policies', 'Restore token and app management policies'),
  write('Policy.ReadWrite.AccessReview', 'entra', 'Policies', 'Change access review settings', 'Restore access review settings'),
  write('Domain.ReadWrite.All', 'entra', 'Settings', 'Change domains', 'Restore domain federation settings'),
  write('OrganizationalBranding.ReadWrite.All', 'entra', 'Settings', 'Change sign-in page branding', 'Restore company branding'),
  write('CustomSecAttributeDefinition.ReadWrite.All', 'entra', 'Settings', 'Change custom security attributes', 'Restore attribute definitions'),
  write('MultiTenantOrganization.ReadWrite.All', 'entra', 'Settings', 'Change multitenant organisation', 'Restore linked tenants'),
  write('EntitlementManagement.ReadWrite.All', 'governance', 'Policies', 'Change access packages', 'Restore catalogs and access package settings'),
  write('LifecycleWorkflows.ReadWrite.All', 'governance', 'Policies', 'Change joiner and leaver workflows', 'Restore lifecycle workflows'),
  write('DeviceManagementRBAC.ReadWrite.All', 'intune', 'Roles', 'Change Intune roles', 'Restore Intune scope tags'),
  write('DeviceManagementManagedDevices.ReadWrite.All', 'intune', 'Devices', 'Change managed devices', 'Restore device categories'),
  write('DeviceManagementApps.ReadWrite.All', 'intune', 'Apps', 'Change Intune apps', 'Restore app protection and app settings'),
  write('DeviceManagementConfiguration.ReadWrite.All', 'intune', 'Policies', 'Change Intune device settings', 'Restore device and compliance policies'),
  write('DeviceManagementScripts.ReadWrite.All', 'intune', 'Policies', 'Change Intune scripts', 'Restore device scripts'),
  write('DeviceManagementServiceConfig.ReadWrite.All', 'intune', 'Settings', 'Change Intune enrolment settings', 'Restore enrolment notifications'),
  write('MailboxSettings.ReadWrite', 'exchange', 'Settings', 'Change mailbox settings', 'Restore mailbox settings such as auto-replies'),
  entry('restorer', 'exchange', 'Exchange.ManageAsApp', 'exchange', 'Settings', 'Run Exchange admin commands', 'Restore Exchange and Purview settings'),
  write('Sites.FullControl.All', 'sharepoint', 'Settings', 'Full control of sites', 'Restore site settings and which apps can reach a site'),
  entry('restorer', 'sharepoint', 'Sites.FullControl.All', 'sharepoint', 'Settings', 'Full control of sites (SharePoint)', 'Restore site groups and sharing through SharePoint'),
  write('SharePointTenantSettings.ReadWrite.All', 'sharepoint', 'Settings', 'Change SharePoint settings', 'Restore tenant-wide sharing settings'),
  write('PeopleSettings.ReadWrite.All', 'entra', 'Users', 'Change profile card settings', 'Restore the pronouns setting'),
  write('ReportSettings.ReadWrite.All', 'reports', 'Settings', 'Change the report privacy setting', 'Restore whether usage reports hide real names'),
  write('OrgSettings-Forms.ReadWrite.All', 'other', 'Settings', 'Change Microsoft Forms settings', 'Restore tenant-wide Forms settings'),
  write('OrgSettings-Microsoft365Install.ReadWrite.All', 'other', 'Apps', 'Change Microsoft 365 Apps install options', 'Restore which Office apps people can install themselves'),
  write('OrgSettings-AppsAndServices.ReadWrite.All', 'other', 'Apps', 'Change Office Store and trial settings', 'Restore whether people can start app trials'),
  write('Community.ReadWrite.All', 'other', 'Groups', 'Change Viva Engage communities', 'Restore the name, description and privacy of Viva Engage communities'),
  write('TeamMember.ReadWrite.All', 'teams', 'Memberships', 'Change team members', 'Restore team owners and members'),
  write('TeamSettings.ReadWrite.All', 'teams', 'Settings', 'Change team settings', 'Restore each team\'s settings'),

  // ---- Content reader: reads mail, files and Teams content for content backups. Read-only.
  content('User.Read.All', 'entra', 'Users', 'Read every user', 'Find the mailboxes and OneDrives to back up'),
  content('Group.Read.All', 'entra', 'Groups', 'Read groups', 'Find group mailboxes, sites and teams to back up'),
  content('MailboxSettings.Read', 'exchange', 'Settings', 'Read mailbox settings', 'Tell user, shared and room mailboxes apart'),
  content('Mail.Read', 'exchange', 'Content', 'Read mail', 'Back up email'),
  content('Calendars.Read', 'exchange', 'Content', 'Read calendars', 'Back up calendar events'),
  content('Contacts.Read', 'exchange', 'Content', 'Read contacts', 'Back up mailbox contacts'),
  content('MailboxFolder.Read.All', 'exchange', 'Content', 'Read mailbox folders', 'Back up archive mailbox folders'),
  content('MailboxItem.Read.All', 'exchange', 'Content', 'Read mailbox items', 'Back up archive mailbox items'),
  content('Sites.Read.All', 'sharepoint', 'Settings', 'Read sites', 'Find sites, libraries and lists to back up'),
  content('Files.Read.All', 'sharepoint', 'Content', 'Read files', 'Back up files in OneDrive and SharePoint'),
  content('ChannelMember.Read.All', 'teams', 'Memberships', 'Read channel members', 'Back up who is in private and shared channels'),
  content('TeamsTab.Read.All', 'teams', 'Apps', 'Read channel tabs', 'Back up the tabs in each channel'),
  content('TeamsAppInstallation.ReadForTeam.All', 'teams', 'Apps', 'Read apps in each team', 'Back up which apps each team has'),
  content('Team.ReadBasic.All', 'teams', 'Settings', 'List teams', 'Find every team'),
  content('Channel.ReadBasic.All', 'teams', 'Settings', 'List channels', 'Find every channel'),
  content('ChannelSettings.Read.All', 'teams', 'Settings', 'Read channel settings', 'Back up each channel\'s settings'),
  content('ChannelMessage.Read.All', 'teams', 'Content', 'Read channel messages', 'Back up Teams channel messages (coming soon: Microsoft must approve this permission for Keel first)', 'optional'),
  content('Tasks.Read.All', 'planner', 'Content', 'Read tasks', 'Back up Planner plans and tasks'),
]);

export function permissionsFor(identity) {
  return KEEL_PERMISSIONS.filter((permission) => permission.identity === identity && permission.type !== 'admin-role');
}

/** The admin roles one app needs. */
export function rolesFor(identity) {
  return KEEL_PERMISSIONS.filter((permission) => permission.identity === identity && permission.type === 'admin-role');
}
