/**
 * The words people use for Microsoft cloud services, settings and security concepts,
 * mapped to the kinds KEEL backs up (engine/insights/taxonomy.mjs and the collected
 * descriptors). engine/query/intent.mjs reads a question with these tables; every kind
 * named here must be one KEEL knows, which engine/roadmap/grounded-query.test.mjs checks.
 *
 * Each table is data only: a pattern, the kinds it stands for, and the words the
 * answer uses to say how the question was read.
 */

/** Words for a service, current and old product names, matched to the taxonomy's service names. */
export const SERVICE_WORDS = Object.freeze([
  [/\b(?:microsoft )?entra(?: id)?\b|\bazure (?:ad|active directory)\b|\baad\b|\bidentity platform\b/i, 'Entra'],
  [/\bintune\b|\b(?:microsoft )?endpoint manager\b|\bmem(?:cm)?\b|\bendpoint management\b/i, 'Intune'],
  [/\bexchange(?: online)?\b|\bexo\b/i, 'Exchange'],
  [/\b(?:ms |microsoft )?teams\b/i, 'Teams'],
  [/\bsharepoint(?: online)?\b|\bspo\b|\bonedrive(?: for business)?\b|\bodfb\b/i, 'SharePoint'],
  [/\b(?:microsoft )?purview\b|\bcompliance (?:center|centre|portal)\b|\bsecurity (?:&|and) compliance\b/i, 'Purview'],
  [/\bpower platform\b|\bpower ?apps\b|\bpower automate\b|\bpower ?bi\b|\bfabric\b|\bdataverse\b|\bpower pages\b|\bcopilot studio\b/i, 'Power Platform'],
  [/\b(?:microsoft )?defender(?: xdr)?\b|\bmicrosoft 365 defender\b|\bsecurity center\b|\bmdi\b|\bmdca\b|\bmcas\b/i, 'Defender'],
]);

/**
 * Words for one kind each. An exact kind name from the taxonomy ("Named location") is
 * read before these; these are the other ways people say it.
 */
export const TYPE_WORDS = Object.freeze([
  [/\b(?:conditional access|ca)(?: polic(?:y|ies)| rules?)?\b|\bcaps?\b/i, 'conditionalAccessPolicy'],
  [/\bnamed locations?\b|\btrusted (?:ips?|locations?|networks?)\b|\bcountry locations?\b/i, 'namedLocation'],
  [/\brole assignments?\b/i, 'roleAssignment'],
  [/\b(?:enterprise (?:apps?|applications?)|service principals?|spns?)\b/i, 'servicePrincipal'],
  [/\bapp registrations?\b|\bregistered apps?\b/i, 'application'],
  [/\b(?:security |m365 |microsoft 365 |distribution |dynamic )?groups?\b/i, 'group'],
  [/\b(?:users?|accounts?|identities)\b/i, 'user'],
  [/\bauthori[sz]ation polic(?:y|ies)\b|\buser settings\b/i, 'authorizationPolicy'],
  [/\bdevice (?:configurations?|config(?:uration)? profiles?|restrictions?)\b|\bconfiguration profiles?\b/i, 'deviceConfiguration'],
  [/\bsecurity defaults?\b/i, 'identitySecurityDefaultsEnforcementPolicy'],
  [/\b(?:licen[cs]es?|skus?|subscriptions?)\b/i, 'subscribedSku'],
  [/\b(?:custom )?domains?\b/i, 'domain'],
  [/\badministrative units?\b|\badmin units?\b/i, 'administrativeUnit'],
  [/\b(?:managed|enrolled|intune) devices?\b|\bdevice inventory\b/i, 'managedDevice'],
  [/\bsettings catalog\b|\bendpoint security polic(?:y|ies)\b/i, 'configurationPolicy'],
  [/\bterms of use\b|\btou\b/i, 'agreement'],
  [/\bcopilot connectors?\b|\bgraph connectors?\b/i, 'externalConnection'],
  [/\bmail flow\b|\btransport rules?\b|\bconnectors? for mail\b/i, 'exchange-mail-flow'],
  [/\bsensitivity labels?\b|\b(?:mip|aip)(?: labels?)?\b|\binformation protection labels?\b/i, 'purview-labels'],
  [/\bscope tags?\b/i, 'roleScopeTag'],
  [/\bassignment filters?\b/i, 'assignmentFilter'],
  [/\bremediations?(?: scripts?)?\b|\bproactive remediations?\b/i, 'deviceHealthScript'],
  [/\bcompany branding\b|\bsign-in page branding\b/i, 'organizationalBranding'],
  [/\bmulti[- ]?admin approvals?\b|\bmaa\b/i, 'operationApprovalPolicy'],
]);

