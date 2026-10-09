/**
 * Issue #157: Purview retention policies and rules, and DLP policies and rules.
 *
 * A workload of its own (`purview-retention-dlp`), beside the task-106 sensitivity
 * label workload (`purview-labels`), which it does not change. Four families, each
 * its own task-101 operation and one Get cmdlet run with no parameters in the
 * Security & Compliance session (Connect-IPPSSession):
 *  - retention policies (Get-RetentionCompliancePolicy) and their rules
 *    (Get-RetentionComplianceRule);
 *  - DLP policies (Get-DlpCompliancePolicy) and their rules (Get-DlpComplianceRule).
 * Every object becomes one observation, keyed by its Guid (see FAMILIES).
 *
 * Rules:
 *  - Read only. Only the Get cmdlets in RETENTION_DLP_CMDLET_PARAMETERS run, with no
 *    parameters. No write capability exists for this workload. Restore is a separate
 *    task, and any write there that shortens retention must go through the content
 *    effect guard (engine/safety/contentEffects.mjs).
 *  - Policy configuration only. No cmdlet that reads DLP matches, incidents, alerts or
 *    reports runs (RETENTION_DLP_EXCLUDED_CMDLETS), and no item is listed to see which
 *    policy applies to it. Anything an answer carries beyond a family's declared
 *    fields is dropped unread. Sensitive information type definitions, keyword lists
 *    and custom patterns in a DLP rule are configuration and are kept; a value shaped
 *    like a credential is redacted by the shared redactor and never stored.
 *  - Rules keep their parent. Each rule records the Guid of the policy it belongs to
 *    (`parentPolicy`) and whether that policy was read in this run (`parentStatus`,
 *    see checkParents). A rule with no parent reference, or naming a policy its own
 *    policy family does not have, is kept but makes the run partial, because a later
 *    restore could not place it.
 *  - Duplicates are checked. A Guid answered twice keeps the first copy; a second
 *    copy that disagrees is recorded under `conflicts` and makes the run partial.
 *  - Locks are observed. A policy or rule that reports a preservation lock
 *    (`RestrictiveRetention` and the other LOCK_MARKERS) is recorded `locked`; one that
 *    reports none is `not-reported`, which is not proof of no lock.
 *  - Unlicensed is an observation, and a gap. DLP needs a licence that includes
 *    Microsoft Purview Data Loss Prevention. When the session does not expose a DLP
 *    cmdlet, that family is `not-licensed`. A DLP read runs only once its own row is
 *    live-qualified, so losing it later means those policies are no longer backed up:
 *    the run is partial, never complete.
 *  - Disabled until qualified. collectRetentionDlp() sends nothing unless the Exchange
 *    mailbox workload is qualified (as for Purview labels and mail flow) AND both
 *    retention reads are live-qualified and enabled. Each DLP read runs only when its
 *    own row is enabled, and is otherwise listed as skipped.
 */
import { registerWorkload } from '../registry.mjs';
import { CmdletError, runCmdlet } from '../../powershell/jobQueue.mjs';
import { redactPayload } from '../../telemetry/events.mjs';
import { exchangeActivation, structuredFailure } from './exchange.mjs';
import { lockState } from './purview.mjs';

export const RETENTION_DLP_WORKLOAD = 'purview-retention-dlp';
export const RETENTION_DLP_MODULE = 'ExchangeOnlineManagement';
export const DEFAULT_MAX_OBJECTS = 1000;

const WHEN = 'WhenChangedUTC';
const DLP_LICENCE = 'Microsoft Purview Data Loss Prevention';

