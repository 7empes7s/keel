# Delegated-only probe

Generated 2026-10-22T22:01:32.615Z. Environments read: 2 (cap 3).

| Row | Area | Verdict |
|---|---|---|
| 2 | Planner premium plans (Project for the web) | inconclusive |
| 3 | Project Online (PWA) | nothing to call |
| 5 | Power Platform tenant settings | app-only works |
| 6 | Power Apps and flows inside solutions | inconclusive |
| 7 | Power Apps and flows outside solutions | partly app-only |
| 8 | Dynamics 365 (Dataverse) settings and data | inconclusive |
| 9 | Dynamics 365 Finance and Operations | not probed (see reasons) |
| 11 | Power BI reports in shared workspaces | app-only works |
| 12 | Power BI "My workspace" content | partly app-only |
| 14 | SharePoint search schema and term store | partly app-only |
| 15 | OneNote pages | app-only refused |
| 16 | Exchange settings (PowerShell) | partly app-only |
| 17 | Security and Compliance PowerShell (Purview) | partly app-only |
| 18 | Teams policies (MicrosoftTeams module) | partly app-only |
| 20 | Viva Engage (Yammer) | app-only refused |
| 21 | Entra device registration settings | app-only works |
| 22 | Entra password reset (SSPR) and per-user MFA service settings | nothing to call |
| 23 | Microsoft 365 admin center org settings | app-only refused |
| 24 | Defender portal settings | app-only refused |
| 25 | Microsoft Forms | app-only refused |
| 26 | Loop workspaces | nothing to call |
| 27 | Stream videos, Whiteboard, Clipchamp | nothing to call |
| 28 | Bookings | app-only refused |

## Row 2: Planner premium plans (Project for the web)

Verdict: **inconclusive**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| Dataverse answers this app (an application user exists) | environment 1 | skipped |  |  |  | environment has no Dataverse |
| Dataverse answers this app (an application user exists) | environment 2 | not-found | 404 | 0x8004a104 |  | The Dynamics 365 organization you are attempting to access is currently disabled. Please contact your system administrator |
| read premium plans | environment 1 | skipped |  |  |  | environment has no Dataverse |
| read premium plans | environment 2 | not-found | 404 | 0x8004a104 |  | The Dynamics 365 organization you are attempting to access is currently disabled. Please contact your system administrator |

Not called: Restore through the Project schedule APIs is a write, so it is not probed.

## Row 3: Project Online (PWA)

Verdict: **nothing to call**

Not called: Retired by Microsoft on 30 Sep 2026. Nothing to call.

## Row 5: Power Platform tenant settings

Verdict: **app-only works**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| list environments (needed by rows 2, 6, 7, 8, 9) |  | works | 200 |  | 2 |  |
| read tenant settings (read-only POST) |  | works | 200 |  |  |  |

## Row 6: Power Apps and flows inside solutions

Verdict: **inconclusive**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| list solutions | environment 1 | skipped |  |  |  | environment has no Dataverse |
| list solutions | environment 2 | not-found | 404 | 0x8004a104 |  | The Dynamics 365 organization you are attempting to access is currently disabled. Please contact your system administrator |
| list flows in Dataverse | environment 1 | skipped |  |  |  | environment has no Dataverse |
| list flows in Dataverse | environment 2 | not-found | 404 | 0x8004a104 |  | The Dynamics 365 organization you are attempting to access is currently disabled. Please contact your system administrator |
| list canvas apps in Dataverse | environment 1 | skipped |  |  |  | environment has no Dataverse |
| list canvas apps in Dataverse | environment 2 | not-found | 404 | 0x8004a104 |  | The Dynamics 365 organization you are attempting to access is currently disabled. Please contact your system administrator |

Not called: ExportSolution is a POST action that builds a package, so it is not called.

## Row 7: Power Apps and flows outside solutions

