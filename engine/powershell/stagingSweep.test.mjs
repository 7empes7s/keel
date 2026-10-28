// The startup sweep of staged credential copies left behind by killed workers.
// Offline: no Docker, a private temporary staging root per test.

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LEGACY_STAGING_MAX_AGE_MS, runJob, stageJobCredentials, sweepStaleStaging } from './jobQueue.mjs';

function staged(root, name, files = { 'tenant.json': '{}', 'key.pem': 'KEY' }) {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body, { mode: 0o400 });
  return dir;
}

// A pid that is certainly not running: a child that has already exited.
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(String(child.stdout));
}

function withRoot(fn) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'keel-sweep-'));
    try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
}

test('removes copies of dead workers and of an earlier worker with this pid, keeps live ones', withRoot(async (root) => {
  const dead = deadPid();
  staged(root, `keel-ps-${dead}-aB3dE9`);
  staged(root, `keel-ps-${process.pid}-Zz0000`);
  staged(root, `keel-ps-${process.ppid}-live01`);
  const removed = await sweepStaleStaging(root);
  assert.deepEqual(removed.sort(), [`keel-ps-${dead}-aB3dE9`, `keel-ps-${process.pid}-Zz0000`].sort());
  assert.deepEqual(readdirSync(root), [`keel-ps-${process.ppid}-live01`], 'a running worker keeps its copy');
}));

test('a pid owned by another user counts as alive', withRoot(async (root) => {
  staged(root, 'keel-ps-4242-abcdef');
  const removed = await sweepStaleStaging(root, { selfPid: 1, isAlive: () => true });
  assert.deepEqual(removed, []);
  assert.ok(existsSync(join(root, 'keel-ps-4242-abcdef')));
}));

test('older copies without a pid are removed only once past the age limit', withRoot(async (root) => {
  const now = Date.now();
  staged(root, 'keel-ps-Old123');
  staged(root, 'keel-ps-New456');
  const old = (now - LEGACY_STAGING_MAX_AGE_MS - 60_000) / 1000;
  utimesSync(join(root, 'keel-ps-Old123'), old, old);
  const removed = await sweepStaleStaging(root, { now, isAlive: () => false });
  assert.deepEqual(removed, ['keel-ps-Old123']);
  assert.deepEqual(readdirSync(root), ['keel-ps-New456']);
}));

test('leaves everything that is not a staged copy alone', withRoot(async (root) => {
  const dead = deadPid();
  const outside = mkdtempSync(join(tmpdir(), 'keel-sweep-target-'));
  try {
    writeFileSync(join(outside, 'keep.txt'), 'x');
    symlinkSync(outside, join(root, `keel-ps-${dead}-link00`));
    writeFileSync(join(root, `keel-ps-${dead}-file00`), 'x');
    staged(root, 'keel-other-abcdef');
    staged(root, `keel-ps-${dead}-tooLongSuffix`);
    staged(root, 'docker.sock.d');
    const removed = await sweepStaleStaging(root, { now: Date.now() + 10 * LEGACY_STAGING_MAX_AGE_MS });
    assert.deepEqual(removed, []);
    assert.equal(readdirSync(root).length, 5);
    assert.ok(existsSync(join(outside, 'keep.txt')), 'a link is never followed');
  } finally { rmSync(outside, { recursive: true, force: true }); }
}));

test('a missing staging root sweeps nothing', async () => {
  assert.deepEqual(await sweepStaleStaging(join(tmpdir(), 'keel-sweep-does-not-exist', 'x')), []);
});

test('the first staged job sweeps once, and new copies carry this pid', withRoot(async (root) => {
  const creds = mkdtempSync(join(tmpdir(), 'keel-sweep-cred-'));
  try {
    writeFileSync(join(creds, 'tenant.json'), JSON.stringify({ clientId: 'c' }));
    const dead = deadPid();
    staged(root, `keel-ps-${dead}-left01`);

    let mounted;
    const spawnFn = (bin, args) => {
      mounted = args[args.indexOf('-v') + 1].split(':')[0];
      assert.ok(!existsSync(join(root, `keel-ps-${dead}-left01`)), 'the leftover is gone before the container starts');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write() {}, end() {} };
      child.kill = () => {};
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from('[]')); child.emit('close', 0); });
      return child;
    };
    await runJob({ mode: 'probe', tenantConfigPath: join(creds, 'tenant.json') }, { spawnFn, credentialRoot: creds, stagingRoot: root });
    assert.match(mounted, new RegExp(`/keel-ps-${process.pid}-[A-Za-z0-9]{6}$`));
    assert.deepEqual(readdirSync(root), [], 'the job removed its own copy');

    // The sweep runs once per process and root: a later job does not touch a leftover, nor its own live copy.
    staged(root, `keel-ps-${dead}-left02`);
    const second = await stageJobCredentials(join(creds, 'tenant.json'), { credentialRoot: creds, stagingRoot: root });
    assert.ok(existsSync(second.dir));
    assert.ok(existsSync(join(root, `keel-ps-${dead}-left02`)));
    // Another spelling of the same root does not sweep again and take the live copy.
    const third = await stageJobCredentials(join(creds, 'tenant.json'), { credentialRoot: creds, stagingRoot: `${root}/` });
    assert.ok(existsSync(second.dir), 'a live copy survives a job staged under another spelling of the root');
    rmSync(third.dir, { recursive: true, force: true });
    rmSync(second.dir, { recursive: true, force: true });
  } finally { rmSync(creds, { recursive: true, force: true }); }
}));
