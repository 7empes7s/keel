/**
 * Wave 1 READ-TEAMS-PV: Purview retention labels, adaptive scopes, auto-labeling, and
 * eDiscovery cases with their holds.
 *
 * A workload of its own (`purview-governance`), beside the sensitivity label
 * (purview.mjs) and retention and DLP (purviewRetentionDlp.mjs) workloads, which it
 * does not change. Eight families, each its own task-101 operation, in the Security &
 * Compliance session (Connect-IPPSSession):
 *  - retention labels (Get-ComplianceTag) and adaptive scopes (Get-AdaptiveScope);
 *  - auto-labeling policies and their rules (Get-AutoSensitivityLabelPolicy and
 *    Get-AutoSensitivityLabelRule), which need an E5-level licence;
 *  - eDiscovery (Standard) cases (Get-ComplianceCase), eDiscovery (Premium) cases
 *    (Get-ComplianceCase -CaseType AdvancedEdiscovery), which need their own licence,
 *    the holds of every case read (Get-CaseHoldPolicy -Case <case id>), and each
 *    hold's query (Get-CaseHoldRule -Policy <hold id>).
 *
 * Rules:
 *  - Read only, and configuration only. Only the Get cmdlets in
 *    PURVIEW_EXTENDED_CMDLET_PARAMETERS run. No cmdlet reads a search, its results,
 *    an export or a review set (PURVIEW_EXTENDED_EXCLUDED_CMDLETS): a case is backed up
 *    as its settings and holds, never its evidence.
 *  - Parameters are ids KEEL read itself. -Case and -Policy take only a Guid answered
 *    by the parent read in the same run; -CaseType takes only AdvancedEdiscovery.
 *  - Children keep their parent. A hold records its case, a hold rule its hold, and an
 *    auto-labeling rule its policy (`parent`, `parentStatus`), as purviewRetentionDlp.mjs
 *    does for retention rules.
 *  - Unlicensed is an observation, and a gap. A licensed family whose cmdlet the session
 *    does not expose is `not-licensed`. It runs only once its own row is live-qualified,
 *    so losing it later makes the run partial.
 *  - Disabled until qualified. collectPurviewExtended() sends nothing unless the Exchange
 *    mailbox workload is qualified (as for the other Purview workloads) AND every core
 *    read is live-qualified and enabled. Each licensed read runs only when its own row
 *    is enabled, and is otherwise listed as skipped.
 */
import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { exchangeActivation, structuredFailure } from './exchange.mjs';
import {
  emptyRead, guidOf, ledgerRows, notExposed, objectsFrom, recordCmdletRun, recordDisabledRun, summarize,
} from './cmdletFamilies.mjs';

export const PURVIEW_EXTENDED_WORKLOAD = 'purview-governance';
export const PURVIEW_EXTENDED_MODULE = 'ExchangeOnlineManagement';
export const DEFAULT_MAX_OBJECTS = 1000;

const AUTO_LABEL_LICENCE = 'Microsoft Purview Information Protection auto-labeling (E5 or equivalent)';
const PREMIUM_LICENCE = 'Microsoft Purview eDiscovery (Premium)';
const PREMIUM_CASE_TYPE = 'AdvancedEdiscovery';

const byGuid = (body) => guidOf(body?.Guid);
const byIdentity = (body) => guidOf(body?.Identity);

const CASE_FIELDS = Object.freeze([
  'Identity', 'Name', 'Description', 'Status', 'CaseType', 'ExternalId', 'CreatedDateTime', 'ClosedDateTime', 'ClosedBy',
]);

/**
 * The families. Fields were declared from Microsoft's cmdlet documentation, not
 * measured live. `parentFamily` names the family a child's parent is read in;
 * `perParent` names the parameter the parent's id is passed in.
 */
