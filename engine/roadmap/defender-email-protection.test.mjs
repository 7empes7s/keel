// Defender email protection (gap audit 2026-10-30, section B), read-only.
//
// Acceptance:
//  - each read is declared in workloadContract.mjs, passes the scope validator, is run
//    by the read-only probe, and ships disabled (fixture proof never enables it);
//  - only Get cmdlets run, each with the fixed values its family names; the Node and
//    container allowlists match; no write exists;
//  - Allow/Block List entries are keyed by the Identity Exchange gives them, spoofed
//    sender pairs by their Guid, other objects by Guid, the ARC settings once per tenant;
//    declared fields only;
//  - a Defender read that is not available is labelled not-licensed and is a gap;
//  - collection stays off until Exchange and every core read are qualified;
//  - the workload is listed under Defender, in the threat policies group, and a change
//    to an entry is named by its sender, URL or hash, never by its id.
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays the ops/powershell/run-cmdlet.ps1 contract through the real
// engine/powershell/jobQueue.mjs spawn path. No tenant is touched.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  CORE_OPERATIONS, DEFENDER_EMAIL_CMDLET_PARAMETERS, DEFENDER_EMAIL_DESCRIPTOR, DEFENDER_EMAIL_OPERATIONS, DEFENDER_EMAIL_WORKLOAD,
  DefenderEmailScopeError, FAMILIES, FAMILY_NAMES, LICENSED_FAMILIES, assertDefenderEmailCmdlet, collectDefenderEmail,
  defenderEmailActivation, readDefenderEmail,
} from '../collect/workloads/defenderEmail.mjs';
import { EXCHANGE_OPERATIONS } from '../collect/workloads/exchange.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOAD_DESCRIPTORS, WORKLOADS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { serviceObjectName } from '../insights/feed.mjs';
import { typeInfo } from '../insights/taxonomy.mjs';
import { READ_FAMILIES, readModule } from '../../tools/qualification/workloadReadsAcceptance.mjs';
import { runFixtureHarness } from '../../tools/qualification/workloads.mjs';
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

