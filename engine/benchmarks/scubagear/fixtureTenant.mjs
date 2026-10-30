/**
 * A made-up tenant's backups, in the shape Keel stores them (Graph v1.0 objects, and
 * Exchange cmdlet fields for the mail flow read), used to run ScubaGear's rules end to
 * end in tests and to record OPA's own answers for them (build/golden.json).
 *
 * Every name uses the KEEL-RT- prefix. Nothing here is a real tenant's data.
 */
import { maskedFacts } from '../registry.mjs';
import { ADAPTERS, buildInput } from './adapters.mjs';
import { importScubaGearRules } from './import.mjs';
const GA = '62e90394-69f5-4237-9190-012177145e10';
const PRA = 'e8611ab8-c189-46e8-94e1-60213ab1f814';
const USER_ADMIN = 'fe930be7-5e62-47db-91af-98c3a49a38b1';
const ROLES = Object.freeze([
  [GA, 'Global Administrator'], [PRA, 'Privileged Role Administrator'], [USER_ADMIN, 'User Administrator'],
  ['f28a1f50-f6e7-4571-818b-6a12f2af6b6c', 'SharePoint Administrator'], ['29232cdf-9323-42fd-ade2-1d097af3e4de', 'Exchange Administrator'],
  ['8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2', 'Hybrid Identity Administrator'], ['9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3', 'Application Administrator'],
  ['158c047a-c907-4556-b7ef-446551a6b5f7', 'Cloud Application Administrator'], ['729827e3-9c14-49f7-bb1b-9608f156bbb8', 'Helpdesk Administrator'],
]);
const ADA = '00000000-0000-4000-8000-0000000000a1';
const BEN = '00000000-0000-4000-8000-0000000000b2';
const CAL = '00000000-0000-4000-8000-0000000000c3';

const TENANT_ID = '00000000-0000-4000-8000-00000000ffff';
const ENVIRONMENT = '00000000-0000-4000-8000-0000000000e1';
// A stored service-read object: Keel's own key fields, then the cmdlet's fields.
const mail = (kind, suffix, fields) => {
  const identity = `00000000-0000-4000-8000-000000000${suffix.padStart(3, '0')}`;
  return { kind, identity, id: `${kind}:${identity}`, ...fields };
};
const teams = (kind, Identity, fields) => ({ kind, identity: Identity.toLowerCase(), id: `${kind}:${Identity.toLowerCase()}`, Identity, ...fields });
const platform = (kind, identity, fields) => ({ kind, identity, id: `${kind}:${identity}`, ...fields });

const everyone = {
  includeUsers: ['All'], excludeUsers: [], includeGroups: [], excludeGroups: [], includeRoles: [], excludeRoles: [],
  includeGuestsOrExternalUsers: null, excludeGuestsOrExternalUsers: null,
};
const allApps = { includeApplications: ['All'], excludeApplications: [], includeUserActions: [], includeAuthenticationContextClassReferences: [] };
const signInRule = (id, displayName, conditions, grantControls, state = 'enabled') => ({
  id, displayName, state, createdDateTime: '2026-01-05T09:00:00Z', modifiedDateTime: '2026-09-01T09:00:00Z',
  conditions: {
    users: everyone, applications: allApps, clientAppTypes: ['all'], userRiskLevels: [], signInRiskLevels: [],
    platforms: null, locations: null, devices: null, authenticationFlows: null, ...conditions,
  },
  grantControls: { operator: 'OR', builtInControls: [], customAuthenticationFactors: [], termsOfUse: [], authenticationStrength: null, ...grantControls },
  sessionControls: null,
});