export const FAMILIES = Object.freeze({
  retentionLabel: Object.freeze({
    operation: 'purview.retention-labels', cmdlet: 'Get-ComplianceTag', prefix: 'retention-label', identity: byGuid,
    fields: Object.freeze([
      'Name', 'Guid', 'Comment', 'Notes', 'IsRecordLabel', 'Regulatory', 'IsRecordUnlockedAsDefault', 'RetentionAction', 'RetentionDuration',
      'RetentionType', 'EventType', 'ReviewerEmail', 'FilePlanMetadata', 'MultiStageReviewProperty', 'ComplianceTagForNextStage',
      'AutoApprovalPeriod', 'Workload', 'WhenChangedUTC',
    ]),
  }),
  adaptiveScope: Object.freeze({
    operation: 'purview.adaptive-scopes', cmdlet: 'Get-AdaptiveScope', prefix: 'adaptive-scope', identity: byGuid,
    fields: Object.freeze(['Name', 'Guid', 'Comment', 'LocationType', 'FilterConditions', 'RawQuery', 'AdministrativeUnits', 'WhenChangedUTC']),
  }),
  autoLabelPolicy: Object.freeze({
    operation: 'purview.auto-label-policies', cmdlet: 'Get-AutoSensitivityLabelPolicy', prefix: 'auto-label-policy', identity: byGuid, license: AUTO_LABEL_LICENCE,
    fields: Object.freeze([
      'Name', 'Guid', 'Comment', 'Mode', 'Enabled', 'Priority', 'ApplySensitivityLabel', 'OverwriteLabel', 'Type', 'Workload',
      'ExchangeLocation', 'ExchangeSender', 'ExchangeSenderException', 'ExchangeSenderMemberOf', 'ExchangeSenderMemberOfException',
      'SharePointLocation', 'SharePointLocationException', 'OneDriveLocation', 'OneDriveLocationException',
      'ExchangeAdaptiveScopes', 'ExchangeAdaptiveScopesException', 'SharePointAdaptiveScopes', 'SharePointAdaptiveScopesException',
      'OneDriveAdaptiveScopes', 'OneDriveAdaptiveScopesException', 'PolicyRBACScopes', 'WhenChangedUTC',
    ]),
  }),
  autoLabelRule: Object.freeze({
    operation: 'purview.auto-label-rules', cmdlet: 'Get-AutoSensitivityLabelRule', prefix: 'auto-label-rule', identity: byGuid, license: AUTO_LABEL_LICENCE,
    parentFamily: 'autoLabelPolicy', parentOf: (body) => guidOf(body?.Policy),
    fields: Object.freeze([
      'Name', 'Guid', 'Policy', 'ParentPolicyName', 'Comment', 'Disabled', 'Mode', 'Priority', 'Workload',
      'ContentContainsSensitiveInformation', 'ExceptIfContentContainsSensitiveInformation', 'AdvancedRule', 'ContentExtensionMatchesWords',
      'DocumentIsPasswordProtected', 'DocumentIsUnsupported', 'FromAddressContainsWords', 'FromAddressMatchesPatterns', 'HeaderMatchesPatterns',
      'SubjectMatchesPatterns', 'SenderDomainIs', 'RecipientDomainIs', 'SenderIPRanges', 'SentTo', 'SentToMemberOf', 'AccessScope',
      'ReportSeverityLevel', 'WhenChangedUTC',
    ]),
  }),
  ediscoveryCase: Object.freeze({
    operation: 'purview.ediscovery-cases', cmdlet: 'Get-ComplianceCase', prefix: 'ediscovery-case', identity: byIdentity, fields: CASE_FIELDS,
  }),
  premiumCase: Object.freeze({
    operation: 'purview.ediscovery-premium-cases', cmdlet: 'Get-ComplianceCase', parameters: Object.freeze({ CaseType: PREMIUM_CASE_TYPE }),
    prefix: 'ediscovery-premium-case', identity: byIdentity, fields: CASE_FIELDS, license: PREMIUM_LICENCE,
  }),
  caseHold: Object.freeze({
    operation: 'purview.case-holds', cmdlet: 'Get-CaseHoldPolicy', prefix: 'case-hold', identity: byGuid,
    parentFamily: ['ediscoveryCase', 'premiumCase'], perParent: 'Case',
    fields: Object.freeze([
      'Name', 'Guid', 'Comment', 'Enabled', 'Mode', 'ExchangeLocation', 'SharePointLocation', 'PublicFolderLocation', 'WhenChangedUTC',
    ]),
  }),
  caseHoldRule: Object.freeze({
    operation: 'purview.case-hold-rules', cmdlet: 'Get-CaseHoldRule', prefix: 'case-hold-rule', identity: byGuid,
    parentFamily: ['caseHold'], perParent: 'Policy',
    fields: Object.freeze(['Name', 'Guid', 'Policy', 'Comment', 'Disabled', 'ContentMatchQuery', 'WhenChangedUTC']),
  }),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const PURVIEW_EXTENDED_OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));
