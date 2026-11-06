// ops/mimule-backup.sh (#1024): the nightly backup's rotation and dump replacement, with docker,
// node and tar stubbed, so nothing here touches a real container, database or /opt/backups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../ops/mimule-backup.sh', import.meta.url));
const TODAY = '2026-11-06';

// Twelve dated sets ending on TODAY, plus things the rotation must never touch.
function backups() {
  const dir = mkdtempSync(join(tmpdir(), 'mimule-backup-'));
  for (let day = 0; day < 12; day += 1) {
    const date = new Date(Date.parse(`${TODAY}T00:00:00Z`) - day * 86400000).toISOString().slice(0, 10);
    mkdirSync(join(dir, date));
    writeFileSync(join(dir, date, 'keel-db.sql.gz'), gzipSync(`dump of ${date}\n`));
  }
  mkdirSync(join(dir, 'final-archive-2026-10-04'));
  mkdirSync(join(dir, '2026-10-01-manual'));
  writeFileSync(join(dir, '2026-10-02'), 'a file, not a dated set');
  writeFileSync(join(dir, 'keel-db-manifest.json'), '{}');
  return dir;
}

const UNTOUCHED = ['2026-10-01-manual', '2026-10-02', 'final-archive-2026-10-04', 'keel-db-manifest.json'];
const NEWEST_7 = ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', TODAY];

test('rotation keeps the newest 7 dated sets and nothing else is deleted', () => {
  const dir = backups();
  const run = spawnSync('bash', ['-c', `source "${script}"; rotate_dated_sets "$1" 7`, 'rotate', dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readdirSync(dir).sort(), [...UNTOUCHED, ...NEWEST_7].sort());
});

test('rotation deletes nothing when there are 7 or fewer dated sets', () => {
  const dir = backups();
  const run = spawnSync('bash', ['-c', `source "${script}"; rotate_dated_sets "$1" 20`, 'rotate', dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readdirSync(dir).length, 12 + UNTOUCHED.length);
});

// The whole script against a temporary backup folder; docker prints `copyBlocks` COPY lines,
// or fails mid-stream when copyBlocks is 'fail'.
function backup(dir, copyBlocks) {
  const bin = mkdtempSync(join(tmpdir(), 'mimule-backup-bin-'));
  const calls = join(bin, 'calls');
  writeFileSync(calls, '');
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('docker', copyBlocks === 'fail'
    ? 'echo "COPY public.half (id) FROM stdin;"; exit 1'
    : `for i in $(seq ${copyBlocks}); do echo "COPY public.t$i (id) FROM stdin;"; done`);
  stub('node', `echo "node $*" >> "${calls}"`);
  stub('tar', `echo "tar $1 $2" >> "${calls}"`);
  const run = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KEEL_BACKUP_DIR: dir, KEEL_BACKUP_DATE: TODAY },
  });
  return { ...run, calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean) };
}

test('a verified dump replaces the day\'s dump, publishes its manifest and rotation keeps 7', () => {
  const dir = backups();
  const run = backup(dir, 6);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const dump = join(dir, TODAY, 'keel-db.sql.gz');
  assert.match(gunzipSync(readFileSync(dump)).toString(), /^COPY public\.t6 /m);
  assert.equal(existsSync(`${dump}.partial`), false);
  assert.ok(run.calls.includes(`node /opt/keel/ops/keel-dump-manifest.mjs ${dump}`));
  assert.deepEqual(readdirSync(dir).sort(), [...UNTOUCHED, ...NEWEST_7].sort());
});

for (const [why, copyBlocks] of [['pg_dump fails mid-stream', 'fail'], ['the dump is incomplete', 2]]) {
  test(`when ${why}, the day's good dump is kept, no manifest is published and the unit fails`, () => {
    const dir = backups();
    const run = backup(dir, copyBlocks);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /BACKUP DEGRADED/);
    const dump = join(dir, TODAY, 'keel-db.sql.gz');
    assert.equal(gunzipSync(readFileSync(dump)).toString(), `dump of ${TODAY}\n`);
    assert.equal(existsSync(`${dump}.partial`), false);
    assert.equal(run.calls.some((call) => call.startsWith('node ')), false);
  });
}
