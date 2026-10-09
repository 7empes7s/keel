/**
 * Issue #153: the Exchange organization's mail flow and protection settings.
 *
 * Eleven families, each its own task-101 operation and one Get cmdlet run with no
 * parameters in the Exchange Online session:
 *  - accepted domains and remote domains;
 *  - mail flow (transport) rules;
 *  - inbound and outbound connectors;
 *  - anti-spam (hosted content filter), anti-phishing and anti-malware policies;
 *  - DKIM signing configuration;
 *  - Safe Links and Safe Attachments policies (Microsoft Defender for Office 365).
 * Every object becomes one observation, keyed by a stable identity (see FAMILIES).
 *
 * Rules:
 *  - Read only. Only the Get cmdlets in MAIL_FLOW_CMDLET_PARAMETERS run, with no
 *    parameters. No write capability exists for this workload; restore is a separate
 *    task once these reads are live-qualified.
 *  - Declared fields only. Anything an answer carries beyond a family's fields is
 *    dropped unread. That drops the DKIM public keys (published in DNS anyway) and
 *    any property the module adds later. No declared field holds a secret: Exchange
 *    connectors carry certificate names and IP ranges, never a password or key. A
 *    credential-shaped value an administrator typed into a rule is still redacted.
 *  - Errors are structured. A family that fails is `failed` or `denied` with the
 *    structured error, never an empty list. An empty successful answer is a family
 *    with no objects.
 *  - Unlicensed is an observation. Safe Links and Safe Attachments need Defender for
 *    Office 365. When a tenant does not have it, Exchange does not expose the cmdlet,
 *    and the family is recorded as `not-licensed`; the run does not fail for it.
 *  - Disabled until qualified. collectMailFlow() sends nothing unless the Exchange
 *    mailbox workload is qualified (as Purview requires) AND every core read here is
 *    live-qualified and enabled. The two Defender reads are optional: each runs only
 *    when its own row is enabled, and is otherwise listed as skipped.
 */
import { registerWorkload } from '../registry.mjs';
import { CmdletError, runCmdlet } from '../../powershell/jobQueue.mjs';
import { redactPayload } from '../../telemetry/events.mjs';
import { exchangeActivation, structuredFailure } from './exchange.mjs';

export const MAIL_FLOW_WORKLOAD = 'exchange-mail-flow';
export const MAIL_FLOW_MODULE = 'ExchangeOnlineManagement';
export const DEFAULT_MAX_OBJECTS = 1000;

const WHEN = 'WhenChangedUTC';

/**
 * The families. `key` is the identity an observation is stored under:
 *  - `domain`: the domain name itself (accepted domains, remote domains, DKIM). It is
 *    what the object configures, it is unique per tenant, and a domain removed and
 *    added again is the same domain;
 *  - `guid`: the object's Guid (rules, connectors, policies). Names are unique too,
 *    but they can be renamed; the Guid survives a rename. The name is kept as a field.
 * Fields were declared from Microsoft's cmdlet documentation, not measured live.
 */