/** Families that need a licence: optional for activation, a gap once qualified and lost. */
export const LICENSED_FAMILIES = Object.freeze(FAMILY_NAMES.filter((name) => FAMILIES[name].license));
export const CORE_OPERATIONS = Object.freeze(FAMILY_NAMES.filter((name) => !FAMILIES[name].license).map((name) => FAMILIES[name].operation));

/**
 * What a backup of this workload cannot hold, for the completeness records
 * (package INCOMPLETE). A case is backed up as its settings and holds only.
 */
export const PURVIEW_EXTENDED_MISSING = Object.freeze([
  Object.freeze({ family: 'ediscoveryCase', field: 'searches, exports and review sets', reason: 'content', note: 'Case evidence is content, not configuration, and is never read. Rerun searches in the recreated case.' }),
  Object.freeze({ family: 'premiumCase', field: 'searches, exports and review sets', reason: 'content', note: 'Case evidence is content, not configuration, and is never read. Rerun searches in the recreated case.' }),
  Object.freeze({ family: 'ediscoveryCase', field: 'case members', reason: 'not-read', note: 'Case membership is not read yet. Add members again in the Purview portal.' }),
  Object.freeze({ family: 'premiumCase', field: 'case members', reason: 'not-read', note: 'Case membership is not read yet. Add members again in the Purview portal.' }),
  Object.freeze({ family: 'ediscoveryCase', field: 'Identity', reason: 'read-only', note: 'Microsoft assigns a new case id on create; holds are placed again under the new case.' }),
]);

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const PURVIEW_EXTENDED_DESCRIPTOR = Object.freeze({
  type: 'purviewGovernance',
  workload: PURVIEW_EXTENDED_WORKLOAD,
  adapter: 'purview-governance',
  readOnly: true,
  enabledByDefault: false,
  operations: PURVIEW_EXTENDED_OPERATIONS,
});

// The only cmdlets this workload runs, and the only parameters each may receive.
// ops/powershell/run-cmdlet.ps1 ($AllowedPurviewExtended) holds the same list and checks it again.
export const PURVIEW_EXTENDED_CMDLET_PARAMETERS = Object.freeze({
  'Get-ComplianceTag': Object.freeze([]),
  'Get-AdaptiveScope': Object.freeze([]),
  'Get-AutoSensitivityLabelPolicy': Object.freeze([]),
  'Get-AutoSensitivityLabelRule': Object.freeze([]),
  'Get-ComplianceCase': Object.freeze(['CaseType']),
  'Get-CaseHoldPolicy': Object.freeze(['Case']),
  'Get-CaseHoldRule': Object.freeze(['Policy']),
});
export const PURVIEW_EXTENDED_CMDLETS = new Set(Object.keys(PURVIEW_EXTENDED_CMDLET_PARAMETERS));
// Never allowed: these read or act on case evidence, not configuration.
export const PURVIEW_EXTENDED_EXCLUDED_CMDLETS = Object.freeze([
  'Get-ComplianceSearch', 'Get-ComplianceSearchAction', 'New-ComplianceSearch', 'Start-ComplianceSearch', 'Get-ComplianceCaseMember',
]);

export class PurviewExtendedScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PurviewExtendedScopeError';
  }
}

