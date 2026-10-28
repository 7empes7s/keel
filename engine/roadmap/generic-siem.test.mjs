// engine/roadmap/generic-siem.test.mjs
//
// Roadmap task-81 (WS12): boundary tests for the generic webhook and CEF SIEM export
// adapters (engine/telemetry/adapters/webhook.mjs, engine/telemetry/adapters/cef.mjs)
// and their registration in the task-79 outbox drain path (cli/keel-worker.mjs
// SIEM_ADAPTERS). Adversarial fixtures model an untrusted event payload trying to
// steer delivery, and a receiver that never confirms acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';

import { defineEvent } from '../telemetry/events.mjs';
import {
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_DEDUP_KEY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  createWebhookAdapter,
  webhookDestinationUrl,
  webhookDestinationProblems,
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
  cefDestinationProblems,
  cefHttpsUrl,
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
import { schemaSql } from '../store/loadSchema.mjs';

const SCHEMA = schemaSql();
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

function fakeResolve(table) {
  return (hostname, options, callback) => {
    const addresses = table[hostname];
    if (!addresses) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    return callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
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
  const adapter = createCefAdapter({ sendUdp: async () => { throw new Error('must not send an oversized record'); }, allowLoopback: true });
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
  const adapter = createCefAdapter({ sendUdp, allowLoopback: true });
  const destination = { kind: 'cef', config: { transport: 'udp', host: '127.0.0.1', port: 5514, acknowledgement: 'none' } };
  const envelope = fixtureEnvelope('fixture', 1, { host: 'attacker.evil', port: 9999, url: 'https://attacker.evil/collect' });
  await adapter.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk-2' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, '127.0.0.1');
  assert.equal(calls[0].port, 5514);
});

test('webhook destination URL resolution requires https to a public address (audit finding 6)', () => {
  assert.equal(webhookDestinationUrl({ config: { url: 'https://sink.example.test/x' } }).protocol, 'https:');
  assert.throws(() => webhookDestinationUrl({ config: { url: 'http://sink.example.test/x' } }), /https/);
  // Production refuses loopback, link-local (metadata) and private addresses, in any spelling.
  for (const url of [
    'http://127.0.0.1:2019/stop', 'http://localhost:2019/load', 'https://127.0.0.1:2019/stop',
    'https://localhost/x', 'https://169.254.169.254/latest', 'https://10.0.0.5/x', 'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x', 'https://2130706433/x', 'https://0x7f.0.0.1/x',
  ]) {
    assert.throws(() => webhookDestinationUrl({ config: { url } }), /https|public|local/, url);
  }
  // Tests may opt in to a loopback listener; nothing else changes.
  assert.equal(webhookDestinationUrl({ config: { url: 'http://127.0.0.1:8080/x' } }, { allowLoopback: true }).protocol, 'http:');
  assert.throws(() => webhookDestinationUrl({ config: { url: 'https://10.0.0.5/x' } }, { allowLoopback: true }), /public/);
});

test('registering a webhook destination refuses internal addresses and out-of-namespace credential references', async (t) => {
  const { client, admin } = await setup(t);
  for (const config of [
    { url: 'http://127.0.0.1:2019/stop' },
    { url: 'https://169.254.169.254/latest' },
    { url: 'https://sink.example.test/ingest', auth: { type: 'bearer', tokenRef: 'env:KEEL_DB_URL' } },
    { url: 'https://sink.example.test/ingest', auth: { type: 'hmac-sha256', secretRef: 'env:DATABASE_URL' } },
  ]) {
    await assert.rejects(
      registerDestination(client, { tenantRef: 'fixture', name: 'refused', kind: 'webhook', config, requestedBy: admin.id }),
      /webhook destination config/,
      JSON.stringify(config),
    );
  }
  assert.deepEqual(webhookDestinationProblems({
    url: 'https://sink.example.test/ingest', auth: { type: 'bearer', tokenRef: 'env:KEEL_INTEGRATION_SIEM_TOKEN' },
  }), []);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM siem_destination');
  assert.equal(rows[0].n, 0);
});

test('the default webhook transport delivers to a local listener only when a test allows loopback', async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { received.push({ url: req.url, headers: req.headers, body }); res.statusCode = 202; res.end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/ingest`;
  const envelope = fixtureEnvelope('fixture', 1);
  const destination = { kind: 'webhook', config: { url } };

  const production = createWebhookAdapter();
  const refused = await production.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk' });
  assert.equal(refused.outcome, 'retry');
  assert.match(refused.error, /unusable/);
  assert.equal(received.length, 0, 'production settings must not reach a loopback listener');

  const local = createWebhookAdapter({ allowLoopback: true });
  assert.equal(await local.deliver({ destination, envelope, eventId: envelope.eventId, dedupKey: 'dk' }), 'accepted');
  assert.equal(received.length, 1);
  assert.equal(received[0].headers[WEBHOOK_EVENT_ID_HEADER], envelope.eventId);
  assert.equal(JSON.parse(received[0].body).eventId, envelope.eventId);
});

// ---------------------------------------------------------------------------
// Required mutation check 3: "Report unacknowledged syslog delivery successful"
// (Acceptance: "unknown-delivery transport is not reported acknowledged")
// ---------------------------------------------------------------------------

test('CEF udp syslog delivery never reports accepted; a "none" acknowledgement stays honestly uncertain', async () => {
  const { sendUdp, calls } = fakeSendUdp();
  const adapter = createCefAdapter({ sendUdp, allowLoopback: true });
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
  const adapter = createCefAdapter({ sendUdp, allowLoopback: true });
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
  const adapter = createCefAdapter({ sendUdp: async () => { throw new Error('must not send'); }, allowLoopback: true });
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

test('the default webhook transport checks names after DNS and every redirect hop', async (t) => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.statusCode = 307;
    res.setHeader('location', `https://internal.example.test:${server.address().port}/x`);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const resolve = fakeResolve({ 'rebind.example.test': ['127.0.0.1'], 'internal.example.test': ['10.0.0.5'] });
  const envelope = fixtureEnvelope('fixture', 1);
  const deliver = (adapter, url) => adapter.deliver({ destination: { kind: 'webhook', config: { url } }, envelope, eventId: envelope.eventId, dedupKey: 'dk' });

  const rebound = await deliver(createWebhookAdapter({ resolve }), `https://rebind.example.test:${server.address().port}/stop`);
  assert.equal(rebound.outcome, 'retry');
  assert.match(rebound.error, /unusable: rebind\.example\.test resolves to/);
  assert.equal(hits, 0);

  const redirected = await deliver(createWebhookAdapter({ allowLoopback: true, resolve }), `http://127.0.0.1:${server.address().port}/go`);
  assert.equal(redirected.outcome, 'retry');
  assert.match(redirected.error, /unusable: internal\.example\.test resolves to/);
  assert.equal(hits, 1, 'only the first hop is reached');
});

// ---------------------------------------------------------------------------
// CEF: the same address rule over https and udp (audit finding 6 follow-up).
// ---------------------------------------------------------------------------

const BLOCKED_CEF_URLS = [
  'http://127.0.0.1:2019/stop', 'http://localhost:2019/load', 'https://127.0.0.1:2019/stop', 'https://localhost/x',
  'https://169.254.169.254/latest', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x',
  'https://2130706433/x', 'https://0x7f.0.0.1/x', 'https://user:pw@sink.example.test/x', 'http://sink.example.test/x',
];
const BLOCKED_CEF_HOSTS = [
  '127.0.0.1', 'localhost', 'syslog.localhost', '169.254.169.254', '10.0.0.5', '192.168.1.10', '172.16.0.1',
  '100.64.0.1', '0.0.0.0', '::1', '[::1]', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1', '224.0.0.1', '255.255.255.255',
];

test('CEF https and udp destinations must point at public addresses', () => {
  assert.equal(cefHttpsUrl({ url: 'https://sink.example.test/cef' }).hostname, 'sink.example.test');
  for (const url of BLOCKED_CEF_URLS) {
    assert.throws(() => cefHttpsUrl({ url }), /https|public|local|user name/, url);
    assert.notDeepEqual(cefDestinationProblems({ transport: 'https', url }), [], url);
  }
  // Tests may opt in to a loopback listener; nothing else changes.
  assert.equal(cefHttpsUrl({ url: 'http://127.0.0.1:8080/x' }, { allowLoopback: true }).protocol, 'http:');
  assert.throws(() => cefHttpsUrl({ url: 'https://10.0.0.5/x' }, { allowLoopback: true }), /public/);

  for (const host of BLOCKED_CEF_HOSTS) {
    assert.match(cefDestinationProblems({ transport: 'udp', host, port: 514 }).join(';'), /public addresses/, host);
  }
  for (const host of ['2130706433', '0x7f.0.0.1', '127.0.0.1.', '0177.0.0.1']) {
    assert.match(cefDestinationProblems({ transport: 'udp', host, port: 514 }).join(';'), /public addresses/, host);
  }
  assert.deepEqual(cefDestinationProblems({ transport: 'udp', host: 'syslog.example.test', port: 514 }), []);
  assert.deepEqual(cefDestinationProblems({ transport: 'udp', host: '8.8.8.8', port: 514 }), []);
  assert.deepEqual(cefDestinationProblems({ transport: 'https', url: 'https://sink.example.test/cef' }), []);
  assert.match(cefDestinationProblems({ transport: 'udp', host: 'syslog.example.test', port: 0 }).join(';'), /port/);
  assert.match(cefDestinationProblems({ transport: 'tcp', host: 'syslog.example.test', port: 514 }).join(';'), /unsupported/);
});

test('registering a CEF destination refuses internal https and udp addresses', async (t) => {
  const { client, admin } = await setup(t);
  for (const config of [
    { transport: 'udp', host: '127.0.0.1', port: 5514 },
    { transport: 'udp', host: '169.254.169.254', port: 514 },
    { transport: 'udp', host: 'localhost', port: 514 },
    { transport: 'https', url: 'https://10.0.0.5/cef' },
    { transport: 'https', url: 'http://127.0.0.1:2019/load' },
  ]) {
    await assert.rejects(
      registerDestination(client, { tenantRef: 'fixture', name: 'refused', kind: 'cef', config, requestedBy: admin.id }),
      /cef destination config/,
      JSON.stringify(config),
    );
  }
  const { rows } = await client.query('SELECT count(*)::int AS n FROM siem_destination');
  assert.equal(rows[0].n, 0);
});

test('CEF udp checks every address a name resolves to and sends to the checked address, never the name', async () => {
  const envelope = fixtureEnvelope('fixture', 1);
  const resolve = fakeResolve({
    'internal.example.test': ['10.0.0.5'],
    'metadata.example.test': ['169.254.169.254'],
    'mixed.example.test': ['8.8.8.8', '127.0.0.1'],
    'syslog.example.test': ['8.8.4.4'],
    'dual.example.test': ['2001:4860:4860::8888', '8.8.8.8'],
  });
  const deliver = (adapter, host) => adapter.deliver({
    destination: { kind: 'cef', config: { transport: 'udp', host, port: 514, acknowledgement: 'none' } },
    envelope, eventId: envelope.eventId, dedupKey: 'dk',
  });

  for (const host of [...BLOCKED_CEF_HOSTS, 'internal.example.test', 'metadata.example.test', 'mixed.example.test']) {
    const { sendUdp, calls } = fakeSendUdp();
    const outcome = await deliver(createCefAdapter({ sendUdp, resolve }), host);
    assert.equal(outcome.outcome, 'retry', host);
    assert.match(outcome.error, /cef destination unusable: .*public addresses/, host);
    assert.equal(calls.length, 0, `nothing may be sent to ${host}`);
  }

  const { sendUdp, calls } = fakeSendUdp();
  const outcome = await deliver(createCefAdapter({ sendUdp, resolve }), 'syslog.example.test');
  assert.equal(outcome.outcome, 'uncertain');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, '8.8.4.4', 'the datagram goes to the address that was checked, so DNS cannot change it');
  await deliver(createCefAdapter({ sendUdp, resolve }), 'dual.example.test');
  assert.equal(calls[1].host, '8.8.8.8', 'IPv4 is preferred, as the udp4 socket did before');

  const unknown = await deliver(createCefAdapter({ sendUdp, resolve }), 'missing.example.test');
  assert.equal(unknown.outcome, 'retry');
  assert.match(unknown.error, /ENOTFOUND/);
});

