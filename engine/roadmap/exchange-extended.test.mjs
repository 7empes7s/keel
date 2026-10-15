// READ-EXO: the Exchange and Defender settings mail flow does not read, read-only.
//
// Acceptance:
//  - each read is declared in workloadContract.mjs, passes the scope validator, is run
//    by the read-only probe, and ships disabled (fixture proof never enables it);
//  - only Get cmdlets run, the Node and container allowlists match, no write exists;
//  - each object is one observation under its Guid, with declared fields only;
//  - a Defender read that is not available is labelled not-licensed and is a gap;
//  - collection stays off until Exchange and every core read are qualified.
// Mutation checks:
//  - key objects by name instead of Guid (the rename test fails);
//  - drop the global quarantine parameter (the call list test fails);
//  - run a Defender read whose own row is not enabled (the activation test fails).
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays the ops/powershell/run-cmdlet.ps1 contract through the real
// engine/powershell/jobQueue.mjs spawn path. No tenant is touched.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  CORE_OPERATIONS, EXCHANGE_EXTENDED_CMDLET_PARAMETERS, EXCHANGE_EXTENDED_DESCRIPTOR, EXCHANGE_EXTENDED_OPERATIONS, EXCHANGE_EXTENDED_WORKLOAD,
  ExchangeExtendedScopeError, FAMILIES, FAMILY_NAMES, LICENSED_FAMILIES, assertExchangeExtendedCmdlet, collectExchangeExtended,
  exchangeExtendedActivation, objectIdentity, readExchangeExtended,
} from '../collect/workloads/exchangeExtended.mjs';
import { EXCHANGE_OPERATIONS } from '../collect/workloads/exchange.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { WKLD_WRITE_OPERATIONS } from '../restore/workloads/writeDeclarations.mjs';
import { planWaves } from '../restore/wavePlanner.mjs';
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

