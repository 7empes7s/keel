// Gap register W2: a workload restore runs through cli/keel-restore.mjs.
//
// Acceptance:
//  - `--workload <name>` plans a dry run from a recorded collection and persists it;
//  - promoting that artifact needs an approved request from someone other than the
//    requester, and then dispatches to that workload's own execute function;
//  - the content-effect guard and the write qualification still apply;
//  - by default the qualification comes from the stored workload ledger: a write
//    with no live capture from this tenant stays disabled;
//  - a workload artifact never has its `workload:<name>` marker read as a file.
//
// Everything runs against the isolated test database, an in-memory fake Graph and
// fake credential files. No tenant is read or written.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { WORKLOAD_DESCRIPTORS } from '../collect/workloadContract.mjs';
import { saveLedgerInputs } from '../collect/workloadLedgerStore.mjs';
import { SHAREPOINT_OPERATIONS, recordSharePointRun } from '../collect/workloads/sharepoint.mjs';
import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { approveRequest, requestApproval, SelfApprovalError } from '../govern/approvals.mjs';
import { createDryRunArtifact, getDryRunArtifactById } from '../restore/dryRunArtifact.mjs';
import { WORKLOAD_RESTORES } from '../restore/workloads/dispatch.mjs';
import { SHAREPOINT_WRITE_OPERATION } from '../restore/workloads/sharepoint.mjs';
import { approveContentEffects, contentEffectsDigest } from '../safety/contentEffects.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { defaultWorkloadQualifications, main, runRestore } from '../../cli/keel-restore.mjs';
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

const quiet = { log() {}, error() {} };
const HOST = 'contoso.sharepoint.com';
const SETTINGS_URL = 'https://graph.microsoft.com/v1.0/admin/sharepoint/settings';
const TENANT_ID = '0a1b2c3d-0000-4000-8000-000000000002';
const TENANT = tenantRefFor(TENANT_ID);
const OTHER_TENANT_ID = '0a1b2c3d-0000-4000-8000-000000000099';
const SOURCE_SETTINGS = {
  sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'allowList',
  sharingAllowedDomainList: ['fabrikam.com'], sharingBlockedDomainList: [], isResharingByExternalUsersEnabled: false,
};