const NOW = new Date('2026-10-30T12:00:00Z');
const EXO_VERSION = '3.5.0';
let tenantSeq = 0;
const nextTenant = () => `sha256:defender-email-${tenantSeq += 1}`;
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-00000000d0d0`;
// The shape of an Allow/Block List Identity: opaque, mixed case, URL-safe base64.
const entryId = (n) => `RgAAAAAI8gSyI_NmQqzeh-HXJBywBwCqfQNJY8hBTbdlKFkv6BcUAAAAl_QCAAAAqf0D${n}`;
const familyOf = (job) => FAMILY_NAMES.find((name) => FAMILIES[name].cmdlet === job.cmdlet
  && JSON.stringify(FAMILIES[name].parameters ?? {}) === JSON.stringify(job.parameters ?? {}));

// One object per family, as Exchange answers it: every declared field, the identity the
// family keys on, plus internal properties a careless reader would keep.
const SAMPLE = Object.freeze(Object.fromEntries(FAMILY_NAMES.map((family, index) => {
  const { fields, prefix, cmdlet } = FAMILIES[family];
  const body = Object.fromEntries(fields.map((field) => [field, field === 'WhenChangedUTC' ? '2026-10-01T00:00:00Z' : true]));
  const identity = cmdlet === 'Get-TenantAllowBlockListItems' ? { Identity: entryId(index), Value: `KEEL-RT-${prefix}.example.com` }
    : cmdlet === 'Get-TenantAllowBlockListSpoofItems' ? { Identity: guid(index + 1), SpoofedUser: 'KEEL-RT-spoof.example.com' }
      : { Guid: guid(index + 1), Name: `KEEL-RT-${prefix}` };
  return [family, { ...body, ...identity, LastUsedDate: '2026-10-29T00:00:00Z', DistinguishedName: 'CN=internal', OrganizationId: 'internal' }];
})));
const answersFor = (family) => [structuredClone(SAMPLE[family])];

function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z0-9-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const ALLOWED = containerAllowlist('AllowedDefenderEmail');
const NOT_FOUND = (cmdlet) => ({ message: `The term '${cmdlet}' is not recognized as a name of a cmdlet, function, script file, or executable program.`, category: 'ObjectNotFound', errorId: 'CommandNotFoundException' });

/** A fake Exchange Online behind the real jobQueue spawn path, playing run-cmdlet.ps1. */
function fakeExchange({ answers = {} } = {}) {
  const calls = [];
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  function run(job) {
    if (job.mode !== 'cmdlet' || job.module !== 'ExchangeOnlineManagement' || !ALLOWED[job.cmdlet]) {
      return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, category: null, errorId: 'CmdletNotAllowed' } }, 1);
    }
    for (const name of Object.keys(job.parameters ?? {})) {
      if (!ALLOWED[job.cmdlet].includes(name)) return envelope({ ok: false, error: { message: `parameter ${name} is not allowed`, category: null, errorId: 'ParameterNotAllowed' } }, 1);
    }
    calls.push({ cmdlet: job.cmdlet, parameters: job.parameters ?? {} });
    const family = familyOf(job);
    const answer = answers[family] ?? answersFor(family);
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

const liveCapture = (operationId, tenantRef) => {
  const descriptor = WORKLOAD_DESCRIPTORS.find((item) => item.id === operationId);
  const version = descriptor.operation.kind === 'graph' || descriptor.operation.kind === 'rest' ? descriptor.operation.version
    : descriptor.operation.module === 'PnP.PowerShell' ? '3.4.1' : descriptor.operation.module === 'MicrosoftTeams' ? '6.0.0' : EXO_VERSION;
  return { operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-29T00:00:00Z', version, ok: true, proofRef: `${operationId}@sha256:x` };
};
const fixtureRun = (operationId) => ({ operationId, kind: 'fixture', synthetic: true, ok: true, proofRef: `${operationId}.fixture` });
const GRANTS = Object.freeze({
  permissions: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.permissions))],
  roles: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.roles))],
  setup: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.setup ?? []))],
});
const RUNTIME = Object.freeze({ modules: { ExchangeOnlineManagement: EXO_VERSION, 'PnP.PowerShell': '3.4.1', MicrosoftTeams: '6.0.0' } });
function ledgerWith(tenantRef, live) {
  const evidence = WORKLOAD_DESCRIPTORS.map((descriptor) => (live.includes(descriptor.id) ? liveCapture(descriptor.id, tenantRef) : fixtureRun(descriptor.id)));
  return buildWorkloadLedger({ evidence, grants: GRANTS, runtime: RUNTIME, tenantRef, now: NOW });
}
const ALL_READS = Object.freeze(WORKLOAD_DESCRIPTORS.map((descriptor) => descriptor.id));
const OTHER_READS = Object.freeze(ALL_READS.filter((id) => !DEFENDER_EMAIL_OPERATIONS.includes(id)));

test('each read is declared, in scope, probed, Get-only and ships disabled', async () => {
  assert.ok(WORKLOADS.includes(DEFENDER_EMAIL_WORKLOAD));
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === DEFENDER_EMAIL_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [...DEFENDER_EMAIL_OPERATIONS]);
  assert.deepEqual(declared.map((descriptor) => descriptor.operation.cmdlet), FAMILY_NAMES.map((name) => FAMILIES[name].cmdlet));
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const exo = /# --- Exchange Online ---([\s\S]*?)# --- Security & Compliance/.exec(probe)[1];
  for (const descriptor of declared) {
    assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
    assert.equal(descriptor.operation.module, 'ExchangeOnlineManagement');
    assert.match(descriptor.operation.cmdlet, /^Get-/);
    assert.ok(exo.includes(`-Workload 'exo' -Name '${descriptor.operation.probeName}' -Block { ${descriptor.operation.probeName} }`), descriptor.id);
  }
  // The probe runs each Allow/Block List read with the same fixed values the reader sends.
  for (const descriptor of declared) {
    const family = FAMILY_NAMES[DEFENDER_EMAIL_OPERATIONS.indexOf(descriptor.id)];
    const flags = Object.entries(FAMILIES[family].parameters ?? {}).map(([name, value]) => ` -${name} ${value}`).join('');
    assert.equal(descriptor.operation.probeName, `${descriptor.operation.cmdlet}${flags}`, descriptor.id);
  }
  assert.equal(new Set(declared.map((descriptor) => descriptor.operation.probeName)).size, declared.length);

  const bare = buildWorkloadLedger({ grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  for (const id of DEFENDER_EMAIL_OPERATIONS) {
    const row = bare.rows.find((item) => item.id === id);
    assert.equal(row.state, 'disabled', id);
    assert.equal(row.enabled, false, id);
  }
  const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

  assert.equal(DEFENDER_EMAIL_DESCRIPTOR.enabledByDefault, false);
  assert.equal(DEFENDER_EMAIL_DESCRIPTOR.readOnly, true);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === DEFENDER_EMAIL_WORKLOAD && descriptor.enabledByDefault === false));
  assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((operation) => operation.workload === DEFENDER_EMAIL_WORKLOAD), [], 'no write exists');
  assert.ok(WORKLOAD_COLLECTORS.some((entry) => entry.workload === DEFENDER_EMAIL_WORKLOAD && entry.powershellFamily === 'exchange'));
  // The live read gate captures exactly these reads, in the Exchange Online module.
  assert.equal(READ_FAMILIES[DEFENDER_EMAIL_WORKLOAD], FAMILIES);
  assert.equal(readModule(DEFENDER_EMAIL_WORKLOAD), 'ExchangeOnlineManagement');

  // The allowlist holds Get cmdlets only, and matches the container's exactly.
  assert.ok(Object.keys(DEFENDER_EMAIL_CMDLET_PARAMETERS).every((cmdlet) => cmdlet.startsWith('Get-')));
  assert.deepEqual(Object.fromEntries(Object.entries(DEFENDER_EMAIL_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), ALLOWED,
    'the Node and container allowlists are identical');
  for (const cmdlet of ['New-TenantAllowBlockListItems', 'Remove-TenantAllowBlockListItems', 'Set-ArcConfig', 'Set-ReportSubmissionPolicy', 'Get-QuarantineMessage']) {
    assert.throws(() => assertDefenderEmailCmdlet({ cmdlet }), DefenderEmailScopeError, cmdlet);
  }
  // Only the values a family names: never a lookup by entry, never another list.
  assert.throws(() => assertDefenderEmailCmdlet({ cmdlet: 'Get-TenantAllowBlockListItems', parameters: { ListType: 'Sender', Entry: 'x' } }), /does not take Entry/);
  assert.throws(() => assertDefenderEmailCmdlet({ cmdlet: 'Get-TenantAllowBlockListItems', parameters: { ListType: 'Recipient' } }), /fixed values/);
  assert.throws(() => assertDefenderEmailCmdlet({ cmdlet: 'Get-TenantAllowBlockListItems', parameters: {} }), /fixed values/);
  assert.throws(() => assertDefenderEmailCmdlet({ cmdlet: 'Get-ArcConfig', parameters: { Identity: 'Default' } }), /does not take Identity/);
});

test('every object is one observation under the identity Exchange gives it, with declared fields only', async () => {
  const exchange = fakeExchange({
    answers: {
      // An entry whose value changes keeps its key; one with no usable Identity is not
      // guessed at; a duplicate is stored once; a credential in the notes is redacted.
      blockListSender: [
        answersFor('blockListSender')[0],
        { ...answersFor('blockListSender')[0] },
        { ...answersFor('blockListSender')[0], Identity: 'bad id; Remove-Item', Value: 'KEEL-RT-unidentified.example.com' },
      ],
      blockListUrl: [{ ...answersFor('blockListUrl')[0], Notes: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' }],
    },
  });
  const result = await readDefenderEmail({ powershell: exchange.powershell, now: () => NOW });

  // One call per family, each with exactly its fixed values.
  assert.deepEqual(exchange.calls, FAMILY_NAMES.map((name) => ({ cmdlet: FAMILIES[name].cmdlet, parameters: FAMILIES[name].parameters ?? {} })));
  assert.deepEqual(exchange.calls.filter((call) => call.cmdlet === 'Get-TenantAllowBlockListItems').map((call) => call.parameters),
    [{ ListType: 'Sender' }, { ListType: 'Url' }, { ListType: 'FileHash' }, { ListType: 'IP' }, { ListType: 'Url', ListSubType: 'AdvancedDelivery' }]);

  assert.equal(result.resources.length, FAMILY_NAMES.length);
  const sender = result.resources.find((resource) => resource.kind === 'blockListSender');
  assert.equal(sender.resourceKey, `allow-block-sender:${SAMPLE.blockListSender.Identity}`, 'the entry id is kept as Exchange wrote it, case and all');
  assert.equal(result.discovery.unidentified, 1);
  assert.equal(result.resources.find((resource) => resource.kind === 'blockListSpoof').resourceKey, `allow-block-spoof:${SAMPLE.blockListSpoof.Identity}`);
  assert.equal(result.resources.find((resource) => resource.kind === 'arcConfig').resourceKey, 'arc-config:organization');
  assert.equal(result.resources.find((resource) => resource.kind === 'reportSubmissionRule').resourceKey, `report-submission-rule:${SAMPLE.reportSubmissionRule.Guid}`);
  for (const resource of result.resources) {
    const declared = FAMILIES[resource.kind].fields;
    assert.deepEqual(Object.keys(resource.fieldCoverage).sort(), [...declared].sort(), resource.resourceKey);
    assert.ok(Object.keys(resource.fields).every((field) => declared.includes(field)), resource.resourceKey);
  }
  const stored = JSON.stringify(result.resources);
  for (const dropped of ['DistinguishedName', 'OrganizationId', 'LastUsedDate', 'abcdefghijklmnopqrstuvwxyz']) assert.ok(!stored.includes(dropped), dropped);
  assert.equal(result.resources.find((resource) => resource.kind === 'blockListUrl').fieldCoverage.Notes.status, 'redacted');
  assert.equal(result.outcome, 'partial', 'an unidentified entry and a redacted value are gaps');

  const clean = await readDefenderEmail({ powershell: fakeExchange().powershell, now: () => NOW });
  assert.equal(clean.outcome, 'complete');
  assert.ok(Object.values(clean.discovery.families).every((family) => family.status === 'read' && family.objects === 1));
  assert.deepEqual(clean.unknownFields, {});

  // Empty lists are a normal tenant: the run is complete-empty, not a gap.
  const empty = Object.fromEntries(FAMILY_NAMES.map((name) => [name, []]));
  assert.equal((await readDefenderEmail({ powershell: fakeExchange({ answers: empty }).powershell, now: () => NOW })).outcome, 'complete-empty');
});

test('a Defender read that is not available is labelled and is a gap; other failures are structured', async () => {
  assert.deepEqual([...LICENSED_FAMILIES], ['builtInProtectionRule', 'teamsProtectionPolicy', 'teamsProtectionRule']);
  const notFound = Object.fromEntries(LICENSED_FAMILIES.map((family) => [family, { error: NOT_FOUND(FAMILIES[family].cmdlet) }]));
  const result = await readDefenderEmail({ powershell: fakeExchange({ answers: notFound }).powershell, now: () => NOW });
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.unavailable.map((item) => [item.family, item.status]), LICENSED_FAMILIES.map((family) => [family, 'not-licensed']));
  assert.match(result.unavailable[0].reason, /Microsoft Defender for Office 365 is not licensed/);

  // A core cmdlet that is not found is a failure, not a licence question.
  const missingCore = await readDefenderEmail({ powershell: fakeExchange({ answers: { arcConfig: { error: NOT_FOUND('Get-ArcConfig') } } }).powershell });
  assert.deepEqual(missingCore.failures.map((failure) => [failure.family, failure.status, failure.error.errorId]), [['arcConfig', 'failed', 'CommandNotFoundException']]);

  const mixed = await readDefenderEmail({
    powershell: fakeExchange({
      answers: {
        blockListSpoof: { error: { message: "The user isn't assigned to any management roles. Access denied.", category: 'PermissionDenied', errorId: 'AccessDenied' } },
        reportSubmissionPolicy: 'crash',
      },
    }).powershell,
  });
  assert.equal(mixed.outcome, 'partial');
  assert.deepEqual(mixed.failures.map((failure) => [failure.family, failure.status, failure.error.code]), [['blockListSpoof', 'denied', 'CMDLET_ERROR'], ['reportSubmissionPolicy', 'failed', 'NONZERO_EXIT']]);

  const everything = Object.fromEntries(FAMILY_NAMES.map((name) => [name, 'crash']));
  assert.equal((await readDefenderEmail({ powershell: fakeExchange({ answers: everything }).powershell })).outcome, 'failed');
});

test('collection stays off until Exchange and every core read are qualified; Defender reads need their own proof', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const exchange = fakeExchange();

  for (const ledger of [ledgerWith(tenantRef, OTHER_READS), ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)))]) {
    const disabled = await collectDefenderEmail(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => NOW });
    assert.equal(disabled.run.outcome, 'disabled');
    assert.equal(disabled.result, null);
  }
  assert.deepEqual(exchange.calls, [], 'nothing is sent while disabled');
  assert.match(defenderEmailActivation(ledgerWith(tenantRef, OTHER_READS)).reasons.join('; '), /defender-email-protection\.allow-block-senders is fixture-tested/);
  assert.match(defenderEmailActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)))).reasons[0], /Exchange is not qualified yet/);
  assert.equal(defenderEmailActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => id !== 'defender-email-protection.arc-trusted-sealers'))).enabled, false);

  // Core reads live, Defender reads not: enabled, Defender families skipped, run partial.
  const core = ledgerWith(tenantRef, [...OTHER_READS, ...CORE_OPERATIONS]);
  const activation = defenderEmailActivation(core);
  assert.equal(activation.enabled, true);
  assert.deepEqual(activation.skipped.map((item) => item.family), [...LICENSED_FAMILIES]);
  const partial = await collectDefenderEmail(client, { tenantRef, ledger: core, powershell: exchange.powershell, now: () => NOW });
  assert.equal(partial.run.outcome, 'partial');
  const defenderCmdlets = LICENSED_FAMILIES.map((family) => FAMILIES[family].cmdlet);
  assert.ok(!exchange.calls.some((call) => defenderCmdlets.includes(call.cmdlet)), 'an unqualified Defender read is never sent');

  // Everything live: complete, one stored observation per object.
  exchange.calls.length = 0;
  const full = await collectDefenderEmail(client, { tenantRef, ledger: ledgerWith(tenantRef, ALL_READS), powershell: exchange.powershell, now: () => NOW });
  assert.equal(full.run.outcome, 'complete');
  assert.equal(exchange.calls.length, FAMILY_NAMES.length);
  const { rows } = await client.query('SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1', [full.run.id]);
  assert.equal(rows.length, FAMILY_NAMES.length);
  const sender = rows.find((row) => row.resource_key === `allow-block-sender:${SAMPLE.blockListSender.Identity}`);
  assert.equal(sender.fields.kind, 'blockListSender');
  assert.equal(sender.fields.Value, 'KEEL-RT-allow-block-sender.example.com');
  assert.equal(sender.fields.DistinguishedName, undefined);
  assert.equal(sender.field_coverage.Action.status, 'observed');
});

test('listed under Defender with the threat policies; an entry is named by its value, never its id', () => {
  const info = typeInfo(DEFENDER_EMAIL_WORKLOAD);
  assert.deepEqual([info.service, info.categoryName, info.known, info.priority], ['Defender', 'Threat policies and rules', true, 'high']);
  // Before the custom detection rules, inside the same group.
  assert.ok(info.typeRank < typeInfo('defenderDetectionRule').typeRank);
  assert.equal(serviceObjectName(`allow-block-sender:${entryId(1)}`, { Value: 'KEEL-RT-sender@example.com', Action: 'Block' }), 'KEEL-RT-sender@example.com');
  assert.equal(serviceObjectName(`allow-block-spoof:${guid(1)}`, { SpoofedUser: 'KEEL-RT-spoof.example.com' }), 'KEEL-RT-spoof.example.com');
  assert.equal(serviceObjectName(`report-submission-rule:${guid(2)}`, { Name: 'DefaultReportSubmissionRule' }), 'DefaultReportSubmissionRule');
});
