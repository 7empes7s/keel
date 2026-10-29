# TCM snapshot probe (run)

Generated 2026-10-29. Graph v1.0. Masked: types, counts and property names only.

## Summary

| Measure | Value |
| --- | --- |
| Resources extracted (counts against 20000 a month) | 1724 |
| Types requested | 168 |
| Types with data | 105 |
| Types refused at create | 21 |
| Types not sent (no room for another job) | 0 |
| Types empty | 42 |
| Jobs deleted / not deleted | 5 / 0 |

## Types KEEL does not read that returned data (best first)

| Type | Tier | Count |
| --- | --- | --- |
| microsoft.exchange.recipientpermission | 1 | 358 |
| microsoft.exchange.mailboxpermission | 1 | 88 |
| microsoft.exchange.calendarprocessing | 1 | 57 |
| microsoft.exchange.mailboxcalendarfolder | 1 | 57 |
| microsoft.exchange.place | 1 | 11 |
| microsoft.exchange.sharedmailbox | 1 | 7 |
| microsoft.exchange.distributiongroup | 1 | 6 |
| microsoft.exchange.mailcontact | 1 | 2 |
| microsoft.exchange.dataclassification | 2 | 226 |
| microsoft.exchange.groupsettings | 2 | 13 |
| microsoft.securityandcompliance.fileplanpropertycategory | 2 | 13 |
| microsoft.securityandcompliance.fileplanpropertydepartment | 2 | 10 |
| microsoft.securityandcompliance.fileplanpropertycitation | 2 | 5 |
| microsoft.exchange.casmailboxplan | 2 | 4 |
| microsoft.exchange.mailboxplan | 2 | 4 |
| microsoft.exchange.sharingpolicy | 2 | 3 |
| microsoft.securityandcompliance.fileplanpropertyauthority | 2 | 3 |
| microsoft.securityandcompliance.retentioneventtype | 2 | 3 |
| microsoft.exchange.owamailboxpolicy | 2 | 2 |
| microsoft.exchange.irmconfiguration | 2 | 1 |
| microsoft.exchange.mailtips | 2 | 1 |
| microsoft.exchange.omeconfiguration | 2 | 1 |
| microsoft.exchange.perimeterconfiguration | 2 | 1 |
| microsoft.exchange.reportsubmissionpolicy | 2 | 1 |
| microsoft.exchange.roleassignmentpolicy | 2 | 1 |
| microsoft.exchange.transportconfig | 2 | 1 |
| microsoft.teams.upgradepolicy | 3 | 11 |
| microsoft.teams.feedbackpolicy | 3 | 4 |
| microsoft.teams.enhancedencryptionpolicy | 3 | 3 |
| microsoft.teams.channelspolicy | 3 | 2 |
| microsoft.teams.mobilitypolicy | 3 | 2 |
| microsoft.teams.shiftspolicy | 3 | 2 |
| microsoft.teams.updatemanagementpolicy | 3 | 2 |
| microsoft.teams.audioconferencingpolicy | 3 | 1 |
| microsoft.teams.callholdpolicy | 3 | 1 |
| microsoft.teams.compliancerecordingpolicy | 3 | 1 |
| microsoft.teams.cortanapolicy | 3 | 1 |
| microsoft.teams.dialinconferencingtenantsettings | 3 | 1 |
| microsoft.teams.filespolicy | 3 | 1 |
| microsoft.teams.ipphonepolicy | 3 | 1 |
| microsoft.teams.meetingconfiguration | 3 | 1 |
| microsoft.teams.networkroamingpolicy | 3 | 1 |
| microsoft.teams.templatespolicy | 3 | 1 |
| microsoft.teams.upgradeconfiguration | 3 | 1 |
| microsoft.teams.vdipolicy | 3 | 1 |
| microsoft.teams.voiceroute | 3 | 1 |
| microsoft.teams.workloadpolicy | 3 | 1 |
| microsoft.teams.onlinevoiceuser | 4 | 24 |

## Jobs

| Workload | Types | Status | Seconds | Errors | Download | Resources |
| --- | --- | --- | --- | --- | --- | --- |
| exchange | 66 | partiallySuccessful | 371 | 4 | 200 (graph) | 1345 |
| exchange | 10 | refused 400: BadRequest: One or more validation errors occurred.: ResourceType 'microsoft.exchange.addressbookpolicy' is not supported.: ResourceType 'microsoft.exchange.addresslist' is not supported.: ResourceType 'microsoft.exchange.applicationaccesspolicy' is not supported.: ResourceType 'microsoft.exchange.clientaccessrule' is not supported.: ResourceType 'microsoft.exchange.eopprotectionpolicyrule' is not | | | | |
| securityandcompliance | 24 | partiallySuccessful | 201 | 8 | 200 (graph) | 48 |
| securityandcompliance | 4 | refused 400: BadRequest: One or more validation errors occurred.: ResourceType 'microsoft.securityandcompliance.auditconfigurationpolicy' is not supported.: ResourceType 'microsoft.securityandcompliance.autosensitivitylabelrule' is not supported.: ResourceType 'microsoft.securityandcompliance.dlpcompliancerule' is not supported.: ResourceType 'microsoft.securityandcompliance.sensitivitylabel' is not supported. | | | | |
| teams | 51 | succeeded | 155 | 0 | 200 (graph) | 291 |
| teams | 7 | refused 400: BadRequest: One or more validation errors occurred.: ResourceType 'microsoft.teams.channel' is not supported.: ResourceType 'microsoft.teams.channeltab' is not supported.: ResourceType 'microsoft.teams.onlinevoicemailusersettings' is not supported.: ResourceType 'microsoft.teams.orgwideappsettings' is not supported.: ResourceType 'microsoft.teams.usercallingsettings' is not supported.: ResourceTyp | | | | |
| entra | 3 | succeeded | 93 | 0 | 200 (graph) | 28 |
| intune | 3 | partiallySuccessful | 155 | 1 | 200 (graph) | 12 |

