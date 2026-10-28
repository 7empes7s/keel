// The Purview pieces DLP depends on (custom sensitive information types, their rule
// packages, keyword dictionaries), and alert and audit log retention policies. Read only.
//
// Acceptance:
//  - the reads are declared in workloadContract.mjs, pass the scope validator, are run by
//    the read-only probe, and ship disabled (fixture proof never enables them);
//  - only the Get cmdlets run, with no parameters; the Node and container allowlists
//    match; no writer exists;
//  - Microsoft's built-in types and rule package are left out and counted; a custom rule
//    package is kept as its XML, keyed by the RulePack id inside it;
//  - collection stays off until Exchange and the core reads are qualified, never waits
//    for the other Purview workloads, and audit retention runs only once its own row is on;
//  - a keyword added to a dictionary between two reads is a change on the Changes page;
//  - the read capture tool can qualify both workloads;
//  - they sit in Purview's "Retention and data loss prevention" and "Audit and alerts".
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays the ops/powershell/run-cmdlet.ps1 contract through the real
// engine/powershell/jobQueue.mjs spawn path. No tenant is touched.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  AUDIT_ALERT_FAMILIES, CLASSIFIER_FAMILIES, DLP_SUPPORT_EXCLUDED_CMDLETS, DlpSupportScopeError, PURVIEW_AUDIT_ALERTS,
  PURVIEW_AUDIT_ALERTS_WORKLOAD, PURVIEW_CLASSIFIERS, PURVIEW_CLASSIFIERS_WORKLOAD, collectPurviewAuditAlerts, collectPurviewClassifiers,
  decodeRulePackage, purviewAuditAlertsActivation, purviewClassifiersActivation, readPurviewAuditAlerts, readPurviewClassifiers, rulePackIdOf,
} from '../collect/workloads/purviewDlpSupport.mjs';
import { EXCHANGE_OPERATIONS } from '../collect/workloads/exchange.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { detectWorkloadDrift } from '../govern/workloadDrift.mjs';
import { typeInfo } from '../insights/taxonomy.mjs';
import { runFixtureHarness } from '../../tools/qualification/workloads.mjs';
import { readModule, workloadReads } from '../../tools/qualification/workloadReadsAcceptance.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

