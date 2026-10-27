/**
 * Roadmap task-101: configuration-only workload descriptors and their qualification.
 *
 * KEEL's Entra collection runs on Graph descriptors (descriptors.mjs). This module
 * declares the NEXT workloads before any adapter reads them:
 *  - SharePoint site settings;
 *  - Teams settings and membership;
 *  - Exchange mailbox settings;
 *  - OneDrive site-level settings;
 *  - Purview label definitions and their publication;
 *  - Exchange organization-wide mail flow and protection settings (issue #153);
 *  - Teams organization-wide policies and configuration (issue #154);
 *  - Purview retention and DLP policies and their rules (issue #157);
 *  - the Exchange and Defender settings mail flow does not read (READ-EXO);
 *  - Teams calling, voice and live event policies and policy assignments, and Purview
 *    retention labels, adaptive scopes, auto-labeling and eDiscovery cases and holds
 *    (Wave 1 READ-TEAMS-PV).
 * Each entry records, per read operation:
 *  - the Graph endpoint or cmdlet;
 *  - its version;
 *  - app-only and delegated support;
 *  - the permissions and admin roles it needs;
 *  - paging, throttling and consistency;
 *  - the documentation it was declared from.
 *
 * Four rules:
 *
 * 1. Configuration only. validateWorkloadDescriptor() refuses any operation that would
 *    read file, message or list-item content, per-item labels or per-file permissions.
 *    It judges the endpoint itself, segment by segment, never the descriptor's name or
 *    workload, so a content path cannot pass by sitting under a site, team or user.
 * 2. Disabled until proven. A declared operation is `disabled`. A fixture harness run
 *    makes it `fixture-tested`, which is still disabled. Only a non-synthetic capture
 *    from this tenant, at the version in use now, makes it `live-qualified`, and only
 *    a live-qualified operation whose grants are confirmed is enabled.
 * 3. Missing RBAC is named. When the observed grants lack a permission or role the
 *    operation needs, or a capture failed in an authorization-shaped way, the row is
 *    `pending-prerequisite` and lists exactly what is missing.
 * 4. Proof is bound to a version. Evidence records the Graph API version or the module
 *    version it ran under. When the version in use changes, that evidence is listed as
 *    invalidated and stops counting.
 */
