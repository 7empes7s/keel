// Custom Exchange admin role restore through Exchange Online PowerShell.
//
// Acceptance:
//  - one write is declared (a custom role that no longer exists), ships disabled, has no
//    trust or sign-in field, and the Node and container allowlists are equal;
//  - the transport refuses, unsent, an undeclared cmdlet or parameter;
//  - Graph's role entries ("(snap-in) Cmdlet -Param ...") are read, common parameters
//    left out; a script entry, excluded actions or a condition is listed, never written;
//  - the parent is the one the backup names, else the smallest built-in role that holds
//    every entry and parameter;
//  - a fixture restore recreates a deleted KEEL-RT- role with exactly the backup's entries
//    (New-ManagementRole, then the new role's entries trimmed), verified by read-back; a
//    second dry run plans nothing;
//  - a role that still exists is never changed: what differs is listed;
//  - on the test tenant only KEEL-RT- roles are written; built-in roles are never targets;
//  - a role created since the dry run is stale and nothing is sent; a failed create is
//    never resent; without a qualification nothing is sent.
//
// Runs against the isolated test database and a fake PowerShell container behind the
// real engine/powershell/jobQueue.mjs spawn path. No tenant is touched.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { RESTORE_POWERSHELL_FAMILY, workloadPowershellConfigPath } from '../collect/workloads/powershellConfigs.mjs';
import { WORKLOAD_WRITE_OPERATIONS, workloadWriteQualification } from '../coverage/qualification.mjs';
import { WORKLOAD_RESTORES } from '../restore/workloads/dispatch.mjs';
import {
  EXCHANGE_ROLE_ADD, EXCHANGE_ROLE_WRITE_OPERATIONS, EXCHANGE_ROLES_WORKLOAD, ROLE_READ_CMDLETS, ROLE_WRITE_CMDLETS, RoleWriteScopeError,
  chooseParent, createExchangeRoleArtifact, entryDifferences, executeExchangeRoleRestore, loadRoleSource, planExchangeRoleRestore,
  readLiveRoles, recordEntries, roleCmdletRunner,
} from '../restore/workloads/exchangeRoleDefinitions.mjs';
import { isTrustField } from '../restore/workloads/writeDeclarations.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { containerAllowlist } from '../test/fakeCmdletContainer.mjs';
import { fakeExchangeRoles as fakeExchange } from '../test/fakeExchangeRoles.mjs';

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

const TENANT = '00000000-0000-4000-8000-0000000000e7';
let tenantSeq = 0;
const nextTenant = () => `sha256:exchange-role-definitions-${tenantSeq += 1}`;
let principalSeq = 0;
async function principal(client, label, role = null) {
  const { rows } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id', [`${label}-${principalSeq += 1}@example.test`]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id, activeFrom: new Date(Date.now() - 60_000) });
  return rows[0].id;
}

