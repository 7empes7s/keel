// Security audit finding 6: an admin's notify webhook must not reach the host's own
// loopback services (for example a proxy admin API on 127.0.0.1:2019), the metadata
// address or the private network. The audit's local repro is replayed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { ChannelConfigError } from './adapters.mjs';
import {
  DEFAULT_TRANSPORTS, DeliveryAttemptError, attemptDelivery, createChannel, createWebhookTransport, sendTestAlert,
} from './notifications.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

async function setup(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  await client.query(schemaSql());
  const { rows: [admin] } = await client.query(
    "INSERT INTO principal (email) VALUES ('webhook-guard-admin@example.invalid') RETURNING *",
  );
  await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'admin')", [admin.id]);
  return { client, admin };
}

function fakeResolve(table) {
  return (hostname, options, callback) => {
    const addresses = table[hostname];
    if (!addresses) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    return callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
}

async function listener(t, handler = (req, res) => res.end()) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { hits, port: server.address().port };
}

test('creating a webhook channel refuses private, local and metadata addresses', async (t) => {
  const { client } = await setup(t);
  for (const url of [
    'http://127.0.0.1:2019/stop', 'http://localhost:2019/load', 'http://[::1]:2019/stop',
    'https://169.254.169.254/latest', 'http://10.0.0.5/x', 'http://2130706433/', 'ftp://hooks.example.test/x', 'not a url',
  ]) {
    await assert.rejects(createChannel(client, { kind: 'webhook', config: { url } }), ChannelConfigError, url);
  }
  const { rows } = await client.query("SELECT count(*)::int AS n FROM channel WHERE kind = 'webhook'");
  assert.equal(rows[0].n, 0);
  const ok = await createChannel(client, { kind: 'webhook', config: { url: 'https://hooks.example.test/keel' } });
  assert.equal(ok.kind, 'webhook');
});

test('the production webhook transport never reaches a loopback listener, directly or by redirect', async (t) => {
  const { client, admin } = await setup(t);
  const target = await listener(t);
  const redirector = await listener(t, (req, res) => {
    res.statusCode = 307;
    res.setHeader('location', `http://127.0.0.1:${target.port}/stop-via-redirect`);
    res.end();
  });

  // A stored row that points at loopback (written behind createChannel's back, as an
  // old row would be) is refused when it is sent, and the refusal is final.
  const channel = await createChannel(client, { kind: 'webhook', config: { url: 'https://hooks.example.test/keel' } });
  await client.query('UPDATE channel SET config = $2 WHERE id = $1', [channel.id, { url: `http://127.0.0.1:${target.port}/stop` }]);
  const queued = await sendTestAlert(client, { channelId: channel.id, requestedBy: admin.id });
  const deliveryId = queued.delivery.id;
  await assert.rejects(attemptDelivery(client, { deliveryId, transports: DEFAULT_TRANSPORTS }), DeliveryAttemptError);
  const { rows: [row] } = await client.query('SELECT status, last_error FROM delivery WHERE id = $1', [deliveryId]);
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /webhook address refused: .*public addresses/);
  assert.equal(target.hits.length, 0);

  // With loopback opened for the test, the redirect is followed to the second listener.
  // The production transport refuses the same address at the first hop.
  const testOnly = createWebhookTransport({ allowLoopback: true });
  await testOnly({ channel: { config: { url: `http://127.0.0.1:${redirector.port}/go` } }, event: { kind: 'test' } });
  assert.deepEqual(target.hits, ['/stop-via-redirect']);
  await assert.rejects(
    createWebhookTransport()({ channel: { config: { url: `http://127.0.0.1:${redirector.port}/go` } }, event: { kind: 'test' } }),
    /webhook address refused/,
  );
  assert.equal(target.hits.length, 1);
});

test('the webhook transport checks names after DNS and every redirect hop itself', async (t) => {
  const target = await listener(t);
  const resolve = fakeResolve({ 'rebind.example.test': ['127.0.0.1'], 'internal.example.test': ['10.0.0.5'] });
  const redirector = await listener(t, (req, res) => {
    res.statusCode = 307;
    res.setHeader('location', `http://internal.example.test:${target.port}/x`);
    res.end();
  });
  // A name that resolves to loopback is refused by the transport, not only by the URL check.
  await assert.rejects(
    createWebhookTransport({ resolve })({ channel: { config: { url: `http://rebind.example.test:${target.port}/stop` } }, event: { kind: 'test' } }),
    /webhook address refused: .*resolves to/,
  );
  // A redirect to a name that resolves to a private address is refused at that hop.
  await assert.rejects(
    createWebhookTransport({ allowLoopback: true, resolve })({ channel: { config: { url: `http://127.0.0.1:${redirector.port}/go` } }, event: { kind: 'test' } }),
    /webhook address refused: internal\.example\.test resolves to/,
  );
  assert.equal(target.hits.length, 0);
});
