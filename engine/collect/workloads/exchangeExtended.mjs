/**
 * READ-EXO: the Exchange and Defender settings the mail flow workload does not read.
 *
 * Twenty-one families, each its own task-101 operation and one Get cmdlet run in the
 * Exchange Online session:
 *  - outbound spam policies and rules, and the connection filter (IP allow and block lists);
 *  - the rules that scope the anti-spam, anti-phishing and anti-malware policies
 *    (mailFlow.mjs reads the policies; without their rules a restore cannot say who
 *    each policy applies to), and the Standard and Strict preset policy rules;
 *  - quarantine policies, and the global quarantine notification settings;
 *  - journal rules;
 *  - mobile device (ActiveSync) mailbox policies, device access rules and the
 *    organization's ActiveSync access settings;
 *  - address lists, global address lists, offline address books and address book policies;
 *  - retention (MRM) policy tags and retention policies;
 *  - Microsoft Defender for Office 365: the Safe Links and Safe Attachments rules, the
 *    Defender preset policy rules, and Safe Attachments for SharePoint, OneDrive and Teams.
 * Every object becomes one observation, keyed by its Guid (it survives a rename; the
 * name is kept as a field).
 *
 * Rules (the same as mailFlow.mjs):
 *  - Read only. Only the Get cmdlets in EXCHANGE_EXTENDED_CMDLET_PARAMETERS run, each with
 *    its fixed parameters (none, except the global quarantine read). No write capability
 *    exists for this workload.
 *  - Declared fields only. Anything else an answer carries is dropped unread. No declared
 *    field holds a secret; a credential-shaped value an administrator typed is still redacted.
 *  - Errors are structured. A family that fails is `failed` or `denied`, never an empty list.
 *  - Unlicensed is an observation. Without Defender for Office 365, Exchange does not
 *    expose the Defender cmdlets, and those families are recorded as `not-licensed`.
 *  - Disabled until qualified. Nothing is sent unless the Exchange mailbox workload is
 *    qualified AND every core read here is live-qualified and enabled. Each Defender read
 *    runs only when its own row is enabled, and is otherwise listed as skipped.
 */
import { registerWorkload } from '../registry.mjs';
import { CmdletError, runCmdlet } from '../../powershell/jobQueue.mjs';
import { redactPayload } from '../../telemetry/events.mjs';
import { exchangeActivation, structuredFailure } from './exchange.mjs';

export const EXCHANGE_EXTENDED_WORKLOAD = 'exchange-extended';
export const EXCHANGE_EXTENDED_MODULE = 'ExchangeOnlineManagement';
export const DEFAULT_MAX_OBJECTS = 1000;

const WHEN = 'WhenChangedUTC';
const DEFENDER = 'Microsoft Defender for Office 365';

// Who a protection rule applies to, and who it leaves out.
const RECIPIENT_SCOPE = Object.freeze([
  'Name', 'State', 'Priority', 'Comments', 'SentTo', 'SentToMemberOf', 'RecipientDomainIs',
  'ExceptIfSentTo', 'ExceptIfSentToMemberOf', 'ExceptIfRecipientDomainIs', WHEN,
]);
const SENDER_SCOPE = Object.freeze([
  'Name', 'State', 'Priority', 'Comments', 'From', 'FromMemberOf', 'SenderDomainIs',
  'ExceptIfFrom', 'ExceptIfFromMemberOf', 'ExceptIfSenderDomainIs', WHEN,
]);
const rule = (policyField) => Object.freeze([policyField, ...RECIPIENT_SCOPE]);

/**
 * The families. `parameters` are fixed by KEEL, never taken from a job. Fields were
 * declared from Microsoft's cmdlet documentation, not measured live.
 */
