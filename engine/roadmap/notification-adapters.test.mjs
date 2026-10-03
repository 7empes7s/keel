// Roadmap task-84: Teams, Slack, PagerDuty and SMS channel adapters.
//
// Acceptance:
//  - each adapter has request/response fixtures, including throttle, rejection and
//    missing setup;
//  - the PagerDuty dedup key is stable across retries;
//  - an unsupported endpoint or provider stays unconfigured (nothing is sent);
//  - no secret appears in evidence.
// Mutation checks:
//  - ignore Retry-After;
//  - change the incident dedup key on retry;
//  - record the webhook secret URL in evidence.
//
// Every provider call goes to an injected fixture `fetch`; nothing reaches a real
// provider.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  ChannelConfigError, NotificationSendError, createAdapterTransport, createAdapterTransports, parseRetryAfter,
} from '../notify/adapters.mjs';
import { DeliveryAttemptError, attemptDelivery, createChannel, queueDelivery } from '../notify/notifications.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

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

// Secret values the fixtures resolve. None of them may show up in anything KEEL records.
const SECRETS = {
  'env:KEEL_TEAMS_WEBHOOK': 'https://prod-12.westus.logic.azure.com:443/workflows/0a1b2c/triggers/manual/paths/invoke?api-version=2016-06-01&sig=TeamsSig0123456789secret',
  'env:KEEL_SLACK_WEBHOOK': 'https://hooks.slack.com/services/T0KEEL000/B0KEEL000/SlackSecretToken0123456789',
  'env:KEEL_PAGERDUTY_KEY': 'R0utingKey0123456789abcdefABCDEF',
  'env:KEEL_TWILIO_TOKEN': 'twilioAuthToken0123456789abcdef',
  'env:KEEL_LEGACY_TEAMS': 'https://contoso.webhook.office.com/webhookb2/aaaa@bbbb/IncomingWebhook/cccc/dddd',
  'env:KEEL_NOT_SLACK': 'https://hooks.contoso.example/services/T0/B0/xyzSecretPath',
};
const SECRET_VALUES = [...Object.values(SECRETS), ...Object.values(SECRETS).filter((value) => value.startsWith('https:')).map((value) => new URL(value).href)];
const resolveSecret = (reference) => SECRETS[reference] ?? null;

const CONFIGS = {
  teams: { endpointRef: 'env:KEEL_TEAMS_WEBHOOK' },
  slack: { endpointRef: 'env:KEEL_SLACK_WEBHOOK' },
  pagerduty: { routingKeyRef: 'env:KEEL_PAGERDUTY_KEY', region: 'eu' },
  sms: { provider: 'twilio', accountSid: `AC${'0123456789abcdef'.repeat(2)}`, authTokenRef: 'env:KEEL_TWILIO_TOKEN', from: '+15551230000', to: '+15551239999' },
};

const EVENT = Object.freeze({
  kind: 'alert.escalated', severity: 'critical', alertId: '6f1c2a54-1d3b-4c8e-9a51-3e0d7c1b2a90', occurrence: 2,
  tenantRef: 'sha256:task-84', resourceKey: 'group:board', control: 'baseline', condition: 'drift',
  ackDeadlineAt: '2026-10-03T22:00:00.000Z', requiresUnacknowledged: false,
});
const DELIVERY = Object.freeze({ id: '0d3e1c2b-5a6f-4b7c-8d9e-0f1a2b3c4d5e' });

/** A fixture `fetch` answering from a script, recording every request. */
function fixtureFetch(...replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return new Response(reply.body ?? '', { status: reply.status, headers: reply.headers ?? {} });
  };
  return { fetchImpl, calls };
}

const NOW = new Date('2026-10-03T21:00:00.000Z');
const transportFor = (kind, fetchImpl) => createAdapterTransport(kind, { fetchImpl, resolveSecret, now: () => NOW });
const channel = (kind, config = CONFIGS[kind]) => ({ id: crypto.randomUUID(), kind, config, enabled: true });

async function sendError(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof NotificationSendError, `expected NotificationSendError, got ${error}`);
    return error;
  }
  assert.fail('expected the send to fail');
}

function assertNoSecret(label, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRET_VALUES) assert.ok(!text.includes(secret), `${label} contains a secret: ${text}`);
  assert.ok(!/SlackSecretToken|TeamsSig|R0utingKey|twilioAuthToken|xyzSecretPath/.test(text), `${label} contains part of a secret: ${text}`);
}

