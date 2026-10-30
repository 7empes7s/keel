/**
 * Exchange organisation policies: who and what may reach the organisation's mail, and
 * the defaults a new mailbox gets. Microsoft Graph reads none of these.
 *
 * Two read-only workloads, in the Exchange Online session, so each lands in its own
 * group on the portal's lists:
 *  - `exchange-org-access` ("Sharing and client access"): authentication policies
 *    (legacy sign-in blocks), sharing policies (calendar sharing with outside domains),
 *    organization relationships and hybrid connectors (free/busy with other
 *    organizations), Outlook on the web policies (downloads, add-ins, offline), role
 *    assignment policies (what people may change on their own mailbox), application
 *    access policies (which apps may open which mailboxes) and the "External" sender tag.
 *  - `exchange-org-defaults` ("Organization settings"): the transport configuration
 *    (SMTP AUTH, TLS, journaling report address, size limits), whether mailbox auditing
 *    is turned off for the whole organization (Get-OrganizationConfig AuditDisabled,
 *    which CISA ScubaGear MS.EXO.13.1 checks), email address policies, and the client
 *    access and mailbox plans a new mailbox starts from.
 *
 * Rules (the same as the other Exchange cmdlet workloads):
 *  - Read only, configuration only. Only the Get cmdlets in EXCHANGE_ORG_POLICIES_CMDLET_PARAMETERS
 *    run, each with no parameters. No writer exists.
 *  - Declared fields only. Anything else an answer carries is dropped unread. Fields were
 *    declared from Microsoft's cmdlet documentation, not measured live; a declared field
 *    the tenant leaves out is `unknown` and makes the run partial, so the live read
 *    check shows any to drop.
 *  - Identity is the Guid (it survives a rename; the name is kept as a field). The two
 *    organisation-wide answers (transport configuration and the External tag) are kept
 *    under `organization`, and so is the organization configuration. An application access policy has no Guid; it is kept under
 *    the Identity Exchange gives it (tenant, app and mailbox scope).
 *  - Errors are structured. A family that fails is `failed` or `denied`, never an empty list.
 *  - Disabled until qualified. Nothing is sent unless the Exchange mailbox workload is
 *    qualified AND every read of the workload is live-qualified and enabled.
 */
import { registerWorkload } from '../registry.mjs';
import { CmdletError, runCmdlet } from '../../powershell/jobQueue.mjs';
import { exchangeActivation, structuredFailure } from './exchange.mjs';
import {
  emptyRead, guidOf, ledgerRows, objectsFrom, recordCmdletRun, recordDisabledRun, summarize,
} from './cmdletFamilies.mjs';

export const EXCHANGE_ORG_ACCESS_WORKLOAD = 'exchange-org-access';
export const EXCHANGE_ORG_DEFAULTS_WORKLOAD = 'exchange-org-defaults';
export const EXCHANGE_ORG_POLICIES_MODULE = 'ExchangeOnlineManagement';
export const DEFAULT_MAX_OBJECTS = 1000;

const WHEN = 'WhenChangedUTC';
const byGuid = (body) => guidOf(body?.Guid);
/** One per tenant: whatever Exchange answers is the organisation's. */
const organization = () => 'organization';
// An application access policy Identity: "<tenant>\<app>:<scope SID>;<scope group>"
// (administrator data, bounded, no control characters).
// eslint-disable-next-line no-control-regex
const POLICY_IDENTITY = /^[^\u0000-\u001f\u007f]{1,512}$/;
const byPolicyIdentity = (body) => {
  const id = typeof body?.Identity === 'string' ? body.Identity.trim() : '';
  return POLICY_IDENTITY.test(id) ? id.toLowerCase() : null;
};

// Get-ApplicationAccessPolicy with no Identity lists "<organization>\*". A tenant that has
// never had an application access policy has nothing under that path yet, and Exchange
// answers "object '<organization>\*' couldn't be found" instead of an empty list. Only that
// wildcard lookup counts as empty; a named object that is missing, or any other error,
// stays a failure.
const NO_POLICY_YET = /object '[^']*\\\*' couldn['’]t be found/i;
export function noApplicationAccessPolicyYet(error) {
  return error instanceof CmdletError && NO_POLICY_YET.test(String(error.detail?.message ?? ''));
}

const family = (operation, cmdlet, prefix, identity, fields, { emptyWhen = null } = {}) => Object.freeze({ operation, cmdlet, prefix, identity, fields: Object.freeze(fields), emptyWhen });

