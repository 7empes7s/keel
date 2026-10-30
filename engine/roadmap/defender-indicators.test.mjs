// READ-MDE-IOC: Defender for Endpoint indicators, read-only.
//
// Acceptance:
//  - the read is declared in workloadContract.mjs as an admin REST read on
//    api.security.microsoft.com, passes the scope validator and ships disabled;
//  - the transport sends only GETs of the indicators list, with a token for the legacy
//    Defender audience; alerts, devices, hunting and writes are refused before sending;
//  - each indicator is one observation keyed by its id, with declared fields only;
//    duplicates that disagree, unidentified answers and a full 10,000 page are gaps;
//  - nothing is sent until the read is live-qualified, and the ledger names the
//    WindowsDefenderATP Ti.Read.All setup step when a capture is refused;
//  - the live read capture tool captures it through the same transport and its signed
//    record turns the workload on.
// Mutation checks (each was run once and made this file fail):
//  - allow POST in the transport (the read-only assertion fails);
//  - drop the full-page check (the cap test fails).
//
// Everything runs against the isolated test database and a fake API with KEEL-RT-
// fixtures. No tenant is touched.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import {
  DEFENDER_INDICATORS_DESCRIPTOR, DEFENDER_INDICATORS_OPERATION, DEFENDER_INDICATORS_WORKLOAD, DefenderIndicatorsScopeError, PAGE_SIZE,
  collectDefenderIndicators, defenderIndicatorsActivation, defenderIndicatorsTransportFor, readDefenderIndicators,
  readOnlyDefenderIndicatorsTransport,
} from '../collect/workloads/defenderIndicators.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { planWaves } from '../restore/wavePlanner.mjs';
import { runFixtureHarness } from '../../tools/qualification/workloads.mjs';
import { captureWorkloadReads, ledgerEvidenceFromWorkloadReadsAcceptance } from '../../tools/qualification/workloadReadsLive.mjs';
import { WORKLOAD_READS_LIVE_GATE } from '../../tools/qualification/workloadReadsAcceptance.mjs';
import { signEvidence, verifyEvidence } from '../../tools/release/qualification.mjs';
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
let tenantSeq = 0;
const nextTenant = () => `sha256:read-mde-ioc-${tenantSeq += 1}`;
const LIST = 'https://api.security.microsoft.com/api/indicators?$top=10000';
const AUDIENCE = 'https://api.securitycenter.microsoft.com/';

const indicator = (id, overrides = {}) => ({
  id, indicatorValue: '881c0f10c75e64ec39d257a131fcd531f47dd2cff2070ae94baa347d375126fd', indicatorType: 'FileSha256',
  action: 'BlockAndRemediate', title: `KEEL-RT-indicator-${id}`, description: 'KEEL-RT fixture', severity: 'High', generateAlert: true,
  recommendedActions: 'none', application: null, rbacGroupNames: [], rbacGroupIds: [], expirationTime: null, sourceType: 'User',
  createdBy: 'keel-rt@example.test', creationTimeDateTimeUtc: '2026-10-01T00:00:00Z', lastUpdatedBy: null, lastUpdateTime: '2026-10-01T00:00:00Z',
  machineTags: ['not declared'],
  ...overrides,
});

/** A fake indicators API behind the real read-only transport. */
function fakeApi(answer = { value: [indicator('995'), indicator('996', { indicatorType: 'Url', indicatorValue: 'https://keel-rt.example.test', action: 'Block' })] }) {
  const sent = [];
  const audiences = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method, body: init.body, authorization: init.headers.authorization });
    if (answer.status) return new Response('{}', { status: answer.status });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  const transport = readOnlyDefenderIndicatorsTransport(async (audience) => { audiences.push(audience); return 'token'; }, fetchImpl);
  return { sent, audiences, transport };
}

const liveCapture = (tenantRef) => ({
  operationId: DEFENDER_INDICATORS_OPERATION, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-29T00:00:00Z',
  version: 'api', ok: true, proofRef: 'x',
});
const GRANTS = Object.freeze({ permissions: [], roles: [] });
const ledgerWith = (tenantRef, evidence) => buildWorkloadLedger({
  descriptors: WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === DEFENDER_INDICATORS_WORKLOAD),
  evidence, grants: GRANTS, tenantRef, now: NOW,
});