// Fake credential files: the dry run names the collector file; a promotion reads
// the server's two files (credentialPaths), never the artifact's marker paths.
const configs = new Map([
  ['/fixtures/collector.json', JSON.stringify({ tenantId: TENANT_ID, clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: TENANT_ID, clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
  ['/fixtures/other-collector.json', JSON.stringify({ tenantId: OTHER_TENANT_ID, clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/other-restorer.json', JSON.stringify({ tenantId: OTHER_TENANT_ID, clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
]);
const reads = [];
const readFile = (path) => {
  reads.push(path);
  if (!configs.has(path)) throw new Error(`unexpected file read: ${path}`);
  return configs.get(path);
};
const SERVER_PATHS = { collectorConfig: '/fixtures/collector.json', targetConfig: '/fixtures/restorer.json' };

/** An in-memory /admin/sharepoint/settings. */
function fakeSharePoint(initial) {
  const state = { settings: structuredClone(initial) };
  const requests = [];
  async function transport(url, init) {
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    if (url !== SETTINGS_URL) return { status: 404, headers: {}, body: null };
    if (method === 'GET') return { status: 200, headers: {}, body: structuredClone(state.settings) };
    if (method === 'PATCH') {
      Object.assign(state.settings, structuredClone(init.body));
      return { status: 200, headers: {}, body: structuredClone(state.settings) };
    }
    return { status: 405, headers: {}, body: null };
  }
  return { state, requests, transport, writes: () => requests.filter((request) => request.method !== 'GET') };
}

const qualified = () => ({
  [SHAREPOINT_WRITE_OPERATION]: workloadWriteQualification(SHAREPOINT_WRITE_OPERATION, {
    readLedger: { tenantRef: TENANT, rows: [{ id: 'sharepoint.tenant-settings', state: 'live-qualified', enabled: true }] },
    evidence: [{
      operationId: SHAREPOINT_WRITE_OPERATION, kind: 'live-write-capture', synthetic: false, tenantRef: TENANT,
      capturedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), version: 'v1.0', ok: true, readBackVerified: true, proofRef: 'capture.json@sha256:x',
    }],
    tenantRef: TENANT,
  }),
});

/** CLI dependencies: a fake Graph per role, a qualification answer and the server's paths. */
function cliDependencies(graph, { qualifications = qualified, paths = SERVER_PATHS, scope = {} } = {}) {
  const connections = [];
  return {
    connections,
    dependencies: {
      workloadConnection: async ({ role, config, configPath, powershellConfigPath = null }) => {
        connections.push({ role, clientId: config.clientId, configPath, powershellConfigPath });
        return { transport: graph.transport, powershell: {} };
      },
      workloadQualifications: async () => qualifications(),
      credentialPaths: () => paths,
      workloadScope: () => scope,
      sleep: async () => {},
    },
  };
}

async function recordSource(client) {
  const fieldCoverage = Object.fromEntries(Object.keys(SOURCE_SETTINGS).map((field) => [field, { status: 'observed', operation: 'sharepoint.tenant-settings' }]));
  const run = await recordSharePointRun(client, {
    tenantRef: TENANT,
    result: {
      workload: 'sharepoint-site-settings', tenantHost: HOST, outcome: 'complete',
      observedFrom: '2026-10-01T00:00:00Z', observedTo: '2026-10-01T00:01:00Z',
      tenant: { fields: SOURCE_SETTINGS, fieldCoverage }, sites: [],
    },
  });
  return run.id;
}

async function dryRun(client, live, { requestedBy = 'requester', collectorConfig = '/fixtures/collector.json', options } = {}) {
  const collectionId = await recordSource(client);
  const graph = fakeSharePoint(live);
  const deps = cliDependencies(graph, options);
  const artifactId = crypto.randomUUID();
  const result = await main({
    argv: [
      'node', 'keel-restore.mjs', '--workload', 'sharepoint-site-settings', '--collection', String(collectionId),
      '--tenant-host', HOST, ...(collectorConfig === null ? [] : ['--collector-config', collectorConfig]),
      '--persist-artifact', artifactId, ...(requestedBy === null ? [] : ['--requested-by', requestedBy]),
    ],
    readFile, dbUrl: database.url, dependencies: deps.dependencies, logger: quiet,
  });
  return { result, graph, deps, artifactId };
}

async function approve(client, artifactId, { requestedBy = 'requester', decidedBy = 'approver' } = {}) {
  const request = await requestApproval(client, { tenantRef: TENANT, action: 'restore', params: { artifactId }, requestedBy });
  return approveRequest(client, { tenantRef: TENANT, id: request.id, decidedBy });
}

// Gap B11: a request must come from an enabled principal, so promotions use real ones.
async function people(client) {
  const requester = (await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [`w2-requester-${crypto.randomUUID()}@example.test`])).rows[0].id;
  const approver = (await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [`w2-approver-${crypto.randomUUID()}@example.test`])).rows[0].id;
  await grantRole(client, { principalId: approver, role: 'approver', grantedBy: approver, activeFrom: new Date(Date.now() - 60_000) });
  return { requester, approver };
}

const promote = (graph, artifactId, options) => runRestore({
  artifactId, mode: 'enforce', readFile, dbUrl: database.url, dependencies: cliDependencies(graph, options).dependencies, logger: quiet,
});

// ------------------------------------------------------------------- dry run

test('--workload plans a dry run from the recorded collection, with the collector, and sends no write', async (t) => {
  const client = await schemaClient(t);
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'externalUserAndGuestSharing' };
  const { result, graph, deps, artifactId } = await dryRun(client, live);

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.status, 'completed');
  assert.equal(result.artifactId, artifactId);
  assert.deepEqual(result.workloadRestore.operations[0].body, { sharingCapability: 'externalUserSharingOnly' });
  assert.deepEqual(graph.writes(), [], 'a dry run only reads');
  assert.deepEqual(deps.connections.map((c) => [c.role, c.clientId]), [['collector', 'collector']], 'the dry run never holds the restorer');

  const artifact = await getDryRunArtifactById(client, { id: artifactId });
  assert.equal(artifact.snapshotId, null);
  assert.equal(artifact.collectorConfigPath, 'workload:sharepoint-site-settings');
  assert.equal(artifact.tenantRef, TENANT);
  assert.equal(artifact.requestedBy, 'requester');
  assert.equal(artifact.workloadRestore.digest, result.workloadRestore.digest);
});

test('--workload without --requested-by persists the dry run under the keel-restore default', async (t) => {
  // keel-operator found the dry run crashed here: the plan was built, then the
  // artifact insert failed on a null requested_by.
  const client = await schemaClient(t);
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'externalUserAndGuestSharing' };
  const { result, artifactId } = await dryRun(client, live, { requestedBy: null });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.status, 'completed');
  const artifact = await getDryRunArtifactById(client, { id: artifactId });
  assert.equal(artifact.requestedBy, 'keel-restore');
});