Verdict: **partly app-only**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| admin list of apps | environment 1 | works | 200 |  | 0 |  |
| admin list of apps | environment 2 | works | 200 |  | 0 |  |
| admin list of flows | environment 1 | works | 200 |  | 0 |  |
| admin list of flows | environment 2 | not-found | 404 | XrmApiRequestFailed |  | Request to XRM API failed with error: 'Message: The Dynamics 365 organization you are attempting to access is currently disabled. Please contact your system administrator Code: 0x8004a104 InnerError: '. |

Not called: The package export is a POST that starts an export job, so it is not called.

## Row 8: Dynamics 365 (Dataverse) settings and data

Verdict: **inconclusive**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| read organization settings | environment 1 | skipped |  |  |  | environment has no Dataverse |
| read organization settings | environment 2 | not-found | 404 | 0x8004a104 |  | The Dynamics 365 organization you are attempting to access is currently disabled. Please contact your system administrator |

## Row 9: Dynamics 365 Finance and Operations

Verdict: **not probed (see reasons)**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| environments linked to Finance and Operations (from the environment list) |  | info |  |  | 0 | environments linked to Finance and Operations; its own API is a later phase and is not called |

## Row 11: Power BI reports in shared workspaces

Verdict: **app-only works**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| workspaces this app is a member of |  | works | 200 |  | 0 |  |
| admin list of shared workspaces |  | works | 200 |  | 0 |  |

## Row 12: Power BI "My workspace" content

Verdict: **partly app-only**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| admin list of personal workspaces |  | works | 200 |  | 2 |  |
| list reports in one personal workspace |  | refused | 401 | PowerBINotAuthorizedException |  |  |

## Row 14: SharePoint search schema and term store

Verdict: **partly app-only**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| term store groups |  | refused | 403 | accessDenied |  | The current user has insufficient permissions to perform this operation. |

Cmdlet sweep: works 2.

Not called: Search schema export is read by the PnP sweep (Get-PnPSearchConfiguration).

## Row 15: OneNote pages

Verdict: **app-only refused**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| OneNote notebooks on the root site |  | not-supported | 400 | 20143 |  | The OData query is invalid. The URI segment 'notebooks' is invalid after the segment 'notes'. |

## Row 16: Exchange settings (PowerShell)

Verdict: **partly app-only**

Cmdlet sweep: works 188, needs-parameter 79, refused 6, error 69, not-found 3, not-supported 1.

