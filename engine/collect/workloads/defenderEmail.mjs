/**
 * Defender email protection: the Microsoft Defender for Office 365 and Exchange Online
 * Protection settings that mail flow (mailFlow.mjs) and the extended Exchange read
 * (exchangeExtended.mjs) do not read. Gap audit 2026-10-30, section B.
 *
 * A workload of its own (`defender-email-protection`), listed under Defender:
 *  - the Tenant Allow/Block List: sender, URL, file hash and IP entries, and spoofed
 *    sender pairs (an allow entry is the classic way phishing gets let in);
 *  - advanced delivery: the third-party phishing simulation and SecOps mailbox
 *    overrides, which skip filtering, and the simulation URLs they allow;
 *  - the exceptions to Built-in protection, and Teams protection (zero-hour purge in
 *    Teams) with its rule;
 *  - where reported messages go (report submission policy and rule);
 *  - the trusted ARC sealers.
 * Each family is its own task-101 operation and one Get cmdlet in the Exchange Online
 * session. Every object becomes one observation under the identity Exchange gives it.
 *
 * Rules (the same as the other Exchange cmdlet workloads):
 *  - Read only. Only the Get cmdlets in DEFENDER_EMAIL_CMDLET_PARAMETERS run, each with
 *    the fixed parameters its family names. No write capability exists for this workload.
 *  - Declared fields only. Anything else an answer carries is dropped unread. No declared
 *    field holds a secret; a credential-shaped value an administrator typed is redacted.
 *  - Identity is never guessed. Allow/Block List entries carry no Guid, so their key is
 *    the Identity Exchange assigns (the id Set- and Remove- take); every other object is
 *    keyed by its Guid; the ARC settings are one object per tenant.
 *  - Errors are structured. A family that fails is `failed` or `denied`, never an empty list.
 *  - Unlicensed is an observation. Without Defender for Office 365 the Built-in protection
 *    and Teams protection cmdlets are not exposed, and those families are `not-licensed`.
 *  - Disabled until qualified. Nothing is sent unless the Exchange mailbox workload is
 *    qualified AND every core read here is live-qualified and enabled. Each Defender read
 *    runs only when its own row is enabled, and is otherwise listed as skipped. Fields
 *    were declared from Microsoft's cmdlet documentation, not measured live.
 */
import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { exchangeActivation, structuredFailure } from './exchange.mjs';
import {
  emptyRead, guidOf, ledgerRows, notExposed, objectsFrom, recordCmdletRun, recordDisabledRun, summarize,
} from './cmdletFamilies.mjs';

export const DEFENDER_EMAIL_WORKLOAD = 'defender-email-protection';
export const DEFENDER_EMAIL_MODULE = 'ExchangeOnlineManagement';
export const DEFAULT_MAX_OBJECTS = 5000;

const WHEN = 'WhenChangedUTC';
const DEFENDER = 'Microsoft Defender for Office 365';

// An Allow/Block List entry's Identity: an opaque token Exchange assigns (letters,
// digits and URL-safe base64 marks). Kept as Exchange wrote it: case matters.
const ENTRY_ID = /^[A-Za-z0-9_\-+/=]{8,512}$/;
const byGuid = (body) => guidOf(body.Guid);
const byEntryId = (body) => (typeof body.Identity === 'string' && ENTRY_ID.test(body.Identity) ? body.Identity : null);
// A spoofed sender pair's Identity is a random Guid (Microsoft Learn).
const bySpoofId = (body) => guidOf(body.Guid) ?? guidOf(body.Identity);
// One object per tenant.
const tenantWide = () => 'organization';

const ENTRY_FIELDS = Object.freeze([
  // LastUsedDate changes every time an entry matches a message, so it is not kept.
  'Value', 'Action', 'ListType', 'ListSubType', 'ExpirationDate', 'RemoveAfter', 'Notes', 'SubmissionID', 'SysManaged',
  'CreatedDateTime', 'LastModifiedDateTime', 'ModifiedBy',
]);
const entries = (listType, operation, prefix, extra = {}) => Object.freeze({
  operation: `${DEFENDER_EMAIL_WORKLOAD}.${operation}`, cmdlet: 'Get-TenantAllowBlockListItems', prefix, identity: byEntryId,
  parameters: Object.freeze({ ListType: listType, ...extra }), fields: ENTRY_FIELDS,
});
const EXCEPT = Object.freeze(['ExceptIfSentTo', 'ExceptIfSentToMemberOf', 'ExceptIfRecipientDomainIs']);