test('the indicators read is declared, in scope, read-only and ships disabled', async () => {
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === DEFENDER_INDICATORS_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [DEFENDER_INDICATORS_OPERATION]);
  const [descriptor] = declared;
  assert.deepEqual(descriptorProblems(descriptor), []);
  assert.equal(descriptor.operation.host, 'api.security.microsoft.com');
  assert.equal(descriptor.operation.audience, AUDIENCE);
  assert.match(descriptor.rbac.setup.join(' '), /WindowsDefenderATP .*Ti\.Read\.All/);

  const bare = ledgerWith('sha256:t', []);
  assert.equal(bare.rows[0].state, 'disabled');
  assert.equal(bare.rows[0].enabled, false);
  const { evidence, results } = await runFixtureHarness({ descriptors: declared });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = ledgerWith('sha256:t', evidence);
  assert.equal(fixtured.rows[0].state, 'fixture-tested');
  assert.equal(fixtured.rows[0].enabled, false);

  assert.equal(DEFENDER_INDICATORS_DESCRIPTOR.enabledByDefault, false);
  assert.equal(DEFENDER_INDICATORS_DESCRIPTOR.readOnly, true);
  assert.ok(listWorkloads().some((item) => item.workload === DEFENDER_INDICATORS_WORKLOAD));
  assert.equal(WORKLOAD_COLLECTORS.find((entry) => entry.workload === DEFENDER_INDICATORS_WORKLOAD).powershellFamily, null);
  assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((item) => item.workload === DEFENDER_INDICATORS_WORKLOAD), []);
  assert.throws(() => planWaves([{ naturalKey: 'x', resourceType: 'defenderEndpointIndicators', verb: 'update', payload: {} }]), /workload restore path/);
});

test('the transport sends only GETs of the indicators list, with a token for the Defender audience', async () => {
  const api = fakeApi();
  for (const [url, init] of [
    [LIST, { method: 'POST' }],
    [LIST, { method: 'GET', body: '{}' }],
    ['https://api.security.microsoft.com/api/indicators/995', { method: 'DELETE' }],
    ['https://api.security.microsoft.com/api/alerts', {}],
    ['https://api.security.microsoft.com/api/machines', {}],
    ['https://api.security.microsoft.com/api/advancedqueries/run', {}],
    ['https://api.security.microsoft.com/api/indicators?$filter=action eq \'Block\'', {}],
    ['https://graph.microsoft.com/v1.0/users', {}],
    ['http://api.security.microsoft.com/api/indicators', {}],
  ]) await assert.rejects(api.transport(url, init), DefenderIndicatorsScopeError, `${init.method ?? 'GET'} ${url}`);
  assert.deepEqual(api.sent, [], 'nothing refused was sent');
  assert.deepEqual(api.audiences, [], 'no token was fetched for a refused request');

  await api.transport(LIST);
  await api.transport(`${LIST}&$skip=10000`);
  assert.deepEqual(api.sent.map((item) => item.method), ['GET', 'GET']);
  assert.deepEqual(api.audiences, [AUDIENCE], 'one token, fetched once');

  const scopes = [];
  const production = defenderIndicatorsTransportFor({ tenantId: 't' }, {
    getTokenFn: async (_config, { scope }) => { scopes.push(scope); return { accessToken: 'x' }; },
    fetchImpl: async () => new Response('{"value":[]}', { status: 200 }),
  });
  await production(LIST);
  assert.deepEqual(scopes, ['https://api.securitycenter.microsoft.com/.default']);
});

test('each indicator is one observation keyed by its id, with declared fields only', async () => {
  const api = fakeApi();
  const result = await readDefenderIndicators({ transport: api.transport, now: () => NOW });
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(result.resources.map((item) => item.resourceKey), ['indicator:995', 'indicator:996']);
  const [first] = result.resources;
  assert.equal(first.fields.action, 'BlockAndRemediate');
  assert.equal(first.fields.machineTags, undefined, 'an undeclared field is dropped');
  assert.equal(first.fieldCoverage.category.status, 'unknown', 'an optional field not answered is unknown, not a gap');
  assert.equal(api.sent[0].url, LIST);

  // An empty tenant is complete-empty; numeric ids are kept as text.
  assert.equal((await readDefenderIndicators({ transport: fakeApi({ value: [] }).transport })).outcome, 'complete-empty');
  assert.equal((await readDefenderIndicators({ transport: fakeApi({ value: [indicator(7)] }).transport })).resources[0].identity, '7');
});

