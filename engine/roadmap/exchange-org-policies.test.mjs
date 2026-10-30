// Exchange organisation policies (sharing and client access; transport and new mailbox
// defaults), read-only.
//
// Acceptance:
//  - every read is declared in workloadContract.mjs, passes the scope validator, is run by
//    the read-only probe, and ships disabled (fixture proof never enables it);
//  - only the Get cmdlets run, with no parameters, the Node and container allowlists
//    match, no write exists;
//  - each policy is one observation under its Guid, the organisation-wide settings under
//    `organization`, and an application access policy under its Identity; declared fields only;
//  - collection stays off until Exchange and the workload's reads are qualified, and
//    turning it on needs nothing from the other Exchange cmdlet workloads;
//  - SMTP AUTH turned back on between two reads is a change on the Changes page;
//  - the read capture tool can qualify both workloads although they have no writes;
//  - access sits in Exchange's "Sharing and client access" group, defaults in
//    "Organization settings", each in the portal's order.
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays the ops/powershell/run-cmdlet.ps1 contract through the real
// engine/powershell/jobQueue.mjs spawn path. No tenant is touched.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  ACCESS_FAMILIES, DEFAULTS_FAMILIES, EXCHANGE_ORG_ACCESS_WORKLOAD, EXCHANGE_ORG_DEFAULTS_WORKLOAD, EXCHANGE_ORG_POLICIES_CMDLET_PARAMETERS,
  ExchangeOrgPoliciesScopeError, ORG_ACCESS, ORG_DEFAULTS, collectExchangeOrgDefaults, exchangeOrgAccessActivation, exchangeOrgDefaultsActivation,
  readExchangeOrgAccess, readExchangeOrgDefaults,
} from '../collect/workloads/exchangeOrgPolicies.mjs';
import { EXCHANGE_OPERATIONS } from '../collect/workloads/exchange.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { detectWorkloadDrift } from '../govern/workloadDrift.mjs';
import { compareInService, typeInfo } from '../insights/taxonomy.mjs';
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

