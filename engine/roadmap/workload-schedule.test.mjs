// Gap register W1 and W3: scheduled workload collection and live proof expiry.
//
// Acceptance:
//  - the ledger inputs (evidence rows and grants) persist, and the ledger rebuilt from
//    them matches the in-memory ledger built from the same inputs;
//  - a `workload-collect` schedule is valid, seeded daily, and its job kind is accepted
//    by the schema, mapped to the collect capability and dispatched by the worker;
//  - a scheduled run with no stored proof records `disabled` for every workload and
//    sends no request;
//  - with stored SharePoint proof the run writes a `complete` SharePoint snapshot with
//    observations, using GET requests only, and every later workload stays disabled;
//  - a collector that throws is recorded as `failed` and the next workload still runs;
//  - the coverage report and the `proof` command say when each live proof expires.
// Mutation checks:
//  - store fixture or cross-tenant evidence as live;
//  - let the run send a write;
//  - report an expired proof as current.
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { capabilityForJobKind } from '../authz/jobCapabilities.mjs';
import { WORKLOAD_DESCRIPTORS, WORKLOADS, buildWorkloadLedger } from '../collect/workloadContract.mjs';
import {
  PROOF_EXPIRY_WARNING_DAYS, loadLedgerInputs, loadWorkloadLedger, proofExpiry, saveLedgerInputs,
} from '../collect/workloadLedgerStore.mjs';
import { SHAREPOINT_OPERATIONS } from '../collect/workloads/sharepoint.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { enqueue } from '../jobs/queue.mjs';
import { nextDueAt, validateSchedule } from '../schedules/cadence.mjs';
import { initialSchedules } from '../store/scheduleSeed.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import {
  POWERSHELL_FAMILY, importLedgerInputs, importSeams, main, powershellConfigPaths, powershellFor, readOnlyGraphTransport,
  runWorkloadCollection,
} from '../../cli/keel-workload-collect.mjs';
import { JOB_HANDLERS } from '../../cli/keel-worker.mjs';
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

const tenant = () => `sha256:w1-${crypto.randomUUID()}`;
const CAPTURED = '2026-10-07T11:09:31.077Z';
const NOW = new Date('2026-10-12T09:00:00Z');
const HOST = 'contoso.sharepoint.com';
const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const PROOF = 'sharepoint-live-acceptance@sha256:fixture';
const descriptor = (id) => WORKLOAD_DESCRIPTORS.find((item) => item.id === id);

function sharePointProof(tenantRef, { capturedAt = CAPTURED } = {}) {
  const reads = SHAREPOINT_OPERATIONS.map((id) => ({
    operationId: id, kind: 'live-capture', synthetic: false, tenantRef, capturedAt,
    version: descriptor(id).operation.version, ok: true, error: null, observed: { pages: 1 }, proofRef: PROOF,
  }));
  const writes = [{
    operationId: 'sharepoint.tenant-settings.update', kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt,
    version: 'v1.0', ok: true, readBackVerified: true, proofRef: PROOF,
  }];
  const grants = {
    permissions: [...new Set(SHAREPOINT_OPERATIONS.flatMap((id) => descriptor(id).rbac.permissions))],
    roles: [...new Set(SHAREPOINT_OPERATIONS.flatMap((id) => descriptor(id).rbac.roles))],
  };
  return { reads, writes, grants };
}

/** A fake SharePoint Graph that records every request and its method. */
function fakeGraph() {
  const requests = [];
  const siteId = `${HOST},00000001-0000-4000-8000-000000000001,00000101-0000-4000-8000-000000000101`;
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init?.method ?? 'GET', auth: init?.headers?.authorization });
    const path = decodeURIComponent(new URL(url).pathname).replace('/v1.0', '');
    let status = 200;
    let body;
    if (path === '/admin/sharepoint/settings') {
      body = { sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'none', sharingAllowedDomainList: [], sharingBlockedDomainList: [], isResharingByExternalUsersEnabled: false };
    } else if (path === '/sites/getAllSites') {
      body = { value: [{ id: siteId, webUrl: `https://${HOST}/sites/one`, displayName: 'One' }] };
    } else if (path === `/sites/${siteId}/permissions`) {
      body = { value: [] };
    } else if (path === `/sites/${siteId}`) {
      body = { id: siteId, name: 'one', displayName: 'One', webUrl: `https://${HOST}/sites/one`, createdDateTime: '2025-01-01T00:00:00Z', lastModifiedDateTime: '2026-10-01T00:00:00Z', siteCollection: { hostname: HOST } };
    } else { status = 404; body = { error: { code: 'itemNotFound' } }; }
    return { status, headers: new Headers(), text: async () => JSON.stringify(body) };
  };
  return { requests, fetchImpl };
}

