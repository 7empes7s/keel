# ScubaGear rule coverage

Generated from CISA ScubaGear 2.0.0 (commit `6e5a1a4`, public domain) by `node tools/scubagear-rules.mjs report --write`. Do not edit by hand: a test fails when this file and the generator differ.

**109 rules** across 7 products. For each rule this lists what ScubaGear reads to check it and whether Keel reads the same data. Nothing here has run a rule yet; this is what will be possible when the rules run on Keel's backups.

## Summary

| Product | Rules | SHALL | SHOULD | 🟢 Ready | 🟡 Partly read | 🔴 Could not check | ⚪ Check by hand |
|---|---:|---:|---:|---:|---:|---:|---:|
| Entra ID | 34 | 23 | 11 | 30 | 0 | 1 | 3 |
| Exchange Online | 12 | 10 | 2 | 3 | 0 | 9 | 0 |
| Security Suite (Defender and Purview) | 24 | 9 | 15 | 18 | 0 | 3 | 3 |
| SharePoint and OneDrive | 8 | 8 | 0 | 0 | 8 | 0 | 0 |
| Teams | 14 | 4 | 10 | 11 | 0 | 3 | 0 |
| Power Platform | 9 | 5 | 4 | 2 | 0 | 5 | 2 |
| Power BI | 8 | 0 | 8 | 8 | 0 | 0 | 0 |
| **All** | **109** | **59** | **50** | **72** | **8** | **21** | **8** |

- 🟢 Ready: Keel reads everything it needs.
- 🟡 Partly read: Keel reads it through another API, some fields may be missing.
- 🔴 Could not check: Keel does not read an input it needs.
- ⚪ Check by hand: CISA has no automated check.

## What Keel does not read yet

Each row is one input. Reading it would move every listed rule out of "Could not check".

| Input | ScubaGear reads it with | Rules | Why Keel does not have it |
|---|---|---|---|
| `dmarc_records` | DNS TXT lookup (DMARC) | 4: MS.EXO.4.1v1, MS.EXO.4.2v1, MS.EXO.4.3v1, MS.EXO.4.4v1 | Public DNS. Keel does not do DNS lookups. |
| `environment_creation` | Get-PowerPlatformTenantSettingsRest | 4: MS.POWERPLATFORM.1.1v1, MS.POWERPLATFORM.1.2v1, MS.POWERPLATFORM.5.1v1, MS.POWERPLATFORM.6.1v1 | Keel does not read the Power Platform tenant settings. |
| `tenant_app_settings` | Teams org-wide app settings (unified app management API) | 3: MS.TEAMS.5.1v2, MS.TEAMS.5.2v2, MS.TEAMS.5.3v2 | Keel does not read the org-wide Teams app settings. ScubaGear itself can only read them with an interactive sign-in. |
| `sharing_policy` | Get-SharingPolicy | 2: MS.EXO.6.1v1, MS.EXO.6.2v1 | Keel does not run Get-SharingPolicy. |
| `spf_records` | DNS TXT lookup (SPF) | 2: MS.EXO.2.2v3, MS.EXO.3.1v1 | Public DNS. Keel does not do DNS lookups. |
| `admin_audit_log_config` | Get-AdminAuditLogConfig | 1: MS.SECURITYSUITE.5.1v1 | Keel does not run Get-AdminAuditLogConfig. |
| `built_in_protection_rules` | Get-ATPBuiltInProtectionRule | 1: MS.SECURITYSUITE.1.3v1 | Keel does not run Get-ATPBuiltInProtectionRule. |
| `dkim_records` | DNS TXT lookup (DKIM selectors) | 1: MS.EXO.3.1v1 | Public DNS. Keel does not do DNS lookups. |
| `protection_alerts` | Get-ProtectionAlert | 1: MS.SECURITYSUITE.4.1v1 | Keel blocks this cmdlet on purpose today (engine/collect/workloads/purviewRetentionDlp.mjs RETENTION_DLP_EXCLUDED_CMDLETS). |
| `risky_delegated_permission_classifications` | Get-ServicePrincipalsWithRiskyDelegatedPermissionClassifications | 1: MS.AAD.5.2v1 | Needs each service principal's delegated permission classifications, which Keel does not read. |
| `tenant_isolation` | Get-PowerPlatformTenantIsolationRest | 1: MS.POWERPLATFORM.3.1v1 | Keel does not read Power Platform tenant isolation. |
| `transport_config` | Get-TransportConfig | 1: MS.EXO.5.1v1 | Keel does not run Get-TransportConfig. |

