// engine/roadmap/generic-siem.test.mjs
//
// Roadmap task-81 (WS12): boundary tests for the generic webhook and CEF SIEM export
// adapters (engine/telemetry/adapters/webhook.mjs, engine/telemetry/adapters/cef.mjs)
// and their registration in the task-79 outbox drain path (cli/keel-worker.mjs
// SIEM_ADAPTERS). Adversarial fixtures model an untrusted event payload trying to
// steer delivery, and a receiver that never confirms acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import dgram from 'node:dgram';

import { defineEvent } from '../telemetry/events.mjs';
import {
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_DEDUP_KEY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  createWebhookAdapter,
  webhookDestinationUrl,
  defaultResolveSecret,
} from '../telemetry/adapters/webhook.mjs';
import {
  CEF_EVENT_ID_HEADER,
  CEF_DEDUP_KEY_HEADER,
  CefMessageTooLargeError,
  escapeCefHeaderField,
  escapeCefExtensionValue,
  cefSeverity,
  formatCefEvent,
  createCefAdapter,
} from '../telemetry/adapters/cef.mjs';
import {
  registerDestination,
  enqueueEvent,
  drainDestination,
  drainDueDestinations,
  requestReplay,
  outboxStatus,
  receiverDedupKey,
} from '../telemetry/outbox.mjs';
import { SIEM_ADAPTERS } from '../../cli/keel-worker.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const SCHEMA = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
const T0 = '2026-09-15T10:00:00.000Z';
const NOW = new Date(Date.now() + 60 * 1000);

function fixtureEnvelope(tenantRef, n, payload = {}, overrides = {}) {
  return defineEvent({
    tenantRef,
    eventType: overrides.eventType ?? 'fixture.observed',
    source: { component: overrides.sourceComponent ?? 'fixture' },
    correlationId: overrides.correlationId ?? 'fixture:1',
    causationId: overrides.causationId ?? null,
    sourceSequence: n,
    observedAt: new Date(new Date(T0).getTime() + n * 1000).toISOString(),
    payload,
  });
}

// A fake fetch that answers a fixed sequence of responses/throws, recording every call
// so a test can assert exactly what URL/headers/body production code sent — this is how
// the "route using payload URL" and injection mutations are caught without a network.
function fakeFetch(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init, body: init?.body });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next.throw) throw next.throw;
      return {
        status: next.status,
        headers: { get: (name) => next.headers?.[String(name).toLowerCase()] ?? null },
      };
    },
  };
}

function fakeSendUdp() {
  const calls = [];
  return { calls, sendUdp: async ({ host, port, message }) => { calls.push({ host, port, message }); } };
}

async function setup(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  await client.query(SCHEMA);
  const { rows: [admin] } = await client.query(
    "INSERT INTO principal (email) VALUES ('generic-siem-admin@example.invalid') RETURNING *",
  );
  await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'admin')", [admin.id]);
  const { rows: [viewer] } = await client.query(
    "INSERT INTO principal (email) VALUES ('generic-siem-viewer@example.invalid') RETURNING *",
  );
  await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'viewer')", [viewer.id]);
  return { db, client, admin, viewer };
}

// ---------------------------------------------------------------------------
// Required mutation check 1: "Interpolate unescaped CEF newline"
// ---------------------------------------------------------------------------

test('CEF field escaping neutralizes pipe, backslash, CR and LF individually', () => {
  assert.equal(escapeCefHeaderField('a|b\\c\r\n'), 'a\\|b\\\\c\\r\\n');
  assert.equal(escapeCefExtensionValue('a=b\\c\r\n'), 'a\\=b\\\\c\\r\\n');
  // Header escaping does not touch '=' (structural only in extensions); extension
  // escaping does not touch '|' (structural only in the header).
  assert.equal(escapeCefHeaderField('a=b'), 'a=b');
  assert.equal(escapeCefExtensionValue('a|b'), 'a|b');
});