const silent = { log() {} };
let tick = Date.parse('2026-10-12T02:00:00Z');
const clock = () => new Date((tick += 1000));

test('ledger inputs persist, and the rebuilt ledger matches the in-memory one', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const { reads, writes, grants } = sharePointProof(tenantRef);
  const restorerGrants = { permissions: ['SharePointTenantSettings.ReadWrite.All'], roles: ['SharePoint Administrator'] };
  const runtime = { modules: { ExchangeOnlineManagement: '3.7.0' } };
  await saveLedgerInputs(client, { tenantRef, evidence: [...reads, ...writes], grants, restorerGrants, runtime });
  // Re-importing the same proof replaces its rows rather than doubling them.
  await saveLedgerInputs(client, { tenantRef, evidence: [...reads, ...writes], grants, restorerGrants, runtime });

  const stored = await loadLedgerInputs(client, { tenantRef });
  assert.equal(stored.reads.length, SHAREPOINT_OPERATIONS.length);
  assert.equal(stored.writes.length, 1);
  assert.equal(stored.writes[0].readBackVerified, true);
  assert.deepEqual(stored.grants, { permissions: [...grants.permissions].sort(), roles: [...grants.roles].sort() });
  assert.deepEqual(stored.restorerGrants, restorerGrants);
  assert.deepEqual(stored.runtime, runtime);

  const { ledger } = await loadWorkloadLedger(client, { tenantRef, now: NOW });
  const memory = buildWorkloadLedger({ evidence: reads, grants, runtime, tenantRef, now: NOW });
  assert.deepEqual(ledger.rows.map((row) => [row.id, row.state, row.enabled]), memory.rows.map((row) => [row.id, row.state, row.enabled]));
  for (const id of SHAREPOINT_OPERATIONS) assert.equal(ledger.rows.find((row) => row.id === id).enabled, true, id);
  // The ledger is rebuilt at run time, so the 30-day rule applies on every run.
  const { ledger: later } = await loadWorkloadLedger(client, { tenantRef, now: new Date('2026-11-07T00:00:00Z') });
  for (const id of SHAREPOINT_OPERATIONS) assert.equal(later.rows.find((row) => row.id === id).enabled, false, id);

  // Another tenant sees none of it.
  assert.deepEqual((await loadLedgerInputs(client, { tenantRef: tenant() })).reads, []);
});

test('fixture, synthetic-kind and cross-tenant evidence is never stored as live proof', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const [read] = sharePointProof(tenantRef).reads;
  await assert.rejects(saveLedgerInputs(client, { tenantRef, evidence: [{ ...read, kind: 'fixture' }] }), /only live captures are stored/);
  await assert.rejects(saveLedgerInputs(client, { tenantRef, evidence: [{ ...read, tenantRef: tenant() }] }), /another tenant/);
  assert.deepEqual((await loadLedgerInputs(client, { tenantRef })).reads, []);
  // A stored synthetic row still never qualifies: the ledger applies its own rules.
  await saveLedgerInputs(client, { tenantRef, evidence: [{ ...read, synthetic: true }] });
  const { ledger } = await loadWorkloadLedger(client, { tenantRef, now: NOW });
  assert.notEqual(ledger.rows.find((row) => row.id === read.operationId).state, 'live-qualified');
});