const pimRule = (type, id, extra) => ({ '@odata.type': `#microsoft.graph.unifiedRoleManagementPolicy${type}Rule`, id, target: { caller: 'Admin', operations: ['all'], level: 'Assignment', inheritableSettings: [], enforcedSettings: [] }, ...extra });
const notification = (id, recipients) => pimRule('Notification', id, {
  notificationType: 'Email', recipientType: 'Admin', notificationLevel: 'All', isDefaultRecipientsEnabled: true, notificationRecipients: recipients,
});
const pimRules = (approval) => [
  pimRule('Approval', 'Approval_EndUser_Assignment', { setting: { isApprovalRequired: approval, isApprovalRequiredForExtension: false, isRequestorJustificationRequired: true, approvalMode: 'SingleStage', approvalStages: [] } }),
  notification('Notification_Admin_Admin_Assignment', approval ? ['KEEL-RT-alerts@contoso.example'] : []),
  notification('Notification_Admin_Admin_Eligibility', approval ? ['KEEL-RT-alerts@contoso.example'] : []),
  notification('Notification_Admin_EndUser_Assignment', approval ? ['KEEL-RT-alerts@contoso.example'] : []),
];

export const FIXTURE_BACKUPS = Object.freeze({
  conditionalAccessPolicy: [
    signInRule('ca-legacy', 'KEEL-RT-Block legacy sign-in', { clientAppTypes: ['exchangeActiveSync', 'other'] }, { builtInControls: ['block'] }),
    signInRule('ca-mfa', 'KEEL-RT-MFA for everyone', {}, { builtInControls: ['mfa'] }),
    signInRule('ca-risk', 'KEEL-RT-Block risky users', { userRiskLevels: ['high'] }, { builtInControls: ['block'] }),
    signInRule('ca-device-code', 'KEEL-RT-Block device code', { authenticationFlows: { transferMethods: 'deviceCodeFlow' } }, { builtInControls: ['block'] }, 'disabled'),
  ],
  authorizationPolicy: [{
    id: 'authorizationPolicy', displayName: 'Authorization Policy', allowInvitesFrom: 'everyone', allowedToSignUpEmailBasedSubscriptions: true,
    allowedToUseSSPR: true, allowEmailVerifiedUsersToJoinOrganization: false, blockMsolPowerShell: true,
    guestUserRoleId: '2af84b1e-32c8-42b7-82bc-daa82404023b',
    permissionGrantPolicyIdsAssignedToDefaultUserRole: ['ManagePermissionGrantsForOwnedResource.microsoft-dynamically-managed-permissions-for-team'],
    defaultUserRolePermissions: { allowedToCreateApps: false, allowedToCreateSecurityGroups: false, allowedToCreateTenants: false, allowedToReadOtherUsers: true },
  }],
  authenticationMethodsPolicy: [{
    id: 'authenticationMethodsPolicy', displayName: 'Authentication Methods Policy', policyMigrationState: 'migrationComplete', policyVersion: '1.5',
    authenticationMethodConfigurations: [
      { '@odata.type': '#microsoft.graph.smsAuthenticationMethodConfiguration', id: 'Sms', state: 'disabled' },
      { '@odata.type': '#microsoft.graph.voiceAuthenticationMethodConfiguration', id: 'Voice', state: 'disabled' },
      { '@odata.type': '#microsoft.graph.emailAuthenticationMethodConfiguration', id: 'Email', state: 'enabled' },
      {
        '@odata.type': '#microsoft.graph.microsoftAuthenticatorAuthenticationMethodConfiguration', id: 'MicrosoftAuthenticator', state: 'enabled', isSoftwareOathEnabled: false,
        featureSettings: {
          displayAppInformationRequiredState: { state: 'enabled', includeTarget: { targetType: 'group', id: 'all_users' } },
          displayLocationInformationRequiredState: { state: 'enabled', includeTarget: { targetType: 'group', id: 'all_users' } },
        },
      },
    ],
  }],
  groupSetting: [{
    id: 'setting-consent', displayName: 'Consent Policy Settings', templateId: 'dffd5d46-495d-40a9-8e21-954ff55e198a',
    values: [{ name: 'EnableGroupSpecificConsent', value: 'false' }, { name: 'EnableAdminConsentRequests', value: 'true' }],
  }],
  domain: [{ id: 'KEEL-RT-contoso.example', authenticationType: 'Managed', isDefault: true, isInitial: false, isRoot: true, isVerified: true, passwordValidityPeriodInDays: 2147483647, passwordNotificationWindowInDays: 14, supportedServices: ['Email'] }],
  subscribedSku: [{
    id: 'sku-e5', skuId: '06ebc4ee-1bb5-47dd-8120-11324bc54e06', skuPartNumber: 'SPE_E5', appliesTo: 'User', capabilityStatus: 'Enabled', consumedUnits: 3,
    prepaidUnits: { enabled: 25, suspended: 0, warning: 0, lockedOut: 0 },
    servicePlans: [
      { servicePlanId: 'eec0eb4f-6444-4f95-aba0-50c24d67f998', servicePlanName: 'AAD_PREMIUM_P2', provisioningStatus: 'Success', appliesTo: 'User' },
      { servicePlanId: '41781fb2-bc02-4b7c-bd55-b576c07bb09d', servicePlanName: 'AAD_PREMIUM', provisioningStatus: 'Success', appliesTo: 'User' },
      { servicePlanId: '9f431833-0334-42de-a7dc-70aa40db46db', servicePlanName: 'LOCKBOX_ENTERPRISE', provisioningStatus: 'Disabled', appliesTo: 'User' },
    ],
  }],
  tenantAppManagementPolicy: [{
    id: '00000000-0000-0000-0000-000000000000', displayName: 'Default app management tenant policy', isEnabled: true,
    applicationRestrictions: {
      passwordCredentials: [
        { restrictionType: 'passwordAddition', state: 'enabled', maxLifetime: null, restrictForAppsCreatedAfterDateTime: '0001-01-01T00:00:00Z' },
      ],
      keyCredentials: [
        { restrictionType: 'asymmetricKeyLifetime', state: 'enabled', maxLifetime: 'P400D', restrictForAppsCreatedAfterDateTime: '2026-01-01T00:00:00Z' },
      ],
    },
    servicePrincipalRestrictions: {
      passwordCredentials: [{ restrictionType: 'passwordAddition', state: 'enabled', maxLifetime: null, restrictForAppsCreatedAfterDateTime: '0001-01-01T00:00:00Z' }],
      keyCredentials: [],
    },
  }],
  appManagementPolicy: [],
  roleDefinition: ROLES.map(([id, displayName]) => ({ id, templateId: id, displayName, isBuiltIn: true, isEnabled: true })),
  roleAssignment: [
    { id: 'ra-ada-ga', principalId: ADA, roleDefinitionId: GA, directoryScopeId: '/' },
    { id: 'ra-ben-ga', principalId: BEN, roleDefinitionId: GA, directoryScopeId: '/' },
    { id: 'ra-cal-ua', principalId: CAL, roleDefinitionId: USER_ADMIN, directoryScopeId: '/' },
  ],
  roleAssignmentSchedule: [
    {
      id: 'sched-ben-ga', principalId: BEN, roleDefinitionId: GA, directoryScopeId: '/', assignmentType: 'Activated', memberType: 'Direct', status: 'Provisioned',
      scheduleInfo: { startDateTime: '2026-10-30T08:00:00Z', expiration: { type: 'afterDateTime', endDateTime: '2026-10-30T16:00:00Z' } },
    },
  ],
  roleEligibilitySchedule: [
    {
      id: 'elig-cal-pra', principalId: CAL, roleDefinitionId: PRA, directoryScopeId: '/', memberType: 'Direct', status: 'Provisioned',
      scheduleInfo: { startDateTime: '2026-06-01T00:00:00Z', expiration: { type: 'noExpiration' } },
    },
  ],
  unifiedRoleManagementPolicy: ROLES.map(([id], index) => ({
    id: `DirectoryRole_tenant_${id}`, scopeId: '/', scopeType: 'DirectoryRole', displayName: 'Directory Role', isOrganizationDefault: false,
    // Global Administrator needs approval and alerts; the others are left as Microsoft ships them.
    rules: pimRules(index === 0),
  })),
  unifiedRoleManagementPolicyAssignment: ROLES.map(([id]) => ({ id: `assign_${id}`, policyId: `DirectoryRole_tenant_${id}`, roleDefinitionId: id, scopeId: '/', scopeType: 'DirectoryRole' })),
  user: [
    { id: ADA, displayName: 'KEEL-RT-Ada', userPrincipalName: 'KEEL-RT-ada@contoso.example', onPremisesSyncEnabled: null, onPremisesImmutableId: null },
    { id: BEN, displayName: 'KEEL-RT-Ben', userPrincipalName: 'KEEL-RT-ben@contoso.example', onPremisesSyncEnabled: true, onPremisesImmutableId: 'S0VFTC1SVC1iZW4=' },
    { id: CAL, displayName: 'KEEL-RT-Cal', userPrincipalName: 'KEEL-RT-cal@contoso.example', onPremisesSyncEnabled: null, onPremisesImmutableId: null },
  ],
  group: [],
  servicePrincipal: [],
  'exchange-mail-flow': [
    { kind: 'remoteDomain', identity: 'Default', id: 'remote-domain:Default', Name: 'Default', DomainName: '*', AutoForwardEnabled: false, AutoReplyEnabled: true, IsInternal: false },
    { kind: 'acceptedDomain', identity: 'KEEL-RT-contoso.example', id: 'accepted-domain:KEEL-RT-contoso.example', Name: 'KEEL-RT-contoso.example', DomainName: 'KEEL-RT-contoso.example', DomainType: 'Authoritative', Default: true },
    {
      kind: 'transportRule', identity: 'b6a7c1e2-0000-4000-8000-00000000e001', id: 'transport-rule:b6a7c1e2-0000-4000-8000-00000000e001',
      Name: 'KEEL-RT-External sender warning', State: 'Enabled', Mode: 'Enforce', Priority: 0, FromScope: 'NotInOrganization', PrependSubject: '[EXTERNAL] ',
    },
    { kind: 'dkimSigning', identity: 'KEEL-RT-contoso.example', id: 'dkim:KEEL-RT-contoso.example', Domain: 'KEEL-RT-contoso.example', Enabled: true, Status: 'Valid' },
    mail('antiMalwarePolicy', 'a1', {
      Name: 'Default', IsDefault: true, EnableFileFilter: true, FileTypes: ['ace', 'cmd', 'exe', 'vbe'], FileTypeAction: 'Reject', ZapEnabled: false,
    }),
    mail('antiPhishPolicy', 'a2', {
      Name: 'Office365 AntiPhish Default', IsDefault: true, Enabled: true,
      EnableTargetedUserProtection: false, TargetedUsersToProtect: [], TargetedUserProtectionAction: 'NoAction',
      EnableOrganizationDomainsProtection: true, EnableTargetedDomainsProtection: false, TargetedDomainsToProtect: [], TargetedDomainProtectionAction: 'Quarantine',
      EnableFirstContactSafetyTips: true, EnableSimilarUsersSafetyTips: true, EnableSimilarDomainsSafetyTips: true, EnableUnusualCharactersSafetyTips: true,
      EnableViaTag: true, EnableUnauthenticatedSender: false,
    }),
    mail('antiSpamPolicy', 'a3', { Name: 'Default', IsDefault: true, SpamAction: 'MoveToJmf', HighConfidenceSpamAction: 'Quarantine', PhishSpamAction: 'Quarantine', HighConfidencePhishAction: 'Quarantine', AllowedSenderDomains: [] }),
    mail('safeLinksPolicy', 'a4', {
      Name: 'KEEL-RT-Safe links', IsBuiltInProtection: false, EnableSafeLinksForEmail: true, EnableSafeLinksForTeams: true, EnableSafeLinksForOffice: true,
      EnableForInternalSenders: true, ScanUrls: true, DeliverMessageAfterScan: true, TrackClicks: false, AllowClickThrough: false,
    }),
    mail('safeAttachmentPolicy', 'a5', { Name: 'KEEL-RT-Safe attachments', IsBuiltInProtection: false, Enable: true, Action: 'Block' }),
  ],
  'exchange-extended': [
    mail('safeLinksRule', 'b1', {
      Name: 'KEEL-RT-Safe links', SafeLinksPolicy: 'KEEL-RT-Safe links', State: 'Enabled', Priority: 0,
      SentTo: null, SentToMemberOf: null, RecipientDomainIs: null, ExceptIfSentTo: null, ExceptIfSentToMemberOf: null, ExceptIfRecipientDomainIs: null,
    }),
    mail('defenderForOffice', 'b2', { Name: 'Default', EnableATPForSPOTeamsODB: true, EnableSafeDocs: false, AllowSafeDocsOpen: false }),
    mail('connectionFilterPolicy', 'b3', { Name: 'Default', IsDefault: true, IPAllowList: ['192.0.2.10'], IPBlockList: [], EnableSafeList: false }),
  ],
  'purview-retention-dlp': [
    ...['Suspicious email sending patterns detected', 'Suspicious connector activity', 'Suspicious Email Forwarding Activity', 'Messages have been delayed',
      'Tenant restricted from sending unprovisioned email'].map((Name, index) => mail('alertPolicy', `c${index}`, { Name, IsSystemRule: true, Disabled: false })),
    mail('alertPolicy', 'c9', { Name: 'Tenant restricted from sending email', IsSystemRule: true, Disabled: true }),
  ],
  'teams-org-policies': [
    teams('meetingPolicy', 'Global', {
      AllowExternalParticipantGiveRequestControl: false, AllowAnonymousUsersToStartMeeting: false, AutoAdmittedUsers: 'EveryoneInCompanyExcludingGuests',
      AllowPSTNUsersToBypassLobby: false, AllowCloudRecording: true,
    }),
    teams('meetingPolicy', 'Tag:KEEL-RT-Open meetings', {
      AllowExternalParticipantGiveRequestControl: true, AllowAnonymousUsersToStartMeeting: false, AutoAdmittedUsers: 'Everyone',
      AllowPSTNUsersToBypassLobby: true, AllowCloudRecording: true,
    }),
    teams('federationConfiguration', 'Global', {
      AllowFederatedUsers: true, AllowedDomains: { AllowedDomain: [{ Domain: 'KEEL-RT-partner.example' }] }, BlockedDomains: [],
      AllowTeamsConsumer: true, AllowTeamsConsumerInbound: false,
    }),
    teams('clientConfiguration', 'Global', { AllowGuestUser: true, AllowEmailIntoChannel: true }),
    teams('appPermissionPolicy', 'Global', { DefaultCatalogAppsType: 'BlockedAppList', GlobalCatalogAppsType: 'BlockedAppList', PrivateCatalogAppsType: 'BlockedAppList' }),
  ],
  'teams-voice-policies': [
    teams('liveEventsPolicy', 'Global', { AllowBroadcastScheduling: true, BroadcastRecordingMode: 'AlwaysEnabled' }),
  ],
  'sharepoint-site-settings': [
    {
      id: 'tenant', sharingCapability: 'existingExternalUserSharingOnly', sharingDomainRestrictionMode: 'none',
      sharingAllowedDomainList: [], sharingBlockedDomainList: [], isResharingByExternalUsersEnabled: false,
    },
  ],
  'power-platform-settings': [
    platform('environment', `Default-${TENANT_ID}`, { displayName: 'KEEL-RT-Default', isDefault: true }),
    platform('environment', ENVIRONMENT, { displayName: 'KEEL-RT-Sales', isDefault: false }),
    platform('dlpPolicy', '00000000-0000-4000-8000-0000000000d1', {
      displayName: 'KEEL-RT-Default only', environmentType: 'OnlyEnvironments',
      environments: [{ id: `/providers/admin/environment/Default-${TENANT_ID}`, name: `Default-${TENANT_ID}`, type: 'Microsoft.BusinessAppPlatform/scopes/environments' }],
    }),
    ...[['PublishToWeb', false], ['AllowGuestUserToAccessSharedContent', true], ['ExternalSharingV2', false], ['ServicePrincipalAccessPermissionAPIs', true],
      ['AllowServicePrincipalsCreateAndUseProfiles', false], ['BlockResourceKeyAuthentication', true], ['RScriptVisual', true], ['EimInformationProtectionEdit', true]]
      .map(([settingName, enabled]) => platform('powerBiSetting', settingName, { title: `KEEL-RT-${settingName}`, enabled, enabledSecurityGroups: [] })),
  ],
  organization: [{ id: TENANT_ID, displayName: 'KEEL-RT-Contoso' }],
});