export const FAMILIES = Object.freeze({
  outboundSpamPolicy: Object.freeze({
    operation: 'exchange-extended.outbound-spam-policies', cmdlet: 'Get-HostedOutboundSpamFilterPolicy', prefix: 'outbound-spam-policy',
    fields: Object.freeze([
      'Name', 'IsDefault', 'AdminDisplayName', 'RecipientLimitExternalPerHour', 'RecipientLimitInternalPerHour', 'RecipientLimitPerDay',
      'ActionWhenThresholdReached', 'AutoForwardingMode', 'BccSuspiciousOutboundMail', 'BccSuspiciousOutboundAdditionalRecipients',
      'NotifyOutboundSpam', 'NotifyOutboundSpamRecipients', WHEN,
    ]),
  }),
  outboundSpamRule: Object.freeze({
    operation: 'exchange-extended.outbound-spam-rules', cmdlet: 'Get-HostedOutboundSpamFilterRule', prefix: 'outbound-spam-rule',
    fields: Object.freeze(['HostedOutboundSpamFilterPolicy', ...SENDER_SCOPE]),
  }),
  connectionFilterPolicy: Object.freeze({
    operation: 'exchange-extended.connection-filter-policies', cmdlet: 'Get-HostedConnectionFilterPolicy', prefix: 'connection-filter-policy',
    fields: Object.freeze(['Name', 'IsDefault', 'AdminDisplayName', 'IPAllowList', 'IPBlockList', 'EnableSafeList', WHEN]),
  }),
  antiSpamRule: Object.freeze({
    operation: 'exchange-extended.anti-spam-rules', cmdlet: 'Get-HostedContentFilterRule', prefix: 'anti-spam-rule',
    fields: rule('HostedContentFilterPolicy'),
  }),
  antiPhishRule: Object.freeze({
    operation: 'exchange-extended.anti-phish-rules', cmdlet: 'Get-AntiPhishRule', prefix: 'anti-phish-rule',
    fields: rule('AntiPhishPolicy'),
  }),
  antiMalwareRule: Object.freeze({
    operation: 'exchange-extended.anti-malware-rules', cmdlet: 'Get-MalwareFilterRule', prefix: 'anti-malware-rule',
    fields: rule('MalwareFilterPolicy'),
  }),
  eopPresetRule: Object.freeze({
    operation: 'exchange-extended.eop-preset-rules', cmdlet: 'Get-EOPProtectionPolicyRule', prefix: 'eop-preset-rule',
    fields: Object.freeze(['HostedContentFilterPolicy', 'AntiPhishPolicy', 'MalwareFilterPolicy', ...RECIPIENT_SCOPE]),
  }),
  quarantinePolicy: Object.freeze({
    operation: 'exchange-extended.quarantine-policies', cmdlet: 'Get-QuarantinePolicy', prefix: 'quarantine-policy',
    fields: Object.freeze([
      'Name', 'QuarantinePolicyType', 'EndUserQuarantinePermissionsValue', 'ESNEnabled', 'IncludeMessagesFromBlockedSenderAddress', WHEN,
    ]),
  }),
  globalQuarantineSettings: Object.freeze({
    operation: 'exchange-extended.quarantine-global-settings', cmdlet: 'Get-QuarantinePolicy', prefix: 'quarantine-global',
    parameters: Object.freeze({ QuarantinePolicyType: 'GlobalQuarantinePolicy' }),
    fields: Object.freeze([
      'Name', 'QuarantinePolicyType', 'EndUserSpamNotificationFrequency', 'EndUserSpamNotificationFrequencyInDays',
      'EndUserSpamNotificationCustomFromAddress', 'MultiLanguageSetting', 'MultiLanguageCustomDisclaimer', 'MultiLanguageSenderName',
      'OrganizationBrandingEnabled', WHEN,
    ]),
  }),
  journalRule: Object.freeze({
    operation: 'exchange-extended.journal-rules', cmdlet: 'Get-JournalRule', prefix: 'journal-rule',
    fields: Object.freeze(['Name', 'Enabled', 'Recipient', 'JournalEmailAddress', 'Scope', WHEN]),
  }),
  mobileDevicePolicy: Object.freeze({
    operation: 'exchange-extended.mobile-device-policies', cmdlet: 'Get-MobileDeviceMailboxPolicy', prefix: 'mobile-device-policy',
    fields: Object.freeze([
      'Name', 'IsDefault', 'AllowNonProvisionableDevices', 'PasswordEnabled', 'AlphanumericPasswordRequired', 'AllowSimplePassword',
      'MinPasswordLength', 'MinPasswordComplexCharacters', 'MaxPasswordFailedAttempts', 'PasswordExpiration', 'PasswordHistory',
      'MaxInactivityTimeLock', 'PasswordRecoveryEnabled', 'DeviceEncryptionEnabled', 'RequireDeviceEncryption', 'RequireStorageCardEncryption',
      'AttachmentsEnabled', 'MaxAttachmentSize', 'AllowCamera', 'AllowBluetooth', 'AllowBrowser', 'AllowStorageCard', 'AllowWiFi',
      'AllowTextMessaging', 'AllowPOPIMAPEmail', 'AllowHTMLEmail', 'DevicePolicyRefreshInterval', WHEN,
    ]),
  }),
  deviceAccessRule: Object.freeze({
    operation: 'exchange-extended.device-access-rules', cmdlet: 'Get-ActiveSyncDeviceAccessRule', prefix: 'device-access-rule',
    fields: Object.freeze(['Name', 'QueryString', 'Characteristic', 'AccessLevel', WHEN]),
  }),
  activeSyncSettings: Object.freeze({
    operation: 'exchange-extended.activesync-settings', cmdlet: 'Get-ActiveSyncOrganizationSettings', prefix: 'activesync-settings',
    fields: Object.freeze([
      'Name', 'DefaultAccessLevel', 'UserMailInsert', 'AdminMailRecipients', 'OtaNotificationMailInsert', 'AllowAccessForUnSupportedPlatform', WHEN,
    ]),
  }),
  addressList: Object.freeze({
    operation: 'exchange-extended.address-lists', cmdlet: 'Get-AddressList', prefix: 'address-list',
    fields: Object.freeze([
      'Name', 'DisplayName', 'Path', 'RecipientFilter', 'IncludedRecipients', 'ConditionalCompany', 'ConditionalDepartment',
      'ConditionalStateOrProvince', 'ConditionalCustomAttribute1', 'ConditionalCustomAttribute2', 'RecipientContainer', WHEN,
    ]),
  }),
  globalAddressList: Object.freeze({
    operation: 'exchange-extended.global-address-lists', cmdlet: 'Get-GlobalAddressList', prefix: 'global-address-list',
    fields: Object.freeze([
      'Name', 'IsDefaultGlobalAddressList', 'RecipientFilter', 'IncludedRecipients', 'ConditionalCompany', 'ConditionalDepartment',
      'ConditionalStateOrProvince', 'ConditionalCustomAttribute1', 'ConditionalCustomAttribute2', WHEN,
    ]),
  }),
  offlineAddressBook: Object.freeze({
    operation: 'exchange-extended.offline-address-books', cmdlet: 'Get-OfflineAddressBook', prefix: 'offline-address-book',
    fields: Object.freeze(['Name', 'IsDefault', 'AddressLists', 'DiffRetentionPeriod', WHEN]),
  }),
  addressBookPolicy: Object.freeze({
    operation: 'exchange-extended.address-book-policies', cmdlet: 'Get-AddressBookPolicy', prefix: 'address-book-policy',
    fields: Object.freeze(['Name', 'AddressLists', 'GlobalAddressList', 'OfflineAddressBook', 'RoomList', WHEN]),
  }),
  retentionPolicyTag: Object.freeze({
    operation: 'exchange-extended.retention-policy-tags', cmdlet: 'Get-RetentionPolicyTag', prefix: 'retention-policy-tag',
    fields: Object.freeze([
      'Name', 'Type', 'RetentionEnabled', 'AgeLimitForRetention', 'RetentionAction', 'Comment', 'MessageClass', 'SystemTag',
      'LocalizedRetentionPolicyTagName', 'LocalizedComment', 'RetentionId', WHEN,
    ]),
  }),
  retentionPolicy: Object.freeze({
    operation: 'exchange-extended.retention-policies', cmdlet: 'Get-RetentionPolicy', prefix: 'retention-policy',
    fields: Object.freeze(['Name', 'IsDefault', 'IsDefaultArbitrationMailbox', 'RetentionPolicyTagLinks', 'RetentionId', WHEN]),
  }),
  safeLinksRule: Object.freeze({
    operation: 'exchange-extended.safe-links-rules', cmdlet: 'Get-SafeLinksRule', prefix: 'safe-links-rule', license: DEFENDER,
    fields: rule('SafeLinksPolicy'),
  }),
  safeAttachmentRule: Object.freeze({
    operation: 'exchange-extended.safe-attachment-rules', cmdlet: 'Get-SafeAttachmentRule', prefix: 'safe-attachment-rule', license: DEFENDER,
    fields: rule('SafeAttachmentPolicy'),
  }),
  defenderPresetRule: Object.freeze({
    operation: 'exchange-extended.defender-preset-rules', cmdlet: 'Get-ATPProtectionPolicyRule', prefix: 'defender-preset-rule', license: DEFENDER,
    fields: Object.freeze(['SafeLinksPolicy', 'SafeAttachmentPolicy', ...RECIPIENT_SCOPE]),
  }),
  defenderForOffice: Object.freeze({
    operation: 'exchange-extended.defender-office-apps', cmdlet: 'Get-AtpPolicyForO365', prefix: 'defender-office-apps', license: DEFENDER,
    fields: Object.freeze(['Name', 'EnableATPForSPOTeamsODB', 'EnableSafeDocs', 'AllowSafeDocsOpen', WHEN]),
  }),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const EXCHANGE_EXTENDED_OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));
