import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineEvent } from '../telemetry/events.mjs';
import {
  registerDestination,
  enqueueEvent,
  drainDestination,
  drainDueDestinations,
  outboxStatus,
  retryDelayMs,
} from '../telemetry/outbox.mjs';
import {
  LOGS_INGESTION_API_VERSION,
  LOGS_INGESTION_DOC_SOURCE,
  LOGS_INGESTION_TOKEN_AUDIENCE,
  SENTINEL_COLUMNS,
  SENTINEL_DESTINATION_KIND,
  SENTINEL_STREAM_NAME,
  SENTINEL_TABLE_NAME,
  createSentinelAdapter,
  logsIngestionUrl,
  recordForEnvelope,
  sentinelSetupPrerequisites,
  tokenAudienceForCloud,
} from '../telemetry/adapters/sentinel.mjs';
import { SIEM_ADAPTERS } from '../../cli/keel-worker.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const SCHEMA = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
const OPS_SCHEMA = JSON.parse(readFileSync(new URL('../../ops/sentinel-schema.json', import.meta.url), 'utf8'));
const DEDUP_KQL = readFileSync(new URL('../../ops/sentinel-dedup.kql', import.meta.url), 'utf8');

const T0 = '2026-09-15T10:00:00.000Z';
const NOW = new Date(Date.now() + 60 * 1000);
const FIXTURE_ENDPOINT = 'https://fixture-dce.eastus-1.ingest.monitor.azure.com';
const FIXTURE_DCR = 'dcr-f1xture00000000000000000000000000aa';
const FIXTURE_TOKEN = 'fixture-sentinel-token-DO-NOT-LEAK';

function fixtureEnvelope(tenantRef, n) {
  return defineEvent({
    tenantRef,
    eventType: 'fixture.observed',
    source: { component: 'fixture' },
    correlationId: 'fixture:1',
    sourceSequence: n,
    observedAt: new Date(new Date(T0).getTime() + n * 1000).toISOString(),
  });
}

function fixtureConfig(overrides = {}) {
  return {
    endpoint: FIXTURE_ENDPOINT,
    dcrImmutableId: FIXTURE_DCR,
    credentialRef: 'env:KEEL_SENTINEL_FIXTURE_CREDENTIAL',
    ...overrides,
  };
}

// Deterministic diagnostic request ids so a test can assert they change per
// request while the KEEL event id stays stable.
function uuidSequence() {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  };
}

// Fixture ingestion endpoint: records every request, applies the scripted
// behaviour. This is the fake Microsoft sink — fixture-tested only.
function fixtureEndpoint(behaviour = async () => ({ status: 204 })) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const response = await behaviour({ url, init, requests });
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: new Headers(response.headers ?? {}),
    };
  };
  return { requests, fetchImpl };
}

function recordingTokenProvider(token = FIXTURE_TOKEN) {
  const calls = [];
  return {
    calls,
    tokenProvider: async ({ scope }) => {
      calls.push({ scope });
      return token;
    },
  };
}

async function setup(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  await client.query(SCHEMA);
  const { rows: [admin] } = await client.query(
    "INSERT INTO principal (email) VALUES ('sentinel-admin@example.invalid') RETURNING *",
  );
  await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'admin')", [admin.id]);
  const { rows: [viewer] } = await client.query(
    "INSERT INTO principal (email) VALUES ('sentinel-viewer@example.invalid') RETURNING *",
  );
  await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'viewer')", [viewer.id]);
  return { db, client, admin, viewer };
}

async function sentinelDestination(client, admin, { tenantRef = 'fixture', config = fixtureConfig() } = {}) {
  return registerDestination(client, {
    tenantRef, name: 'sentinel-1', kind: SENTINEL_DESTINATION_KIND, config, requestedBy: admin.id,
  });
}