const SNAPIN = '(Microsoft.Exchange.Management.PowerShell.E2010)';
const COMMON = '-ErrorAction -ErrorVariable -OutBuffer -OutVariable -WarningAction -WarningVariable';
const action = (cmdlet, parameters) => `${SNAPIN} ${cmdlet} ${[...parameters.map((name) => `-${name}`), COMMON].join(' ')}`;
let idSeq = 0;
/** One exchangeRoleDefinition as Graph beta returns it. */
function role(displayName, entries, { isBuiltIn = true, description = `${displayName} role`, extra = {} } = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(idSeq += 1).padStart(12, '0')}`, displayName, description, isEnabled: true, isBuiltIn, version: '0.12 (14.0.451.0)', templateId: null,
    allowedPrincipalTypes: 'user,group',
    rolePermissions: [{ allowedResourceActions: Object.entries(entries).map(([cmdlet, parameters]) => action(cmdlet, parameters)), excludedResourceActions: [], condition: null }],
    ...extra,
  };
}
const ADDRESS_LISTS = role('Address Lists', {
  'Get-AddressList': ['Identity', 'ResultSize', 'SearchText'], 'Get-GlobalAddressList': ['Identity', 'DefaultOnly'],
  'New-AddressList': ['Name', 'RecipientFilter'], 'Remove-AddressList': ['Identity'], 'Set-AddressList': ['Identity', 'DisplayName'],
});
const MAIL_RECIPIENTS = role('Mail Recipients', {
  'Get-AddressList': ['Identity', 'ResultSize', 'SearchText'], 'Get-GlobalAddressList': ['Identity', 'DefaultOnly'],
  'Get-Mailbox': ['Identity', 'ResultSize'], 'Set-Mailbox': ['Identity', 'DisplayName'], 'Get-Recipient': ['Identity'],
  'New-AddressList': ['Name', 'RecipientFilter'], 'Remove-AddressList': ['Identity'], 'Set-AddressList': ['Identity', 'DisplayName'],
});
const READER = role('KEEL-RT-role-address-read', { 'Get-AddressList': ['Identity'], 'Get-GlobalAddressList': ['Identity', 'DefaultOnly'] }, { isBuiltIn: false, description: 'KEEL-RT read-only address lists' });

const builtInLive = () => [
  { name: 'Address Lists', entries: { 'Get-AddressList': ['Identity', 'ResultSize', 'SearchText'], 'Get-GlobalAddressList': ['Identity', 'DefaultOnly'], 'New-AddressList': ['Name', 'RecipientFilter'], 'Remove-AddressList': ['Identity'], 'Set-AddressList': ['Identity', 'DisplayName'] } },
  { name: 'Mail Recipients', entries: structuredClone(Object.fromEntries(Object.entries(recordEntries(MAIL_RECIPIENTS).entries))) },
];

async function snapshot(client, tenantRef, records, { status = 'complete' } = {}) {
  const { rows: [row] } = await client.query(
    "INSERT INTO snapshot(tenant_ref, status, completed_at, coverage_digest) VALUES ($1, $2, now(), $3) RETURNING id",
    [tenantRef, status, { exchangeRoleDefinition: { outcome: 'complete', itemCount: records.length } }],
  );
  for (const record of records) {
    await client.query(
      `INSERT INTO resource_version(snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, 'exchangeRoleDefinition', $3, 'h', 'tier2', 'access-affecting', 'full', '{}')`,
      [row.id, `exchangeRoleDefinition:${record.id}`, record],
    );
  }
  return row.id;
}

const entry = WORKLOAD_RESTORES[EXCHANGE_ROLES_WORKLOAD];
async function planned(client, tenantRef, tenant, collectionId, { targets = [], testTenantRefs = [tenantRef] } = {}) {
  const source = await loadRoleSource(client, { tenantRef, collectionId });
  const cmdlet = roleCmdletRunner(tenant.powershell);
  const roles = await readLiveRoles(cmdlet);
  const live = { roles, entries: {} };
  for (const item of roles) {
    if (source.roles.some(({ record }) => record.displayName.toLowerCase() === item.name.toLowerCase() && record.isBuiltIn === false)) {
      live.entries[item.name] = Object.fromEntries(Object.entries(tenant.state.get(item.name.toLowerCase()).entries).map(([name, list]) => [name, [...list].sort()]));
    }
  }
  const plan = planExchangeRoleRestore({ source, live, tenantId: TENANT, tenantRef, targets, testTenantRefs });
  const artifact = await createExchangeRoleArtifact(client, { tenantRef, plan, requestedBy: await principal(client, 'requester') });
  return { plan, artifact };
}
const enabled = () => ({ [EXCHANGE_ROLE_ADD]: { operationId: EXCHANGE_ROLE_ADD, state: 'live-qualified', enabled: true, reasons: [] } });
const execute = (client, tenantRef, artifact, tenant, qualifications = enabled()) => executeExchangeRoleRestore(client, {
  tenantRef, artifactId: artifact.id, tenantId: TENANT, cmdlet: roleCmdletRunner(tenant.powershell), qualifications, testTenantRefs: [tenantRef],
});
const sorted = (entries) => Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => [name, [...list].sort()]));

// ------------------------------------------------------------ declarations and allowlists

test('one write is declared, ships disabled, and the container allowlists match the engine', () => {
  assert.deepEqual(Object.keys(EXCHANGE_ROLE_WRITE_OPERATIONS), [EXCHANGE_ROLE_ADD]);
  const write = WORKLOAD_WRITE_OPERATIONS[EXCHANGE_ROLE_ADD];
  assert.equal(write.workload, EXCHANGE_ROLES_WORKLOAD);
  assert.equal(write.kind, 'cmdlet');
  assert.equal(write.module, 'ExchangeOnlineManagement');
  assert.equal(write.readBack, 'exchange-role-groups.role-groups');
  assert.equal(write.grantsRequired, true);
  for (const field of write.fields) assert.equal(isTrustField(write.resourceType, field), false, field);
  assert.equal(workloadWriteQualification(EXCHANGE_ROLE_ADD, { tenantRef: 'sha256:t' }).enabled, false);
  const fixtureOnly = workloadWriteQualification(EXCHANGE_ROLE_ADD, { tenantRef: 'sha256:t', evidence: [{ operationId: EXCHANGE_ROLE_ADD, kind: 'fixture', ok: true, synthetic: true }] });
  assert.equal(fixtureOnly.enabled, false, 'a fixture pass never switches it on');

  const shipped = (variable) => Object.fromEntries(Object.entries(containerAllowlist(variable)).map(([name, list]) => [name, [...list].sort()]));
  const declared = (table) => Object.fromEntries(Object.entries(table).map(([name, list]) => [name, [...list].sort()]));
  assert.deepEqual(shipped('AllowedExchangeRoleReads'), declared(ROLE_READ_CMDLETS));
  assert.deepEqual(shipped('AllowedExchangeRoleWrites'), declared(ROLE_WRITE_CMDLETS));
  assert.deepEqual([...entry.operations], [EXCHANGE_ROLE_ADD]);
  // The restore connects with the Exchange PowerShell file, like the Exchange collects.
  assert.equal(RESTORE_POWERSHELL_FAMILY[EXCHANGE_ROLES_WORKLOAD], 'exchange');
  assert.equal(workloadPowershellConfigPath(EXCHANGE_ROLES_WORKLOAD, {
    role: 'collector', tenantId: TENANT, scope: { powershellConfigs: { exchange: '/etc/keel/exchange-collector.json' } },
    readFile: () => JSON.stringify({ tenantId: TENANT }),
  }), '/etc/keel/exchange-collector.json');
});

test('the transport refuses an undeclared cmdlet or parameter before anything is sent', async () => {
  const tenant = fakeExchange();
  const cmdlet = roleCmdletRunner(tenant.powershell);
  await assert.rejects(cmdlet({ cmdlet: 'Remove-ManagementRole', parameters: { Identity: 'KEEL-RT-x' } }), RoleWriteScopeError);
  await assert.rejects(cmdlet({ cmdlet: 'New-ManagementRole', parameters: { Name: 'KEEL-RT-x', Parent: 'Address Lists', Force: true } }), RoleWriteScopeError);
  await assert.rejects(cmdlet({ cmdlet: 'Add-ManagementRoleEntry', parameters: { Identity: 'KEEL-RT-x\\Get-Mailbox' } }), RoleWriteScopeError);
  assert.equal(tenant.calls.length, 0);
});

// ------------------------------------------------------------ entries and parents

test('Graph role entries are read with common parameters left out; unreadable entries are a problem', () => {
  assert.deepEqual(recordEntries(READER).entries, { 'Get-AddressList': ['Identity'], 'Get-GlobalAddressList': ['DefaultOnly', 'Identity'] });
  assert.match(recordEntries({ rolePermissions: [{ allowedResourceActions: ['(Script) Reset-Things.ps1'] }] }).problem, /cannot read/);
  assert.match(recordEntries({ rolePermissions: [{ allowedResourceActions: [action('Get-Mailbox', [])], excludedResourceActions: ['x'] }] }).problem, /excluded/);
  assert.match(recordEntries({ rolePermissions: [] }).problem, /no role entries/);
  assert.deepEqual(entryDifferences({ 'Get-A': ['Identity', 'X'], 'Get-B': [] }, { 'Get-A': ['Identity'], 'Get-C': [] }), {
    removeEntries: ['Get-B'], removeParameters: [{ cmdlet: 'Get-A', parameters: ['X'] }], missing: [{ cmdlet: 'Get-C', parameters: null }],
  });
});

test('the parent is the one the backup names, else the smallest built-in role that holds every entry', () => {
  const source = { roles: [ADDRESS_LISTS, MAIL_RECIPIENTS, READER].map((record) => ({ naturalKey: record.id, record })) };
  assert.equal(chooseParent(READER, recordEntries(READER).entries, source).name, 'Address Lists');
  const named = { ...READER, inheritsPermissionsFrom: [{ id: MAIL_RECIPIENTS.id }] };
  assert.equal(chooseParent(named, recordEntries(named).entries, source).name, 'Mail Recipients');
  // A named parent that does not hold every entry is not used.
  const wider = role('KEEL-RT-role-wide', { 'Get-Mailbox': ['Identity'] }, { isBuiltIn: false, extra: { inheritsPermissionsFrom: [{ id: ADDRESS_LISTS.id }] } });
  assert.equal(chooseParent(wider, recordEntries(wider).entries, { roles: [...source.roles, { naturalKey: wider.id, record: wider }] }).name, 'Mail Recipients');
  const nowhere = role('KEEL-RT-role-none', { 'Get-Thing': ['Identity'] }, { isBuiltIn: false });
  assert.equal(chooseParent(nowhere, recordEntries(nowhere).entries, source), null);
});

// ------------------------------------------------------------ restore

for (const ignoreEnabledCmdlets of [false, true]) {
  test(`a deleted KEEL-RT- role is recreated with exactly the backup's entries${ignoreEnabledCmdlets ? ' (entries the create copied are removed)' : ''}`, async (t) => {
    const client = await schemaClient(t);
    const tenantRef = nextTenant();
    const tenant = fakeExchange({ roles: builtInLive(), ignoreEnabledCmdlets });
    const collectionId = await snapshot(client, tenantRef, [ADDRESS_LISTS, MAIL_RECIPIENTS, READER]);
    const { plan, artifact } = await planned(client, tenantRef, tenant, collectionId);
    assert.equal(artifact.status, 'completed');
    assert.equal(plan.operations.length, 1);
    const [op] = plan.operations;
    assert.equal(op.name, READER.displayName);
    assert.equal(op.parent, 'Address Lists');
    assert.deepEqual(op.parameters.EnabledCmdlets, ['Get-AddressList', 'Get-GlobalAddressList']);
    assert.ok(plan.manual.some((item) => item.field === 'Holders'), 'who held the role is listed');
    assert.equal(plan.excluded[0].count, 2, 'the built-in roles are excluded');
    assert.equal(tenant.sent().length, 0, 'the dry run sends nothing');

    const result = await execute(client, tenantRef, artifact, tenant);
    assert.equal(result.outcome, 'verified', JSON.stringify(result));
    const created = tenant.state.get(READER.displayName.toLowerCase());
    assert.equal(created.parent, 'Address Lists');
    assert.equal(created.description, READER.description);
    assert.deepEqual(sorted(created.entries), sorted(recordEntries(READER).entries));
    const sent = tenant.sent();
    assert.equal(sent[0].cmdlet, 'New-ManagementRole');
    assert.ok(sent.slice(1).every(({ cmdlet, parameters }) => /^(Set|Remove)-ManagementRoleEntry$/.test(cmdlet) && parameters.Identity.startsWith(`${READER.displayName}\\`)),
      'entries are trimmed only on the new role');
    assert.ok(sent.some(({ cmdlet, parameters }) => cmdlet === 'Set-ManagementRoleEntry' && parameters.Identity.endsWith('\\Get-AddressList')
      && parameters.RemoveParameter === true && [...parameters.Parameters].sort().join() === 'ResultSize,SearchText'));
    assert.equal(sent.filter(({ cmdlet }) => cmdlet === 'Remove-ManagementRoleEntry').length, ignoreEnabledCmdlets ? 3 : 0);
    assert.ok(sent.every(({ parameters }) => !Object.values(parameters).some((value) => String(value).includes('*'))), 'no write names a wildcard');

    // A second dry run plans nothing: the role is there and matches.
    const again = await planned(client, tenantRef, tenant, collectionId);
    assert.equal(again.plan.operations.length, 0);
    assert.deepEqual(again.plan.manual, []);
  });
}