/**
 * The families, in the order a list shows them: the Allow/Block List entries, then the
 * filter bypasses (advanced delivery), then protection policies before their rules, then
 * tenant-wide settings. `parameters` are fixed by KEEL, never taken from a job.
 */
export const FAMILIES = Object.freeze({
  blockListSender: entries('Sender', 'allow-block-senders', 'allow-block-sender'),
  blockListUrl: entries('Url', 'allow-block-urls', 'allow-block-url'),
  blockListFileHash: entries('FileHash', 'allow-block-file-hashes', 'allow-block-file-hash'),
  blockListIp: entries('IP', 'allow-block-ips', 'allow-block-ip'),
  blockListSpoof: Object.freeze({
    operation: `${DEFENDER_EMAIL_WORKLOAD}.allow-block-spoofed-senders`, cmdlet: 'Get-TenantAllowBlockListSpoofItems', prefix: 'allow-block-spoof',
    identity: bySpoofId, fields: Object.freeze(['SpoofedUser', 'SendingInfrastructure', 'SpoofType', 'Action']),
  }),
  phishSimOverridePolicy: Object.freeze({
    operation: `${DEFENDER_EMAIL_WORKLOAD}.phish-sim-override-policies`, cmdlet: 'Get-PhishSimOverridePolicy', prefix: 'phish-sim-override-policy',
    identity: byGuid, fields: Object.freeze(['Name', 'Enabled', 'Mode', 'Comment']),
  }),
  phishSimOverrideRule: Object.freeze({
    operation: `${DEFENDER_EMAIL_WORKLOAD}.phish-sim-override-rules`, cmdlet: 'Get-ExoPhishSimOverrideRule', prefix: 'phish-sim-override-rule',
    identity: byGuid, fields: Object.freeze(['Name', 'Policy', 'Domains', 'SenderIpRanges', 'Mode', 'Comment']),
  }),
  phishSimUrl: entries('Url', 'phish-sim-urls', 'phish-sim-url', { ListSubType: 'AdvancedDelivery' }),
  secOpsOverridePolicy: Object.freeze({
    operation: `${DEFENDER_EMAIL_WORKLOAD}.secops-override-policies`, cmdlet: 'Get-SecOpsOverridePolicy', prefix: 'secops-override-policy',
    identity: byGuid, fields: Object.freeze(['Name', 'Enabled', 'Mode', 'SentTo', 'Comment']),
  }),
  secOpsOverrideRule: Object.freeze({
    operation: `${DEFENDER_EMAIL_WORKLOAD}.secops-override-rules`, cmdlet: 'Get-ExoSecOpsOverrideRule', prefix: 'secops-override-rule',
    identity: byGuid, fields: Object.freeze(['Name', 'Policy', 'SentTo', 'Mode', 'Comment']),
  }),
  builtInProtectionRule: Object.freeze({
    operation: `${DEFENDER_EMAIL_WORKLOAD}.built-in-protection-rules`, cmdlet: 'Get-ATPBuiltInProtectionRule', prefix: 'built-in-protection-rule',
    identity: byGuid, license: DEFENDER,
    fields: Object.freeze(['Name', 'State', 'Priority', 'Comments', 'SafeLinksPolicy', 'SafeAttachmentPolicy', ...EXCEPT]),
  }),
  teamsProtectionPolicy: Object.freeze({
    operation: `${DEFENDER_EMAIL_WORKLOAD}.teams-protection-policies`, cmdlet: 'Get-TeamsProtectionPolicy', prefix: 'teams-protection-policy',
    identity: byGuid, license: DEFENDER,
    fields: Object.freeze(['Name', 'ZapEnabled', 'HighConfidencePhishQuarantineTag', 'MalwareQuarantineTag', WHEN]),
  }),
  teamsProtectionRule: Object.freeze({
    operation: `${DEFENDER_EMAIL_WORKLOAD}.teams-protection-rules`, cmdlet: 'Get-TeamsProtectionPolicyRule', prefix: 'teams-protection-rule',
    identity: byGuid, license: DEFENDER,
    fields: Object.freeze(['Name', 'TeamsProtectionPolicy', 'Comments', ...EXCEPT]),
  }),
  reportSubmissionPolicy: Object.freeze({
    operation: `${DEFENDER_EMAIL_WORKLOAD}.report-submission-policies`, cmdlet: 'Get-ReportSubmissionPolicy', prefix: 'report-submission-policy',
    identity: byGuid,
    // The settings that decide whether people can report and where reports go. The
    // message texts shown before and after a report are left out.
    fields: Object.freeze([
      'Name', 'DisableUserSubmissionOptions', 'DisableQuarantineReportingOption', 'EnableReportToMicrosoft',
      'EnableThirdPartyAddress', 'ThirdPartyReportAddresses',
      'ReportJunkToCustomizedAddress', 'ReportJunkAddresses', 'ReportNotJunkToCustomizedAddress', 'ReportNotJunkAddresses',
      'ReportPhishToCustomizedAddress', 'ReportPhishAddresses',
      'ReportChatMessageEnabled', 'ReportChatMessageToCustomizedAddressEnabled', 'ReportChatMessageAddresses',
      'EnableUserEmailNotification', 'EnableCustomNotificationSender', 'NotificationSenderAddress', 'EnableOrganizationBranding',
      'PreSubmitMessageEnabled', 'PostSubmitMessageEnabled', 'OnlyShowPhishingDisclaimer', WHEN,
    ]),
  }),
  reportSubmissionRule: Object.freeze({
    operation: `${DEFENDER_EMAIL_WORKLOAD}.report-submission-rules`, cmdlet: 'Get-ReportSubmissionRule', prefix: 'report-submission-rule',
    identity: byGuid, fields: Object.freeze(['Name', 'State', 'ReportSubmissionPolicy', 'SentTo', 'Comments']),
  }),
  arcConfig: Object.freeze({
    operation: `${DEFENDER_EMAIL_WORKLOAD}.arc-trusted-sealers`, cmdlet: 'Get-ArcConfig', prefix: 'arc-config',
    identity: tenantWide, fields: Object.freeze(['ArcTrustedSealers']),
  }),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const DEFENDER_EMAIL_OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));