/** Families that need an add-on licence: optional for activation, never a failure when absent. */
export const LICENSED_FAMILIES = Object.freeze(FAMILY_NAMES.filter((name) => FAMILIES[name].license));
export const CORE_OPERATIONS = Object.freeze(FAMILY_NAMES.filter((name) => !FAMILIES[name].license).map((name) => FAMILIES[name].operation));

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const EXCHANGE_EXTENDED_DESCRIPTOR = Object.freeze({
  type: 'exchangeExtended',
  workload: EXCHANGE_EXTENDED_WORKLOAD,
  adapter: 'exchange-extended',
  readOnly: true,
  enabledByDefault: false,
  operations: EXCHANGE_EXTENDED_OPERATIONS,
});

// The only cmdlets this workload runs, and the only parameters each may receive.
// ops/powershell/run-cmdlet.ps1 ($AllowedExchangeExtended) holds the same list and checks it again.
export const EXCHANGE_EXTENDED_CMDLET_PARAMETERS = Object.freeze(FAMILY_NAMES.reduce((allowed, name) => {
  const { cmdlet, parameters = {} } = FAMILIES[name];
  return { ...allowed, [cmdlet]: Object.freeze([...new Set([...(allowed[cmdlet] ?? []), ...Object.keys(parameters)])]) };
}, {}));
export const EXCHANGE_EXTENDED_CMDLETS = new Set(Object.keys(EXCHANGE_EXTENDED_CMDLET_PARAMETERS));