test('a role that still exists is never changed; what differs is listed', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const tenant = fakeExchange({ roles: [...builtInLive(), { name: READER.displayName, parent: 'Address Lists', description: 'changed', entries: { 'Get-AddressList': ['Identity', 'ResultSize'], 'Set-AddressList': ['Identity'] } }] });
  const collectionId = await snapshot(client, tenantRef, [ADDRESS_LISTS, MAIL_RECIPIENTS, READER]);
  const { plan } = await planned(client, tenantRef, tenant, collectionId);
  assert.equal(plan.operations.length, 0);
  assert.deepEqual(plan.manual.map((item) => item.field).sort(), ['Description', 'Entries', 'Entries', 'Parameters']);
  assert.equal(tenant.sent().length, 0);
});

test('on the test tenant only KEEL-RT- roles are written, and built-in roles are never targets', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const tenant = fakeExchange({ roles: builtInLive() });
  const other = role('Helpdesk readers', { 'Get-AddressList': ['Identity'] }, { isBuiltIn: false });
  const collectionId = await snapshot(client, tenantRef, [ADDRESS_LISTS, MAIL_RECIPIENTS, READER, other]);
  const { plan, artifact } = await planned(client, tenantRef, tenant, collectionId);
  assert.deepEqual(plan.refusals.map((item) => item.naturalKey), [`exchangeRoleDefinition:${other.id}`]);
  assert.equal(artifact.status, 'refused');
  const targeted = await planned(client, tenantRef, tenant, collectionId, { targets: [READER.displayName] });
  assert.equal(targeted.artifact.status, 'completed');
  assert.equal(targeted.plan.operations.length, 1);
  await assert.rejects(planned(client, tenantRef, tenant, collectionId, { targets: ['Address Lists'] }), /built-in/);
  await assert.rejects(planned(client, tenantRef, tenant, collectionId, { targets: ['KEEL-RT-nothing'] }), /no Exchange admin role named/);
  // Off the test tenant a customer's own roles are restored.
  const customer = await planned(client, tenantRef, tenant, collectionId, { testTenantRefs: [] });
  assert.equal(customer.plan.operations.length, 2);
});