/** Families that need an add-on licence: optional for activation, never a failure when absent. */
export const LICENSED_FAMILIES = Object.freeze(FAMILY_NAMES.filter((name) => FAMILIES[name].license));
export const CORE_OPERATIONS = Object.freeze(FAMILY_NAMES.filter((name) => !FAMILIES[name].license).map((name) => FAMILIES[name].operation));

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const DEFENDER_EMAIL_DESCRIPTOR = Object.freeze({
  type: 'defenderEmailProtection',
  workload: DEFENDER_EMAIL_WORKLOAD,
  adapter: 'defender-email-protection',
  readOnly: true,
  enabledByDefault: false,
  operations: DEFENDER_EMAIL_OPERATIONS,
});

// The only cmdlets this workload runs, and the only parameters each may receive.
// ops/powershell/run-cmdlet.ps1 ($AllowedDefenderEmail) holds the same list and checks it again.
export const DEFENDER_EMAIL_CMDLET_PARAMETERS = Object.freeze(FAMILY_NAMES.reduce((allowed, name) => {
  const { cmdlet, parameters = {} } = FAMILIES[name];
  return { ...allowed, [cmdlet]: Object.freeze([...new Set([...(allowed[cmdlet] ?? []), ...Object.keys(parameters)])]) };
}, {}));
export const DEFENDER_EMAIL_CMDLETS = new Set(Object.keys(DEFENDER_EMAIL_CMDLET_PARAMETERS));

export class DefenderEmailScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DefenderEmailScopeError';
  }
}