test('fixture endpoint validates the ingestion URL, body mapping and token audience', async () => {
  const endpoint = fixtureEndpoint();
  const tokens = recordingTokenProvider();
  const adapter = createSentinelAdapter({
    fetchImpl: endpoint.fetchImpl, tokenProvider: tokens.tokenProvider, uuid: uuidSequence(),
  });
  const envelope = fixtureEnvelope('fixture', 7);
  const destination = {
    id: 'dest-fixture-1',
    tenant_ref: 'fixture',
    kind: SENTINEL_DESTINATION_KIND,
    config: fixtureConfig(),
  };

  const outcome = await adapter.deliver({ destination, envelope, eventId: envelope.eventId });
  assert.equal(outcome.outcome, 'accepted');
  assert.equal(endpoint.requests.length, 1);
  assert.equal(tokens.calls.length, 1);

  // Audience: the Logs Ingestion audience, never the Graph audience.
  assert.equal(tokens.calls[0].scope, 'https://monitor.azure.com/.default');
  assert.doesNotMatch(tokens.calls[0].scope, /graph\.microsoft\.com/i);

  // URL: endpoint + DCR immutable id + stream + pinned api-version.
  const expected = `${FIXTURE_ENDPOINT}/dataCollectionRules/${FIXTURE_DCR}`
    + `/streams/${SENTINEL_STREAM_NAME}?api-version=${LOGS_INGESTION_API_VERSION}`;
  assert.equal(endpoint.requests[0].url, expected);

  // Headers: bearer auth, JSON content type, diagnostic GUID request id.
  const { headers } = endpoint.requests[0].init;
  assert.equal(headers.Authorization, `Bearer ${FIXTURE_TOKEN}`);
  assert.match(headers['Content-Type'], /^application\/json/);
  assert.match(headers['x-ms-client-request-id'],
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // Body: a JSON array with one record carrying the KEEL event id and the
  // tenant-specific source identity.
  const [record] = endpoint.requests[0].body;
  assert.equal(record.KeelEventId, envelope.eventId);
  assert.equal(record.TenantRef, 'fixture');
  assert.equal(record.SourceIdentity, 'keel:fixture');
  assert.equal(record.DestinationId, destination.id);
  assert.equal(record.TimeGenerated, envelope.observedAt);
  assert.equal(record.EventType, 'fixture.observed');
  assert.equal(record.SourceSequence, 7);
});

test('the token audience is derived per cloud and can never be the Graph audience', () => {
  assert.equal(tokenAudienceForCloud('public'), 'https://monitor.azure.com');
  assert.equal(tokenAudienceForCloud(), 'https://monitor.azure.com');
  assert.equal(tokenAudienceForCloud('china'), 'https://monitor.azure.cn');
  assert.equal(tokenAudienceForCloud('usgov'), 'https://monitor.azure.us');
  for (const audience of Object.values(LOGS_INGESTION_TOKEN_AUDIENCE)) {
    assert.doesNotMatch(audience, /graph/i);
  }
  assert.throws(() => tokenAudienceForCloud('graph'), /unknown cloud/);
  assert.throws(() => tokenAudienceForCloud('https://graph.microsoft.com'), /unknown cloud/);
  // An unknown configured cloud is a named pending prerequisite, not a request.
  const pending = sentinelSetupPrerequisites(fixtureConfig({ cloud: 'graph' }));
  assert.ok(pending.some((p) => p.name === 'supported-cloud'));
});

test('throttled batch (429) is never acknowledged; Retry-After delays the replay under the same event id', async (t) => {
  const { client, admin, viewer } = await setup(t);
  const destination = await sentinelDestination(client, admin);
  const envelope = fixtureEnvelope('fixture', 1);
  const { event } = await enqueueEvent(client, {
    tenantRef: 'fixture', destinationId: destination.id, envelope,
  });

  let calls = 0;
  const endpoint = fixtureEndpoint(async () => {
    calls += 1;
    return calls === 1 ? { status: 429, headers: { 'Retry-After': '3' } } : { status: 204 };
  });
  const adapter = createSentinelAdapter({
    fetchImpl: endpoint.fetchImpl, tokenProvider: recordingTokenProvider().tokenProvider,
    uuid: uuidSequence(),
  });

  const first = await drainDestination(client, { destinationId: destination.id, adapter, now: NOW });
  assert.equal(first.retried, 1);
  assert.equal(first.delivered, 0);

  // Not acknowledged: the row stays pending, the checkpoint does not advance.
  const { rows: [row] } = await client.query('SELECT * FROM siem_outbox_event WHERE id = $1', [event.id]);
  assert.equal(row.status, 'pending');
  assert.equal(row.event_id, envelope.eventId);
  assert.match(row.last_error, /throttled/);
  // Retry-After: 3 wins over the 5s exponential floor for the first attempt.
  assert.equal(new Date(row.next_attempt_at).getTime(), NOW.getTime() + 3000);
  const midStatus = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(midStatus.checkpoint.lastAcknowledgedSeq, 0);

  // After Retry-After the SAME event id is redelivered and acknowledged.
  const later = new Date(NOW.getTime() + 3001);
  const second = await drainDestination(client, { destinationId: destination.id, adapter, now: later });
  assert.equal(second.delivered, 1);
  assert.equal(endpoint.requests.length, 2);
  assert.equal(endpoint.requests[1].body[0].KeelEventId, envelope.eventId);
});

test('lost acknowledgement (timeout) replays the same event id; the request id is diagnostic only', async () => {
  const endpoint = fixtureEndpoint(async ({ requests }) => (
    requests.length === 1 ? Promise.reject(new Error('fixture socket timeout')) : { status: 204 }
  ));
  const uuid = uuidSequence();
  const adapter = createSentinelAdapter({
    fetchImpl: endpoint.fetchImpl, tokenProvider: recordingTokenProvider().tokenProvider, uuid,
  });
  const envelope = fixtureEnvelope('fixture', 3);
  const destination = {
    id: 'dest-fixture-2', tenant_ref: 'fixture', kind: SENTINEL_DESTINATION_KIND, config: fixtureConfig(),
  };

  const first = await adapter.deliver({ destination, envelope, eventId: envelope.eventId });
  assert.equal(first.outcome, 'uncertain');
  assert.equal(endpoint.requests.length, 1);

  const second = await adapter.deliver({ destination, envelope, eventId: envelope.eventId });
  assert.equal(second.outcome, 'accepted');
  assert.equal(endpoint.requests.length, 2);

  // Same KEEL event id in both physical requests — dedup identity is the event id.
  assert.equal(endpoint.requests[0].body[0].KeelEventId, envelope.eventId);
  assert.equal(endpoint.requests[1].body[0].KeelEventId, envelope.eventId);
  // The diagnostic x-ms-client-request-id differs per request and is NOT the dedup
  // identity (it is also absent from the record body entirely).
  const requestIds = endpoint.requests.map((r) => r.init.headers['x-ms-client-request-id']);
  assert.notEqual(requestIds[0], requestIds[1]);
  assert.notEqual(requestIds[0], envelope.eventId);
  for (const request of endpoint.requests) {
    assert.equal(request.body[0]['x-ms-client-request-id'], undefined);
    assert.doesNotMatch(JSON.stringify(request.body), /x-ms-client-request-id/);
  }
});

test('schema rejection (400) quarantines as poison; 401/403 and 5xx stay pending for retry', async () => {
  const envelope = fixtureEnvelope('fixture', 1);
  const destination = {
    id: 'dest-fixture-3', tenant_ref: 'fixture', kind: SENTINEL_DESTINATION_KIND, config: fixtureConfig(),
  };
  const deliverWith = async (status) => {
    const endpoint = fixtureEndpoint(async () => ({ status, headers: { 'x-ms-request-id': 'svc-req-1' } }));
    const adapter = createSentinelAdapter({
      fetchImpl: endpoint.fetchImpl, tokenProvider: recordingTokenProvider().tokenProvider,
    });
    return adapter.deliver({ destination, envelope, eventId: envelope.eventId });
  };

  const rejected = await deliverWith(400);
  assert.equal(rejected.outcome, 'poison');
  assert.match(rejected.reason, /schema rejected/);
  assert.match(rejected.reason, /svc-req-1/); // service request id is diagnostic context

  for (const status of [401, 403, 408, 500, 503]) {
    const outcome = await deliverWith(status);
    assert.equal(outcome.outcome, 'retry', `HTTP ${status}`);
  }
});

test('a missing DCR yields named pending setup prerequisites and nothing is sent or acknowledged', async (t) => {
  const { client, admin, viewer } = await setup(t);
  const config = fixtureConfig();
  delete config.dcrImmutableId;
  const destination = await sentinelDestination(client, admin, { config });
  const envelope = fixtureEnvelope('fixture', 1);
  await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope });

  // Direct prerequisite listing names the missing piece.
  const pending = sentinelSetupPrerequisites(config);
  assert.deepEqual(pending.map((p) => p.name), ['data-collection-rule-immutable-id']);

  const endpoint = fixtureEndpoint();
  const adapter = createSentinelAdapter({
    fetchImpl: endpoint.fetchImpl, tokenProvider: recordingTokenProvider().tokenProvider,
  });
  const summary = await drainDestination(client, { destinationId: destination.id, adapter, now: NOW });
  assert.equal(summary.retried, 1);
  assert.equal(summary.delivered, 0);
  assert.equal(endpoint.requests.length, 0); // no request is even attempted

  const { rows: [row] } = await client.query('SELECT * FROM siem_outbox_event WHERE destination_id = $1', [destination.id]);
  assert.equal(row.status, 'pending');
  assert.match(row.last_error, /pending setup prerequisites: data-collection-rule-immutable-id/);
  const status = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(status.acknowledged, 0);
  assert.equal(status.checkpoint.lastAcknowledgedSeq, 0);

  // The direct deliver path returns the same named prerequisites.
  const direct = await adapter.deliver({
    destination: { id: destination.id, tenant_ref: 'fixture', config }, envelope, eventId: envelope.eventId,
  });
  assert.equal(direct.outcome, 'retry');
  assert.deepEqual(direct.pendingPrerequisites.map((p) => p.name), ['data-collection-rule-immutable-id']);
});