export const FAMILIES = Object.freeze({
  acceptedDomain: Object.freeze({
    operation: 'mailflow.accepted-domains', cmdlet: 'Get-AcceptedDomain', prefix: 'accepted-domain', key: 'domain', keyField: 'DomainName',
    fields: Object.freeze(['Name', 'DomainName', 'DomainType', 'Default', 'MatchSubDomains', WHEN]),
  }),
  remoteDomain: Object.freeze({
    operation: 'mailflow.remote-domains', cmdlet: 'Get-RemoteDomain', prefix: 'remote-domain', key: 'domain', keyField: 'DomainName',
    fields: Object.freeze([
      'Name', 'DomainName', 'IsInternal', 'AllowedOOFType', 'AutoReplyEnabled', 'AutoForwardEnabled', 'DeliveryReportEnabled',
      'NDREnabled', 'NDRDiagnosticInfoEnabled', 'MeetingForwardNotificationEnabled', 'TNEFEnabled', 'ContentType', 'CharacterSet',
      'NonMimeCharacterSet', 'TrustedMailInboundEnabled', 'TrustedMailOutboundEnabled', 'UseSimpleDisplayName', WHEN,
    ]),
  }),
  transportRule: Object.freeze({
    operation: 'mailflow.transport-rules', cmdlet: 'Get-TransportRule', prefix: 'transport-rule', key: 'guid',
    // Description is Exchange's full text of the rule's conditions, exceptions and
    // actions. The typed predicates kept below are the common ones; the rest are
    // covered by Description until the restore task needs them typed.
    fields: Object.freeze([
      'Name', 'State', 'Mode', 'Priority', 'Comments', 'Description', 'Conditions', 'Exceptions', 'Actions',
      'StopRuleProcessing', 'RuleErrorAction', 'SenderAddressLocation', 'ActivationDate', 'ExpiryDate',
      'From', 'FromScope', 'SentTo', 'SentToScope', 'SenderDomainIs', 'RecipientDomainIs', 'FromAddressContainsWords',
      'SubjectContainsWords', 'SubjectOrBodyContainsWords', 'AttachmentExtensionMatchesWords', 'AttachmentHasExecutableContent',
      'SenderIpRanges', 'HeaderContainsMessageHeader', 'HeaderContainsWords',
      'ExceptIfFrom', 'ExceptIfSentTo', 'ExceptIfSenderDomainIs', 'ExceptIfRecipientDomainIs', 'ExceptIfSenderIpRanges',
      'SetSCL', 'SetHeaderName', 'SetHeaderValue', 'PrependSubject', 'RedirectMessageTo', 'BlindCopyTo', 'AddToRecipients',
      'ModerateMessageByUser', 'RejectMessageReasonText', 'RejectMessageEnhancedStatusCode', 'DeleteMessage', 'Quarantine',
      'ApplyHtmlDisclaimerText', 'ApplyHtmlDisclaimerLocation', 'ApplyHtmlDisclaimerFallbackAction',
      'RouteMessageOutboundConnector', 'RouteMessageOutboundRequireTls', 'ApplyRightsProtectionTemplate', 'GenerateIncidentReport',
      WHEN,
    ]),
  }),
  inboundConnector: Object.freeze({
    operation: 'mailflow.inbound-connectors', cmdlet: 'Get-InboundConnector', prefix: 'inbound-connector', key: 'guid',
    fields: Object.freeze([
      'Name', 'Enabled', 'ConnectorType', 'ConnectorSource', 'Comment', 'SenderDomains', 'SenderIPAddresses',
      'RestrictDomainsToIPAddresses', 'RestrictDomainsToCertificate', 'RequireTls', 'TlsSenderCertificateName',
      'CloudServicesMailEnabled', 'TreatMessagesAsInternal', 'TrustedOrganizations', 'AssociatedAcceptedDomains',
      'EFSkipLastIP', 'EFSkipIPs', 'EFSkipMailGateway', 'EFUsers', 'ScanAndDropRecipients', WHEN,
    ]),
  }),
  outboundConnector: Object.freeze({
    operation: 'mailflow.outbound-connectors', cmdlet: 'Get-OutboundConnector', prefix: 'outbound-connector', key: 'guid',
    fields: Object.freeze([
      'Name', 'Enabled', 'ConnectorType', 'ConnectorSource', 'Comment', 'RecipientDomains', 'SmartHosts', 'UseMXRecord',
      'TlsSettings', 'TlsDomain', 'IsTransportRuleScoped', 'RouteAllMessagesViaOnPremises', 'CloudServicesMailEnabled',
      'AllAcceptedDomains', 'SenderRewritingEnabled', 'TestMode', 'IsValidated', WHEN,
    ]),
  }),
  antiSpamPolicy: Object.freeze({
    operation: 'mailflow.anti-spam-policies', cmdlet: 'Get-HostedContentFilterPolicy', prefix: 'anti-spam-policy', key: 'guid',
    fields: Object.freeze([
      'Name', 'IsDefault', 'BulkThreshold', 'SpamAction', 'HighConfidenceSpamAction', 'PhishSpamAction', 'HighConfidencePhishAction',
      'BulkSpamAction', 'QuarantineRetentionPeriod', 'SpamQuarantineTag', 'HighConfidenceSpamQuarantineTag', 'PhishQuarantineTag',
      'HighConfidencePhishQuarantineTag', 'BulkQuarantineTag', 'AllowedSenders', 'AllowedSenderDomains', 'BlockedSenders',
      'BlockedSenderDomains', 'EnableLanguageBlockList', 'LanguageBlockList', 'EnableRegionBlockList', 'RegionBlockList',
      'InlineSafetyTipsEnabled', 'SpamZapEnabled', 'PhishZapEnabled', 'TestModeAction', 'AddXHeaderValue', 'ModifySubjectValue',
      'RedirectToRecipients', WHEN,
    ]),
  }),
  antiPhishPolicy: Object.freeze({
    operation: 'mailflow.anti-phish-policies', cmdlet: 'Get-AntiPhishPolicy', prefix: 'anti-phish-policy', key: 'guid',
    fields: Object.freeze([
      'Name', 'IsDefault', 'Enabled', 'PhishThresholdLevel', 'EnableSpoofIntelligence', 'EnableUnauthenticatedSender', 'EnableViaTag',
      'AuthenticationFailAction', 'HonorDmarcPolicy', 'DmarcQuarantineAction', 'DmarcRejectAction', 'SpoofQuarantineTag',
      'EnableMailboxIntelligence', 'EnableMailboxIntelligenceProtection', 'MailboxIntelligenceProtectionAction',
      'EnableOrganizationDomainsProtection', 'EnableTargetedDomainsProtection', 'TargetedDomainsToProtect', 'TargetedDomainProtectionAction',
      'EnableTargetedUserProtection', 'TargetedUsersToProtect', 'TargetedUserProtectionAction', 'ExcludedDomains', 'ExcludedSenders',
      'EnableFirstContactSafetyTips', 'EnableSimilarUsersSafetyTips', 'EnableSimilarDomainsSafetyTips', 'EnableUnusualCharactersSafetyTips',
      WHEN,
    ]),
  }),
  antiMalwarePolicy: Object.freeze({
    operation: 'mailflow.anti-malware-policies', cmdlet: 'Get-MalwareFilterPolicy', prefix: 'anti-malware-policy', key: 'guid',
    fields: Object.freeze([
      'Name', 'IsDefault', 'EnableFileFilter', 'FileTypes', 'FileTypeAction', 'ZapEnabled', 'QuarantineTag',
      'EnableInternalSenderAdminNotifications', 'InternalSenderAdminAddress', 'EnableExternalSenderAdminNotifications',
      'ExternalSenderAdminAddress', 'CustomNotifications', WHEN,
    ]),
  }),
  dkimSigning: Object.freeze({
    operation: 'mailflow.dkim-signing', cmdlet: 'Get-DkimSigningConfig', prefix: 'dkim', key: 'domain', keyField: 'Domain',
    fields: Object.freeze([
      'Domain', 'Enabled', 'Status', 'Selector1CNAME', 'Selector2CNAME', 'Selector1KeySize', 'Selector2KeySize',
      'HeaderCanonicalization', 'BodyCanonicalization', 'RotateOnDate', WHEN,
    ]),
  }),
  safeLinksPolicy: Object.freeze({
    operation: 'mailflow.safe-links-policies', cmdlet: 'Get-SafeLinksPolicy', prefix: 'safe-links-policy', key: 'guid', license: 'Microsoft Defender for Office 365',
    fields: Object.freeze([
      'Name', 'IsBuiltInProtection', 'EnableSafeLinksForEmail', 'EnableSafeLinksForTeams', 'EnableSafeLinksForOffice', 'TrackClicks',
      'AllowClickThrough', 'ScanUrls', 'EnableForInternalSenders', 'DeliverMessageAfterScan', 'DisableUrlRewrite', 'DoNotRewriteUrls',
      'EnableOrganizationBranding', 'CustomNotificationText', 'UseTranslatedNotificationText', WHEN,
    ]),
  }),
  safeAttachmentPolicy: Object.freeze({
    operation: 'mailflow.safe-attachment-policies', cmdlet: 'Get-SafeAttachmentPolicy', prefix: 'safe-attachment-policy', key: 'guid', license: 'Microsoft Defender for Office 365',
    fields: Object.freeze(['Name', 'IsBuiltInProtection', 'Enable', 'Action', 'QuarantineTag', 'Redirect', 'RedirectAddress', WHEN]),
  }),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const MAIL_FLOW_OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));
