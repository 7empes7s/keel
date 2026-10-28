#Requires -Version 7.0
<#
.SYNOPSIS
  KEEL PowerShell plane: run ONE allowlisted Exchange Online, Security & Compliance
  (Purview), PnP or Microsoft Teams cmdlet (roadmap tasks 105 and 106, issue #154).

.DESCRIPTION
  Reads the job descriptor from $env:KEEL_JOB_JSON:
    { mode: "cmdlet", module, cmdlet, parameters: { Name: value, ... }, tenantConfigPath? }
  There is no script field and nothing here builds PowerShell source from the job.
  The cmdlet name must be in $Allowed and every parameter name in its list. Values
  are bound by splatting a hashtable, so each value is exactly one argument: a
  mailbox identity such as  o'brien'; Remove-Mailbox x  is passed literally.

  Answers one JSON envelope on stdout:
    { ok: true,  output: [...] }                               exit 0
    { ok: false, error: { message, category, errorId } }       exit 1
  A cmdlet error is never reported as an empty success.

  Fixture-tested only through engine/roadmap/exchange-config.test.mjs,
  engine/roadmap/onedrive-purview.test.mjs, engine/roadmap/exchange-mail-flow.test.mjs,
  engine/roadmap/teams-org-policies.test.mjs, engine/roadmap/exchange-extended.test.mjs,
  engine/roadmap/exchange-role-groups.test.mjs,
  engine/roadmap/purview-retention-dlp.test.mjs and engine/roadmap/workload-writers.test.mjs
  (which play this contract); it has not
  been run against a tenant.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'keel-json.ps1')
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

# Cmdlet -> parameter names it may receive. Reads take only -Identity. Writes take
# the exact settings KEEL restores (engine/coverage/qualification.mjs).
$Allowed = @{
    'Get-OrganizationConfig' = @()
    'Get-Mailbox'            = @('Identity')
    'Get-CASMailbox'         = @('Identity')
    'Set-CASMailbox'         = @('Identity', 'OWAEnabled', 'ActiveSyncEnabled', 'PopEnabled', 'ImapEnabled', 'MAPIEnabled', 'EwsEnabled', 'SmtpClientAuthenticationDisabled')
    'Set-Mailbox'            = @('Identity', 'LitigationHoldEnabled', 'RetentionHoldEnabled', 'SingleItemRecoveryEnabled', 'RetainDeletedItemsFor')
    'Set-OrganizationConfig' = @('MailTipsLargeAudienceThreshold')
}

# Task-106: Purview label configuration runs in the Security & Compliance session
# (Connect-IPPSSession). Only label DEFINITIONS and publishing policies: no cmdlet
# here reads a labeled item or label usage. Writes take display text and AddLabels.
$AllowedPurview = @{
    'Get-Label'       = @()
    'Get-LabelPolicy' = @()
    'Set-Label'       = @('Identity', 'DisplayName', 'Tooltip', 'Comment')
    'Set-LabelPolicy' = @('Identity', 'AddLabels')
}

# Issue #153: organization-wide mail flow and protection settings, read in the
# Exchange Online session with no parameters. Reads only: no Set-, New- or Remove-.
$AllowedMailFlow = @{
    'Get-AcceptedDomain'            = @()
    'Get-RemoteDomain'              = @()
    'Get-TransportRule'             = @()
    'Get-InboundConnector'          = @()
    'Get-OutboundConnector'         = @()
    'Get-HostedContentFilterPolicy' = @()
    'Get-AntiPhishPolicy'           = @()
    'Get-MalwareFilterPolicy'       = @()
    'Get-DkimSigningConfig'         = @()
    'Get-SafeLinksPolicy'           = @()
    'Get-SafeAttachmentPolicy'      = @()
}

# Issue #154: Teams org-wide policies and tenant configuration, read in the
# MicrosoftTeams session with no parameters. Reads only: no Set-, New-, Grant- or Remove-.
$AllowedTeamsPolicy = @{
    'Get-CsTeamsMeetingPolicy'               = @()
    'Get-CsTeamsMessagingPolicy'             = @()
    'Get-CsTeamsAppSetupPolicy'              = @()
    'Get-CsTeamsAppPermissionPolicy'         = @()
    'Get-CsTenantFederationConfiguration'    = @()
    'Get-CsTeamsClientConfiguration'         = @()
    'Get-CsTeamsGuestMeetingConfiguration'   = @()
    'Get-CsTeamsGuestMessagingConfiguration' = @()
    'Get-CsTeamsGuestCallingConfiguration'   = @()
}

# Issue #157: Purview retention and DLP policies and rules, read in the Security &
# Compliance session with no parameters. Reads only: no Set-, New- or Remove-, and no
# cmdlet that reads DLP matches, incidents or reports.
$AllowedPurviewRetentionDlp = @{
    'Get-RetentionCompliancePolicy' = @()
    'Get-RetentionComplianceRule'   = @()
    'Get-DlpCompliancePolicy'       = @()
    'Get-DlpComplianceRule'         = @()
}