test('no token material appears in outcomes, errors, bodies or logs', async () => {
  // Adversarial fixture: the sink echoes the bearer token in its response headers;
  // the adapter must still only surface status and the diagnostic request id.
  const leakyHeaders = { 'x-ms-request-id': 'svc-req-9', 'x-echo': FIXTURE_TOKEN };
  for (const status of [400, 429, 500]) {
    const endpoint = fixtureEndpoint(async () => ({ status, headers: leakyHeaders }));
    const adapter = createSentinelAdapter({
      fetchImpl: endpoint.fetchImpl, tokenProvider: recordingTokenProvider().tokenProvider,
    });
    const envelope = fixtureEnvelope('fixture', 1);
    const destination = {
      id: 'dest-leak', tenant_ref: 'fixture', kind: SENTINEL_DESTINATION_KIND, config: fixtureConfig(),
    };
    const outcome = await adapter.deliver({ destination, envelope, eventId: envelope.eventId });
    const serialized = JSON.stringify(outcome);
    assert.doesNotMatch(serialized, new RegExp(FIXTURE_TOKEN));
    assert.equal(endpoint.requests[0].init.headers.Authorization, `Bearer ${FIXTURE_TOKEN}`);
    assert.doesNotMatch(endpoint.requests[0].init.body, new RegExp(FIXTURE_TOKEN));
  }

  // Token acquisition failure is reported as a pending prerequisite without
  // echoing the credential internals.
  const failingProvider = async () => {
    throw new Error(`could not read credential file containing ${FIXTURE_TOKEN}`);
  };
  const adapter = createSentinelAdapter({
    fetchImpl: fixtureEndpoint().fetchImpl, tokenProvider: failingProvider,
  });
  const outcome = await adapter.deliver({
    destination: { id: 'd', tenant_ref: 'fixture', config: fixtureConfig() },
    envelope: fixtureEnvelope('fixture', 1),
    eventId: fixtureEnvelope('fixture', 1).eventId,
  });
  assert.equal(outcome.outcome, 'retry');
  assert.match(outcome.error, /pending setup prerequisite/);
  assert.doesNotMatch(JSON.stringify(outcome), new RegExp(FIXTURE_TOKEN));
});