// Where a retention or DLP policy applies. These are scope (mailboxes, sites, groups),
// not content.
const RETENTION_LOCATIONS = Object.freeze([
  'ExchangeLocation', 'ExchangeLocationException', 'SharePointLocation', 'SharePointLocationException',
  'OneDriveLocation', 'OneDriveLocationException', 'ModernGroupLocation', 'ModernGroupLocationException',
  'PublicFolderLocation', 'SkypeLocation', 'SkypeLocationException', 'TeamsChannelLocation', 'TeamsChannelLocationException',
  'TeamsChatLocation', 'TeamsChatLocationException', 'AdaptiveScopeLocation',
]);
const DLP_LOCATIONS = Object.freeze([
  'ExchangeLocation', 'SharePointLocation', 'SharePointLocationException', 'OneDriveLocation', 'OneDriveLocationException',
  'TeamsLocation', 'TeamsLocationException', 'EndpointDlpLocation', 'EndpointDlpLocationException',
  'OnPremisesScannerDlpLocation', 'OnPremisesScannerDlpLocationException', 'ExchangeSenderMemberOf', 'ExchangeSenderMemberOfException',
]);

/**
 * The families. Every object is keyed by its Guid: names are unique too, but they can
 * be renamed, and the Guid survives a rename. The name is kept as a field. Rules name
 * their policy in `Policy` (its Guid), kept as `parentPolicy`. Fields were declared
 * from Microsoft's cmdlet documentation, not measured live.
 */
export const FAMILIES = Object.freeze({
  retentionPolicy: Object.freeze({
    operation: 'purview.retention-policies', cmdlet: 'Get-RetentionCompliancePolicy', prefix: 'retention-policy', rule: false,
    fields: Object.freeze([
      'Name', 'Comment', 'Enabled', 'Mode', 'Type', 'Workload', 'RetentionRuleTypes', 'RestrictiveRetention',
      ...RETENTION_LOCATIONS, 'DistributionStatus', WHEN,
    ]),
  }),
  retentionRule: Object.freeze({
    operation: 'purview.retention-rules', cmdlet: 'Get-RetentionComplianceRule', prefix: 'retention-rule', rule: true, policyFamily: 'retentionPolicy',
    fields: Object.freeze([
      'Name', 'Policy', 'Comment', 'Disabled', 'Mode', 'Workload', 'RetentionDuration', 'RetentionDurationDisplayHint',
      'RetentionComplianceAction', 'ExpirationDateOption', 'ApplyComplianceTag', 'PublishComplianceTag', 'ContentMatchQuery',
      'ContentContainsSensitiveInformation', 'ExcludedItemClasses', WHEN,
    ]),
  }),
  dlpPolicy: Object.freeze({
    operation: 'purview.dlp-policies', cmdlet: 'Get-DlpCompliancePolicy', prefix: 'dlp-policy', rule: false, license: DLP_LICENCE,
    fields: Object.freeze([
      'Name', 'Comment', 'Mode', 'Type', 'Workload', 'Priority', ...DLP_LOCATIONS, 'PolicyTemplateInfo', 'DistributionStatus', WHEN,
    ]),
  }),
  dlpRule: Object.freeze({
    operation: 'purview.dlp-rules', cmdlet: 'Get-DlpComplianceRule', prefix: 'dlp-rule', rule: true, policyFamily: 'dlpPolicy', license: DLP_LICENCE,
    // GenerateIncidentReport and IncidentReportContent say who receives an incident
    // report and what it contains. They are configuration; no incident is read.
    fields: Object.freeze([
      'Name', 'Policy', 'ParentPolicyName', 'Comment', 'Disabled', 'Mode', 'Priority', 'Workload',
      'ContentContainsSensitiveInformation', 'ExceptIfContentContainsSensitiveInformation', 'AdvancedRule',
      'ContentPropertyContainsWords', 'SubjectOrBodyContainsWords', 'SubjectOrBodyMatchesPatterns', 'DocumentNameMatchesPatterns',
      'ContentExtensionMatchesWords', 'AccessScope', 'From', 'SentToMemberOf', 'SenderDomainIs', 'RecipientDomainIs',
      'ExceptIfSenderDomainIs', 'ExceptIfRecipientDomainIs', 'BlockAccess', 'BlockAccessScope', 'NotifyUser', 'NotifyUserType',
      'NotifyEmailCustomText', 'NotifyPolicyTipCustomText', 'NotifyAllowOverride', 'GenerateAlert', 'GenerateIncidentReport',
      'IncidentReportContent', 'ReportSeverityLevel', 'StopPolicyProcessing', WHEN,
    ]),
  }),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const RETENTION_DLP_OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));