## Entra ID

| Rule | Level | Keel | Statement | Inputs |
|---|---|---|---|---|
| MS.AAD.1.1v1 | SHALL | 🟢 Ready | Legacy authentication SHALL be blocked. | `conditional_access_policies` |
| MS.AAD.2.1v1 | SHALL | 🟢 Ready | Users detected as high risk SHALL be blocked. | `conditional_access_policies`, `service_plans` |
| MS.AAD.2.2v1 | SHOULD | ⚪ Check by hand | A notification SHOULD be sent to the administrator when high-risk users are detected. | none |
| MS.AAD.2.3v1 | SHALL | 🟢 Ready | Sign-ins detected as high-risk SHALL be blocked. | `conditional_access_policies`, `service_plans` |
| MS.AAD.3.1v1 | SHALL | 🟢 Ready | Phishing-resistant MFA SHALL be enforced for all users. | `conditional_access_policies` |
| MS.AAD.3.2v2 | SHALL | 🟢 Ready | MFA SHALL be enforced for all users. | `conditional_access_policies` |
| MS.AAD.3.3v2 | SHALL | 🟢 Ready | If Microsoft Authenticator is enabled, it SHALL be configured to show login context information. | `authentication_method`, `conditional_access_policies` |
| MS.AAD.3.4v1 | SHALL | 🟢 Ready | The "Authentication methods manage migration" feature SHALL be set to "Migration complete." | `authentication_method` |
| MS.AAD.3.5v2 | SHALL | 🟢 Ready | The authentication methods of short message service (SMS), voice call, and email one-time passcode (OTP) SHALL be disabled. | `authentication_method` |
| MS.AAD.3.6v1 | SHALL | 🟢 Ready | Phishing-resistant MFA SHALL be required for highly privileged roles. | `conditional_access_policies`, `privileged_roles` |
| MS.AAD.3.7v1 | SHOULD | 🟢 Ready | Managed devices SHOULD be required for authentication. | `conditional_access_policies` |
| MS.AAD.3.8v1 | SHOULD | 🟢 Ready | Managed devices SHOULD be required to register MFA. | `conditional_access_policies` |
| MS.AAD.3.9v1 | SHOULD | 🟢 Ready | Device code authentication SHOULD be blocked. | `conditional_access_policies` |
| MS.AAD.4.1v1 | SHALL | ⚪ Check by hand | Security logs SHALL be sent to the agency's security operations center for monitoring. | none |
| MS.AAD.5.1v1 | SHALL | 🟢 Ready | Only administrators SHALL be allowed to register applications. | `authorization_policies` |
| MS.AAD.5.2v1 | SHALL | 🔴 Could not check | User consent to applications SHALL be restricted. | `authorization_policies`, `risky_delegated_permission_classifications` (not read) |
| MS.AAD.5.3v1 | SHALL | 🟢 Ready | An administrative consent workflow SHALL be configured for applications. | `directory_settings` |
| MS.AAD.5.5v1 | SHOULD | 🟢 Ready | Application password addition SHOULD be blocked. | `app_management_policies`, `default_app_management_policy` |
| MS.AAD.5.6v1 | SHOULD | 🟢 Ready | Application password lifetime SHOULD be restricted to 180 days or less. | `app_management_policies`, `default_app_management_policy` |
| MS.AAD.5.7v1 | SHOULD | 🟢 Ready | Application certificate lifetime SHOULD be restricted to 365 days or less. | `app_management_policies`, `default_app_management_policy` |
| MS.AAD.6.1v1 | SHALL | 🟢 Ready | User passwords SHALL NOT expire. | `domain_settings` |
| MS.AAD.7.1v1 | SHALL | 🟢 Ready | A minimum of two users and a maximum of eight users SHALL be provisioned with the Global Administrator role. | `privileged_users` |
| MS.AAD.7.2v1 | SHALL | 🟢 Ready | Privileged users SHALL be provisioned with finer-grained roles instead of the Global Administrator role. | `privileged_users` |
| MS.AAD.7.3v1 | SHALL | 🟢 Ready | Privileged users SHALL be provisioned cloud-only accounts separate from an on-premises directory or other federated identity providers. | `privileged_users` |
| MS.AAD.7.4v1 | SHALL | 🟢 Ready | Permanent active role assignments SHALL NOT be allowed for highly privileged roles. | `privileged_roles`, `service_plans` |
| MS.AAD.7.5v1 | SHALL | 🟢 Ready | Provisioning users to highly privileged roles SHALL NOT occur outside of a PAM system. | `privileged_roles`, `service_plans` |
| MS.AAD.7.6v1 | SHALL | 🟢 Ready | Activation of the Global Administrator role SHALL require approval. | `privileged_roles`, `service_plans` |
| MS.AAD.7.7v1 | SHALL | 🟢 Ready | Eligible and active highly privileged role assignments SHALL trigger an alert. | `privileged_roles`, `service_plans` |
| MS.AAD.7.8v1 | SHALL | 🟢 Ready | User activation of the Global Administrator role SHALL trigger an alert. | `privileged_roles`, `service_plans` |
| MS.AAD.7.9v1 | SHOULD | 🟢 Ready | User activation of other highly privileged roles SHOULD trigger an alert. | `privileged_roles`, `service_plans` |
| MS.AAD.8.1v1 | SHOULD | 🟢 Ready | Guest users SHOULD have limited or restricted access to Microsoft Entra ID directory objects. | `authorization_policies` |
| MS.AAD.8.2v1 | SHOULD | 🟢 Ready | Only users with the "Guest Inviter" role SHOULD be able to invite guest users. | `authorization_policies` |
| MS.AAD.8.3v1 | SHOULD | ⚪ Check by hand | Guest invites SHOULD only be allowed to be sent to specific external domains that have been authorized by the agency for legitimate business purposes. | none |
| MS.AAD.9.1v1 | SHALL | 🟢 Ready | Risky AI agents SHALL be blocked. | `conditional_access_policies`, `license_information`, `service_plans` |