test('workload-collect is a valid daily schedule, a schema job kind, a collect capability and a worker dispatch', async (t) => {
  const client = await schemaClient(t);
  const seed = initialSchedules(new Date('2026-10-12T09:00:00Z')).find((row) => row.jobKind === 'workload-collect');
  assert.deepEqual(seed.cadence, { every: 'day', n: 1, atTime: '02:00' });
  assert.equal(seed.nextDueAt.toISOString(), '2026-10-13T02:00:00.000Z');
  const row = { job_kind: 'workload-collect', tier: null, cadence: seed.cadence, cron_override: null };
  assert.doesNotThrow(() => validateSchedule(row));
  assert.equal(nextDueAt(row, seed.nextDueAt).toISOString(), '2026-10-14T02:00:00.000Z');
  assert.throws(() => validateSchedule({ ...row, tier: 'tier1' }), /invalid schedule tier/);
  assert.throws(() => validateSchedule({ ...row, cadence: null, cron_override: '*/30 * * * *' }), /schedule_minimum_interval/);

  assert.equal(capabilityForJobKind('workload-collect'), 'collect');
  const job = await enqueue(client, { kind: 'workload-collect', params: { tenantRef: 'sha256:x' }, requestedBy: 'scheduler-test', idempotencyKey: `w1-${crypto.randomUUID()}` });
  assert.equal(job.kind, 'workload-collect', 'the schema CHECK accepts the kind');

  const handler = JOB_HANDLERS['workload-collect'];
  assert.ok(handler.script.endsWith('cli/keel-workload-collect.mjs'));
  assert.deepEqual(handler.argsFor({ tenantRef: 'sha256:x' }), ['run', '--tenant-ref', 'sha256:x']);
  assert.deepEqual(handler.argsFor({ config: '/etc/keel/tenant.json', scope: '/etc/keel/workload-scope.json' }),
    ['run', '--config', '/etc/keel/tenant.json', '--scope', '/etc/keel/workload-scope.json']);
  assert.throws(() => handler.argsFor({ tenantRef: 'sha256:x', confirm: true }), /may contain only/);
});

test('with no stored proof, a scheduled run records disabled for every workload and sends nothing', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const graph = fakeGraph();
  let tokens = 0;
  const transport = readOnlyGraphTransport(async () => { tokens += 1; return 'token'; }, graph.fetchImpl);
  const result = await runWorkloadCollection(client, {
    tenantRef, config: { tenantId: TENANT_ID }, scope: { sharepointHost: HOST }, transport,
    powershell: { spawnFn() { throw new Error('no container may start'); } }, now: clock, logger: silent,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.runs.map((run) => run.workload).sort(), [...WORKLOADS].sort());
  assert.ok(result.runs.every((run) => run.outcome === 'disabled'), JSON.stringify(result.runs));
  assert.deepEqual([graph.requests.length, tokens], [0, 0], 'no token and no request without qualification');
  const { rows } = await client.query('SELECT workload, outcome FROM workload_collection WHERE tenant_ref = $1', [tenantRef]);
  assert.equal(rows.length, WORKLOADS.length);
});

test('with stored SharePoint proof the run writes a complete SharePoint snapshot using GET only', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const { reads, writes, grants } = sharePointProof(tenantRef);
  await saveLedgerInputs(client, { tenantRef, evidence: [...reads, ...writes], grants });
  const graph = fakeGraph();
  const transport = readOnlyGraphTransport(async () => 'token', graph.fetchImpl);
  const lines = [];
  const result = await runWorkloadCollection(client, {
    tenantRef, config: { tenantId: TENANT_ID }, scope: { sharepointHost: HOST }, transport, now: clock,
    logger: { log: (line) => lines.push(line) },
  });
  const sharePoint = result.runs.find((run) => run.workload === 'sharepoint-site-settings');
  assert.equal(sharePoint.outcome, 'complete', JSON.stringify(sharePoint));
  for (const run of result.runs.filter((item) => item.workload !== 'sharepoint-site-settings')) {
    assert.equal(run.outcome, 'disabled', run.workload);
  }
  assert.equal(result.exitCode, 0);
  assert.ok(graph.requests.length > 0);
  assert.ok(graph.requests.every((request) => request.method === 'GET' && request.auth === 'Bearer token'));
  const { rows } = await client.query(
    'SELECT resource_key FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [sharePoint.collectionId],
  );
  assert.deepEqual(rows.map((row) => row.resource_key), [`site:${HOST},00000001-0000-4000-8000-000000000001,00000101-0000-4000-8000-000000000101`, 'tenant']);
  assert.equal(result.proof.length, 1);
  assert.equal(result.proof[0].status, 'current');
});

test('a collector that throws is recorded as failed, and the next workload still runs', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const { reads, writes, grants } = sharePointProof(tenantRef);
  await saveLedgerInputs(client, { tenantRef, evidence: [...reads, ...writes], grants });
  const graph = fakeGraph();
  const result = await runWorkloadCollection(client, {
    tenantRef, config: { tenantId: TENANT_ID }, scope: {}, transport: readOnlyGraphTransport(async () => 'token', graph.fetchImpl),
    now: clock, logger: silent,
  });
  const sharePoint = result.runs.find((run) => run.workload === 'sharepoint-site-settings');
  assert.equal(sharePoint.outcome, 'failed');
  assert.match(sharePoint.reasons[0], /tenantHost must be/);
  assert.equal(result.runs.length, WORKLOADS.length);
  assert.equal(result.exitCode, 1);
  const report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [], now: NOW });
  assert.equal(report.workloads.find((item) => item.workload === 'sharepoint-site-settings').status, 'failed');
});