const NOW = new Date('2026-10-27T12:00:00Z');
const EXO_VERSION = '3.5.0';
let tenantSeq = 0;
const nextTenant = () => `sha256:dlp-support-${tenantSeq += 1}`;
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-00000000d1d1`;

// A custom rule package as Microsoft stores it: UTF-16 little endian with a byte order
// mark, serialized by ConvertTo-Json as an array of numbers.
const PACK_ID = guid(50);
const packXml = (id = PACK_ID) => `<?xml version="1.0" encoding="utf-16"?><RulePackage xmlns="http://schemas.microsoft.com/office/2011/mce"><RulePack id="${id}"><Version major="1" minor="0" build="0" revision="0"/></RulePack><Rules><Entity id="${guid(60)}" patternsProximity="300" recommendedConfidence="75"><Pattern confidenceLevel="75"><IdMatch idRef="Regex_keel_rt"/></Pattern></Entity><Regex id="Regex_keel_rt">KEEL-RT-\\d{6}</Regex><LocalizedStrings><Resource idRef="${guid(60)}"><Name default="true" langcode="en-us">KEEL-RT-employee-id</Name></Resource></LocalizedStrings></Rules></RulePackage>`;
const utf16Bytes = (text) => [0xff, 0xfe, ...Buffer.from(text, 'utf16le')];

const sit = (n, over = {}) => ({
  Name: `KEEL-RT-type-${n}`, Id: guid(n), Description: 'Test type', Publisher: 'Contoso', RecommendedConfidence: 75, RulePackId: PACK_ID,
  DistinguishedName: 'CN=internal', ...over,
});
const BUILT_IN_SIT = sit(1, { Name: 'Credit Card Number', Publisher: 'Microsoft Corporation' });
const rulePackage = (over = {}) => ({
  // As Q179 saw them: Name empty, RuleCollectionName carries it, bytes UTF-16LE with no byte order mark.
  Name: '', RuleCollectionName: 'KEEL-RT-rule-package', Publisher: 'KEEL-RT', Version: '1.0.0.0', Description: 'Test package',
  IsEncrypted: false, SerializedClassificationRuleCollection: [...Buffer.from(packXml(), 'utf16le')], ...over,
});
const BUILT_IN_PACKAGE = rulePackage({ RuleCollectionName: 'Microsoft Rule Package', Publisher: 'Microsoft Corporation', SerializedClassificationRuleCollection: utf16Bytes(packXml(guid(99))) });
const dictionary = (n, over = {}) => ({
  // No Guid property; Identity is the Guid (Q179).
  Name: `KEEL-RT-dictionary-${n}`, Description: 'Test words', KeywordDictionary: 'alpha,beta', MatchStyle: 'Word', IsValid: true,
  Identity: guid(n), ...over,
});
const alert = (n, over = {}) => ({
  Name: `KEEL-RT-alert-${n}`, Comment: '', Category: 'DataLossPrevention', Severity: 'Low', Disabled: true, IsSystemRule: false,
  NotifyUser: ['admin@contoso.test'], NotificationEnabled: true, Operation: ['FileDeleted'], Filter: null, AggregationType: 'None',
  Threshold: null, TimeWindow: null, ThreatType: 'Activity', WhenChangedUTC: '2026-10-20T00:00:00Z', Guid: guid(n), ...over,
});
const SYSTEM_ALERT = alert(20, { Name: 'Elevation of Exchange admin privilege', IsSystemRule: true, Disabled: false });
const auditPolicy = (n, over = {}) => ({
  Name: `KEEL-RT-audit-${n}`, Description: '', Priority: 100, RecordTypes: ['ExchangeAdmin'], Operations: [], UserIds: [],
  RetentionDuration: 'OneYear', WhenChangedUTC: '2026-10-20T00:00:00Z', Guid: guid(n), ...over,
});

function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z0-9-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const ALLOWED = { ...containerAllowlist('AllowedPurviewClassifiers'), ...containerAllowlist('AllowedPurviewAuditAlerts') };

const defaultAnswers = () => ({
  'Get-DlpSensitiveInformationType': [BUILT_IN_SIT, sit(2), sit(3)],
  'Get-DlpSensitiveInformationTypeRulePackage': [BUILT_IN_PACKAGE, rulePackage()],
  'Get-DlpKeywordDictionary': [dictionary(10)],
  'Get-ProtectionAlert': [SYSTEM_ALERT, alert(21)],
  'Get-UnifiedAuditLogRetentionPolicy': [auditPolicy(30)],
});

/** A fake Security & Compliance session behind the real jobQueue spawn path. */
function fakeCompliance(state = { answers: defaultAnswers(), errors: {} }) {
  const calls = [];
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  function run(job) {
    if (job.mode !== 'cmdlet' || job.module !== 'ExchangeOnlineManagement' || !ALLOWED[job.cmdlet]) {
      return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, category: null, errorId: 'CmdletNotAllowed' } }, 1);
    }
    calls.push({ cmdlet: job.cmdlet, parameters: job.parameters ?? {} });
    const error = state.errors?.[job.cmdlet];
    if (error) return envelope({ ok: false, error }, 1);
    return envelope({ ok: true, output: structuredClone(state.answers[job.cmdlet] ?? []) });
  }
  function spawnFn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let input = '';
    child.stdin = {
      write(chunk) { input += chunk; },
      end() {
        queueMicrotask(() => {
          const result = run(JSON.parse(input));
          child.stdout.emit('data', Buffer.from(result.stdout));
          child.emit('close', result.exitCode);
        });
      },
    };
    return child;
  }
  return { calls, state, powershell: { spawnFn, timeoutMs: 200, tenantConfigPath: '/etc/keel/purview-collector.json' } };
}

const liveCapture = (operationId, tenantRef) => {
  const descriptor = WORKLOAD_DESCRIPTORS.find((item) => item.id === operationId);
  const version = descriptor.operation.kind === 'graph' ? descriptor.operation.version : descriptor.operation.module === 'PnP.PowerShell' ? '3.4.1' : EXO_VERSION;
  return { operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-26T00:00:00Z', version, ok: true, proofRef: `${operationId}@sha256:x` };
};
const fixtureRun = (operationId) => ({ operationId, kind: 'fixture', synthetic: true, ok: true, proofRef: `${operationId}.fixture` });
const GRANTS = Object.freeze({
  permissions: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.permissions))],
  roles: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.roles))],
});
const RUNTIME = Object.freeze({ modules: { ExchangeOnlineManagement: EXO_VERSION, 'PnP.PowerShell': '3.4.1', MicrosoftTeams: '6.0.0' } });
function ledgerWith(tenantRef, live) {
  const evidence = WORKLOAD_DESCRIPTORS.map((descriptor) => (live.includes(descriptor.id) ? liveCapture(descriptor.id, tenantRef) : fixtureRun(descriptor.id)));
  return buildWorkloadLedger({ evidence, grants: GRANTS, runtime: RUNTIME, tenantRef, now: NOW });
}
const ALL_READS = Object.freeze(WORKLOAD_DESCRIPTORS.map((descriptor) => descriptor.id));
const OURS = Object.freeze([...PURVIEW_CLASSIFIERS.operations, ...PURVIEW_AUDIT_ALERTS.operations]);

test('the reads are declared, in scope, probed, Get-only and ship disabled', async () => {
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const scc = /# --- Security & Compliance([\s\S]*?)if \(\$Workloads -contains 'defender'\)/.exec(probe)[1];
  for (const workload of [PURVIEW_CLASSIFIERS, PURVIEW_AUDIT_ALERTS]) {
    const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === workload.workload);
    assert.deepEqual(declared.map((descriptor) => descriptor.id), [...workload.operations]);
    for (const descriptor of declared) {
      assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
      assert.equal(descriptor.operation.module, 'ExchangeOnlineManagement');
      assert.deepEqual(descriptor.rbac.roles, ['Compliance Administrator']);
      const name = descriptor.operation.cmdlet;
      assert.ok(scc.includes(`-Workload 'scc' -Name '${name}' -Block { ${name} }`), `${name} is probed`);
    }
    const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
    assert.ok(results.every((result) => result.ok), JSON.stringify(results));
    const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
    assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

    assert.equal(workload.descriptor.enabledByDefault, false);
    assert.equal(workload.descriptor.readOnly, true);
    assert.ok(listWorkloads().some((descriptor) => descriptor.workload === workload.workload && descriptor.enabledByDefault === false));
    assert.ok(WORKLOAD_COLLECTORS.some((entry) => entry.workload === workload.workload && entry.powershellFamily === 'purview'));
    assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((operation) => operation.workload === workload.workload), [], 'no writer');
    assert.equal(readModule(workload.workload), 'ExchangeOnlineManagement');
    assert.deepEqual(workloadReads(workload.workload).map((read) => read.operationId), [...workload.operations]);
  }
  assert.deepEqual(Object.fromEntries(Object.entries({ ...PURVIEW_CLASSIFIERS.cmdletParameters, ...PURVIEW_AUDIT_ALERTS.cmdletParameters })
    .map(([name, list]) => [name, [...list]])), ALLOWED, 'the Node and container allowlists are identical');
  for (const cmdlet of DLP_SUPPORT_EXCLUDED_CMDLETS) {
    assert.ok(!ALLOWED[cmdlet], cmdlet);
    assert.throws(() => PURVIEW_CLASSIFIERS.assertCmdlet({ cmdlet }), DlpSupportScopeError, cmdlet);
    assert.throws(() => PURVIEW_AUDIT_ALERTS.assertCmdlet({ cmdlet }), DlpSupportScopeError, cmdlet);
  }
  // The container sends only the declared fields of a type (the full object fails ConvertTo-Json, Q179),
  // and drops Microsoft's rule package by its RuleCollectionName (its Name is empty).
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const projected = /'Get-DlpSensitiveInformationType'\) \{ \$output = @\(\$output \| Select-Object ([^)]*)\)/.exec(script)[1].split(',').map((name) => name.trim());
  for (const field of CLASSIFIER_FAMILIES.sensitiveInfoType.fields) assert.ok(projected.includes(field), `${field} is sent`);
  assert.match(script, /\$_\.RuleCollectionName -ne 'Microsoft Rule Package'/);
  // Each workload runs only its own reads, and none takes a parameter.
  assert.throws(() => PURVIEW_CLASSIFIERS.assertCmdlet({ cmdlet: 'Get-ProtectionAlert' }), DlpSupportScopeError);
  assert.throws(() => PURVIEW_AUDIT_ALERTS.assertCmdlet({ cmdlet: 'Get-DlpKeywordDictionary' }), DlpSupportScopeError);
  assert.throws(() => PURVIEW_CLASSIFIERS.assertCmdlet({ cmdlet: 'Get-DlpKeywordDictionary', parameters: { Name: 'x' } }), /does not take Name/);
});

test('they sit in Purview: classifiers beside DLP, alert and audit policies under Audit and alerts', () => {
  const classifiers = typeInfo(PURVIEW_CLASSIFIERS_WORKLOAD);
  assert.equal(classifiers.known, true);
  assert.equal(classifiers.service, 'Purview');
  assert.equal(classifiers.categoryName, 'Retention and data loss prevention');
  const alerts = typeInfo(PURVIEW_AUDIT_ALERTS_WORKLOAD);
  assert.equal(alerts.service, 'Purview');
  assert.equal(alerts.categoryName, 'Audit and alerts');
});

test('rule package bytes decode to XML, and the RulePack id is the identity', () => {
  const xml = packXml();
  assert.equal(decodeRulePackage(utf16Bytes(xml)), xml);
  assert.equal(decodeRulePackage(Buffer.from(utf16Bytes(xml)).toString('base64')), xml);
  assert.equal(decodeRulePackage([0xef, 0xbb, 0xbf, ...Buffer.from(xml, 'utf8')]), xml);
  assert.equal(decodeRulePackage([...Buffer.from(xml, 'utf16le')]), xml, 'UTF-16 without a byte order mark');
  assert.equal(decodeRulePackage(xml), xml);
  for (const nothing of [undefined, null, [], 'not base64!', [300]]) assert.equal(decodeRulePackage(nothing), null);
  assert.equal(rulePackIdOf(xml), PACK_ID);
  assert.equal(rulePackIdOf('<RulePackage><Rules/></RulePackage>'), null);
});

test('custom types, packages and dictionaries are kept; Microsoft built-ins are counted, not stored', async () => {
  const compliance = fakeCompliance();
  const result = await readPurviewClassifiers({ powershell: compliance.powershell, now: () => NOW });
  assert.deepEqual(compliance.calls.map((call) => [call.cmdlet, call.parameters]), Object.values(CLASSIFIER_FAMILIES).map((spec) => [spec.cmdlet, {}]));
  assert.equal(result.outcome, 'complete', JSON.stringify(result.unknownFields));
  assert.deepEqual(result.resources.map((resource) => resource.resourceKey), [
    `sensitive-info-type:${guid(2)}`, `sensitive-info-type:${guid(3)}`, `sit-rule-package:${PACK_ID}`, `keyword-dictionary:${guid(10)}`,
  ]);
  assert.deepEqual(result.discovery.builtIn, { sensitiveInfoType: 1, sitRulePackage: 1 });
  const type = result.resources[0];
  assert.deepEqual(Object.keys(type.fields), [...CLASSIFIER_FAMILIES.sensitiveInfoType.fields]);
  assert.equal(type.fields.DistinguishedName, undefined, 'undeclared fields are dropped');
  const pack = result.resources.find((resource) => resource.kind === 'sitRulePackage');
  assert.equal(pack.fields.RulePackageXml, packXml(), 'kept as the XML a restore uploads again');
  assert.equal(pack.fields.SerializedClassificationRuleCollection, undefined);
  assert.equal(result.resources.at(-1).fields.KeywordDictionary, 'alpha,beta');

  // A large custom package (the portal's own custom pack can grow past the upload cap) is kept, never taken for Microsoft's.
  const big = packXml().replace('</Rules>', `<!-- ${'x'.repeat(200 * 1024)} --></Rules>`);
  compliance.state.answers['Get-DlpSensitiveInformationTypeRulePackage'] = [rulePackage({ RuleCollectionName: 'Microsoft.SCCManaged.CustomRulePack', SerializedClassificationRuleCollection: utf16Bytes(big) })];
  const large = await readPurviewClassifiers({ powershell: compliance.powershell, families: ['sitRulePackage'], now: () => NOW });
  assert.deepEqual(large.resources.map((resource) => resource.resourceKey), [`sit-rule-package:${PACK_ID}`]);
  assert.equal(large.discovery.builtIn.sitRulePackage, 0);

  // A package whose XML cannot be read has no identity KEEL trusts: partial, never silent.
  compliance.state.answers['Get-DlpSensitiveInformationTypeRulePackage'] = [rulePackage({ SerializedClassificationRuleCollection: null })];
  const unreadable = await readPurviewClassifiers({ powershell: compliance.powershell, now: () => NOW });
  assert.equal(unreadable.outcome, 'partial');
  assert.equal(unreadable.discovery.unidentified, 1);

  // A tenant with no custom types is complete and empty, not a failure.
  const empty = fakeCompliance({ answers: { 'Get-DlpSensitiveInformationType': [BUILT_IN_SIT], 'Get-DlpSensitiveInformationTypeRulePackage': [BUILT_IN_PACKAGE] } });
  assert.equal((await readPurviewClassifiers({ powershell: empty.powershell })).outcome, 'complete-empty');

  const denied = fakeCompliance({ answers: {}, errors: Object.fromEntries(Object.values(CLASSIFIER_FAMILIES).map((spec) => [spec.cmdlet, { message: 'Access is denied', category: 'PermissionDenied', errorId: 'x' }])) });
  const failed = await readPurviewClassifiers({ powershell: denied.powershell });
  assert.equal(failed.outcome, 'failed');
  assert.ok(failed.failures.every((failure) => failure.status === 'denied'));
});

test('alert policies keep the built-in ones; audit retention without its licence is not-licensed', async () => {
  const compliance = fakeCompliance();
  const result = await readPurviewAuditAlerts({ powershell: compliance.powershell, now: () => NOW });
  assert.equal(result.outcome, 'complete', JSON.stringify(result.unknownFields));
  assert.deepEqual(result.resources.map((resource) => [resource.resourceKey, resource.fields.Name]), [
    [`alert-policy:${guid(20)}`, 'Elevation of Exchange admin privilege'],
    [`alert-policy:${guid(21)}`, 'KEEL-RT-alert-21'],
    [`audit-retention-policy:${guid(30)}`, 'KEEL-RT-audit-30'],
  ]);
  assert.deepEqual(Object.keys(result.resources[0].fields), [...AUDIT_ALERT_FAMILIES.alertPolicy.fields]);
  assert.equal(result.resources[1].fields.Filter, null, 'a null answered is observed, not unknown');

  compliance.state.errors = { 'Get-UnifiedAuditLogRetentionPolicy': { message: "The term 'Get-UnifiedAuditLogRetentionPolicy' is not recognized as a name of a cmdlet", category: 'ObjectNotFound', errorId: 'CommandNotFoundException' } };
  const unlicensed = await readPurviewAuditAlerts({ powershell: compliance.powershell, now: () => NOW });
  assert.equal(unlicensed.outcome, 'partial');
  assert.equal(unlicensed.unavailable[0].status, 'not-licensed');
  assert.match(unlicensed.unavailable[0].license, /Audit \(Premium\)/);

  // Every tenant has built-in alert policies: an empty answer is a gap.
  const none = fakeCompliance({ answers: { 'Get-ProtectionAlert': [] } });
  const gap = await readPurviewAuditAlerts({ powershell: none.powershell, families: ['alertPolicy'] });
  assert.equal(gap.outcome, 'partial');
  assert.deepEqual(gap.discovery.empty, ['alertPolicy']);
});

test('collection stays off until Exchange and the core reads are qualified, then a dictionary change is a change', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const compliance = fakeCompliance();
  const others = ALL_READS.filter((id) => !OURS.includes(id));
  for (const ledger of [ledgerWith(tenantRef, others), ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)))]) {
    assert.equal((await collectPurviewClassifiers(client, { tenantRef, ledger, powershell: compliance.powershell, now: () => NOW })).run.outcome, 'disabled');
    assert.equal((await collectPurviewAuditAlerts(client, { tenantRef, ledger, powershell: compliance.powershell, now: () => NOW })).run.outcome, 'disabled');
  }
  assert.deepEqual(compliance.calls, [], 'nothing is sent while disabled');
  assert.match(purviewClassifiersActivation(ledgerWith(tenantRef, others)).reasons.join('; '), /purview\.sensitive-info-types is fixture-tested/);

  // Never waits for the other Purview workloads, only for Exchange and its own reads.
  const otherPurview = ALL_READS.filter((id) => id.startsWith('purview.') && !OURS.includes(id));
  assert.ok(otherPurview.length > 10);
  const withoutOtherPurview = ledgerWith(tenantRef, ALL_READS.filter((id) => !otherPurview.includes(id)));
  assert.equal(purviewClassifiersActivation(withoutOtherPurview).enabled, true);
  assert.equal(purviewAuditAlertsActivation(withoutOtherPurview).enabled, true);

  // Audit retention is licensed: off until its own row is on, listed as skipped.
  const noAudit = purviewAuditAlertsActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => id !== 'purview.audit-retention-policies')));
  assert.equal(noAudit.enabled, true);
  assert.deepEqual(noAudit.families, ['alertPolicy']);
  assert.deepEqual(noAudit.skipped.map((entry) => entry.family), ['auditRetentionPolicy']);

  const ledger = ledgerWith(tenantRef, ALL_READS);
  const first = await collectPurviewClassifiers(client, { tenantRef, ledger, powershell: compliance.powershell, now: () => new Date('2026-10-26T02:00:00Z') });
  assert.equal(first.run.outcome, 'complete');
  const { rows } = await client.query('SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [first.run.id]);
  assert.deepEqual(rows.map((row) => [row.resource_key, row.fields.kind]), [
    [`keyword-dictionary:${guid(10)}`, 'keywordDictionary'],
    [`sensitive-info-type:${guid(2)}`, 'sensitiveInfoType'],
    [`sensitive-info-type:${guid(3)}`, 'sensitiveInfoType'],
    [`sit-rule-package:${PACK_ID}`, 'sitRulePackage'],
  ]);
  const audit = await collectPurviewAuditAlerts(client, { tenantRef, ledger, powershell: compliance.powershell, now: () => NOW });
  assert.equal(audit.run.outcome, 'complete');

  compliance.state.answers['Get-DlpKeywordDictionary'] = [dictionary(10, { KeywordDictionary: 'alpha,beta,gamma' })];
  const second = await collectPurviewClassifiers(client, { tenantRef, ledger, powershell: compliance.powershell, now: () => new Date('2026-10-27T02:00:00Z') });
  const drift = await detectWorkloadDrift(client, { collectionId: second.run.id });
  assert.equal(drift.status, 'detected');
  const { rows: changes } = await client.query('SELECT resource_key, change_type, fields FROM workload_drift WHERE tenant_ref = $1', [tenantRef]);
  assert.deepEqual(changes.map((row) => [row.resource_key, row.change_type]), [[`keyword-dictionary:${guid(10)}`, 'modified']]);
  assert.ok(changes[0].fields.some((field) => field.path === 'KeywordDictionary'));
});
