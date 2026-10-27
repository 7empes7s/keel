/**
 * The Purview pieces DLP depends on, and the alert and audit policies beside them.
 *
 * DLP policies and rules are backed up by purviewRetentionDlp.mjs. A DLP rule names
 * the sensitive information types it looks for, and a custom type can use a keyword
 * dictionary; when those are gone, restoring the rule fails. This module backs them up,
 * read only, in two workloads of their own, so the live Purview workloads keep running
 * while these wait for their first live capture:
 *
 *  - `purview-classifiers` (Purview "Retention and data loss prevention"):
 *    - custom sensitive information types (Get-DlpSensitiveInformationType), one
 *      observation per type, keyed by its Id;
 *    - the rule packages that hold them (Get-DlpSensitiveInformationTypeRulePackage),
 *      kept as the package XML a restore uploads again
 *      (Set-/New-DlpSensitiveInformationTypeRulePackage -FileData), keyed by the
 *      RulePack id inside that XML;
 *    - keyword dictionaries (Get-DlpKeywordDictionary), with their terms.
 *  - `purview-audit-alerts` (Purview "Audit and alerts"):
 *    - alert policies (Get-ProtectionAlert), Microsoft's built-in ones included, since
 *      an admin can turn them off or change who is notified;
 *    - audit log retention policies (Get-UnifiedAuditLogRetentionPolicy), which need
 *      Microsoft Purview Audit (Premium).
 *
 * Rules (the same as the other Purview cmdlet workloads, see cmdletFamilies.mjs):
 *  - Read only. Only the Get cmdlets below run, with no parameters. No writer exists.
 *  - Configuration only. No cmdlet that reads matches, detections, alerts raised or
 *    audit records runs (DLP_SUPPORT_EXCLUDED_CMDLETS). A sensitive information type is
 *    its definition (patterns, keywords, confidence), never content it matched.
 *  - Microsoft's built-in types and the built-in "Microsoft Rule Package" are left out
 *    and counted (`builtIn`): they come back with the service, and the package is
 *    megabytes (the container drops it before it is sent, see run-cmdlet.ps1). Every
 *    other package is kept, whatever its size. Built-in alert policies are kept.
 *  - Identity is never guessed. A rule package without a readable RulePack id, or any
 *    other answer without a Guid, is unidentified and makes the run partial.
 *  - Unlicensed is an observation, and a gap: audit retention runs only once its own
 *    row is live-qualified; a session that then lacks the cmdlet is `not-licensed`.
 *  - Disabled until qualified. Nothing is sent unless the Exchange mailbox workload is
 *    qualified (as for the other Purview workloads) AND every core read of the workload
 *    is live-qualified and enabled.
 */
import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { exchangeActivation, structuredFailure } from './exchange.mjs';
import {
  emptyRead, guidOf, ledgerRows, notExposed, objectsFrom, recordCmdletRun, recordDisabledRun, summarize,
} from './cmdletFamilies.mjs';

export const DLP_SUPPORT_MODULE = 'ExchangeOnlineManagement';
export const PURVIEW_CLASSIFIERS_WORKLOAD = 'purview-classifiers';
export const PURVIEW_AUDIT_ALERTS_WORKLOAD = 'purview-audit-alerts';
export const DEFAULT_MAX_OBJECTS = 1000;

const AUDIT_PREMIUM_LICENCE = 'Microsoft Purview Audit (Premium)';
const MICROSOFT_PUBLISHER = 'Microsoft Corporation';
const MICROSOFT_RULE_PACKAGE = 'Microsoft Rule Package';

/** The first of `keys` that holds a Guid, lower-cased, or null. */
const guidIn = (keys) => (body) => {
  for (const key of keys) {
    const id = guidOf(body?.[key]);
    if (id) return id;
  }
  return null;
};
const byGuid = guidIn(['Guid', 'Identity']);

/**
 * A rule package's XML from its SerializedClassificationRuleCollection: the bytes
 * Microsoft stores (an array of numbers once serialized to JSON, or base64), usually
 * UTF-16 with a byte order mark. Returns null when there is nothing to decode.
 */