/**
 * Sharing and client access, in the order a list shows them: sign-in, sharing with other
 * organizations, then what people and apps may do with mailboxes.
 */
export const ACCESS_FAMILIES = Object.freeze({
  authenticationPolicy: family('exchange-org-access.authentication-policies', 'Get-AuthenticationPolicy', 'authentication-policy', byGuid, [
    'Name', 'AllowBasicAuthActiveSync', 'AllowBasicAuthAutodiscover', 'AllowBasicAuthImap', 'AllowBasicAuthMapi',
    'AllowBasicAuthOfflineAddressBook', 'AllowBasicAuthOutlookService', 'AllowBasicAuthPop', 'AllowBasicAuthPowershell',
    'AllowBasicAuthReportingWebServices', 'AllowBasicAuthRpc', 'AllowBasicAuthSmtp', 'AllowBasicAuthWebServices', WHEN,
  ]),
  sharingPolicy: family('exchange-org-access.sharing-policies', 'Get-SharingPolicy', 'sharing-policy', byGuid, [
    'Name', 'Enabled', 'Default', 'Domains', WHEN,
  ]),
  organizationRelationship: family('exchange-org-access.organization-relationships', 'Get-OrganizationRelationship', 'organization-relationship', byGuid, [
    'Name', 'Enabled', 'DomainNames', 'FreeBusyAccessEnabled', 'FreeBusyAccessLevel', 'FreeBusyAccessScope',
    'MailTipsAccessEnabled', 'MailTipsAccessLevel', 'MailTipsAccessScope', 'DeliveryReportEnabled', 'PhotosEnabled',
    'MailboxMoveEnabled', 'MailboxMoveCapability', 'ArchiveAccessEnabled', 'TargetApplicationUri', 'TargetAutodiscoverEpr',
    'TargetSharingEpr', 'TargetOwaURL', 'OrganizationContact', WHEN,
  ]),
  intraOrganizationConnector: family('exchange-org-access.intra-organization-connectors', 'Get-IntraOrganizationConnector', 'intra-organization-connector', byGuid, [
    'Name', 'Enabled', 'TargetAddressDomains', 'DiscoveryEndpoint', 'TargetSharingEpr', WHEN,
  ]),
  owaMailboxPolicy: family('exchange-org-access.owa-mailbox-policies', 'Get-OwaMailboxPolicy', 'owa-mailbox-policy', byGuid, [
    'Name', 'IsDefault', 'ConditionalAccessPolicy', 'DirectFileAccessOnPublicComputersEnabled', 'DirectFileAccessOnPrivateComputersEnabled',
    'WacViewingOnPublicComputersEnabled', 'WacViewingOnPrivateComputersEnabled', 'WacEditingEnabled', 'ClassicAttachmentsEnabled',
    'ReferenceAttachmentsEnabled', 'SaveAttachmentsToCloudEnabled', 'AdditionalStorageProvidersAvailable', 'ThirdPartyFileProvidersEnabled',
    'ActionForUnknownFileAndMIMETypes', 'AllowedFileTypes', 'BlockedFileTypes', 'ForceSaveFileTypes', 'AllowedMimeTypes', 'BlockedMimeTypes',
    'AllowOfflineOn', 'OfflineEnabledWeb', 'OfflineEnabledWin', 'PersonalAccountsEnabled', 'PersonalAccountCalendarsEnabled',
    'ItemsToOtherAccountsEnabled', 'ExternalImageProxyEnabled', 'ChangePasswordEnabled', 'SignaturesEnabled', 'OutlookBetaToggleEnabled',
    'BookingsMailboxCreationEnabled', WHEN,
  ]),
  roleAssignmentPolicy: family('exchange-org-access.role-assignment-policies', 'Get-RoleAssignmentPolicy', 'role-assignment-policy', byGuid, [
    'Name', 'IsDefault', 'Description', 'AssignedRoles', WHEN,
  ]),
  applicationAccessPolicy: family('exchange-org-access.application-access-policies', 'Get-ApplicationAccessPolicy', 'application-access-policy', byPolicyIdentity, [
    'AppId', 'AccessRight', 'ScopeName', 'ScopeIdentity', 'PolicyScopeGroupId', 'Description', 'IsValid',
  ], { emptyWhen: noApplicationAccessPolicyYet }),
  externalInOutlook: family('exchange-org-access.external-in-outlook', 'Get-ExternalInOutlook', 'external-in-outlook', organization, [
    'Enabled', 'AllowList',
  ]),
});