test('the default CEF https transport refuses internal addresses after DNS and on every redirect hop', async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push(req.url);
    if (req.url === '/go') {
      res.statusCode = 307;
      res.setHeader('location', `https://internal.example.test:${server.address().port}/x`);
    } else {
      res.statusCode = 202;
    }
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const resolve = fakeResolve({ 'rebind.example.test': ['127.0.0.1'], 'internal.example.test': ['10.0.0.5'] });
  const envelope = fixtureEnvelope('fixture', 1);
  const deliver = (adapter, url) => adapter.deliver({
    destination: { kind: 'cef', config: { transport: 'https', url, acknowledgement: 'http-response' } },
    envelope, eventId: envelope.eventId, dedupKey: 'dk',
  });

  const production = await deliver(createCefAdapter(), `http://127.0.0.1:${port}/ingest`);
  assert.equal(production.outcome, 'retry');
  assert.match(production.error, /unusable/);

  const rebound = await deliver(createCefAdapter({ resolve }), `https://rebind.example.test:${port}/stop`);
  assert.equal(rebound.outcome, 'retry');
  assert.match(rebound.error, /unusable: rebind\.example\.test resolves to/);
  assert.equal(received.length, 0, 'production settings must not reach a loopback listener');

  const redirected = await deliver(createCefAdapter({ allowLoopback: true, resolve }), `http://127.0.0.1:${port}/go`);
  assert.equal(redirected.outcome, 'retry');
  assert.match(redirected.error, /unusable: internal\.example\.test resolves to/);
  assert.deepEqual(received, ['/go'], 'only the first hop is reached');

  assert.equal(await deliver(createCefAdapter({ allowLoopback: true }), `http://127.0.0.1:${port}/ingest`), 'accepted');
  assert.deepEqual(received, ['/go', '/ingest']);
});

