// Security audit finding 6: webhooks may only reach public addresses, checked after DNS
// and on every redirect hop. Loopback is allowed only when a test asks for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  BlockedDestinationError,
  addressProblem,
  assertDestinationAllowed,
  guardedLookup,
  guardedRequest,
  isIntegrationReference,
} from './outboundDestination.mjs';

test('addressProblem refuses loopback, private, link-local, metadata and reserved addresses', () => {
  for (const ip of [
    '127.0.0.1', '127.255.0.9', '0.0.0.0', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:a00:5', '64:ff9b::7f00:1', '::127.0.0.1',
    '[::1]', 'fe80::1%eth0',
  ]) {
    assert.match(addressProblem(ip) ?? '', /public addresses/, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(addressProblem(ip), null, ip);
  }
  assert.match(addressProblem('example.com'), /not an IP address/);
});

test('allowLoopback opens 127.0.0.0/8 and ::1 only', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(addressProblem(ip, { allowLoopback: true }), null, ip);
  for (const ip of ['10.0.0.5', '169.254.169.254', '192.168.1.1', '0.0.0.0', 'fe80::1']) {
    assert.ok(addressProblem(ip, { allowLoopback: true }), ip);
  }
});

test('assertDestinationAllowed checks the scheme and literal hosts in every spelling', () => {
  for (const url of [
    'http://127.0.0.1:2019/stop', 'http://localhost:2019/load', 'http://LOCALHOST./x', 'http://api.localhost/x',
    'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://[::1]:2019/', 'http://[::ffff:127.0.0.1]/',
    'https://169.254.169.254/latest/meta-data', 'http://10.0.0.5/x',
  ]) {
    assert.throws(() => assertDestinationAllowed(url), BlockedDestinationError, url);
  }
  assert.throws(() => assertDestinationAllowed('ftp://example.com/x'), /http or https/);
  assert.throws(() => assertDestinationAllowed('https://user:pass@example.com/x'), /user name or password/);
  assert.throws(() => assertDestinationAllowed('http://example.com/x', { protocols: ['https:'] }), /https/);
  assert.equal(assertDestinationAllowed('https://hooks.example.com/keel').hostname, 'hooks.example.com');
  assert.equal(assertDestinationAllowed('http://127.0.0.1:8080/x', { allowLoopback: true }).port, '8080');
});

function fakeResolve(table) {
  return (hostname, options, callback) => {
    const addresses = table[hostname];
    if (!addresses) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    return callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
}

test('guardedLookup refuses a name when any resolved address is not public', async () => {
  const resolve = fakeResolve({
    'public.example.test': ['93.184.216.34'],
    'rebind.example.test': ['127.0.0.1'],
    'mixed.example.test': ['93.184.216.34', '10.0.0.5'],
    'metadata.example.test': ['169.254.169.254'],
  });
  const run = (host, opts = {}) => new Promise((done) => {
    guardedLookup({ resolve, ...opts })(host, { all: true }, (error, result) => done({ error, result }));
  });
  assert.deepEqual((await run('public.example.test')).result, [{ address: '93.184.216.34', family: 4 }]);
  for (const host of ['rebind.example.test', 'mixed.example.test', 'metadata.example.test']) {
    assert.ok((await run(host)).error instanceof BlockedDestinationError, host);
  }
  assert.equal((await run('rebind.example.test', { allowLoopback: true })).error, null);
  // The single-address callback form used by older sockets.
  const single = await new Promise((done) => {
    guardedLookup({ resolve })('public.example.test', {}, (error, address, family) => done({ error, address, family }));
  });
  assert.deepEqual(single, { error: null, address: '93.184.216.34', family: 4 });
});

async function listener(t, handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { hits.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { hits, port: server.address().port };
}

test('guardedRequest never reaches a loopback listener with production settings, directly or through DNS', async (t) => {
  const target = await listener(t, (req, res) => { res.end('ok'); });
  await assert.rejects(guardedRequest(`http://127.0.0.1:${target.port}/stop`, { body: '{}' }), BlockedDestinationError);
  const resolve = fakeResolve({ 'rebind.example.test': ['127.0.0.1'] });
  await assert.rejects(guardedRequest(`http://rebind.example.test:${target.port}/stop`, { body: '{}', resolve }), BlockedDestinationError);
  assert.equal(target.hits.length, 0);
});

test('guardedRequest checks every redirect hop and keeps fetch semantics', async (t) => {
  const resolve = fakeResolve({
    'other.example.test': ['127.0.0.1'],
    'internal.example.test': ['10.0.0.5'],
  });
  const final = await listener(t, (req, res) => { res.statusCode = 200; res.end('done'); });
  const redirector = await listener(t, (req, res) => {
    const to = {
      '/to-metadata': 'http://169.254.169.254/latest/meta-data',
      '/to-internal-name': `http://internal.example.test:${final.port}/x`,
      '/to-other-origin': `http://other.example.test:${final.port}/keep`,
      '/see-other': `http://127.0.0.1:${final.port}/after-303`,
      '/loop': '/loop',
    }[req.url];
    res.statusCode = req.url === '/see-other' ? 303 : 307;
    res.setHeader('location', to);
    res.end();
  });
  const base = `http://127.0.0.1:${redirector.port}`;
  const options = { body: '{"a":1}', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' }, allowLoopback: true, resolve };

  // Loopback is open for the test, yet a redirect to the metadata address or to a name
  // that resolves to a private address is refused before any connection.
  await assert.rejects(guardedRequest(`${base}/to-metadata`, options), BlockedDestinationError);
  await assert.rejects(guardedRequest(`${base}/to-internal-name`, options), BlockedDestinationError);
  await assert.rejects(guardedRequest(`${base}/loop`, options), /redirected more than/);

  // 307 to another origin keeps method and body, drops the Authorization header.
  const kept = await guardedRequest(`${base}/to-other-origin`, options);
  assert.equal(kept.status, 200);
  assert.equal(kept.ok, true);
  assert.equal(await kept.text(), 'done');
  const keep = final.hits.find((hit) => hit.url === '/keep');
  assert.equal(keep.method, 'POST');
  assert.equal(keep.body, '{"a":1}');
  assert.equal(keep.headers.authorization, undefined);

  // 303 becomes a GET without a body.
  await guardedRequest(`${base}/see-other`, options);
  const after = final.hits.find((hit) => hit.url === '/after-303');
  assert.equal(after.method, 'GET');
  assert.equal(after.body, '');
  assert.equal(final.hits.some((hit) => hit.url === '/x'), false);
});

test('integration credential references are limited to env:KEEL_INTEGRATION_*', () => {
  assert.equal(isIntegrationReference('env:KEEL_INTEGRATION_SIEM_TOKEN'), true);
  for (const value of ['env:KEEL_DB_URL', 'env:DATABASE_URL', 'env:KEEL_INTEGRATION_', 'env:keel_integration_x', 'KEEL_INTEGRATION_X', null]) {
    assert.equal(isIntegrationReference(value), false, String(value));
  }
});