/** Organisation-wide transport settings, then what a new mailbox or group starts with. */
export const DEFAULTS_FAMILIES = Object.freeze({
  transportConfig: family('exchange-org-defaults.transport-config', 'Get-TransportConfig', 'transport-config', organization, [
    'Name', 'SmtpClientAuthenticationDisabled', 'AllowLegacyTLSClients', 'JournalingReportNdrTo', 'ExternalPostmasterAddress',
    'ExternalDsnReportingAuthority', 'ExternalDelayDsnEnabled', 'InternalDelayDsnEnabled', 'ExternalDsnSendHtml', 'InternalDsnSendHtml',
    'MaxReceiveSize', 'MaxSendSize', 'MaxRecipientEnvelopeLimit', 'AddressBookPolicyRoutingEnabled', 'ClearCategories',
    'ConvertDisclaimerWrapperToEml', 'Rfc2231EncodingEnabled', 'HeaderPromotionModeSetting', 'VoicemailJournalingEnabled',
    'ReplyAllStormProtectionEnabled', 'ReplyAllStormDetectionMinimumRecipients', 'ReplyAllStormDetectionMinimumReplies',
    'ReplyAllStormBlockDurationHours', WHEN,
  ]),
  // Only what a check needs: the exchange-mailbox-settings workload keeps its own
  // allowlist of organization settings (exchange.mjs ORGANIZATION_FIELDS), qualified apart.
  organizationConfig: family('exchange-org-defaults.organization-config', 'Get-OrganizationConfig', 'organization-config', organization, [
    'Name', 'AuditDisabled', WHEN,
  ]),
  emailAddressPolicy: family('exchange-org-defaults.email-address-policies', 'Get-EmailAddressPolicy', 'email-address-policy', byGuid, [
    'Name', 'Priority', 'EnabledPrimarySMTPAddressTemplate', 'EnabledEmailAddressTemplates', 'DisabledEmailAddressTemplates',
    'RecipientFilter', 'IncludedRecipients', WHEN,
  ]),
  casMailboxPlan: family('exchange-org-defaults.cas-mailbox-plans', 'Get-CASMailboxPlan', 'cas-mailbox-plan', byGuid, [
    'Name', 'DisplayName', 'ActiveSyncEnabled', 'ImapEnabled', 'PopEnabled', 'OwaMailboxPolicy', WHEN,
  ]),
  mailboxPlan: family('exchange-org-defaults.mailbox-plans', 'Get-MailboxPlan', 'mailbox-plan', byGuid, [
    'Name', 'DisplayName', 'IsDefault', 'IssueWarningQuota', 'ProhibitSendQuota', 'ProhibitSendReceiveQuota', 'MaxSendSize',
    'MaxReceiveSize', 'RecipientLimits', 'RetainDeletedItemsFor', 'RetentionPolicy', 'RoleAssignmentPolicy', WHEN,
  ]),
});

export class ExchangeOrgPoliciesScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExchangeOrgPoliciesScopeError';
  }
}

/**
 * One read-only workload over `families`: its descriptor, allowlist, reader, activation,
 * recorder and gated collector, the same shape as exchangeRecipients.mjs.
 */
