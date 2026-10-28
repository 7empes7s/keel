// A missing or broken settings file stops keel-restore before any connection, in plain
// words that name the file, what is wrong and what to do. Never a raw ENOENT or JSON error.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { main, runCli } from './keel-restore.mjs';

const dir = mkdtempSync(join(tmpdir(), 'keel-restore-config-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const TENANT_ID = '0a1b2c3d-0000-4000-8000-000000000001';
const collector = join(dir, 'tenant.json');
const restorer = join(dir, 'restorer.json');
const missing = join(dir, 'gone.json');
const broken = join(dir, 'broken.json');
writeFileSync(collector, JSON.stringify({ tenantId: TENANT_ID, clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' }));
writeFileSync(restorer, JSON.stringify({ tenantId: TENANT_ID, clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' }));
writeFileSync(broken, '{"tenantId": "x", "clientSecret": "do-not-print-me",');

// Nothing here may reach the database or the tenant.
const dependencies = { connect: () => { throw new Error('connected'); } };
const run = (...args) => main({ argv: ['node', 'keel-restore.mjs', ...args], dbUrl: 'postgres://unused', dependencies, logger: { log() {}, error() {} } });
const RAW = /ENOENT|SyntaxError|Unexpected token|at position|do-not-print-me/;
const plain = (what, path, problem) => ({
  name: 'ConfigFileError',
  message: `Keel can't read the ${what} file (${path}): ${problem}. Fix the file on the Keel server, then try again.`,
});

test('a selection dry run names the missing restorer file and the broken collector file', async () => {
  await assert.rejects(run('--snapshot-id', 's', '--select', 'group:A', '--target-config', missing, '--collector-config', collector),
    plain('restorer settings', missing, 'the file is missing'));
  await assert.rejects(run('--snapshot-id', 's', '--select', 'group:A', '--target-config', restorer, '--collector-config', broken),
    plain('collector settings', broken, 'it is not valid JSON'));
});

test('a workload dry run and a compliance fix name the collector file the same way', async () => {
  await assert.rejects(run('--workload', 'exchange-mail-flow', '--collector-config', missing),
    plain('collector settings', missing, 'the file is missing'));
  await assert.rejects(run('--compliance-fix', 'c1', '--object', 'o1', '--collector-config', collector, '--target-config', broken),
    plain('restorer settings', broken, 'it is not valid JSON'));
});

test('the job output starts with the plain sentence and never quotes the file', async () => {
  const errors = [];
  const code = await runCli({
    argv: ['node', 'keel-restore.mjs', '--snapshot-id', 's', '--select', 'group:A', '--target-config', broken, '--collector-config', collector],
    dbUrl: 'postgres://unused', dependencies, logger: { log() {}, error: (error) => errors.push(error) },
  });
  assert.equal(code, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /^Keel can't read the restorer settings file \(/);
  assert.doesNotMatch(String(errors[0].stack), RAW);
  assert.equal(errors[0].cause, undefined);
});