// What each rule should give on this tenant, worked out by hand from the rules' text.
export const FIXTURE_EXPECTED = Object.freeze({
  'MS.AAD.1.1v1': 'pass', // a rule blocks both legacy client types for everyone
  'MS.AAD.2.1v1': 'pass', // high-risk users are blocked, and the tenant has P2
  'MS.AAD.2.3v1': 'fail', // no rule blocks high-risk sign-ins
  'MS.AAD.3.1v1': 'fail', // MFA is required, but not phishing-resistant MFA
  'MS.AAD.3.2v2': 'pass',
  'MS.AAD.3.3v2': 'pass', // Authenticator shows the app and location on every prompt
  'MS.AAD.3.4v1': 'pass', // migration complete
  'MS.AAD.3.5v2': 'fail', // email one-time passcodes are still on
  'MS.AAD.3.6v1': 'fail', // admins get plain MFA, not phishing-resistant MFA
  'MS.AAD.3.7v1': 'fail', // no rule requires a managed device
  'MS.AAD.3.8v1': 'fail', // no rule requires a managed device to register MFA
  'MS.AAD.3.9v1': 'fail', // the device code block is off
  'MS.AAD.5.1v1': 'pass', // users cannot register apps
  'MS.AAD.5.3v1': 'pass', // admin consent requests are on
  'MS.AAD.5.5v1': 'pass', // password addition is blocked for every app and service principal
  'MS.AAD.5.6v1': 'pass', // lifetime is moot once additions are blocked
  'MS.AAD.5.7v1': 'fail', // certificates may live 400 days, and only newer apps are covered
  'MS.AAD.6.1v1': 'pass', // passwords never expire
  'MS.AAD.7.1v1': 'pass', // two Global Administrators
  'MS.AAD.7.2v1': 'fail', // two Global Administrators against one other admin
  'MS.AAD.7.3v1': 'fail', // Ben is synced from on-premises
  'MS.AAD.7.4v1': 'fail', // Ada's Global Administrator assignment is permanent
  'MS.AAD.7.6v1': 'pass', // Global Administrator activation needs approval
  'MS.AAD.7.7v1': 'fail', // other roles send no assignment alerts
  'MS.AAD.7.8v1': 'pass', // Global Administrator activations send alerts
  'MS.AAD.7.9v1': 'fail', // other roles send no activation alerts
  'MS.AAD.8.1v1': 'pass', // guests are restricted
  'MS.AAD.8.2v1': 'fail', // everyone can invite guests
  'MS.EXO.1.1v2': 'pass', // no domain allows automatic forwarding
  'MS.EXO.7.1v1': 'pass', // external senders are flagged
  'MS.SECURITYSUITE.1.1v1': 'pass', // the Default malware policy blocks .exe, .cmd and .vbe
  'MS.SECURITYSUITE.1.2v1': 'fail', // zero-hour auto purge is off
  'MS.SECURITYSUITE.1.4v1': 'pass', // Defender scans SharePoint, OneDrive and Teams files
  'MS.SECURITYSUITE.2.2v1': 'pass', // the Default anti-phish policy protects the tenant's own domains, and quarantines
  'MS.SECURITYSUITE.2.4v1': 'fail', // the unverified-sender question mark is off
  'MS.SECURITYSUITE.4.1v1': 'fail', // one required alert is turned off
  'MS.SECURITYSUITE.7.1v1': 'pass', // one Safe Links rule covers everyone, for email, Teams, Office and internal senders
  'MS.SECURITYSUITE.7.2v1': 'pass', // it scans links before delivering
  'MS.SECURITYSUITE.7.3v1': 'fail', // it does not track clicks
  'MS.SECURITYSUITE.8.1v1': 'fail', // the connection filter has an IP allow list
  'MS.SECURITYSUITE.8.2v1': 'pass', // the safe list is off
  'MS.SHAREPOINT.1.1v1': 'pass', // SharePoint sharing is limited to existing guests
  'MS.SHAREPOINT.1.3v1': 'fail', // external sharing is on, with no domain list
  'MS.TEAMS.1.1v1': 'fail', // a named meeting policy lets outside people request control
  'MS.TEAMS.1.2v2': 'pass',
  'MS.TEAMS.1.3v1': 'pass', // the Global policy admits only people in the company, and dial-in users wait
  'MS.TEAMS.1.4v1': 'pass',
  'MS.TEAMS.1.5v1': 'fail', // the named policy lets dial-in users skip the lobby
  'MS.TEAMS.1.6v1': 'fail', // cloud recording is on in the Global policy
  'MS.TEAMS.1.7v2': 'fail', // live events are always recorded
  'MS.TEAMS.2.1v2': 'pass', // external access is limited to one partner domain
  'MS.TEAMS.2.2v2': 'pass', // personal Teams accounts cannot start a chat
  'MS.TEAMS.2.3v2': 'fail', // users can still chat with personal Teams accounts
  'MS.TEAMS.4.1v1': 'fail', // email into channels is on
  'MS.POWERPLATFORM.2.1v1': 'pass', // a DLP policy covers the default environment
  'MS.POWERPLATFORM.2.2v1': 'fail', // the Sales environment has no DLP policy
  'MS.POWERBI.1.1v1': 'pass', // publish to web is off
  'MS.POWERBI.2.1v1': 'fail', // every guest can open shared content
  'MS.POWERBI.3.1v1': 'pass',
  'MS.POWERBI.4.1v1': 'fail', // every app may call the read-only admin APIs
  'MS.POWERBI.4.2v1': 'pass',
  'MS.POWERBI.5.1v1': 'pass',
  'MS.POWERBI.6.1v1': 'fail', // R and Python visuals are on
  'MS.POWERBI.7.1v1': 'pass',
});

// The time the fixture's PIM eligibilities are judged at, as the tests run it.
export const FIXTURE_NOW = '2026-06-01T12:00:00.000Z';

/**
 * ScubaGear's whole input document for `product`, built from these backups the way the
 * controls build it (every key the product's rules read that Keel can build).
 */
export function fixtureDocument(product, { version, now = FIXTURE_NOW }) {
  const keys = [...new Set(importScubaGearRules().rules.filter((rule) => rule.product === product).flatMap((rule) => rule.inputs))]
    .filter((key) => ADAPTERS[key]?.build).sort();
  const facts = Object.fromEntries(Object.entries(FIXTURE_BACKUPS).map(([type, resources]) => [type, resources.map((resource) => maskedFacts(type, resource))]));
  const built = buildInput(keys, facts, { version, now });
  if (built.couldNotBuild) throw built.couldNotBuild;
  return built.document;
}