# READ-EXO: the Exchange and Defender settings mail flow does not read, in the
# Exchange Online session. Reads only; the one parameter is the global quarantine
# settings' fixed -QuarantinePolicyType.
$AllowedExchangeExtended = @{
    'Get-HostedOutboundSpamFilterPolicy' = @()
    'Get-HostedOutboundSpamFilterRule'   = @()
    'Get-HostedConnectionFilterPolicy'   = @()
    'Get-HostedContentFilterRule'        = @()
    'Get-AntiPhishRule'                  = @()
    'Get-MalwareFilterRule'              = @()
    'Get-EOPProtectionPolicyRule'        = @()
    'Get-QuarantinePolicy'               = @('QuarantinePolicyType')
    'Get-JournalRule'                    = @()
    'Get-MobileDeviceMailboxPolicy'      = @()
    'Get-ActiveSyncDeviceAccessRule'     = @()
    'Get-ActiveSyncOrganizationSettings' = @()
    'Get-AddressList'                    = @()
    'Get-GlobalAddressList'              = @()
    'Get-OfflineAddressBook'             = @()
    'Get-AddressBookPolicy'              = @()
    'Get-RetentionPolicyTag'             = @()
    'Get-RetentionPolicy'                = @()
    'Get-SafeLinksRule'                  = @()
    'Get-SafeAttachmentRule'             = @()
    'Get-ATPProtectionPolicyRule'        = @()
    'Get-AtpPolicyForO365'               = @()
}

# Exchange admin role groups (engine/collect/workloads/exchangeRoleGroups.mjs), in the
# Exchange Online session. One read, no parameters.
$AllowedExchangeRoleGroups = @{
    'Get-RoleGroup' = @()
}

# Wave 1 READ-TEAMS-PV: Teams calling, voice and live event policies and policy
# assignments, read in the MicrosoftTeams session. Only Get-CsOnlineUser takes a
# parameter (-ResultSize, a bound). Reads only.
$AllowedTeamsExtended = @{
    'Get-CsTeamsCallingPolicy'                 = @()
    'Get-CsOnlineVoiceRoutingPolicy'           = @()
    'Get-CsTenantDialPlan'                     = @()
    'Get-CsTeamsEmergencyCallingPolicy'        = @()
    'Get-CsTeamsEmergencyCallRoutingPolicy'    = @()
    'Get-CsTeamsCallParkPolicy'                = @()
    'Get-CsCallingLineIdentity'                = @()
    'Get-CsOnlineVoicemailPolicy'              = @()
    'Get-CsTeamsMeetingBroadcastPolicy'        = @()
    'Get-CsTeamsEventsPolicy'                  = @()
    'Get-CsTeamsMeetingBroadcastConfiguration' = @()
    'Get-CsOnlineUser'                         = @('ResultSize')
    'Get-CsGroupPolicyAssignment'              = @()
}

# Wave 1 READ-TEAMS-PV: Purview retention labels, adaptive scopes, auto-labeling and
# eDiscovery cases and holds, read in the Security & Compliance session. -Case and
# -Policy take ids KEEL read in the same run. Reads only: nothing that reads a search,
# its results, an export or a review set.
$AllowedPurviewExtended = @{
    'Get-ComplianceTag'              = @()
    'Get-AdaptiveScope'              = @()
    'Get-AutoSensitivityLabelPolicy' = @()
    'Get-AutoSensitivityLabelRule'   = @()
    'Get-ComplianceCase'             = @('CaseType')
    'Get-CaseHoldPolicy'             = @('Case')
    'Get-CaseHoldRule'               = @('Policy')
}