## Exchange Online

| Rule | Level | Keel | Statement | Inputs |
|---|---|---|---|---|
| MS.EXO.1.1v2 | SHALL | 🟢 Ready | Automatic forwarding to external domains SHALL be disabled. | `remote_domains` |
| MS.EXO.2.2v3 | SHALL | 🔴 Could not check | An SPF policy SHALL be published for each domain that fails all non-approved senders. | `spf_records` (not read) |
| MS.EXO.3.1v1 | SHOULD | 🔴 Could not check | DKIM SHOULD be enabled for all domains. | `dkim_config`, `dkim_records` (not read), `spf_records` (not read) |
| MS.EXO.4.1v1 | SHALL | 🔴 Could not check | A DMARC policy SHALL be published for every second-level domain. | `dmarc_records` (not read) |
| MS.EXO.4.2v1 | SHALL | 🔴 Could not check | The DMARC message rejection option SHALL be p=reject. | `dmarc_records` (not read) |
| MS.EXO.4.3v1 | SHALL | 🔴 Could not check | The DMARC point of contact for aggregate reports SHALL include `reports@dmarc.cyber.dhs.gov`. | `dmarc_records` (not read) |
| MS.EXO.4.4v1 | SHOULD | 🔴 Could not check | An agency point of contact SHOULD be included for aggregate and failure reports. | `dmarc_records` (not read) |
| MS.EXO.5.1v1 | SHALL | 🔴 Could not check | SMTP AUTH SHALL be disabled. | `transport_config` (not read) |
| MS.EXO.6.1v1 | SHALL | 🔴 Could not check | Contact folders SHALL NOT be shared with all domains. | `sharing_policy` (not read) |
| MS.EXO.6.2v1 | SHALL | 🔴 Could not check | Calendar details SHALL NOT be shared with all domains. | `sharing_policy` (not read) |
| MS.EXO.7.1v1 | SHALL | 🟢 Ready | External sender warnings SHALL be implemented. | `transport_rule` |
| MS.EXO.13.1v1 | SHALL | 🟢 Ready | Mailbox auditing SHALL be enabled. | `org_config` |