export const WORKLOAD_CONTRACT_VERSION = 1;
export const WORKLOADS = Object.freeze([
  'sharepoint-site-settings', 'teams-settings', 'exchange-mailbox-settings', 'onedrive-site-settings', 'purview-labels',
  'exchange-mail-flow', 'teams-org-policies', 'purview-retention-dlp',
  'exchange-extended',
  'exchange-role-groups',
  'exchange-distribution-groups', 'exchange-recipients',
  'teams-voice-policies', 'purview-governance',
  'power-platform-settings',
]);
export const WORKLOAD_STATES = Object.freeze(['refused', 'disabled', 'fixture-tested', 'pending-prerequisite', 'live-qualified']);
export const GRAPH_VERSIONS = Object.freeze(['v1.0', 'beta']);
export const PAGING = Object.freeze(['none', 'odata-nextLink', 'cmdlet-unbounded', 'next-link']);
export const LIVE_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Wave 1 CONT: the separate identity that backs up content (mail, files, list items,
// pages, Teams and Planner). Rule 1 still holds for every configuration workload; only
// a read made as this identity may address content, and it is still read-only.
export const CONTENT_READER_IDENTITY = 'content-reader';

const GRAPH = 'https://graph.microsoft.com';
const LEARN = 'https://learn.microsoft.com';

// Path segments that address content rather than configuration. A Graph endpoint
// containing any of them, anywhere and under any container, is refused.
const CONTENT_SEGMENTS = new Set([
  'drive', 'drives', 'items', 'children', 'content', 'versions', 'thumbnails',
  'list', 'lists', 'pages', 'onenote', 'notebooks',
  'messages', 'mailfolders', 'replies', 'hostedcontents', 'chats', 'events', 'calendar', 'calendars',
  'contacts', 'contactfolders', 'attachments', 'inferenceclassification',
  'extractsensitivitylabels', 'assignsensitivitylabel', 'sensitivitylabel', 'permissions', 'invite', 'createlink',
]);
// Cmdlets: read verbs only, and no noun that reads content. A noun naming a policy,
// rule or configuration about content (Get-SafeAttachmentPolicy) is configuration.
const CONTENT_NOUN = /(File|ListItem|FolderItem|Folder|Message(?!ing)|Attachment|ComplianceSearch|MailboxExport|SearchResult|Page)/;
const CONFIGURATION_NOUN = /(Policy|Rule|Configuration|Config|Settings)$/;
const AUTHZ_FAILURE = /\b(401|403)\b|forbidden|access (is )?denied|insufficient privileges|unauthori[sz]ed|not authorized|does not have permission/i;

// Tenant setup a read needs that is neither a permission nor a role (rbac.setup).
export const POWER_PLATFORM_SETUP = Object.freeze([
  'register the collector app as a Power Platform management app (New-PowerAppManagementApp)',
]);
export const FABRIC_READ_ONLY_ADMIN_SETUP = Object.freeze([
  'turn on the Fabric setting "Service principals can access read-only admin APIs" for a security group whose only member is the collector app',
  'keep every Power BI permission off the collector app',
]);
const doc = (path) => Object.freeze({ url: `${LEARN}${path}`, retrievedAt: null });
const graph = (endpoint, version = 'v1.0') => Object.freeze({ kind: 'graph', method: 'GET', endpoint, version });
const cmdlet = (name, module, { parameters = [], probeName = name } = {}) => Object.freeze({ kind: 'cmdlet', cmdlet: name, parameters, module, probeName });
// A read from a Microsoft admin REST API outside Graph (Power Platform, Fabric). Only the
// hosts in REST_HOSTS are in scope. `items` names the array the answer lists objects in.
const rest = (host, endpoint, version, { audience, items = 'value' }) => Object.freeze({ kind: 'rest', method: 'GET', host, endpoint, version, audience, items });
export const REST_HOSTS = Object.freeze(['api.bap.microsoft.com', 'api.powerapps.com', 'api.fabric.microsoft.com']);
// Path segments of those APIs that address apps, flows, user connections or Power BI
// content rather than tenant configuration.
const REST_CONTENT_SEGMENTS = new Set([
  'apps', 'flows', 'connections', 'workspaces', 'groups', 'datasets', 'reports', 'dashboards', 'dataflows', 'items',
  'content', 'export', 'runs', 'tables', 'rows',
]);

/**
 * The declared operations. Every fact here was declared from Microsoft's published
 * documentation (see docs/roadmap/workload-contract.md for which could not be
 * re-fetched); none of it enables a read on its own.
 */
export const WORKLOAD_DESCRIPTORS = Object.freeze([
  {
    id: 'sharepoint.tenant-settings', workload: 'sharepoint-site-settings', resource: 'SharePoint tenant sharing and site settings',
    operation: graph('/admin/sharepoint/settings'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['SharePointTenantSettings.Read.All'], roles: ['SharePoint Administrator'] },
    paging: 'none', throttle: 'graph-429-retry-after', consistency: 'eventual',
    source: doc('/en-us/graph/api/sharepointsettings-get?view=graph-rest-1.0'),
  },
  {
    id: 'sharepoint.site-discovery', workload: 'sharepoint-site-settings', resource: 'SharePoint site list',
    operation: graph('/sites/getAllSites'),
    auth: { application: true, delegated: false },
    rbac: { permissions: ['Sites.Read.All'], roles: [] },
    paging: 'odata-nextLink', throttle: 'graph-429-retry-after', consistency: 'eventual',
    source: doc('/en-us/graph/api/site-getallsites'),
  },
  {
    id: 'sharepoint.site-permissions', workload: 'sharepoint-site-settings', resource: 'SharePoint site-level app permission grants',
    operation: graph('/sites/{site-id}/permissions'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Sites.FullControl.All'], roles: [] },
    paging: 'odata-nextLink', throttle: 'graph-429-retry-after', consistency: 'eventual',
    source: doc('/en-us/graph/api/site-list-permissions'),
  },
  {
    id: 'sharepoint.site-properties', workload: 'sharepoint-site-settings', resource: 'SharePoint site properties',
    operation: graph('/sites/{site-id}'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Sites.Read.All'], roles: [] },
    paging: 'none', throttle: 'graph-429-retry-after', consistency: 'eventual',
    source: doc('/en-us/graph/api/site-get'),
  },
  {
    id: 'sharepoint.site-sharing', workload: 'sharepoint-site-settings', resource: 'SharePoint per-site sharing settings',
    operation: cmdlet('Get-PnPTenantSite', 'PnP.PowerShell'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Sites.FullControl.All'], roles: ['SharePoint Administrator'] },
    paging: 'cmdlet-unbounded', throttle: 'sharepoint-429-retry-after', consistency: 'eventual',
    source: Object.freeze({ url: 'https://pnp.github.io/powershell/cmdlets/Get-PnPTenantSite.html', retrievedAt: null }),
  },
  {
    id: 'teams.settings', workload: 'teams-settings', resource: 'Team member, guest, messaging and fun settings',
    operation: graph('/teams/{team-id}'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['TeamSettings.Read.All'], roles: [] },
    paging: 'none', throttle: 'graph-429-retry-after', consistency: 'eventual',
    source: doc('/en-us/graph/api/team-get'),
  },
  {
    id: 'teams.membership', workload: 'teams-settings', resource: 'Team members and their roles',
    operation: graph('/teams/{team-id}/members'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['TeamMember.Read.All'], roles: [] },
    paging: 'odata-nextLink', throttle: 'graph-429-retry-after', consistency: 'eventual',
    source: doc('/en-us/graph/api/team-list-members'),
  },
  // Task-104: discovery, and the Microsoft 365 group behind each team. Group
  // membership is a separate observation from Teams membership: the two can
  // diverge, and one being complete says nothing about the other.
  {
    id: 'teams.team-discovery', workload: 'teams-settings', resource: 'Team list',
    operation: graph('/teams'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Team.ReadBasic.All'], roles: [] },
    paging: 'odata-nextLink', throttle: 'graph-429-retry-after', consistency: 'eventual',
    source: doc('/en-us/graph/api/teams-list'),
  },
  {
    id: 'teams.group-membership', workload: 'teams-settings', resource: 'Members of the Microsoft 365 group behind a team',
    operation: graph('/groups/{group-id}/members'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['GroupMember.Read.All'], roles: [] },
    paging: 'odata-nextLink', throttle: 'graph-429-retry-after', consistency: 'eventual',
    source: doc('/en-us/graph/api/group-list-members'),
  },
  // Issue #154 moved `teams.meeting-policies` (declared here by task-101) into the
  // teams-org-policies workload below. Its id is unchanged, so a probe row for it maps
  // to the same read.
  {
    id: 'exchange.mailbox-settings', workload: 'exchange-mailbox-settings', resource: 'Mailbox settings (automatic replies, time zone, working hours)',
    operation: graph('/users/{user-id}/mailboxSettings'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['MailboxSettings.Read'], roles: [] },
    paging: 'none', throttle: 'graph-429-retry-after', consistency: 'eventual',
    source: doc('/en-us/graph/api/user-get-mailboxsettings'),
  },
  {
    id: 'exchange.client-access', workload: 'exchange-mailbox-settings', resource: 'Mailbox client access settings',
    operation: cmdlet('Get-CASMailbox', 'ExchangeOnlineManagement', { parameters: ['-ResultSize Unlimited'] }),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] },
    paging: 'cmdlet-unbounded', throttle: 'exchange-budget', consistency: 'eventual',
    source: doc('/en-us/powershell/module/exchange/get-casmailbox'),
  },
  // Task-105: the mailbox's hold and retention state, and the organization's
  // Exchange configuration. Both are configuration; neither reads a message.
  {
    id: 'exchange.mailbox-hold', workload: 'exchange-mailbox-settings', resource: 'Mailbox hold and retention settings',
    operation: cmdlet('Get-Mailbox', 'ExchangeOnlineManagement', { parameters: ['-Identity'] }),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] },
    paging: 'none', throttle: 'exchange-budget', consistency: 'eventual',
    source: doc('/en-us/powershell/module/exchange/get-mailbox'),
  },
  {
    id: 'exchange.organization-config', workload: 'exchange-mailbox-settings', resource: 'Exchange organization configuration',
    operation: cmdlet('Get-OrganizationConfig', 'ExchangeOnlineManagement'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] },
    paging: 'none', throttle: 'exchange-budget', consistency: 'eventual',
    source: doc('/en-us/powershell/module/exchange/get-organizationconfig'),
  },
  {
    id: 'onedrive.site-settings', workload: 'onedrive-site-settings', resource: 'OneDrive site sharing and storage settings',
    operation: cmdlet('Get-PnPTenantSite', 'PnP.PowerShell', { parameters: ['-IncludeOneDriveSites'], probeName: 'Get-PnPTenantSite -IncludeOneDriveSites' }),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Sites.FullControl.All'], roles: ['SharePoint Administrator'] },
    paging: 'cmdlet-unbounded', throttle: 'sharepoint-429-retry-after', consistency: 'eventual',
    source: Object.freeze({ url: 'https://pnp.github.io/powershell/cmdlets/Get-PnPTenantSite.html', retrievedAt: null }),
  },
  {
    id: 'purview.label-definitions', workload: 'purview-labels', resource: 'Sensitivity label definitions',
    operation: cmdlet('Get-Label', 'ExchangeOnlineManagement'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Exchange.ManageAsApp'], roles: ['Compliance Administrator'] },
    paging: 'none', throttle: 'exchange-budget', consistency: 'eventual',
    source: doc('/en-us/powershell/module/exchange/get-label'),
  },
  {
    id: 'purview.label-publication', workload: 'purview-labels', resource: 'Sensitivity label publishing policies',
    operation: cmdlet('Get-LabelPolicy', 'ExchangeOnlineManagement'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Exchange.ManageAsApp'], roles: ['Compliance Administrator'] },
    paging: 'none', throttle: 'exchange-budget', consistency: 'eventual',
    source: doc('/en-us/powershell/module/exchange/get-labelpolicy'),
  },
  // Issue #153: the organization's mail flow and protection settings. Each is a
  // whole-tenant list of configuration objects, read with no parameters. The last
  // two need Microsoft Defender for Office 365; engine/collect/workloads/mailFlow.mjs
  // treats them as optional so an unlicensed tenant still backs up the rest.
  ...[
    ['mailflow.accepted-domains', 'Accepted domains', 'Get-AcceptedDomain'],
    ['mailflow.remote-domains', 'Remote domains', 'Get-RemoteDomain'],
    ['mailflow.transport-rules', 'Mail flow (transport) rules', 'Get-TransportRule'],
    ['mailflow.inbound-connectors', 'Inbound connectors', 'Get-InboundConnector'],
    ['mailflow.outbound-connectors', 'Outbound connectors', 'Get-OutboundConnector'],
    ['mailflow.anti-spam-policies', 'Anti-spam (hosted content filter) policies', 'Get-HostedContentFilterPolicy'],
    ['mailflow.anti-phish-policies', 'Anti-phishing policies', 'Get-AntiPhishPolicy'],
    ['mailflow.anti-malware-policies', 'Anti-malware policies', 'Get-MalwareFilterPolicy'],
    ['mailflow.dkim-signing', 'DKIM signing configuration', 'Get-DkimSigningConfig'],
    ['mailflow.safe-links-policies', 'Safe Links policies', 'Get-SafeLinksPolicy'],
    ['mailflow.safe-attachment-policies', 'Safe Attachments policies', 'Get-SafeAttachmentPolicy'],
  ].map(([id, resource, name]) => ({
    id, workload: 'exchange-mail-flow', resource,
    operation: cmdlet(name, 'ExchangeOnlineManagement'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] },
    paging: 'cmdlet-unbounded', throttle: 'exchange-budget', consistency: 'eventual',
    source: doc(`/en-us/powershell/module/exchange/${name.toLowerCase()}`),
  })),
  // Issue #154: Teams organization-wide policies and tenant configuration, read with
  // no parameters in the MicrosoftTeams session. Policies are lists keyed by Identity
  // (`Global`, `Tag:<name>`); configurations are tenant singletons (`Global`).
  // engine/collect/workloads/teamsPolicies.mjs holds the fields and identities.
  ...[
    ['teams.meeting-policies', 'Teams meeting policies', 'Get-CsTeamsMeetingPolicy', 'cmdlet-unbounded'],
    ['teams.messaging-policies', 'Teams messaging policies', 'Get-CsTeamsMessagingPolicy', 'cmdlet-unbounded'],
    ['teams.app-setup-policies', 'Teams app setup policies', 'Get-CsTeamsAppSetupPolicy', 'cmdlet-unbounded'],
    ['teams.app-permission-policies', 'Teams app permission policies', 'Get-CsTeamsAppPermissionPolicy', 'cmdlet-unbounded'],
    ['teams.federation-configuration', 'Teams external access (federation) configuration', 'Get-CsTenantFederationConfiguration', 'none'],
    ['teams.client-configuration', 'Teams client and guest access configuration', 'Get-CsTeamsClientConfiguration', 'none'],
    ['teams.guest-meeting-configuration', 'Teams guest meeting configuration', 'Get-CsTeamsGuestMeetingConfiguration', 'none'],
    ['teams.guest-messaging-configuration', 'Teams guest messaging configuration', 'Get-CsTeamsGuestMessagingConfiguration', 'none'],
    ['teams.guest-calling-configuration', 'Teams guest calling configuration', 'Get-CsTeamsGuestCallingConfiguration', 'none'],
  ].map(([id, resource, name, paging]) => ({
    id, workload: 'teams-org-policies', resource,
    operation: cmdlet(name, 'MicrosoftTeams'),
    auth: { application: true, delegated: true },
    rbac: { permissions: [], roles: ['Teams Administrator'] },
    paging, throttle: 'module-managed', consistency: 'eventual',
    source: doc(`/en-us/powershell/module/teams/${name.toLowerCase()}`),
  })),
  // Issue #157: Purview retention and DLP policies and their rules, in the Security &
  // Compliance session, read with no parameters. The DLP reads need a licence that
  // includes Purview DLP; engine/collect/workloads/purviewRetentionDlp.mjs treats them
  // as optional so a tenant without it still backs up its retention policies.
  ...[
    ['purview.retention-policies', 'Retention policies', 'Get-RetentionCompliancePolicy'],
    ['purview.retention-rules', 'Retention rules', 'Get-RetentionComplianceRule'],
    ['purview.dlp-policies', 'Data loss prevention (DLP) policies', 'Get-DlpCompliancePolicy'],
    ['purview.dlp-rules', 'Data loss prevention (DLP) rules', 'Get-DlpComplianceRule'],
  ].map(([id, resource, name]) => ({
    id, workload: 'purview-retention-dlp', resource,
    operation: cmdlet(name, 'ExchangeOnlineManagement'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Exchange.ManageAsApp'], roles: ['Compliance Administrator'] },
    paging: 'cmdlet-unbounded', throttle: 'exchange-budget', consistency: 'eventual',
    source: doc(`/en-us/powershell/module/exchange/${name.toLowerCase()}`),
  })),
  // READ-EXO: the Exchange and Defender settings mail flow does not read, in the
  // Exchange Online session with no parameters (the global quarantine settings take a
  // fixed -QuarantinePolicyType). The last four need Microsoft Defender for Office 365;
  // engine/collect/workloads/exchangeExtended.mjs treats them as optional.
  ...[
    ['exchange-extended.outbound-spam-policies', 'Outbound spam policies', 'Get-HostedOutboundSpamFilterPolicy'],
    ['exchange-extended.outbound-spam-rules', 'Outbound spam rules', 'Get-HostedOutboundSpamFilterRule'],
    ['exchange-extended.connection-filter-policies', 'Connection filter policies', 'Get-HostedConnectionFilterPolicy'],
    ['exchange-extended.anti-spam-rules', 'Anti-spam rules (who each policy applies to)', 'Get-HostedContentFilterRule'],
    ['exchange-extended.anti-phish-rules', 'Anti-phishing rules (who each policy applies to)', 'Get-AntiPhishRule'],
    ['exchange-extended.anti-malware-rules', 'Anti-malware rules (who each policy applies to)', 'Get-MalwareFilterRule'],
    ['exchange-extended.eop-preset-rules', 'Standard and Strict preset policy rules', 'Get-EOPProtectionPolicyRule'],
    ['exchange-extended.quarantine-policies', 'Quarantine policies', 'Get-QuarantinePolicy'],
    ['exchange-extended.quarantine-global-settings', 'Quarantine notification settings', 'Get-QuarantinePolicy',
      { parameters: ['-QuarantinePolicyType'], probeName: 'Get-QuarantinePolicy -QuarantinePolicyType GlobalQuarantinePolicy' }],
    ['exchange-extended.journal-rules', 'Journal rules', 'Get-JournalRule'],
    ['exchange-extended.mobile-device-policies', 'Mobile device mailbox policies', 'Get-MobileDeviceMailboxPolicy'],
    ['exchange-extended.device-access-rules', 'Mobile device access rules', 'Get-ActiveSyncDeviceAccessRule'],
    ['exchange-extended.activesync-settings', 'Mobile device access settings', 'Get-ActiveSyncOrganizationSettings'],
    ['exchange-extended.address-lists', 'Address lists', 'Get-AddressList'],
    ['exchange-extended.global-address-lists', 'Global address lists', 'Get-GlobalAddressList'],
    ['exchange-extended.offline-address-books', 'Offline address books', 'Get-OfflineAddressBook'],
    ['exchange-extended.address-book-policies', 'Address book policies', 'Get-AddressBookPolicy'],
    ['exchange-extended.retention-policy-tags', 'Mailbox retention tags', 'Get-RetentionPolicyTag'],
    ['exchange-extended.retention-policies', 'Mailbox retention policies', 'Get-RetentionPolicy'],
    ['exchange-extended.safe-links-rules', 'Safe Links rules', 'Get-SafeLinksRule'],
    ['exchange-extended.safe-attachment-rules', 'Safe Attachments rules', 'Get-SafeAttachmentRule'],
    ['exchange-extended.defender-preset-rules', 'Defender preset policy rules', 'Get-ATPProtectionPolicyRule'],
    ['exchange-extended.defender-office-apps', 'Safe Attachments for SharePoint, OneDrive and Teams', 'Get-AtpPolicyForO365'],
  ].map(([id, resource, name, options]) => ({
    id, workload: 'exchange-extended', resource,
    operation: cmdlet(name, 'ExchangeOnlineManagement', options),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] },
    paging: 'cmdlet-unbounded', throttle: 'exchange-budget', consistency: 'eventual',
    source: doc(`/en-us/powershell/module/exchange/${name.toLowerCase()}`),
  })),
  // Exchange admin role groups, in the Exchange Online session with no parameters.
  // engine/collect/workloads/exchangeRoleGroups.mjs holds the fields and identity.
  {
    id: 'exchange-role-groups.role-groups', workload: 'exchange-role-groups', resource: 'Exchange admin role groups',
    operation: cmdlet('Get-RoleGroup', 'ExchangeOnlineManagement'),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] },
    paging: 'cmdlet-unbounded', throttle: 'exchange-budget', consistency: 'eventual',
    source: doc('/en-us/powershell/module/exchange/get-rolegroup'),
  },
  // Exchange recipients and mailbox permissions, in the Exchange Online session.
  // engine/collect/workloads/exchangeRecipients.mjs holds the fields and identities.
  ...[
    ['exchange-distribution-groups.distribution-groups', 'exchange-distribution-groups', 'Distribution lists and mail-enabled security groups',
      'Get-DistributionGroup', { parameters: ['-ResultSize Unlimited'] }],
    ['exchange-distribution-groups.dynamic-distribution-groups', 'exchange-distribution-groups', 'Dynamic distribution lists',
      'Get-DynamicDistributionGroup', { parameters: ['-ResultSize Unlimited'] }],
    ['exchange-distribution-groups.microsoft-365-groups', 'exchange-distribution-groups', 'Microsoft 365 group mail settings',
      'Get-UnifiedGroup', { parameters: ['-ResultSize Unlimited'] }],
    ['exchange-recipients.shared-mailboxes', 'exchange-recipients', 'Shared mailboxes', 'Get-Mailbox',
      { parameters: ['-RecipientTypeDetails SharedMailbox', '-ResultSize Unlimited'], probeName: 'Get-Mailbox -RecipientTypeDetails SharedMailbox' }],
    ['exchange-recipients.room-mailboxes', 'exchange-recipients', 'Room mailboxes', 'Get-Mailbox',
      { parameters: ['-RecipientTypeDetails RoomMailbox', '-ResultSize Unlimited'], probeName: 'Get-Mailbox -RecipientTypeDetails RoomMailbox' }],
    ['exchange-recipients.equipment-mailboxes', 'exchange-recipients', 'Equipment mailboxes', 'Get-Mailbox',
      { parameters: ['-RecipientTypeDetails EquipmentMailbox', '-ResultSize Unlimited'], probeName: 'Get-Mailbox -RecipientTypeDetails EquipmentMailbox' }],
    ['exchange-recipients.mail-contacts', 'exchange-recipients', 'Mail contacts', 'Get-MailContact', { parameters: ['-ResultSize Unlimited'] }],
    ['exchange-recipients.mailbox-permissions', 'exchange-recipients', 'Full Access and other rights on shared, room and equipment mailboxes',
      'Get-MailboxPermission', { parameters: ['-Identity'], probeName: 'Get-MailboxPermission -Identity' }],
    ['exchange-recipients.send-as', 'exchange-recipients', 'Send As rights', 'Get-RecipientPermission', { parameters: ['-ResultSize Unlimited'] }],
    ['exchange-recipients.calendar-processing', 'exchange-recipients', 'Room and equipment booking rules',
      'Get-CalendarProcessing', { parameters: ['-Identity'], probeName: 'Get-CalendarProcessing -Identity' }],
  ].map(([id, workload, resource, name, options]) => ({
    id, workload, resource,
    operation: cmdlet(name, 'ExchangeOnlineManagement', options),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] },
    paging: 'cmdlet-unbounded', throttle: 'exchange-budget', consistency: 'eventual',
    source: doc(`/en-us/powershell/module/exchange/${name.toLowerCase()}`),
  })),
  // Wave 1 READ-TEAMS-PV: Teams calling, voice and live event policies, and the
  // policies assigned to users and groups, in the MicrosoftTeams session.
  // engine/collect/workloads/teamsExtended.mjs holds the fields and identities.
  ...[
    ['teams.calling-policies', 'Teams calling policies', 'Get-CsTeamsCallingPolicy', 'cmdlet-unbounded'],
    ['teams.voice-routing-policies', 'Teams voice routing policies', 'Get-CsOnlineVoiceRoutingPolicy', 'cmdlet-unbounded'],
    ['teams.dial-plans', 'Teams dial plans', 'Get-CsTenantDialPlan', 'cmdlet-unbounded'],
    ['teams.emergency-calling-policies', 'Teams emergency calling policies', 'Get-CsTeamsEmergencyCallingPolicy', 'cmdlet-unbounded'],
    ['teams.emergency-call-routing-policies', 'Teams emergency call routing policies', 'Get-CsTeamsEmergencyCallRoutingPolicy', 'cmdlet-unbounded'],
    ['teams.call-park-policies', 'Teams call park policies', 'Get-CsTeamsCallParkPolicy', 'cmdlet-unbounded'],
    ['teams.caller-id-policies', 'Teams caller ID policies', 'Get-CsCallingLineIdentity', 'cmdlet-unbounded'],
    ['teams.voicemail-policies', 'Teams voicemail policies', 'Get-CsOnlineVoicemailPolicy', 'cmdlet-unbounded'],
    ['teams.live-events-policies', 'Teams live event policies', 'Get-CsTeamsMeetingBroadcastPolicy', 'cmdlet-unbounded'],
    ['teams.events-policies', 'Teams town hall and webinar policies', 'Get-CsTeamsEventsPolicy', 'cmdlet-unbounded'],
    ['teams.live-events-configuration', 'Teams live event configuration', 'Get-CsTeamsMeetingBroadcastConfiguration', 'none'],
    ['teams.user-policy-assignments', 'Teams policies assigned to each user', 'Get-CsOnlineUser', 'cmdlet-unbounded', { parameters: ['-ResultSize'] }],
    ['teams.group-policy-assignments', 'Teams policies assigned to groups', 'Get-CsGroupPolicyAssignment', 'cmdlet-unbounded'],
  ].map(([id, resource, name, paging, options]) => ({
    id, workload: 'teams-voice-policies', resource,
    operation: cmdlet(name, 'MicrosoftTeams', options),
    auth: { application: true, delegated: true },
    rbac: { permissions: [], roles: ['Teams Administrator'] },
    paging, throttle: 'module-managed', consistency: 'eventual',
    source: doc(`/en-us/powershell/module/teams/${name.toLowerCase()}`),
  })),
  // Wave 1 READ-TEAMS-PV: Purview retention labels, adaptive scopes, auto-labeling and
  // eDiscovery cases with their holds, in the Security & Compliance session.
  // engine/collect/workloads/purviewExtended.mjs holds the fields, parents and licences.
  // The eDiscovery reads declare Compliance Administrator: that role group carries the
  // Case Management and Hold roles these cmdlets need (checked live in Q106).
  ...[
    ['purview.retention-labels', 'Retention labels', 'Get-ComplianceTag', {}, ['Compliance Administrator']],
    ['purview.adaptive-scopes', 'Adaptive scopes', 'Get-AdaptiveScope', {}, ['Compliance Administrator']],
    ['purview.auto-label-policies', 'Auto-labeling policies', 'Get-AutoSensitivityLabelPolicy', {}, ['Compliance Administrator']],
    ['purview.auto-label-rules', 'Auto-labeling rules', 'Get-AutoSensitivityLabelRule', {}, ['Compliance Administrator']],
    ['purview.ediscovery-cases', 'eDiscovery (Standard) cases', 'Get-ComplianceCase', {}, ['Compliance Administrator']],
    ['purview.ediscovery-premium-cases', 'eDiscovery (Premium) cases', 'Get-ComplianceCase',
      { parameters: ['-CaseType AdvancedEdiscovery'], probeName: 'Get-ComplianceCase -CaseType AdvancedEdiscovery' }, ['Compliance Administrator']],
    ['purview.case-holds', 'eDiscovery case holds', 'Get-CaseHoldPolicy', { parameters: ['-Case'], probeName: 'Get-CaseHoldPolicy -Case' }, ['Compliance Administrator']],
    ['purview.case-hold-rules', 'eDiscovery case hold queries', 'Get-CaseHoldRule', { parameters: ['-Policy'], probeName: 'Get-CaseHoldRule -Policy' }, ['Compliance Administrator']],
  ].map(([id, resource, name, options, roles]) => ({
    id, workload: 'purview-governance', resource,
    operation: cmdlet(name, 'ExchangeOnlineManagement', options),
    auth: { application: true, delegated: true },
    rbac: { permissions: ['Exchange.ManageAsApp'], roles },
    paging: 'cmdlet-unbounded', throttle: 'exchange-budget', consistency: 'eventual',
    source: doc(`/en-us/powershell/module/exchange/${name.toLowerCase()}`),
  })),
  // READ-PP: Power Platform environments, DLP policies and connectors, and Power BI
  // (Fabric) tenant settings, from the admin REST APIs. Neither route needs an admin
  // role: app-only Power Platform reads need the app registered as a Power Platform
  // management app, and app-only Fabric reads go through the read-only admin APIs,
  // which need a Fabric tenant setting and an app holding no Power BI permission.
  // `rbac.setup` names those steps; they are not roles, so observed grants never
  // hold them and a capture is what proves them.
  // engine/collect/workloads/powerPlatform.mjs holds the fields and identities.
  ...[
    ['powerplatform.environments', 'Power Platform environments',
      rest('api.bap.microsoft.com', '/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01', '2020-10-01', { audience: 'https://service.powerapps.com/' }),
      'next-link', POWER_PLATFORM_SETUP, '/en-us/connectors/powerplatformforadmins/'],
    ['powerplatform.dlp-policies', 'Power Platform data loss prevention (DLP) policies',
      rest('api.bap.microsoft.com', '/providers/PowerPlatform.Governance/v2/policies', 'v2', { audience: 'https://service.powerapps.com/' }),
      'next-link', POWER_PLATFORM_SETUP, '/en-us/power-platform/admin/wp-data-loss-prevention'],
    ['powerplatform.connectors', 'Power Platform connectors in each environment',
      rest('api.powerapps.com', '/providers/Microsoft.PowerApps/scopes/admin/environments/{environment-name}/apis?api-version=2016-11-01', '2016-11-01', { audience: 'https://service.powerapps.com/' }),
      'next-link', POWER_PLATFORM_SETUP, '/en-us/connectors/powerappsforadmins/'],
    ['powerbi.tenant-settings', 'Power BI tenant settings',
      rest('api.fabric.microsoft.com', '/v1/admin/tenantsettings', 'v1', { audience: 'https://api.fabric.microsoft.com/', items: 'tenantSettings' }),
      'next-link', FABRIC_READ_ONLY_ADMIN_SETUP, '/en-us/rest/api/fabric/admin/tenants/list-tenant-settings'],
  ].map(([id, resource, operation, paging, setup, path]) => ({
    id, workload: 'power-platform-settings', resource, operation,
    auth: { application: true, delegated: true },
    rbac: { permissions: [], roles: [], setup },
    paging, throttle: 'rest-429-retry-after', consistency: 'eventual',
    source: doc(path),
  })),
].map((descriptor) => Object.freeze(descriptor)));