/** Throws unless the cmdlet is one of the reads above, with only its own parameters and values. */
export function assertPurviewExtendedCmdlet({ cmdlet, parameters = {} }) {
  const allowed = PURVIEW_EXTENDED_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new PurviewExtendedScopeError(`${cmdlet} is not a Purview governance read KEEL runs; this workload never writes or reads case evidence`);
  for (const [name, value] of Object.entries(parameters)) {
    if (!allowed.includes(name)) throw new PurviewExtendedScopeError(`${cmdlet} does not take ${name} from KEEL`);
    if (name === 'CaseType' && value !== PREMIUM_CASE_TYPE) throw new PurviewExtendedScopeError(`CaseType may only be ${PREMIUM_CASE_TYPE}`);
    if ((name === 'Case' || name === 'Policy') && !guidOf(value)) throw new PurviewExtendedScopeError(`${name} must be a Guid KEEL read`);
  }
  return true;
}

/** Runs one cmdlet through the bounded job transport. */
export async function purviewExtendedCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertPurviewExtendedCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: PURVIEW_EXTENDED_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: PURVIEW_EXTENDED_CMDLETS });
}

/** One call. Returns its output, or the failure or unavailability to record. */
async function call(family, parameters, powershell) {
  const { cmdlet, operation, license } = FAMILIES[family];
  try {
    const { output } = await purviewExtendedCmdlet({ cmdlet, parameters }, powershell);
    return { output };
  } catch (error) {
    if (license && notExposed(error)) {
      return {
        unavailable: {
          family, operation, status: 'not-licensed', license,
          reason: `${cmdlet} is not available in this tenant: ${license} is not licensed, or the app's compliance role does not include it`,
          error: structuredFailure(error).error,
        },
      };
    }
    return { failure: { family, operation, ...(Object.keys(parameters).length ? { parameters } : {}), ...structuredFailure(error) } };
  }
}

/** A whole-tenant family: one call. */
async function readFamily(family, { powershell, maxObjects }) {
  const spec = FAMILIES[family];
  const answer = await call(family, spec.parameters ?? {}, powershell);
  if (answer.unavailable) return emptyRead({ unavailable: answer.unavailable });
  if (answer.failure) return emptyRead({ failure: answer.failure });
  const extra = spec.parentOf ? (body) => ({ parent: spec.parentOf(body) }) : undefined;
  return { ...emptyRead(), ...objectsFrom(family, spec, answer.output, { maxObjects, extra }) };
}

/**
 * A family read once per parent (holds per case, rules per hold). Each child records
 * the parent it was read under. A failed call is a failure of that parent's children
 * only; every other parent is still read.
 */
async function readPerParent(family, parents, { powershell, maxObjects }) {
  const spec = FAMILIES[family];
  const read = { ...emptyRead(), failures: [] };
  const kept = new Map();
  const count = { value: 0 };
  for (const parent of parents) {
    const answer = await call(family, { [spec.perParent]: parent.identity }, powershell);
    if (answer.failure) { read.failures.push({ ...answer.failure, parent: parent.resourceKey }); continue; }
    const part = objectsFrom(family, spec, answer.output, {
      maxObjects, kept, count, extra: () => ({ parent: parent.identity, parentStatus: 'found', ...(family === 'caseHold' ? { case: parent.resourceKey } : {}) }),
    });
    read.resources.push(...part.resources);
    read.conflicts.push(...part.conflicts);
    read.unidentified += part.unidentified;
    read.capped ||= part.capped;
  }
  // Every per-parent call failed: the family failed as a whole.
  if (parents.length > 0 && read.failures.length === parents.length) {
    const [first] = read.failures;
    return { ...read, failure: { family, operation: spec.operation, status: first.status, error: first.error, parents: read.failures.length } };
  }
  return read;
}

/**
 * Sets each auto-labeling rule's `parentStatus` (none, missing, found or unchecked, as
 * purviewRetentionDlp.mjs does for retention rules) and returns how many have no
 * usable parent.
 */