test('--workload without --collector-config reads the server collector file, the one its promotion reads', async (t) => {
  // keel-operator hit this in Q77: the dry run demanded a path, and the server default
  // named a file the host never had, so every workload restore needed one by hand.
  const client = await schemaClient(t);
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'externalUserAndGuestSharing' };
  const { requester, approver } = await people(client);
  reads.length = 0;
  const { result, graph, deps, artifactId } = await dryRun(client, live, { requestedBy: requester, collectorConfig: null });

  assert.equal(result.status, 'completed');
  assert.deepEqual(reads, [SERVER_PATHS.collectorConfig]);
  assert.deepEqual(deps.connections.map((c) => [c.role, c.configPath]), [['collector', SERVER_PATHS.collectorConfig]]);

  await approve(client, artifactId, { requestedBy: requester, decidedBy: approver });
  reads.length = 0;
  const promoted = await promote(graph, artifactId);
  assert.equal(promoted.outcome, 'verified');
  assert.deepEqual(reads, [SERVER_PATHS.collectorConfig, SERVER_PATHS.targetConfig]);
});

test('--workload is a dry run only, and refuses an unknown workload or a missing option', async (t) => {
  await schemaClient(t);
  const run = (extra) => main({
    argv: ['node', 'keel-restore.mjs', '--collector-config', '/fixtures/collector.json', ...extra],
    readFile, dbUrl: database.url, dependencies: cliDependencies(fakeSharePoint(SOURCE_SETTINGS)).dependencies, logger: quiet,
  });
  await assert.rejects(run(['--workload', 'sharepoint-site-settings', '--enforce']), /dry run only/);
  await assert.rejects(run(['--workload', 'sharepoint-site-settings', '--snapshot-id', 's', '--select', 'k']), /mutually exclusive/);
  await assert.rejects(run(['--workload', 'onedrive']), /unknown workload "onedrive"/);
  await assert.rejects(run(['--workload', 'sharepoint-site-settings', '--tenant-host', HOST]), /--collection <id> is required/);
  await assert.rejects(runRestore({
    workloadRestore: { workload: 'sharepoint-site-settings' }, mode: 'enforce',
    collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')), readFile, dbUrl: database.url, logger: quiet,
  }), /only ever planned as a dry run/);
});