/**
 * Concepts that span several kinds: security and compliance words, product features and
 * abbreviations. `label` is what the answer says the word was read as.
 */
export const CONCEPT_WORDS = Object.freeze([
  {
    pattern: /\b(?:pim|privileged identity management|eligible (?:admin )?roles?|eligible assignments?|just[- ]in[- ]time(?: access)?|jit(?: access)?|role activations?)\b/i,
    label: 'Privileged Identity Management: eligible and time-limited admin roles and their activation settings',
    kinds: ['roleEligibilitySchedule', 'roleAssignmentSchedule', 'unifiedRoleManagementPolicy', 'unifiedRoleManagementPolicyAssignment', 'privilegedAccessGroupResource', 'roleManagementCustomExtension'],
  },
  {
    pattern: /\b(?:admin(?:istrator)? (?:roles?|rights|permissions|accounts?)|privileged (?:roles?|access|accounts?)|directory roles?|role[- ]based access(?: control)?|rbac|(?:global |privileged |tenant )administrators?|(?:global |privileged |tenant )admins?|administrators|admins)\b/i,
    label: 'admin roles and who holds them, in Entra, Intune, Exchange and Defender',
    kinds: ['directoryRole', 'roleDefinition', 'roleAssignment', 'roleEligibilitySchedule', 'roleAssignmentSchedule', 'deviceManagementRoleDefinition', 'deviceManagementRoleAssignment', 'exchangeRoleDefinition', 'exchangeRoleAssignment', 'exchange-role-groups', 'defenderRoleDefinition', 'defenderRoleAssignment', 'entitlementManagementRoleAssignment'],
  },
  {
    pattern: /\b(?:mfa|multi[- ]?factor(?: authentication)?|2fa|two[- ]factor(?: authentication)?|2sv|two[- ]step(?: verification)?|strong authentication)\b/i,
    label: 'sign-in method settings, authentication strengths, Conditional Access policies and security defaults',
    kinds: ['authenticationMethodsPolicy', 'authenticationStrengthPolicy', 'conditionalAccessPolicy', 'identitySecurityDefaultsEnforcementPolicy'],
  },
  {
    pattern: /\b(?:passwordless|fido2?|passkeys?|security keys?|(?:microsoft )?authenticator(?: app)?|windows hello|temporary access pass(?:es)?|sms sign-in|authentication methods?|sign-in methods?)\b/i,
    label: 'the authentication methods policy and authentication strengths',
    kinds: ['authenticationMethodsPolicy', 'authenticationStrengthPolicy'],
  },
  {
    pattern: /\b(?:certificate[- ]based (?:auth(?:entication)?|sign-in)|cba|smart ?cards?)\b/i,
    label: 'certificate sign-in settings and app certificate authority trust',
    kinds: ['certificateBasedAuthConfiguration', 'certificateBasedApplicationConfiguration'],
  },
  {
    pattern: /\b(?:guest(?:s| users?| accounts?)? (?:access|settings?|permissions?|invit(?:e|es|ations?)|restrictions?|sign-?ups?)|b2b(?: collaboration)?|external (?:identities|collaboration)(?: settings?)?|invit(?:e|es|ation|ations) settings?)\b/i,
    label: 'guest permission, invitation, external sign-up and cross-tenant access settings',
    kinds: ['authorizationPolicy', 'b2bManagementPolicy', 'externalIdentitiesPolicy', 'authenticationFlowsPolicy', 'b2xIdentityUserFlow', 'externalDomainFederation', 'crossTenantAccessPolicy', 'crossTenantAccessPolicyConfigurationDefault', 'crossTenantAccessPolicyPartner', 'connectedOrganization'],
  },
  {
    pattern: /\b(?:guest users?|guest accounts?|external users?|external guests?|guests?)\b/i,
    label: 'users (an answer cannot yet show guests apart from members, so every user is included)',
    kinds: ['user'],
  },
  {
    pattern: /\b(?:external sharing|sharing (?:settings?|links?|polic(?:y|ies))|anonymous (?:links?|sharing|access)|anyone links?|share externally|shared externally|file sharing|sharing)\b/i,
    label: 'SharePoint and OneDrive sharing settings, cross-tenant sharing and guest invitation limits',
    kinds: ['sharepointSettings', 'sharepoint-site-settings', 'onedrive-site-settings', 'crossTenantM365Capability', 'b2bManagementPolicy'],
  },
  {
    pattern: /\b(?:cross[- ]tenant(?: access| sync(?:hroni[sz]ation)?| settings?)?|b2b direct connect|tenant restrictions?|multi[- ]?tenant organi[sz]ations?|mto)\b/i,
    label: 'cross-tenant access and sync settings',
    kinds: ['crossTenantAccessPolicy', 'crossTenantAccessPolicyConfigurationDefault', 'crossTenantAccessPolicyPartner', 'crossTenantIdentitySyncPolicyPartner', 'crossTenantM365Capability', 'multiTenantOrganization', 'multiTenantOrganizationIdentitySyncPolicyTemplate', 'multiTenantOrganizationPartnerConfigurationTemplate'],
  },
  {
    pattern: /\b(?:(?:app |admin |user |oauth )?consents?|oauth(?:2)?(?: grants?| permissions?)?|delegated permissions?|api permissions?|permission grants?)\b/i,
    label: 'delegated app consents, consent policies and admin consent requests',
    kinds: ['oauth2PermissionGrant', 'permissionGrantPolicy', 'adminConsentRequestPolicy', 'permissionGrantPreApprovalPolicy'],
  },
  {
    pattern: /\b(?:app (?:secrets?|credentials?|certificates?)|client secrets?|credential polic(?:y|ies))\b/i,
    label: 'app credential rules',
    kinds: ['appManagementPolicy', 'tenantAppManagementPolicy'],
  },
  {
    pattern: /\b(?:federation|federated domains?|saml|ws-fed|identity providers?|idps?|social (?:sign-in|login))\b/i,
    label: 'federation and external identity providers',
    kinds: ['domain', 'externalDomainFederation', 'identityProvider', 'homeRealmDiscoveryPolicy'],
  },
  {
    pattern: /\b(?:tokens?(?: lifetime| issuance| claims)?|session (?:lifetime|timeout)s?|idle (?:sign-out|timeout)|claims mapping)\b/i,
    label: 'token and session settings',
    kinds: ['tokenLifetimePolicy', 'tokenIssuancePolicy', 'claimsMappingPolicy', 'activityBasedTimeoutPolicy'],
  },
  {
    pattern: /\b(?:access reviews?|recertifications?|attestations?)\b/i,
    label: 'access reviews and their settings',
    kinds: ['accessReviewScheduleDefinition', 'accessReviewPolicy', 'directoryRoleAccessReviewPolicy'],
  },
  {
    pattern: /\b(?:identity governance|entitlement management|access packages?|catalogs?)\b/i,
    label: 'access packages, catalogs, their policies and assignments',
    kinds: ['accessPackage', 'accessPackageCatalog', 'accessPackageAssignmentPolicy', 'accessPackageAssignment', 'accessPackageResourceRoleScope', 'connectedOrganization', 'entitlementManagementSettings', 'entitlementManagementRoleAssignment', 'externalOriginResourceConnector'],
  },
  {
    pattern: /\b(?:lifecycle workflows?|joiner|mover|leaver|jml|onboarding workflows?|offboarding)\b/i,
    label: 'lifecycle workflows',
    kinds: ['lifecycleWorkflow', 'lifecycleWorkflowCustomTaskExtension', 'lifecycleManagementSettings'],
  },
  {
    pattern: /\b(?:provisioning|scim|user sync|directory sync|entra connect(?: sync)?|azure ad connect|aad connect|cloud sync)\b/i,
    label: 'provisioning and sync jobs',
    kinds: ['synchronizationJob', 'crossTenantIdentitySyncPolicyPartner'],
  },
  {
    pattern: /\b(?:custom security attributes?|security attributes?)\b/i,
    label: 'custom security attributes and their sets',
    kinds: ['customSecurityAttributeDefinition', 'attributeSet'],
  },
  {
    pattern: /\b(?:device compliance|compliance polic(?:y|ies)|compliant devices?|non[- ]?compliant(?: devices?)?|compliance scripts?)\b/i,
    label: 'device compliance policies and compliance scripts',
    kinds: ['deviceCompliancePolicy', 'deviceManagementCompliancePolicy', 'deviceComplianceScript', 'notificationMessageTemplate'],
  },
  {
    pattern: /\b(?:(?:security |intune |windows |mde )?baselines?|cis (?:benchmarks?|baselines?)|benchmarks?)\b/i,
    label: 'Intune security baselines and settings catalog policies (KEEL’s own compliance baselines are on the Baselines page)',
    kinds: ['deviceManagementIntent', 'configurationPolicy', 'userExperienceAnalyticsBaseline'],
  },
  {
    pattern: /\b(?:app protection(?: polic(?:y|ies))?|mam(?: polic(?:y|ies))?|mobile application management|app configuration(?: polic(?:y|ies))?)\b/i,
    label: 'app protection and app configuration policies',
    kinds: ['managedAppPolicy', 'windowsManagedAppProtection', 'targetedManagedAppConfiguration', 'mobileAppConfiguration'],
  },
  {
    pattern: /\b(?:managed apps?|app deployments?|line[- ]of[- ]business apps?|lob apps?|win32 apps?|store apps?|company portal apps?)\b/i,
    label: 'managed apps',
    kinds: ['mobileApp', 'mobileAppCategory', 'mobileAppRelationship'],
  },
  {
    pattern: /\b(?:autopilot|device preparation)\b/i,
    label: 'Windows Autopilot profiles and devices',
    kinds: ['windowsAutopilotDeploymentProfile', 'windowsAutopilotDeviceIdentity'],
  },
  {
    pattern: /\b(?:enrol(?:l)?ment(?: restrictions?| profiles?| settings?)?|enrol(?:l)?ing|ade|dep|apple business manager|abm|android enterprise|zero[- ]touch)\b/i,
    label: 'device enrollment settings and profiles',
    kinds: ['deviceEnrollmentConfiguration', 'androidDeviceOwnerEnrollmentProfile', 'androidForWorkEnrollmentProfile', 'appleUserInitiatedEnrollmentProfile', 'depOnboardingSetting', 'androidManagedStoreAccountEnterpriseSettings', 'deviceRegistrationPolicy'],
  },
  {
    pattern: /\b(?:windows updates?|update rings?|wufb|windows update for business|feature updates?|quality updates?|driver updates?|patch(?:es|ing)?|hotpatch)\b/i,
    label: 'Windows update profiles and policies',
    kinds: ['windowsFeatureUpdateProfile', 'windowsQualityUpdateProfile', 'windowsDriverUpdateProfile', 'windowsQualityUpdatePolicy'],
  },
  {
    pattern: /\b(?:gpos?|group polic(?:y|ies)|admx|administrative templates?)\b/i,
    label: 'administrative templates',
    kinds: ['groupPolicyConfiguration', 'groupPolicyUploadedDefinitionFile'],
  },
  {
    pattern: /\b(?:scripts?|powershell|shell scripts?)\b/i,
    label: 'Intune scripts',
    kinds: ['deviceManagementScript', 'deviceShellScript', 'deviceHealthScript', 'deviceComplianceScript', 'deviceCustomAttributeShellScript'],
  },
  {
    pattern: /\b(?:mde|defender for endpoint|antivirus|anti-virus|edr|endpoint detection|attack surface reduction|asr(?: rules)?|firewall|bitlocker|disk encryption|endpoint security)\b/i,
    label: 'Defender for Endpoint settings managed in Intune: endpoint security and baseline policies, and the threat defense connector',
    kinds: ['configurationPolicy', 'deviceManagementIntent', 'mobileThreatDefenseConnector'],
  },
  {
    pattern: /\b(?:mdo|defender for office(?: 365)?|atp|eop|exchange online protection|safe links|safe attachments|anti-?spam|anti-?phishing|anti-?malware|spam filters?|phishing protection|quarantine)\b/i,
    label: 'Exchange mail flow, protection and filtering settings',
    kinds: ['exchange-mail-flow', 'exchange-extended'],
  },
  {
    pattern: /\b(?:attack simulations?|phishing simulations?|simulated phishing|security awareness training)\b/i,
    label: 'attack simulations and their automations',
    kinds: ['attackSimulation', 'simulationAutomation'],
  },
  {
    pattern: /\b(?:dlp|data loss prevention|data leak(?:age)? prevention)\b/i,
    label: 'data loss prevention and retention policies',
    kinds: ['purview-retention-dlp'],
  },
  {
    pattern: /\b(?:retention(?: polic(?:y|ies)| labels?)?|records management|legal holds?|litigation holds?)\b/i,
    label: 'retention policies and labels',
    kinds: ['purview-retention-dlp', 'purview-governance'],
  },
  {
    pattern: /\b(?:e-?discovery|content search|auto-?label(?:l)?ing)\b/i,
    label: 'eDiscovery, auto-labelling and retention label settings',
    kinds: ['purview-governance'],
  },
  {
    pattern: /\b(?:mailbox (?:permissions?|delegations?|forwarding|settings?)|shared mailboxes?|(?:mail |email |auto-?)forwarding|send as|full access)\b/i,
    label: 'Exchange mailbox settings, shared mailboxes and who has access to them',
    kinds: ['exchange-recipients', 'exchange-mailbox-settings'],
  },
  {
    pattern: /\b(?:distribution (?:lists?|groups?)|mailing lists?|dynamic distribution|mail-enabled security groups?|room mailboxes?|meeting rooms?|room booking|equipment mailboxes?|mail contacts?|calendar processing)\b/i,
    label: 'Exchange distribution lists, rooms and contacts',
    kinds: ['exchange-distribution-groups', 'exchange-recipients'],
  },
  {
    pattern: /\b(?:activesync|mobile device access|owa polic(?:y|ies)|outlook on the web)\b/i,
    label: 'Exchange filtering, retention, mobile and Outlook on the web settings',
    kinds: ['exchange-extended', 'exchange-org-access'],
  },
  {
    pattern: /\b(?:calendar sharing|sharing polic(?:y|ies)|free\/?busy|organi[sz]ation relationships?|authentication polic(?:y|ies)|basic auth(?:entication)?|legacy auth(?:entication)?|application access polic(?:y|ies)|role assignment polic(?:y|ies)|external (?:sender )?tag|external in outlook)\b/i,
    label: 'Exchange sharing and client access policies',
    kinds: ['exchange-org-access'],
  },
  {
    pattern: /\b(?:smtp auth|transport config(?:uration)?|email address polic(?:y|ies)|mailbox plans?|cas mailbox plans?|reply-?all storm)\b/i,
    label: 'Exchange transport settings and new mailbox defaults',
    kinds: ['exchange-org-defaults'],
  },
  {
    pattern: /\b(?:meeting polic(?:y|ies)|messaging polic(?:y|ies)|app setup polic(?:y|ies)|teams apps?|external access|federation with teams|teams federation)\b/i,
    label: 'Teams organization policies',
    kinds: ['teams-org-policies'],
  },
  {
    pattern: /\b(?:calling polic(?:y|ies)|voice(?: polic(?:y|ies)| routing)?|phone system|direct routing|live events?|town ?halls?|emergency calling)\b/i,
    label: 'Teams calling, voice and live event policies',
    kinds: ['teams-voice-policies'],
  },
  {
    pattern: /\b(?:external access polic(?:y|ies)|private channels?|shared channels?|channels? polic(?:y|ies)|files? polic(?:y|ies)|team templates?|shifts|teams upgrade|coexistence mode|azure communication services|acs federation)\b/i,
    label: 'Teams external access, channel, files, template, Shifts and upgrade policies',
    kinds: ['teams-collaboration-policies'],
  },
  {
    pattern: /\b(?:anonymous (?:join|users?)|meeting (?:configuration|settings?|templates?)|end-to-end encryption|enhanced encryption|compliance recording|meeting invit(?:e|ation)s?|quality of service|qos)\b/i,
    label: 'Teams meeting settings, encryption and compliance recording',
    kinds: ['teams-meeting-settings'],
  },
  {
    pattern: /\b(?:pstn usages?|voice routes?|pstn gateways?|session border controllers?|sbcs?|translation rules?|unassigned numbers?|network (?:regions?|sites?|subnets?)|trusted ips?|location-based routing|auto attendants?|call queues?|dial-in|audio conferencing|call hold|music on hold)\b/i,
    label: 'Teams voice routing, network sites, auto attendants and call queues',
    kinds: ['teams-voice-network'],
  },
  {
    pattern: /\b(?:ip phones?|teams phones?|teams devices?|desk phones?|hot desking|update (?:management )?polic(?:y|ies)|teams updates?|mobility polic(?:y|ies)|vdi|feedback polic(?:y|ies)|workload polic(?:y|ies))\b/i,
    label: 'Teams device and client policies',
    kinds: ['teams-device-policies'],
  },
  {
    pattern: /\b(?:microsoft tunnel|tunnel gateway|vpn)\b/i,
    label: 'Microsoft Tunnel settings',
    kinds: ['microsoftTunnelConfiguration', 'microsoftTunnelHealthThreshold'],
  },
  {
    pattern: /\b(?:apple (?:push|mdm push)(?: certificate)?|apns|vpp|volume purchase|apple tokens?)\b/i,
    label: 'Apple certificates and tokens',
    kinds: ['applePushNotificationCertificate', 'vppToken', 'depOnboardingSetting'],
  },
  {
    pattern: /\b(?:code signing(?: certificates?)?)\b/i,
    label: 'code signing certificates',
    kinds: ['enterpriseCodeSigningCertificate', 'symantecCodeSigningCertificate'],
  },
  {
    pattern: /\b(?:intune partners?|mtd|mobile threat defen[cs]e|partner connectors?|remote help)\b/i,
    label: 'Intune partner connectors',
    kinds: ['mobileThreatDefenseConnector', 'deviceManagementPartner', 'complianceManagementPartner', 'remoteAssistancePartner', 'deviceManagementExchangeConnector'],
  },
  {
    pattern: /\b(?:branding|brand|logos?|sign-in page)\b/i,
    label: 'company branding',
    kinds: ['organizationalBranding', 'organizationalBrandingLocalization', 'intuneBrandingProfile'],
  },
  {
    pattern: /\b(?:group (?:expiration|expiry|naming|creation)(?: polic(?:y|ies)| settings?)?|naming polic(?:y|ies))\b/i,
    label: 'group expiration and tenant-wide group settings',
    kinds: ['groupLifecyclePolicy', 'groupSetting', 'directorySettingTemplate'],
  },
  {
    pattern: /\b(?:device (?:join|registration)(?: settings?)?|entra join|azure ad join|hybrid join|registered devices?)\b/i,
    label: 'device join and registration settings',
    kinds: ['deviceRegistrationPolicy'],
  },
  {
    pattern: /\b(?:power platform dlp|power platform environments?|tenant isolation|power bi settings|fabric settings)\b/i,
    label: 'Power Platform and Power BI settings',
    kinds: ['power-platform-settings'],
  },
  {
    pattern: /\bcompliance\b/i,
    label: 'Purview labels, retention, data loss prevention and eDiscovery settings, and Intune device compliance policies',
    kinds: ['purview-labels', 'purview-retention-dlp', 'purview-governance', 'deviceCompliancePolicy', 'deviceManagementCompliancePolicy'],
  },
  {
    pattern: /\b(?:workload identit(?:y|ies)|managed identit(?:y|ies)|app(?:lication)? identit(?:y|ies))\b/i,
    label: 'app registrations and enterprise apps',
    kinds: ['application', 'servicePrincipal'],
  },
]);