function graphSegments(endpoint) {
  const [path, query = ''] = String(endpoint).split('?');
  const segments = path.split('/').filter(Boolean).map((segment) => {
    // Graph also addresses by key and by function call: `items('x')`, `root:/a.docx:`.
    const bare = segment.replace(/\(.*$/, '').replace(/:.*$/, '');
    return decodeURIComponent(bare).toLowerCase();
  });
  const expanded = [...new URLSearchParams(query).entries()]
    .filter(([key]) => ['$expand', 'expand'].includes(key.toLowerCase()))
    .flatMap(([, value]) => value.split(',').map((part) => part.trim().replace(/\(.*$/, '').toLowerCase()));
  return { segments, expanded };
}

/**
 * Why an endpoint or cmdlet is outside configuration scope; empty when it is in scope.
 * `identity: 'content-reader'` lifts the content exclusion and nothing else: a read
 * verb is still required, and no configuration workload descriptor can claim it.
 */
export function scopeProblems(operation, { identity = null } = {}) {
  if (identity !== null && identity !== CONTENT_READER_IDENTITY) return [`unknown read identity ${identity}`];
  const contentReader = identity === CONTENT_READER_IDENTITY;
  const problems = [];
  if (operation?.kind === 'graph') {
    if (operation.method !== 'GET') problems.push(`${operation.method} is not a read`);
    if (typeof operation.endpoint !== 'string' || !operation.endpoint.startsWith('/')) {
      problems.push('a Graph endpoint must be a path starting with /');
      return problems;
    }
    const { segments, expanded } = graphSegments(operation.endpoint);
    // Task 102: `/sites/{site-id}/permissions` is the site's own grant list (which
    // apps hold Sites.Selected access), not a file's sharing. That exact shape is
    // configuration; `permissions` anywhere else (under a drive item) stays refused.
    const sitePermissions = segments.length === 3 && segments[0] === 'sites' && segments[2] === 'permissions';
    const content = [...segments, ...expanded]
      .filter((segment, index) => CONTENT_SEGMENTS.has(segment) && !(sitePermissions && index === 2));
    if (content.length && !contentReader) problems.push(`${operation.endpoint} reads content (${[...new Set(content)].join(', ')}), not configuration`);
  } else if (operation?.kind === 'rest') {
    if (operation.method !== 'GET') problems.push(`${operation.method} is not a read`);
    if (!REST_HOSTS.includes(operation.host)) problems.push(`${operation.host} is not an admin API KEEL reads`);
    if (typeof operation.endpoint !== 'string' || !operation.endpoint.startsWith('/')) {
      problems.push('a REST endpoint must be a path starting with /');
      return problems;
    }
    const content = operation.endpoint.split('?')[0].split('/').filter(Boolean)
      .map((segment) => decodeURIComponent(segment).toLowerCase()).filter((segment) => REST_CONTENT_SEGMENTS.has(segment));
    if (content.length) problems.push(`${operation.endpoint} reads content (${[...new Set(content)].join(', ')}), not configuration`);
  } else if (operation?.kind === 'cmdlet') {
    const [verb, noun = ''] = String(operation.cmdlet ?? '').split('-');
    if (verb !== 'Get') problems.push(`${operation.cmdlet} is not a read cmdlet`);
    if (CONTENT_NOUN.test(noun) && !CONFIGURATION_NOUN.test(noun) && !contentReader) problems.push(`${operation.cmdlet} reads content, not configuration`);
  } else {
    problems.push('operation must be a Graph endpoint, an admin REST endpoint or a cmdlet');
  }
  return problems;
}

/** Every problem with a descriptor; the scope validator plus the shape of the contract. */
export function descriptorProblems(descriptor) {
  const problems = [...scopeProblems(descriptor?.operation)];
  if (!WORKLOADS.includes(descriptor?.workload)) problems.push(`unknown workload ${descriptor?.workload}`);
  if (descriptor?.operation?.kind === 'graph' && !GRAPH_VERSIONS.includes(descriptor.operation.version)) {
    problems.push('a Graph operation must name its API version (v1.0 or beta)');
  }
  if (descriptor?.operation?.kind === 'cmdlet' && !descriptor.operation.module) problems.push('a cmdlet must name its module');
  if (descriptor?.operation?.kind === 'rest' && (!descriptor.operation.version || !descriptor.operation.audience)) {
    problems.push('a REST operation must name its API version and token audience');
  }
  if (typeof descriptor?.auth?.application !== 'boolean' || typeof descriptor?.auth?.delegated !== 'boolean') {
    problems.push('auth must say whether app-only and delegated access are supported');
  }
  if (!Array.isArray(descriptor?.rbac?.permissions) || !Array.isArray(descriptor?.rbac?.roles)) {
    problems.push('rbac must list permissions and roles (empty lists are fine)');
  }
  if (descriptor?.rbac?.setup !== undefined
    && (!Array.isArray(descriptor.rbac.setup) || !descriptor.rbac.setup.every((step) => typeof step === 'string' && step))) {
    problems.push('rbac.setup, when present, lists setup steps as text');
  }
  if (!PAGING.includes(descriptor?.paging)) problems.push(`paging must be one of ${PAGING.join(', ')}`);
  if (!descriptor?.source?.url) problems.push('a declared operation cites its documentation');
  return problems;
}

export class WorkloadScopeError extends Error {
  constructor(id, problems) {
    super(`${id}: ${problems.join('; ')}`);
    this.name = 'WorkloadScopeError';
    this.problems = problems;
  }
}

export function validateWorkloadDescriptor(descriptor) {
  const problems = descriptorProblems(descriptor);
  if (problems.length) throw new WorkloadScopeError(descriptor?.id ?? 'descriptor', problems);
  return descriptor;
}

/**
 * The version an operation runs under NOW: the Graph API version it calls, or the
 * module version the latest capture reported (`runtime.modules`). Null when unknown.
 */
export function currentVersion(descriptor, runtime = {}) {
  if (descriptor.operation.kind === 'graph' || descriptor.operation.kind === 'rest') return descriptor.operation.version;
  return runtime.modules?.[descriptor.operation.module] ?? null;
}

function evidenceProblems(descriptor, item, { tenantRef, version, now }) {
  const problems = [];
  if (item.synthetic !== false) problems.push('synthetic evidence (a fixture or probe harness) is never live qualification');
  if (item.kind !== 'live-capture') problems.push(`${item.kind ?? 'unlabelled'} evidence is not a live capture`);
  if (!tenantRef || item.tenantRef !== tenantRef) problems.push('captured in a different tenant, or no tenant was named');
  const at = Date.parse(item.capturedAt ?? '');
  if (Number.isNaN(at)) problems.push('no capture time');
  else if (at > now.getTime()) problems.push('captured in the future');
  else if (now.getTime() - at > LIVE_EVIDENCE_MAX_AGE_MS) problems.push('older than 30 days');
  if (!item.version) problems.push('the capture predates version recording');
  else if (version === null) problems.push('the version in use now is unknown');
  if (item.ok !== true) problems.push('the read failed');
  return problems;
}

function versionDrift(item, version) {
  return Boolean(item.version) && version !== null && item.version !== version;
}

function rbacState(descriptor, grants) {
  if (!grants) return { state: 'unchecked', missing: null };
  const permissions = new Set(grants.permissions ?? []);
  const roles = new Set(grants.roles ?? []);
  const missing = {
    permissions: descriptor.rbac.permissions.filter((name) => !permissions.has(name)),
    roles: descriptor.rbac.roles.filter((name) => !roles.has(name)),
  };
  return missing.permissions.length || missing.roles.length ? { state: 'missing', missing } : { state: 'satisfied', missing: null };
}

function prerequisiteSentence(descriptor, missing) {
  const parts = [];
  if (missing.permissions.length) parts.push(`grant ${missing.permissions.join(', ')} to the collector app`);
  if (missing.roles.length) parts.push(`assign it the ${missing.roles.join(', ')} role${missing.roles.length > 1 ? 's' : ''}`);
  if (missing.setup?.length) parts.push(...missing.setup);
  return `To read ${descriptor.resource.toLowerCase()}, ${parts.join(' and ')}.`;
}

/**
 * One row per descriptor. `evidence` is every fixture result and supplied capture;
 * `grants` is what the collector app is observed to hold ({ permissions, roles }),
 * when known; `runtime.modules` is the module versions in use now.
 */
export function workloadRow(descriptor, { evidence = [], grants = null, runtime = {}, tenantRef = null, now = new Date() } = {}) {
  const problems = descriptorProblems(descriptor);
  const version = descriptor.operation ? currentVersion(descriptor, runtime) : null;
  const base = {
    id: descriptor.id,
    workload: descriptor.workload,
    resource: descriptor.resource,
    operation: descriptor.operation,
    version,
    auth: descriptor.auth,
    rbac: descriptor.rbac,
    paging: descriptor.paging,
    throttle: descriptor.throttle,
    consistency: descriptor.consistency,
    documentation: descriptor.source ? { ...descriptor.source, reverified: Boolean(descriptor.source.retrievedAt) } : null,
  };
  if (problems.length) {
    return Object.freeze({ ...base, state: 'refused', enabled: false, reasons: problems, prerequisite: null, proof: { fixture: null, live: null }, invalidated: [] });
  }
  const mine = evidence.filter((item) => item.operationId === descriptor.id);
  const invalidated = [];
  const current = [];
  for (const item of mine) {
    if (versionDrift(item, version)) invalidated.push({ proofRef: item.proofRef, version: item.version, reason: `version changed to ${version}` });
    else current.push(item);
  }
  const fixture = current.find((item) => item.kind === 'fixture' && item.ok === true) ?? null;
  const reasons = [];
  let live = null;
  for (const item of current.filter((candidate) => candidate.kind !== 'fixture')) {
    const failures = evidenceProblems(descriptor, item, { tenantRef, version, now });
    if (failures.length === 0) { live = item; break; }
    reasons.push(`${item.proofRef ?? 'capture'}: ${failures.join('; ')}`);
  }
  const deniedCapture = current.find((item) => item.kind === 'live-capture' && item.synthetic === false && item.ok === false
    && AUTHZ_FAILURE.test(String(item.error ?? '')));
  const rbac = rbacState(descriptor, grants);

  let state;
  let prerequisite = null;
  if (rbac.state === 'missing') {
    state = 'pending-prerequisite';
    prerequisite = { ...rbac.missing, source: 'observed grants', message: prerequisiteSentence(descriptor, rbac.missing) };
  } else if (!live && deniedCapture) {
    // A refusal names what the operation needs; nothing else is guessed.
    state = 'pending-prerequisite';
    const missing = { permissions: descriptor.rbac.permissions, roles: descriptor.rbac.roles, setup: descriptor.rbac.setup ?? [] };
    prerequisite = { ...missing, source: 'authorization failure', message: prerequisiteSentence(descriptor, missing) };
  } else if (live) {
    state = 'live-qualified';
  } else if (fixture) {
    state = 'fixture-tested';
    reasons.push('fixture proof only: a live capture from this tenant is required');
  } else {
    state = 'disabled';
    reasons.push('no proof yet');
  }
  if (state === 'live-qualified' && rbac.state === 'unchecked') reasons.push('the collector app\'s grants have not been checked');
  return Object.freeze({
    ...base,
    state,
    enabled: state === 'live-qualified' && rbac.state === 'satisfied',
    reasons,
    prerequisite,
    proof: {
      fixture: fixture ? { proofRef: fixture.proofRef, version: fixture.version, observed: fixture.observed ?? null } : null,
      live: live ? { proofRef: live.proofRef, version: live.version, capturedAt: live.capturedAt, observed: live.observed ?? null } : null,
    },
    invalidated,
  });
}

export function buildWorkloadLedger({ descriptors = WORKLOAD_DESCRIPTORS, ...options } = {}) {
  const ids = new Set();
  for (const descriptor of descriptors) {
    if (ids.has(descriptor.id)) throw new Error(`duplicate workload operation id: ${descriptor.id}`);
    ids.add(descriptor.id);
  }
  return Object.freeze({
    contractVersion: WORKLOAD_CONTRACT_VERSION,
    tenantRef: options.tenantRef ?? null,
    rows: Object.freeze(descriptors.map((descriptor) => workloadRow(descriptor, options))),
  });
}

/**
 * Reads one Graph configuration operation through an injected transport, following
 * @odata.nextLink and honouring Retry-After. A nextLink that leaves the operation's
 * own path, or that would read content, is refused rather than followed.
 *   transport(url) -> { status, headers: { 'retry-after'? }, body }
 */
export async function readGraphConfiguration(descriptor, { transport, sleep = async () => {}, maxPages = 100, maxRetries = 3, substitute = {} }) {
  validateWorkloadDescriptor(descriptor);
  if (descriptor.operation.kind !== 'graph') throw new TypeError(`${descriptor.id} is not a Graph operation`);
  const path = descriptor.operation.endpoint.replace(/\{([^}]+)\}/g, (_, name) => {
    if (typeof substitute[name] !== 'string' || !substitute[name]) throw new TypeError(`${descriptor.id}: ${name} is required`);
    return encodeURIComponent(substitute[name]);
  });
  const base = `${GRAPH}/${descriptor.operation.version}`;
  const first = new URL(`${base}${path}`);
  const items = [];
  const observed = { pages: 0, throttled: 0, retryAfterHonouredMs: 0 };
  let next = first.href;
  while (next) {
    if (observed.pages >= maxPages) throw new Error(`${descriptor.id}: more than ${maxPages} pages`);
    let response;
    for (let attempt = 0; ; attempt += 1) {
      response = await transport(next);
      if (response.status !== 429 && response.status !== 503) break;
      observed.throttled += 1;
      if (attempt >= maxRetries) throw new Error(`${descriptor.id}: still throttled after ${maxRetries} retries`);
      const seconds = Number(response.headers?.['retry-after']);
      const waitMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempt * 1000;
      observed.retryAfterHonouredMs += waitMs;
      await sleep(waitMs);
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`${descriptor.id}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    observed.pages += 1;
    const body = response.body ?? {};
    if (Array.isArray(body.value)) items.push(...body.value);
    else items.push(body);
    const link = body['@odata.nextLink'];
    if (!link) break;
    const url = new URL(link);
    if (url.origin !== first.origin || decodeURIComponent(url.pathname) !== decodeURIComponent(first.pathname)) {
      throw new Error(`${descriptor.id}: refused a next page outside ${first.pathname}`);
    }
    const scope = scopeProblems({ kind: 'graph', method: 'GET', endpoint: `${url.pathname.replace(`/${descriptor.operation.version}`, '')}${url.search}` });
    if (scope.length) throw new Error(`${descriptor.id}: refused a next page: ${scope.join('; ')}`);
    next = url.href;
  }
  return { items, observed };
}

const REST_NEXT_LINKS = Object.freeze(['nextLink', '@odata.nextLink', 'continuationUri']);

/**
 * Reads one admin REST configuration operation (Power Platform, Fabric) through an
 * injected transport, following its next link and honouring Retry-After, like
 * readGraphConfiguration. A next link that leaves the operation's host and path, or
 * that would read content, is refused rather than followed.
 *   transport(url) -> { status, headers: { 'retry-after'? }, body }
 */
export async function readRestConfiguration(descriptor, { transport, sleep = async () => {}, maxPages = 100, maxRetries = 3, substitute = {} }) {
  validateWorkloadDescriptor(descriptor);
  const { operation } = descriptor;
  if (operation.kind !== 'rest') throw new TypeError(`${descriptor.id} is not an admin REST operation`);
  const path = operation.endpoint.replace(/\{([^}]+)\}/g, (_, name) => {
    if (typeof substitute[name] !== 'string' || !substitute[name]) throw new TypeError(`${descriptor.id}: ${name} is required`);
    return encodeURIComponent(substitute[name]);
  });
  const first = new URL(`https://${operation.host}${path}`);
  const items = [];
  const observed = { pages: 0, throttled: 0, retryAfterHonouredMs: 0 };
  let next = first.href;
  while (next) {
    if (observed.pages >= maxPages) throw new Error(`${descriptor.id}: more than ${maxPages} pages`);
    let response;
    for (let attempt = 0; ; attempt += 1) {
      response = await transport(next);
      if (response.status !== 429 && response.status !== 503) break;
      observed.throttled += 1;
      if (attempt >= maxRetries) throw new Error(`${descriptor.id}: still throttled after ${maxRetries} retries`);
      const seconds = Number(response.headers?.['retry-after']);
      const waitMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempt * 1000;
      observed.retryAfterHonouredMs += waitMs;
      await sleep(waitMs);
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`${descriptor.id}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    observed.pages += 1;
    const body = response.body ?? {};
    const list = body[operation.items];
    if (!Array.isArray(list)) throw new Error(`${descriptor.id}: the answer has no ${operation.items} list`);
    items.push(...list);
    const link = REST_NEXT_LINKS.map((key) => body[key]).find((value) => typeof value === 'string' && value);
    if (!link) break;
    const url = new URL(link, first);
    if (url.origin !== first.origin || decodeURIComponent(url.pathname) !== decodeURIComponent(first.pathname)) {
      throw new Error(`${descriptor.id}: refused a next page outside ${first.pathname}`);
    }
    next = url.href;
  }
  return { items, observed };
}

/**
 * Evidence from rows that ops/powershell/probe-workloads.ps1 printed, supplied
 * explicitly by an operator. Rows from before version recording carry no
 * moduleVersion or synthetic flag and therefore never qualify.
 */
export function evidenceFromProbeRows(rows, { tenantRef, proofRef, descriptors = WORKLOAD_DESCRIPTORS }) {
  const evidence = [];
  const modules = {};
  for (const row of rows) {
    // Every row reports the module version in use, whether or not it maps to a declared operation.
    if (row?.moduleVersion && row?.module) modules[row.module] = row.moduleVersion;
    if (!row?.cmdlet) continue;
    const descriptor = descriptors.find((candidate) => candidate.operation.kind === 'cmdlet' && candidate.operation.probeName === row.cmdlet);
    if (!descriptor) continue;
    evidence.push({
      operationId: descriptor.id,
      kind: 'live-capture',
      synthetic: row.synthetic === false ? false : true,
      tenantRef,
      capturedAt: row.capturedAt ?? null,
      version: row.moduleVersion ?? null,
      ok: row.ok === true,
      error: row.error ?? null,
      observed: { count: row.count ?? null },
      proofRef,
    });
  }
  return { evidence, runtime: { modules } };
}