test('defaultResolveSecret only understands env:KEEL_INTEGRATION_* references and never invents a credential', () => {
  process.env.KEEL_INTEGRATION_TEST_GENERIC_SIEM_SECRET = 'resolved-value';
  process.env.KEEL_TEST_GENERIC_SIEM_DB_URL = 'postgres://fixture-only';
  assert.equal(defaultResolveSecret('env:KEEL_INTEGRATION_TEST_GENERIC_SIEM_SECRET'), 'resolved-value');
  assert.throws(() => defaultResolveSecret('env:KEEL_INTEGRATION_TEST_GENERIC_SIEM_MISSING'), /unresolved credential reference/);
  // Set, but outside the integration namespace: never resolved (audit hardening note).
  assert.throws(() => defaultResolveSecret('env:KEEL_TEST_GENERIC_SIEM_DB_URL'), /unresolved credential reference/);
  assert.throws(() => defaultResolveSecret('vault:some/path'), /unresolved credential reference/);
  delete process.env.KEEL_INTEGRATION_TEST_GENERIC_SIEM_SECRET;
  delete process.env.KEEL_TEST_GENERIC_SIEM_DB_URL;
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

  // The production webhook adapter goes through the address guard: a destination row
  // that points at the host's own loopback (written behind registration's back) is
  // never contacted, and the event stays pending with the reason. Delivery to a
  // listener is proven above with the same default transport and allowLoopback.
  let listenerHits = 0;
  const listener = http.createServer((req, res) => { listenerHits += 1; res.end(); });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  await client.query('UPDATE siem_destination SET config = $2 WHERE id = $1', [
    webhookDestination.id, { url: `https://127.0.0.1:${listener.address().port}/stop` },
  ]);
  const webhookResults = await drainDueDestinations(client, { adapters: SIEM_ADAPTERS, now: NOW });
  assert.equal(webhookResults.find((r) => r.destinationId === webhookDestination.id)?.delivered, 0);
  const { rows: [blockedRow] } = await client.query(
    'SELECT status, last_error FROM siem_outbox_event WHERE destination_id = $1', [webhookDestination.id]);
  assert.equal(blockedRow.status, 'pending');
  assert.match(blockedRow.last_error, /public addresses/);
  assert.equal(listenerHits, 0);

  // The CEF udp path is exercised against a real bounded loopback socket (no external
  // egress, no live tenant object touched) so the wiring itself — not just the adapter
  // function in isolation — is proven end to end.
  const freeUdpPort = await new Promise((resolve, reject) => {
    const probe = dgram.createSocket('udp4');
    probe.bind(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    probe.on('error', reject);
  });
  // A udp loopback host is refused at registration; a row written behind registration's
  // back is never sent to by the production adapter (audit finding 6).
  await assert.rejects(registerDestination(client, {
    tenantRef: 'fixture', name: 'loopback-cef', kind: 'cef',
    config: { transport: 'udp', host: '127.0.0.1', port: freeUdpPort, acknowledgement: 'none' }, requestedBy: admin.id,
  }), /cef destination config: 127\.0\.0\.1 is a private, local or reserved address/);
  const cefDestination = await registerDestination(client, {
    tenantRef: 'fixture', name: 'wired-cef', kind: 'cef',
    config: { transport: 'udp', host: 'syslog.example.test', port: freeUdpPort, acknowledgement: 'none' }, requestedBy: admin.id,
  });
  await client.query('UPDATE siem_destination SET config = $2 WHERE id = $1', [
    cefDestination.id, { transport: 'udp', host: '127.0.0.1', port: freeUdpPort, acknowledgement: 'none' },
  ]);
  const received = [];
  const socket = dgram.createSocket('udp4');
  socket.on('message', (message) => received.push(message.toString('utf8')));
  await new Promise((resolve) => socket.bind(freeUdpPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => socket.close(resolve)));
  await enqueueEvent(client, { tenantRef: 'fixture', destinationId: cefDestination.id, envelope: fixtureEnvelope('fixture', 2) });
  const cefResults = await drainDueDestinations(client, { adapters: SIEM_ADAPTERS, now: NOW });
  const cefSummary = cefResults.find((r) => r.destinationId === cefDestination.id);
  assert.equal(cefSummary?.delivered, 0);
  assert.equal(cefSummary?.retried, 1);
  const { rows: [cefRow] } = await client.query(
    'SELECT status, last_error FROM siem_outbox_event WHERE destination_id = $1', [cefDestination.id]);
  assert.equal(cefRow.status, 'pending');
  assert.match(cefRow.last_error, /public addresses/);
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.equal(received.length, 0, 'the production adapter must not reach the loopback socket');

  // The CEF udp path is exercised against a real bounded loopback socket (no external
  // egress, no live tenant object touched) with the default udp transport, opened for
  // loopback the way only a test can.
  const later = new Date(NOW.getTime() + 60 * 60 * 1000);
  const local = await drainDestination(client, {
    destinationId: cefDestination.id, adapter: createCefAdapter({ allowLoopback: true }), now: later,
  });
  // A "none" acknowledgement is never delivered; the event stays pending for replay.
  assert.equal(local.delivered, 0);
  assert.equal(local.uncertain, 1);
  for (let i = 0; i < 50 && received.length === 0; i += 1) await new Promise((resolve) => { setTimeout(resolve, 10); });
  assert.equal(received.length, 1, 'the datagram reaches the local socket only when loopback is allowed');
  assert.match(received[0], /^CEF:0\|KEEL\|keel\|/);
});

test('the outbox receiver dedup key stays stable across a webhook redelivery', () => {
  const key1 = receiverDedupKey({ tenantRef: 'fixture', destinationId: 'dest-1', eventId: 'evt-1' });
  const key2 = receiverDedupKey({ tenantRef: 'fixture', destinationId: 'dest-1', eventId: 'evt-1' });
  assert.equal(key1, key2);
});