test('the KQL dedup view collapses physical duplicates into one logical event per dedup key', () => {
  // The shipped view must implement the receiver dedup contract: group by
  // (TenantRef, DestinationId, KeelEventId), keep the latest TimeGenerated.
  assert.match(DEDUP_KQL, /KeelEvents_CL/);
  assert.match(DEDUP_KQL, /arg_max\(TimeGenerated, \*\)/);
  assert.match(DEDUP_KQL, /by TenantRef, DestinationId, KeelEventId/);

  // Fixture evaluation of the view's semantics over physically duplicated rows
  // (the at-least-once case): one logical event per dedup key.
  const envelope = fixtureEnvelope('fixture', 4);
  const destinationId = 'dest-fixture-4';
  const record = recordForEnvelope({ envelope, destinationId, eventId: envelope.eventId });
  const laterCopy = { ...record, TimeGenerated: new Date(new Date(T0).getTime() + 60_000).toISOString() };
  const other = recordForEnvelope({
    envelope: fixtureEnvelope('fixture', 5), destinationId, eventId: fixtureEnvelope('fixture', 5).eventId,
  });
  const physicalRows = [record, laterCopy, other];

  const logical = new Map();
  for (const row of physicalRows) {
    const key = JSON.stringify([row.TenantRef, row.DestinationId, row.KeelEventId]);
    const existing = logical.get(key);
    if (!existing || row.TimeGenerated > existing.TimeGenerated) logical.set(key, row);
  }
  assert.equal(logical.size, 2); // duplicates collapse; distinct events never do
  const deduped = logical.get(JSON.stringify(['fixture', destinationId, envelope.eventId]));
  assert.equal(deduped.TimeGenerated, laterCopy.TimeGenerated);
  assert.equal(deduped.KeelEventId, envelope.eventId);
});