/** Families that need an add-on licence: optional for activation, never a failure when absent. */
export const LICENSED_FAMILIES = Object.freeze(FAMILY_NAMES.filter((name) => FAMILIES[name].license));
export const CORE_OPERATIONS = Object.freeze(FAMILY_NAMES.filter((name) => !FAMILIES[name].license).map((name) => FAMILIES[name].operation));

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const MAIL_FLOW_DESCRIPTOR = Object.freeze({
  type: 'exchangeMailFlow',
  workload: MAIL_FLOW_WORKLOAD,
  adapter: 'exchange-mail-flow',
  readOnly: true,
  enabledByDefault: false,
  operations: MAIL_FLOW_OPERATIONS,
});

// The only cmdlets this workload runs, and the only parameters each may receive (none).
// ops/powershell/run-cmdlet.ps1 ($AllowedMailFlow) holds the same list and checks it again.
export const MAIL_FLOW_CMDLET_PARAMETERS = Object.freeze(Object.fromEntries(FAMILY_NAMES.map((name) => [FAMILIES[name].cmdlet, Object.freeze([])])));
export const MAIL_FLOW_CMDLETS = new Set(Object.keys(MAIL_FLOW_CMDLET_PARAMETERS));

export class MailFlowScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MailFlowScopeError';
  }
}