test('--allow-tenant-wide-test-writes reaches the workload plan, and is off unless given (#317)', async (t) => {
  await schemaClient(t);
  const seen = [];
  const workloadRestores = {
    'teams-org-policies': { label: 'Teams', operations: [], plan: async (_client, { request }) => { seen.push(request.allowTenantWide); throw new Error('planned'); } },
  };
  const run = (extra) => main({
    argv: ['node', 'keel-restore.mjs', '--collector-config', '/fixtures/collector.json', '--workload', 'teams-org-policies', '--collection', '1', ...extra],
    readFile, dbUrl: database.url, dependencies: { ...cliDependencies(fakeSharePoint(SOURCE_SETTINGS)).dependencies, workloadRestores }, logger: quiet,
  });
  await assert.rejects(run([]), /planned/);
  await assert.rejects(run(['--allow-tenant-wide-test-writes']), /planned/);
  assert.deepEqual(seen, [false, true]);
});

// ------------------------------------------------------------------- promotion

test('promotion is refused without an approved request; once approved it runs the SharePoint restore', async (t) => {
  const client = await schemaClient(t);
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'externalUserAndGuestSharing' };
  const { requester, approver } = await people(client);
  const { graph, artifactId } = await dryRun(client, live, { requestedBy: requester });
  reads.length = 0;

  // Mutation check: promote the reviewed artifact without approval, then with a self-approval.
  await assert.rejects(promote(graph, artifactId), /needs an approved request/);
  const request = await requestApproval(client, { tenantRef: TENANT, action: 'restore', params: { artifactId }, requestedBy: requester });
  await assert.rejects(approveRequest(client, { tenantRef: TENANT, id: request.id, decidedBy: requester }), SelfApprovalError);
  await assert.rejects(promote(graph, artifactId), /needs an approved request/);
  assert.deepEqual(graph.writes(), [], 'nothing written without the approval');
  assert.deepEqual(reads, [], 'no credential file is read before the approval');

  const approved = await approveRequest(client, { tenantRef: TENANT, id: request.id, decidedBy: approver });
  assert.deepEqual([approved.job.params.mode, approved.job.params.artifactId], ['enforce', artifactId]);

  const deps = cliDependencies(graph);
  const result = await runRestore({ artifactId, mode: 'enforce', readFile, dbUrl: database.url, dependencies: deps.dependencies, logger: quiet });
  assert.equal(result.outcome, 'verified');
  assert.deepEqual(graph.writes().map((w) => `${w.method} ${w.url}`), [`PATCH ${SETTINGS_URL}`]);
  assert.equal(graph.state.settings.sharingCapability, 'externalUserSharingOnly');
  assert.deepEqual(deps.connections.map((c) => [c.role, c.clientId, c.configPath]), [['restorer', 'restorer', '/fixtures/restorer.json']]);
  assert.ok(reads.every((path) => !path.startsWith('workload:')), 'the marker config path is never read as a file');
});

test('the content-effect guard still holds a widening change after the restore approval', async (t) => {
  const client = await schemaClient(t);
  // The source was more open than today: restoring it widens sharing.
  const { requester, approver } = await people(client);
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'existingExternalUserSharingOnly', sharingAllowedDomainList: [] };
  const { result, graph, artifactId } = await dryRun(client, live, { requestedBy: requester });
  assert.ok(result.workloadRestore.contentEffects.length > 0);
  await approve(client, artifactId, { requestedBy: requester, decidedBy: approver });

  await assert.rejects(promote(graph, artifactId), /SharePoint restore blocked-content-effect/);
  assert.deepEqual(graph.writes(), []);

  await approveContentEffects(client, {
    tenantRef: TENANT, artifactId, approverId: approver,
    effectsDigest: contentEffectsDigest(result.workloadRestore.contentEffects), justification: 'partner access agreed with the data owner',
  });
  assert.equal((await promote(graph, artifactId)).outcome, 'verified');
  assert.equal(graph.state.settings.sharingCapability, 'externalUserSharingOnly');
});