// What each provider answers. `ok` is the success fixture; `throttle` carries Retry-After.
const FIXTURES = {
  teams: { ok: { status: 202 }, reject: { status: 400, body: 'Invalid adaptive card' } },
  slack: { ok: { status: 200, body: 'ok' }, reject: { status: 404, body: 'no_service' } },
  pagerduty: {
    ok: { status: 202, body: JSON.stringify({ status: 'success', message: 'Event processed', dedup_key: 'keel:alert:6f1c2a54-1d3b-4c8e-9a51-3e0d7c1b2a90:2' }) },
    reject: { status: 400, body: JSON.stringify({ status: 'invalid event', message: 'Event object is invalid', errors: ['Length of \'routing_key\' is incorrect'] }) },
  },
  sms: {
    ok: { status: 201, body: JSON.stringify({ sid: `SM${'a'.repeat(32)}`, status: 'queued' }) },
    reject: { status: 400, body: JSON.stringify({ code: 21211, message: "The 'To' number +15551239999 is not a valid phone number.", status: 400 }) },
  },
};
const THROTTLE = { status: 429, headers: { 'retry-after': '120' }, body: 'rate_limited' };

test('each adapter sends the provider-shaped request and reads its success reply', async () => {
  const expectations = {
    teams: ({ url, init }) => {
      assert.equal(url, new URL(SECRETS['env:KEEL_TEAMS_WEBHOOK']).href);
      const body = JSON.parse(init.body);
      assert.equal(body.type, 'message');
      assert.equal(body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
      assert.equal(body.attachments[0].content.type, 'AdaptiveCard');
      assert.match(body.attachments[0].content.body[0].text, /^\[KEEL CRITICAL\] alert\.escalated: group:board/);
    },
    slack: ({ url, init }) => {
      assert.equal(url, new URL(SECRETS['env:KEEL_SLACK_WEBHOOK']).href);
      const body = JSON.parse(init.body);
      assert.match(body.text, /^\[KEEL CRITICAL\] alert\.escalated/);
      assert.equal(body.unfurl_links, false);
    },
    pagerduty: ({ url, init }) => {
      assert.equal(url, 'https://events.eu.pagerduty.com/v2/enqueue', 'the configured region decides the endpoint');
      const body = JSON.parse(init.body);
      assert.equal(body.routing_key, SECRETS['env:KEEL_PAGERDUTY_KEY']);
      assert.equal(body.event_action, 'trigger');
      assert.equal(body.dedup_key, `keel:alert:${EVENT.alertId}:2`);
      assert.equal(body.payload.severity, 'critical');
      assert.ok(body.payload.summary.length <= 1024);
    },
    sms: ({ url, init }) => {
      assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${CONFIGS.sms.accountSid}/Messages.json`);
      assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.equal(init.headers.authorization, `Basic ${Buffer.from(`${CONFIGS.sms.accountSid}:${SECRETS['env:KEEL_TWILIO_TOKEN']}`).toString('base64')}`);
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('To'), '+15551239999');
      assert.equal(form.get('From'), '+15551230000');
      assert.ok(form.get('Body').length <= 320);
    },
  };
  for (const kind of Object.keys(expectations)) {
    const { fetchImpl, calls } = fixtureFetch(FIXTURES[kind].ok);
    const { receipt } = await transportFor(kind, fetchImpl)({ channel: channel(kind), event: EVENT, delivery: DELIVERY });
    assert.equal(calls.length, 1, kind);
    expectations[kind](calls[0]);
    assert.equal(receipt.outcome, 'delivered', kind);
    assert.ok(receipt.semantics, `${kind} says what delivered means`);
    assertNoSecret(`${kind} receipt`, receipt);
  }
});

test('throttling is a retry that carries the provider\'s Retry-After; a refusal is final', async () => {
  for (const kind of Object.keys(FIXTURES)) {
    const throttled = await sendError(transportFor(kind, fixtureFetch(THROTTLE).fetchImpl)({ channel: channel(kind), event: EVENT, delivery: DELIVERY }));
    assert.equal(throttled.outcome, 'retry', kind);
    assert.equal(throttled.retryAfterMs, 120_000, `${kind} normalizes Retry-After to milliseconds`);
    assertNoSecret(`${kind} throttle`, [throttled.message, throttled.receipt]);

    const rejected = await sendError(transportFor(kind, fixtureFetch(FIXTURES[kind].reject).fetchImpl)({ channel: channel(kind), event: EVENT, delivery: DELIVERY }));
    assert.equal(rejected.outcome, 'rejected', kind);
    assert.equal(rejected.retryAfterMs, null, kind);
    assert.equal(rejected.receipt.httpStatus, FIXTURES[kind].reject.status, kind);
    assertNoSecret(`${kind} rejection`, [rejected.message, rejected.receipt]);

    const down = await sendError(transportFor(kind, fixtureFetch({ status: 503 }).fetchImpl)({ channel: channel(kind), event: EVENT, delivery: DELIVERY }));
    assert.equal(down.outcome, 'retry', `${kind}: 5xx retries`);
    assert.equal(down.retryAfterMs, null, `${kind}: no Retry-After falls back to KEEL's backoff`);
  }
  assert.equal(parseRetryAfter('Sat, 03 Oct 2026 21:02:00 GMT', NOW), 120_000, 'an HTTP date is read relative to now');
  assert.equal(parseRetryAfter('86400', NOW), 60 * 60 * 1000, 'Retry-After is capped');
  assert.equal(parseRetryAfter('soon', NOW), null);
});

test('missing setup, an unsupported endpoint or an unsupported provider stays unconfigured and sends nothing', async () => {
  const cases = [
    ['teams', { endpointRef: 'env:KEEL_UNSET' }, /env:KEEL_UNSET has no value/],
    ['slack', { endpointRef: 'env:KEEL_UNSET' }, /has no value/],
    ['pagerduty', { routingKeyRef: 'env:KEEL_UNSET' }, /has no value/],
    ['sms', { ...CONFIGS.sms, authTokenRef: 'env:KEEL_UNSET' }, /has no value/],
    ['teams', { endpointRef: 'env:KEEL_LEGACY_TEAMS' }, /retired Office 365 connector/],
    ['teams', { endpointRef: 'env:KEEL_SLACK_WEBHOOK' }, /not a Teams Workflows webhook host/],
    ['slack', { endpointRef: 'env:KEEL_NOT_SLACK' }, /not a Slack incoming webhook/],
    ['sms', { ...CONFIGS.sms, provider: 'vonage' }, /SMS provider vonage is not supported/],
    ['pagerduty', { routingKeyRef: 'env:KEEL_PAGERDUTY_KEY', region: 'apac' }, /region must be us or eu/],
  ];
  for (const [kind, config, reason] of cases) {
    const { fetchImpl, calls } = fixtureFetch(FIXTURES[kind].ok);
    const error = await sendError(transportFor(kind, fetchImpl)({ channel: channel(kind, config), event: EVENT, delivery: DELIVERY }));
    assert.equal(error.outcome, 'unconfigured', `${kind} ${JSON.stringify(config)}`);
    assert.match(error.message, reason);
    assert.equal(calls.length, 0, `${kind}: nothing is sent while unconfigured`);
    assertNoSecret(`${kind} unconfigured`, [error.message, error.receipt]);
  }
});

test('channels store credential references only and refuse an unsupported provider', async (t) => {
  const client = await schemaClient(t);
  const refused = [
    ['teams', { url: SECRETS['env:KEEL_TEAMS_WEBHOOK'] }, /url is not a setting|endpointRef is required/],
    ['slack', { endpointRef: SECRETS['env:KEEL_SLACK_WEBHOOK'] }, /endpointRef must be a credential reference/],
    ['pagerduty', { routingKeyRef: SECRETS['env:KEEL_PAGERDUTY_KEY'] }, /routingKeyRef must be a credential reference/],
    ['sms', { ...CONFIGS.sms, provider: 'vonage' }, /SMS provider vonage is not supported \(supported: twilio\)/],
    ['sms', { ...CONFIGS.sms, provider: undefined }, /provider is required/],
    ['sms', { ...CONFIGS.sms, to: '5551239999' }, /to must be one phone number in E\.164 form/],
  ];
  for (const [kind, config, reason] of refused) {
    await assert.rejects(createChannel(client, { kind, config: JSON.parse(JSON.stringify(config)) }), (error) => {
      assert.ok(error instanceof ChannelConfigError, String(error));
      assert.match(error.message, reason);
      assertNoSecret('config error', error.message);
      return true;
    });
  }
  for (const kind of Object.keys(CONFIGS)) {
    const created = await createChannel(client, { kind, config: CONFIGS[kind] });
    assert.equal(created.kind, kind);
  }
  // A legacy row (or one written by hand) naming an unsupported provider stays unconfigured.
  const { rows: [legacy] } = await client.query(
    "INSERT INTO channel (kind, config) VALUES ('sms', $1) RETURNING *", [{ ...CONFIGS.sms, provider: 'vonage' }],
  );
  const { delivery } = await queued(client, legacy.id);
  const { fetchImpl, calls } = fixtureFetch(FIXTURES.sms.ok);
  const result = await attemptDelivery(client, { deliveryId: delivery.id, transports: transports(fetchImpl) });
  assert.equal(result.delivery.status, 'cancelled');
  assert.match(result.delivery.last_error, /SMS provider vonage is not supported/);
  assert.equal(result.delivery.provider_receipt.outcome, 'unconfigured');
  assert.equal(calls.length, 0);
  assert.equal(await notifyJobs(client, delivery.id), 1, 'no retry is queued for missing setup');
});

let admin = null;
async function requester(client) {
  if (!admin) {
    const { rows: [row] } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id', [`${crypto.randomUUID()}@contoso.example`]);
    admin = row.id;
  }
  return admin;
}

async function queued(client, channelId, event = EVENT) {
  const requestedBy = await requester(client);
  await client.query('BEGIN');
  const result = await queueDelivery(client, { event, channelId, requestedBy, maxAttempts: 5 });
  await client.query('COMMIT');
  return result;
}

const transports = (fetchImpl) => createAdapterTransports({ fetchImpl, resolveSecret, now: () => NOW });

async function notifyJobs(client, deliveryId) {
  const { rows: [row] } = await client.query("SELECT count(*)::int AS n FROM job WHERE kind = 'notify' AND params->>'deliveryId' = $1", [deliveryId]);
  return row.n;
}

async function attemptExpectingFailure(client, deliveryId, fetchImpl, now = NOW) {
  await client.query("UPDATE delivery SET next_attempt_at = now() - interval '1 second' WHERE id = $1 AND status = 'retrying'", [deliveryId]);
  try {
    await attemptDelivery(client, { deliveryId, transports: transports(fetchImpl), now });
  } catch (error) {
    assert.ok(error instanceof DeliveryAttemptError, String(error));
    return error;
  }
  assert.fail('expected the attempt to fail');
}

test('a throttled PagerDuty send waits for Retry-After and retries under the same dedup key', async (t) => {
  const client = await schemaClient(t);
  const pd = await createChannel(client, { kind: 'pagerduty', config: CONFIGS.pagerduty });
  const { delivery } = await queued(client, pd.id);
  const { fetchImpl, calls } = fixtureFetch(THROTTLE, { status: 502 }, FIXTURES.pagerduty.ok);

  await attemptExpectingFailure(client, delivery.id, fetchImpl);
  let row = (await client.query('SELECT * FROM delivery WHERE id = $1', [delivery.id])).rows[0];
  assert.equal(row.status, 'retrying');
  assert.equal(row.next_attempt_at.toISOString(), new Date(NOW.getTime() + 120_000).toISOString(),
    'the next attempt waits exactly the provider\'s Retry-After, not KEEL\'s 30 s backoff');
  const { rows: [job] } = await client.query(
    "SELECT not_before FROM job WHERE kind = 'notify' AND params->>'deliveryId' = $1 AND idempotency_key LIKE '%attempt:2'", [delivery.id],
  );
  assert.equal(job.not_before.toISOString(), row.next_attempt_at.toISOString(), 'the follow-up job is held until then too');
  assert.equal(row.provider_receipt.retryAfterMs, 120_000);

  await attemptExpectingFailure(client, delivery.id, fetchImpl);
  row = (await client.query('SELECT * FROM delivery WHERE id = $1', [delivery.id])).rows[0];
  assert.equal(row.next_attempt_at.toISOString(), new Date(NOW.getTime() + 60_000).toISOString(), 'without Retry-After the backoff applies');

  await client.query("UPDATE delivery SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [delivery.id]);
  const done = await attemptDelivery(client, { deliveryId: delivery.id, transports: transports(fetchImpl), now: NOW });
  assert.equal(done.delivery.status, 'delivered');
  assert.equal(done.delivery.attempts, 3);

  const keys = calls.map((call) => JSON.parse(call.init.body).dedup_key);
  assert.equal(keys.length, 3);
  assert.deepEqual(new Set(keys), new Set([`keel:alert:${EVENT.alertId}:2`]), 'every retry carries the same dedup key');
  assert.equal(done.delivery.provider_receipt.dedupKey, keys[0]);
  assertNoSecret('pagerduty delivery', done.delivery);

  // A non-alert event is keyed by its delivery, so its retries also share one key.
  const { delivery: other } = await queued(client, pd.id, { kind: 'drift.detected', severity: 'warning' });
  const replay = fixtureFetch(THROTTLE, FIXTURES.pagerduty.ok);
  await attemptExpectingFailure(client, other.id, replay.fetchImpl);
  await client.query("UPDATE delivery SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [other.id]);
  await attemptDelivery(client, { deliveryId: other.id, transports: transports(replay.fetchImpl), now: NOW });
  assert.deepEqual(replay.calls.map((call) => JSON.parse(call.init.body).dedup_key), [`keel:delivery:${other.id}`, `keel:delivery:${other.id}`]);
});

test('a provider refusal fails the delivery at once, with no retry queued', async (t) => {
  const client = await schemaClient(t);
  for (const kind of Object.keys(CONFIGS)) {
    const created = await createChannel(client, { kind, config: CONFIGS[kind] });
    const { delivery } = await queued(client, created.id);
    const { fetchImpl, calls } = fixtureFetch(FIXTURES[kind].reject);
    const error = await attemptExpectingFailure(client, delivery.id, fetchImpl);
    assert.equal(error.status, 'failed', kind);
    const { rows: [row] } = await client.query('SELECT * FROM delivery WHERE id = $1', [delivery.id]);
    assert.equal(row.status, 'failed', kind);
    assert.equal(row.attempts, 1, `${kind}: a refusal is not retried`);
    assert.equal(row.provider_receipt.outcome, 'rejected', kind);
    assert.equal(calls.length, 1, kind);
    assert.equal(await notifyJobs(client, delivery.id), 1, `${kind}: no follow-up job`);
  }
});

test('no secret reaches the delivery log, the job log or the evidence ledger', async (t) => {
  const client = await schemaClient(t);
  // Providers that echo the request back, and a network error that names the address,
  // are the realistic ways a secret leaks into an error message.
  const echoes = {
    teams: [new TypeError(`fetch failed for ${SECRETS['env:KEEL_TEAMS_WEBHOOK']}`), { status: 403, body: `forbidden ${SECRETS['env:KEEL_TEAMS_WEBHOOK']}` }],
    slack: [{ status: 429, body: `slow down ${SECRETS['env:KEEL_SLACK_WEBHOOK']}` }, { status: 410, body: `channel_is_archived ${new URL(SECRETS['env:KEEL_SLACK_WEBHOOK']).pathname}` }],
    pagerduty: [{ status: 500, body: SECRETS['env:KEEL_PAGERDUTY_KEY'] }, { status: 400, body: JSON.stringify({ message: `bad key ${SECRETS['env:KEEL_PAGERDUTY_KEY']}` }) }],
    sms: [{ status: 503, body: SECRETS['env:KEEL_TWILIO_TOKEN'] }, { status: 401, body: JSON.stringify({ code: 20003, message: `Authenticate ${SECRETS['env:KEEL_TWILIO_TOKEN']}` }) }],
  };
  const deliveryIds = [];
  for (const kind of Object.keys(CONFIGS)) {
    const created = await createChannel(client, { kind, config: CONFIGS[kind] });
    const { delivery } = await queued(client, created.id);
    deliveryIds.push(delivery.id);
    const { fetchImpl } = fixtureFetch(...echoes[kind]);
    const first = await attemptExpectingFailure(client, delivery.id, fetchImpl);
    const second = await attemptExpectingFailure(client, delivery.id, fetchImpl);
    assertNoSecret(`${kind} thrown errors`, [first.message, second.message]);
  }
  // A delivered webhook keeps its receipt too; the address must not be in it.
  const teams = await createChannel(client, { kind: 'teams', config: CONFIGS.teams });
  const { delivery: delivered } = await queued(client, teams.id);
  deliveryIds.push(delivered.id);
  await attemptDelivery(client, { deliveryId: delivered.id, transports: transports(fixtureFetch(FIXTURES.teams.ok).fetchImpl), now: NOW });

  const { rows: deliveries } = await client.query('SELECT * FROM delivery WHERE id = ANY($1)', [deliveryIds]);
  assert.equal(deliveries.length, deliveryIds.length);
  assert.ok(deliveries.every((row) => row.provider_receipt), 'every attempt left a receipt');
  assert.equal(deliveries.find((row) => row.id === delivered.id).provider_receipt.endpointHost, 'prod-12.westus.logic.azure.com',
    'the receipt names the host, which is not secret');
  assertNoSecret('delivery rows', deliveries);
  const { rows: jobs } = await client.query("SELECT params, idempotency_key FROM job WHERE kind = 'notify' AND params->>'deliveryId' = ANY($1)", [deliveryIds]);
  assertNoSecret('notify jobs', jobs);
  const { rows: channels } = await client.query('SELECT config FROM channel');
  assertNoSecret('channel configs', channels.filter((row) => !row.config.url));
  const { rows: evidence } = await client.query('SELECT * FROM evidence');
  assertNoSecret('evidence', evidence);
});