# Wave 2 WKLD: workload configuration writes, one Set- (or New- for a named Teams
# policy) per object, each with the identity and the declared fields only
# (engine/restore/workloads/writeDeclarations.mjs; the restore test checks these lists
# match it exactly). No Remove-, Enable-, Disable- or Grant- cmdlet.
$AllowedExchangeWrites = @{
    'Set-ActiveSyncDeviceAccessRule'     = @('Identity', 'AccessLevel')
    'Set-ActiveSyncOrganizationSettings' = @('Identity', 'AdminMailRecipients', 'AllowAccessForUnSupportedPlatform', 'DefaultAccessLevel', 'OtaNotificationMailInsert', 'UserMailInsert')
    'Set-AddressBookPolicy'              = @('Identity', 'AddressLists', 'GlobalAddressList', 'OfflineAddressBook', 'RoomList')
    'Set-AddressList'                    = @('Identity', 'ConditionalCompany', 'ConditionalCustomAttribute1', 'ConditionalCustomAttribute2', 'ConditionalDepartment', 'ConditionalStateOrProvince', 'DisplayName', 'IncludedRecipients', 'RecipientFilter')
    'Set-AntiPhishPolicy'                = @('Identity', 'EnableSpoofIntelligence', 'EnableUnauthenticatedSender', 'HonorDmarcPolicy')
    'Set-AntiPhishRule'                  = @('Identity', 'Comments', 'ExceptIfRecipientDomainIs', 'ExceptIfSentTo', 'ExceptIfSentToMemberOf', 'Priority', 'RecipientDomainIs', 'SentTo', 'SentToMemberOf')
    'Set-AtpPolicyForO365'               = @('Identity', 'AllowSafeDocsOpen', 'EnableATPForSPOTeamsODB', 'EnableSafeDocs')
    'Set-GlobalAddressList'              = @('Identity', 'ConditionalCompany', 'ConditionalCustomAttribute1', 'ConditionalCustomAttribute2', 'ConditionalDepartment', 'ConditionalStateOrProvince', 'IncludedRecipients', 'RecipientFilter')
    'Set-HostedConnectionFilterPolicy'   = @('Identity', 'AdminDisplayName', 'IPBlockList')
    'Set-HostedContentFilterPolicy'      = @('Identity', 'AllowedSenderDomains', 'HighConfidencePhishAction', 'InlineSafetyTipsEnabled', 'PhishSpamAction', 'PhishZapEnabled')
    'Set-HostedContentFilterRule'        = @('Identity', 'Comments', 'ExceptIfRecipientDomainIs', 'ExceptIfSentTo', 'ExceptIfSentToMemberOf', 'Priority', 'RecipientDomainIs', 'SentTo', 'SentToMemberOf')
    'Set-HostedOutboundSpamFilterPolicy' = @('Identity', 'ActionWhenThresholdReached', 'AdminDisplayName', 'AutoForwardingMode', 'BccSuspiciousOutboundAdditionalRecipients', 'BccSuspiciousOutboundMail', 'NotifyOutboundSpam', 'NotifyOutboundSpamRecipients', 'RecipientLimitExternalPerHour', 'RecipientLimitInternalPerHour', 'RecipientLimitPerDay')
    'Set-HostedOutboundSpamFilterRule'   = @('Identity', 'Comments', 'ExceptIfFrom', 'ExceptIfFromMemberOf', 'ExceptIfSenderDomainIs', 'From', 'FromMemberOf', 'Priority', 'SenderDomainIs')
    'Set-InboundConnector'               = @('Identity', 'AssociatedAcceptedDomains', 'CloudServicesMailEnabled', 'Comment', 'ConnectorSource', 'Enabled', 'ScanAndDropRecipients')
    'Set-JournalRule'                    = @('Identity', 'JournalEmailAddress', 'Recipient', 'Scope')
    'Set-MalwareFilterPolicy'            = @('Identity', 'AdminDisplayName', 'CustomNotifications', 'EnableFileFilter', 'ZapEnabled')
    'Set-MalwareFilterRule'              = @('Identity', 'Comments', 'ExceptIfRecipientDomainIs', 'ExceptIfSentTo', 'ExceptIfSentToMemberOf', 'Priority', 'RecipientDomainIs', 'SentTo', 'SentToMemberOf')
    'Set-MobileDeviceMailboxPolicy'      = @('Identity', 'AllowBluetooth', 'AllowBrowser', 'AllowCamera', 'AllowHTMLEmail', 'AllowNonProvisionableDevices', 'AllowPOPIMAPEmail', 'AllowSimplePassword', 'AllowStorageCard', 'AllowTextMessaging', 'AllowWiFi', 'AlphanumericPasswordRequired', 'AttachmentsEnabled', 'DeviceEncryptionEnabled', 'MaxPasswordFailedAttempts', 'MinPasswordComplexCharacters', 'MinPasswordLength', 'PasswordEnabled', 'PasswordHistory', 'PasswordRecoveryEnabled', 'RequireDeviceEncryption', 'RequireStorageCardEncryption')
    'Set-OfflineAddressBook'             = @('Identity', 'AddressLists')
    'Set-OutboundConnector'              = @('Identity', 'AllAcceptedDomains', 'CloudServicesMailEnabled', 'Comment', 'ConnectorSource', 'Enabled', 'IsTransportRuleScoped', 'RecipientDomains', 'RouteAllMessagesViaOnPremises', 'SenderRewritingEnabled', 'TestMode', 'UseMXRecord')
    'Set-QuarantinePolicy'               = @('Identity', 'ESNEnabled', 'EndUserSpamNotificationCustomFromAddress', 'EndUserSpamNotificationFrequencyInDays', 'IncludeMessagesFromBlockedSenderAddress', 'MultiLanguageCustomDisclaimer', 'MultiLanguageSenderName', 'MultiLanguageSetting', 'OrganizationBrandingEnabled')
    'Set-RetentionPolicy'                = @('Identity', 'RetentionPolicyTagLinks')
    'Set-RetentionPolicyTag'             = @('Identity', 'AgeLimitForRetention', 'Comment', 'RetentionAction', 'RetentionEnabled')
    'Set-SafeAttachmentRule'             = @('Identity', 'Comments', 'ExceptIfRecipientDomainIs', 'ExceptIfSentTo', 'ExceptIfSentToMemberOf', 'Priority', 'RecipientDomainIs', 'SentTo', 'SentToMemberOf')
    'Set-SafeLinksPolicy'                = @('Identity', 'AllowClickThrough', 'EnableSafeLinksForEmail', 'ScanUrls')
    'Set-SafeLinksRule'                  = @('Identity', 'Comments', 'ExceptIfRecipientDomainIs', 'ExceptIfSentTo', 'ExceptIfSentToMemberOf', 'Priority', 'RecipientDomainIs', 'SentTo', 'SentToMemberOf')
    'Set-TransportRule'                  = @('Identity', 'ActivationDate', 'AddToRecipients', 'ApplyHtmlDisclaimerFallbackAction', 'ApplyHtmlDisclaimerLocation', 'ApplyHtmlDisclaimerText', 'ApplyRightsProtectionTemplate', 'AttachmentExtensionMatchesWords', 'AttachmentHasExecutableContent', 'BlindCopyTo', 'Comments', 'DeleteMessage', 'ExceptIfFrom', 'ExceptIfRecipientDomainIs', 'ExceptIfSenderDomainIs', 'ExceptIfSenderIpRanges', 'ExceptIfSentTo', 'ExpiryDate', 'From', 'FromAddressContainsWords', 'FromScope', 'GenerateIncidentReport', 'HeaderContainsMessageHeader', 'HeaderContainsWords', 'Mode', 'ModerateMessageByUser', 'PrependSubject', 'Priority', 'Quarantine', 'RecipientDomainIs', 'RedirectMessageTo', 'RejectMessageEnhancedStatusCode', 'RejectMessageReasonText', 'RouteMessageOutboundConnector', 'RouteMessageOutboundRequireTls', 'RuleErrorAction', 'SenderAddressLocation', 'SenderDomainIs', 'SenderIpRanges', 'SentTo', 'SentToScope', 'SetHeaderName', 'SetHeaderValue', 'SetSCL', 'StopRuleProcessing', 'SubjectContainsWords', 'SubjectOrBodyContainsWords')
}