test('an unqualified write sends nothing, and a restorer from another tenant is refused', async (t) => {
  const client = await schemaClient(t);
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'externalUserAndGuestSharing' };
  const { requester, approver } = await people(client);
  const { graph, artifactId } = await dryRun(client, live, { requestedBy: requester });
  await approve(client, artifactId, { requestedBy: requester, decidedBy: approver });

  await assert.rejects(promote(graph, artifactId, { qualifications: () => ({}) }), /SharePoint restore disabled/);
  await assert.rejects(promote(graph, artifactId, {
    paths: { collectorConfig: '/fixtures/other-collector.json', targetConfig: '/fixtures/other-restorer.json' },
  }), /different tenant/);
  await assert.rejects(promote(graph, artifactId, {
    paths: { collectorConfig: '/fixtures/collector.json', targetConfig: '/fixtures/other-restorer.json' },
  }), /Collector tenantId must match the Restorer tenantId/);
  assert.deepEqual(graph.writes(), []);
});

test('promotion dispatches each workload artifact to its own execute function', async (t) => {
  const client = await schemaClient(t);
  const calls = [];
  const { requester, approver } = await people(client);
  const fakeRestores = Object.fromEntries(Object.entries(WORKLOAD_RESTORES).map(([name, entry]) => [name, {
    ...entry,
    execute: async (_client, { artifactId, tenantId, plan }) => {
      calls.push({ workload: name, artifactId, tenantId, planWorkload: plan.workload });
      return { outcome: 'verified', operations: [], reasons: [] };
    },
  }]));
  for (const workload of Object.keys(WORKLOAD_RESTORES)) {
    const id = crypto.randomUUID();
    await createDryRunArtifact(client, {
      id, tenantRef: TENANT, snapshotId: null, selection: [workload], closureKeys: [workload], targetTenantId: TENANT_ID,
      collectorConfigPath: `workload:${workload}`, targetConfigPath: `workload:${workload}`, reconciliationResources: null,
      waves: [], patches: [], guardRefusals: [], results: {}, currentStateFingerprint: 'f', digest: 'd', status: 'completed',
      requestedBy: requester, workloadRestore: { workload, operations: [] },
    });
    await assert.rejects(runRestore({
      artifactId: id, mode: 'enforce', readFile, dbUrl: database.url, logger: quiet,
      dependencies: { ...cliDependencies(fakeSharePoint({})).dependencies, workloadRestores: fakeRestores },
    }), /needs an approved request/);
    await approve(client, id, { requestedBy: requester, decidedBy: approver });
    const result = await runRestore({
      artifactId: id, mode: 'enforce', readFile, dbUrl: database.url, logger: quiet,
      dependencies: { ...cliDependencies(fakeSharePoint({})).dependencies, workloadRestores: fakeRestores },
    });
    assert.equal(result.outcome, 'verified');
    assert.deepEqual(calls.at(-1), { workload, artifactId: id, tenantId: TENANT_ID, planWorkload: workload });
  }
  assert.deepEqual(calls.map((call) => call.workload), Object.keys(WORKLOAD_RESTORES));
});

// Issue #542 (operator Q149): Exchange and Purview refuse the Graph configs, which name
// no organization, so a workload restore's PowerShell connects with its family's file
// from the workload scope: the collector file for the dry run, the restorer file for
// the promotion. The Graph identity stays the server's collector and restorer.
const FAMILY_FILES = {
  '/etc/keel/exchange-collector.json': { tenantId: TENANT_ID, clientId: 'collector', organization: 'contoso.onmicrosoft.com' },
  '/etc/keel/exchange-restorer.json': { tenantId: TENANT_ID, clientId: 'restorer', organization: 'contoso.onmicrosoft.com' },
  '/etc/keel/purview-collector.json': { tenantId: TENANT_ID, clientId: 'purview-collector', organization: 'contoso.onmicrosoft.com' },
  '/etc/keel/purview-restorer.json': { tenantId: TENANT_ID, clientId: 'purview-restorer', organization: 'contoso.onmicrosoft.com' },
  '/etc/keel/other-tenant-restorer.json': { tenantId: OTHER_TENANT_ID, clientId: 'restorer', organization: 'fabrikam.onmicrosoft.com' },
};
for (const [path, value] of Object.entries(FAMILY_FILES)) configs.set(path, JSON.stringify(value));
const FAMILY_SCOPE = {
  powershellConfigs: { exchange: '/etc/keel/exchange-collector.json', purview: '/etc/keel/purview-collector.json' },
  powershellRestorerConfigs: { exchange: '/etc/keel/exchange-restorer.json', purview: '/etc/keel/purview-restorer.json' },
};

