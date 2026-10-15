/**
 * Wave 2 WKLD: the workload configuration writes for mail flow, the Exchange settings
 * READ-EXO added, Teams org-wide and voice policies, and Purview retention and DLP.
 *
 * Pure data, in the shape of WORKLOAD_WRITE_OPERATIONS (coverage/qualification.mjs),
 * which spreads it in. An entry runs only once workloadWriteQualification enables it
 * (live read, observed grants, live write capture). Each entry is one operation with its own proof:
 *  - `method` is the Set- (or, for `.add`, New-) cmdlet, `fields` the parameters KEEL
 *    may send besides the identity. Everything else the read keeps is compared and,
 *    when it differs, listed for an administrator (cmdletSettings.mjs).
 *  - `family` names the collector family the write restores, `readBack` that family's
 *    read operation, which must be enabled for the write to run.
 *  - `identity` says how the object is named to the cmdlet: `guid` (-Identity <Guid>,
 *    Exchange and Purview objects), `object-name` (-Identity <Name>, for an Exchange
 *    cmdlet that refuses a Guid: Set-QuarantinePolicy fails its Identity argument
 *    transformation on one, #339), `policy` (-Identity as Teams answered it, `Global`
 *    or `Tag:<name>`), `name` (-Identity <name> for a New- of a named Teams policy).
 *  - Fields were declared from Microsoft's cmdlet documentation, not measured live.
 *    A value the cmdlet transport cannot carry (an object, a list of non-strings) is
 *    never sent, whatever is declared here.
 * Nothing here deletes: no Remove- cmdlet is declared, and no Enable-/Disable- one
 * (a rule's State is listed for an administrator).
 */
const EXO = Object.freeze({
  module: 'ExchangeOnlineManagement', session: 'exo',
  rbac: Object.freeze({ permissions: Object.freeze(['Exchange.ManageAsApp']), roles: Object.freeze(['Exchange Administrator']) }),
  requires: Object.freeze(['exchange.client-access.update']),
});
const IPPS = Object.freeze({
  module: 'ExchangeOnlineManagement', session: 'ipps',
  rbac: Object.freeze({ permissions: Object.freeze(['Exchange.ManageAsApp']), roles: Object.freeze(['Compliance Administrator']) }),
  requires: Object.freeze(['exchange.client-access.update']),
});
const TEAMS = Object.freeze({
  module: 'MicrosoftTeams', session: 'teams',
  rbac: Object.freeze({ permissions: Object.freeze([]), roles: Object.freeze(['Teams Administrator']) }),
  requires: Object.freeze(['teams.settings.update']),
});
const EXO_DOCS = 'https://learn.microsoft.com/en-us/powershell/module/exchange';
const TEAMS_DOCS = 'https://learn.microsoft.com/en-us/powershell/module/teams';

const entries = {};
function declare(plane, docs, { id, workload, family, resourceType, readBack, method, identity = 'guid', fields }) {
  entries[id] = Object.freeze({
    workload, family, resourceType, kind: 'cmdlet', method, module: plane.module, session: plane.session, identity, readBack,
    fields: Object.freeze([...fields]), rbac: plane.rbac, grantsRequired: true, requires: plane.requires,
    source: `${docs}/${method.toLowerCase()}`,
  });
}

/** One update (Set-) per family, and for a named Teams policy an add (New-) too. */
function family(plane, docs, { workload, prefix, family: name, resourceType, readBack, set, create = null, identity = 'guid', fields }) {
  declare(plane, docs, { id: `${prefix}.update`, workload, family: name, resourceType, readBack, method: set, identity, fields });
  if (create) declare(plane, docs, { id: `${prefix}.add`, workload, family: name, resourceType, readBack, method: create, identity: 'name', fields });
}