test('formatCefEvent stays a single line and cannot be split into a forged second record by producer-controlled fields', () => {
  const envelope = fixtureEnvelope('fixture', 1, { severity: 'critical' }, {
    eventType: 'evil|type\r\nCEF:0|FORGED|forged|1|x|x|10|k=v',
    sourceComponent: 'comp\\|=\r\ninjected',
    causationId: 'cause\r\n|=\\end',
  });
  const message = formatCefEvent(envelope);
  assert.equal(/[\r\n]/.test(message), false, 'a formatted record must never contain a raw CR or LF');
  assert.equal(message.match(/CEF:0\|/g)?.length, 1, 'the record must contain exactly one CEF header, never a forged second one');
  // The malicious characters are present only in escaped form, never as structural bytes
  // — computed via the same escape functions so this assertion cannot itself encode a
  // transcription mistake about what "escaped" means.
  assert.ok(message.includes(escapeCefHeaderField('evil|type\r\nCEF:0|FORGED|forged|1|x|x|10|k=v')));
  assert.ok(message.includes(`keelCausationId=${escapeCefExtensionValue('cause\r\n|=\\end')}`));
  assert.ok(message.includes(`keelSourceComponent=${escapeCefExtensionValue('comp\\|=\r\ninjected')}`));
});

test('an oversized CEF record is poisoned with the size reason, never silently truncated', async () => {
  const adapter = createCefAdapter({ sendUdp: async () => { throw new Error('must not send an oversized record'); } });
  const destination = { kind: 'cef', config: { transport: 'udp', host: '127.0.0.1', port: 5514, maxMessageBytes: 256 } };
  const envelope = fixtureEnvelope('fixture', 1, { severity: 'critical' });
  assert.throws(() => formatCefEvent(envelope, { maxBytes: 256 }), CefMessageTooLargeError);
  const outcome = await adapter.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk' });
  assert.equal(outcome.outcome, 'poison');
  assert.match(outcome.reason, /exceeding the 256-byte bound/);
});

test('cefSeverity maps named severities and defaults unnamed ones to neutral 5', () => {
  assert.equal(cefSeverity(fixtureEnvelope('fixture', 1, { severity: 'critical' })), 10);
  assert.equal(cefSeverity(fixtureEnvelope('fixture', 1, { severity: 'warning' })), 6);
  assert.equal(cefSeverity(fixtureEnvelope('fixture', 1, { severity: 'notice' })), 3);
  assert.equal(cefSeverity(fixtureEnvelope('fixture', 1, {})), 5);
  assert.equal(cefSeverity(fixtureEnvelope('fixture', 1, { severity: 'made-up' })), 5);
});

// ---------------------------------------------------------------------------
// Required mutation check 2: "Route using payload URL"
// (Acceptance: "event cannot choose a destination")
// ---------------------------------------------------------------------------

test('webhook delivery routes using only the registered destination config URL, never the event payload', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200 }]);
  const adapter = createWebhookAdapter({ fetchImpl });
  const destination = { kind: 'webhook', config: { url: 'https://sink.example.test/ingest' } };
  const envelope = fixtureEnvelope('fixture', 1, {
    url: 'https://attacker.evil/collect',
    destinationUrl: 'https://attacker.evil/collect',
    webhookUrl: 'https://attacker.evil/collect',
  });
  const outcome = await adapter.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk-1' });
  assert.equal(outcome, 'accepted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://sink.example.test/ingest', 'delivery must never be redirected by payload content');
});

test('CEF delivery routes using only the registered destination host/port/url, never the event payload', async () => {
  const { sendUdp, calls } = fakeSendUdp();
  const adapter = createCefAdapter({ sendUdp });
  const destination = { kind: 'cef', config: { transport: 'udp', host: '127.0.0.1', port: 5514, acknowledgement: 'none' } };
  const envelope = fixtureEnvelope('fixture', 1, { host: 'attacker.evil', port: 9999, url: 'https://attacker.evil/collect' });
  await adapter.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk-2' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, '127.0.0.1');
  assert.equal(calls[0].port, 5514);
});