test('each PowerShell workload connects with its own family config from the scope file', () => {
  // Every workload but the two Graph ones and the Power Platform REST one runs PowerShell, and each has a family.
  const graphOnly = new Set(['sharepoint-site-settings', 'teams-settings', 'power-platform-settings']);
  assert.deepEqual(Object.keys(POWERSHELL_FAMILY).sort(), WORKLOADS.filter((id) => !graphOnly.has(id)).sort());

  const files = {
    '/etc/keel/exchange-collector.json': JSON.stringify({ tenantId: TENANT_ID, organization: 'contoso.onmicrosoft.com' }),
    '/etc/keel/purview-collector.json': JSON.stringify({ organization: 'contoso.onmicrosoft.com' }),
    '/etc/keel/other-tenant.json': JSON.stringify({ tenantId: '99999999-2222-4333-8444-555555555555' }),
  };
  const readFile = (path) => files[path];
  const config = { tenantId: TENANT_ID };
  const scope = {
    powershellConfigs: powershellConfigPaths({
      powershellConfigs: { exchange: '/etc/keel/exchange-collector.json', purview: '/etc/keel/purview-collector.json' },
    }, { config, readFile }),
  };
  const base = { tenantConfigPath: '/etc/keel/tenant.json', image: 'keel-ps' };
  assert.equal(powershellFor('exchange-mailbox-settings', { scope, powershell: base }).tenantConfigPath, '/etc/keel/exchange-collector.json');
  assert.equal(powershellFor('exchange-mail-flow', { scope, powershell: base }).tenantConfigPath, '/etc/keel/exchange-collector.json');
  assert.equal(powershellFor('purview-labels', { scope, powershell: base }).tenantConfigPath, '/etc/keel/purview-collector.json');
  assert.equal(powershellFor('purview-retention-dlp', { scope, powershell: base }).image, 'keel-ps');
  // A family the scope file leaves out keeps the tenant config, as before.
  assert.equal(powershellFor('onedrive-site-settings', { scope, powershell: base }).tenantConfigPath, '/etc/keel/tenant.json');
  assert.equal(powershellFor('teams-org-policies', { scope: {}, powershell: base }).tenantConfigPath, '/etc/keel/tenant.json');

  // Misconfigured hosts fail loudly instead of connecting elsewhere.
  const check = (powershellConfigs) => () => powershellConfigPaths({ powershellConfigs }, { config, readFile });
  assert.throws(check({ exchange: '/etc/keel/other-tenant.json' }), /another tenant/);
  assert.throws(check({ exchange: '/home/keel/exchange.json' }), /under \/etc\/keel\//);
  assert.throws(check({ exchange: '/etc/keel/../shadow' }), /under \/etc\/keel\//);
  assert.throws(check({ sharepoint: '/etc/keel/exchange-collector.json' }), /not a PowerShell family/);
  assert.throws(check(['/etc/keel/exchange-collector.json']), /must be an object/);
  assert.deepEqual(powershellConfigPaths({}, { config, readFile }), {});
});

test('the Graph transport refuses writes and other hosts before sending', async () => {
  let sent = 0;
  const transport = readOnlyGraphTransport(async () => 'token', async () => { sent += 1; throw new Error('sent'); });
  await assert.rejects(transport('https://graph.microsoft.com/v1.0/admin/sharepoint/settings', { method: 'PATCH', body: {} }), /read-only/);
  await assert.rejects(transport('https://graph.microsoft.com/v1.0/admin/sharepoint/settings', { body: {} }), /read-only/);
  await assert.rejects(transport('https://contoso.sharepoint.com/_api/web'), /Microsoft Graph only/);
  assert.equal(sent, 0);
});

test('proof expiry: "expires in N days", a warning inside 14 days, expired after 30', () => {
  const items = sharePointProof('sha256:t').reads;
  const at = (iso) => proofExpiry(items, { now: new Date(iso) })[0];
  const current = at('2026-10-12T09:00:00Z');
  assert.deepEqual([current.status, current.daysLeft, current.expiresAt], ['current', 25, '2026-11-06T11:09:31.077Z']);
  assert.equal(current.gate, 'sharepoint-live-acceptance');
  assert.match(current.message, /expires in 25 days \(2026-11-06\)/);
  assert.deepEqual(current.operations, [...SHAREPOINT_OPERATIONS].sort());
  const expiring = at('2026-10-25T00:00:00Z');
  assert.equal(expiring.status, 'expiring');
  assert.ok(expiring.daysLeft < PROOF_EXPIRY_WARNING_DAYS);
  assert.match(expiring.message, /Recapture it before then/);
  const expired = at('2026-11-06T11:09:31.078Z');
  assert.equal(expired.status, 'expired');
  assert.match(expired.message, /expired on 2026-11-06/);
  // The oldest capture in a proof sets its expiry; synthetic rows never count.
  const mixed = proofExpiry([{ ...items[0], capturedAt: '2026-10-01T00:00:00Z' }, ...items.slice(1), { ...items[0], proofRef: 'fixture@x', synthetic: true }], { now: NOW });
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].expiresAt, '2026-10-31T00:00:00.000Z');
});