/** Families that need a licence: optional for activation, a gap once qualified and lost. */
export const LICENSED_FAMILIES = Object.freeze(FAMILY_NAMES.filter((name) => FAMILIES[name].license));
export const CORE_OPERATIONS = Object.freeze(FAMILY_NAMES.filter((name) => !FAMILIES[name].license).map((name) => FAMILIES[name].operation));

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const RETENTION_DLP_DESCRIPTOR = Object.freeze({
  type: 'purviewRetentionDlp',
  workload: RETENTION_DLP_WORKLOAD,
  adapter: 'purview-retention-dlp',
  readOnly: true,
  enabledByDefault: false,
  operations: RETENTION_DLP_OPERATIONS,
});

// The only cmdlets this workload runs, and the only parameters each may receive (none).
// ops/powershell/run-cmdlet.ps1 ($AllowedPurviewRetentionDlp) holds the same list and checks it again.
export const RETENTION_DLP_CMDLET_PARAMETERS = Object.freeze(Object.fromEntries(FAMILY_NAMES.map((name) => [FAMILIES[name].cmdlet, Object.freeze([])])));
export const RETENTION_DLP_CMDLETS = new Set(Object.keys(RETENTION_DLP_CMDLET_PARAMETERS));
// Never run: they read matches, incidents, alerts, searches or holds on content.
// This list is documentation and a test fixture. What actually blocks them is the
// allowlist: RETENTION_DLP_CMDLET_PARAMETERS here and $AllowedPurviewRetentionDlp in
// the container, which admit only the four reads above.
export const RETENTION_DLP_EXCLUDED_CMDLETS = Object.freeze([
  'Get-DlpDetailReport', 'Get-DlpIncidentDetailReport', 'Get-DlpDetectionsReport', 'Get-DlpSiDetectionsReport',
  'Get-ComplianceSearch', 'Get-ComplianceSearchAction', 'Get-CaseHoldPolicy', 'Get-ProtectionAlert',
]);

export class RetentionDlpScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetentionDlpScopeError';
  }
}

/** Throws unless the cmdlet is one of the reads above and is given no parameters. */
export function assertRetentionDlpCmdlet({ cmdlet, parameters = {} }) {
  const allowed = RETENTION_DLP_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new RetentionDlpScopeError(`${cmdlet} is not a retention or DLP policy read KEEL runs; this workload never writes, and never reads matches, incidents or content`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new RetentionDlpScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  return true;
}

/** Runs one retention or DLP cmdlet through the bounded job transport. */
export async function retentionDlpCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertRetentionDlpCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: RETENTION_DLP_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: RETENTION_DLP_CMDLETS });
}

const canonical = (value) => JSON.stringify(value ?? null, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]))
  : inner));

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guidOf = (value) => {
  const id = String(value ?? '');
  return GUID.test(id) ? id.toLowerCase() : null;
};

/** The stable identity of one answer: its Guid, or null when it has none KEEL trusts. */
export const objectIdentity = (body) => guidOf(body?.Guid);
/** The Guid of the policy a rule belongs to, or null when the rule does not name one. */
export const parentPolicyOf = (body) => guidOf(body?.Policy);
export const retentionDlpKey = (family, identity) => `${FAMILIES[family].prefix}:${identity}`;

