// Gap register W2: a workload restore runs through cli/keel-restore.mjs.
//
// Acceptance:
//  - `--workload <name>` plans a dry run from a recorded collection and persists it;
//  - promoting that artifact needs an approved request from someone other than the
//    requester, and then dispatches to that workload's own execute function;
//  - the content-effect guard and the write qualification still apply;
//  - a workload artifact never has its `workload:<name>` marker read as a file.
//
// Everything runs against the isolated test database, an in-memory fake Graph and
// fake credential files. No tenant is read or written.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { recordSharePointRun } from '../collect/workloads/sharepoint.mjs';
import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { approveRequest, requestApproval, SelfApprovalError } from '../govern/approvals.mjs';
import { createDryRunArtifact, getDryRunArtifactById } from '../restore/dryRunArtifact.mjs';
import { WORKLOAD_RESTORES } from '../restore/workloads/dispatch.mjs';
import { SHAREPOINT_WRITE_OPERATION } from '../restore/workloads/sharepoint.mjs';
import { approveContentEffects, contentEffectsDigest } from '../safety/contentEffects.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { main, runRestore } from '../../cli/keel-restore.mjs';

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
function cliDependencies(graph, { qualifications = qualified, paths = SERVER_PATHS } = {}) {
  const connections = [];
  return {
    connections,
    dependencies: {
      workloadConnection: async ({ role, config, configPath }) => {
        connections.push({ role, clientId: config.clientId, configPath });
        return { transport: graph.transport, powershell: {} };
      },
      workloadQualifications: async () => qualifications(),
      credentialPaths: () => paths,
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

async function dryRun(client, live, { requestedBy = 'requester', options } = {}) {
  const collectionId = await recordSource(client);
  const graph = fakeSharePoint(live);
  const deps = cliDependencies(graph, options);
  const artifactId = crypto.randomUUID();
  const result = await main({
    argv: [
      'node', 'keel-restore.mjs', '--workload', 'sharepoint-site-settings', '--collection', String(collectionId),
      '--tenant-host', HOST, '--collector-config', '/fixtures/collector.json',
      '--persist-artifact', artifactId, '--requested-by', requestedBy,
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