test('ops/sentinel-schema.json declares exactly the columns the adapter emits', () => {
  const declared = OPS_SCHEMA.columns.map((column) => column.name).sort();
  const emitted = SENTINEL_COLUMNS.map((column) => column.name).sort();
  assert.deepEqual(declared, emitted);
  assert.deepEqual(Object.keys(recordForEnvelope({
    envelope: fixtureEnvelope('fixture', 1), destinationId: 'd', eventId: fixtureEnvelope('fixture', 1).eventId,
  })).sort(), emitted);
  assert.equal(OPS_SCHEMA.tableName, SENTINEL_TABLE_NAME);
  assert.equal(OPS_SCHEMA.streamName, SENTINEL_STREAM_NAME);
  const declaration = OPS_SCHEMA.dcrTemplate.properties.streamDeclarations[SENTINEL_STREAM_NAME];
  assert.deepEqual(declaration.columns.map((column) => column.name).sort(), emitted);
  assert.equal(OPS_SCHEMA.dcrTemplate.properties.dataFlows[0].outputStream, `Custom-${SENTINEL_TABLE_NAME}`);
  // Reserved column names from the documentation are never used.
  for (const reserved of ['_ResourceId', 'id', '_SubscriptionId', 'TenantId', 'Type', 'UniqueId', 'Title']) {
    assert.ok(!emitted.includes(reserved), `reserved column used: ${reserved}`);
  }
  // Constraint-8 documentation pin is recorded on the ops artifact and adapter.
  assert.equal(OPS_SCHEMA.docSource.url, LOGS_INGESTION_DOC_SOURCE.url);
  assert.equal(OPS_SCHEMA.docSource.retrievedAt, '2026-09-26');
  assert.equal(LOGS_INGESTION_DOC_SOURCE.apiVersion, LOGS_INGESTION_API_VERSION);
  assert.equal(LOGS_INGESTION_DOC_SOURCE.tokenAudience, 'https://monitor.azure.com');
});

test('logsIngestionUrl requires https and encodes the path segments', () => {
  assert.equal(
    logsIngestionUrl({ endpoint: `${FIXTURE_ENDPOINT}/`, dcrImmutableId: FIXTURE_DCR }),
    `${FIXTURE_ENDPOINT}/dataCollectionRules/${FIXTURE_DCR}/streams/${SENTINEL_STREAM_NAME}?api-version=2023-01-01`,
  );
  assert.equal(
    logsIngestionUrl({ endpoint: FIXTURE_ENDPOINT, dcrImmutableId: FIXTURE_DCR, streamName: 'Custom-Other Stream' }),
    `${FIXTURE_ENDPOINT}/dataCollectionRules/${FIXTURE_DCR}/streams/Custom-Other%20Stream?api-version=2023-01-01`,
  );
  assert.throws(() => logsIngestionUrl({ endpoint: 'http://insecure.invalid', dcrImmutableId: FIXTURE_DCR }), /https/);
  assert.throws(() => logsIngestionUrl({ endpoint: 'not a url', dcrImmutableId: FIXTURE_DCR }), /valid URL/);
  assert.throws(() => logsIngestionUrl({ endpoint: FIXTURE_ENDPOINT, dcrImmutableId: '' }), /dcrImmutableId/);
});

test('worker SIEM_ADAPTERS registers the sentinel kind; drainDueDestinations routes to it', async (t) => {
  assert.equal(typeof SIEM_ADAPTERS[SENTINEL_DESTINATION_KIND]?.deliver, 'function');
  assert.equal(SIEM_ADAPTERS[SENTINEL_DESTINATION_KIND].kind, SENTINEL_DESTINATION_KIND);

  const { client, admin, viewer } = await setup(t);
  const destination = await sentinelDestination(client, admin);
  const envelopes = [1, 2].map((n) => fixtureEnvelope('fixture', n));
  for (const envelope of envelopes) {
    await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope });
  }
  const endpoint = fixtureEndpoint();
  const results = await drainDueDestinations(client, {
    adapters: {
      [SENTINEL_DESTINATION_KIND]: createSentinelAdapter({
        fetchImpl: endpoint.fetchImpl, tokenProvider: recordingTokenProvider().tokenProvider,
      }),
    },
    now: NOW,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].delivered, 2);
  assert.equal(endpoint.requests.length, 2);
  const status = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(status.acknowledged, 2);
  assert.equal(status.checkpoint.lastAcknowledgedEventId, envelopes[1].eventId);
});

test('an envelope from another tenant is refused as poison, never delivered', async () => {
  const endpoint = fixtureEndpoint();
  const adapter = createSentinelAdapter({
    fetchImpl: endpoint.fetchImpl, tokenProvider: recordingTokenProvider().tokenProvider,
  });
  const outcome = await adapter.deliver({
    destination: { id: 'd', tenant_ref: 'fixture', config: fixtureConfig() },
    envelope: fixtureEnvelope('other-tenant', 1),
    eventId: fixtureEnvelope('other-tenant', 1).eventId,
  });
  assert.equal(outcome.outcome, 'poison');
  assert.match(outcome.reason, /tenant/);
  assert.equal(endpoint.requests.length, 0);
});

