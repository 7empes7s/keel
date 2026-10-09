// Issue #157: Purview retention and DLP policies and rules, read-only.
//
// Acceptance:
//  - each read is declared in workloadContract.mjs, passes the scope validator, is run
//    by the read-only probe in the Security & Compliance session, and ships disabled
//    (fixture proof never enables it);
//  - no write capability exists for the workload, no cmdlet that reads DLP matches or
//    incidents is allowed, and the Purview label workload is unchanged;
//  - each policy and rule is one observation keyed by its Guid, with declared fields
//    only, its parent policy kept on each rule, and nothing credential-shaped stored;
//  - a DLP read that stops being available is labelled not-licensed and makes the run
//    partial: its policies are no longer backed up.
// Mutation checks (each was run once and made this file fail):
//  - key objects by Name instead of Guid (the rename assertion fails);
//  - stop counting rules with no parent policy (the unparented assertion fails);
//  - count a not-licensed family as complete, or as a failure (the outcome test fails);
//  - run a DLP read whose own row is not enabled (the activation test fails).
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays the ops/powershell/run-cmdlet.ps1 contract through the real
// engine/powershell/jobQueue.mjs spawn path. No tenant is touched.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  CORE_OPERATIONS, FAMILIES, FAMILY_NAMES, RETENTION_DLP_CMDLET_PARAMETERS, RETENTION_DLP_DESCRIPTOR, RETENTION_DLP_EXCLUDED_CMDLETS,
  RETENTION_DLP_OPERATIONS, RETENTION_DLP_WORKLOAD, RetentionDlpScopeError, assertRetentionDlpCmdlet, collectRetentionDlp,
  readRetentionDlp, retentionDlpActivation,
} from '../collect/workloads/purviewRetentionDlp.mjs';
import { PURVIEW_CMDLET_PARAMETERS, PURVIEW_DESCRIPTOR, PURVIEW_OPERATIONS } from '../collect/workloads/purview.mjs';
import { EXCHANGE_OPERATIONS } from '../collect/workloads/exchange.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { planDeletionWaves, planWaves } from '../restore/wavePlanner.mjs';
import { redactPayload } from '../telemetry/events.mjs';
import { runFixtureHarness } from '../../tools/qualification/workloads.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
  }
  return client;
}