test('a refusal, a disagreeing duplicate, an answer with no id and a full page are gaps', async () => {
  const refused = await readDefenderIndicators({ transport: fakeApi({ status: 403 }).transport });
  assert.equal(refused.outcome, 'failed');
  assert.equal(refused.failures[0].error.httpStatus, 403);

  const duplicate = await readDefenderIndicators({ transport: fakeApi({ value: [indicator('1'), indicator('1', { action: 'Allowed' }), { title: 'no id' }] }).transport });
  assert.equal(duplicate.outcome, 'partial');
  assert.deepEqual(duplicate.discovery.conflicts, [{ resourceKey: 'indicator:1', fields: ['action'] }]);
  assert.equal(duplicate.discovery.unidentified, 1);

  const full = Array.from({ length: PAGE_SIZE }, (_, index) => indicator(String(index + 1)));
  const capped = await readDefenderIndicators({ transport: fakeApi({ value: full }).transport });
  assert.equal(capped.outcome, 'partial');
  assert.equal(capped.discovery.capped, true);
});

test('collection stays off until the read is qualified; a refused capture names the Ti.Read.All step', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const api = fakeApi();
  const disabled = await collectDefenderIndicators(client, { tenantRef, ledger: ledgerWith(tenantRef, []), transport: api.transport, now: () => NOW });
  assert.equal(disabled.run.outcome, 'disabled');
  assert.deepEqual(api.sent, [], 'nothing is sent while disabled');

  const denied = defenderIndicatorsActivation(ledgerWith(tenantRef, [{ ...liveCapture(tenantRef), ok: false, error: 'HTTP 403' }]));
  assert.equal(denied.enabled, false);
  assert.match(denied.reasons[0], /pending-prerequisite: .*Ti\.Read\.All/);

  const full = await collectDefenderIndicators(client, { tenantRef, ledger: ledgerWith(tenantRef, [liveCapture(tenantRef)]), transport: api.transport, now: () => NOW });
  assert.equal(full.run.outcome, 'complete');
  const { rows } = await client.query('SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [full.run.id]);
  assert.deepEqual(rows.map((row) => row.resource_key), ['indicator:995', 'indicator:996']);
  assert.equal(rows[0].fields.kind, 'indicator');

  // The scheduled run records a disabled run without asking for a token.
  const entry = WORKLOAD_COLLECTORS.find((item) => item.workload === DEFENDER_INDICATORS_WORKLOAD);
  const scheduled = await entry.collect(client, { base: { tenantRef: nextTenant(), ledger: ledgerWith(tenantRef, []), now: () => NOW }, config: { tenantId: 't' }, sleep: async () => {} });
  assert.equal(scheduled.run.outcome, 'disabled');
});

test('the live read capture tool captures the indicators read and its signed record turns the workload on', async () => {
  const KEY = 'mde-ioc-test-key';
  const tenantRef = 'sha256:mde-ioc-capture';
  const build = 'build-mde-ioc';
  const api = fakeApi();
  const { record, diagnostics } = await captureWorkloadReads({
    workload: DEFENDER_INDICATORS_WORKLOAD, collector: api.transport, tenantRef, build, credential: 'app:collector', now: () => NOW,
  });
  assert.deepEqual(diagnostics, []);
  assert.ok(api.sent.every((call) => call.method === 'GET'));
  assert.deepEqual(record.subject.reads.map(({ operationId, version, ok }) => ({ operationId, version, ok })),
    [{ operationId: DEFENDER_INDICATORS_OPERATION, version: 'api', ok: true }]);
  const evidence = signEvidence(record, KEY, 'keel-release-runner');
  assert.deepEqual(verifyEvidence(evidence, { gate: WORKLOAD_READS_LIVE_GATE, tenantRef, build, hmacKey: KEY, requireLive: true, now: NOW }).failures, []);
  const seam = ledgerEvidenceFromWorkloadReadsAcceptance(evidence, { tenantRef, build, hmacKey: KEY, now: NOW });
  assert.equal(defenderIndicatorsActivation(ledgerWith(tenantRef, seam.reads)).enabled, true);
});