// The Security & Compliance session answers a cmdlet it does not expose (no licence,
// or no role granting it) with CommandNotFoundException.
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
    // A credential-shaped value (a token pasted into a keyword list, say) is redacted
    // by the shared telemetry redactor and marked as such: never stored, and never
    // mistaken for a restorable value.
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
  const { cmdlet, operation, license, rule } = FAMILIES[family];
  const empty = { resources: [], capped: false, unidentified: 0, conflicts: [] };
  let output;
  try {
    ({ output } = await retentionDlpCmdlet({ cmdlet }, powershell));
  } catch (error) {
    if (license && notExposed(error)) {
      return {
        ...empty, failure: null,
        unavailable: { family, operation, status: 'not-licensed', license, reason: `${cmdlet} is not available in this tenant: ${license} is not licensed, or the app's compliance role does not include it`, error: structuredFailure(error).error },
      };
    }
    return { ...empty, failure: { family, operation, ...structuredFailure(error) }, unavailable: null };
  }
  const resources = [];
  const kept = new Map();
  const conflicts = [];
  let unidentified = 0;
  let capped = false;
  for (const body of output) {
    const identity = body && typeof body === 'object' ? objectIdentity(body) : null;
    if (!identity) { unidentified += 1; continue; }
    if (kept.has(identity)) {
      // The same Guid answered twice. The first copy is kept; a second copy that
      // disagrees on a declared field is recorded as a conflict and makes the run
      // partial, because KEEL cannot tell which copy is current.
      const first = kept.get(identity);
      if (first) {
        const other = observeObject(family, body);
        const fields = Object.keys(first.fieldCoverage).filter((field) => canonical(first.fields[field]) !== canonical(other.fields[field]));
        if (fields.length) conflicts.push({ resourceKey: first.resourceKey, fields });
      }
      continue;
    }
    if (resources.length >= maxObjects) { capped = true; kept.set(identity, null); continue; }
    const resource = { resourceKey: retentionDlpKey(family, identity), kind: family, identity, lock: lockState(body), ...observeObject(family, body) };
    if (rule) resource.parentPolicy = parentPolicyOf(body);
    kept.set(identity, resource);
    resources.push(resource);
  }
  return { resources, failure: null, capped, unidentified, conflicts, unavailable: null };
}

/**
 * Sets each rule's `parentStatus` and returns how many rules have no usable parent:
 *  - `none`: the rule names no valid policy Guid;
 *  - `missing`: its own family's policies were read in full and none has that Guid
 *    (a retention rule naming a DLP policy is missing too);
 *  - `found`: the policy was read in this run;
 *  - `unchecked`: the policy family was not read in full (skipped, failed, not
 *    licensed, capped or with unidentified answers), so absence proves nothing.
 * `none` and `missing` count as unparented.
 */
function checkParents(families, reads) {
  const complete = new Map();
  families.forEach((family, index) => {
    const read = reads[index];
    if (FAMILIES[family].rule || read.failure || read.unavailable || read.capped || read.unidentified > 0) return;
    complete.set(family, new Set(read.resources.map((resource) => resource.identity)));
  });
  let unparented = 0;
  families.forEach((family, index) => {
    const { rule, policyFamily } = FAMILIES[family];
    if (!rule) return;
    for (const resource of reads[index].resources) {
      const policies = complete.get(policyFamily);
      if (!resource.parentPolicy) resource.parentStatus = 'none';
      else if (!policies) resource.parentStatus = 'unchecked';
      else resource.parentStatus = policies.has(resource.parentPolicy) ? 'found' : 'missing';
      if (resource.parentStatus === 'none' || resource.parentStatus === 'missing') unparented += 1;
    }
  });
  return unparented;
}

/**
 * Reads the named families (all by default). Pure apart from the injected
 * PowerShell options: no database, no gate. `skipped` lists families the caller did
 * not read, with the reason. Callers outside tests use collectRetentionDlp.
 */