const NOW = new Date('2026-10-09T12:00:00Z');
const EXO_VERSION = '3.5.0';
let tenantSeq = 0;
const nextTenant = () => `sha256:issue-157-${tenantSeq += 1}`;
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000157`;
const WHEN = '2026-09-01T00:00:00Z';

const RETENTION_LOCATIONS = {
  ExchangeLocation: ['All'], ExchangeLocationException: [], SharePointLocation: ['All'], SharePointLocationException: [],
  OneDriveLocation: ['All'], OneDriveLocationException: [], ModernGroupLocation: [], ModernGroupLocationException: [],
  PublicFolderLocation: [], SkypeLocation: [], SkypeLocationException: [], TeamsChannelLocation: [], TeamsChannelLocationException: [],
  TeamsChatLocation: [], TeamsChatLocationException: [], AdaptiveScopeLocation: [],
};
const DLP_LOCATIONS = {
  ExchangeLocation: ['All'], SharePointLocation: ['All'], SharePointLocationException: [], OneDriveLocation: ['All'], OneDriveLocationException: [],
  TeamsLocation: [], TeamsLocationException: [], EndpointDlpLocation: [], EndpointDlpLocationException: [],
  OnPremisesScannerDlpLocation: [], OnPremisesScannerDlpLocationException: [], ExchangeSenderMemberOf: [], ExchangeSenderMemberOfException: [],
};

// One or two objects per family, as the Security & Compliance session answers them,
// with the extra properties a careless reader would keep.
const SAMPLE = Object.freeze({
  'Get-RetentionCompliancePolicy': [
    { Name: 'Keep mail 7 years', Guid: guid(1), Comment: '', Enabled: true, Mode: 'Enforce', Type: 'Hold', Workload: 'Exchange, SharePoint, OneDriveForBusiness', RetentionRuleTypes: ['Default'], RestrictiveRetention: false, ...RETENTION_LOCATIONS, DistributionStatus: 'Success', WhenChangedUTC: WHEN, ObjectVersion: 'internal', ExoObjectId: guid(901) },
    { Name: 'Regulatory lock', Guid: guid(2), Comment: 'SEC 17a-4', Enabled: true, Mode: 'Enforce', Type: 'Hold', Workload: 'Exchange', RetentionRuleTypes: ['Default'], RestrictiveRetention: true, ...RETENTION_LOCATIONS, DistributionStatus: 'Success', WhenChangedUTC: WHEN },
  ],
  'Get-RetentionComplianceRule': [
    { Name: 'Keep mail 7 years rule', Guid: guid(3), Policy: guid(1), Comment: '', Disabled: false, Mode: 'Enforce', Workload: 'Exchange, SharePoint, OneDriveForBusiness', RetentionDuration: 2555, RetentionDurationDisplayHint: 'Days', RetentionComplianceAction: 'KeepAndDelete', ExpirationDateOption: 'CreationAgeInDays', ApplyComplianceTag: null, PublishComplianceTag: null, ContentMatchQuery: null, ContentContainsSensitiveInformation: null, ExcludedItemClasses: [], WhenChangedUTC: WHEN, ReadOnly: false },
  ],
  'Get-DlpCompliancePolicy': [
    { Name: 'Card numbers', Guid: guid(4), Comment: '', Mode: 'Enable', Type: 'Dlp', Workload: 'Exchange, SharePoint, OneDriveForBusiness', Priority: 0, ...DLP_LOCATIONS, PolicyTemplateInfo: null, DistributionStatus: 'Success', WhenChangedUTC: WHEN },
  ],
  'Get-DlpComplianceRule': [
    {
      Name: 'Block card numbers', Guid: guid(5), Policy: guid(4), ParentPolicyName: 'Card numbers', Comment: '', Disabled: false, Mode: 'Enforce', Priority: 0, Workload: 'Exchange, SharePoint, OneDriveForBusiness',
      ContentContainsSensitiveInformation: [{ name: 'Credit Card Number', id: '50842eb7-edc8-4019-85dd-5a5c1f2bb085', mincount: '1', minconfidence: '85' }],
      ExceptIfContentContainsSensitiveInformation: null, AdvancedRule: null,
      ContentPropertyContainsWords: [], SubjectOrBodyContainsWords: ['project falcon'], SubjectOrBodyMatchesPatterns: ['\\bPF-\\d{6}\\b'], DocumentNameMatchesPatterns: [],
      ContentExtensionMatchesWords: [], AccessScope: 'NotInOrganization', From: [], SentToMemberOf: [], SenderDomainIs: [], RecipientDomainIs: [],
      ExceptIfSenderDomainIs: [], ExceptIfRecipientDomainIs: ['partner.test'], BlockAccess: true, BlockAccessScope: 'All', NotifyUser: ['SiteAdmin'], NotifyUserType: 'NotSet',
      NotifyEmailCustomText: null, NotifyPolicyTipCustomText: 'This message contains card numbers.', NotifyAllowOverride: [], GenerateAlert: ['SiteAdmin'],
      GenerateIncidentReport: ['dlp-team@contoso.test'], IncidentReportContent: ['All'], ReportSeverityLevel: 'High', StopPolicyProcessing: false, WhenChangedUTC: WHEN,
      // What a careless reader would keep: match counts and incident detail are not configuration.
      MatchCount: 42, LastIncident: 'mail from a@contoso.test matched 3 card numbers',
    },
  ],
});

// The allowlists the container enforces, parsed from the script it ships.
function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const RETENTION_DLP_ALLOWED = containerAllowlist('AllowedPurviewRetentionDlp');
const NOT_FOUND = (cmdlet) => ({ message: `The term '${cmdlet}' is not recognized as a name of a cmdlet, function, script file, or executable program.`, category: 'ObjectNotFound', errorId: 'CommandNotFoundException' });

/**
 * A fake Security & Compliance session behind the real jobQueue spawn path. It plays
 * run-cmdlet.ps1 for this workload. `answers[cmdlet]` overrides the sample: a list is
 * the output, `{ error }` an error envelope, 'crash' a non-zero exit with no envelope.
 */
function fakeCompliance({ answers = {} } = {}) {
  const calls = [];
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  function run(job) {
    const keys = Object.keys(job).filter((key) => key !== 'jobId').sort();
    if (job.mode !== 'cmdlet' || keys.some((key) => !['adapter', 'cmdlet', 'mode', 'module', 'parameters', 'tenantConfigPath'].includes(key))) {
      return { stdout: '', stderr: `run-job.sh: refused descriptor with ${keys.join(',')}`, exitCode: 2 };
    }
    if (job.module !== 'ExchangeOnlineManagement' || !RETENTION_DLP_ALLOWED[job.cmdlet]) {
      return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, category: null, errorId: 'CmdletNotAllowed' } }, 1);
    }
    for (const name of Object.keys(job.parameters ?? {})) {
      if (!RETENTION_DLP_ALLOWED[job.cmdlet].includes(name)) return envelope({ ok: false, error: { message: `parameter ${name} is not allowed`, category: null, errorId: 'ParameterNotAllowed' } }, 1);
    }
    calls.push({ cmdlet: job.cmdlet, parameters: job.parameters ?? {} });
    const answer = answers[job.cmdlet] ?? SAMPLE[job.cmdlet];
    if (answer === 'crash') return { stdout: '', stderr: 'pwsh: segmentation fault', exitCode: 139 };
    if (answer?.error) return envelope({ ok: false, error: answer.error }, 1);
    return envelope({ ok: true, output: structuredClone(answer) });
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
          if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
          if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
          child.emit('close', result.exitCode);
        });
      },
    };
    return child;
  }
  return { calls, powershell: { spawnFn, timeoutMs: 200, tenantConfigPath: '/etc/keel/tenant.json' } };
}

// ---------------------------------------------------------------- ledgers

const liveCapture = (operationId, tenantRef) => {
  const descriptor = WORKLOAD_DESCRIPTORS.find((item) => item.id === operationId);
  const version = descriptor.operation.kind === 'graph' ? descriptor.operation.version : descriptor.operation.module === 'PnP.PowerShell' ? '3.4.1' : EXO_VERSION;
  return { operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-08T00:00:00Z', version, ok: true, proofRef: `${operationId}@sha256:x` };
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
const OTHER_READS = Object.freeze(ALL_READS.filter((id) => !RETENTION_DLP_OPERATIONS.includes(id)));

// ---------------------------------------------------------------- tests

test('each retention and DLP read is declared, in scope, probed, read-only and ships disabled', async () => {
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === RETENTION_DLP_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.operation.cmdlet), [
    'Get-RetentionCompliancePolicy', 'Get-RetentionComplianceRule', 'Get-DlpCompliancePolicy', 'Get-DlpComplianceRule',
  ]);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [...RETENTION_DLP_OPERATIONS]);
  for (const descriptor of declared) {
    assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
    assert.equal(descriptor.operation.module, 'ExchangeOnlineManagement');
    assert.deepEqual(descriptor.operation.parameters, []);
    assert.deepEqual(descriptor.rbac.roles, ['Compliance Administrator']);
    assert.match(descriptor.source.url, /^https:\/\/learn\.microsoft\.com\/en-us\/powershell\/module\/exchange\/get-/);
  }

  // The read-only probe runs each one in the Security & Compliance session.
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const scc = /# --- Security & Compliance([\s\S]*?)# --- Teams/.exec(probe)[1];
  assert.match(scc, /Connect-IPPSSession/);
  for (const descriptor of declared) assert.match(scc, new RegExp(`-Workload 'scc' -Name '${descriptor.operation.probeName}'`), descriptor.id);

  // No proof: disabled. Fixture proof: fixture-tested, still disabled.
  const bare = buildWorkloadLedger({ grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  for (const id of RETENTION_DLP_OPERATIONS) {
    const row = bare.rows.find((item) => item.id === id);
    assert.equal(row.state, 'disabled', id);
    assert.equal(row.enabled, false, id);
  }
  const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

  // Registered disabled; read-only; no write of any kind.
  assert.equal(RETENTION_DLP_DESCRIPTOR.enabledByDefault, false);
  assert.equal(RETENTION_DLP_DESCRIPTOR.readOnly, true);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === RETENTION_DLP_WORKLOAD && descriptor.enabledByDefault === false));
  assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((operation) => operation.workload === RETENTION_DLP_WORKLOAD), []);
  assert.ok(Object.keys(RETENTION_DLP_CMDLET_PARAMETERS).every((cmdlet) => cmdlet.startsWith('Get-')));
  assert.deepEqual(Object.fromEntries(Object.entries(RETENTION_DLP_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), RETENTION_DLP_ALLOWED,
    'the Node and container allowlists are identical');
  for (const cmdlet of [
    'Set-RetentionCompliancePolicy', 'Set-RetentionComplianceRule', 'New-DlpComplianceRule', 'Remove-DlpCompliancePolicy',
    ...RETENTION_DLP_EXCLUDED_CMDLETS, 'Get-Label',
  ]) {
    assert.throws(() => assertRetentionDlpCmdlet({ cmdlet }), RetentionDlpScopeError, cmdlet);
    assert.ok(!(cmdlet in RETENTION_DLP_ALLOWED), `${cmdlet} is not allowed by the container`);
  }
  assert.throws(() => assertRetentionDlpCmdlet({ cmdlet: 'Get-RetentionCompliancePolicy', parameters: { DistributionDetail: true } }), /does not take DistributionDetail/);

  // The Purview label workload keeps its own operations, allowlist and gate.
  assert.deepEqual([...PURVIEW_OPERATIONS], ['purview.label-definitions', 'purview.label-publication']);
  assert.deepEqual(Object.keys(PURVIEW_CMDLET_PARAMETERS), ['Get-Label', 'Get-LabelPolicy', 'Set-Label', 'Set-LabelPolicy']);
  assert.deepEqual(Object.keys(containerAllowlist('AllowedPurview')), ['Get-Label', 'Get-LabelPolicy', 'Set-Label', 'Set-LabelPolicy']);
  assert.equal(PURVIEW_DESCRIPTOR.workload, 'purview-labels');
});

test('every policy and rule is one observation keyed by Guid, with its parent policy and declared fields only', async () => {
  const compliance = fakeCompliance({
    answers: {
      // A rule renamed between runs keeps its key; a duplicate is stored once; a rule
      // with no Guid is not guessed at; a rule with no parent policy is kept but is a gap;
      // a credential pasted into a DLP keyword list is redacted.
      'Get-DlpComplianceRule': [
        { ...SAMPLE['Get-DlpComplianceRule'][0], Name: 'Block card numbers (renamed)' },
        { ...SAMPLE['Get-DlpComplianceRule'][0] },
        { ...SAMPLE['Get-DlpComplianceRule'][0], Guid: 'not-a-guid', Name: 'Unidentified' },
        { ...SAMPLE['Get-DlpComplianceRule'][0], Guid: guid(6), Name: 'Orphan', Policy: null, ParentPolicyName: null },
        {
          ...SAMPLE['Get-DlpComplianceRule'][0], Guid: guid(7), Name: 'Leaked token',
          SubjectOrBodyContainsWords: ['Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
        },
      ],
    },
  });
  const result = await readRetentionDlp({ powershell: compliance.powershell, now: () => NOW });

  // One call per family, no parameters, nothing else.
  assert.deepEqual(compliance.calls.map((call) => call.cmdlet), FAMILY_NAMES.map((name) => FAMILIES[name].cmdlet));
  assert.ok(compliance.calls.every((call) => Object.keys(call.parameters).length === 0));

  assert.deepEqual(result.resources.map((resource) => resource.resourceKey), [
    `retention-policy:${guid(1)}`, `retention-policy:${guid(2)}`, `retention-rule:${guid(3)}`, `dlp-policy:${guid(4)}`,
    `dlp-rule:${guid(5)}`, `dlp-rule:${guid(6)}`, `dlp-rule:${guid(7)}`,
  ]);
  const rule = result.resources.find((resource) => resource.resourceKey === `dlp-rule:${guid(5)}`);
  assert.equal(rule.fields.Name, 'Block card numbers (renamed)', 'the first answer for a Guid is kept; a rename does not change the key');
  assert.equal(rule.parentPolicy, guid(4));
  assert.equal(rule.fields.ParentPolicyName, 'Card numbers');
  assert.equal(result.resources.find((resource) => resource.resourceKey === `retention-rule:${guid(3)}`).parentPolicy, guid(1));
  assert.ok(!('parentPolicy' in result.resources[0]), 'a policy has no parent');
  assert.equal(result.resources.find((resource) => resource.resourceKey === `dlp-rule:${guid(6)}`).parentPolicy, null);
  assert.equal(result.discovery.unidentified, 1);
  assert.equal(result.discovery.unparented, 1);
  assert.equal(result.discovery.contentRead, false);

  // Sensitive information types, keywords and patterns are configuration: kept as is.
  assert.deepEqual(rule.fields.ContentContainsSensitiveInformation, SAMPLE['Get-DlpComplianceRule'][0].ContentContainsSensitiveInformation);
  assert.deepEqual(rule.fields.SubjectOrBodyMatchesPatterns, ['\\bPF-\\d{6}\\b']);
  assert.equal(rule.fieldCoverage.SubjectOrBodyContainsWords.status, 'observed');
  const leaked = result.resources.find((resource) => resource.resourceKey === `dlp-rule:${guid(7)}`);
  assert.equal(leaked.fieldCoverage.SubjectOrBodyContainsWords.status, 'redacted');

  // Locks are observed from the answer.
  assert.equal(result.resources[0].lock, 'unlocked');
  assert.equal(result.resources[1].lock, 'locked');
  assert.equal(rule.lock, 'not-reported');

  // Declared fields only: match counts, incident text and internal ids are dropped.
  for (const resource of result.resources) {
    const declared = FAMILIES[resource.kind].fields;
    assert.deepEqual(Object.keys(resource.fieldCoverage).sort(), [...declared].sort(), resource.resourceKey);
    assert.ok(Object.keys(resource.fields).every((field) => declared.includes(field)), resource.resourceKey);
  }
  const stored = JSON.stringify(result.resources);
  for (const dropped of ['MatchCount', 'LastIncident', 'matched 3 card numbers', 'ObjectVersion', 'ExoObjectId', 'ReadOnly']) {
    assert.ok(!stored.includes(dropped), dropped);
  }
  assert.ok(!stored.includes('abcdefghijklmnopqrstuvwxyz0123456789'), 'a credential-shaped keyword is never stored');
  const redaction = { redactedFields: 0, seen: new WeakSet() };
  redactPayload(result.resources.map((resource) => resource.fields), redaction);
  assert.equal(redaction.redactedFields, 0, 'nothing left that the shared redactor would catch');
  assert.equal(result.outcome, 'partial', 'an unidentified object, a rule with no parent and a redacted value are gaps');

  // A rule with no parent alone makes the run partial.
  const orphanOnly = await readRetentionDlp({
    powershell: fakeCompliance({ answers: { 'Get-RetentionComplianceRule': [{ ...SAMPLE['Get-RetentionComplianceRule'][0], Policy: 'Keep mail 7 years' }] } }).powershell,
  });
  assert.equal(orphanOnly.discovery.unparented, 1);
  assert.equal(orphanOnly.outcome, 'partial');

  const clean = await readRetentionDlp({ powershell: fakeCompliance().powershell, now: () => NOW });
  assert.equal(clean.outcome, 'complete');
  assert.equal(clean.resources.length, 5);
  assert.ok(Object.values(clean.discovery.families).every((family) => family.status === 'read'));
});

test('a DLP family that is no longer available is labelled, and is a gap; other failures are structured gaps', async () => {
  const unlicensed = fakeCompliance({ answers: { 'Get-DlpCompliancePolicy': { error: NOT_FOUND('Get-DlpCompliancePolicy') }, 'Get-DlpComplianceRule': { error: NOT_FOUND('Get-DlpComplianceRule') } } });
  const result = await readRetentionDlp({ powershell: unlicensed.powershell, now: () => NOW });
  assert.equal(result.outcome, 'partial', 'a qualified DLP read that stops working means those policies are no longer backed up');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.unavailable.map((item) => [item.family, item.status]), [['dlpPolicy', 'not-licensed'], ['dlpRule', 'not-licensed']]);
  assert.match(result.unavailable[0].reason, /Microsoft Purview Data Loss Prevention is not licensed/);
  assert.equal(result.unavailable[0].error.errorId, 'CommandNotFoundException');
  assert.equal(result.discovery.families.dlpPolicy.status, 'not-licensed');
  assert.equal(result.resources.length, 3, 'the retention policies and rules are still backed up');

  // Nothing read at all is a failure, even when some families say not-licensed.
  const nothing = Object.fromEntries(FAMILY_NAMES.map((family) => [FAMILIES[family].cmdlet, { error: NOT_FOUND(FAMILIES[family].cmdlet) }]));
  assert.equal((await readRetentionDlp({ powershell: fakeCompliance({ answers: nothing }).powershell })).outcome, 'failed');

  // A retention cmdlet that is not found is a failure, not a licence question.
  const missingCore = await readRetentionDlp({ powershell: fakeCompliance({ answers: { 'Get-RetentionComplianceRule': { error: NOT_FOUND('Get-RetentionComplianceRule') } } }).powershell });
  assert.equal(missingCore.outcome, 'partial');
  assert.deepEqual(missingCore.failures.map((failure) => [failure.family, failure.status, failure.error.errorId]), [['retentionRule', 'failed', 'CommandNotFoundException']]);

  // Denied, crashed and empty answers.
  const mixed = await readRetentionDlp({
    powershell: fakeCompliance({
      answers: {
        'Get-RetentionCompliancePolicy': { error: { message: "The user isn't assigned to any management roles. Access denied.", category: 'PermissionDenied', errorId: 'AccessDenied' } },
        'Get-DlpComplianceRule': 'crash',
        'Get-DlpCompliancePolicy': [],
      },
    }).powershell,
  });
  assert.equal(mixed.outcome, 'partial');
  assert.deepEqual(mixed.failures.map((failure) => [failure.family, failure.status, failure.error.code]), [['retentionPolicy', 'denied', 'CMDLET_ERROR'], ['dlpRule', 'failed', 'NONZERO_EXIT']]);
  assert.deepEqual(mixed.discovery.families.dlpPolicy, { status: 'read', objects: 0 });

  const everything = Object.fromEntries(FAMILY_NAMES.map((name) => [FAMILIES[name].cmdlet, 'crash']));
  assert.equal((await readRetentionDlp({ powershell: fakeCompliance({ answers: everything }).powershell })).outcome, 'failed');

  const empty = Object.fromEntries(FAMILY_NAMES.map((name) => [FAMILIES[name].cmdlet, []]));
  assert.equal((await readRetentionDlp({ powershell: fakeCompliance({ answers: empty }).powershell })).outcome, 'complete-empty');
});

test('collection stays off until Exchange and both retention reads are qualified; DLP reads need their own proof', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const compliance = fakeCompliance();

  // Fixture proof only, or every retention and DLP read live but Exchange not: disabled, nothing sent.
  for (const ledger of [ledgerWith(tenantRef, OTHER_READS), ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)))]) {
    const disabled = await collectRetentionDlp(client, { tenantRef, ledger, powershell: compliance.powershell, now: () => NOW });
    assert.equal(disabled.run.outcome, 'disabled');
    assert.equal(disabled.result, null);
  }
  assert.deepEqual(compliance.calls, [], 'nothing is sent while disabled');
  assert.match(retentionDlpActivation(ledgerWith(tenantRef, OTHER_READS)).reasons.join('; '), /purview\.retention-policies is fixture-tested/);
  assert.match(retentionDlpActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)))).reasons[0], /Exchange is not qualified yet/);
  // One retention read missing keeps the whole workload off.
  assert.equal(retentionDlpActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => id !== 'purview.retention-rules'))).enabled, false);
  // Purview label proof is not retention proof.
  assert.equal(retentionDlpActivation(ledgerWith(tenantRef, OTHER_READS)).enabled, false);

  // Retention reads live, DLP reads not: enabled, DLP families skipped and the run partial.
  const core = ledgerWith(tenantRef, [...OTHER_READS, ...CORE_OPERATIONS]);
  const activation = retentionDlpActivation(core);
  assert.equal(activation.enabled, true);
  assert.deepEqual(activation.skipped.map((item) => item.family), ['dlpPolicy', 'dlpRule']);
  const partial = await collectRetentionDlp(client, { tenantRef, ledger: core, powershell: compliance.powershell, now: () => NOW });
  assert.equal(partial.run.outcome, 'partial');
  assert.ok(!compliance.calls.some((call) => call.cmdlet.startsWith('Get-Dlp')), 'an unqualified DLP read is never sent');
  assert.match(partial.run.digest.skipped[0].reason, /purview\.dlp-policies is fixture-tested/);

  // Everything live: complete, one stored observation per object.
  compliance.calls.length = 0;
  const full = await collectRetentionDlp(client, { tenantRef, ledger: ledgerWith(tenantRef, ALL_READS), powershell: compliance.powershell, now: () => NOW });
  assert.equal(full.run.outcome, 'complete');
  assert.equal(compliance.calls.length, FAMILY_NAMES.length);
  const { rows } = await client.query(`SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key`, [full.run.id]);
  assert.equal(rows.length, 5);
  const dlpRule = rows.find((row) => row.resource_key === `dlp-rule:${guid(5)}`);
  assert.equal(dlpRule.fields.identity, guid(5));
  assert.equal(dlpRule.fields.kind, 'dlpRule');
  assert.equal(dlpRule.fields.parentPolicy, guid(4));
  assert.equal(dlpRule.fields.MatchCount, undefined);
  assert.equal(dlpRule.field_coverage.BlockAccess.status, 'observed');
  const locked = rows.find((row) => row.resource_key === `retention-policy:${guid(2)}`);
  assert.equal(locked.fields.lock, 'locked');
  assert.equal(locked.fields.RestrictiveRetention, true);

  // Coverage lists the workload; its type never enters an Entra wave.
  const report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [], now: NOW });
  const entry = report.workloads.find((item) => item.workload === RETENTION_DLP_WORKLOAD);
  assert.equal(entry.status, 'complete');
  assert.throws(() => planWaves([{ naturalKey: 'x', resourceType: 'purviewRetentionDlp', verb: 'update', payload: {} }]), /workload restore path/);
  assert.throws(() => planDeletionWaves([{ naturalKey: 'x', resourceType: 'purviewRetentionDlp', verb: 'delete', payload: {} }]), /workload restore path/);
});