test('the coverage report and the proof command surface expiry', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const { reads, writes, grants } = sharePointProof(tenantRef);
  const empty = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [], now: NOW });
  assert.deepEqual(empty.workloadProof, []);
  await saveLedgerInputs(client, { tenantRef, evidence: [...reads, ...writes], grants });
  const report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [], now: NOW });
  assert.equal(report.workloadProof.length, 1);
  assert.equal(report.workloadProof[0].daysLeft, 25);
  assert.match(report.workloadProof[0].message, /expires in 25 days/);

  // The CLI's proof command exits 1 once a proof is inside the warning window.
  const lines = [];
  const config = JSON.stringify({ tenantId: TENANT_ID });
  const tenantRefForConfig = (await import('../store/tenantRef.mjs')).tenantRefFor(TENANT_ID);
  await client.query('DELETE FROM workload_ledger_evidence WHERE tenant_ref = $1', [tenantRefForConfig]);
  const recent = sharePointProof(tenantRefForConfig, { capturedAt: new Date(Date.now() - 2 * 86400000).toISOString() });
  await saveLedgerInputs(client, { tenantRef: tenantRefForConfig, evidence: recent.reads, grants: recent.grants });
  const options = { readFile: () => config, connectFn: async () => client, logger: { log: (line) => lines.push(line) } };
  const fakeEnd = client.end.bind(client);
  client.end = async () => {};
  try {
    assert.equal(await main(['proof', '--db-url', 'postgres://unused'], options), 0);
    assert.match(lines.join('\n'), /expires in 2[78] days/);
    await client.query('UPDATE workload_ledger_evidence SET captured_at = now() - interval \'20 days\' WHERE tenant_ref = $1', [tenantRefForConfig]);
    assert.equal(await main(['proof', '--db-url', 'postgres://unused'], options), 1);
    // A run for another tenant than the config names is refused before anything is read.
    await assert.rejects(main(['run', '--tenant-ref', 'sha256:other', '--db-url', 'postgres://unused'], options), /another tenant/);
  } finally {
    client.end = fakeEnd;
  }
});

test('import stores only records that verify; the committed records need the signing key', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const proof = sharePointProof(tenantRef);
  const seams = [
    { file: 'ok.json', seam: () => ({ ok: true, failures: [], ...proof, restorerGrants: { permissions: ['A'], roles: [] }, runtime: { modules: { M: '1' } } }) },
    { file: 'bad.json', seam: () => ({ ok: false, failures: ['signature does not verify'], reads: [], writes: [], grants: null }) },
  ];
  const result = await importLedgerInputs(client, { tenantRef, dir: '/nowhere', seams, readFile: () => '{}' });
  assert.deepEqual(result.imported, [{ file: 'ok.json', evidenceBuild: null, reads: SHAREPOINT_OPERATIONS.length, writes: 1 }]);
  assert.deepEqual(result.refused, [{ file: 'bad.json', evidenceBuild: null, failures: ['signature does not verify'] }]);
  assert.equal(result.exitCode, 1);
  const stored = await loadLedgerInputs(client, { tenantRef });
  assert.equal(stored.reads.length, SHAREPOINT_OPERATIONS.length);
  assert.deepEqual(stored.runtime, { modules: { M: '1' } });

  // The real seams on the committed 2026-10-07 records without the signing key: nothing is stored.
  const committedTenant = JSON.parse(readFileSync(new URL('../../docs/release/qualifications/exchange-live-acceptance.json', import.meta.url), 'utf8')).tenantRef;
  await client.query('DELETE FROM workload_ledger_evidence WHERE tenant_ref = $1', [committedTenant]);
  const realDir = new URL('../../docs/release/qualifications/', import.meta.url).pathname;
  const realSeams = await importSeams();
  const real = await importLedgerInputs(client, {
    tenantRef: committedTenant, dir: realDir, seams: realSeams, verify: { hmacKey: null, now: NOW },
  });
  assert.equal(real.imported.length, 0);
  // Every committed record is refused: the four read proofs and each optional writer
  // record captured so far. Optional records not captured yet are absent, not refused.
  const committed = realSeams.filter((entry) => existsSync(join(realDir, entry.file))).map((entry) => entry.file);
  assert.ok(committed.length >= 4);
  assert.deepEqual(real.refused.map((entry) => entry.file).sort(), committed.sort());
  assert.deepEqual((await loadLedgerInputs(client, { tenantRef: committedTenant })).reads, []);
});

