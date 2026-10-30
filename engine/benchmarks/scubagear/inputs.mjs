/**
 * Every key of ScubaGear's input document that a v2.0.0 rule reads, and where Keel gets
 * the same data. This is the contract the per-product adapters (follow-up work) will
 * build ScubaGear's document from. It is kept per input key, never per rule, so a new
 * upstream rule that reads known keys needs no change here.
 *
 * `from` is what ScubaGear itself calls (its provider's cmdlet, Graph call or DNS
 * lookup). `keel` lists Keel's own reads of the same data:
 *  - `graph:<type>` is a type in tools/tenant-probe/catalog.mjs;
 *  - anything else is an id in engine/collect/workloadContract.mjs WORKLOAD_DESCRIPTORS.
 * A test checks every listed read exists, so a renamed or removed read shows up here.
 *
 * `state`:
 *  - read: Keel reads the same object;
 *  - partial: Keel reads the same settings through another API that may not carry every
 *    field the rules use (the adapter confirms field by field);
 *  - not-read: Keel does not read it today, so rules that need it read "could not check";
 *  - run-setting: not tenant data; Keel supplies it for the run (ScubaGear's own config
 *    file, its version, the tenant id);
 *  - run-status: not tenant data; derived from how Keel's own read went (for example
 *    "not licensed" when Defender for Office 365 cmdlets are missing).
 */
export const INPUT_STATES = Object.freeze(['read', 'partial', 'not-read', 'run-setting', 'run-status']);

const entry = (product, from, state, keel = [], note = null) => Object.freeze({ product, from, state, keel: Object.freeze(keel), note });