| Cmdlet | Outcome | Message |
|---|---|---|
| Get-AccessToCustomerDataRequest | refused | \|\|You're not authorized to perform the operation. Please elevate to one of these roles: Global Administrator, Customer LockBox Access Approver, Global Reader |
| Get-App | error | \|\|This action cannot be performed directly to arbitration mailboxes. Please use the OrganizationApp parameter instead. |
| Get-ApplicationAccessPolicy | not-found | \|\|The operation couldn't be performed because object 'OU=[tenant host],OU=Microsoft Exchange Hosted Organizations,DC=EURPR04A012,DC=PROD,DC=OUTLOOK,DC=COM\*' couldn't be found on 'ZRXPR04A12DC003.EURPR04A012.PROD.OUTLOOK.COM'. |
| Get-AuditConfig | error | Object reference not set to an instance of an object. |
| Get-BlockedConnector | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-BlockedSenderAddress | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-BookingMailbox | error | Object reference not set to an instance of an object. |
| Get-CalendarSettings | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-CompliancePolicyFileSyncNotification | error | Object reference not set to an instance of an object. |
| Get-CompliancePolicySyncNotification | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-CrossTenantAccessPolicy | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-CrossTenantRecallConfiguration | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-DefaultTenantBriefingConfig | refused | Access to the requested resource is forbidden. |
| Get-DeviceComplianceUserReport | error | \|\|Parameter set cannot be resolved using the specified named parameters. Default mandatory parameters not satisfied. DeviceId |
| Get-DlpDetailReport | error | The cmdlet you attempted to run is currently unavailable. It may be deprecated, restricted from use, or temporarily blocked due to an internal issue. If you believe this cmdlet should be accessible, please contact us at [address] for assistance.  |
| Get-DlpDetectionsReport | error | The cmdlet you attempted to run is currently unavailable. It may be deprecated, restricted from use, or temporarily blocked due to an internal issue. If you believe this cmdlet should be accessible, please contact us at [address] for assistance.  |
| Get-DlpIncidentDetailReport | error | The cmdlet you attempted to run is currently unavailable. It may be deprecated, restricted from use, or temporarily blocked due to an internal issue. If you believe this cmdlet should be accessible, please contact us at [address] for assistance.  |
| Get-DlpKeywordDictionary | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-DlpPolicyTemplate | error | The cmdlet you attempted to run is currently unavailable. It may be deprecated, restricted from use, or temporarily blocked due to an internal issue. If you believe this cmdlet should be accessible, please contact us at [address] for assistance.  |
| Get-DlpSensitiveInformationTypeConfig | error | This command is only allowed to run in Exchange Online Protection environment. |
| Get-DlpSensitiveInformationTypeRulePackage | error | \|\|This command is only allowed to run in Exchange Online Protection environment. |
| Get-DlpSiDetectionsReport | error | The cmdlet you attempted to run is currently unavailable. It may be deprecated, restricted from use, or temporarily blocked due to an internal issue. If you believe this cmdlet should be accessible, please contact us at [address] for assistance.  |
| Get-ElevatedAccessAuthorization | error | One or more errors occurred. (Operation QueryItems failed.) |
| Get-ElevatedAccessRequest | error | One or more errors occurred. (Operation QueryItems failed.) |
| Get-EXOMailboxFolderPermission | error | Identity "" is not a valid value. The identity should be <MailboxId>:\<FolderPath> or <MailboxId>:<FolderId> format. Valid Value for Mailbox Identity is either GUID(XXXXXXXX - XXXX - XXXX - XXXX - XXXXXXXXXXXX format) or UserPrincipalName([address] format) or Alias. |
| Get-EXOMailboxFolderStatistics | error | Identity is a mandatory value to provide for running Get-ExoMailboxFolderStatistics. You can specify identity by using either of the following Identity, ExternalDirectoryObjectId, UserPrincipalName.  |
| Get-EXOMailboxPermission | error | Identity is a mandatory value to provide for running Get-ExoMailboxPermission. You can specify identity by using any one of the three available parameters: Identity, ExternalDirectoryObjectId, UserPrincipalName. |
| Get-EXOMailboxStatistics | error | Identity is a mandatory value to provide for running Get-ExoMailboxStatistics. You can specify identity by using either of the following 1. Any one of the three available parameters: Identity, ExchangeGuid, UserPrincipalName. 2. ExchangeGuid and DatabaseGuid |
| Get-EXOMobileDeviceStatistics | error |  "Mailbox" "Identity" or "ExternalDirectoryObjectId" or "UserPrincipalName" or "PrimarySmtpAddress" parameter must be specified |
| Get-ExoPhishSimOverrideRule | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-ExoSecOpsOverrideRule | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-ExternalInOutlook | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-InformationBarrierReportDetails | error | \|\|We cannot currently process your request, please wait a few minutes and try again. |
| Get-InformationBarrierReportSummary | error | \|\|We cannot currently process your request, please wait a few minutes and try again. |
| Get-IPv6StatusForAcceptedDomain | error | Cannot create filter for property Name with null value. (Parameter 'originalValue') |
| Get-JitConfiguration | error | The cmdlet you attempted to run is currently unavailable. It may be deprecated, restricted from use, or temporarily blocked due to an internal issue. If you believe this cmdlet should be accessible, please contact us at [address] for assistance.  |
| Get-LimitsEnforcementStatus | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-LogonStatistics | error | Cannot process command because of one or more missing mandatory parameters: Identity. |
| Get-M365CrossTenantAccessPolicy | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-MailboxAnalysisRequest | error | Object reference not set to an instance of an object. |
| Get-MailboxCalendarConfiguration | refused | Parameter set cannot be resolved using the specified named parameters. One or more parameters issued cannot be used together or an insufficient number of parameters were provided. |
| Get-MailboxExtendedProperty | error | Object reference not set to an instance of an object. |
| Get-MailboxFolder | refused | Parameter set cannot be resolved using the specified named parameters. One or more parameters issued cannot be used together or an insufficient number of parameters were provided. |
| Get-MailboxFolderStatistics | error | Cannot process command because of one or more missing mandatory parameters: Identity. |
| Get-MailboxIRMAccess | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-MailboxLocation | error | Cannot process command because of one or more missing mandatory parameters: Identity. |
| Get-MailboxOverrideConfiguration | error | \|\|Parameter set cannot be resolved using the specified named parameters. Multiple parameter sets are applicable.  |
| Get-MailboxRegionalConfiguration | refused | Parameter set cannot be resolved using the specified named parameters. One or more parameters issued cannot be used together or an insufficient number of parameters were provided. |
| Get-MailboxSpellingConfiguration | error | \|\|Parameter set cannot be resolved using the specified named parameters. Multiple parameter sets are applicable.  |
| Get-MailboxStatistics | error | Cannot process command because of one or more missing mandatory parameters: Identity. |
| Get-MailTrafficSummaryReport | error | \|\|Invalid Category value. |
| Get-MessageTrace | error | \|\|Get-MessageTrace will start deprecating on September 1st, 2025. Please refer to: https://learn.microsoft.com/en-us/powershell/module/exchange/get-messagetracev2?view=exchange-ps to switch to Get-MessageTraceV2. |
| Get-MessageTraceDetail | error | \|\|MessageTraceId is a required field. |
| Get-MobileDeviceDashboardSummaryReport | error | \|\|DeviceType is a required parameter. |
| Get-MxRecordReport | error | \|\|Domain is a required field. |
| Get-MxRecordsReport | error | \|\|Domain |
| Get-OMEConfiguration | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-OnlineMeetingConfiguration | error | \|\|Parameter set cannot be resolved using the specified named parameters. Multiple parameter sets are applicable.  |
| Get-OnPremServerExemptionQuota | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-OnPremServerReportInfo | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-OutboundConnectorReport | error | \|\|Domain is a required field. |
| Get-PhishSimOverridePolicy | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-PlaceMailbox | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-PublicFolder | refused | Parameter set cannot be resolved using the specified named parameters. One or more parameters issued cannot be used together or an insufficient number of parameters were provided. |
| Get-RbacDiagnosticInfo | not-supported | Cmdlet type is not supported. Please check the name of the cmdlet: Get-RbacDiagnosticInfo |
| Get-RecipientStatisticsReport | not-found | \|\|Use the ReportingServer and ReportingDatabase parameters to specify the appropriate System Center Operations Manager reporting server and database. Error: A network-related or instance-specific error occurred while establishing a connection to SQL Server. The server was not found or was not accessible. Verify that the instance name is correct and that SQL Server is configured to allow remote con |
| Get-RetentionEvent | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-SafeLinksAggregateReport | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-SafeLinksDetailReport | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-ScopeEntities | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-SecOpsOverridePolicy | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-SecurityPrincipal | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-ServiceDeliveryReport | error | \|\|Recipient is a required field. |
| Get-ServiceStatus | not-found | \|\|Use the ReportingServer and ReportingDatabase parameters to specify the appropriate System Center Operations Manager reporting server and database. Error: A network-related or instance-specific error occurred while establishing a connection to SQL Server. The server was not found or was not accessible. Verify that the instance name is correct and that SQL Server is configured to allow remote con |
| Get-SmimeConfig | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-SupervisoryReviewPolicyReport | error | \|\|We cannot currently process your request, please wait a few minutes and try again. |
| Get-SupervisoryReviewReport | error | \|\|We cannot currently process your request, please wait a few minutes and try again. |
| Get-TenantScanRequestStatistics | error | A server side error has occurred because of which the operation could not be completed. Please try again after some time. If the problem still persists, please reach out to MS support. |
| Get-WrappedCommand | error | Cannot validate argument on parameter 'Name'. The argument is null, empty, or an element of the argument collection contains a null value. Supply a collection that does not contain any null values and then try the command again. |