test('import adds the roles the collector holds live, so a role granted after capture counts', async (t) => {
  const client = await schemaClient(t);
  const config = JSON.stringify({ tenantId: TENANT_ID, clientId: 'collector-app-id' });
  const tenantRef = (await import('../store/tenantRef.mjs')).tenantRefFor(TENANT_ID);
  const proof = sharePointProof(tenantRef);
  const seams = [{ file: 'ok.json', seam: () => ({ ok: true, failures: [], ...proof, grants: { permissions: ['Sites.FullControl.All'], roles: ['SharePoint Administrator'] } }) }];
  const requests = [];
  const page2 = 'https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?page=2';
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init?.method });
    const { pathname } = new URL(url);
    let body;
    if (pathname.startsWith("/v1.0/servicePrincipals(appId='collector-app-id')")) body = { id: 'sp-1' };
    else if (url === page2) body = { value: [{ directoryScopeId: '/administrativeUnits/au-1', roleDefinition: { displayName: 'User Administrator' } }] };
    else if (pathname === '/v1.0/roleManagement/directory/roleAssignments') {
      assert.equal(new URL(url).searchParams.get('$filter'), "principalId eq 'sp-1'");
      body = { value: [
        { directoryScopeId: '/', roleDefinition: { displayName: 'Teams Administrator' } },
        { directoryScopeId: '/', roleDefinition: { displayName: 'Global Reader' } },
      ], '@odata.nextLink': page2 };
    } else return { status: 404, headers: new Headers(), text: async () => '{}' };
    return { status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
  };
  const lines = [];
  const options = {
    readFile: () => config, connectFn: async () => client, logger: { log: (line) => lines.push(line) }, seams, fetchImpl,
    getTokenFn: async () => ({ accessToken: 'token' }),
  };
  const fakeEnd = client.end.bind(client);
  client.end = async () => {};
  try {
    assert.equal(await main(['import', '--db-url', 'postgres://unused', '--dir', '/nowhere'], options), 0);
  } finally {
    client.end = fakeEnd;
  }
  assert.ok(requests.length === 3 && requests.every((item) => item.method === 'GET'));
  const stored = await loadLedgerInputs(client, { tenantRef });
  // Declared roles stay, live tenant-wide roles are added, a scoped role is not.
  assert.deepEqual(stored.grants.roles, ['Global Reader', 'SharePoint Administrator', 'Teams Administrator']);
  assert.deepEqual(stored.grants.permissions, ['Sites.FullControl.All']);
  assert.equal(JSON.parse(lines.join('\n')).collectorRoles.source, 'declared+live');
  // The Teams policy reads no longer wait on the Teams Administrator role.
  const ledger = buildWorkloadLedger({ evidence: [], grants: stored.grants, tenantRef, now: NOW });
  const teamsRows = ledger.rows.filter((row) => row.workload === 'teams-org-policies');
  assert.ok(teamsRows.length > 0);
  assert.ok(teamsRows.every((row) => !row.prerequisite));

  // A failed live read keeps the declared roles and says why; nothing else changes.
  const failed = await importLedgerInputs(client, {
    tenantRef, dir: '/nowhere', seams, readFile: () => '{}', observeRoles: async () => { throw new Error('reading roles returned HTTP 403'); },
  });
  assert.deepEqual(failed.collectorRoles, { source: 'declared', live: null, error: 'reading roles returned HTTP 403', stored: ['SharePoint Administrator'] });
  assert.equal(failed.exitCode, 0);
  assert.deepEqual((await loadLedgerInputs(client, { tenantRef })).grants.roles, ['SharePoint Administrator']);
});