function checkParents(reads) {
  const rules = reads.autoLabelRule;
  if (!rules) return 0;
  const policies = reads.autoLabelPolicy;
  const complete = policies && !policies.failure && !policies.unavailable && !policies.capped && policies.unidentified === 0
    ? new Set(policies.resources.map((resource) => resource.identity)) : null;
  let unparented = 0;
  for (const resource of rules.resources) {
    if (!resource.parent) resource.parentStatus = 'none';
    else if (!complete) resource.parentStatus = 'unchecked';
    else resource.parentStatus = complete.has(resource.parent) ? 'found' : 'missing';
    if (resource.parentStatus === 'none' || resource.parentStatus === 'missing') unparented += 1;
  }
  return unparented;
}

/**
 * Reads the named families (all by default). Pure apart from the injected PowerShell
 * options: no database, no gate. `skipped` lists families the caller did not read,
 * with the reason. Callers outside tests use collectPurviewExtended.
 */
export async function readPurviewExtended({ powershell = {}, families = FAMILY_NAMES, skipped = [], maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() }) {
  for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown Purview governance family ${family}`);
  const observedFrom = now().toISOString();
  const reads = {};
  // Parents before children: FAMILY_NAMES is in that order.
  for (const family of FAMILY_NAMES.filter((name) => families.includes(name))) {
    const spec = FAMILIES[family];
    if (!spec.perParent) {
      reads[family] = await readFamily(family, { powershell, maxObjects });
      continue;
    }
    const parents = spec.parentFamily.flatMap((parent) => reads[parent]?.resources ?? []);
    reads[family] = await readPerParent(family, parents, { powershell, maxObjects });
  }
  const unparented = checkParents(reads);
  return summarize({
    workload: PURVIEW_EXTENDED_WORKLOAD, families, reads, skipped, unparented, maxObjects,
    observedFrom, observedTo: now().toISOString(),
  });
}

/**
 * Whether live collection may run, and which families. The Exchange mailbox workload
 * must be qualified first, and every core read must be live-qualified and enabled.
 * Each licensed read runs only when its own row is enabled; otherwise it is skipped
 * with the row's reason.
 */
export function purviewExtendedActivation(ledger) {
  const { rows, describe } = ledgerRows(ledger);
  const reasons = [];
  const exchange = exchangeActivation(ledger);
  if (!exchange.enabled) reasons.push(`Exchange is not qualified yet, and Purview governance follows it: ${exchange.reasons.join('; ')}`);
  for (const id of CORE_OPERATIONS) if (!rows.get(id)?.enabled) reasons.push(describe(id));
  const families = FAMILY_NAMES.filter((name) => !FAMILIES[name].license || rows.get(FAMILIES[name].operation)?.enabled);
  const skipped = LICENSED_FAMILIES.filter((name) => !families.includes(name))
    .map((name) => ({ family: name, operation: FAMILIES[name].operation, reason: describe(FAMILIES[name].operation) }));
  return { enabled: reasons.length === 0, reasons, families, skipped };
}

export const recordPurviewExtendedRun = (client, { tenantRef, result }) => recordCmdletRun(client, PURVIEW_EXTENDED_WORKLOAD, { tenantRef, result });

/** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
export async function collectPurviewExtended(client, { tenantRef, ledger, powershell, maxObjects, now }) {
  const activation = purviewExtendedActivation(ledger);
  if (!activation.enabled) {
    const run = await recordDisabledRun(client, PURVIEW_EXTENDED_WORKLOAD, { tenantRef, reasons: activation.reasons, now });
    return { run, result: null, activation };
  }
  const result = await readPurviewExtended({ powershell, families: activation.families, skipped: activation.skipped, maxObjects, now });
  const run = await recordPurviewExtendedRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const purviewExtendedAdapter = Object.freeze({
  async collect() {
    throw new Error('the Purview governance workload adapter is disabled until live qualification; use collectPurviewExtended with the ledger');
  },
});

registerWorkload(PURVIEW_EXTENDED_DESCRIPTOR, purviewExtendedAdapter);