## Row 17: Security and Compliance PowerShell (Purview)

Verdict: **partly app-only**

Cmdlet sweep: works 102, needs-parameter 14, error 15, refused 2, not-found 1.

| Cmdlet | Outcome | Message |
|---|---|---|
| Get-AuditConfig | error | Object reference not set to an instance of an object. |
| Get-CaseHoldPolicy | error | \|Microsoft.Exchange.Management.UnifiedPolicy.ErrorMustSpecifyCaseOrPolicyException\|To retrieve a case hold policy, please specify a policy or a case id. |
| Get-ComplianceCaseMemberCandidate | error | \|Microsoft.Exchange.Configuration.Tasks.ThrowTerminatingErrorException\|This cmdlet has been blocked because it is no longer in use. If you believe this is incorrect and you still require access to this cmdlet, please contact the Exchange Manageability team at [address] with the reason for your request so it can be reviewed and unblocked if appropriate. |
| Get-ComplianceCustodian | error | \|Microsoft.Exchange.Configuration.Tasks.ThrowTerminatingErrorException\|This cmdlet has been blocked because it is no longer in use. If you believe this is incorrect and you still require access to this cmdlet, please contact the Exchange Manageability team at [address] with the reason for your request so it can be reviewed and unblocked if appropriate. |
| Get-ComplianceNotice | error | \|Microsoft.Exchange.Configuration.Tasks.ThrowTerminatingErrorException\|This cmdlet has been blocked because it is no longer in use. If you believe this is incorrect and you still require access to this cmdlet, please contact the Exchange Manageability team at [address] with the reason for your request so it can be reviewed and unblocked if appropriate. |
| Get-CompliancePreservationSetting | error | The tenantId string is not a Guid or a valid domain string |
| Get-ComplianceSecurityFilter | refused | \|System.Exception\|Please close the current PowerShell session and open a new session using Connect-IPPSSession with the -EnableSearchOnlySession flag. This requires using ExchangeOnlineManagement v3.9.0 or higher. Please make sure you have Organization Management role group and eDiscovery Admin role to execute the cmdlets.Exception: [[time]] Cannot get security filters, error code Unauthorized. |
| Get-HoldComplianceRule | error | At least one unknown predicate or action is detected. |
| Get-InsiderRiskEntityList | error | \|Microsoft.Exchange.Management.UnifiedPolicy.ErrorIrmEntityListInvalidGetParametersException\|Either Identity or Type should be provided as parameter. |
| Get-LongTermAuditStats | error | Object reference not set to an instance of an object. |
| Get-MailFilterListReport | error | \|Microsoft.Exchange.Management.FfoReporting.Common.FfoReportingException\|We cannot currently process your request, please wait a few minutes and try again. |
| Get-PrivacyManagementCaseAdmin | not-found | \|Microsoft.Exchange.Management.Tasks.ComplianceCaseTaskException\|Unable to execute the task. Reason: The compliance case "*" doesn't exist. Please create the case. |
| Get-RetentionEvent | refused | This command is not allowed to run in Exchange Online Protection environment. |
| Get-ScopeEntities | error | Maximum retry count reached. |
| Get-ServiceDomainGroupStorage | error | \|Microsoft.Exchange.Configuration.Tasks.ThrowTerminatingErrorException\|This cmdlet has been blocked because it is no longer in use. If you believe this is incorrect and you still require access to this cmdlet, please contact the Exchange Manageability team at [address] with the reason for your request so it can be reviewed and unblocked if appropriate. |
| Get-TeamsRetentionComplianceRule | error | \|Microsoft.Exchange.Configuration.Tasks.ThrowTerminatingErrorException\|This cmdlet has been blocked because it is no longer in use. If you believe this is incorrect and you still require access to this cmdlet, please contact the Exchange Manageability team at [address] with the reason for your request so it can be reviewed and unblocked if appropriate. |
| Get-ThreatResponsePolicy | error | \|Microsoft.Exchange.Configuration.Tasks.ThrowTerminatingErrorException\|This cmdlet has been blocked because it is no longer in use. If you believe this is incorrect and you still require access to this cmdlet, please contact the Exchange Manageability team at [address] with the reason for your request so it can be reviewed and unblocked if appropriate. |
| Get-ThreatResponseRule | error | \|Microsoft.Exchange.Configuration.Tasks.ThrowTerminatingErrorException\|This cmdlet has been blocked because it is no longer in use. If you believe this is incorrect and you still require access to this cmdlet, please contact the Exchange Manageability team at [address] with the reason for your request so it can be reviewed and unblocked if appropriate. |