test('the parent must exist live; a role with no live parent, or entries Keel cannot read, is listed', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  // Address Lists is gone, so the reader is created from Mail Recipients, the next role that holds its entries.
  const tenant = fakeExchange({ roles: [builtInLive()[1]] });
  const script = { ...role('KEEL-RT-role-script', {}, { isBuiltIn: false }), rolePermissions: [{ allowedResourceActions: ['(Script) Reset-Things.ps1'], excludedResourceActions: [] }] };
  const lists = role('KEEL-RT-role-lists', { 'New-AddressList': ['Name'] }, { isBuiltIn: false, extra: { inheritsPermissionsFrom: [{ id: ADDRESS_LISTS.id }] } });
  const collectionId = await snapshot(client, tenantRef, [ADDRESS_LISTS, MAIL_RECIPIENTS, READER, script, lists]);
  const { plan } = await planned(client, tenantRef, tenant, collectionId);
  assert.deepEqual(plan.operations.map((op) => [op.name, op.parent]), [[READER.displayName, 'Mail Recipients'], [lists.displayName, 'Mail Recipients']].sort());
  assert.ok(plan.manual.some((item) => /cannot read/.test(item.reason)));
  // No live role holds what it needs: listed, never created from a guess.
  const bare = fakeExchange({ roles: [{ name: 'Other', entries: { 'Get-Recipient': ['Identity'] } }] });
  const { plan: none } = await planned(client, tenantRef, bare, collectionId);
  assert.equal(none.operations.length, 0);
  assert.ok(none.manual.some((item) => item.field === 'Parent' && /restore the parent first/.test(item.reason) && item.after === 'Address Lists'));
});