/**
 * Things people ask about that KEEL does not back up. Naming one never widens or
 * narrows an answer: it is said back plainly, and the rest of the question is answered.
 */
export const NOT_HELD_WORDS = Object.freeze([
  [/\b(?:sign-?ins?|sign-in logs?|logins?|log-?ons?)\b/i, 'sign-in logs'],
  [/\b(?:audit logs?|unified audit log|ual|activity logs?)\b/i, 'audit logs'],
  [/\b(?:secure score|compliance score|exposure score)\b/i, 'scores such as Secure Score'],
  [/\b(?:risky (?:users?|sign-ins?)|identity protection|risk detections?|user risk|sign-in risk)\b/i, 'Identity Protection risk data'],
  [/\b(?:defender|security|sentinel|m365|microsoft 365) (?:alerts?|incidents?)\b/i, 'Microsoft security alerts and incidents'],
  [/\b(?:sspr|self[- ]service password reset|password resets?)\b/i, 'self-service password reset settings'],
  [/\b(?:password (?:protection|polic(?:y|ies)|expiry|expiration)|banned passwords?)\b/i, 'password policies'],
]);

/**
 * Things KEEL holds but Ask does not answer yet, and the page that does: [pattern,
 * what it is, the page].
 */
export const ELSEWHERE_WORDS = Object.freeze([
  [/\b(?:(?:baseline|benchmark|compliance|cis) (?:controls?|checks?|results?|findings?|scores?)|compliance checks?|findings?|non-?conformities|deviations?)\b/i, 'compliance check results', 'Baselines'],
  [/\b(?:keel )?alerts?\b/i, 'KEEL alerts', 'Alerts'],
  [/\b(?:keel )?incidents?\b/i, 'incidents', 'Incidents'],
  [/\b(?:approvals?|pending approvals?|change requests?)\b/i, 'approvals', 'Approvals'],
]);

/** Who made a change: KEEL compares backups, so it knows what changed and when, not who. */
export const ACTOR_WORDS = /\b(?:who (?:changed|modified|edited|updated|added|created|removed|deleted|made|did|touched|turned|enabled|disabled|granted|assigned)|by whom|which admin (?:changed|modified|made))\b/i;