const NOW = new Date('2026-10-14T12:00:00Z');
const EXO_VERSION = '3.5.0';
let tenantSeq = 0;
const nextTenant = () => `sha256:read-exo-${tenantSeq += 1}`;
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-00000000e0e0`;

// One object per family, as Exchange answers it: every declared field, plus the
// internal properties a careless reader would keep.
const SAMPLE = Object.freeze(Object.fromEntries(FAMILY_NAMES.map((family, index) => {
  const { cmdlet, fields, prefix } = FAMILIES[family];
  const body = Object.fromEntries(fields.map((field) => [field, field === 'WhenChangedUTC' ? '2026-10-01T00:00:00Z' : true]));
  return [family, { ...body, Name: `KEEL-RT-${prefix}`, Guid: guid(index + 1), DistinguishedName: 'CN=internal', OrganizationId: 'internal', cmdlet }];
})));
const answersFor = (family) => { const { cmdlet, ...body } = SAMPLE[family]; return [body]; };

// The allowlist the container enforces, parsed from the script it ships.
function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z0-9-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const ALLOWED = containerAllowlist('AllowedExchangeExtended');
const NOT_FOUND = (cmdlet) => ({ message: `The term '${cmdlet}' is not recognized as a name of a cmdlet, function, script file, or executable program.`, category: 'ObjectNotFound', errorId: 'CommandNotFoundException' });

/**
 * A fake Exchange Online behind the real jobQueue spawn path, playing run-cmdlet.ps1.
 * `answers[family]` overrides the sample: a list is the output, `{ error }` an error
 * envelope, 'crash' a non-zero exit with no envelope.
 */
function fakeExchange({ answers = {} } = {}) {
  const calls = [];
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  const familyOf = (job) => FAMILY_NAMES.find((name) => FAMILIES[name].cmdlet === job.cmdlet
    && JSON.stringify(FAMILIES[name].parameters ?? {}) === JSON.stringify(job.parameters ?? {}));
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

// ---------------------------------------------------------------- ledgers

const liveCapture = (operationId, tenantRef) => {
  const descriptor = WORKLOAD_DESCRIPTORS.find((item) => item.id === operationId);
  const version = descriptor.operation.kind === 'graph' ? descriptor.operation.version : descriptor.operation.module === 'PnP.PowerShell' ? '3.4.1' : EXO_VERSION;
  return { operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-13T00:00:00Z', version, ok: true, proofRef: `${operationId}@sha256:x` };
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
const OTHER_READS = Object.freeze(ALL_READS.filter((id) => !EXCHANGE_EXTENDED_OPERATIONS.includes(id)));

// ---------------------------------------------------------------- tests

test('each read is declared, in scope, probed, Get-only and ships disabled', async () => {
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === EXCHANGE_EXTENDED_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [...EXCHANGE_EXTENDED_OPERATIONS]);
  assert.deepEqual(declared.map((descriptor) => descriptor.operation.cmdlet), FAMILY_NAMES.map((name) => FAMILIES[name].cmdlet));
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const exo = /# --- Exchange Online ---([\s\S]*?)# --- Security & Compliance/.exec(probe)[1];
  for (const descriptor of declared) {
    assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
    assert.equal(descriptor.operation.module, 'ExchangeOnlineManagement');
    assert.match(descriptor.operation.cmdlet, /^Get-/);
    assert.match(descriptor.source.url, /^https:\/\/learn\.microsoft\.com\/en-us\/powershell\/module\/exchange\/get-/);
    assert.ok(exo.includes(`-Workload 'exo' -Name '${descriptor.operation.probeName}' -Block { ${descriptor.operation.probeName} }`), descriptor.id);
  }
  // The two quarantine reads are told apart by the probe.
  assert.equal(new Set(declared.map((descriptor) => descriptor.operation.probeName)).size, declared.length);

  const bare = buildWorkloadLedger({ grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  for (const id of EXCHANGE_EXTENDED_OPERATIONS) {
    const row = bare.rows.find((item) => item.id === id);
    assert.equal(row.state, 'disabled', id);
    assert.equal(row.enabled, false, id);
  }
  const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

  assert.equal(EXCHANGE_EXTENDED_DESCRIPTOR.enabledByDefault, false);
  assert.equal(EXCHANGE_EXTENDED_DESCRIPTOR.readOnly, true);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === EXCHANGE_EXTENDED_WORKLOAD && descriptor.enabledByDefault === false));
  // Wave 2 WKLD: the only writes for this workload are its declared cmdlet writes, and
  // each needs observed grants and a live write capture before it runs.
  const writes = Object.entries(WORKLOAD_WRITE_OPERATIONS).filter(([, operation]) => operation.workload === EXCHANGE_EXTENDED_WORKLOAD);
  assert.ok(writes.length > 0);
  for (const [id, operation] of writes) {
    assert.equal(operation, WKLD_WRITE_OPERATIONS[id], id);
    assert.equal(operation.kind, 'cmdlet', id);
    assert.equal(operation.grantsRequired, true, id);
  }
  assert.ok(WORKLOAD_COLLECTORS.some((entry) => entry.workload === EXCHANGE_EXTENDED_WORKLOAD && entry.powershellFamily === 'exchange'));

  // The allowlist holds Get cmdlets only, and matches the container's exactly.
  assert.ok(Object.keys(EXCHANGE_EXTENDED_CMDLET_PARAMETERS).every((cmdlet) => cmdlet.startsWith('Get-')));
  assert.deepEqual(Object.fromEntries(Object.entries(EXCHANGE_EXTENDED_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), ALLOWED,
    'the Node and container allowlists are identical');
  for (const cmdlet of ['Set-JournalRule', 'New-AddressList', 'Remove-RetentionPolicyTag', 'Get-QuarantineMessage', 'Get-MessageTrace', 'Get-MobileDevice']) {
    assert.throws(() => assertExchangeExtendedCmdlet({ cmdlet }), ExchangeExtendedScopeError, cmdlet);
  }
  assert.throws(() => assertExchangeExtendedCmdlet({ cmdlet: 'Get-JournalRule', parameters: { Identity: 'x' } }), /does not take Identity/);
});

test('every object is one observation under its Guid, with declared fields only', async () => {
  const exchange = fakeExchange({
    answers: {
      // A rule renamed between runs keeps its key; one with no Guid is not guessed at;
      // a duplicate is stored once; a credential typed into a free-text field is redacted.
      journalRule: [
        { ...answersFor('journalRule')[0], Name: 'KEEL-RT-journal (renamed)' },
        answersFor('journalRule')[0],
        { ...answersFor('journalRule')[0], Guid: 'not-a-guid', Name: 'KEEL-RT-unidentified' },
      ],
      retentionPolicyTag: [{ ...answersFor('retentionPolicyTag')[0], Comment: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' }],
    },
  });
  const result = await readExchangeExtended({ powershell: exchange.powershell, now: () => NOW });

  // One call per family; only the global quarantine read takes its fixed parameter.
  assert.deepEqual(exchange.calls.map((call) => call.cmdlet), FAMILY_NAMES.map((name) => FAMILIES[name].cmdlet));
  assert.deepEqual(exchange.calls.filter((call) => Object.keys(call.parameters).length > 0),
    [{ cmdlet: 'Get-QuarantinePolicy', parameters: { QuarantinePolicyType: 'GlobalQuarantinePolicy' } }]);

  assert.equal(result.resources.length, FAMILY_NAMES.length);
  const journal = result.resources.find((resource) => resource.kind === 'journalRule');
  assert.equal(journal.resourceKey, `journal-rule:${SAMPLE.journalRule.Guid}`);
  assert.equal(journal.fields.Name, 'KEEL-RT-journal (renamed)', 'the first answer for a Guid is kept; a rename does not change the key');
  assert.equal(result.discovery.unidentified, 1);
  for (const resource of result.resources) {
    const declared = FAMILIES[resource.kind].fields;
    assert.deepEqual(Object.keys(resource.fieldCoverage).sort(), [...declared].sort(), resource.resourceKey);
    assert.ok(Object.keys(resource.fields).every((field) => declared.includes(field)), resource.resourceKey);
  }
  const stored = JSON.stringify(result.resources);
  for (const dropped of ['DistinguishedName', 'OrganizationId', 'abcdefghijklmnopqrstuvwxyz']) assert.ok(!stored.includes(dropped), dropped);
  const tag = result.resources.find((resource) => resource.kind === 'retentionPolicyTag');
  assert.equal(tag.fieldCoverage.Comment.status, 'redacted');
  assert.equal(result.outcome, 'partial', 'an unidentified object and a redacted value are gaps');

  assert.equal(objectIdentity({ Guid: guid(1).toUpperCase() }), guid(1));
  assert.equal(objectIdentity({ Name: 'KEEL-RT-no-guid' }), null);

  const clean = await readExchangeExtended({ powershell: fakeExchange().powershell, now: () => NOW });
  assert.equal(clean.outcome, 'complete');
  assert.ok(Object.values(clean.discovery.families).every((family) => family.status === 'read' && family.objects === 1));
});

test('a Defender read that is not available is labelled and is a gap; other failures are structured', async () => {
  const notFound = Object.fromEntries(LICENSED_FAMILIES.map((family) => [family, { error: NOT_FOUND(FAMILIES[family].cmdlet) }]));
  const result = await readExchangeExtended({ powershell: fakeExchange({ answers: notFound }).powershell, now: () => NOW });
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.unavailable.map((item) => [item.family, item.status]), LICENSED_FAMILIES.map((family) => [family, 'not-licensed']));
  assert.match(result.unavailable[0].reason, /Microsoft Defender for Office 365 is not licensed/);

  // A core cmdlet that is not found is a failure, not a licence question.
  const missingCore = await readExchangeExtended({ powershell: fakeExchange({ answers: { journalRule: { error: NOT_FOUND('Get-JournalRule') } } }).powershell });
  assert.deepEqual(missingCore.failures.map((failure) => [failure.family, failure.status, failure.error.errorId]), [['journalRule', 'failed', 'CommandNotFoundException']]);

  // Denied, crashed and empty answers. The global address list needs the Address Lists role.
  const mixed = await readExchangeExtended({
    powershell: fakeExchange({
      answers: {
        globalAddressList: { error: { message: "The user isn't assigned to any management roles. Access denied.", category: 'PermissionDenied', errorId: 'AccessDenied' } },
        addressBookPolicy: 'crash',
        deviceAccessRule: [],
      },
    }).powershell,
  });
  assert.equal(mixed.outcome, 'partial');
  assert.deepEqual(mixed.failures.map((failure) => [failure.family, failure.status, failure.error.code]), [['globalAddressList', 'denied', 'CMDLET_ERROR'], ['addressBookPolicy', 'failed', 'NONZERO_EXIT']]);
  assert.deepEqual(mixed.discovery.families.deviceAccessRule, { status: 'read', objects: 0 });

  const everything = Object.fromEntries(FAMILY_NAMES.map((name) => [name, 'crash']));
  assert.equal((await readExchangeExtended({ powershell: fakeExchange({ answers: everything }).powershell })).outcome, 'failed');
});

test('collection stays off until Exchange and every core read are qualified; Defender reads need their own proof', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const exchange = fakeExchange();

  for (const ledger of [ledgerWith(tenantRef, OTHER_READS), ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)))]) {
    const disabled = await collectExchangeExtended(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => NOW });
    assert.equal(disabled.run.outcome, 'disabled');
    assert.equal(disabled.result, null);
  }
  assert.deepEqual(exchange.calls, [], 'nothing is sent while disabled');
  assert.match(exchangeExtendedActivation(ledgerWith(tenantRef, OTHER_READS)).reasons.join('; '), /exchange-extended\.journal-rules is fixture-tested/);
  assert.match(exchangeExtendedActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)))).reasons[0], /Exchange is not qualified yet/);
  assert.equal(exchangeExtendedActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => id !== 'exchange-extended.retention-policy-tags'))).enabled, false);

  // Core reads live, Defender reads not: enabled, Defender families skipped, run partial.
  const core = ledgerWith(tenantRef, [...OTHER_READS, ...CORE_OPERATIONS]);
  const activation = exchangeExtendedActivation(core);
  assert.equal(activation.enabled, true);
  assert.deepEqual(activation.skipped.map((item) => item.family), [...LICENSED_FAMILIES]);
  const partial = await collectExchangeExtended(client, { tenantRef, ledger: core, powershell: exchange.powershell, now: () => NOW });
  assert.equal(partial.run.outcome, 'partial');
  const defenderCmdlets = LICENSED_FAMILIES.map((family) => FAMILIES[family].cmdlet);
  assert.ok(!exchange.calls.some((call) => defenderCmdlets.includes(call.cmdlet)), 'an unqualified Defender read is never sent');

  // Everything live: complete, one stored observation per object.
  exchange.calls.length = 0;
  const full = await collectExchangeExtended(client, { tenantRef, ledger: ledgerWith(tenantRef, ALL_READS), powershell: exchange.powershell, now: () => NOW });
  assert.equal(full.run.outcome, 'complete');
  assert.equal(exchange.calls.length, FAMILY_NAMES.length);
  const { rows } = await client.query('SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1', [full.run.id]);
  assert.equal(rows.length, FAMILY_NAMES.length);
  const journal = rows.find((row) => row.resource_key === `journal-rule:${SAMPLE.journalRule.Guid}`);
  assert.equal(journal.fields.kind, 'journalRule');
  assert.equal(journal.fields.Name, 'KEEL-RT-journal-rule');
  assert.equal(journal.fields.DistinguishedName, undefined);
  assert.equal(journal.field_coverage.JournalEmailAddress.status, 'observed');

  const report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [], now: NOW });
  assert.equal(report.workloads.find((item) => item.workload === EXCHANGE_EXTENDED_WORKLOAD).status, 'complete');
  assert.throws(() => planWaves([{ naturalKey: 'x', resourceType: 'exchangeExtended', verb: 'update', payload: {} }]), /workload restore path/);
});