$AllowedPurviewWrites = @{
    'Set-ComplianceTag'             = @('Identity', 'Comment', 'Notes', 'RetentionDuration')
    'Set-DlpCompliancePolicy'       = @('Identity', 'Comment', 'Mode', 'Priority')
    'Set-DlpComplianceRule'         = @('Identity', 'BlockAccess', 'BlockAccessScope', 'Comment', 'Disabled', 'GenerateAlert', 'GenerateIncidentReport', 'IncidentReportContent', 'NotifyAllowOverride', 'NotifyEmailCustomText', 'NotifyPolicyTipCustomText', 'NotifyUser', 'NotifyUserType', 'Priority', 'ReportSeverityLevel', 'StopPolicyProcessing')
    'Set-RetentionCompliancePolicy' = @('Identity', 'Comment', 'Enabled')
    'Set-RetentionComplianceRule'   = @('Identity', 'Comment', 'ContentMatchQuery', 'ExpirationDateOption', 'RetentionComplianceAction', 'RetentionDuration', 'RetentionDurationDisplayHint')
}

$AllowedTeamsWrites = @{
    'New-CsCallingLineIdentity'                = @('Identity', 'BlockIncomingPstnCallerID', 'CallingIDSubstitute', 'CompanyName', 'Description', 'EnableUserOverride', 'ResourceAccount', 'ServiceNumber')
    'New-CsOnlineVoicemailPolicy'              = @('Identity', 'Description', 'EnableEditingCallAnswerRulesSetting', 'EnableTranscription', 'EnableTranscriptionProfanityMasking', 'EnableTranscriptionTranslation', 'PrimarySystemPromptLanguage', 'SecondarySystemPromptLanguage')
    'New-CsOnlineVoiceRoutingPolicy'           = @('Identity', 'Description', 'OnlinePstnUsages')
    'New-CsTeamsCallingPolicy'                 = @('Identity', 'AllowCallForwardingToPhone', 'AllowCallForwardingToUser', 'AllowCallGroups', 'AllowCallRedirect', 'AllowCloudRecordingForCalls', 'AllowDelegation', 'AllowPrivateCalling', 'AllowSIPDevicesCalling', 'AllowTranscriptionForCalling', 'AllowVoicemail', 'AllowWebPSTNCalling', 'AutoAnswerEnabledType', 'BusyOnBusyEnabledType', 'CallRecordingExpirationDays', 'Description', 'InboundFederatedCallRoutingTreatment', 'InboundPstnCallRoutingTreatment', 'LiveCaptionsEnabledTypeForCalling', 'MusicOnHoldEnabledType', 'PopoutAppPathForIncomingPstnCalls', 'PopoutForIncomingPstnCalls', 'PreventTollBypass', 'SpamFilteringEnabledType')
    'New-CsTeamsCallParkPolicy'                = @('Identity', 'AllowCallPark', 'Description', 'ParkTimeoutSeconds', 'PickupRangeEnd', 'PickupRangeStart')
    'New-CsTeamsEmergencyCallingPolicy'        = @('Identity', 'Description', 'EnhancedEmergencyServiceDisclaimer', 'ExternalLocationLookupMode', 'NotificationDialOutNumber', 'NotificationGroup', 'NotificationMode')
    'New-CsTeamsEmergencyCallRoutingPolicy'    = @('Identity', 'AllowEnhancedEmergencyServices', 'Description')
    'New-CsTeamsEventsPolicy'                  = @('Identity', 'AllowEmailEditing', 'AllowTownhalls', 'AllowWebinars', 'Description', 'EventAccessType', 'RecordingForTownhall', 'RecordingForWebinar', 'TownhallChatExperience', 'TownhallEventAttendeeAccess', 'TranscriptionForTownhall', 'TranscriptionForWebinar', 'UseMicrosoftECDN')
    'New-CsTeamsMeetingBroadcastPolicy'        = @('Identity', 'AllowBroadcastScheduling', 'AllowBroadcastTranscription', 'BroadcastAttendeeVisibilityMode', 'BroadcastRecordingMode', 'Description')
    'New-CsTeamsMessagingPolicy'               = @('Identity', 'AllowCommunicationComplianceEndUserReporting', 'AllowFullChatPermissionUserToDeleteAnyMessage', 'AllowGiphy', 'AllowGiphyDisplay', 'AllowGroupChatJoinLinks', 'AllowImmersiveReader', 'AllowMemes', 'AllowOwnerDeleteMessage', 'AllowPasteInternetImage', 'AllowPriorityMessages', 'AllowRemoveUser', 'AllowSecurityEndUserReporting', 'AllowSmartCompose', 'AllowSmartReply', 'AllowStickers', 'AllowUrlPreviews', 'AllowUserChat', 'AllowUserDeleteChat', 'AllowUserDeleteMessage', 'AllowUserEditMessage', 'AllowUserTranslation', 'AllowVideoMessages', 'AudioMessageEnabledType', 'ChannelsInChatListEnabledType', 'ChatPermissionRole', 'Description', 'GiphyRatingType', 'ReadReceiptsEnabledType')
    'New-CsTenantDialPlan'                     = @('Identity', 'Description', 'ExternalAccessPrefix', 'OptimizeDeviceDialing', 'SimpleName')
    'Set-CsCallingLineIdentity'                = @('Identity', 'BlockIncomingPstnCallerID', 'CallingIDSubstitute', 'CompanyName', 'Description', 'EnableUserOverride', 'ResourceAccount', 'ServiceNumber')
    'Set-CsOnlineVoicemailPolicy'              = @('Identity', 'Description', 'EnableEditingCallAnswerRulesSetting', 'EnableTranscription', 'EnableTranscriptionProfanityMasking', 'EnableTranscriptionTranslation', 'PrimarySystemPromptLanguage', 'SecondarySystemPromptLanguage')
    'Set-CsOnlineVoiceRoutingPolicy'           = @('Identity', 'Description', 'OnlinePstnUsages')
    'Set-CsTeamsCallingPolicy'                 = @('Identity', 'AllowCallForwardingToPhone', 'AllowCallForwardingToUser', 'AllowCallGroups', 'AllowCallRedirect', 'AllowCloudRecordingForCalls', 'AllowDelegation', 'AllowPrivateCalling', 'AllowSIPDevicesCalling', 'AllowTranscriptionForCalling', 'AllowVoicemail', 'AllowWebPSTNCalling', 'AutoAnswerEnabledType', 'BusyOnBusyEnabledType', 'CallRecordingExpirationDays', 'Description', 'InboundFederatedCallRoutingTreatment', 'InboundPstnCallRoutingTreatment', 'LiveCaptionsEnabledTypeForCalling', 'MusicOnHoldEnabledType', 'PopoutAppPathForIncomingPstnCalls', 'PopoutForIncomingPstnCalls', 'PreventTollBypass', 'SpamFilteringEnabledType')
    'Set-CsTeamsCallParkPolicy'                = @('Identity', 'AllowCallPark', 'Description', 'ParkTimeoutSeconds', 'PickupRangeEnd', 'PickupRangeStart')
    'Set-CsTeamsClientConfiguration'           = @('Identity', 'AllowBox', 'AllowDropBox', 'AllowEgnyte', 'AllowEmailIntoChannel', 'AllowGoogleDrive', 'AllowGuestUser', 'AllowOrganizationTab', 'AllowResourceAccountSendMessage', 'AllowRoleBasedChatPermissions', 'AllowScopedPeopleSearchandAccess', 'AllowShareFile', 'AllowSkypeBusinessInterop', 'ContentPin', 'ResourceAccountContentAccess', 'RestrictedSenderList')
    'Set-CsTeamsEmergencyCallingPolicy'        = @('Identity', 'Description', 'EnhancedEmergencyServiceDisclaimer', 'ExternalLocationLookupMode', 'NotificationDialOutNumber', 'NotificationGroup', 'NotificationMode')
    'Set-CsTeamsEmergencyCallRoutingPolicy'    = @('Identity', 'AllowEnhancedEmergencyServices', 'Description')
    'Set-CsTeamsEventsPolicy'                  = @('Identity', 'AllowEmailEditing', 'AllowTownhalls', 'AllowWebinars', 'Description', 'EventAccessType', 'RecordingForTownhall', 'RecordingForWebinar', 'TownhallChatExperience', 'TownhallEventAttendeeAccess', 'TranscriptionForTownhall', 'TranscriptionForWebinar', 'UseMicrosoftECDN')
    'Set-CsTeamsGuestCallingConfiguration'     = @('Identity', 'AllowPrivateCalling')
    'Set-CsTeamsGuestMeetingConfiguration'     = @('Identity', 'AllowIPVideo', 'AllowMeetNow', 'AllowTranscription', 'LiveCaptionsEnabledType')
    'Set-CsTeamsGuestMessagingConfiguration'   = @('Identity', 'AllowGiphy', 'AllowImmersiveReader', 'AllowMemes', 'AllowStickers', 'AllowUserChat', 'AllowUserDeleteChat', 'AllowUserDeleteMessage', 'AllowUserEditMessage', 'GiphyRatingType')
    'Set-CsTeamsMeetingBroadcastConfiguration' = @('Identity', 'AllowSdnProviderForBroadcastMeeting', 'SupportURL')
    'Set-CsTeamsMeetingBroadcastPolicy'        = @('Identity', 'AllowBroadcastScheduling', 'AllowBroadcastTranscription', 'BroadcastAttendeeVisibilityMode', 'BroadcastRecordingMode', 'Description')
    'Set-CsTeamsMessagingPolicy'               = @('Identity', 'AllowCommunicationComplianceEndUserReporting', 'AllowFullChatPermissionUserToDeleteAnyMessage', 'AllowGiphy', 'AllowGiphyDisplay', 'AllowGroupChatJoinLinks', 'AllowImmersiveReader', 'AllowMemes', 'AllowOwnerDeleteMessage', 'AllowPasteInternetImage', 'AllowPriorityMessages', 'AllowRemoveUser', 'AllowSecurityEndUserReporting', 'AllowSmartCompose', 'AllowSmartReply', 'AllowStickers', 'AllowUrlPreviews', 'AllowUserChat', 'AllowUserDeleteChat', 'AllowUserDeleteMessage', 'AllowUserEditMessage', 'AllowUserTranslation', 'AllowVideoMessages', 'AudioMessageEnabledType', 'ChannelsInChatListEnabledType', 'ChatPermissionRole', 'Description', 'GiphyRatingType', 'ReadReceiptsEnabledType')
    'Set-CsTenantDialPlan'                     = @('Identity', 'Description', 'ExternalAccessPrefix', 'OptimizeDeviceDialing', 'SimpleName')
    'Set-CsTenantFederationConfiguration'      = @('Identity', 'AllowTeamsConsumer', 'AllowTeamsConsumerInbound', 'BlockAllSubdomains', 'ExternalAccessWithTrialTenants', 'RestrictTeamsConsumerToExternalUserProfiles')
}