test('qualification tool: complete config passes, missing DCR fails with named prerequisites (offline, fixture-tested)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-sentinel-qual-'));
  try {
    const tool = new URL('../../tools/qualification/sentinel.mjs', import.meta.url).pathname;
    const completePath = join(dir, 'complete.json');
    writeFileSync(completePath, JSON.stringify(fixtureConfig()));
    const okOut = execFileSync('node', [tool, 'check', '--config', completePath, '--tenant', 'fixture'], { encoding: 'utf8' });
    const okRecord = JSON.parse(okOut);
    assert.equal(okRecord.gate, 'sentinel-ingestion');
    assert.equal(okRecord.subject.ok, true);
    assert.equal(okRecord.evidenceLevel, 'fixture-tested');
    assert.equal(okRecord.synthetic, true);
    assert.equal(okRecord.docSource.url, LOGS_INGESTION_DOC_SOURCE.url);
    assert.equal(okRecord.docSource.retrievedAt, '2026-09-26');
    assert.deepEqual(okRecord.subject.dedupKey, ['TenantRef', 'DestinationId', 'KeelEventId']);

    const incompletePath = join(dir, 'incomplete.json');
    const incomplete = fixtureConfig();
    delete incomplete.dcrImmutableId;
    delete incomplete.credentialRef;
    writeFileSync(incompletePath, JSON.stringify(incomplete));
    let failed = null;
    try {
      execFileSync('node', [tool, 'check', '--config', incompletePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      failed = error;
    }
    assert.ok(failed, 'incomplete config must exit nonzero');
    assert.equal(failed.status, 1);
    const failedRecord = JSON.parse(failed.stdout);
    assert.equal(failedRecord.subject.ok, false);
    assert.deepEqual(
      failedRecord.subject.pendingPrerequisites.map((p) => p.name).sort(),
      ['data-collection-rule-immutable-id', 'entra-app-credential-reference'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Truncated column mirrors capture.truncated from the envelope, never a constant', async () => {
  // A genuinely oversized payload: defineEvent caps it and records the cost, so
  // the fixture exercises the real production capture path.
  const big = defineEvent({
    tenantRef: 'fixture',
    eventType: 'fixture.observed',
    source: { component: 'fixture' },
    correlationId: 'fixture:big',
    sourceSequence: 9,
    observedAt: T0,
    payload: { blob: 'x'.repeat(4096) },
    maxPayloadBytes: 128,
  });
  assert.equal(big.capture.truncated, true);
  const truncatedRecord = recordForEnvelope({ envelope: big, destinationId: 'd', eventId: big.eventId });
  assert.equal(truncatedRecord.Truncated, true);
  assert.equal(truncatedRecord.PayloadBytes, big.capture.payloadBytes);

  const small = fixtureEnvelope('fixture', 6);
  assert.equal(small.capture.truncated, false);
  assert.equal(
    recordForEnvelope({ envelope: small, destinationId: 'd', eventId: small.eventId }).Truncated,
    false,
  );

  // End to end: the truncation flag survives into the physical ingestion body.
  const endpoint = fixtureEndpoint();
  const adapter = createSentinelAdapter({
    fetchImpl: endpoint.fetchImpl, tokenProvider: recordingTokenProvider().tokenProvider,
  });
  const outcome = await adapter.deliver({
    destination: { id: 'dest-trunc', tenant_ref: 'fixture', kind: SENTINEL_DESTINATION_KIND, config: fixtureConfig() },
    envelope: big,
    eventId: big.eventId,
  });
  assert.equal(outcome.outcome, 'accepted');
  assert.equal(endpoint.requests[0].body[0].Truncated, true);
  assert.equal(endpoint.requests[0].body[0].PayloadBytes, big.capture.payloadBytes);
});

test('an envelope that cannot be mapped to the stream schema is quarantined as poison, never sent', async (t) => {
  const endpoint = fixtureEndpoint();
  const tokens = recordingTokenProvider();
  const adapter = createSentinelAdapter({
    fetchImpl: endpoint.fetchImpl, tokenProvider: tokens.tokenProvider,
  });

  // Direct delivery: mapping throws, the adapter must convert that to a durable
  // poison outcome — never propagate, never retry, never send.
  const broken = { ...fixtureEnvelope('fixture', 1), correlationId: '' };
  const direct = await adapter.deliver({
    destination: { id: 'dest-broken', tenant_ref: 'fixture', kind: SENTINEL_DESTINATION_KIND, config: fixtureConfig() },
    envelope: broken,
    eventId: broken.eventId,
  });
  assert.equal(direct.outcome, 'poison');
  assert.match(direct.reason, /cannot be mapped/);
  assert.equal(endpoint.requests.length, 0); // nothing is sent
  assert.equal(tokens.calls.length, 0);      // no token is acquired for a poison event

  // Through the outbox the same failure is a durable quarantine, not a retry.
  const { client, admin, viewer } = await setup(t);
  const destination = await sentinelDestination(client, admin);
  const valid = fixtureEnvelope('fixture', 2);
  const { event } = await enqueueEvent(client, {
    tenantRef: 'fixture', destinationId: destination.id, envelope: valid,
  });
  // The stored envelope became unmappable after enqueue (schema drift case).
  await client.query('UPDATE siem_outbox_event SET envelope = $2 WHERE id = $1', [
    event.id, JSON.stringify({ ...valid, correlationId: null }),
  ]);
  const summary = await drainDestination(client, { destinationId: destination.id, adapter, now: NOW });
  assert.equal(summary.quarantined, 1);
  assert.equal(summary.retried, 0);
  assert.equal(summary.delivered, 0);
  assert.equal(endpoint.requests.length, 0);

  const { rows: [row] } = await client.query('SELECT * FROM siem_outbox_event WHERE id = $1', [event.id]);
  assert.equal(row.status, 'quarantined');
  assert.match(row.quarantine_reason, /cannot be mapped/);
  const status = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(status.quarantined, 1);
  assert.equal(status.acknowledged, 0);
});

test('an outbox event id mismatch is rejected by the mapper before delivery', async () => {
  const envelope = fixtureEnvelope('fixture', 1);
  const eventId = fixtureEnvelope('fixture', 2).eventId;
  assert.notEqual(eventId, envelope.eventId);
  assert.throws(
    () => recordForEnvelope({ envelope, destinationId: 'dest-mismatch', eventId }),
    { name: 'TypeError', message: 'outbox event id does not match the envelope event id' },
  );
  // Matching identities and legacy callers omitting the separate id still map.
  for (const suppliedId of [envelope.eventId, undefined]) {
    assert.equal(recordForEnvelope({
      envelope, destinationId: 'dest-mismatch', eventId: suppliedId,
    }).KeelEventId, envelope.eventId);
  }
  const endpoint = fixtureEndpoint();
  const tokens = recordingTokenProvider();
  const adapter = createSentinelAdapter({ fetchImpl: endpoint.fetchImpl, tokenProvider: tokens.tokenProvider });
  const outcome = await adapter.deliver({
    destination: { id: 'dest-mismatch', tenant_ref: 'fixture', config: fixtureConfig() },
    envelope, eventId,
  });
  assert.equal(outcome.outcome, 'poison');
  assert.match(outcome.reason, /outbox event id does not match the envelope event id/);
  assert.equal(tokens.calls.length, 0);
  assert.equal(endpoint.requests.length, 0);
});

test('an outbox event id mismatch is durably quarantined without acknowledgement', async (t) => {
  const { client, admin, viewer } = await setup(t);
  const destination = await sentinelDestination(client, admin);
  const envelope = fixtureEnvelope('fixture', 1);
  const { event } = await enqueueEvent(client, {
    tenantRef: 'fixture', destinationId: destination.id, envelope,
  });
  // Simulate stored identity corruption while keeping a valid, same-tenant envelope.
  const differentEnvelope = fixtureEnvelope('fixture', 2);
  assert.notEqual(differentEnvelope.eventId, event.event_id);
  await client.query('UPDATE siem_outbox_event SET envelope = $2 WHERE id = $1', [
    event.id, JSON.stringify(differentEnvelope),
  ]);
  const endpoint = fixtureEndpoint();
  const tokens = recordingTokenProvider();
  const adapter = createSentinelAdapter({ fetchImpl: endpoint.fetchImpl, tokenProvider: tokens.tokenProvider });
  const summary = await drainDestination(client, { destinationId: destination.id, adapter, now: NOW });
  assert.equal(summary.quarantined, 1);
  assert.equal(summary.delivered, 0);
  assert.equal(summary.retried, 0);
  assert.equal(summary.uncertain, 0);
  assert.equal(tokens.calls.length, 0);
  assert.equal(endpoint.requests.length, 0);
  const { rows: [row] } = await client.query('SELECT * FROM siem_outbox_event WHERE id = $1', [event.id]);
  assert.equal(row.status, 'quarantined');
  assert.equal(row.event_id, envelope.eventId);
  assert.equal(row.envelope.eventId, differentEnvelope.eventId);
  assert.equal(row.acknowledged_at, null);
  assert.match(row.quarantine_reason, /outbox event id does not match the envelope event id/);
  const status = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(status.quarantined, 1);
  assert.equal(status.acknowledged, 0);
  assert.equal(status.checkpoint.lastAcknowledgedSeq, 0);
});

test('the default credential path acquires a certificate token for the Monitor audience and caches per scope', async (t) => {
  // Fixture credential: a real generated RSA keypair in a temp directory, the
  // referenced JSON file naming tenantId/clientId/cert/key paths — exactly the
  // shape the production credentialRef flow resolves. No tokenProvider is
  // injected, so the default acquireCertificateToken path runs.
  const dir = mkdtempSync(join(tmpdir(), 'keel-sentinel-cred-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPath = join(dir, 'sender.key');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(privateKeyPath, privateKeyPem);
  const certificatePath = join(dir, 'sender.crt');
  writeFileSync(certificatePath,
    `-----BEGIN CERTIFICATE-----\n${Buffer.from('fixture-der-cert').toString('base64')}\n-----END CERTIFICATE-----\n`);
  const credentialPath = join(dir, 'credential.json');
  writeFileSync(credentialPath, JSON.stringify({
    tenantId: 'fixture-tenant', clientId: 'fixture-client', certificatePath, privateKeyPath,
  }));
  const envVar = 'KEEL_SENTINEL_PROD_CREDENTIAL_TEST';
  const previous = process.env[envVar];
  process.env[envVar] = credentialPath;
  t.after(() => {
    if (previous === undefined) delete process.env[envVar];
    else process.env[envVar] = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  // Fake Microsoft endpoints: the token endpoint echoes a token derived from the
  // requested scope so the test can prove WHICH audience each request used.
  const tokenRequests = [];
  const ingestionRequests = [];
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://login.microsoftonline.com/')) {
      const params = new URLSearchParams(init.body);
      tokenRequests.push({ url, params });
      const scope = params.get('scope');
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ access_token: `prod-token[${scope}]`, expires_in: 3600 }),
      };
    }
    ingestionRequests.push({ url, init, body: JSON.parse(init.body) });
    return { status: 204, ok: true, headers: new Headers() };
  };

  const adapter = createSentinelAdapter({ fetchImpl });
  const deliverTo = async (cloud) => {
    const envelope = fixtureEnvelope('fixture', 1);
    const config = fixtureConfig({
      credentialRef: `env:${envVar}`,
      ...(cloud === 'public' ? {} : { cloud }),
    });
    return adapter.deliver({
      destination: { id: `dest-prod-${cloud}`, tenant_ref: 'fixture', kind: SENTINEL_DESTINATION_KIND, config },
      envelope,
      eventId: envelope.eventId,
    });
  };

  const first = await deliverTo('public');
  assert.equal(first.outcome, 'accepted');
  assert.equal(tokenRequests.length, 1);
  assert.equal(
    tokenRequests[0].url,
    'https://login.microsoftonline.com/fixture-tenant/oauth2/v2.0/token',
  );
  assert.equal(tokenRequests[0].params.get('grant_type'), 'client_credentials');
  assert.equal(tokenRequests[0].params.get('client_id'), 'fixture-client');
  assert.match(
    tokenRequests[0].params.get('client_assertion'),
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  );
  // The requested audience is the LOGS INGESTION audience, never Graph.
  assert.equal(tokenRequests[0].params.get('scope'), 'https://monitor.azure.com/.default');
  assert.doesNotMatch(tokenRequests[0].params.get('scope'), /graph/i);
  assert.equal(
    ingestionRequests[0].init.headers.Authorization,
    'Bearer prod-token[https://monitor.azure.com/.default]',
  );

  // Same scope again: the cached token is reused, no second token request.
  const second = await deliverTo('public');
  assert.equal(second.outcome, 'accepted');
  assert.equal(tokenRequests.length, 1);
  assert.equal(ingestionRequests.length, 2);
  assert.equal(
    ingestionRequests[1].init.headers.Authorization,
    'Bearer prod-token[https://monitor.azure.com/.default]',
  );

  // A different cloud means a different audience: the cache must NOT hand back
  // the public-cloud token — a fresh token is acquired for the new scope.
  const third = await deliverTo('china');
  assert.equal(third.outcome, 'accepted');
  assert.equal(tokenRequests.length, 2);
  assert.equal(tokenRequests[1].params.get('scope'), 'https://monitor.azure.cn/.default');
  assert.doesNotMatch(tokenRequests[1].params.get('scope'), /graph/i);
  assert.equal(ingestionRequests.length, 3);
  assert.equal(
    ingestionRequests[2].init.headers.Authorization,
    'Bearer prod-token[https://monitor.azure.cn/.default]',
  );

  // No credential material leaks into the delivery outcomes.
  for (const outcome of [first, second, third]) {
    const serialized = JSON.stringify(outcome);
    assert.doesNotMatch(serialized, /PRIVATE KEY/);
    assert.ok(!serialized.includes(privateKeyPem));
  }
});