test('a workload restore connects PowerShell with the family file from the workload scope (#542)', async (t) => {
  const client = await schemaClient(t);
  const { requester, approver } = await people(client);
  const planned = [];
  const executed = [];
  const fakeRestores = Object.fromEntries(Object.entries(WORKLOAD_RESTORES).map(([name, entry]) => [name, {
    ...entry,
    plan: async (_client, { connection }) => { planned.push(connection); return { workload: name, operations: [], manual: [], refusals: [] }; },
    create: async () => ({ id: crypto.randomUUID(), status: 'completed' }),
    execute: async (_client, { connection }) => { executed.push(connection); return { outcome: 'verified', operations: [], reasons: [] }; },
  }]));
  const expected = {
    'exchange-mail-flow': ['/etc/keel/exchange-collector.json', '/etc/keel/exchange-restorer.json'],
    'exchange-mailbox-settings': ['/etc/keel/exchange-collector.json', '/etc/keel/exchange-restorer.json'],
    'exchange-extended': ['/etc/keel/exchange-collector.json', '/etc/keel/exchange-restorer.json'],
    'purview-labels': ['/etc/keel/purview-collector.json', '/etc/keel/purview-restorer.json'],
    'purview-retention-dlp': ['/etc/keel/purview-collector.json', '/etc/keel/purview-restorer.json'],
    'purview-governance': ['/etc/keel/purview-collector.json', '/etc/keel/purview-restorer.json'],
    // A family the scope leaves out keeps the role's own file.
    'teams-org-policies': [null, null],
  };
  for (const [workload, [collectorPath, restorerPath]] of Object.entries(expected)) {
    const deps = cliDependencies(fakeSharePoint({}), { scope: FAMILY_SCOPE });
    await main({
      argv: ['node', 'keel-restore.mjs', '--workload', workload, '--collection', '1', '--requested-by', requester],
      readFile, dbUrl: database.url, dependencies: { ...deps.dependencies, credentialPaths: () => SERVER_PATHS, workloadRestores: fakeRestores }, logger: quiet,
    });
    assert.deepEqual(deps.connections.map((c) => [c.role, c.configPath, c.powershellConfigPath]),
      [['collector', SERVER_PATHS.collectorConfig, collectorPath]], workload);

    const id = crypto.randomUUID();
    await createDryRunArtifact(client, {
      id, tenantRef: TENANT, snapshotId: null, selection: [workload], closureKeys: [workload], targetTenantId: TENANT_ID,
      collectorConfigPath: `workload:${workload}`, targetConfigPath: `workload:${workload}`, reconciliationResources: null,
      waves: [], patches: [], guardRefusals: [], results: {}, currentStateFingerprint: 'f', digest: 'd', status: 'completed',
      requestedBy: requester, workloadRestore: { workload, operations: [] },
    });
    await approve(client, id, { requestedBy: requester, decidedBy: approver });
    const promoted = cliDependencies(fakeSharePoint({}), { scope: FAMILY_SCOPE });
    const result = await runRestore({
      artifactId: id, mode: 'enforce', readFile, dbUrl: database.url, logger: quiet,
      dependencies: { ...promoted.dependencies, workloadRestores: fakeRestores },
    });
    assert.equal(result.outcome, 'verified');
    assert.deepEqual(promoted.connections.map((c) => [c.role, c.clientId, c.configPath, c.powershellConfigPath]),
      [['restorer', 'restorer', SERVER_PATHS.targetConfig, restorerPath]], workload);
  }
  assert.equal(planned.length, Object.keys(expected).length);
  assert.equal(executed.length, Object.keys(expected).length);
});