# Task-106: OneDrive site-level settings through PnP, one named site at a time.
# No file, folder or list-item cmdlet is allowed.
$AllowedPnP = @{
    'Get-PnPTenantSite' = @('Identity')
}

# SharePoint structure (engine/collect/workloads/sharepointStructure.mjs). Hub sites, site
# designs and site scripts are read on the admin site; a site template is read on the one
# site the job names. Reads only. -Url never reaches the cmdlet: it names the site to
# connect to, and must be the tenant root or a /sites/ or /teams/ site collection root on
# the tenant's own host (Get-KeelSiteUrl). The template handlers are fixed here, never
# taken from the job: structure only, no Files, Pages, PageContents, TermGroups,
# PropertyBagEntries, Publishing or SiteSecurity (people and permissions are backed up elsewhere,
# and a restore must never send them).
$AllowedPnPStructure = @{
    'Get-PnPHubSite'      = @()
    'Get-PnPSiteDesign'   = @()
    'Get-PnPSiteScript'   = @('Identity')
    'Get-PnPSiteTemplate' = @('Url')
}
$SiteTemplateHandlers = 'Fields, ContentTypes, Lists, Navigation, Features, RegionalSettings, SupportedUILanguages, WebSettings, SiteHeader, SiteFooter, CustomActions'