export class ExchangeExtendedScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExchangeExtendedScopeError';
  }
}

/** Throws unless the cmdlet is one of the reads above and is given only its allowed parameters. */
export function assertExchangeExtendedCmdlet({ cmdlet, parameters = {} }) {
  const allowed = EXCHANGE_EXTENDED_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new ExchangeExtendedScopeError(`${cmdlet} is not an Exchange configuration read KEEL runs; this workload never writes or reads messages`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new ExchangeExtendedScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  return true;
}

/** Runs one cmdlet through the bounded job transport. */
export async function exchangeExtendedCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertExchangeExtendedCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: EXCHANGE_EXTENDED_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: EXCHANGE_EXTENDED_CMDLETS });
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stable identity of one answer: its Guid, or null when it has none KEEL trusts. */
export function objectIdentity(body) {
  const id = String(body?.Guid ?? '');
  return GUID.test(id) ? id.toLowerCase() : null;
}
export const exchangeExtendedKey = (family, identity) => `${FAMILIES[family].prefix}:${identity}`;

// Exchange answers a cmdlet the session does not expose (no licence, or no role
// granting it) with CommandNotFoundException.
const NOT_FOUND = /CommandNotFoundException|is not recognized as (?:the |a )?name of a cmdlet/i;
function notExposed(error) {
  return error instanceof CmdletError && NOT_FOUND.test(`${error.detail.errorId ?? ''} ${error.detail.message ?? ''}`);
}

function observeObject(family, body) {
  const { fields, operation } = FAMILIES[family];
  const entry = { fields: {}, fieldCoverage: {} };
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) {
      entry.fieldCoverage[field] = { status: 'unknown', operation };
      continue;
    }
    // Defence in depth: a credential-shaped value is redacted by the shared telemetry
    // redactor and marked as such, never stored or mistaken for a restorable value.
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
  const { cmdlet, parameters = {}, operation, license } = FAMILIES[family];
  let output;
  try {
    ({ output } = await exchangeExtendedCmdlet({ cmdlet, parameters }, powershell));
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
    const identity = body && typeof body === 'object' ? objectIdentity(body) : null;
    if (!identity) { unidentified += 1; continue; }
    if (seen.has(identity)) continue;
    if (resources.length >= maxObjects) { capped = true; continue; }
    seen.add(identity);
    resources.push({ resourceKey: exchangeExtendedKey(family, identity), kind: family, identity, ...observeObject(family, body) });
  }
  return { resources, failure: null, capped, unidentified, unavailable: null };
}

/**
 * Reads the named families (all by default). Pure apart from the injected PowerShell
 * options: no database, no gate. `skipped` lists families the caller did not read, with
 * the reason. Callers outside tests use collectExchangeExtended.
 */