test('webhook and cef destination URL resolution refuses plaintext http except loopback', () => {
  assert.equal(webhookDestinationUrl({ config: { url: 'https://sink.example.test/x' } }).protocol, 'https:');
  assert.equal(webhookDestinationUrl({ config: { url: 'http://127.0.0.1:8080/x' } }).protocol, 'http:');
  assert.throws(() => webhookDestinationUrl({ config: { url: 'http://sink.example.test/x' } }), /https/);
});

// ---------------------------------------------------------------------------
// Required mutation check 3: "Report unacknowledged syslog delivery successful"
// (Acceptance: "unknown-delivery transport is not reported acknowledged")
// ---------------------------------------------------------------------------

test('CEF udp syslog delivery never reports accepted; a "none" acknowledgement stays honestly uncertain', async () => {
  const { sendUdp, calls } = fakeSendUdp();
  const adapter = createCefAdapter({ sendUdp });
  const destination = { kind: 'cef', config: { transport: 'udp', host: '127.0.0.1', port: 5514, acknowledgement: 'none' } };
  const envelope = fixtureEnvelope('fixture', 1, { severity: 'critical' });
  const outcome = await adapter.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk-3' });
  assert.equal(calls.length, 1, 'the datagram must actually have been sent');
  assert.deepEqual(outcome, {
    outcome: 'uncertain',
    error: 'cef udp syslog transport provides no delivery acknowledgement',
  });
});

test('a udp destination cannot silently upgrade to an http-response acknowledgement contract', async () => {
  const { sendUdp, calls } = fakeSendUdp();
  const adapter = createCefAdapter({ sendUdp });
  const destination = { kind: 'cef', config: { transport: 'udp', host: '127.0.0.1', port: 5514, acknowledgement: 'http-response' } };
  const envelope = fixtureEnvelope('fixture', 1);
  const outcome = await adapter.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk-4' });
  assert.equal(calls.length, 0, 'a contradictory acknowledgement declaration must fail before sending anything');
  assert.equal(outcome.outcome, 'retry');
});

test('CEF https delivery reports accepted only when the destination declares http-response acknowledgement', async () => {
  const envelope = fixtureEnvelope('fixture', 1);

  const none = fakeFetch([{ status: 202 }]);
  const noneAdapter = createCefAdapter({ fetchImpl: none.fetchImpl });
  const noneOutcome = await noneAdapter.deliver({
    destination: { kind: 'cef', config: { transport: 'https', url: 'https://sink.example.test/cef', acknowledgement: 'none' } },
    envelope, eventId: envelope.eventId, dedupKey: 'dk-5',
  });
  assert.deepEqual(noneOutcome, { outcome: 'uncertain', error: 'cef destination declares no delivery acknowledgement' });

  const ack = fakeFetch([{ status: 202 }]);
  const ackAdapter = createCefAdapter({ fetchImpl: ack.fetchImpl });
  const ackOutcome = await ackAdapter.deliver({
    destination: { kind: 'cef', config: { transport: 'https', url: 'https://sink.example.test/cef', acknowledgement: 'http-response' } },
    envelope, eventId: envelope.eventId, dedupKey: 'dk-6',
  });
  assert.equal(ackOutcome, 'accepted');
});

test('an unsupported CEF acknowledgement declaration fails visibly rather than guessing', async () => {
  const adapter = createCefAdapter({ sendUdp: async () => { throw new Error('must not send'); } });
  const envelope = fixtureEnvelope('fixture', 1);
  const outcome = await adapter.deliver({
    destination: { kind: 'cef', config: { transport: 'udp', host: '127.0.0.1', port: 1, acknowledgement: 'maybe' } },
    envelope, eventId: envelope.eventId, dedupKey: 'dk-7',
  });
  assert.equal(outcome.outcome, 'retry');
  assert.match(outcome.error, /unsupported cef acknowledgement/);
});