/** Throws unless the cmdlet is one of the reads above and is given no parameters. */
export function assertMailFlowCmdlet({ cmdlet, parameters = {} }) {
  const allowed = MAIL_FLOW_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new MailFlowScopeError(`${cmdlet} is not a mail flow configuration read KEEL runs; this workload never writes, traces or reads messages`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new MailFlowScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  return true;
}

/** Runs one mail flow cmdlet through the bounded job transport. */
export async function mailFlowCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertMailFlowCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: MAIL_FLOW_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: MAIL_FLOW_CMDLETS });
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A domain as Exchange reports it: letters, digits, dots, hyphens, and `*` for the
// default remote domain. Anything else is not trusted as an identity.
const DOMAIN = /^(\*|(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/;

/** The stable identity of one answer in a family; null when it has none KEEL trusts. */
export function objectIdentity(family, body) {
  const { key, keyField } = FAMILIES[family];
  if (key === 'guid') {
    const id = String(body?.Guid ?? '');
    return GUID.test(id) ? id.toLowerCase() : null;
  }
  const domain = String(body?.[keyField] ?? '').toLowerCase();
  return domain.length > 0 && domain.length <= 255 && DOMAIN.test(domain) ? domain : null;
}
export const mailFlowKey = (family, identity) => `${FAMILIES[family].prefix}:${identity}`;

// Exchange answers a cmdlet the session does not expose (no licence, or no role
// granting it) with CommandNotFoundException.
const NOT_FOUND = /CommandNotFoundException|is not recognized as (?:the |a )?name of a cmdlet/i;
function notExposed(error) {
  return error instanceof CmdletError && NOT_FOUND.test(`${error.detail.errorId ?? ''} ${error.detail.message ?? ''}`);
}

// A transport rule that stamps a header whose name says it carries a credential
// (an API key for a partner relay, say) holds that credential in plain text, in the
// header value and in the rule's Description. Neither is stored.
const SENSITIVE_HEADER = /key|auth|token|secret|passw|signature|credential|bearer/i;

function sensitiveFields(family, body) {
  if (family !== 'transportRule' || typeof body.SetHeaderName !== 'string' || !SENSITIVE_HEADER.test(body.SetHeaderName)) return new Set();
  return new Set(['SetHeaderValue', 'Description']);
}

function observeObject(family, body) {
  const { fields, operation } = FAMILIES[family];
  const entry = { fields: {}, fieldCoverage: {} };
  const sensitive = sensitiveFields(family, body);
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) {
      entry.fieldCoverage[field] = { status: 'unknown', operation };
      continue;
    }
    if (sensitive.has(field) && value !== null) {
      entry.fields[field] = '[redacted]';
      entry.fieldCoverage[field] = { status: 'redacted', operation, reason: 'the rule stamps a credential-named header, so its value was not stored' };
      continue;
    }
    // Defence in depth: a credential-shaped value (a bearer token in a rule's header
    // value, say) is redacted by the shared telemetry redactor and marked as such,
    // so it is never stored and never mistaken for a restorable value.
    const redaction = { redactedFields: 0, seen: new WeakSet() };
    const clean = redactPayload(value, redaction);
    if (redaction.redactedFields > 0) {
      entry.fields[field] = clean;
      entry.fieldCoverage[field] = { status: 'redacted', operation, reason: 'the value looked like a credential and was not stored' };
      continue;
    }
    entry.fields[field] = value;
    entry.fieldCoverage[field] = { status: 'observed', operation };
  }
  return entry;
}