// ------------------------------------------------------------ mail flow
const MAIL_FLOW = 'exchange-mail-flow';
family(EXO, EXO_DOCS, {
  workload: MAIL_FLOW, prefix: 'mailflow.transport-rule', family: 'transportRule', resourceType: 'exchangeTransportRule',
  readBack: 'mailflow.transport-rules', set: 'Set-TransportRule',
  fields: [
    'Priority', 'Comments', 'Mode', 'StopRuleProcessing', 'RuleErrorAction', 'SenderAddressLocation', 'ActivationDate', 'ExpiryDate',
    'From', 'FromScope', 'SentTo', 'SentToScope', 'SenderDomainIs', 'RecipientDomainIs', 'FromAddressContainsWords',
    'SubjectContainsWords', 'SubjectOrBodyContainsWords', 'AttachmentExtensionMatchesWords', 'AttachmentHasExecutableContent',
    'SenderIpRanges', 'HeaderContainsMessageHeader', 'HeaderContainsWords',
    'ExceptIfFrom', 'ExceptIfSentTo', 'ExceptIfSenderDomainIs', 'ExceptIfRecipientDomainIs', 'ExceptIfSenderIpRanges',
    'SetSCL', 'SetHeaderName', 'SetHeaderValue', 'PrependSubject', 'RedirectMessageTo', 'BlindCopyTo', 'AddToRecipients',
    'ModerateMessageByUser', 'RejectMessageReasonText', 'RejectMessageEnhancedStatusCode', 'DeleteMessage', 'Quarantine',
    'ApplyHtmlDisclaimerText', 'ApplyHtmlDisclaimerLocation', 'ApplyHtmlDisclaimerFallbackAction',
    'RouteMessageOutboundConnector', 'RouteMessageOutboundRequireTls', 'ApplyRightsProtectionTemplate', 'GenerateIncidentReport',
  ],
});
family(EXO, EXO_DOCS, {
  workload: MAIL_FLOW, prefix: 'mailflow.inbound-connector', family: 'inboundConnector', resourceType: 'exchangeInboundConnector',
  readBack: 'mailflow.inbound-connectors', set: 'Set-InboundConnector',
  fields: [
    'Enabled', 'ConnectorType', 'ConnectorSource', 'Comment', 'SenderDomains', 'SenderIPAddresses', 'RestrictDomainsToIPAddresses',
    'RestrictDomainsToCertificate', 'RequireTls', 'TlsSenderCertificateName', 'CloudServicesMailEnabled', 'TreatMessagesAsInternal',
    'TrustedOrganizations', 'AssociatedAcceptedDomains', 'EFSkipLastIP', 'EFSkipIPs', 'EFSkipMailGateway', 'EFUsers', 'ScanAndDropRecipients',
  ],
});
family(EXO, EXO_DOCS, {
  workload: MAIL_FLOW, prefix: 'mailflow.outbound-connector', family: 'outboundConnector', resourceType: 'exchangeOutboundConnector',
  readBack: 'mailflow.outbound-connectors', set: 'Set-OutboundConnector',
  fields: [
    'Enabled', 'ConnectorType', 'ConnectorSource', 'Comment', 'RecipientDomains', 'SmartHosts', 'UseMXRecord', 'TlsSettings', 'TlsDomain',
    'IsTransportRuleScoped', 'RouteAllMessagesViaOnPremises', 'CloudServicesMailEnabled', 'AllAcceptedDomains', 'SenderRewritingEnabled', 'TestMode',
  ],
});