export const SCUBA_INPUT_SOURCES = Object.freeze({
  // Run settings: Keel supplies these itself.
  scuba_config: entry('all', 'ScubaGear config file', 'run-setting', [], 'Exclusions and options. Keel passes its own settings (none by default).'),
  module_version: entry('all', 'ScubaGear module version', 'run-setting', [], 'Used only to build links to the baseline text.'),
  tenant_id: entry('powerplatform', 'Tenant id', 'run-setting', ['graph:organization']),

  // Entra ID
  conditional_access_policies: entry('aad', 'Get-MgBetaIdentityConditionalAccessPolicy', 'read', ['graph:conditionalAccessPolicy']),
  authorization_policies: entry('aad', 'Get-MgBetaPolicyAuthorizationPolicy', 'read', ['graph:authorizationPolicy']),
  authentication_method: entry('aad', 'Get-MgBetaPolicyAuthenticationMethodPolicy', 'read', ['graph:authenticationMethodsPolicy']),
  directory_settings: entry('aad', 'Get-MgBetaDirectorySetting', 'read', ['graph:groupSetting']),
  domain_settings: entry('aad', 'Get-MgBetaDomain', 'read', ['graph:domain']),
  service_plans: entry('aad', 'Get-MgBetaSubscribedSku (service plans)', 'read', ['graph:subscribedSku']),
  license_information: entry('aad', 'Get-MgBetaSubscribedSku', 'read', ['graph:subscribedSku']),
  default_app_management_policy: entry('aad', 'Get-MgBetaPolicyDefaultAppManagementPolicy', 'read', ['graph:tenantAppManagementPolicy']),
  app_management_policies: entry('aad', 'Get-MgBetaPolicyAppManagementPolicy and the apps each applies to', 'read',
    ['graph:appManagementPolicy', 'graph:application', 'graph:servicePrincipal']),
  privileged_users: entry('aad', 'Get-PrivilegedUser (role members, PIM eligibility, group members)', 'read',
    ['graph:roleAssignment', 'graph:roleEligibilitySchedule', 'graph:roleAssignmentSchedule', 'graph:directoryRole', 'graph:user', 'graph:group', 'graph:servicePrincipal'],
    'ScubaGear builds this list from several reads; the adapter builds it from the same objects in the backup.'),
  privileged_roles: entry('aad', 'Get-PrivilegedRole (role templates, PIM rules and assignments)', 'read',
    ['graph:roleDefinition', 'graph:unifiedRoleManagementPolicy', 'graph:unifiedRoleManagementPolicyAssignment', 'graph:roleAssignmentSchedule', 'graph:roleEligibilitySchedule']),
  risky_delegated_permission_classifications: entry('aad', 'Get-ServicePrincipalsWithRiskyDelegatedPermissionClassifications', 'not-read', [],
    'Needs each service principal\'s delegated permission classifications, which Keel does not read.'),

  // Exchange Online
  remote_domains: entry('exo', 'Get-RemoteDomain', 'read', ['mailflow.remote-domains']),
  accepted_domains: entry('exo', 'Get-AcceptedDomain', 'read', ['mailflow.accepted-domains']),
  dkim_config: entry('exo', 'Get-DkimSigningConfig', 'read', ['mailflow.dkim-signing']),
  transport_rule: entry('exo', 'Get-TransportRule', 'read', ['mailflow.transport-rules']),
  org_config: entry('exo', 'Get-OrganizationConfig', 'read', ['exchange.organization-config']),
  transport_config: entry('exo', 'Get-TransportConfig', 'not-read', [], 'Keel does not run Get-TransportConfig.'),
  sharing_policy: entry('exo', 'Get-SharingPolicy', 'not-read', [], 'Keel does not run Get-SharingPolicy.'),
  spf_records: entry('exo', 'DNS TXT lookup (SPF)', 'not-read', [], 'Public DNS. Keel does not do DNS lookups.'),
  dkim_records: entry('exo', 'DNS TXT lookup (DKIM selectors)', 'not-read', [], 'Public DNS. Keel does not do DNS lookups.'),
  dmarc_records: entry('exo', 'DNS TXT lookup (DMARC)', 'not-read', [], 'Public DNS. Keel does not do DNS lookups.'),

  // Security Suite (Defender for Office 365, Exchange Online Protection, Purview)
  protection_policy_rules: entry('securitysuite', 'Get-EOPProtectionPolicyRule', 'read', ['exchange-extended.eop-preset-rules']),
  atp_policy_rules: entry('securitysuite', 'Get-ATPProtectionPolicyRule', 'read', ['exchange-extended.defender-preset-rules']),
  atp_policy_for_o365: entry('securitysuite', 'Get-AtpPolicyForO365', 'read', ['exchange-extended.defender-office-apps']),
  anti_phish_policies: entry('securitysuite', 'Get-AntiPhishPolicy', 'read', ['mailflow.anti-phish-policies']),
  anti_phish_rules: entry('securitysuite', 'Get-AntiPhishRule', 'read', ['exchange-extended.anti-phish-rules']),
  anti_malware_policies: entry('securitysuite', 'Get-MalwareFilterPolicy', 'read', ['mailflow.anti-malware-policies']),
  anti_malware_rules: entry('securitysuite', 'Get-MalwareFilterRule', 'read', ['exchange-extended.anti-malware-rules']),
  safe_attachment_policies: entry('securitysuite', 'Get-SafeAttachmentPolicy', 'read', ['mailflow.safe-attachment-policies']),
  safe_attachment_rules: entry('securitysuite', 'Get-SafeAttachmentRule', 'read', ['exchange-extended.safe-attachment-rules']),
  safe_links_policies: entry('securitysuite', 'Get-SafeLinksPolicy', 'read', ['mailflow.safe-links-policies']),
  safe_links_rules: entry('securitysuite', 'Get-SafeLinksRule', 'read', ['exchange-extended.safe-links-rules']),
  hosted_content_filter_policies: entry('securitysuite', 'Get-HostedContentFilterPolicy', 'read', ['mailflow.anti-spam-policies']),
  hosted_content_filter_rules: entry('securitysuite', 'Get-HostedContentFilterRule', 'read', ['exchange-extended.anti-spam-rules']),
  conn_filter: entry('securitysuite', 'Get-HostedConnectionFilterPolicy', 'read', ['exchange-extended.connection-filter-policies']),
  dlp_compliance_policies: entry('securitysuite', 'Get-DlpCompliancePolicy', 'read', ['purview.dlp-policies']),
  dlp_compliance_rules: entry('securitysuite', 'Get-DlpComplianceRule', 'read', ['purview.dlp-rules']),
  built_in_protection_rules: entry('securitysuite', 'Get-ATPBuiltInProtectionRule', 'not-read', [], 'Keel does not run Get-ATPBuiltInProtectionRule.'),
  admin_audit_log_config: entry('securitysuite', 'Get-AdminAuditLogConfig', 'not-read', [], 'Keel does not run Get-AdminAuditLogConfig.'),
  protection_alerts: entry('securitysuite', 'Get-ProtectionAlert', 'not-read', [],
    'Keel blocks this cmdlet on purpose today (engine/collect/workloads/purviewRetentionDlp.mjs RETENTION_DLP_EXCLUDED_CMDLETS).'),
  defender_license: entry('securitysuite', 'Whether the Defender for Office 365 cmdlets ran', 'run-status',
    ['exchange-extended.defender-office-apps', 'exchange-extended.defender-preset-rules'], 'Keel records these reads as not licensed when the cmdlets are missing.'),
  defender_dlp_license: entry('securitysuite', 'Whether the Purview DLP cmdlets ran', 'run-status', ['purview.dlp-policies', 'purview.dlp-rules']),

  // SharePoint and OneDrive
  SPO_tenant: entry('sharepoint', 'Get-SPOTenantRest (SharePoint admin tenant properties)', 'partial',
    ['sharepoint.tenant-settings', 'onedrive.site-settings'],
    'Keel reads tenant sharing settings through Graph, which may not carry every SharePoint admin field these rules use (for example anonymous link expiry and default link type).'),

  // Teams
  meeting_policies: entry('teams', 'Get-CsTeamsMeetingPolicy', 'read', ['teams.meeting-policies']),
  federation_configuration: entry('teams', 'Get-CsTenantFederationConfiguration', 'read', ['teams.federation-configuration']),
  client_configuration: entry('teams', 'Get-CsTeamsClientConfiguration', 'read', ['teams.client-configuration']),
  app_policies: entry('teams', 'Get-CsTeamsAppPermissionPolicy', 'read', ['teams.app-permission-policies']),
  broadcast_policies: entry('teams', 'Get-CsTeamsMeetingBroadcastPolicy', 'read', ['teams.live-events-policies']),
  tenant_app_settings: entry('teams', 'Teams org-wide app settings (unified app management API)', 'not-read', [],
    'Keel does not read the org-wide Teams app settings. ScubaGear itself can only read them with an interactive sign-in.'),

  // Power Platform
  dlp_policies: entry('powerplatform', 'Get-PowerPlatformDlpPoliciesRest', 'read', ['powerplatform.dlp-policies']),
  environment_list: entry('powerplatform', 'Get-PowerPlatformEnvironmentsRest', 'read', ['powerplatform.environments']),
  environment_creation: entry('powerplatform', 'Get-PowerPlatformTenantSettingsRest', 'not-read', [], 'Keel does not read the Power Platform tenant settings.'),
  tenant_isolation: entry('powerplatform', 'Get-PowerPlatformTenantIsolationRest', 'not-read', [], 'Keel does not read Power Platform tenant isolation.'),

  // Power BI
  powerbi_tenant_settings: entry('powerbi', 'Fabric admin API: tenant settings', 'read', ['powerbi.tenant-settings'],
    'Read through the Fabric read-only admin API; it needs a Fabric tenant setting (workloadContract.mjs FABRIC_READ_ONLY_ADMIN_SETUP), not a Power BI permission.'),
  powerbi_license_found: entry('powerbi', 'Whether the tenant has Power BI', 'run-status', ['powerbi.tenant-settings']),
  powerbi_license_reason: entry('powerbi', 'Why Power BI was not found', 'run-status', ['powerbi.tenant-settings']),
  powerbi_access_denied_reason: entry('powerbi', 'Why the Power BI read was refused', 'run-status', ['powerbi.tenant-settings']),
});