## Job error details (first 40 per job)

- exchange: microsoft.exchange.availabilityaddressspace: Error exporting resource [microsoft.exchange.availabilityaddressspace]. exceptionMessage(s):The term 'Get-AvailabilityAddressSpace' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again. ,
- exchange: microsoft.exchange.resourceconfiguration: Error exporting resource [microsoft.exchange.resourceconfiguration]. exceptionMessage(s):Error during Export: The term 'Get-ResourceConfig' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again. ,
- exchange: microsoft.exchange.availabilityconfig: Error exporting resource [microsoft.exchange.availabilityconfig]. exceptionMessage(s):The term 'Get-AvailabilityConfig' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again. ,
- exchange: microsoft.exchange.emailaddresspolicy: Error exporting resource [microsoft.exchange.emailaddresspolicy]. exceptionMessage(s):The term 'Get-EmailAddressPolicy' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again. ,
- securityandcompliance: microsoft.securityandcompliance.supervisoryreviewrule: Error exporting resource [microsoft.securityandcompliance.supervisoryreviewrule]. exceptionMessage(s):Error during Export: The term 'Get-SupervisoryReviewRule' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try
- securityandcompliance: microsoft.securityandcompliance.compliancecase: Error exporting resource [microsoft.securityandcompliance.compliancecase]. exceptionMessage(s):Error during Export: The term 'Get-ComplianceCase' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again. ,
- securityandcompliance: microsoft.securityandcompliance.securityfilter: Error exporting resource [microsoft.securityandcompliance.securityfilter]. exceptionMessage(s):Error during Export: The term 'Get-ComplianceSecurityFilter' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again. ,
- securityandcompliance: microsoft.securityandcompliance.supervisoryreviewpolicy: Error exporting resource [microsoft.securityandcompliance.supervisoryreviewpolicy]. exceptionMessage(s):Error during Export: The term 'Get-SupervisoryReviewPolicyV2' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct
- securityandcompliance: microsoft.securityandcompliance.caseholdpolicy: Error exporting resource [microsoft.securityandcompliance.caseholdpolicy]. exceptionMessage(s):Error during Export: The term 'Get-ComplianceCase' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again. ,
- securityandcompliance: microsoft.securityandcompliance.compliancesearch: Error exporting resource [microsoft.securityandcompliance.compliancesearch]. exceptionMessage(s):Error during Export: The term 'Get-ComplianceSearch' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again. ,
- securityandcompliance: microsoft.securityandcompliance.caseholdrule: Error exporting resource [microsoft.securityandcompliance.caseholdrule]. exceptionMessage(s):Error during Export: The term 'Get-CaseHoldRule' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and try again. ,
- securityandcompliance: microsoft.securityandcompliance.compliancesearchaction: Error exporting resource [microsoft.securityandcompliance.compliancesearchaction]. exceptionMessage(s):Error during Export: The term 'Get-ComplianceSearchAction' is not recognized as a name of a cmdlet, function, script file, or executable program.
Check the spelling of the name, or if a path was included, verify that the path is correct and 
- intune: microsoft.intune.devicecategory: Error exporting resource [microsoft.intune.devicecategory]. exceptionMessage(s):Error during Export: [Forbidden] : {
  "_version": 3,
  "Message": "Application is not authorized to perform this operation. Application must have one of the following scopes: DeviceManagementManagedDevices.Read.All, DeviceManagementManagedDevices.ReadWrite.All - Operation ID (for cus

## Types refused at create

microsoft.exchange.addressbookpolicy, microsoft.exchange.addresslist, microsoft.exchange.applicationaccesspolicy, microsoft.exchange.clientaccessrule, microsoft.exchange.eopprotectionpolicyrule, microsoft.exchange.externalinoutlook, microsoft.exchange.globaladdresslist, microsoft.exchange.managementroleentry, microsoft.exchange.offlineaddressbook, microsoft.exchange.sweeprule, microsoft.securityandcompliance.auditconfigurationpolicy, microsoft.securityandcompliance.autosensitivitylabelrule, microsoft.securityandcompliance.dlpcompliancerule, microsoft.securityandcompliance.sensitivitylabel, microsoft.teams.channel, microsoft.teams.channeltab, microsoft.teams.onlinevoicemailusersettings, microsoft.teams.orgwideappsettings, microsoft.teams.team, microsoft.teams.usercallingsettings, microsoft.teams.userpolicyassignment

## Types with no data

microsoft.exchange.activesyncdeviceaccessrule, microsoft.exchange.antiphishrule, microsoft.exchange.authenticationpolicy, microsoft.exchange.authenticationpolicyassignment, microsoft.exchange.availabilityaddressspace, microsoft.exchange.availabilityconfig, microsoft.exchange.dataencryptionpolicy, microsoft.exchange.emailaddresspolicy, microsoft.exchange.hostedcontentfilterrule, microsoft.exchange.hostedoutboundspamfilterrule, microsoft.exchange.intraorganizationconnector, microsoft.exchange.journalrule, microsoft.exchange.messageclassification, microsoft.exchange.onpremisesorganization, microsoft.exchange.organizationrelationship, microsoft.exchange.partnerapplication, microsoft.exchange.policytipconfig, microsoft.exchange.reportsubmissionrule, microsoft.exchange.resourceconfiguration, microsoft.intune.devicecategory, microsoft.securityandcompliance.autosensitivitylabelpolicy, microsoft.securityandcompliance.caseholdpolicy, microsoft.securityandcompliance.caseholdrule, microsoft.securityandcompliance.compliancecase, microsoft.securityandcompliance.compliancesearch, microsoft.securityandcompliance.compliancesearchaction, microsoft.securityandcompliance.deviceconditionalaccesspolicy, microsoft.securityandcompliance.deviceconfigurationpolicy, microsoft.securityandcompliance.fileplanpropertyreferenceid, microsoft.securityandcompliance.fileplanpropertysubcategory, microsoft.securityandcompliance.securityfilter, microsoft.securityandcompliance.supervisoryreviewpolicy, microsoft.securityandcompliance.supervisoryreviewrule, microsoft.teams.callqueue, microsoft.teams.grouppolicyassignment, microsoft.teams.pstnusage, microsoft.teams.tenantnetworkregion, microsoft.teams.tenantnetworksite, microsoft.teams.tenantnetworksubnet, microsoft.teams.tenanttrustedipaddress, microsoft.teams.translationrule, microsoft.teams.unassignednumbertreatment

## Snapshot format

- exchange: envelope keys @odata.context, description, displayName, id, parameters, resources; item keys displayName, properties, resourceType, resourceVersion
- securityandcompliance: envelope keys @odata.context, description, displayName, id, parameters, resources; item keys displayName, properties, resourceType, resourceVersion
- teams: envelope keys @odata.context, description, displayName, id, parameters, resources; item keys displayName, properties, resourceType, resourceVersion
- entra: envelope keys @odata.context, description, displayName, id, parameters, resources; item keys displayName, properties, resourceType, resourceVersion
- intune: envelope keys @odata.context, description, displayName, id, parameters, resources; item keys displayName, properties, resourceType, resourceVersion

## Per type

| Type | Count | Properties | First properties |
| --- | --- | --- | --- |
| microsoft.exchange.accepteddomain | 3 | 5 | DomainType, Ensure, Identity, MatchSubDomains, OutboundOnly |
| microsoft.exchange.antiphishpolicy | 4 | 38 | AdminDisplayName, AuthenticationFailAction, DmarcQuarantineAction, DmarcRejectAction, EnableFirstContactSafetyTips, EnableMailboxIntelligence, EnableMailboxIntelligenceProtection, EnableOrganizationDomainsProtection, EnableSimilarDomainsSafetyTips, EnableSimilarUsersSafetyTips, EnableSpoofIntelligence, EnableTargetedDomainsProtection, … |
| microsoft.exchange.atppolicyforo365 | 1 | 5 | AllowSafeDocsOpen, EnableATPForSPOTeamsODB, EnableSafeDocs, Identity, IsSingleInstance |
| microsoft.exchange.calendarprocessing | 57 | 44 | AddAdditionalResponse, AddNewRequestsTentatively, AddOrganizerToSubject, AllBookInPolicy, AllRequestInPolicy, AllRequestOutOfPolicy, AllowConflicts, AllowRecurringMeetings, AutomateProcessing, BookInPolicy, BookingType, BookingWindowInDays, … |
| microsoft.exchange.casmailboxplan | 4 | 6 | ActiveSyncEnabled, DisplayName, Identity, ImapEnabled, OwaMailboxPolicy, PopEnabled |
| microsoft.exchange.casmailboxsettings | 56 | 28 | ActiveSyncAllowedDeviceIDs, ActiveSyncBlockedDeviceIDs, ActiveSyncDebugLogging, ActiveSyncEnabled, ActiveSyncMailboxPolicy, ActiveSyncSuppressReadReceipt, EwsEnabled, Identity, ImapEnabled, ImapForceICalForCalendarRetrievalOption, ImapMessagesRetrievalMimeFormat, ImapSuppressReadReceipt, … |
| microsoft.exchange.dataclassification | 226 | 6 | Description, Ensure, Identity, IsDefault, Locale, Name |
| microsoft.exchange.distributiongroup | 6 | 41 | AcceptMessagesOnlyFrom, AcceptMessagesOnlyFromSendersOrMembers, Alias, BccBlocked, BypassNestedModerationEnabled, CustomAttribute1, CustomAttribute10, CustomAttribute11, CustomAttribute12, CustomAttribute13, CustomAttribute14, CustomAttribute15, … |
| microsoft.exchange.dkimsigningconfig | 3 | 8 | AdminDisplayName, BodyCanonicalization, Enabled, Ensure, HeaderCanonicalization, Identity, KeySize, KeySize@odata.type |
| microsoft.exchange.groupsettings | 13 | 41 | AccessType, AlwaysSubscribeMembersToCalendarEvents, AuditLogAgeLimit, AutoSubscribeNewMembers, ConnectorsEnabled, CustomAttribute1, CustomAttribute10, CustomAttribute11, CustomAttribute12, CustomAttribute13, CustomAttribute14, CustomAttribute15, … |
| microsoft.exchange.hostedconnectionfilterpolicy | 1 | 7 | AdminDisplayName, EnableSafeList, Ensure, IPAllowList, IPBlockList, Identity, MakeDefault |
| microsoft.exchange.hostedcontentfilterpolicy | 3 | 52 | AddXHeaderValue, AdminDisplayName, AllowedSenderDomains, AllowedSenders, BlockedSenderDomains, BlockedSenders, BulkQuarantineTag, BulkSpamAction, BulkThreshold, BulkThreshold@odata.type, DownloadLink, EnableLanguageBlockList, … |
| microsoft.exchange.hostedoutboundspamfilterpolicy | 1 | 15 | ActionWhenThresholdReached, AdminDisplayName, AutoForwardingMode, BccSuspiciousOutboundAdditionalRecipients, BccSuspiciousOutboundMail, Ensure, Identity, NotifyOutboundSpam, NotifyOutboundSpamRecipients, RecipientLimitExternalPerHour, RecipientLimitExternalPerHour@odata.type, RecipientLimitInternalPerHour, … |
| microsoft.exchange.inboundconnector | 1 | 18 | AssociatedAcceptedDomains, CloudServicesMailEnabled, Comment, ConnectorSource, ConnectorType, EFSkipIPs, EFSkipLastIP, EFUsers, Enabled, Ensure, Identity, RequireTls, … |
| microsoft.exchange.irmconfiguration | 1 | 16 | AutomaticServiceUpdateEnabled, AzureRMSLicensingEnabled, DecryptAttachmentForEncryptOnly, EDiscoverySuperUserEnabled, EnablePdfEncryption, Ensure, InternalLicensingEnabled, IsSingleInstance, JournalReportDecryptionEnabled, LicensingLocation, RejectIfRecipientHasNoRights, SearchEnabled, … |
| microsoft.exchange.mailboxautoreplyconfiguration | 57 | 15 | AutoDeclineFutureRequestsWhenOOF, AutoReplyState, CreateOOFEvent, DeclineAllEventsForScheduledOOF, DeclineEventsForScheduledOOF, DeclineMeetingMessage, EndTime, Ensure, ExternalAudience, ExternalMessage, Identity, InternalMessage, … |
| microsoft.exchange.mailboxcalendarfolder | 57 | 7 | DetailLevel, Ensure, Identity, PublishDateRangeFrom, PublishDateRangeTo, PublishEnabled, SearchableUrlEnabled |
| microsoft.exchange.mailboxpermission | 88 | 6 | AccessRights, Deny, Ensure, Identity, InheritanceType, User |
| microsoft.exchange.mailboxplan | 4 | 9 | DisplayName, Identity, IssueWarningQuota, MaxReceiveSize, MaxSendSize, ProhibitSendQuota, ProhibitSendReceiveQuota, RetainDeletedItemsFor, RoleAssignmentPolicy |
| microsoft.exchange.mailboxsettings | 57 | 3 | DisplayName, Locale, TimeZone |
| microsoft.exchange.mailcontact | 2 | 18 | Alias, DisplayName, Ensure, ExtensionCustomAttribute1, ExtensionCustomAttribute2, ExtensionCustomAttribute3, ExtensionCustomAttribute4, ExtensionCustomAttribute5, ExternalEmailAddress, MacAttachmentFormat, MessageBodyFormat, MessageFormat, … |
| microsoft.exchange.mailtips | 1 | 8 | Ensure, IsSingleInstance, MailTipsAllTipsEnabled, MailTipsExternalRecipientsTipsEnabled, MailTipsGroupMetricsEnabled, MailTipsLargeAudienceThreshold, MailTipsLargeAudienceThreshold@odata.type, MailTipsMailboxSourcedTipsEnabled |
| microsoft.exchange.malwarefilterpolicy | 5 | 13 | AdminDisplayName, CustomNotifications, EnableExternalSenderAdminNotifications, EnableFileFilter, EnableInternalSenderAdminNotifications, Ensure, FileTypeAction, FileTypes, Identity, InternalSenderAdminAddress, MakeDefault, QuarantineTag, … |
| microsoft.exchange.malwarefilterrule | 2 | 8 | Enabled, Ensure, Identity, MalwareFilterPolicy, Priority, Priority@odata.type, RecipientDomainIs, SentToMemberOf |
| microsoft.exchange.managementrole | 6 | 4 | Description, Ensure, Name, Parent |
| microsoft.exchange.managementroleassignment | 230 | 7 | App, CustomResourceScope, Ensure, Name, Policy, Role, SecurityGroup |
| microsoft.exchange.mobiledevicemailboxpolicy | 2 | 57 | AllowApplePushNotifications, AllowBluetooth, AllowBrowser, AllowCamera, AllowConsumerEmail, AllowDesktopSync, AllowExternalDeviceManagement, AllowGooglePushNotifications, AllowHTMLEmail, AllowInternetSharing, AllowIrDA, AllowMicrosoftPushNotifications, … |
| microsoft.exchange.omeconfiguration | 1 | 13 | BackgroundColor, DisclaimerText, EmailText, Ensure, ExternalMailExpiryInDays, ExternalMailExpiryInDays@odata.type, Identity, IntroductionText, OTPEnabled, PortalText, PrivacyStatementUrl, ReadButtonText, … |
| microsoft.exchange.organizationconfig | 1 | 98 | ActivityBasedAuthenticationTimeoutEnabled, ActivityBasedAuthenticationTimeoutInterval, ActivityBasedAuthenticationTimeoutWithSingleSignOnEnabled, AppsForOfficeEnabled, AsyncSendEnabled, AuditDisabled, AutoExpandingArchive, AutodiscoverPartialDirSync, BlockMoveMessagesForGroupFolders, BookingsAddressEntryRestricted, BookingsAuthEnabled, BookingsBlockedWordsEnabled, … |
| microsoft.exchange.outboundconnector | 1 | 17 | AllAcceptedDomains, CloudServicesMailEnabled, Comment, ConnectorSource, ConnectorType, Enabled, Ensure, Identity, IsTransportRuleScoped, RecipientDomains, RouteAllMessagesViaOnPremises, SenderRewritingEnabled, … |
| microsoft.exchange.owamailboxpolicy | 2 | 81 | AccountTransferEnabled, ActionForUnknownFileAndMIMETypes, ActiveSyncIntegrationEnabled, AdditionalStorageProvidersAvailable, AllAddressListsEnabled, AllowCopyContactsToDeviceAddressBook, AllowedFileTypes, AllowedMimeTypes, BlockedFileTypes, BlockedMimeTypes, BookingsMailboxCreationEnabled, ClassicAttachmentsEnabled, … |
| microsoft.exchange.perimeterconfiguration | 1 | 3 | Ensure, GatewayIPAddresses, IsSingleInstance |
| microsoft.exchange.place | 11 | 15 | Capacity, Capacity@odata.type, City, CountryOrRegion, DisplayName, Ensure, Identity, IsWheelChairAccessible, Label, MTREnabled, ParentId, PostalCode, … |
| microsoft.exchange.quarantinepolicy | 5 | 9 | ESNEnabled, EndUserQuarantinePermissionsValue, EndUserQuarantinePermissionsValue@odata.type, EndUserSpamNotificationFrequency, EndUserSpamNotificationFrequencyInDays, Ensure, Identity, OrganizationBrandingEnabled, QuarantinePolicyType |
| microsoft.exchange.recipientpermission | 358 | 4 | AccessRights, Ensure, Identity, Trustee |
| microsoft.exchange.remotedomain | 2 | 22 | AllowedOOFType, AutoForwardEnabled, AutoReplyEnabled, ByteEncoderTypeFor7BitCharsets, CharacterSet, ContentType, DeliveryReportEnabled, DisplaySenderName, DomainName, Ensure, Identity, IsInternal, … |
| microsoft.exchange.reportsubmissionpolicy | 1 | 2 | Ensure, IsSingleInstance |
| microsoft.exchange.roleassignmentpolicy | 1 | 5 | Description, Ensure, IsDefault, Name, Roles |
| microsoft.exchange.rolegroup | 39 | 5 | Description, Ensure, Members, Name, Roles |
| microsoft.exchange.safeattachmentpolicy | 5 | 8 | Action, AdminDisplayName, Enable, Ensure, Identity, QuarantineTag, Redirect, RedirectAddress |
| microsoft.exchange.safeattachmentrule | 1 | 7 | Enabled, Ensure, Identity, Priority, Priority@odata.type, SafeAttachmentPolicy, SentToMemberOf |
| microsoft.exchange.safelinkspolicy | 6 | 15 | AdminDisplayName, AllowClickThrough, CustomNotificationText, DeliverMessageAfterScan, DisableUrlRewrite, DoNotRewriteUrls, EnableForInternalSenders, EnableOrganizationBranding, EnableSafeLinksForEmail, EnableSafeLinksForOffice, EnableSafeLinksForTeams, Ensure, … |
| microsoft.exchange.safelinksrule | 2 | 8 | Enabled, Ensure, Identity, Priority, Priority@odata.type, SafeLinksPolicy, SentTo, SentToMemberOf |
| microsoft.exchange.sharedmailbox | 7 | 6 | Alias, DisplayName, EmailAddresses, Ensure, Identity, PrimarySMTPAddress |
| microsoft.exchange.sharingpolicy | 3 | 5 | Default, Domains, Enabled, Ensure, Name |
| microsoft.exchange.transportconfig | 1 | 26 | AddressBookPolicyRoutingEnabled, AllowLegacyTLSClients, ClearCategories, ConvertDisclaimerWrapperToEml, DSNConversionMode, ExternalDelayDsnEnabled, ExternalDsnLanguageDetectionEnabled, ExternalDsnSendHtml, HeaderPromotionModeSetting, InternalDelayDsnEnabled, InternalDsnLanguageDetectionEnabled, InternalDsnSendHtml, … |
| microsoft.exchange.transportrule | 6 | 124 | AddToRecipients, AnyOfCcHeader, AnyOfCcHeaderMemberOf, AnyOfRecipientAddressContainsWords, AnyOfRecipientAddressMatchesPatterns, AnyOfToCcHeader, AnyOfToCcHeaderMemberOf, AnyOfToHeader, AnyOfToHeaderMemberOf, ApplyHtmlDisclaimerFallbackAction, ApplyHtmlDisclaimerLocation, ApplyHtmlDisclaimerText, … |
| microsoft.securityandcompliance.compliancetag | 2 | 9 | Comment, Ensure, IsRecordLabel, Name, Notes, Regulatory, RetentionAction, RetentionDuration, RetentionType |
| microsoft.securityandcompliance.dlpcompliancepolicy | 3 | 18 | Comment, EndpointDlpLocationException, Ensure, ExchangeSenderMemberOf, ExchangeSenderMemberOfException, Mode, Name, OnPremisesScannerDlpLocationException, OneDriveLocation, OneDriveLocationException, PowerBIDlpLocationException, Priority, … |
| microsoft.securityandcompliance.fileplanpropertyauthority | 3 | 2 | Ensure, Name |
| microsoft.securityandcompliance.fileplanpropertycategory | 13 | 2 | Ensure, Name |
| microsoft.securityandcompliance.fileplanpropertycitation | 5 | 4 | CitationJurisdiction, CitationUrl, Ensure, Name |
| microsoft.securityandcompliance.fileplanpropertydepartment | 10 | 2 | Ensure, Name |
| microsoft.securityandcompliance.labelpolicy | 2 | 6 | AdvancedSettings, Comment, Ensure, ExchangeLocation, Labels, Name |
| microsoft.securityandcompliance.protectionalert | 3 | 15 | AggregationType, Category, Comment, Disabled, Ensure, Filter, Name, NotificationEnabled, NotifyUser, NotifyUserOnFilterMatch, NotifyUserThrottleThreshold, NotifyUserThrottleThreshold@odata.type, … |
| microsoft.securityandcompliance.retentioncompliancepolicy | 2 | 17 | Comment, DynamicScopeLocation, Enabled, Ensure, ExchangeLocation, ExchangeLocationException, ModernGroupLocation, ModernGroupLocationException, Name, OneDriveLocation, OneDriveLocationException, PublicFolderLocation, … |
| microsoft.securityandcompliance.retentioncompliancerule | 2 | 10 | Comment, ContentMatchQuery, Ensure, ExcludedItemClasses, ExpirationDateOption, Name, Policy, RetentionComplianceAction, RetentionDuration, RetentionDurationDisplayHint |
| microsoft.securityandcompliance.retentioneventtype | 3 | 3 | Comment, Ensure, Name |
| microsoft.teams.apppermissionpolicy | 1 | 8 | DefaultCatalogApps, DefaultCatalogAppsType, Ensure, GlobalCatalogApps, GlobalCatalogAppsType, Identity, PrivateCatalogApps, PrivateCatalogAppsType |
| microsoft.teams.appsetuppolicy | 3 | 6 | AllowSideLoading, AllowUserPinning, Description, Ensure, Identity, PinnedAppBarApps |
| microsoft.teams.audioconferencingpolicy | 1 | 4 | AllowTollFreeDialin, Ensure, Identity, MeetingInvitePhoneNumbers |
| microsoft.teams.callholdpolicy | 1 | 2 | Ensure, Identity |
| microsoft.teams.callingpolicy | 7 | 22 | AllowCallForwardingToPhone, AllowCallForwardingToUser, AllowCallGroups, AllowCallRedirect, AllowCloudRecordingForCalls, AllowDelegation, AllowPrivateCalling, AllowSIPDevicesCalling, AllowTranscriptionForCalling, AllowVoicemail, AllowWebPSTNCalling, AutoAnswerEnabledType, … |
| microsoft.teams.callparkpolicy | 3 | 10 | AllowCallPark, Description, Ensure, Identity, ParkTimeoutSeconds, ParkTimeoutSeconds@odata.type, PickupRangeEnd, PickupRangeEnd@odata.type, PickupRangeStart, PickupRangeStart@odata.type |
| microsoft.teams.channelspolicy | 2 | 8 | AllowChannelSharingToExternalUser, AllowOrgWideTeamCreation, AllowPrivateChannelCreation, AllowSharedChannelCreation, AllowUserToParticipateInExternalSharedChannel, EnablePrivateTeamDiscovery, Ensure, Identity |
| microsoft.teams.clientconfiguration | 1 | 14 | AllowBox, AllowDropBox, AllowEgnyte, AllowEmailIntoChannel, AllowGoogleDrive, AllowGuestUser, AllowOrganizationTab, AllowResourceAccountSendMessage, AllowScopedPeopleSearchandAccess, AllowShareFile, AllowSkypeBusinessInterop, ContentPin, … |
| microsoft.teams.compliancerecordingpolicy | 1 | 6 | ComplianceRecordingApplications, DisableComplianceRecordingAudioNotificationForCalls, Enabled, Ensure, Identity, WarnUserOnRemoval |
| microsoft.teams.cortanapolicy | 1 | 3 | CortanaVoiceInvocationMode, Ensure, Identity |
| microsoft.teams.dialinconferencingtenantsettings | 1 | 11 | AllowPSTNOnlyMeetingsByDefault, AutomaticallyMigrateUserMeetings, AutomaticallyReplaceAcpProvider, AutomaticallySendEmailsToUsers, EnableDialOutJoinConfirmation, EnableEntryExitNotifications, EntryExitAnnouncementsType, IsSingleInstance, MaskPstnNumbersType, PinLength, PinLength@odata.type |
| microsoft.teams.emergencycallingpolicy | 3 | 5 | Description, Ensure, ExternalLocationLookupMode, ExternalLocationLookupMode@odata.type, Identity |
| microsoft.teams.emergencycallroutingpolicy | 3 | 4 | AllowEnhancedEmergencyServices, Description, Ensure, Identity |
| microsoft.teams.enhancedencryptionpolicy | 3 | 4 | CallingEndtoEndEncryptionEnabledType, Ensure, Identity, MeetingEndToEndEncryption |
| microsoft.teams.eventspolicy | 3 | 13 | AllowEmailEditing, AllowEventIntegrations, AllowTownhalls, AllowWebinars, AllowedQuestionTypesInRegistrationForm, AllowedTownhallTypesForRecordingPublish, AllowedWebinarTypesForRecordingPublish, Description, Ensure, EventAccessType, Identity, TownhallChatExperience, … |
| microsoft.teams.federationconfiguration | 1 | 10 | AllowFederatedUsers, AllowTeamsConsumer, AllowTeamsConsumerInbound, AllowedDomains, BlockedDomains, ExternalAccessWithTrialTenants, Identity, RestrictTeamsConsumerToExternalUserProfiles, SharedSipAddressSpace, TreatDiscoveredPartnersAsUnverified |
| microsoft.teams.feedbackpolicy | 4 | 7 | AllowEmailCollection, AllowLogCollection, AllowScreenshotCollection, Ensure, Identity, ReceiveSurveysMode, UserInitiatedMode |
| microsoft.teams.filespolicy | 1 | 4 | Ensure, Identity, NativeFileEntryPoints, SPChannelFilesTab |
| microsoft.teams.guestcallingconfiguration | 1 | 2 | AllowPrivateCalling, Identity |
| microsoft.teams.guestmeetingconfiguration | 1 | 6 | AllowIPVideo, AllowMeetNow, AllowTranscription, Identity, LiveCaptionsEnabledType, ScreenSharingMode |
| microsoft.teams.guestmessagingconfiguration | 1 | 10 | AllowGiphy, AllowImmersiveReader, AllowMemes, AllowStickers, AllowUserChat, AllowUserDeleteChat, AllowUserDeleteMessage, AllowUserEditMessage, GiphyRatingType, Identity |
| microsoft.teams.ipphonepolicy | 1 | 9 | AllowBetterTogether, AllowHomeScreen, AllowHotDesking, Ensure, HotDeskingIdleTimeoutInMinutes, HotDeskingIdleTimeoutInMinutes@odata.type, Identity, SearchOnCommonAreaPhoneMode, SignInMode |
| microsoft.teams.meetingbroadcastconfiguration | 1 | 7 | AllowSdnProviderForBroadcastMeeting, Identity, SdnApiTemplateUrl, SdnApiToken, SdnLicenseId, SdnProviderName, SupportURL |
| microsoft.teams.meetingbroadcastpolicy | 4 | 6 | AllowBroadcastScheduling, AllowBroadcastTranscription, BroadcastAttendeeVisibilityMode, BroadcastRecordingMode, Ensure, Identity |
| microsoft.teams.meetingconfiguration | 1 | 17 | ClientAppSharingPort, ClientAppSharingPort@odata.type, ClientAppSharingPortRange, ClientAppSharingPortRange@odata.type, ClientAudioPort, ClientAudioPort@odata.type, ClientAudioPortRange, ClientAudioPortRange@odata.type, ClientMediaPortRangeEnabled, ClientVideoPort, ClientVideoPort@odata.type, ClientVideoPortRange, … |
| microsoft.teams.meetingpolicy | 8 | 62 | AllowAnnotations, AllowAnonymousUsersToDialOut, AllowAnonymousUsersToJoinMeeting, AllowAnonymousUsersToStartMeeting, AllowBreakoutRooms, AllowCartCaptionsScheduling, AllowChannelMeetingScheduling, AllowCloudRecording, AllowDocumentCollaboration, AllowEngagementReport, AllowExternalParticipantGiveRequestControl, AllowIPAudio, … |
| microsoft.teams.messagingpolicy | 8 | 26 | AllowCommunicationComplianceEndUserReporting, AllowFluidCollaborate, AllowGiphy, AllowImmersiveReader, AllowMemes, AllowOwnerDeleteMessage, AllowPriorityMessages, AllowRemoveUser, AllowSecurityEndUserReporting, AllowSmartCompose, AllowSmartReply, AllowStickers, … |
| microsoft.teams.mobilitypolicy | 2 | 5 | Ensure, IPAudioMobileMode, IPVideoMobileMode, Identity, MobileDialerPreference |
| microsoft.teams.networkroamingpolicy | 1 | 5 | AllowIPVideo, Ensure, Identity, MediaBitRateKb, MediaBitRateKb@odata.type |
| microsoft.teams.onlinevoicemailpolicy | 6 | 8 | EnableEditingCallAnswerRulesSetting, EnableTranscription, EnableTranscriptionProfanityMasking, EnableTranscriptionTranslation, Ensure, Identity, MaximumRecordingLength, ShareData |
| microsoft.teams.onlinevoiceuser | 24 | 2 | Ensure, Identity |
| microsoft.teams.shiftspolicy | 2 | 9 | AccessGracePeriodMinutes, AccessGracePeriodMinutes@odata.type, AccessType, EnableScheduleOwnerPermissions, Ensure, Identity, ShiftNoticeFrequency, ShiftNoticeMessageCustom, ShiftNoticeMessageType |
| microsoft.teams.templatespolicy | 1 | 3 | Ensure, HiddenTemplates, Identity |
| microsoft.teams.tenantdialplan | 3 | 4 | Description, Ensure, Identity, SimpleName |
| microsoft.teams.updatemanagementpolicy | 2 | 10 | AllowManagedUpdates, AllowPreview, AllowPublicPreview, Ensure, Identity, UpdateDayOfWeek, UpdateDayOfWeek@odata.type, UpdateTime, UpdateTimeOfDay, UseNewTeamsClient |
| microsoft.teams.upgradeconfiguration | 1 | 3 | DownloadTeams, IsSingleInstance, SfBMeetingJoinUx |
| microsoft.teams.upgradepolicy | 11 | 2 | Identity, Users |
| microsoft.teams.user | 166 | 4 | Ensure, Role, TeamName, User |
| microsoft.teams.vdipolicy | 1 | 4 | DisableAudioVideoInCallsAndMeetings, DisableCallsAndMeetings, Ensure, Identity |
| microsoft.teams.voiceroute | 1 | 7 | Ensure, Identity, NumberPattern, OnlinePstnGatewayList, OnlinePstnUsages, Priority, Priority@odata.type |
| microsoft.teams.voiceroutingpolicy | 3 | 4 | Description, Ensure, Identity, OnlinePstnUsages |
| microsoft.teams.workloadpolicy | 1 | 8 | AllowCalling, AllowCallingPinned, AllowMeeting, AllowMeetingPinned, AllowMessaging, AllowMessagingPinned, Ensure, Identity |
| microsoft.entra.authorizationpolicy | 1 | 16 | AllowEmailVerifiedUsersToJoinOrganization, AllowInvitesFrom, AllowedToSignUpEmailBasedSubscriptions, AllowedToUseSSPR, BlockMsolPowerShell, DefaultUserRoleAllowedToCreateApps, DefaultUserRoleAllowedToCreateSecurityGroups, DefaultUserRoleAllowedToCreateTenants, DefaultUserRoleAllowedToReadBitlockerKeysForOwnedDevice, DefaultUserRoleAllowedToReadOtherUsers, Description, DisplayName, … |
| microsoft.entra.conditionalaccesspolicy | 24 | 46 | ApplicationEnforcedRestrictionsIsEnabled, AuthenticationContexts, AuthenticationStrength, BuiltInControls, ClientAppTypes, CloudAppSecurityIsEnabled, CloudAppSecurityType, CustomAuthenticationFactors, DeviceFilterRule, DisplayName, Ensure, ExcludeApplications, … |
| microsoft.entra.namedlocationpolicy | 3 | 6 | DisplayName, Ensure, Id, IpRanges, IsTrusted, OdataType |
| microsoft.intune.devicecompliancepolicywindows10 | 1 | 28 | ActiveFirewallRequired, AntiSpywareRequired, AntivirusRequired, Assignments, BitLockerEnabled, CodeIntegrityEnabled, ConfigurationManagerComplianceRequired, DefenderEnabled, Description, DeviceThreatProtectionEnabled, DeviceThreatProtectionRequiredSecurityLevel, DisplayName, … |
| microsoft.intune.roledefinition | 11 | 8 | Description, DisplayName, Ensure, Id, IsBuiltIn, allowedResourceActions, notallowedResourceActions, roleScopeTagIds |