// ------------------------------------------- Exchange settings (READ-EXO)
const EXTENDED = 'exchange-extended';
const RECIPIENT_SCOPE = ['Priority', 'Comments', 'SentTo', 'SentToMemberOf', 'RecipientDomainIs', 'ExceptIfSentTo', 'ExceptIfSentToMemberOf', 'ExceptIfRecipientDomainIs'];
const SENDER_SCOPE = ['Priority', 'Comments', 'From', 'FromMemberOf', 'SenderDomainIs', 'ExceptIfFrom', 'ExceptIfFromMemberOf', 'ExceptIfSenderDomainIs'];
const extended = (name, prefix, read, set, resourceType, fields, identity = 'guid') => family(EXO, EXO_DOCS, {
  workload: EXTENDED, prefix: `exchange-extended.${prefix}`, family: name, resourceType, readBack: `exchange-extended.${read}`, set, identity, fields,
});
extended('outboundSpamPolicy', 'outbound-spam-policy', 'outbound-spam-policies', 'Set-HostedOutboundSpamFilterPolicy', 'exchangeOutboundSpamPolicy', [
  'AdminDisplayName', 'RecipientLimitExternalPerHour', 'RecipientLimitInternalPerHour', 'RecipientLimitPerDay', 'ActionWhenThresholdReached',
  'AutoForwardingMode', 'BccSuspiciousOutboundMail', 'BccSuspiciousOutboundAdditionalRecipients', 'NotifyOutboundSpam', 'NotifyOutboundSpamRecipients',
]);
extended('outboundSpamRule', 'outbound-spam-rule', 'outbound-spam-rules', 'Set-HostedOutboundSpamFilterRule', 'exchangeOutboundSpamRule', SENDER_SCOPE);
extended('connectionFilterPolicy', 'connection-filter-policy', 'connection-filter-policies', 'Set-HostedConnectionFilterPolicy', 'exchangeConnectionFilterPolicy', [
  'AdminDisplayName', 'IPAllowList', 'IPBlockList', 'EnableSafeList',
]);
extended('antiSpamRule', 'anti-spam-rule', 'anti-spam-rules', 'Set-HostedContentFilterRule', 'exchangeAntiSpamRule', RECIPIENT_SCOPE);
extended('antiPhishRule', 'anti-phish-rule', 'anti-phish-rules', 'Set-AntiPhishRule', 'exchangeAntiPhishRule', RECIPIENT_SCOPE);
extended('antiMalwareRule', 'anti-malware-rule', 'anti-malware-rules', 'Set-MalwareFilterRule', 'exchangeAntiMalwareRule', RECIPIENT_SCOPE);
extended('quarantinePolicy', 'quarantine-policy', 'quarantine-policies', 'Set-QuarantinePolicy', 'exchangeQuarantinePolicy', [
  'EndUserQuarantinePermissionsValue', 'ESNEnabled', 'IncludeMessagesFromBlockedSenderAddress',
], 'object-name');
extended('globalQuarantineSettings', 'quarantine-global-settings', 'quarantine-global-settings', 'Set-QuarantinePolicy', 'exchangeGlobalQuarantineSettings', [
  'EndUserSpamNotificationFrequencyInDays', 'EndUserSpamNotificationCustomFromAddress', 'MultiLanguageSetting', 'MultiLanguageCustomDisclaimer',
  'MultiLanguageSenderName', 'OrganizationBrandingEnabled',
], 'object-name');
extended('journalRule', 'journal-rule', 'journal-rules', 'Set-JournalRule', 'exchangeJournalRule', ['Recipient', 'JournalEmailAddress', 'Scope']);
extended('mobileDevicePolicy', 'mobile-device-policy', 'mobile-device-policies', 'Set-MobileDeviceMailboxPolicy', 'exchangeMobileDevicePolicy', [
  'AllowNonProvisionableDevices', 'PasswordEnabled', 'AlphanumericPasswordRequired', 'AllowSimplePassword', 'MinPasswordLength',
  'MinPasswordComplexCharacters', 'MaxPasswordFailedAttempts', 'PasswordHistory', 'PasswordRecoveryEnabled', 'DeviceEncryptionEnabled',
  'RequireDeviceEncryption', 'RequireStorageCardEncryption', 'AttachmentsEnabled', 'AllowCamera', 'AllowBluetooth', 'AllowBrowser',
  'AllowStorageCard', 'AllowWiFi', 'AllowTextMessaging', 'AllowPOPIMAPEmail', 'AllowHTMLEmail',
]);
extended('deviceAccessRule', 'device-access-rule', 'device-access-rules', 'Set-ActiveSyncDeviceAccessRule', 'exchangeDeviceAccessRule', ['AccessLevel']);
extended('activeSyncSettings', 'activesync-settings', 'activesync-settings', 'Set-ActiveSyncOrganizationSettings', 'exchangeActiveSyncSettings', [
  'DefaultAccessLevel', 'UserMailInsert', 'AdminMailRecipients', 'OtaNotificationMailInsert', 'AllowAccessForUnSupportedPlatform',
]);
const ADDRESS_FILTER = ['RecipientFilter', 'IncludedRecipients', 'ConditionalCompany', 'ConditionalDepartment', 'ConditionalStateOrProvince', 'ConditionalCustomAttribute1', 'ConditionalCustomAttribute2'];
extended('addressList', 'address-list', 'address-lists', 'Set-AddressList', 'exchangeAddressList', ['DisplayName', ...ADDRESS_FILTER]);
extended('globalAddressList', 'global-address-list', 'global-address-lists', 'Set-GlobalAddressList', 'exchangeGlobalAddressList', ADDRESS_FILTER);
extended('offlineAddressBook', 'offline-address-book', 'offline-address-books', 'Set-OfflineAddressBook', 'exchangeOfflineAddressBook', ['AddressLists']);
extended('addressBookPolicy', 'address-book-policy', 'address-book-policies', 'Set-AddressBookPolicy', 'exchangeAddressBookPolicy', [
  'AddressLists', 'GlobalAddressList', 'OfflineAddressBook', 'RoomList',
]);
extended('retentionPolicyTag', 'retention-policy-tag', 'retention-policy-tags', 'Set-RetentionPolicyTag', 'exchangeRetentionPolicyTag', [
  'RetentionEnabled', 'AgeLimitForRetention', 'RetentionAction', 'Comment',
]);
extended('retentionPolicy', 'retention-policy', 'retention-policies', 'Set-RetentionPolicy', 'exchangeRetentionPolicy', ['RetentionPolicyTagLinks']);
extended('safeLinksRule', 'safe-links-rule', 'safe-links-rules', 'Set-SafeLinksRule', 'exchangeSafeLinksRule', RECIPIENT_SCOPE);
extended('safeAttachmentRule', 'safe-attachment-rule', 'safe-attachment-rules', 'Set-SafeAttachmentRule', 'exchangeSafeAttachmentRule', RECIPIENT_SCOPE);
extended('defenderForOffice', 'defender-office-apps', 'defender-office-apps', 'Set-AtpPolicyForO365', 'exchangeDefenderForOffice', [
  'EnableATPForSPOTeamsODB', 'EnableSafeDocs', 'AllowSafeDocsOpen',
]);