# SharePoint structure restore (engine/restore/workloads/sharepointStructure.mjs and
# sharepointStructureWrites.mjs, which hold the same list). Nothing here deletes: no
# Remove-, Unregister-, Revoke- or Grant- cmdlet. Invoke-PnPSiteTemplate connects to the
# one site in -Url (a site collection root on the tenant host) and applies the template
# KEEL built (-TemplateGzip, gzip and base64) with the handlers fixed below. The template
# may hold only the PnP elements in $RestoreTemplateElements: never list items, files,
# pages, permissions, webhooks, custom actions, property bags or features.
$AllowedPnPStructureWrites = @{
    'Invoke-PnPSiteTemplate' = @('TemplateGzip', 'Url')
    'Register-PnPHubSite'    = @('Site')
    'Set-PnPHubSite'         = @('Description', 'HideNameInNavigation', 'Identity', 'LogoUrl', 'RequiresJoinApproval', 'SiteDesignId', 'Title')
    'Add-PnPSiteScript'      = @('Content', 'Description', 'Title')
    'Set-PnPSiteScript'      = @('Content', 'Description', 'Identity', 'Title')
    'Add-PnPSiteDesign'      = @('Description', 'IsDefault', 'PreviewImageAltText', 'PreviewImageUrl', 'SiteScriptIds', 'Title', 'WebTemplate')
    'Set-PnPSiteDesign'      = @('Description', 'Identity', 'IsDefault', 'PreviewImageAltText', 'PreviewImageUrl', 'SiteScriptIds', 'Title', 'WebTemplate')
}
$RestoreTemplateHandlers = 'Fields, ContentTypes, Lists, Navigation'
$RestoreTemplateElements = @(
    'Provisioning', 'Preferences', 'Templates', 'ProvisioningTemplate',
    'SiteFields', 'ContentTypes', 'ContentType', 'FieldRefs', 'FieldRef',
    'Lists', 'ListInstance', 'ContentTypeBindings', 'ContentTypeBinding', 'Views', 'Fields', 'FieldDefaults', 'FieldDefault', 'Folders', 'Folder',
    'Navigation', 'GlobalNavigation', 'CurrentNavigation', 'StructuralNavigation', 'NavigationNode'
)
$MaxTemplateGzipChars = 100000

# The site a template job connects to, normalized, or $null when it is not a site
# collection root on the host of the configured admin site (contoso-admin.sharepoint.com
# gives contoso.sharepoint.com).
function Get-KeelSiteUrl {
    param([string]$Value, [string]$AdminUrl)
    $admin = $null
    if (-not [uri]::TryCreate($AdminUrl, [UriKind]::Absolute, [ref]$admin)) { return $null }
    $adminHost = $admin.Host.ToLowerInvariant()
    if (-not $adminHost.EndsWith('-admin.sharepoint.com')) { return $null }
    $tenantHost = $adminHost.Substring(0, $adminHost.Length - '-admin.sharepoint.com'.Length) + '.sharepoint.com'
    if ($tenantHost -notmatch '^[a-z0-9-]+\.sharepoint\.com$') { return $null }
    $uri = $null
    if (-not [uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) { return $null }
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne $tenantHost -or $uri.Query -or $uri.Fragment -or $uri.UserInfo -or -not $uri.IsDefaultPort) { return $null }
    $path = $uri.AbsolutePath.TrimEnd('/')
    if ($path -ne '' -and $path -notmatch '^/(sites|teams)/[A-Za-z0-9_.-]+$') { return $null }
    return "https://$tenantHost$path"
}

function Out-Envelope {
    param([hashtable]$Envelope, [int]$Code)
    # Depth 16: below that, ConvertTo-Json flattens deeper nested settings (DLP
    # sensitive information type groups, say) to type-name strings. Shallower answers
    # serialize the same at either depth. When ConvertTo-Json throws (unloaded PnP
    # collections, #638; non-string dictionary keys in Purview answers, Q179),
    # ConvertTo-KeelJson writes a plain copy instead (keel-json.ps1).
    [Console]::Out.WriteLine((ConvertTo-KeelJson -Value $Envelope -Depth 16))
    exit $Code
}

function Out-Failure {
    param([string]$Message, [string]$Category = $null, [string]$ErrorId = $null)
    Out-Envelope -Envelope @{ ok = $false; error = @{ message = $Message; category = $Category; errorId = $ErrorId } } -Code 1
}