export function decodeRulePackage(value) {
  let bytes;
  if (Array.isArray(value) && value.length > 0 && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) bytes = Buffer.from(value);
  else if (typeof value === 'string' && value.trim().startsWith('<')) return value;
  else if (typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) bytes = Buffer.from(value.trim(), 'base64');
  else return null;
  if (bytes.length === 0) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  // No byte order mark: "<\0" is UTF-16 little endian.
  if (bytes.length > 1 && bytes[1] === 0) return bytes.toString('utf16le');
  return bytes.toString('utf8');
}

/** The RulePack id inside a rule package's XML, lower-cased, or null. */
export function rulePackIdOf(xml) {
  if (typeof xml !== 'string') return null;
  const match = /<RulePack\b[^>]*\bid\s*=\s*["']([^"']+)["']/i.exec(xml);
  return match ? guidOf(match[1]) : null;
}

/**
 * The families, per workload. Fields were declared from Microsoft's cmdlet
 * documentation, not measured live. `prepare(output)` drops Microsoft's built-in
 * objects before identity, and returns how many it dropped.
 */
export const CLASSIFIER_FAMILIES = Object.freeze({
  sensitiveInfoType: Object.freeze({
    operation: 'purview.sensitive-info-types', cmdlet: 'Get-DlpSensitiveInformationType', prefix: 'sensitive-info-type',
    identity: guidIn(['Id']),
    fields: Object.freeze(['Name', 'Id', 'Description', 'Publisher', 'RecommendedConfidence']),
    prepare: (output) => {
      const custom = output.filter((body) => !(body && typeof body === 'object' && body.Publisher === MICROSOFT_PUBLISHER));
      return { output: custom, builtIn: output.length - custom.length };
    },
  }),
  sitRulePackage: Object.freeze({
    operation: 'purview.sit-rule-packages', cmdlet: 'Get-DlpSensitiveInformationTypeRulePackage', prefix: 'sit-rule-package',
    identity: (body) => rulePackIdOf(body?.RulePackageXml),
    // RulePackageXml is decoded from SerializedClassificationRuleCollection (prepare).
    fields: Object.freeze(['Name', 'Publisher', 'Version', 'RulePackageXml', 'WhenChangedUTC']),
    prepare: (output) => {
      const custom = [];
      let builtIn = 0;
      for (const body of output) {
        if (!body || typeof body !== 'object') { custom.push(body); continue; }
        if (body.Name === MICROSOFT_RULE_PACKAGE) { builtIn += 1; continue; }
        const { SerializedClassificationRuleCollection: bytes, ...rest } = body;
        const xml = decodeRulePackage(bytes);
        custom.push(xml === null ? rest : { ...rest, RulePackageXml: xml });
      }
      return { output: custom, builtIn };
    },
  }),
  keywordDictionary: Object.freeze({
    operation: 'purview.keyword-dictionaries', cmdlet: 'Get-DlpKeywordDictionary', prefix: 'keyword-dictionary', identity: byGuid,
    fields: Object.freeze(['Name', 'Description', 'KeywordDictionary', 'WhenChangedUTC']),
  }),
});

export const AUDIT_ALERT_FAMILIES = Object.freeze({
  alertPolicy: Object.freeze({
    operation: 'purview.alert-policies', cmdlet: 'Get-ProtectionAlert', prefix: 'alert-policy', identity: byGuid,
    fields: Object.freeze([
      'Name', 'Comment', 'Category', 'Severity', 'Disabled', 'IsSystemRule', 'NotifyUser', 'NotificationEnabled', 'Operation', 'Filter',
      'AggregationType', 'Threshold', 'TimeWindow', 'ThreatType', 'WhenChangedUTC',
    ]),
  }),
  auditRetentionPolicy: Object.freeze({
    operation: 'purview.audit-retention-policies', cmdlet: 'Get-UnifiedAuditLogRetentionPolicy', prefix: 'audit-retention-policy', identity: byGuid,
    license: AUDIT_PREMIUM_LICENCE,
    fields: Object.freeze(['Name', 'Description', 'Priority', 'RecordTypes', 'Operations', 'UserIds', 'RetentionDuration', 'WhenChangedUTC']),
  }),
});