// -------------------------------------------------- Teams org-wide policies
const TEAMS_POLICIES = 'teams-org-policies';
family(TEAMS, TEAMS_DOCS, {
  workload: TEAMS_POLICIES, prefix: 'teams.meeting-policy', family: 'meetingPolicy', resourceType: 'teamsMeetingPolicy',
  readBack: 'teams.meeting-policies', set: 'Set-CsTeamsMeetingPolicy', create: 'New-CsTeamsMeetingPolicy', identity: 'policy',
  fields: [
    'Description', 'AllowChannelMeetingScheduling', 'AllowMeetNow', 'AllowPrivateMeetNow', 'AllowPrivateMeetingScheduling',
    'MeetingChatEnabledType', 'LiveCaptionsEnabledType', 'AllowIPAudio', 'AllowIPVideo', 'IPAudioMode', 'IPVideoMode',
    'AllowPowerPointSharing', 'AllowWhiteboard', 'AllowParticipantGiveRequestControl', 'AllowExternalParticipantGiveRequestControl',
    'AllowTranscription', 'AllowCloudRecording', 'NewMeetingRecordingExpirationDays', 'AllowAnonymousUsersToJoinMeeting',
    'AllowAnonymousUsersToStartMeeting', 'AllowPSTNUsersToBypassLobby', 'AllowExternalNonTrustedMeetingChat',
    'DesignatedPresenterRoleMode', 'AllowBreakoutRooms', 'AllowMeetingReactions', 'AllowMeetingRegistration', 'WhoCanRegister',
    'AllowEngagementReport', 'AllowOutlookAddIn', 'StreamingAttendeeMode', 'MediaBitRateKb', 'VideoFiltersMode',
    'AllowWatermarkForScreenSharing', 'AllowWatermarkForCameraVideo', 'ExplicitRecordingConsent',
  ],
});
family(TEAMS, TEAMS_DOCS, {
  workload: TEAMS_POLICIES, prefix: 'teams.messaging-policy', family: 'messagingPolicy', resourceType: 'teamsMessagingPolicy',
  readBack: 'teams.messaging-policies', set: 'Set-CsTeamsMessagingPolicy', create: 'New-CsTeamsMessagingPolicy', identity: 'policy',
  fields: [
    'Description', 'AllowUrlPreviews', 'AllowOwnerDeleteMessage', 'AllowUserEditMessage', 'AllowUserDeleteMessage', 'AllowUserDeleteChat',
    'AllowUserChat', 'AllowRemoveUser', 'AllowGiphy', 'GiphyRatingType', 'AllowGiphyDisplay', 'AllowPasteInternetImage', 'AllowMemes',
    'AllowImmersiveReader', 'AllowStickers', 'AllowUserTranslation', 'ReadReceiptsEnabledType', 'AllowPriorityMessages', 'AllowSmartReply',
    'AllowSmartCompose', 'ChannelsInChatListEnabledType', 'AudioMessageEnabledType', 'ChatPermissionRole',
    'AllowFullChatPermissionUserToDeleteAnyMessage', 'AllowVideoMessages', 'AllowCommunicationComplianceEndUserReporting',
    'AllowSecurityEndUserReporting', 'AllowGroupChatJoinLinks',
  ],
});
family(TEAMS, TEAMS_DOCS, {
  workload: TEAMS_POLICIES, prefix: 'teams.federation-configuration', family: 'federationConfiguration', resourceType: 'teamsFederationConfiguration',
  readBack: 'teams.federation-configuration', set: 'Set-CsTenantFederationConfiguration', identity: 'policy',
  fields: [
    'AllowFederatedUsers', 'BlockAllSubdomains', 'AllowTeamsConsumer', 'AllowTeamsConsumerInbound', 'RestrictTeamsConsumerToExternalUserProfiles',
    'AllowPublicUsers', 'TreatDiscoveredPartnersAsUnverified', 'SharedSipAddressSpace', 'ExternalAccessWithTrialTenants',
  ],
});
family(TEAMS, TEAMS_DOCS, {
  workload: TEAMS_POLICIES, prefix: 'teams.client-configuration', family: 'clientConfiguration', resourceType: 'teamsClientConfiguration',
  readBack: 'teams.client-configuration', set: 'Set-CsTeamsClientConfiguration', identity: 'policy',
  fields: [
    'AllowGuestUser', 'AllowEmailIntoChannel', 'RestrictedSenderList', 'AllowDropBox', 'AllowBox', 'AllowGoogleDrive', 'AllowShareFile',
    'AllowEgnyte', 'AllowOrganizationTab', 'AllowSkypeBusinessInterop', 'ContentPin', 'AllowResourceAccountSendMessage',
    'ResourceAccountContentAccess', 'AllowScopedPeopleSearchandAccess', 'AllowRoleBasedChatPermissions',
  ],
});
family(TEAMS, TEAMS_DOCS, {
  workload: TEAMS_POLICIES, prefix: 'teams.guest-meeting-configuration', family: 'guestMeetingConfiguration', resourceType: 'teamsGuestMeetingConfiguration',
  readBack: 'teams.guest-meeting-configuration', set: 'Set-CsTeamsGuestMeetingConfiguration', identity: 'policy',
  fields: ['AllowIPVideo', 'AllowMeetNow', 'LiveCaptionsEnabledType', 'AllowTranscription'],
});
family(TEAMS, TEAMS_DOCS, {
  workload: TEAMS_POLICIES, prefix: 'teams.guest-messaging-configuration', family: 'guestMessagingConfiguration', resourceType: 'teamsGuestMessagingConfiguration',
  readBack: 'teams.guest-messaging-configuration', set: 'Set-CsTeamsGuestMessagingConfiguration', identity: 'policy',
  fields: ['AllowUserEditMessage', 'AllowUserDeleteMessage', 'AllowUserDeleteChat', 'AllowUserChat', 'AllowGiphy', 'GiphyRatingType', 'AllowMemes', 'AllowImmersiveReader', 'AllowStickers'],
});
family(TEAMS, TEAMS_DOCS, {
  workload: TEAMS_POLICIES, prefix: 'teams.guest-calling-configuration', family: 'guestCallingConfiguration', resourceType: 'teamsGuestCallingConfiguration',
  readBack: 'teams.guest-calling-configuration', set: 'Set-CsTeamsGuestCallingConfiguration', identity: 'policy',
  fields: ['AllowPrivateCalling'],
});