## Row 18: Teams policies (MicrosoftTeams module)

Verdict: **partly app-only**

Cmdlet sweep: needs-parameter 38, error 14, works 147, refused 7.

| Cmdlet | Outcome | Message |
|---|---|---|
| Get-AllM365TeamsApps | error |  |
| Get-AssociatedTeam | error | Error occurred while executing Code: BadRequest Message: /me request is only valid with delegated authentication flow. InnerError: RequestId: [id] DateTimeStamp: [time] HttpStatusCode: BadRequest  |
| Get-CsCloudCallDataConnection | refused | [Forbidden] : Access Denied. |
| Get-CsHybridTelephoneNumber | error | [BadArgument] : This cmdlet is no longer supported, please consult public documentation for alternative options. Parameter name: GetHybridNumberAsync |
| Get-CsLocationPolicy | refused | {"code":"Forbidden","message":"You are not authorized to perform this action","action":"Please refer to documentation. CorrelationId: [id]","errorCode":40301} |
| Get-CsOnlineDialInConferencingServiceNumber | error | The server responded with a Request Error, Status: NotFound |
| Get-CsOnlineDirectoryTenant | error | This cmdlet is no longer supported, please consult public documentation or use Get-CsTenant and Get-CsOnlineDialinConferencingBridge to get the relevant attributes. |
| Get-CsOnlineTelephoneNumber | error | This cmdlet is no longer supported, please consult public documentation |
| Get-CsOnlineVoiceUser | error | [InternalServerError] : This cmdlet has been deprecated. Alternative approach to achieve same functionalities is described in the official documentation. Refer this documentation https://learn.microsoft.com/en-us/powershell/module/skype/get-csonlinevoiceuser?view=skype-ps for more details. |
| Get-CsPolicyPackage | refused | Access Denied. |
| Get-CsSdgBulkSignInRequestsSummary | refused | Access Denied. |
| Get-CsTeamsAudioConferencingCustomPromptsConfiguration | error | {"code":"ClientError","message":"Type [redacted] is not currently enabled in flighting","action":"Please refer to documentation. CorrelationId: [id]","errorCode":40003} |
| Get-CsTeamsCarrierEmergencyCallRoutingPolicy | refused | {"code":"Forbidden","message":"You are not authorized to perform this action","action":"Please refer to documentation. CorrelationId: [id]","errorCode":40301} |
| Get-CsTeamsTenantAbuseConfiguration | refused | {"code":"Forbidden","message":"You are not authorized to perform this action","action":"Please refer to documentation. CorrelationId: [id]","errorCode":40301} |
| Get-CsTenant | error | A parameter cannot be found that matches parameter name 'ResultSize'. |
| Get-M365UnifiedCustomPendingApps | error |  |
| Get-M365UnifiedTenantSettings | error |  |
| Get-TeamsApp | refused | Error occurred while executing Code: Forbidden Message: Missing role permissions on the request. API requires one of 'AppCatalog.Read.All, AppCatalog.ReadWrite.All'. Roles on the request 'TeamMember.Read.All, Place.Read.All, CustomSecAttributeDefinition.Read.All, ExternalConnection.Read.All, DeviceManagementManagedDevices.Read.All, Printer.Read.All, Policy.Read.PermissionGrant, SharePointTenantSe |
| Get-TeamsArtifacts | error | EXPORT_TOOL.CLIENT_ID environment variable not set. |
| Get-TeamTargetingHierarchyStatus | error |  |
| Get-TenantPrivateChannelMigrationStatus | error | {"errors":[{"message":"S2S12040: Bearer_AppToken.IsApplicationIdValid returned false. The 'appid' or 'azp' claim found in token did not match any of the ValidApplicationIds specified in: 'Bearer_AppToken'. Claim value: '[PII of type 'System.String' is hidden]'.\r\nS2S12040: Bearer_CDT.IsApplicationIdValid returned false. The 'appid' or 'azp' claim found in token did not match any of the ValidAppli |

## Row 20: Viva Engage (Yammer)

Verdict: **app-only refused**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| Engage communities through Graph |  | refused | 403 | unauthorized |  | Authorization credentials are invalid. |
| Engage network settings (Yammer API) |  | refused | 401 |  |  |  |

## Row 21: Entra device registration settings

Verdict: **app-only works**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| device registration policy |  | works | 200 |  |  |  |

## Row 22: Entra password reset (SSPR) and per-user MFA service settings

Verdict: **nothing to call**

Not called: No public API for either. Nothing to call.

## Row 23: Microsoft 365 admin center org settings

Verdict: **app-only refused**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| Microsoft 365 Apps installation options |  | refused | 403 | Forbidden |  | Access is denied to the requested resource. The user or app might not have enough permission. |
| report privacy setting |  | refused | 403 | UnknownError |  | {"error":{"code":"S2SUnauthorized","message":"Invalid permission."}} |
| profile card properties |  | refused | 403 | forbidden |  | Authorization failed because of missing requirement(s). |
| apps and services settings |  | refused | 403 | UnknownError |  |  |
| To Do settings |  | refused | 403 | UnknownError |  |  |
| Dynamics 365 customer voice settings |  | refused | 403 | UnknownError |  |  |

Not called: Admin center settings outside Graph `/admin` have no public API.

## Row 24: Defender portal settings

Verdict: **app-only refused**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| custom detection rules |  | refused | 403 | Forbidden |  | Missing application roles. API required roles: CustomDetection.ReadWrite.All,CustomDetection.Read.All, application roles: TeamMember.Read.All,Place.Read.All,CustomSecAttributeDefinition.Read.All,ExternalConnection.Read.All,DeviceManagementManagedDevices.Read.All,Printer.Read.All,Policy.Read.PermissionGrant,SharePointTenantSettings.Read.All,SecurityEvents.Read.All,RoleManagement.Read.Directory,Grou |

Not called: Advanced features and notification rules have no public API.

## Row 25: Microsoft Forms

Verdict: **app-only refused**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| tenant Forms settings (not forms or answers) |  | refused | 403 | UnknownError |  |  |

Not called: Forms and their answers have no API.

## Row 26: Loop workspaces

Verdict: **nothing to call**

Not called: SharePoint Embedded containers of other apps are not open to a third-party app. Nothing to call.

## Row 27: Stream videos, Whiteboard, Clipchamp

Verdict: **nothing to call**

Not called: Stored as files in OneDrive and SharePoint; covered by the file backup.

## Row 28: Bookings

Verdict: **app-only refused**

| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |
|---|---|---|---|---|---|---|
| Bookings calendars |  | refused | 401 | UnknownError |  |  |