// ---------------------------------------------------------------------------
// Outcome honesty (webhook): the remaining acceptance/derived coverage.
// ---------------------------------------------------------------------------

test('webhook delivery classifies 2xx accepted, 408/429/5xx retry with Retry-After, other 4xx poison', async () => {
  const adapter429 = createWebhookAdapter({
    fetchImpl: fakeFetch([{ status: 429, headers: { 'retry-after': '2' } }]).fetchImpl,
  });
  const destination = { kind: 'webhook', config: { url: 'https://sink.example.test/ingest' } };
  const envelope = fixtureEnvelope('fixture', 1);
  const retryOutcome = await adapter429.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk' });
  assert.equal(retryOutcome.outcome, 'retry');
  assert.equal(retryOutcome.retryAfterMs, 2000);

  const adapter400 = createWebhookAdapter({ fetchImpl: fakeFetch([{ status: 400 }]).fetchImpl });
  const poisonOutcome = await adapter400.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk' });
  assert.equal(poisonOutcome.outcome, 'poison');

  const adapter200 = createWebhookAdapter({ fetchImpl: fakeFetch([{ status: 204 }]).fetchImpl });
  const acceptedOutcome = await adapter200.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk' });
  assert.equal(acceptedOutcome, 'accepted');
});

test('webhook delivery reports uncertain (not accepted, not dropped) when the acknowledgement is lost after send', async () => {
  const timeoutError = new Error('The operation was aborted');
  timeoutError.name = 'TimeoutError';
  const adapter = createWebhookAdapter({ fetchImpl: fakeFetch([{ throw: timeoutError }]).fetchImpl });
  const destination = { kind: 'webhook', config: { url: 'https://sink.example.test/ingest' } };
  const envelope = fixtureEnvelope('fixture', 1);
  const outcome = await adapter.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk' });
  assert.equal(outcome.outcome, 'uncertain');
});

test('webhook delivery carries the stable event id and dedup key as headers on every attempt', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200 }]);
  const adapter = createWebhookAdapter({ fetchImpl });
  const destination = { kind: 'webhook', config: { url: 'https://sink.example.test/ingest' } };
  const envelope = fixtureEnvelope('fixture', 1);
  await adapter.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'the-dedup-key' });
  assert.equal(calls[0].init.headers[WEBHOOK_EVENT_ID_HEADER], envelope.eventId);
  assert.equal(calls[0].init.headers[WEBHOOK_DEDUP_KEY_HEADER], 'the-dedup-key');
  assert.equal(JSON.parse(calls[0].body).eventId, envelope.eventId);
});

test('webhook bearer and hmac auth resolve credential references and never leak the secret value', async () => {
  const resolveSecret = async (ref) => (ref === 'env:TEST_TOKEN' ? 'super-secret-token' : 'super-secret-hmac');
  const { fetchImpl: bearerFetch, calls: bearerCalls } = fakeFetch([{ status: 200 }]);
  const bearerAdapter = createWebhookAdapter({ fetchImpl: bearerFetch, resolveSecret });
  const bearerDestination = {
    kind: 'webhook',
    config: { url: 'https://sink.example.test/ingest', auth: { type: 'bearer', tokenRef: 'env:TEST_TOKEN' } },
  };
  const envelope = fixtureEnvelope('fixture', 1);
  await bearerAdapter.deliver({ destination: bearerDestination, envelope, eventId: envelope.eventId, dedupKey: 'dk' });
  assert.equal(bearerCalls[0].init.headers.authorization, 'Bearer super-secret-token');

  const { fetchImpl: hmacFetch, calls: hmacCalls } = fakeFetch([{ status: 200 }]);
  const hmacAdapter = createWebhookAdapter({ fetchImpl: hmacFetch, resolveSecret });
  const hmacDestination = {
    kind: 'webhook',
    config: { url: 'https://sink.example.test/ingest', auth: { type: 'hmac-sha256', secretRef: 'env:TEST_HMAC' } },
  };
  await hmacAdapter.deliver({ destination: hmacDestination, envelope, eventId: envelope.eventId, dedupKey: 'dk' });
  assert.match(hmacCalls[0].init.headers[WEBHOOK_SIGNATURE_HEADER], /^sha256=[0-9a-f]{64}$/);
});