const sameParameters = (a = {}, b = {}) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Throws unless the call is exactly one family's read: its cmdlet with its fixed parameters. */
export function assertDefenderEmailCmdlet({ cmdlet, parameters = {} }) {
  const allowed = DEFENDER_EMAIL_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new DefenderEmailScopeError(`${cmdlet} is not a Defender email protection read KEEL runs; this workload never writes`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new DefenderEmailScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  if (!FAMILY_NAMES.some((name) => FAMILIES[name].cmdlet === cmdlet && sameParameters(FAMILIES[name].parameters, parameters))) {
    throw new DefenderEmailScopeError(`${cmdlet} is only run with the fixed values its families name`);
  }
  return true;
}

/** Runs one cmdlet through the bounded job transport. */
export async function defenderEmailCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertDefenderEmailCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: DEFENDER_EMAIL_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: DEFENDER_EMAIL_CMDLETS });
}

async function readFamily(family, { powershell, maxObjects }) {
  const spec = FAMILIES[family];
  let output;
  try {
    ({ output } = await defenderEmailCmdlet({ cmdlet: spec.cmdlet, parameters: spec.parameters ?? {} }, powershell));
  } catch (error) {
    if (spec.license && notExposed(error)) {
      return emptyRead({
        unavailable: {
          family, operation: spec.operation, status: 'not-licensed', license: spec.license,
          reason: `${spec.cmdlet} is not available in this tenant: ${spec.license} is not licensed, or the app's Exchange role does not include it`,
          error: structuredFailure(error).error,
        },
      });
    }
    return emptyRead({ failure: { family, operation: spec.operation, ...structuredFailure(error) } });
  }
  return { ...emptyRead(), ...objectsFrom(family, spec, output, { maxObjects }) };
}

/**
 * Reads the named families (all by default). Pure apart from the injected PowerShell
 * options: no database, no gate. `skipped` lists families the caller did not read, with
 * the reason. Callers outside tests use collectDefenderEmail.
 */
export async function readDefenderEmail({ powershell = {}, families = FAMILY_NAMES, skipped = [], maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() }) {
  for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown Defender email protection family ${family}`);
  const observedFrom = now().toISOString();
  const reads = {};
  for (const family of families) reads[family] = await readFamily(family, { powershell, maxObjects });
  // Every list here may be empty in a working tenant, so no family is required.
  return summarize({ workload: DEFENDER_EMAIL_WORKLOAD, families, reads, skipped, maxObjects, observedFrom, observedTo: now().toISOString() });
}

/**
 * Whether live collection may run, and which families. The Exchange mailbox workload
 * must be qualified first, and every core read here must be live-qualified and enabled.
 * The Defender reads run only when their own rows are enabled; otherwise they are skipped.
 */
export function defenderEmailActivation(ledger) {
  const { rows, describe } = ledgerRows(ledger);
  const reasons = [];
  const exchange = exchangeActivation(ledger);
  if (!exchange.enabled) reasons.push(`Exchange is not qualified yet, and these reads follow it: ${exchange.reasons.join('; ')}`);
  for (const id of CORE_OPERATIONS) if (!rows.get(id)?.enabled) reasons.push(describe(id));
  const families = FAMILY_NAMES.filter((name) => !FAMILIES[name].license || rows.get(FAMILIES[name].operation)?.enabled);
  const skipped = LICENSED_FAMILIES.filter((name) => !families.includes(name))
    .map((name) => ({ family: name, operation: FAMILIES[name].operation, reason: describe(FAMILIES[name].operation) }));
  return { enabled: reasons.length === 0, reasons, families, skipped };
}

export const recordDefenderEmailRun = (client, { tenantRef, result }) => recordCmdletRun(client, DEFENDER_EMAIL_WORKLOAD, { tenantRef, result });

/** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
export async function collectDefenderEmail(client, { tenantRef, ledger, powershell, maxObjects, now }) {
  const activation = defenderEmailActivation(ledger);
  if (!activation.enabled) {
    const run = await recordDisabledRun(client, DEFENDER_EMAIL_WORKLOAD, { tenantRef, reasons: activation.reasons, now });
    return { run, result: null, activation };
  }
  const result = await readDefenderEmail({ powershell, families: activation.families, skipped: activation.skipped, maxObjects, now });
  const run = await recordDefenderEmailRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const defenderEmailAdapter = Object.freeze({
  async collect() {
    throw new Error('the Defender email protection workload adapter is disabled until live qualification; use collectDefenderEmail with the ledger');
  },
});

registerWorkload(DEFENDER_EMAIL_DESCRIPTOR, defenderEmailAdapter);