## Security Suite (Defender and Purview)

| Rule | Level | Keel | Statement | Inputs |
|---|---|---|---|---|
| MS.SECURITYSUITE.1.1v1 | SHALL | 🟢 Ready | Emails with click-to-run file attachments SHALL be blocked including, at a minimum, .exe, .cmd, and .vbe files. | `accepted_domains`, `anti_malware_policies`, `anti_malware_rules`, `protection_policy_rules` |
| MS.SECURITYSUITE.1.2v1 | SHALL | 🟢 Ready | Email scanning SHALL be capable of reviewing emails after delivery. | `accepted_domains`, `anti_malware_policies`, `anti_malware_rules`, `protection_policy_rules` |
| MS.SECURITYSUITE.1.3v1 | SHALL | 🔴 Could not check | Emails identified as containing malware SHALL be quarantined or dropped. | `accepted_domains`, `atp_policy_rules`, `built_in_protection_rules` (not read), `safe_attachment_policies`, `safe_attachment_rules` |
| MS.SECURITYSUITE.1.4v1 | SHOULD | 🟢 Ready | SharePoint, OneDrive, and Teams message attachments SHOULD be scanned for malware. | `atp_policy_for_o365` |
| MS.SECURITYSUITE.2.1v1 | SHOULD | 🟢 Ready | User impersonation protection SHOULD be enabled for sensitive accounts. | `accepted_domains`, `anti_phish_policies`, `anti_phish_rules`, `protection_policy_rules` |
| MS.SECURITYSUITE.2.2v1 | SHOULD | 🟢 Ready | Domain impersonation protection SHOULD be enabled for domains owned by the agency. | `accepted_domains`, `anti_phish_policies`, `anti_phish_rules`, `protection_policy_rules` |
| MS.SECURITYSUITE.2.3v1 | SHOULD | 🟢 Ready | Domain impersonation protection SHOULD be added for key suppliers and partners. | `accepted_domains`, `anti_phish_policies`, `anti_phish_rules`, `protection_policy_rules` |
| MS.SECURITYSUITE.2.4v1 | SHOULD | 🟢 Ready | User warnings, comparable to the user safety tips included with EOP, SHOULD be displayed. | `accepted_domains`, `anti_phish_policies`, `anti_phish_rules`, `protection_policy_rules` |
| MS.SECURITYSUITE.3.1v1 | SHALL | 🟢 Ready | A DLP policy SHALL be configured to protect PII and sensitive information, as defined by the agency, blocking at a minimum: credit card numbers, U.S. Individual Taxpayer Identification Numbers (ITIN), and U.S. Social Security numbers (SSN). | `dlp_compliance_policies`, `dlp_compliance_rules` |
| MS.SECURITYSUITE.3.2v1 | SHOULD | 🟢 Ready | The DLP policy SHOULD be applied to Exchange, OneDrive, SharePoint, Teams chat, and Devices. | `dlp_compliance_policies`, `dlp_compliance_rules` |
| MS.SECURITYSUITE.3.3v1 | SHOULD | 🟢 Ready | The action for the DLP policy SHOULD be set to block sharing sensitive information with everyone. | `dlp_compliance_policies`, `dlp_compliance_rules` |
| MS.SECURITYSUITE.3.4v1 | SHOULD | 🟢 Ready | Notifications to inform users and help educate them on the proper use of sensitive information SHOULD be enabled in the DLP policy. | `dlp_compliance_policies`, `dlp_compliance_rules` |
| MS.SECURITYSUITE.3.5v1 | SHOULD | ⚪ Check by hand | The DLP policy SHOULD include an action to block access to sensitive information by restricted applications and unwanted Bluetooth applications. | none |
| MS.SECURITYSUITE.4.1v1 | SHALL | 🔴 Could not check | At a minimum, the following alerts SHALL be enabled: | `protection_alerts` (not read) |
| MS.SECURITYSUITE.4.2v1 | SHOULD | ⚪ Check by hand | The alerts SHOULD be sent to a monitored address or incorporated into a Security Information and Event Management (SIEM). | none |
| MS.SECURITYSUITE.5.1v1 | SHALL | 🔴 Could not check | Unified audit logging SHALL be enabled. | `admin_audit_log_config` (not read) |
| MS.SECURITYSUITE.5.2v1 | SHALL | ⚪ Check by hand | Audit logs SHALL be retained and searchable for a minimum of 3 months and retrievable for a minimum of 12 months. | none |
| MS.SECURITYSUITE.6.1v1 | SHALL | 🟢 Ready | Emails detected as spam and phishing SHALL NOT be delivered to the user's inbox. | `accepted_domains`, `hosted_content_filter_policies`, `hosted_content_filter_rules`, `protection_policy_rules` |
| MS.SECURITYSUITE.6.2v1 | SHALL | 🟢 Ready | Allowed domains SHALL NOT be added to inbound anti-spam protection policies. | `accepted_domains`, `hosted_content_filter_policies`, `hosted_content_filter_rules`, `protection_policy_rules` |
| MS.SECURITYSUITE.7.1v1 | SHOULD | 🟢 Ready | URL comparison with a block-list SHOULD be enabled for URLs in emails, Teams messages, and Office documents. | `protection_policy_rules`, `safe_links_policies`, `safe_links_rules` |
| MS.SECURITYSUITE.7.2v1 | SHOULD | 🟢 Ready | Direct download links SHOULD be scanned for malware. | `protection_policy_rules`, `safe_links_policies`, `safe_links_rules` |
| MS.SECURITYSUITE.7.3v1 | SHOULD | 🟢 Ready | User click tracking SHOULD be enabled. | `protection_policy_rules`, `safe_links_policies`, `safe_links_rules` |
| MS.SECURITYSUITE.8.1v1 | SHOULD | 🟢 Ready | IP allow lists SHOULD NOT be created. | `conn_filter` |
| MS.SECURITYSUITE.8.2v1 | SHOULD | 🟢 Ready | Safe lists SHOULD NOT be enabled. | `conn_filter` |