// Never allowed: they read DLP matches, raised alerts or audit records, or write.
export const DLP_SUPPORT_EXCLUDED_CMDLETS = Object.freeze([
  'Get-DlpDetailReport', 'Get-DlpSiDetectionsReport', 'Get-DlpDetectionsReport', 'Search-UnifiedAuditLog', 'Get-AdminAuditLogConfig',
  'Test-DataClassification', 'Test-TextExtraction',
  'New-DlpSensitiveInformationTypeRulePackage', 'Set-DlpSensitiveInformationTypeRulePackage', 'Remove-DlpSensitiveInformationTypeRulePackage',
  'New-DlpKeywordDictionary', 'Set-DlpKeywordDictionary', 'Set-ProtectionAlert', 'Remove-ProtectionAlert', 'Set-UnifiedAuditLogRetentionPolicy',
]);

export class DlpSupportScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DlpSupportScopeError';
  }
}

/**
 * One read-only workload over `families`. `label` names it in errors and reasons;
 * `required` lists families every working tenant has, so an empty answer is a gap.
 */
function defineWorkload({ workload, type, label, families: FAMILIES, required = [] }) {
  const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
  const OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));
  const LICENSED = Object.freeze(FAMILY_NAMES.filter((name) => FAMILIES[name].license));
  const CORE = Object.freeze(FAMILY_NAMES.filter((name) => !FAMILIES[name].license).map((name) => FAMILIES[name].operation));
  // The only cmdlets this workload runs, with no parameters. ops/powershell/run-cmdlet.ps1
  // holds the same list ($AllowedPurviewClassifiers, $AllowedPurviewAuditAlerts).
  const CMDLET_PARAMETERS = Object.freeze(Object.fromEntries(FAMILY_NAMES.map((name) => [FAMILIES[name].cmdlet, Object.freeze([])])));
  const CMDLETS = new Set(Object.keys(CMDLET_PARAMETERS));

  const descriptor = Object.freeze({ type, workload, adapter: workload, readOnly: true, enabledByDefault: false, operations: OPERATIONS });

  function assertCmdlet({ cmdlet, parameters = {} }) {
    if (!CMDLET_PARAMETERS[cmdlet]) throw new DlpSupportScopeError(`${cmdlet} is not a ${label} read KEEL runs; this workload never writes, and never reads matches, alerts raised or audit records`);
    for (const name of Object.keys(parameters)) throw new DlpSupportScopeError(`${cmdlet} does not take ${name} from KEEL`);
    return true;
  }

  async function cmdlet({ cmdlet: name, parameters = {} }, powershell = {}) {
    assertCmdlet({ cmdlet: name, parameters });
    const { tenantConfigPath = null, ...options } = powershell;
    return runCmdlet({ module: DLP_SUPPORT_MODULE, cmdlet: name, parameters, tenantConfigPath }, { ...options, allowedCmdlets: CMDLETS });
  }

  async function readFamily(family, { powershell, maxObjects }) {
    const spec = FAMILIES[family];
    let output;
    try {
      ({ output } = await cmdlet({ cmdlet: spec.cmdlet }, powershell));
    } catch (error) {
      if (spec.license && notExposed(error)) {
        return emptyRead({
          unavailable: {
            family, operation: spec.operation, status: 'not-licensed', license: spec.license,
            reason: `${spec.cmdlet} is not available in this tenant: ${spec.license} is not licensed, or the app's compliance role does not include it`,
            error: structuredFailure(error).error,
          },
        });
      }
      return emptyRead({ failure: { family, operation: spec.operation, ...structuredFailure(error) } });
    }
    const prepared = spec.prepare ? spec.prepare(output) : { output, builtIn: 0 };
    return { ...emptyRead(), ...objectsFrom(family, spec, prepared.output, { maxObjects }), builtIn: prepared.builtIn };
  }

  /** Reads the named families (all by default). Pure apart from the injected PowerShell options. */
  async function read({ powershell = {}, families = FAMILY_NAMES, skipped = [], maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() }) {
    for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown ${label} family ${family}`);
    const observedFrom = now().toISOString();
    const reads = {};
    for (const family of families) reads[family] = await readFamily(family, { powershell, maxObjects });
    const result = summarize({ workload, families, reads, skipped, required, maxObjects, observedFrom, observedTo: now().toISOString() });
    result.discovery.builtIn = Object.fromEntries(families.filter((family) => FAMILIES[family].prepare).map((family) => [family, reads[family].builtIn ?? 0]));
    return result;
  }

  /** Whether live collection may run, and which families (see the module comment). */
  function activation(ledger) {
    const { rows, describe } = ledgerRows(ledger);
    const reasons = [];
    const exchange = exchangeActivation(ledger);
    if (!exchange.enabled) reasons.push(`Exchange is not qualified yet, and ${label} follow it: ${exchange.reasons.join('; ')}`);
    for (const id of CORE) if (!rows.get(id)?.enabled) reasons.push(describe(id));
    const families = FAMILY_NAMES.filter((name) => !FAMILIES[name].license || rows.get(FAMILIES[name].operation)?.enabled);
    const skipped = LICENSED.filter((name) => !families.includes(name))
      .map((name) => ({ family: name, operation: FAMILIES[name].operation, reason: describe(FAMILIES[name].operation) }));
    return { enabled: reasons.length === 0, reasons, families, skipped };
  }

  const record = (client, { tenantRef, result }) => recordCmdletRun(client, workload, { tenantRef, result });

  /** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
  async function collect(client, { tenantRef, ledger, powershell, maxObjects, now }) {
    const gate = activation(ledger);
    if (!gate.enabled) {
      const run = await recordDisabledRun(client, workload, { tenantRef, reasons: gate.reasons, now });
      return { run, result: null, activation: gate };
    }
    const result = await read({ powershell, families: gate.families, skipped: gate.skipped, maxObjects, now });
    const run = await record(client, { tenantRef, result });
    return { run, result, activation: gate };
  }

  const adapter = Object.freeze({
    async collect() {
      throw new Error(`the ${label} workload adapter is disabled until live qualification; use its collect function with the ledger`);
    },
  });
  registerWorkload(descriptor, adapter);

  return Object.freeze({
    workload, families: FAMILIES, familyNames: FAMILY_NAMES, operations: OPERATIONS, licensed: LICENSED, core: CORE,
    cmdletParameters: CMDLET_PARAMETERS, descriptor, assertCmdlet, read, activation, record, collect,
  });
}

export const PURVIEW_CLASSIFIERS = defineWorkload({
  workload: PURVIEW_CLASSIFIERS_WORKLOAD, type: 'purviewClassifiers', label: 'Purview sensitive information types and keyword dictionaries',
  families: CLASSIFIER_FAMILIES,
});
export const PURVIEW_AUDIT_ALERTS = defineWorkload({
  workload: PURVIEW_AUDIT_ALERTS_WORKLOAD, type: 'purviewAuditAlerts', label: 'Purview alert and audit retention policies',
  // Every tenant has Microsoft's built-in alert policies.
  families: AUDIT_ALERT_FAMILIES, required: ['alertPolicy'],
});

export const readPurviewClassifiers = (options) => PURVIEW_CLASSIFIERS.read(options);
export const collectPurviewClassifiers = (client, options) => PURVIEW_CLASSIFIERS.collect(client, options);
export const recordPurviewClassifiersRun = (client, options) => PURVIEW_CLASSIFIERS.record(client, options);
export const purviewClassifiersActivation = (ledger) => PURVIEW_CLASSIFIERS.activation(ledger);
export const readPurviewAuditAlerts = (options) => PURVIEW_AUDIT_ALERTS.read(options);
export const collectPurviewAuditAlerts = (client, options) => PURVIEW_AUDIT_ALERTS.collect(client, options);
export const recordPurviewAuditAlertsRun = (client, options) => PURVIEW_AUDIT_ALERTS.record(client, options);
export const purviewAuditAlertsActivation = (ledger) => PURVIEW_AUDIT_ALERTS.activation(ledger);