# The certificate re-imported through PKCS12, exactly as probe-workloads.ps1
# (Get-KeelCertificate) builds it: CreateFromPemFile's ephemeral key does not survive
# every .NET crypto provider on Linux. Used by the Teams session, whose live proof
# comes from the probe, so the collector signs in the same way. Nothing is written to disk.
function ConvertTo-KeelPkcs12Certificate {
    param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Raw)
    $password = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
    $bytes = $Raw.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12, $password)
    $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor `
        [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes, $password, $flags)
}

try {
    $job = $env:KEEL_JOB_JSON | ConvertFrom-Json -AsHashtable
} catch {
    Out-Failure -Message "job descriptor is not valid JSON: $($_.Exception.Message)" -ErrorId 'BadDescriptor'
}

$name = [string]$job['cmdlet']
$module = [string]$job['module']
# Each cmdlet belongs to exactly one session, and the job's module must match it.
if ($Allowed.ContainsKey($name) -and $module -eq 'ExchangeOnlineManagement') { $session = 'exo'; $permitted = $Allowed[$name] }
elseif ($AllowedMailFlow.ContainsKey($name) -and $module -eq 'ExchangeOnlineManagement') { $session = 'exo'; $permitted = $AllowedMailFlow[$name] }
elseif ($AllowedExchangeExtended.ContainsKey($name) -and $module -eq 'ExchangeOnlineManagement') { $session = 'exo'; $permitted = $AllowedExchangeExtended[$name] }
elseif ($AllowedExchangeRoleGroups.ContainsKey($name) -and $module -eq 'ExchangeOnlineManagement') { $session = 'exo'; $permitted = $AllowedExchangeRoleGroups[$name] }
elseif ($AllowedPurview.ContainsKey($name) -and $module -eq 'ExchangeOnlineManagement') { $session = 'ipps'; $permitted = $AllowedPurview[$name] }
elseif ($AllowedPurviewRetentionDlp.ContainsKey($name) -and $module -eq 'ExchangeOnlineManagement') { $session = 'ipps'; $permitted = $AllowedPurviewRetentionDlp[$name] }
elseif ($AllowedPnP.ContainsKey($name) -and $module -eq 'PnP.PowerShell') { $session = 'pnp'; $permitted = $AllowedPnP[$name] }
elseif ($AllowedPnPStructure.ContainsKey($name) -and $module -eq 'PnP.PowerShell') { $session = 'pnp'; $permitted = $AllowedPnPStructure[$name] }
elseif ($AllowedPnPStructureWrites.ContainsKey($name) -and $module -eq 'PnP.PowerShell') { $session = 'pnp'; $permitted = $AllowedPnPStructureWrites[$name] }
elseif ($AllowedTeamsPolicy.ContainsKey($name) -and $module -eq 'MicrosoftTeams') { $session = 'teams'; $permitted = $AllowedTeamsPolicy[$name] }
elseif ($AllowedTeamsExtended.ContainsKey($name) -and $module -eq 'MicrosoftTeams') { $session = 'teams'; $permitted = $AllowedTeamsExtended[$name] }
elseif ($AllowedPurviewExtended.ContainsKey($name) -and $module -eq 'ExchangeOnlineManagement') { $session = 'ipps'; $permitted = $AllowedPurviewExtended[$name] }
elseif ($AllowedExchangeWrites.ContainsKey($name) -and $module -eq 'ExchangeOnlineManagement') { $session = 'exo'; $permitted = $AllowedExchangeWrites[$name] }
elseif ($AllowedPurviewWrites.ContainsKey($name) -and $module -eq 'ExchangeOnlineManagement') { $session = 'ipps'; $permitted = $AllowedPurviewWrites[$name] }
elseif ($AllowedTeamsWrites.ContainsKey($name) -and $module -eq 'MicrosoftTeams') { $session = 'teams'; $permitted = $AllowedTeamsWrites[$name] }
else { Out-Failure -Message "cmdlet $name is not allowed" -ErrorId 'CmdletNotAllowed' }
$params = @{}
if ($null -ne $job['parameters']) {
    foreach ($key in $job['parameters'].Keys) {
        if ($permitted -notcontains $key) { Out-Failure -Message "parameter $key is not allowed for $name" -ErrorId 'ParameterNotAllowed' }
        $value = $job['parameters'][$key]
        if ($value -is [System.Collections.IDictionary]) { Out-Failure -Message "parameter $key must be a scalar" -ErrorId 'ParameterNotScalar' }
        $params[$key] = $value
    }
}

$tenantConfigPath = if ($job['tenantConfigPath']) { [string]$job['tenantConfigPath'] } else { '/etc/keel/tenant.json' }
try {
    $config = Get-Content -Raw -Path $tenantConfigPath | ConvertFrom-Json
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($config.certPath, $config.keyPath)
} catch {
    Out-Failure -Message "could not read the connection settings: $($_.Exception.Message)" -Category 'ConnectionError' -ErrorId 'ConnectFailed'
}

# A template is read (or applied) on its own site; everything else in the PnP session on the admin site.
$pnpUrl = $config.sharePointAdminUrl
if ($name -eq 'Get-PnPSiteTemplate') {
    $pnpUrl = Get-KeelSiteUrl -Value ([string]$params['Url']) -AdminUrl ([string]$config.sharePointAdminUrl)
    if (-not $pnpUrl) { Out-Failure -Message "the site is not a site collection root on this tenant's SharePoint host" -ErrorId 'SiteNotAllowed' }
    $params.Remove('Url')
    $params['Handlers'] = $SiteTemplateHandlers
}
# The restore template is applied on its own site, from a temporary file, with fixed handlers.
$templateFile = $null
if ($name -eq 'Invoke-PnPSiteTemplate') {
    $pnpUrl = Get-KeelSiteUrl -Value ([string]$params['Url']) -AdminUrl ([string]$config.sharePointAdminUrl)
    if (-not $pnpUrl) { Out-Failure -Message "the site is not a site collection root on this tenant's SharePoint host" -ErrorId 'SiteNotAllowed' }
    $encoded = [string]$params['TemplateGzip']
    if (-not $encoded -or $encoded.Length -gt $MaxTemplateGzipChars) { Out-Failure -Message 'the template is missing or too large' -ErrorId 'TemplateNotAllowed' }
    try {
        $raw = [System.IO.MemoryStream]::new([Convert]::FromBase64String($encoded))
        $gzip = [System.IO.Compression.GZipStream]::new($raw, [System.IO.Compression.CompressionMode]::Decompress)
        $xml = [System.IO.StreamReader]::new($gzip, [System.Text.Encoding]::UTF8).ReadToEnd()
    } catch {
        Out-Failure -Message 'the template is not gzip and base64' -ErrorId 'TemplateNotAllowed'
    }
    if ($xml -notmatch '<pnp:ProvisioningTemplate\b') { Out-Failure -Message 'the template is not a PnP template' -ErrorId 'TemplateNotAllowed' }
    foreach ($match in [regex]::Matches($xml, '</?pnp:([A-Za-z]+)')) {
        if ($RestoreTemplateElements -notcontains $match.Groups[1].Value) {
            Out-Failure -Message "the template carries pnp:$($match.Groups[1].Value), which KEEL never sends" -ErrorId 'TemplateNotAllowed'
        }
    }
    # The PnP namespace only ever as pnp:, and no DTD: no PnP element can hide under another prefix.
    if ($xml -match '<!DOCTYPE|<!ENTITY') { Out-Failure -Message 'the template carries a DTD, which KEEL never sends' -ErrorId 'TemplateNotAllowed' }
    foreach ($match in [regex]::Matches($xml, '\bxmlns(:[A-Za-z0-9_.-]+)?\s*=\s*["'']([^"'']*)["'']')) {
        if ($match.Groups[2].Value -match 'schemas\.dev\.office\.com/PnP' -and $match.Groups[1].Value -ne ':pnp') {
            Out-Failure -Message 'the template binds the PnP namespace to a prefix other than pnp:, which KEEL never sends' -ErrorId 'TemplateNotAllowed'
        }
    }
    # The file is written just before the cmdlet runs, in the try whose finally removes it.
    $templateXml = $xml
    $templateFile = Join-Path ([System.IO.Path]::GetTempPath()) ("keel-restore-" + [guid]::NewGuid().ToString('N') + '.xml')
    $params = @{ Path = $templateFile; Handlers = $RestoreTemplateHandlers }
}
# A hub is named by its site, which must be a site collection root on the tenant host.
if ($name -eq 'Register-PnPHubSite' -or $name -eq 'Set-PnPHubSite') {
    $key = if ($name -eq 'Register-PnPHubSite') { 'Site' } else { 'Identity' }
    $hubUrl = Get-KeelSiteUrl -Value ([string]$params[$key]) -AdminUrl ([string]$config.sharePointAdminUrl)
    if (-not $hubUrl) { Out-Failure -Message "the hub is not a site collection root on this tenant's SharePoint host" -ErrorId 'SiteNotAllowed' }
    $params[$key] = $hubUrl
}

try {
    if ($session -eq 'pnp') {
        # PnP is never loaded beside ExchangeOnlineManagement (see probe-workloads.ps1).
        Import-Module PnP.PowerShell -ErrorAction Stop | Out-Null
        $pfx = [Convert]::ToBase64String($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx))
        Connect-PnPOnline -Url $pnpUrl -ClientId $config.clientId -Tenant $config.organization -CertificateBase64Encoded $pfx | Out-Null
    } elseif ($session -eq 'teams') {
        # Same app-only connection as the probe (probe-workloads.ps1, Teams block),
        # including its PKCS12 round trip of the certificate.
        Import-Module MicrosoftTeams -ErrorAction Stop | Out-Null
        $teamsCert = ConvertTo-KeelPkcs12Certificate -Raw $cert
        Connect-MicrosoftTeams -Certificate $teamsCert -ApplicationId $config.clientId -TenantId $config.tenantId | Out-Null
    } else {
        Import-Module ExchangeOnlineManagement -ErrorAction Stop | Out-Null
        if ($session -eq 'ipps') {
            Connect-IPPSSession -AppId $config.clientId -Organization $config.organization -Certificate $cert -ShowBanner:$false | Out-Null
        } else {
            Connect-ExchangeOnline -AppId $config.clientId -Organization $config.organization -Certificate $cert -ShowBanner:$false -ShowProgress:$false | Out-Null
        }
    }
} catch {
    Out-Failure -Message "could not connect ($session): $($_.Exception.Message)" -Category 'ConnectionError' -ErrorId 'ConnectFailed'
}

try {
    if ($templateFile) { Set-Content -Path $templateFile -Value $templateXml -Encoding utf8 -NoNewline }
    # Warnings from the module's own functions ignore this script's $WarningPreference and
    # would land on stdout ahead of the envelope (Get-LabelPolicy: "Force Validate not set").
    $output = & $name @params -ErrorAction Stop 3>$null
    Out-Envelope -Envelope @{ ok = $true; output = @($output) } -Code 0
} catch {
    $record = $_
    Out-Failure -Message $record.Exception.Message -Category ([string]$record.CategoryInfo.Category) -ErrorId ([string]$record.FullyQualifiedErrorId)
} finally {
    if ($templateFile) { Remove-Item -LiteralPath $templateFile -Force -ErrorAction SilentlyContinue }
    if ($session -eq 'pnp') { try { Disconnect-PnPOnline -ErrorAction SilentlyContinue | Out-Null } catch {} }
    elseif ($session -eq 'teams') { try { Disconnect-MicrosoftTeams -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {} }
    else { try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {} }
}