test('a role created since the dry run is stale, and nothing is sent', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const tenant = fakeExchange({ roles: builtInLive() });
  const collectionId = await snapshot(client, tenantRef, [ADDRESS_LISTS, MAIL_RECIPIENTS, READER]);
  const { artifact } = await planned(client, tenantRef, tenant, collectionId);
  tenant.state.set(READER.displayName.toLowerCase(), { name: READER.displayName, parent: 'Address Lists', description: null, entries: { 'Get-AddressList': ['Identity'] } });
  const result = await execute(client, tenantRef, artifact, tenant);
  assert.equal(result.operations[0].outcome, 'stale');
  assert.equal(tenant.sent().length, 0);
});

test('without a qualification nothing is sent; a failed create is not resent', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const tenant = fakeExchange({ roles: builtInLive(), failNew: { error: { message: 'The parameter EnabledCmdlets is not valid', category: 'InvalidArgument', errorId: 'ParameterBindingException' } } });
  const collectionId = await snapshot(client, tenantRef, [ADDRESS_LISTS, MAIL_RECIPIENTS, READER]);
  const { artifact } = await planned(client, tenantRef, tenant, collectionId);
  const off = await execute(client, tenantRef, artifact, tenant, {});
  assert.equal(off.outcome, 'disabled');
  assert.equal(tenant.sent().length, 0);
  const failed = await execute(client, tenantRef, artifact, tenant);
  assert.equal(failed.operations[0].outcome, 'failed');
  assert.equal(failed.operations[0].error.errorId, 'ParameterBindingException');
  assert.equal(tenant.sent().filter(({ cmdlet }) => cmdlet === 'New-ManagementRole').length, 1, 'the create was sent once');
  assert.equal(tenant.state.has(READER.displayName.toLowerCase()), false);
});

test('the dispatch entry plans from the backup through the collector connection', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const tenant = fakeExchange({ roles: builtInLive() });
  const collectionId = await snapshot(client, tenantRef, [ADDRESS_LISTS, MAIL_RECIPIENTS, READER]);
  const plan = await entry.plan(client, { tenantRef, tenantId: TENANT, request: { collectionId, targets: [READER.displayName] }, connection: { powershell: tenant.powershell } });
  assert.equal(plan.operations.length, 1);
  await assert.rejects(entry.plan(client, { tenantRef: nextTenant(), tenantId: TENANT, request: { collectionId }, connection: { powershell: tenant.powershell } }), /no backup/);
  const broken = fakeExchange();
  broken.powershell.spawnFn = () => { throw new Error('docker is not running'); };
  await assert.rejects(entry.plan(client, { tenantRef, tenantId: TENANT, request: { collectionId }, connection: { powershell: broken.powershell } }), /could not be read live/);
});