export async function readRetentionDlp({ powershell = {}, families = FAMILY_NAMES, skipped = [], maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() }) {
  for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown retention or DLP family ${family}`);
  const observedFrom = now().toISOString();
  const reads = [];
  for (const family of families) reads.push(await readFamily(family, { powershell, maxObjects }));
  const resources = reads.flatMap((read) => read.resources);
  const failures = reads.map((read) => read.failure).filter(Boolean);
  const unavailable = reads.map((read) => read.unavailable).filter(Boolean);
  const capped = reads.some((read) => read.capped);
  const unidentified = reads.reduce((sum, read) => sum + read.unidentified, 0);
  const conflicts = reads.flatMap((read) => read.conflicts);
  const unparented = checkParents(families, reads);
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
  // A DLP family runs only once its own read is live-qualified, so "not available"
  // later means a lapsed licence or a removed role: those policies are no longer
  // backed up. That is a gap, like a skipped or failed family.
  else if (failures.length || unavailable.length || skipped.length || capped || unidentified || unparented || conflicts.length
    || statuses.some((status) => status !== 'observed')) outcome = 'partial';
  else if (resources.length === 0) outcome = 'complete-empty';
  else outcome = 'complete';
  return {
    workload: RETENTION_DLP_WORKLOAD,
    outcome,
    observedFrom,
    observedTo: now().toISOString(),
    discovery: { families: perFamily, objects: resources.length, capped, unidentified, unparented, conflicts, maxObjects, contentRead: false },
    resources,
    failures,
    unavailable,
    skipped,
    fieldCounts,
  };
}

/**
 * Whether live collection may run, and which families. The Exchange mailbox workload
 * must be qualified first, and both retention reads must be live-qualified and
 * enabled. Each DLP read runs only when its own row is enabled; otherwise it is
 * skipped with the row's reason.
 */
export function retentionDlpActivation(ledger) {
  const rows = new Map((ledger?.rows ?? []).map((row) => [row.id, row]));
  const describe = (id) => {
    const row = rows.get(id);
    return `${id} is ${row?.state ?? 'not in the ledger'}${row?.prerequisite ? `: ${row.prerequisite.message}` : ''}`;
  };
  const reasons = [];
  const exchange = exchangeActivation(ledger);
  if (!exchange.enabled) reasons.push(`Exchange is not qualified yet, and retention and DLP follow it: ${exchange.reasons.join('; ')}`);
  for (const id of CORE_OPERATIONS) if (!rows.get(id)?.enabled) reasons.push(describe(id));
  const families = FAMILY_NAMES.filter((name) => !FAMILIES[name].license || rows.get(FAMILIES[name].operation)?.enabled);
  const skipped = LICENSED_FAMILIES.filter((name) => !families.includes(name))
    .map((name) => ({ family: name, operation: FAMILIES[name].operation, reason: describe(FAMILIES[name].operation) }));
  return { enabled: reasons.length === 0, reasons, families, skipped };
}

/** Persists one run in one transaction; one row per policy and per rule. */
export async function recordRetentionDlpRun(client, { tenantRef, result }) {
  await client.query('BEGIN');
  try {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, RETENTION_DLP_WORKLOAD, result.outcome, result.observedFrom, result.observedTo, {
        discovery: result.discovery ?? null,
        fieldCounts: result.fieldCounts ?? {},
        failures: result.failures ?? [],
        unavailable: result.unavailable ?? [],
        skipped: result.skipped ?? [],
        reasons: result.reasons ?? [],
      }],
    );
    for (const resource of result.resources ?? []) {
      const meta = { identity: resource.identity, kind: resource.kind, lock: resource.lock };
      if ('parentPolicy' in resource) Object.assign(meta, { parentPolicy: resource.parentPolicy, parentStatus: resource.parentStatus });
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields, field_coverage)
         VALUES ($1,$2,$3,$4) ON CONFLICT (collection_id, resource_key) DO NOTHING`,
        [run.id, resource.resourceKey, { ...meta, ...resource.fields }, resource.fieldCoverage],
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
export async function collectRetentionDlp(client, { tenantRef, ledger, powershell, maxObjects, now }) {
  const activation = retentionDlpActivation(ledger);
  if (!activation.enabled) {
    const at = (now?.() ?? new Date()).toISOString();
    const run = await recordRetentionDlpRun(client, { tenantRef, result: { outcome: 'disabled', observedFrom: at, observedTo: at, reasons: activation.reasons } });
    return { run, result: null, activation };
  }
  const result = await readRetentionDlp({ powershell, families: activation.families, skipped: activation.skipped, maxObjects, now });
  const run = await recordRetentionDlpRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const retentionDlpAdapter = Object.freeze({
  async collect() {
    throw new Error('the Purview retention and DLP workload adapter is disabled until live qualification; use collectRetentionDlp with the ledger');
  },
});

registerWorkload(RETENTION_DLP_DESCRIPTOR, retentionDlpAdapter);