## SharePoint and OneDrive

| Rule | Level | Keel | Statement | Inputs |
|---|---|---|---|---|
| MS.SHAREPOINT.1.1v1 | SHALL | 🟡 Partly read | External sharing for SharePoint SHALL be limited to "Existing guests" or "Only people in your organization." | `SPO_tenant` (partly read) |
| MS.SHAREPOINT.1.2v1 | SHALL | 🟡 Partly read | External sharing for OneDrive SHALL be limited to "Existing guests" or "Only people in your organization." | `SPO_tenant` (partly read) |
| MS.SHAREPOINT.1.3v1 | SHALL | 🟡 Partly read | External sharing SHALL be restricted to approved external domains and/or users in approved security groups per interagency collaboration needs. | `SPO_tenant` (partly read) |
| MS.SHAREPOINT.2.1v1 | SHALL | 🟡 Partly read | File and folder default sharing scope SHALL be set to "Specific people (only the people the user specifies)." | `SPO_tenant` (partly read) |
| MS.SHAREPOINT.2.2v1 | SHALL | 🟡 Partly read | File and folder default sharing permissions SHALL be set to view only. | `SPO_tenant` (partly read) |
| MS.SHAREPOINT.3.1v1 | SHALL | 🟡 Partly read | Expiration days for "Anyone" links SHALL be set to 30 days or less. | `SPO_tenant` (partly read) |
| MS.SHAREPOINT.3.2v1 | SHALL | 🟡 Partly read | The allowable file and folder permissions for links SHALL be set to view only. | `SPO_tenant` (partly read) |
| MS.SHAREPOINT.3.3v2 | SHALL | 🟡 Partly read | Reauthentication days for people who use a verification code SHALL be set to 30 days or less. | `SPO_tenant` (partly read) |