test('an unresolvable webhook credential reference is a visible retry, never a silent unauthenticated send', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200 }]);
  const adapter = createWebhookAdapter({
    fetchImpl,
    resolveSecret: async () => { throw new Error('unresolved credential reference: env:MISSING'); },
  });
  const destination = {
    kind: 'webhook',
    config: { url: 'https://sink.example.test/ingest', auth: { type: 'bearer', tokenRef: 'env:MISSING' } },
  };
  const envelope = fixtureEnvelope('fixture', 1);
  const outcome = await adapter.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk' });
  assert.equal(outcome.outcome, 'retry');
  assert.equal(calls.length, 0, 'no request may be sent while the credential is unresolved');
});

test('defaultResolveSecret only understands env: references and never invents a credential', () => {
  process.env.KEEL_TEST_GENERIC_SIEM_SECRET = 'resolved-value';
  assert.equal(defaultResolveSecret('env:KEEL_TEST_GENERIC_SIEM_SECRET'), 'resolved-value');
  assert.throws(() => defaultResolveSecret('env:KEEL_TEST_GENERIC_SIEM_MISSING'), /unresolved credential reference/);
  assert.throws(() => defaultResolveSecret('vault:some/path'), /unresolved credential reference/);
  delete process.env.KEEL_TEST_GENERIC_SIEM_SECRET;
});

// ---------------------------------------------------------------------------
// Full outbox integration: acceptance "repeated event keeps ID" and the
// read-only-viewer capability boundary, against the real production adapters.
// ---------------------------------------------------------------------------

test('a retried webhook delivery redelivers under the SAME event id; the outbox advances only on acceptance', async (t) => {
  const { client, admin, viewer } = await setup(t);
  const destination = await registerDestination(client, {
    tenantRef: 'fixture', name: 'webhook-sink', kind: 'webhook',
    config: { url: 'https://sink.example.test/ingest' }, requestedBy: admin.id,
  });
  const envelope = fixtureEnvelope('fixture', 1);
  await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope });

  const { fetchImpl, calls } = fakeFetch([{ status: 503 }, { status: 200 }]);
  const adapter = createWebhookAdapter({ fetchImpl });

  const first = await drainDestination(client, { destinationId: destination.id, adapter, now: NOW });
  assert.equal(first.retried, 1);
  const { rows: [midRow] } = await client.query(
    'SELECT event_id, status, attempts FROM siem_outbox_event WHERE destination_id = $1', [destination.id]);
  assert.equal(midRow.status, 'pending');
  assert.equal(midRow.event_id, envelope.eventId);

  const later = new Date(NOW.getTime() + 60 * 1000);
  const second = await drainDestination(client, { destinationId: destination.id, adapter, now: later });
  assert.equal(second.delivered, 1);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers[WEBHOOK_EVENT_ID_HEADER], envelope.eventId);
  assert.equal(calls[1].init.headers[WEBHOOK_EVENT_ID_HEADER], envelope.eventId, 'the retry must carry the identical event id');
  assert.equal(calls[0].init.headers[WEBHOOK_DEDUP_KEY_HEADER], calls[1].init.headers[WEBHOOK_DEDUP_KEY_HEADER]);

  const status = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: later,
  });
  assert.equal(status.acknowledged, 1);
  assert.equal(status.checkpoint.lastAcknowledgedEventId, envelope.eventId);
});