const NOW = new Date('2026-10-30T12:00:00Z');
const EXO_VERSION = '3.5.0';
let tenantSeq = 0;
const nextTenant = () => `sha256:org-policies-${tenantSeq += 1}`;
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-00000000b0b0`;
const WHEN = '2026-10-01T00:00:00Z';
// Internal properties a careless reader would keep.
const INTERNAL = Object.freeze({ DistinguishedName: 'CN=internal', OrganizationId: 'internal', ObjectState: 'Unchanged' });

/** An answer with every declared field of `spec` set, then `over`. */
function answer(spec, over = {}) {
  const body = { ...INTERNAL };
  for (const field of spec.fields) body[field] = field === 'WhenChangedUTC' ? WHEN : `${field}-value`;
  return { ...body, ...over };
}

// What each cmdlet answers in a healthy tenant.
function healthyTenant() {
  const output = {};
  for (const [name, spec] of Object.entries({ ...ACCESS_FAMILIES, ...DEFAULTS_FAMILIES })) {
    const index = Object.keys({ ...ACCESS_FAMILIES, ...DEFAULTS_FAMILIES }).indexOf(name) + 1;
    output[spec.cmdlet] = [answer(spec, { Guid: guid(index), Name: `KEEL-RT-${name}` })];
  }
  output['Get-ApplicationAccessPolicy'] = [answer(ACCESS_FAMILIES.applicationAccessPolicy, {
    Identity: `${guid(90)}\\${guid(91)}:S-1-5-21-1;${guid(92)}`, AccessRight: 'RestrictAccess',
  })];
  output['Get-ExternalInOutlook'] = [answer(ACCESS_FAMILIES.externalInOutlook, { Identity: guid(93), Enabled: true, AllowList: [] })];
  output['Get-TransportConfig'] = [answer(DEFAULTS_FAMILIES.transportConfig, { SmtpClientAuthenticationDisabled: true })];
  return output;
}

function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z0-9-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const ALLOWED = containerAllowlist('AllowedExchangeOrgPolicies');

/** A fake Exchange Online behind the real jobQueue spawn path. `state.output[cmdlet]` is its answer. */
function fakeExchange(state = { output: healthyTenant(), errors: {} }) {
  const calls = [];
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  function run(job) {
    if (job.mode !== 'cmdlet' || job.module !== 'ExchangeOnlineManagement' || !ALLOWED[job.cmdlet]) {
      return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, category: null, errorId: 'CmdletNotAllowed' } }, 1);
    }
    calls.push({ cmdlet: job.cmdlet, parameters: job.parameters ?? {} });
    if (state.errors?.[job.cmdlet]) return envelope({ ok: false, error: state.errors[job.cmdlet] }, 1);
    return envelope({ ok: true, output: structuredClone(state.output[job.cmdlet] ?? []) });
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
  return { calls, state, powershell: { spawnFn, timeoutMs: 200, tenantConfigPath: '/etc/keel/tenant.json' } };
}

const liveCapture = (operationId, tenantRef) => {
  const descriptor = WORKLOAD_DESCRIPTORS.find((item) => item.id === operationId);
  const version = descriptor.operation.kind === 'graph' ? descriptor.operation.version : descriptor.operation.module === 'PnP.PowerShell' ? '3.4.1' : EXO_VERSION;
  return { operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-29T00:00:00Z', version, ok: true, proofRef: `${operationId}@sha256:x` };
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
const WORKLOADS = [ORG_ACCESS, ORG_DEFAULTS];

test('every read is declared, in scope, probed, Get-only and ships disabled', async () => {
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const exo = /# --- Exchange Online ---([\s\S]*?)# --- Security & Compliance/.exec(probe)[1];
  const bare = buildWorkloadLedger({ grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  for (const workload of WORKLOADS) {
    const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === workload.workload);
    assert.deepEqual(declared.map((descriptor) => descriptor.id), [...workload.operations]);
    assert.deepEqual(declared.map((descriptor) => descriptor.operation.cmdlet), workload.familyNames.map((name) => workload.families[name].cmdlet));
    for (const descriptor of declared) {
      assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
      assert.equal(descriptor.operation.module, 'ExchangeOnlineManagement');
      assert.deepEqual(descriptor.operation.parameters, []);
      assert.deepEqual(descriptor.rbac.roles, ['Exchange Administrator']);
      const name = descriptor.operation.cmdlet;
      assert.ok(exo.includes(`-Workload 'exo' -Name '${name}' -Block { ${name} }`), `${name} is probed`);
      assert.equal(bare.rows.find((row) => row.id === descriptor.id).enabled, false);
    }
    const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
    assert.ok(results.every((result) => result.ok), JSON.stringify(results));
    const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
    assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

    assert.equal(workload.descriptor.enabledByDefault, false);
    assert.equal(workload.descriptor.readOnly, true);
    assert.ok(listWorkloads().some((descriptor) => descriptor.workload === workload.workload));
    assert.ok(WORKLOAD_COLLECTORS.some((entry) => entry.workload === workload.workload && entry.powershellFamily === 'exchange'));
    assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((operation) => operation.workload === workload.workload), [], 'no writer');
    // The read capture tool qualifies it, in the Exchange module, though it has no writes.
    assert.equal(readModule(workload.workload), 'ExchangeOnlineManagement');
    assert.deepEqual(workloadReads(workload.workload).map((read) => read.operationId), [...workload.operations]);
  }

  assert.deepEqual(Object.fromEntries(Object.entries(EXCHANGE_ORG_POLICIES_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), ALLOWED,
    'the Node and container allowlists are identical');
  for (const cmdlet of ['Set-TransportConfig', 'New-SharingPolicy', 'Set-OwaMailboxPolicy', 'Remove-ApplicationAccessPolicy', 'Set-ExternalInOutlook', 'Get-Mailbox']) {
    assert.throws(() => ORG_ACCESS.assertCmdlet({ cmdlet }), ExchangeOrgPoliciesScopeError, cmdlet);
    assert.throws(() => ORG_DEFAULTS.assertCmdlet({ cmdlet }), ExchangeOrgPoliciesScopeError, cmdlet);
  }
  assert.throws(() => ORG_ACCESS.assertCmdlet({ cmdlet: 'Get-SharingPolicy', parameters: { Identity: 'x' } }), /does not take Identity/);
  // Each workload runs only its own cmdlets.
  assert.throws(() => ORG_ACCESS.assertCmdlet({ cmdlet: 'Get-TransportConfig' }), ExchangeOrgPoliciesScopeError);
});

test('access sits in Sharing and client access, defaults in Organization settings, in the portal order', () => {
  const access = typeInfo(EXCHANGE_ORG_ACCESS_WORKLOAD);
  assert.equal(access.known, true);
  assert.equal(access.service, 'Exchange');
  assert.equal(access.categoryName, 'Sharing and client access');
  assert.equal(access.priority, 'high');
  const defaults = typeInfo(EXCHANGE_ORG_DEFAULTS_WORKLOAD);
  assert.equal(defaults.categoryName, 'Organization settings');
  assert.equal(defaults.priority, 'high');
  const order = [EXCHANGE_ORG_DEFAULTS_WORKLOAD, 'exchange-extended', EXCHANGE_ORG_ACCESS_WORKLOAD, 'exchange-mail-flow', 'exchange-recipients'].sort(compareInService);
  assert.deepEqual(order, ['exchange-recipients', 'exchange-mail-flow', EXCHANGE_ORG_ACCESS_WORKLOAD, 'exchange-extended', EXCHANGE_ORG_DEFAULTS_WORKLOAD]);
});

test('each policy is one observation under its identity, with declared fields only', async () => {
  const exchange = fakeExchange();
  const access = await readExchangeOrgAccess({ powershell: exchange.powershell, now: () => NOW });
  assert.deepEqual(exchange.calls.map((call) => call.cmdlet), Object.values(ACCESS_FAMILIES).map((spec) => spec.cmdlet));
  assert.ok(exchange.calls.every((call) => Object.keys(call.parameters).length === 0));
  assert.equal(access.outcome, 'complete', JSON.stringify(access.discovery));
  assert.deepEqual(access.resources.map((resource) => resource.resourceKey), [
    `authentication-policy:${guid(1)}`, `sharing-policy:${guid(2)}`, `organization-relationship:${guid(3)}`,
    `intra-organization-connector:${guid(4)}`, `owa-mailbox-policy:${guid(5)}`, `role-assignment-policy:${guid(6)}`,
    `application-access-policy:${guid(90)}\\${guid(91)}:s-1-5-21-1;${guid(92)}`, 'external-in-outlook:organization',
  ]);
  const owa = access.resources.find((resource) => resource.kind === 'owaMailboxPolicy');
  assert.deepEqual(Object.keys(owa.fields), [...ACCESS_FAMILIES.owaMailboxPolicy.fields]);
  assert.equal(owa.fields.DistinguishedName, undefined);

  const defaults = await readExchangeOrgDefaults({ powershell: exchange.powershell, now: () => NOW });
  assert.equal(defaults.outcome, 'complete');
  assert.deepEqual(defaults.resources.map((resource) => resource.resourceKey), [
    'transport-config:organization', `email-address-policy:${guid(10)}`, `cas-mailbox-plan:${guid(11)}`, `mailbox-plan:${guid(12)}`,
  ]);

  // A tenant with no hybrid, no relationship and no app policy is complete; one that
  // answers no Outlook on the web policy, or a field it should carry, is a gap.
  const quiet = healthyTenant();
  for (const cmdlet of ['Get-OrganizationRelationship', 'Get-IntraOrganizationConnector', 'Get-ApplicationAccessPolicy']) quiet[cmdlet] = [];
  assert.equal((await readExchangeOrgAccess({ powershell: fakeExchange({ output: quiet }).powershell })).outcome, 'complete');
  assert.equal((await readExchangeOrgAccess({ powershell: fakeExchange({ output: { ...quiet, 'Get-OwaMailboxPolicy': [] } }).powershell })).outcome, 'partial');
  const missingField = healthyTenant();
  delete missingField['Get-TransportConfig'][0].SmtpClientAuthenticationDisabled;
  const partial = await readExchangeOrgDefaults({ powershell: fakeExchange({ output: missingField }).powershell });
  assert.equal(partial.outcome, 'partial');
  assert.deepEqual(partial.unknownFields, { transportConfig: { SmtpClientAuthenticationDisabled: 1 } });

  // A denied read is a failure, never an empty list.
  const denied = await readExchangeOrgAccess({
    powershell: fakeExchange({ output: healthyTenant(), errors: { 'Get-ApplicationAccessPolicy': { message: 'Access is denied', category: 'PermissionDenied', errorId: 'x' } } }).powershell,
  });
  assert.equal(denied.outcome, 'partial');
  assert.deepEqual(denied.failures.map((failure) => [failure.family, failure.status]), [['applicationAccessPolicy', 'denied']]);
});

test('collection stays off until Exchange and the reads are qualified, then SMTP AUTH turned on is a change', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const exchange = fakeExchange();
  const mine = [...ORG_ACCESS.operations, ...ORG_DEFAULTS.operations];
  const others = ALL_READS.filter((id) => !mine.includes(id));
  for (const ledger of [ledgerWith(tenantRef, others), ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)))]) {
    const disabled = await collectExchangeOrgDefaults(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => NOW });
    assert.equal(disabled.run.outcome, 'disabled');
  }
  assert.deepEqual(exchange.calls, [], 'nothing is sent while disabled');
  assert.match(exchangeOrgAccessActivation(ledgerWith(tenantRef, others)).reasons.join('; '), /exchange-org-access\.sharing-policies is fixture-tested/);
  // One unqualified read keeps its whole workload off, and only its own.
  const oneMissing = ledgerWith(tenantRef, ALL_READS.filter((id) => id !== 'exchange-org-access.external-in-outlook'));
  assert.equal(exchangeOrgAccessActivation(oneMissing).enabled, false);
  assert.equal(exchangeOrgDefaultsActivation(oneMissing).enabled, true);
  // Exchange (and what it follows) is needed beside these reads, not the other Exchange cmdlet workloads.
  const otherExchange = ALL_READS.filter((id) => /^(mailflow|exchange-extended|exchange-role-groups|exchange-recipients|exchange-distribution-groups)\./.test(id));
  assert.ok(otherExchange.length > 20);
  assert.equal(exchangeOrgDefaultsActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => !otherExchange.includes(id)))).enabled, true);

  const ledger = ledgerWith(tenantRef, ALL_READS);
  const first = await collectExchangeOrgDefaults(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => new Date('2026-10-29T02:00:00Z') });
  assert.equal(first.run.outcome, 'complete');
  const { rows } = await client.query('SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [first.run.id]);
  assert.deepEqual(rows.map((row) => [row.resource_key, row.fields.kind]), [
    [`cas-mailbox-plan:${guid(11)}`, 'casMailboxPlan'],
    [`email-address-policy:${guid(10)}`, 'emailAddressPolicy'],
    [`mailbox-plan:${guid(12)}`, 'mailboxPlan'],
    ['transport-config:organization', 'transportConfig'],
  ]);

  exchange.state.output['Get-TransportConfig'][0].SmtpClientAuthenticationDisabled = false;
  const second = await collectExchangeOrgDefaults(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => new Date('2026-10-30T02:00:00Z') });
  const drift = await detectWorkloadDrift(client, { collectionId: second.run.id });
  assert.equal(drift.status, 'detected');
  const { rows: changes } = await client.query('SELECT resource_key, change_type, fields FROM workload_drift WHERE tenant_ref = $1', [tenantRef]);
  assert.deepEqual(changes.map((row) => [row.resource_key, row.change_type]), [['transport-config:organization', 'modified']]);
  assert.deepEqual(changes[0].fields.map((field) => field.path), ['SmtpClientAuthenticationDisabled']);
});