## Teams

| Rule | Level | Keel | Statement | Inputs |
|---|---|---|---|---|
| MS.TEAMS.1.1v1 | SHOULD | 🟢 Ready | External meeting participants SHOULD NOT be enabled to request control of shared desktops or windows. | `meeting_policies` |
| MS.TEAMS.1.2v2 | SHALL | 🟢 Ready | Anonymous users SHALL NOT be enabled to start Microsoft Teams meetings. | `meeting_policies` |
| MS.TEAMS.1.3v1 | SHOULD | 🟢 Ready | Anonymous users and dial-in callers SHOULD NOT be admitted automatically. | `meeting_policies` |
| MS.TEAMS.1.4v1 | SHOULD | 🟢 Ready | Internal users SHOULD be admitted to Microsoft Teams meetings automatically. | `meeting_policies` |
| MS.TEAMS.1.5v1 | SHOULD | 🟢 Ready | Dial-in users SHOULD NOT be enabled to bypass the lobby. | `meeting_policies` |
| MS.TEAMS.1.6v1 | SHOULD | 🟢 Ready | Meeting recording SHOULD be disabled. | `meeting_policies` |
| MS.TEAMS.1.7v2 | SHOULD | 🟢 Ready | "Record an event" SHOULD NOT be set to "Always record." | `broadcast_policies` |
| MS.TEAMS.2.1v2 | SHALL | 🟢 Ready | External access for users SHALL only be enabled on a per-domain basis. | `federation_configuration` |
| MS.TEAMS.2.2v2 | SHALL | 🟢 Ready | Unmanaged users SHALL NOT be enabled to initiate contact with internal users. | `federation_configuration` |
| MS.TEAMS.2.3v2 | SHOULD | 🟢 Ready | Internal users SHOULD NOT be enabled to initiate contact with unmanaged users. | `federation_configuration` |
| MS.TEAMS.4.1v1 | SHALL | 🟢 Ready | Microsoft Teams email integration SHALL be disabled. | `client_configuration` |
| MS.TEAMS.5.1v2 | SHOULD | 🔴 Could not check | Agencies SHOULD only allow installation of Microsoft applications approved by the agency. | `app_policies`, `tenant_app_settings` (not read) |
| MS.TEAMS.5.2v2 | SHOULD | 🔴 Could not check | Agencies SHOULD only allow installation of third-party applications approved by the agency. | `app_policies`, `tenant_app_settings` (not read) |
| MS.TEAMS.5.3v2 | SHOULD | 🔴 Could not check | Agencies SHOULD only allow installation of custom applications approved by the agency. | `app_policies`, `tenant_app_settings` (not read) |

## Power Platform