// ------------------------------------------- Teams voice and live event policies
const TEAMS_VOICE = 'teams-voice-policies';
const voice = (name, prefix, read, set, create, resourceType, fields) => family(TEAMS, TEAMS_DOCS, {
  workload: TEAMS_VOICE, prefix: `teams.${prefix}`, family: name, resourceType, readBack: `teams.${read}`, set, create, identity: 'policy', fields,
});
voice('callingPolicy', 'calling-policy', 'calling-policies', 'Set-CsTeamsCallingPolicy', 'New-CsTeamsCallingPolicy', 'teamsCallingPolicy', [
  'Description', 'AllowPrivateCalling', 'AllowWebPSTNCalling', 'AllowSIPDevicesCalling', 'AllowVoicemail', 'AllowCallGroups', 'AllowDelegation',
  'AllowCallForwardingToUser', 'AllowCallForwardingToPhone', 'AllowCallRedirect', 'PreventTollBypass', 'BusyOnBusyEnabledType',
  'MusicOnHoldEnabledType', 'AllowCloudRecordingForCalls', 'AllowTranscriptionForCalling', 'LiveCaptionsEnabledTypeForCalling',
  'AutoAnswerEnabledType', 'SpamFilteringEnabledType', 'CallRecordingExpirationDays', 'InboundPstnCallRoutingTreatment',
  'InboundFederatedCallRoutingTreatment', 'PopoutForIncomingPstnCalls', 'PopoutAppPathForIncomingPstnCalls',
]);
voice('voiceRoutingPolicy', 'voice-routing-policy', 'voice-routing-policies', 'Set-CsOnlineVoiceRoutingPolicy', 'New-CsOnlineVoiceRoutingPolicy', 'teamsVoiceRoutingPolicy', [
  'Description', 'OnlinePstnUsages',
]);
voice('dialPlan', 'dial-plan', 'dial-plans', 'Set-CsTenantDialPlan', 'New-CsTenantDialPlan', 'teamsDialPlan', [
  'Description', 'SimpleName', 'OptimizeDeviceDialing', 'ExternalAccessPrefix',
]);
voice('emergencyCallingPolicy', 'emergency-calling-policy', 'emergency-calling-policies', 'Set-CsTeamsEmergencyCallingPolicy', 'New-CsTeamsEmergencyCallingPolicy', 'teamsEmergencyCallingPolicy', [
  'Description', 'NotificationGroup', 'NotificationDialOutNumber', 'NotificationMode', 'ExternalLocationLookupMode', 'EnhancedEmergencyServiceDisclaimer',
]);
voice('emergencyCallRoutingPolicy', 'emergency-call-routing-policy', 'emergency-call-routing-policies', 'Set-CsTeamsEmergencyCallRoutingPolicy', 'New-CsTeamsEmergencyCallRoutingPolicy', 'teamsEmergencyCallRoutingPolicy', [
  'Description', 'AllowEnhancedEmergencyServices',
]);
voice('callParkPolicy', 'call-park-policy', 'call-park-policies', 'Set-CsTeamsCallParkPolicy', 'New-CsTeamsCallParkPolicy', 'teamsCallParkPolicy', [
  'Description', 'AllowCallPark', 'ParkTimeoutSeconds', 'PickupRangeStart', 'PickupRangeEnd',
]);
voice('callerIdPolicy', 'caller-id-policy', 'caller-id-policies', 'Set-CsCallingLineIdentity', 'New-CsCallingLineIdentity', 'teamsCallerIdPolicy', [
  'Description', 'CallingIDSubstitute', 'ServiceNumber', 'ResourceAccount', 'CompanyName', 'EnableUserOverride', 'BlockIncomingPstnCallerID',
]);
voice('voicemailPolicy', 'voicemail-policy', 'voicemail-policies', 'Set-CsOnlineVoicemailPolicy', 'New-CsOnlineVoicemailPolicy', 'teamsVoicemailPolicy', [
  'Description', 'EnableTranscription', 'EnableTranscriptionProfanityMasking', 'EnableTranscriptionTranslation',
  'EnableEditingCallAnswerRulesSetting', 'PrimarySystemPromptLanguage', 'SecondarySystemPromptLanguage',
]);
voice('liveEventsPolicy', 'live-events-policy', 'live-events-policies', 'Set-CsTeamsMeetingBroadcastPolicy', 'New-CsTeamsMeetingBroadcastPolicy', 'teamsLiveEventsPolicy', [
  'Description', 'AllowBroadcastScheduling', 'AllowBroadcastTranscription', 'BroadcastAttendeeVisibilityMode', 'BroadcastRecordingMode',
]);
voice('eventsPolicy', 'events-policy', 'events-policies', 'Set-CsTeamsEventsPolicy', 'New-CsTeamsEventsPolicy', 'teamsEventsPolicy', [
  'Description', 'AllowWebinars', 'AllowTownhalls', 'AllowEmailEditing', 'EventAccessType', 'TownhallEventAttendeeAccess', 'UseMicrosoftECDN',
  'TownhallChatExperience', 'RecordingForTownhall', 'RecordingForWebinar', 'TranscriptionForTownhall', 'TranscriptionForWebinar',
]);
voice('liveEventsConfiguration', 'live-events-configuration', 'live-events-configuration', 'Set-CsTeamsMeetingBroadcastConfiguration', null, 'teamsLiveEventsConfiguration', [
  'SupportURL', 'AllowSdnProviderForBroadcastMeeting', 'SdnName', 'SdnLicenseId', 'SdnApiTemplateUrl',
]);