test('a family restorer file for another tenant, or the collector registration, is refused before connecting (#542)', async (t) => {
  const client = await schemaClient(t);
  const { requester, approver } = await people(client);
  const workload = 'exchange-mail-flow';
  const id = crypto.randomUUID();
  await createDryRunArtifact(client, {
    id, tenantRef: TENANT, snapshotId: null, selection: [workload], closureKeys: [workload], targetTenantId: TENANT_ID,
    collectorConfigPath: `workload:${workload}`, targetConfigPath: `workload:${workload}`, reconciliationResources: null,
    waves: [], patches: [], guardRefusals: [], results: {}, currentStateFingerprint: 'f', digest: 'd', status: 'completed',
    requestedBy: requester, workloadRestore: { workload, operations: [] },
  });
  await approve(client, id, { requestedBy: requester, decidedBy: approver });
  const enforce = (powershellRestorerConfigs) => {
    const deps = cliDependencies(fakeSharePoint({}), { scope: { powershellConfigs: FAMILY_SCOPE.powershellConfigs, powershellRestorerConfigs } });
    return { deps, run: runRestore({ artifactId: id, mode: 'enforce', readFile, dbUrl: database.url, logger: quiet, dependencies: deps.dependencies }) };
  };
  const otherTenant = enforce({ exchange: '/etc/keel/other-tenant-restorer.json' });
  await assert.rejects(otherTenant.run, /names another tenant/);
  assert.deepEqual(otherTenant.deps.connections, []);
  const sameApp = enforce({ exchange: '/etc/keel/exchange-collector.json' });
  await assert.rejects(sameApp.run, /separate Restorer/);
  assert.deepEqual(sameApp.deps.connections, []);
});

// ------------------------------------------------------- stored qualification

const DAY_MS = 24 * 60 * 60 * 1000;
const descriptor = (id) => WORKLOAD_DESCRIPTORS.find((item) => item.id === id);

/** The SharePoint live proof as the import stores it: every read, and the one write. */
function sharePointProof(tenantRef, capturedAt) {
  const proofRef = 'sharepoint-live-acceptance@sha256:fixture';
  return [
    ...SHAREPOINT_OPERATIONS.map((id) => ({
      operationId: id, kind: 'live-capture', synthetic: false, tenantRef, capturedAt,
      version: descriptor(id).operation.version, ok: true, error: null, observed: { pages: 1 }, proofRef,
    })),
    {
      operationId: SHAREPOINT_WRITE_OPERATION, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt,
      version: 'v1.0', ok: true, readBackVerified: true, proofRef,
    },
  ];
}
const collectorGrants = () => ({
  permissions: [...new Set(SHAREPOINT_OPERATIONS.flatMap((id) => descriptor(id).rbac.permissions))],
  roles: [...new Set(SHAREPOINT_OPERATIONS.flatMap((id) => descriptor(id).rbac.roles))],
});

test('by default a promotion reads the stored ledger: no live write capture sends nothing, a stored one writes', async (t) => {
  const client = await schemaClient(t);
  const live = { ...SOURCE_SETTINGS, sharingCapability: 'externalUserAndGuestSharing' };
  const { requester, approver } = await people(client);
  const { graph, artifactId } = await dryRun(client, live, { requestedBy: requester });
  await approve(client, artifactId, { requestedBy: requester, decidedBy: approver });
  const stored = () => {
    const { dependencies } = cliDependencies(graph);
    delete dependencies.workloadQualifications;
    return dependencies;
  };
  const enforce = () => runRestore({ artifactId, mode: 'enforce', readFile, dbUrl: database.url, dependencies: stored(), logger: quiet });

  // Nothing stored for this tenant: the write stays disabled.
  await assert.rejects(enforce(), /SharePoint restore disabled/);
  assert.deepEqual(graph.writes(), []);

  // A live read and write capture stored for this tenant enables it.
  const capturedAt = new Date(Date.now() - DAY_MS).toISOString();
  await saveLedgerInputs(client, { tenantRef: TENANT, evidence: sharePointProof(TENANT, capturedAt), grants: collectorGrants() });
  const result = await enforce();
  assert.equal(result.outcome, 'verified');
  assert.deepEqual(graph.writes().map((w) => `${w.method} ${w.url}`), [`PATCH ${SETTINGS_URL}`]);
  assert.equal(graph.state.settings.sharingCapability, 'externalUserSharingOnly');
});