| Rule | Level | Keel | Statement | Inputs |
|---|---|---|---|---|
| MS.POWERPLATFORM.1.1v1 | SHALL | 🔴 Could not check | The ability to create production and sandbox environments SHALL be restricted to administrators. | `environment_creation` (not read) |
| MS.POWERPLATFORM.1.2v1 | SHALL | 🔴 Could not check | The ability to create trial environments SHALL be restricted to administrators. | `environment_creation` (not read) |
| MS.POWERPLATFORM.2.1v1 | SHALL | 🟢 Ready | A DLP policy SHALL be created to restrict connector access in the default Power Platform environment. | `dlp_policies` |
| MS.POWERPLATFORM.2.2v1 | SHOULD | 🟢 Ready | Non-default environments SHOULD have at least one DLP policy. | `dlp_policies`, `environment_list` |
| MS.POWERPLATFORM.3.1v1 | SHALL | 🔴 Could not check | Power Platform tenant isolation SHALL be enabled. | `tenant_isolation` (not read) |
| MS.POWERPLATFORM.3.2v1 | SHOULD | ⚪ Check by hand | An inbound/outbound connection allowlist SHOULD be configured. | none |
| MS.POWERPLATFORM.4.1v1 | SHALL | ⚪ Check by hand | Content Security Policy (CSP) SHALL be enforced for model-driven and canvas Power Apps. | none |
| MS.POWERPLATFORM.5.1v1 | SHOULD | 🔴 Could not check | The ability to create Power Pages sites SHOULD be restricted to administrators. | `environment_creation` (not read) |
| MS.POWERPLATFORM.6.1v1 | SHOULD | 🔴 Could not check | The "Share with everyone" feature SHOULD be disabled. | `environment_creation` (not read) |

## Power BI

| Rule | Level | Keel | Statement | Inputs |
|---|---|---|---|---|
| MS.POWERBI.1.1v1 | SHOULD | 🟢 Ready | The "Publish to Web" feature SHOULD be disabled unless the agency mission requires the capability. | `powerbi_tenant_settings` |
| MS.POWERBI.2.1v1 | SHOULD | 🟢 Ready | Guest user access to the Power BI tenant SHOULD be disabled unless the agency mission requires the capability. | `powerbi_tenant_settings` |
| MS.POWERBI.3.1v1 | SHOULD | 🟢 Ready | The "Invite external users to your organization" feature SHOULD be disabled unless agency mission requires the capability. | `powerbi_tenant_settings` |
| MS.POWERBI.4.1v1 | SHOULD | 🟢 Ready | Service principals with access to APIs SHOULD be restricted to specific security groups. | `powerbi_tenant_settings` |
| MS.POWERBI.4.2v1 | SHOULD | 🟢 Ready | Service principals' ability to create and use profiles SHOULD be restricted to specific security groups. | `powerbi_tenant_settings` |
| MS.POWERBI.5.1v1 | SHOULD | 🟢 Ready | ResourceKey-based authentication SHOULD be blocked unless a specific use case (e.g., streaming and/or "push" datasets) merits its use. | `powerbi_tenant_settings` |
| MS.POWERBI.6.1v1 | SHOULD | 🟢 Ready | Python and R interactions SHOULD be disabled. | `powerbi_tenant_settings` |
| MS.POWERBI.7.1v1 | SHOULD | 🟢 Ready | Sensitivity labels SHOULD be enabled for Power BI and employed for sensitive data per enterprise data protection policies. | `powerbi_tenant_settings` |

## Technical details

- Rule ids the Rego still reports but no baseline lists (left out of the counts): MS.POWERPLATFORM.2.3v1.
- Rules whose NIST mapping is in the baseline but has no row in CISA's CSV: MS.AAD.5.5v1, MS.AAD.5.6v1, MS.AAD.5.7v1, MS.POWERPLATFORM.6.1v1.
- Rules where CISA's CSV and the baseline disagree (the baseline is used): MS.SECURITYSUITE.1.4v1 (baseline SI-3; CSV SI-3a); MS.SECURITYSUITE.2.4v1 (baseline AT-2b, SI-8; CSV SI-8); MS.SECURITYSUITE.3.3v1 (baseline AC-3, SC-7(10); CSV SC-7(10)).
- Inputs are found by reading the Rego statically, following helper rules; a rule may be listed as reading an input on a branch it does not always take.
- Run settings (ScubaGear config, module version, tenant id) and run status (licence flags derived from Keel's own reads) are supplied by Keel and are not listed as inputs above.