/** Reads one family. Returns its resources and, when the read did not succeed, why. */
async function readFamily(family, { powershell, maxObjects }) {
  const { cmdlet, operation, license } = FAMILIES[family];
  let output;
  try {
    ({ output } = await mailFlowCmdlet({ cmdlet }, powershell));
  } catch (error) {
    if (license && notExposed(error)) {
      return {
        resources: [], failure: null, capped: false, unidentified: 0,
        unavailable: { family, operation, status: 'not-licensed', license, reason: `${cmdlet} is not available in this tenant: ${license} is not licensed, or the app's Exchange role does not include it`, error: structuredFailure(error).error },
      };
    }
    return { resources: [], failure: { family, operation, ...structuredFailure(error) }, capped: false, unidentified: 0, unavailable: null };
  }
  const resources = [];
  const seen = new Set();
  let unidentified = 0;
  let capped = false;
  for (const body of output) {
    const identity = body && typeof body === 'object' ? objectIdentity(family, body) : null;
    if (!identity) { unidentified += 1; continue; }
    if (seen.has(identity)) continue;
    if (resources.length >= maxObjects) { capped = true; continue; }
    seen.add(identity);
    resources.push({ resourceKey: mailFlowKey(family, identity), kind: family, identity, ...observeObject(family, body) });
  }
  return { resources, failure: null, capped, unidentified, unavailable: null };
}

/**
 * Reads the named families (all by default). Pure apart from the injected
 * PowerShell options: no database, no gate. `skipped` lists families the caller
 * did not read, with the reason, so the run says what it does not cover. Callers
 * outside tests use collectMailFlow.
 */
