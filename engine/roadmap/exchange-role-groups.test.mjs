// Exchange admin role groups (Get-RoleGroup), read-only.
//
// Acceptance:
//  - the read is declared in workloadContract.mjs, passes the scope validator, is run by
//    the read-only probe, and ships disabled (fixture proof never enables it);
//  - only Get-RoleGroup runs, the Node and container allowlists match, no write exists;
//  - each group is one observation under its Guid, with declared fields only;
//  - collection stays off until Exchange and this read are qualified, and turning it on
//    never needs anything from the other Exchange workloads beyond Exchange itself;
//  - a member added between two reads is a change on the Changes page (workload drift);
//  - the read capture tool can qualify it although it has no writes;
//  - it sits in Exchange's "Admin roles" group, before the roles and assignments.
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays the ops/powershell/run-cmdlet.ps1 contract through the real
// engine/powershell/jobQueue.mjs spawn path. No tenant is touched.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  EXCHANGE_ROLE_GROUPS_CMDLET_PARAMETERS, EXCHANGE_ROLE_GROUPS_DESCRIPTOR, EXCHANGE_ROLE_GROUPS_OPERATIONS, EXCHANGE_ROLE_GROUPS_WORKLOAD,
  ExchangeRoleGroupsScopeError, FAMILIES, assertExchangeRoleGroupsCmdlet, collectExchangeRoleGroups, exchangeRoleGroupsActivation,
  readExchangeRoleGroups,
} from '../collect/workloads/exchangeRoleGroups.mjs';
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