test('the stored qualification applies the 30-day, grant and per-operation rules at the moment of the run', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = `sha256:wq-${crypto.randomUUID()}`;
  const capturedAt = '2026-10-10T00:00:00.000Z';
  const operations = [SHAREPOINT_WRITE_OPERATION, 'teams.settings.update', 'exchange.client-access.update'];

  // A database without stored proof: every operation answers, and none is enabled.
  const none = await defaultWorkloadQualifications(client, { tenantRef, operations, now: new Date('2026-10-12T00:00:00Z') });
  assert.deepEqual(Object.keys(none), operations);
  for (const id of operations) {
    assert.equal(none[id].operationId, id);
    assert.equal(none[id].enabled, false, id);
    assert.ok(none[id].reasons.includes('no proof yet'), id);
  }

  await saveLedgerInputs(client, { tenantRef, evidence: sharePointProof(tenantRef, capturedAt), grants: collectorGrants() });
  const fresh = await defaultWorkloadQualifications(client, { tenantRef, operations, now: new Date('2026-10-12T00:00:00Z') });
  assert.equal(fresh[SHAREPOINT_WRITE_OPERATION].state, 'live-qualified');
  assert.equal(fresh[SHAREPOINT_WRITE_OPERATION].enabled, true);
  // SharePoint proof is never Teams proof.
  assert.equal(fresh['teams.settings.update'].enabled, false);
  assert.equal(fresh['teams.settings.update'].state, 'disabled');
  // A write that needs the restorer's grants stays off while they are unknown.
  assert.ok(fresh['exchange.client-access.update'].reasons.some((reason) => /grants are unknown/.test(reason)));
  assert.equal(fresh['exchange.client-access.update'].enabled, false);

  // The same stored capture lapses after 30 days: the ledger is rebuilt per run.
  const later = await defaultWorkloadQualifications(client, { tenantRef, operations, now: new Date('2026-11-10T00:00:00Z') });
  assert.equal(later[SHAREPOINT_WRITE_OPERATION].enabled, false);
  assert.ok(later[SHAREPOINT_WRITE_OPERATION].reasons.some((reason) => /older than 30 days/.test(reason)));

  // Another tenant's stored proof never qualifies this one.
  const other = await defaultWorkloadQualifications(client, { tenantRef: `sha256:wq-${crypto.randomUUID()}`, operations, now: new Date('2026-10-12T00:00:00Z') });
  assert.equal(other[SHAREPOINT_WRITE_OPERATION].enabled, false);
});

test('every WKLD write stays disabled by default until a live capture is stored for it', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = `sha256:wq-${crypto.randomUUID()}`;
  await saveLedgerInputs(client, { tenantRef, evidence: sharePointProof(tenantRef, new Date(Date.now() - DAY_MS).toISOString()), grants: collectorGrants() });
  for (const [workload, entry] of Object.entries(WORKLOAD_RESTORES)) {
    const answers = await defaultWorkloadQualifications(client, { tenantRef, operations: entry.operations });
    assert.deepEqual(Object.keys(answers), [...entry.operations], workload);
    for (const id of entry.operations) {
      if (id === SHAREPOINT_WRITE_OPERATION) continue;
      assert.equal(answers[id].enabled, false, `${workload} ${id}`);
    }
  }
});