function orgPolicyWorkload({ workload, type, families, label, required = [] }) {
  const names = Object.freeze(Object.keys(families));
  const operations = Object.freeze(names.map((name) => families[name].operation));
  const cmdlets = new Set(names.map((name) => families[name].cmdlet));
  const descriptor = Object.freeze({ type, workload, adapter: workload, readOnly: true, enabledByDefault: false, operations });

  /** Throws unless the cmdlet is one of the reads above, with no parameters. */
  function assertCmdlet({ cmdlet, parameters = {} }) {
    if (!cmdlets.has(cmdlet)) throw new ExchangeOrgPoliciesScopeError(`${cmdlet} is not an Exchange ${label} read KEEL runs; this workload never writes`);
    for (const name of Object.keys(parameters)) throw new ExchangeOrgPoliciesScopeError(`${cmdlet} does not take ${name} from KEEL`);
    return true;
  }

  async function readFamily(name, { powershell, maxObjects }) {
    const spec = families[name];
    let output;
    try {
      assertCmdlet({ cmdlet: spec.cmdlet });
      const { tenantConfigPath = null, ...options } = powershell;
      ({ output } = await runCmdlet({ module: EXCHANGE_ORG_POLICIES_MODULE, cmdlet: spec.cmdlet, parameters: {}, tenantConfigPath }, { ...options, allowedCmdlets: cmdlets }));
    } catch (error) {
      if (spec.emptyWhen?.(error)) return emptyRead();
      return emptyRead({ failure: { family: name, operation: spec.operation, ...structuredFailure(error) } });
    }
    return { ...emptyRead(), ...objectsFrom(name, spec, output, { maxObjects }) };
  }

  /** Reads the named families (all by default). Pure apart from the injected PowerShell options. */
  async function read({ powershell = {}, families: wanted = names, skipped = [], maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() } = {}) {
    for (const name of wanted) if (!families[name]) throw new TypeError(`unknown Exchange ${label} family ${name}`);
    const observedFrom = now().toISOString();
    const reads = {};
    for (const name of wanted) reads[name] = await readFamily(name, { powershell, maxObjects });
    return summarize({
      workload, families: wanted, reads, skipped, required: required.filter((name) => wanted.includes(name)), maxObjects,
      observedFrom, observedTo: now().toISOString(),
    });
  }

  /** Whether live collection may run: Exchange first, then every read of this workload. */
  function activation(ledger) {
    const { rows, describe } = ledgerRows(ledger);
    const reasons = [];
    const exchange = exchangeActivation(ledger);
    if (!exchange.enabled) reasons.push(`Exchange is not qualified yet, and ${label} follow it: ${exchange.reasons.join('; ')}`);
    for (const id of operations) if (!rows.get(id)?.enabled) reasons.push(describe(id));
    return { enabled: reasons.length === 0, reasons, families: [...names], skipped: [] };
  }

  const record = (client, { tenantRef, result }) => recordCmdletRun(client, workload, { tenantRef, result });

  /** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
  async function collect(client, { tenantRef, ledger, powershell, maxObjects, now }) {
    const gate = activation(ledger);
    if (!gate.enabled) {
      const run = await recordDisabledRun(client, workload, { tenantRef, reasons: gate.reasons, now });
      return { run, result: null, activation: gate };
    }
    const result = await read({ powershell, families: gate.families, maxObjects, now });
    const run = await record(client, { tenantRef, result });
    return { run, result, activation: gate };
  }

  /** Registry adapter: a direct call is refused until the workload is enabled. */
  const adapter = Object.freeze({
    async collect() {
      throw new Error(`the Exchange ${label} workload adapter is disabled until live qualification; use its collector with the ledger`);
    },
  });
  registerWorkload(descriptor, adapter);

  return Object.freeze({ workload, families, familyNames: names, operations, descriptor, cmdlets, assertCmdlet, read, activation, record, collect });
}

// Every tenant has a default sharing, Outlook on the web and role assignment policy, a
// transport configuration and mailbox plans, so an empty answer there is a gap.
export const ORG_ACCESS = orgPolicyWorkload({
  workload: EXCHANGE_ORG_ACCESS_WORKLOAD, type: 'exchangeOrgAccess', families: ACCESS_FAMILIES, label: 'sharing and client access settings',
  required: ['sharingPolicy', 'owaMailboxPolicy', 'roleAssignmentPolicy', 'externalInOutlook'],
});
export const ORG_DEFAULTS = orgPolicyWorkload({
  workload: EXCHANGE_ORG_DEFAULTS_WORKLOAD, type: 'exchangeOrgDefaults', families: DEFAULTS_FAMILIES, label: 'transport and new mailbox defaults',
  required: ['transportConfig', 'casMailboxPlan', 'mailboxPlan'],
});

export const readExchangeOrgAccess = (options) => ORG_ACCESS.read(options);
export const readExchangeOrgDefaults = (options) => ORG_DEFAULTS.read(options);
export const collectExchangeOrgAccess = (client, options) => ORG_ACCESS.collect(client, options);
export const collectExchangeOrgDefaults = (client, options) => ORG_DEFAULTS.collect(client, options);
export const recordExchangeOrgAccessRun = (client, options) => ORG_ACCESS.record(client, options);
export const recordExchangeOrgDefaultsRun = (client, options) => ORG_DEFAULTS.record(client, options);
export const exchangeOrgAccessActivation = (ledger) => ORG_ACCESS.activation(ledger);
export const exchangeOrgDefaultsActivation = (ledger) => ORG_DEFAULTS.activation(ledger);

/** Both workloads' cmdlets, none with parameters: what run-cmdlet.ps1 ($AllowedExchangeOrgPolicies) must allow. */
export const EXCHANGE_ORG_POLICIES_CMDLET_PARAMETERS = Object.freeze(Object.fromEntries(
  [...ORG_ACCESS.cmdlets, ...ORG_DEFAULTS.cmdlets].map((cmdlet) => [cmdlet, Object.freeze([])]),
));