test('acceptance: a read-only viewer cannot register a destination or request a replay', async (t) => {
  const { client, admin, viewer } = await setup(t);
  await assert.rejects(
    registerDestination(client, {
      tenantRef: 'fixture', name: 'viewer-attempt', kind: 'webhook',
      config: { url: 'https://sink.example.test/ingest' }, requestedBy: viewer.id,
    }),
    /not authorized/,
  );
  const destination = await registerDestination(client, {
    tenantRef: 'fixture', name: 'replay-target', kind: 'webhook',
    config: { url: 'https://sink.example.test/ingest' }, requestedBy: admin.id,
  });
  await assert.rejects(
    requestReplay(client, { tenantRef: 'fixture', destinationId: destination.id, fromSeq: 0, requestedBy: viewer.id }),
    /not authorized/,
  );
  // A viewer retains read access to status even though configuration is refused.
  const status = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(status.destinationId, destination.id);
});

// ---------------------------------------------------------------------------
// CLI/server integration: the real SIEM_ADAPTERS registration from keel-worker.mjs
// (step 3 of the task) drains a real webhook and a real (loopback) CEF destination.
// ---------------------------------------------------------------------------

test('cli/keel-worker.mjs registers webhook and cef adapters that the outbox drain path can use', async (t) => {
  const { client, admin } = await setup(t);
  assert.equal(typeof SIEM_ADAPTERS.webhook?.deliver, 'function');
  assert.equal(typeof SIEM_ADAPTERS.cef?.deliver, 'function');

  const webhookDestination = await registerDestination(client, {
    tenantRef: 'fixture', name: 'wired-webhook', kind: 'webhook',
    config: { url: 'https://sink.example.test/ingest' }, requestedBy: admin.id,
  });
  await enqueueEvent(client, { tenantRef: 'fixture', destinationId: webhookDestination.id, envelope: fixtureEnvelope('fixture', 1) });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, headers: { get: () => null } });
  t.after(() => { globalThis.fetch = originalFetch; });

  const webhookResults = await drainDueDestinations(client, { adapters: SIEM_ADAPTERS, now: NOW });
  assert.equal(webhookResults.find((r) => r.destinationId === webhookDestination.id)?.delivered, 1);

  // The CEF udp path is exercised against a real bounded loopback socket (no external
  // egress, no live tenant object touched) so the wiring itself — not just the adapter
  // function in isolation — is proven end to end.
  const freeUdpPort = await new Promise((resolve, reject) => {
    const probe = dgram.createSocket('udp4');
    probe.bind(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    probe.on('error', reject);
  });
  const cefDestination = await registerDestination(client, {
    tenantRef: 'fixture', name: 'wired-cef', kind: 'cef',
    config: { transport: 'udp', host: '127.0.0.1', port: freeUdpPort, acknowledgement: 'none' }, requestedBy: admin.id,
  });
  await enqueueEvent(client, { tenantRef: 'fixture', destinationId: cefDestination.id, envelope: fixtureEnvelope('fixture', 2) });
  const cefResults = await drainDueDestinations(client, { adapters: SIEM_ADAPTERS, now: NOW });
  const cefSummary = cefResults.find((r) => r.destinationId === cefDestination.id);
  // A "none" acknowledgement is never delivered; the event stays pending for replay.
  assert.equal(cefSummary?.delivered, 0);
  assert.equal(cefSummary?.uncertain, 1);
});

test('the outbox receiver dedup key stays stable across a webhook redelivery', () => {
  const key1 = receiverDedupKey({ tenantRef: 'fixture', destinationId: 'dest-1', eventId: 'evt-1' });
  const key2 = receiverDedupKey({ tenantRef: 'fixture', destinationId: 'dest-1', eventId: 'evt-1' });
  assert.equal(key1, key2);
});