export async function readExchangeExtended({ powershell = {}, families = FAMILY_NAMES, skipped = [], maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() }) {
  for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown Exchange family ${family}`);
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
  // Which declared fields an answer did not carry, per family, so a partial run says
  // what it is missing (names only, never values).
  const unknownFields = {};
  for (const entry of resources) {
    for (const [field, coverage] of Object.entries(entry.fieldCoverage)) {
      if (coverage.status !== 'unknown') continue;
      const family = (unknownFields[entry.kind] ??= {});
      family[field] = (family[field] ?? 0) + 1;
    }
  }
  const perFamily = Object.fromEntries(families.map((family, index) => {
    const read = reads[index];
    const status = read.failure ? read.failure.status : read.unavailable ? read.unavailable.status : 'read';
    return [family, { status, objects: read.resources.length }];
  }));
  let outcome;
  // Nothing usable was read (as in mailFlow.mjs): no object kept, every family failed,
  // was unavailable or answered only unidentified objects, and not all were unavailable.
  if (families.length > 0 && resources.length === 0
    && reads.every((read) => read.failure || read.unavailable || read.unidentified > 0)
    && reads.some((read) => read.failure || read.unidentified > 0)) outcome = 'failed';
  else if (failures.length || unavailable.length || skipped.length || capped || unidentified
    || statuses.some((status) => status !== 'observed')) outcome = 'partial';
  else if (resources.length === 0) outcome = 'complete-empty';
  else outcome = 'complete';
  return {
    workload: EXCHANGE_EXTENDED_WORKLOAD,
    outcome,
    observedFrom,
    observedTo: now().toISOString(),
    discovery: { families: perFamily, objects: resources.length, capped, unidentified, maxObjects },
    resources,
    failures,
    unavailable,
    skipped,
    fieldCounts,
    unknownFields,
  };
}

/**
 * Whether live collection may run, and which families. The Exchange mailbox workload
 * must be qualified first, and every core read here must be live-qualified and enabled.
 * The Defender reads run only when their own rows are enabled; otherwise they are skipped.
 */
export function exchangeExtendedActivation(ledger) {
  const rows = new Map((ledger?.rows ?? []).map((row) => [row.id, row]));
  const describe = (id) => {
    const row = rows.get(id);
    return `${id} is ${row?.state ?? 'not in the ledger'}${row?.prerequisite ? `: ${row.prerequisite.message}` : ''}`;
  };
  const reasons = [];
  const exchange = exchangeActivation(ledger);
  if (!exchange.enabled) reasons.push(`Exchange is not qualified yet, and these reads follow it: ${exchange.reasons.join('; ')}`);
  for (const id of CORE_OPERATIONS) if (!rows.get(id)?.enabled) reasons.push(describe(id));
  const families = FAMILY_NAMES.filter((name) => !FAMILIES[name].license || rows.get(FAMILIES[name].operation)?.enabled);
  const skipped = LICENSED_FAMILIES.filter((name) => !families.includes(name))
    .map((name) => ({ family: name, operation: FAMILIES[name].operation, reason: describe(FAMILIES[name].operation) }));
  return { enabled: reasons.length === 0, reasons, families, skipped };
}

/** Persists one run in one transaction; one row per object. */
export async function recordExchangeExtendedRun(client, { tenantRef, result }) {
  await client.query('BEGIN');
  try {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, EXCHANGE_EXTENDED_WORKLOAD, result.outcome, result.observedFrom, result.observedTo, {
        discovery: result.discovery ?? null,
        fieldCounts: result.fieldCounts ?? {},
        unknownFields: result.unknownFields ?? {},
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
export async function collectExchangeExtended(client, { tenantRef, ledger, powershell, maxObjects, now }) {
  const activation = exchangeExtendedActivation(ledger);
  if (!activation.enabled) {
    const at = (now?.() ?? new Date()).toISOString();
    const run = await recordExchangeExtendedRun(client, { tenantRef, result: { outcome: 'disabled', observedFrom: at, observedTo: at, reasons: activation.reasons } });
    return { run, result: null, activation };
  }
  const result = await readExchangeExtended({ powershell, families: activation.families, skipped: activation.skipped, maxObjects, now });
  const run = await recordExchangeExtendedRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const exchangeExtendedAdapter = Object.freeze({
  async collect() {
    throw new Error('the extended Exchange workload adapter is disabled until live qualification; use collectExchangeExtended with the ledger');
  },
});

registerWorkload(EXCHANGE_EXTENDED_DESCRIPTOR, exchangeExtendedAdapter);
