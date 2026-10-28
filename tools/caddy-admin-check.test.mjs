// ops/caddy-admin-check.mjs fails while Caddy's admin API can answer on a TCP port (Q195):
// no global admin option, a TCP admin address, a socket other users can reach, or a live listener.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminFromCaddyfile, adminFromJson, check } from '../ops/caddy-admin-check.mjs';

const script = fileURLToPath(new URL('../ops/caddy-admin-check.mjs', import.meta.url));
const NO_CADDY = '/nonexistent/caddy';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'keel-caddy-'));
}

function caddyfile(dir, text) {
  const path = join(dir, 'Caddyfile');
  writeFileSync(path, text);
  return path;
}

// A port nothing listens on: bind an ephemeral port on loopback, then close it.
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const SITE = 'keel.example.test {\n\treverse_proxy 127.0.0.1:3600\n}\n';

test('reads the global admin option from Caddyfile text', () => {
  assert.deepEqual(adminFromCaddyfile(SITE), { mode: 'default' });
  assert.deepEqual(adminFromCaddyfile(`{\n\temail ops@example.test\n}\n${SITE}`), { mode: 'default' });
  assert.deepEqual(adminFromCaddyfile(`# header\n{\n\tadmin off # no API\n}\n${SITE}`), { mode: 'off' });
  assert.deepEqual(adminFromCaddyfile(`{\n\tadmin unix//run/caddy/admin.sock|0600\n}\n${SITE}`), { mode: 'unix', path: '/run/caddy/admin.sock' });
  assert.deepEqual(adminFromCaddyfile(`{\n\tadmin localhost:2020 {\n\t\torigins localhost\n\t}\n}\n${SITE}`), { mode: 'tcp', address: 'localhost:2020' });
  // Caddy keeps the last admin line: a later TCP address overrides an earlier socket.
  assert.deepEqual(adminFromCaddyfile(`{\n\tadmin unix//run/caddy/admin.sock\n\tadmin 0.0.0.0:2020\n}\n${SITE}`), { mode: 'tcp', address: '0.0.0.0:2020' });
  assert.deepEqual(adminFromCaddyfile(`{\n\tadmin {\n\t\torigins localhost\n\t}\n}\n${SITE}`), { mode: 'default' });
  // An `admin` word inside a site block is not the global option.
  assert.deepEqual(adminFromCaddyfile(`{\n\tservers {\n\t\tadmin off\n\t}\n}\n${SITE}`), { mode: 'default' });
});

test('reads the admin object from adapted JSON', () => {
  assert.deepEqual(adminFromJson({ apps: {} }), { mode: 'default' });
  assert.deepEqual(adminFromJson({ admin: { disabled: true } }), { mode: 'off' });
  assert.deepEqual(adminFromJson({ admin: { listen: 'unix//run/caddy/admin.sock' } }), { mode: 'unix', path: '/run/caddy/admin.sock' });
  assert.deepEqual(adminFromJson({ admin: { listen: 'localhost:2019' } }), { mode: 'tcp', address: 'localhost:2019' });
});

test('fails the default config, as found on the host in Q195', async () => {
  const port = await freePort();
  const results = await check({ config: caddyfile(tmp(), SITE), port, caddy: NO_CADDY });
  assert.equal(results[0].ok, false);
  assert.match(results[0].message, /no global admin option/);
});

test('fails while something listens on the admin port, even with admin off', async () => {
  const server = createServer((s) => s.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const results = await check({ config: caddyfile(tmp(), `{\n\tadmin off\n}\n${SITE}`), port: server.address().port, caddy: NO_CADDY });
    assert.equal(results[0].ok, true);
    assert.ok(results.some((r) => !r.ok && /accepts connections on 127\.0\.0\.1/.test(r.message)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('passes admin off with nothing listening', async () => {
  const results = await check({ config: caddyfile(tmp(), `{\n\tadmin off\n}\n${SITE}`), port: await freePort(), caddy: NO_CADDY });
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
});

test('passes a unix socket in a private directory, fails one other users can reach', async () => {
  const dir = tmp();
  const sockDir = join(dir, 'run-caddy');
  mkdirSync(sockDir);
  const config = caddyfile(dir, `{\n\tadmin unix/${sockDir}/admin.sock\n}\n${SITE}`);
  const port = await freePort();

  chmodSync(sockDir, 0o700);
  let results = await check({ config, port, caddy: NO_CADDY });
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));

  chmodSync(sockDir, 0o755);
  results = await check({ config, port, caddy: NO_CADDY });
  assert.ok(results.some((r) => !r.ok && /expected 0700/.test(r.message)));
});

test('prefers caddy adapt over the Caddyfile text when the binary is there', async () => {
  const dir = tmp();
  const fake = join(dir, 'caddy');
  // The text has no admin option; the adapted JSON (e.g. from an import) disables it.
  writeFileSync(fake, '#!/usr/bin/env bash\necho \'{"admin":{"disabled":true}}\'\n');
  chmodSync(fake, 0o755);
  const results = await check({ config: caddyfile(dir, SITE), port: await freePort(), caddy: fake });
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.match(results[0].message, /caddy adapt/);
});

test('CLI exits 1 on the default config and 0 once admin is off', async () => {
  const dir = tmp();
  const port = String(await freePort());
  const bad = spawnSync(process.execPath, [script, '--config', caddyfile(dir, SITE), '--port', port, '--caddy', NO_CADDY]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr.toString(), /FAIL: .*no global admin option/);
  const out = execFileSync(process.execPath, [script, '--config', caddyfile(dir, `{\n\tadmin off\n}\n${SITE}`), '--port', port, '--caddy', NO_CADDY]);
  assert.match(out.toString(), /PASS: .*admin off/);
  assert.equal(spawnSync(process.execPath, [script, '--bogus']).status, 2);
});