export async function readMailFlow({ powershell = {}, families = FAMILY_NAMES, skipped = [], maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() }) {
  for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown mail flow family ${family}`);
  const observedFrom = now().toISOString();
  const reads = [];
  for (const family of families) reads.push(await readFamily(family, { powershell, maxObjects }));
  const resources = reads.flatMap((read) => read.resources);
  const failures = reads.map((read) => read.failure).filter(Boolean);
  const unavailable = reads.map((read) => read.unavailable).filter(Boolean);
  const capped = reads.some((read) => read.capped);
  const unidentified = reads.reduce((sum, read) => sum + read.unidentified, 0);
  const statuses = resources.flatMap((entry) => Object.values(entry.fieldCoverage).map((coverage) => coverage.status));
  const fieldCounts = statuses.reduce((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});
  const perFamily = Object.fromEntries(families.map((family, index) => {
    const read = reads[index];
    const status = read.failure ? read.failure.status : read.unavailable ? read.unavailable.status : 'read';
    return [family, { status, objects: read.resources.length }];
  }));
  let outcome;
  // Nothing usable was read: no object was kept, and every family failed, was
  // unavailable, or answered only objects with no identity KEEL trusts (at least one
  // failed or answered such objects; all-unavailable is not a failure of the read).
  if (families.length > 0 && resources.length === 0
    && reads.every((read) => read.failure || read.unavailable || read.unidentified > 0)
    && reads.some((read) => read.failure || read.unidentified > 0)) outcome = 'failed';
  // A Defender family runs only once its own read is live-qualified, so the cmdlet
  // was proven present in this tenant: "not available" later means a lapsed licence
  // or a removed role, and those policies are no longer backed up. That is a gap,
  // like a family skipped because its read is not qualified, or one that failed.
  else if (failures.length || unavailable.length || skipped.length || capped || unidentified
    || statuses.some((status) => status !== 'observed')) outcome = 'partial';
  else if (resources.length === 0) outcome = 'complete-empty';
  else outcome = 'complete';
  return {
    workload: MAIL_FLOW_WORKLOAD,
    outcome,
    observedFrom,
    observedTo: now().toISOString(),
    discovery: { families: perFamily, objects: resources.length, capped, unidentified, maxObjects },
    resources,
    failures,
    unavailable,
    skipped,
    fieldCounts,
  };
}

/**
 * Whether live collection may run, and which families. The Exchange mailbox
 * workload must be qualified first (as for Purview), and every core read here must
 * be live-qualified and enabled. Safe Links and Safe Attachments run only when their
 * own rows are enabled; otherwise they are skipped with the row's reason.
 */
export function mailFlowActivation(ledger) {
  const rows = new Map((ledger?.rows ?? []).map((row) => [row.id, row]));
  const describe = (id) => {
    const row = rows.get(id);
    return `${id} is ${row?.state ?? 'not in the ledger'}${row?.prerequisite ? `: ${row.prerequisite.message}` : ''}`;
  };
  const reasons = [];
  const exchange = exchangeActivation(ledger);
  if (!exchange.enabled) reasons.push(`Exchange is not qualified yet, and mail flow follows it: ${exchange.reasons.join('; ')}`);
  for (const id of CORE_OPERATIONS) if (!rows.get(id)?.enabled) reasons.push(describe(id));
  const families = FAMILY_NAMES.filter((name) => !FAMILIES[name].license || rows.get(FAMILIES[name].operation)?.enabled);
  const skipped = LICENSED_FAMILIES.filter((name) => !families.includes(name))
    .map((name) => ({ family: name, operation: FAMILIES[name].operation, reason: describe(FAMILIES[name].operation) }));
  return { enabled: reasons.length === 0, reasons, families, skipped };
}

/** Persists one run in one transaction; one row per object. */
export async function recordMailFlowRun(client, { tenantRef, result }) {
  await client.query('BEGIN');
  try {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, MAIL_FLOW_WORKLOAD, result.outcome, result.observedFrom, result.observedTo, {
        discovery: result.discovery ?? null,
        fieldCounts: result.fieldCounts ?? {},
        failures: result.failures ?? [],
        unavailable: result.unavailable ?? [],
        skipped: result.skipped ?? [],
        reasons: result.reasons ?? [],
      }],
    );
    for (const resource of result.resources ?? []) {
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields, field_coverage)
         VALUES ($1,$2,$3,$4) ON CONFLICT (collection_id, resource_key) DO NOTHING`,
        [run.id, resource.resourceKey, { identity: resource.identity, kind: resource.kind, ...resource.fields }, resource.fieldCoverage],
      );
    }
    await client.query('COMMIT');
    return run;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
export async function collectMailFlow(client, { tenantRef, ledger, powershell, maxObjects, now }) {
  const activation = mailFlowActivation(ledger);
  if (!activation.enabled) {
    const at = (now?.() ?? new Date()).toISOString();
    const run = await recordMailFlowRun(client, { tenantRef, result: { outcome: 'disabled', observedFrom: at, observedTo: at, reasons: activation.reasons } });
    return { run, result: null, activation };
  }
  const result = await readMailFlow({ powershell, families: activation.families, skipped: activation.skipped, maxObjects, now });
  const run = await recordMailFlowRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const mailFlowAdapter = Object.freeze({
  async collect() {
    throw new Error('the Exchange mail flow workload adapter is disabled until live qualification; use collectMailFlow with the ledger');
  },
});

registerWorkload(MAIL_FLOW_DESCRIPTOR, mailFlowAdapter);