const NOW = new Date('2026-10-22T12:00:00Z');
const EXO_VERSION = '3.5.0';
let tenantSeq = 0;
const nextTenant = () => `sha256:role-groups-${tenantSeq += 1}`;
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-00000000a0a0`;

// Role groups as Exchange answers them: every declared field, plus internal
// properties a careless reader would keep.
const group = (n, over = {}) => ({
  Name: `KEEL-RT-role-group-${n}`, DisplayName: `KEEL-RT-role-group-${n}`, Description: 'Test role group', RoleGroupType: 'Standard',
  Roles: ['Mail Recipients'], Members: ['ada'], ManagedBy: [], ExchangeObjectId: guid(n), WhenChangedUTC: '2026-10-01T00:00:00Z',
  Guid: guid(n), DistinguishedName: 'CN=internal', OrganizationId: 'internal', ...over,
});
const BUILT_IN = group(1, { Name: 'Organization Management', DisplayName: 'Organization Management', RoleGroupType: 'Standard', Roles: ['Role Management', 'Mail Recipients'] });

function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z0-9-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const ALLOWED = containerAllowlist('AllowedExchangeRoleGroups');

/** A fake Exchange Online behind the real jobQueue spawn path. `state.output` is what Get-RoleGroup answers. */
function fakeExchange(state = { output: [BUILT_IN, group(2)] }) {
  const calls = [];
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  function run(job) {
    if (job.mode !== 'cmdlet' || job.module !== 'ExchangeOnlineManagement' || !ALLOWED[job.cmdlet]) {
      return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, category: null, errorId: 'CmdletNotAllowed' } }, 1);
    }
    calls.push({ cmdlet: job.cmdlet, parameters: job.parameters ?? {} });
    if (state.error) return envelope({ ok: false, error: state.error }, 1);
    return envelope({ ok: true, output: structuredClone(state.output) });
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
  return { operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-21T00:00:00Z', version, ok: true, proofRef: `${operationId}@sha256:x` };
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
const OTHER_READS = Object.freeze(ALL_READS.filter((id) => !EXCHANGE_ROLE_GROUPS_OPERATIONS.includes(id)));

test('the read is declared, in scope, probed, Get-only and ships disabled', async () => {
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === EXCHANGE_ROLE_GROUPS_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [...EXCHANGE_ROLE_GROUPS_OPERATIONS]);
  assert.deepEqual(declared.map((descriptor) => descriptor.operation.cmdlet), ['Get-RoleGroup']);
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const exo = /# --- Exchange Online ---([\s\S]*?)# --- Security & Compliance/.exec(probe)[1];
  for (const descriptor of declared) {
    assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
    assert.equal(descriptor.operation.module, 'ExchangeOnlineManagement');
    assert.deepEqual(descriptor.rbac.roles, ['Exchange Administrator']);
    assert.ok(exo.includes(`-Workload 'exo' -Name 'Get-RoleGroup' -Block { Get-RoleGroup }`));
  }
  const bare = buildWorkloadLedger({ grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.equal(bare.rows.find((row) => row.id === 'exchange-role-groups.role-groups').enabled, false);
  const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

  assert.equal(EXCHANGE_ROLE_GROUPS_DESCRIPTOR.enabledByDefault, false);
  assert.equal(EXCHANGE_ROLE_GROUPS_DESCRIPTOR.readOnly, true);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === EXCHANGE_ROLE_GROUPS_WORKLOAD));
  assert.ok(WORKLOAD_COLLECTORS.some((entry) => entry.workload === EXCHANGE_ROLE_GROUPS_WORKLOAD && entry.powershellFamily === 'exchange'));
  assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((operation) => operation.workload === EXCHANGE_ROLE_GROUPS_WORKLOAD), [], 'no writer');

  assert.deepEqual(Object.fromEntries(Object.entries(EXCHANGE_ROLE_GROUPS_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), ALLOWED,
    'the Node and container allowlists are identical');
  for (const cmdlet of ['New-RoleGroup', 'Set-RoleGroup', 'Add-RoleGroupMember', 'Remove-RoleGroup', 'Update-RoleGroupMember', 'Get-ManagementRoleAssignment']) {
    assert.throws(() => assertExchangeRoleGroupsCmdlet({ cmdlet }), ExchangeRoleGroupsScopeError, cmdlet);
  }
  assert.throws(() => assertExchangeRoleGroupsCmdlet({ cmdlet: 'Get-RoleGroup', parameters: { Identity: 'x' } }), /does not take Identity/);

  // The read capture tool qualifies it, in the Exchange module, though it has no writes.
  assert.equal(readModule(EXCHANGE_ROLE_GROUPS_WORKLOAD), 'ExchangeOnlineManagement');
  assert.deepEqual(workloadReads(EXCHANGE_ROLE_GROUPS_WORKLOAD), [{ family: 'roleGroup', operationId: 'exchange-role-groups.role-groups', cmdlet: 'Get-RoleGroup' }]);
});

test('role groups sit first in Exchange admin roles', () => {
  const info = typeInfo(EXCHANGE_ROLE_GROUPS_WORKLOAD);
  assert.equal(info.known, true);
  assert.equal(info.service, 'Exchange');
  assert.equal(info.categoryName, 'Admin roles');
  assert.equal(info.name, 'Exchange admin role group');
  const order = ['exchangeRoleAssignment', 'exchange-mail-flow', 'exchangeRoleDefinition', EXCHANGE_ROLE_GROUPS_WORKLOAD, 'exchange-mailbox-settings'].sort(compareInService);
  assert.deepEqual(order, ['exchange-mailbox-settings', EXCHANGE_ROLE_GROUPS_WORKLOAD, 'exchangeRoleDefinition', 'exchangeRoleAssignment', 'exchange-mail-flow']);
});

test('each group is one observation under its Guid, with declared fields only', async () => {
  const exchange = fakeExchange({ output: [BUILT_IN, group(2), { ...group(2), Name: 'duplicate copy' }, { ...group(3), Guid: 'not-a-guid' }] });
  const result = await readExchangeRoleGroups({ powershell: exchange.powershell, now: () => NOW });
  assert.deepEqual(exchange.calls, [{ cmdlet: 'Get-RoleGroup', parameters: {} }]);
  assert.deepEqual(result.resources.map((resource) => resource.resourceKey), [`role-group:${guid(1)}`, `role-group:${guid(2)}`]);
  const [orgManagement] = result.resources;
  assert.equal(orgManagement.fields.Name, 'Organization Management');
  assert.deepEqual(orgManagement.fields.Roles, ['Role Management', 'Mail Recipients']);
  assert.equal(orgManagement.fields.DistinguishedName, undefined);
  assert.deepEqual(Object.keys(orgManagement.fields), [...FAMILIES.roleGroup.fields]);
  // An unidentified answer and a disagreeing duplicate make the run partial, never silent.
  assert.equal(result.outcome, 'partial');
  assert.equal(result.discovery.unidentified, 1);
  assert.equal(result.discovery.conflicts.length, 1);

  const clean = await readExchangeRoleGroups({ powershell: fakeExchange().powershell, now: () => NOW });
  assert.equal(clean.outcome, 'complete');
  // Every tenant has built-in groups: an empty answer is a gap, and a failure is a failure.
  assert.equal((await readExchangeRoleGroups({ powershell: fakeExchange({ output: [] }).powershell })).outcome, 'partial');
  const failed = await readExchangeRoleGroups({ powershell: fakeExchange({ error: { message: 'Access is denied', category: 'PermissionDenied', errorId: 'x' } }).powershell });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.failures[0].status, 'denied');
});

test('collection stays off until Exchange and this read are qualified, then a member added is a change', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const exchange = fakeExchange();
  for (const ledger of [ledgerWith(tenantRef, OTHER_READS), ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)))]) {
    const disabled = await collectExchangeRoleGroups(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => NOW });
    assert.equal(disabled.run.outcome, 'disabled');
  }
  assert.deepEqual(exchange.calls, [], 'nothing is sent while disabled');
  assert.match(exchangeRoleGroupsActivation(ledgerWith(tenantRef, OTHER_READS)).reasons.join('; '), /exchange-role-groups\.role-groups is fixture-tested/);
  // Exchange (and what it follows) is needed beside this read, not the other Exchange cmdlet workloads.
  const others = ALL_READS.filter((id) => /^(mailflow|exchange-extended)\./.test(id));
  assert.ok(others.length > 20);
  assert.equal(exchangeRoleGroupsActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => !others.includes(id)))).enabled, true);

  const ledger = ledgerWith(tenantRef, ALL_READS);
  const first = await collectExchangeRoleGroups(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => new Date('2026-10-21T02:00:00Z') });
  assert.equal(first.run.outcome, 'complete');
  const { rows } = await client.query('SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [first.run.id]);
  assert.deepEqual(rows.map((row) => [row.resource_key, row.fields.kind, row.fields.Name]), [
    [`role-group:${guid(1)}`, 'roleGroup', 'Organization Management'],
    [`role-group:${guid(2)}`, 'roleGroup', 'KEEL-RT-role-group-2'],
  ]);

  exchange.state.output = [BUILT_IN, group(2, { Members: ['ada', 'grace'], WhenChangedUTC: '2026-10-21T09:00:00Z' })];
  const second = await collectExchangeRoleGroups(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => new Date('2026-10-22T02:00:00Z') });
  const drift = await detectWorkloadDrift(client, { collectionId: second.run.id });
  assert.equal(drift.status, 'detected');
  const { rows: changes } = await client.query('SELECT resource_key, change_type, fields FROM workload_drift WHERE tenant_ref = $1', [tenantRef]);
  assert.deepEqual(changes.map((row) => [row.resource_key, row.change_type]), [[`role-group:${guid(2)}`, 'modified']]);
  assert.deepEqual(changes[0].fields.map((field) => field.path), ['Members']);
});