// ---------------------------------------------- Purview retention and DLP
const RETENTION_DLP = 'purview-retention-dlp';
family(IPPS, EXO_DOCS, {
  workload: RETENTION_DLP, prefix: 'purview.retention-policy', family: 'retentionPolicy', resourceType: 'purviewRetentionPolicy',
  readBack: 'purview.retention-policies', set: 'Set-RetentionCompliancePolicy', fields: ['Comment', 'Enabled'],
});
family(IPPS, EXO_DOCS, {
  workload: RETENTION_DLP, prefix: 'purview.retention-rule', family: 'retentionRule', resourceType: 'purviewRetentionRule',
  readBack: 'purview.retention-rules', set: 'Set-RetentionComplianceRule',
  fields: ['Comment', 'RetentionDuration', 'RetentionDurationDisplayHint', 'RetentionComplianceAction', 'ExpirationDateOption', 'ContentMatchQuery'],
});
family(IPPS, EXO_DOCS, {
  workload: RETENTION_DLP, prefix: 'purview.dlp-policy', family: 'dlpPolicy', resourceType: 'purviewDlpPolicy',
  readBack: 'purview.dlp-policies', set: 'Set-DlpCompliancePolicy', fields: ['Comment', 'Mode', 'Priority'],
});
family(IPPS, EXO_DOCS, {
  workload: RETENTION_DLP, prefix: 'purview.dlp-rule', family: 'dlpRule', resourceType: 'purviewDlpRule',
  readBack: 'purview.dlp-rules', set: 'Set-DlpComplianceRule',
  fields: [
    'Comment', 'Disabled', 'Priority', 'BlockAccess', 'BlockAccessScope', 'NotifyUser', 'NotifyUserType', 'NotifyEmailCustomText',
    'NotifyPolicyTipCustomText', 'NotifyAllowOverride', 'GenerateAlert', 'GenerateIncidentReport', 'IncidentReportContent',
    'ReportSeverityLevel', 'StopPolicyProcessing',
  ],
});
// Retention labels (READ-TEAMS-PV's purview-governance workload): text and duration.
family(IPPS, EXO_DOCS, {
  workload: 'purview-governance', prefix: 'purview.retention-label', family: 'retentionLabel', resourceType: 'purviewRetentionLabel',
  readBack: 'purview.retention-labels', set: 'Set-ComplianceTag', fields: ['Comment', 'Notes', 'RetentionDuration'],
});

export const WKLD_WRITE_OPERATIONS = Object.freeze(entries);
