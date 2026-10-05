// ops/keel-schedules-disable-timers.sh retires only the old timers the seeded kinds replace (#89):
// a collect-only install must leave keel-offsite.timer, the daily vol2 copy, running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../ops/keel-schedules-disable-timers.sh', import.meta.url));
const ALL = ['keel-backup-tier1.timer', 'keel-backup-tier2.timer', 'keel-backup-tier3.timer', 'keel-offsite.timer', 'keel-prune.timer'];

// Fake systemctl: every timer is installed; `disable --now` records the timers and flips them off.
function run(args) {
  const dir = mkdtempSync(join(tmpdir(), 'keel-timers-'));
  const state = join(dir, 'disabled');
  writeFileSync(state, '');
  writeFileSync(join(dir, 'systemctl'), `#!/usr/bin/env bash
case "$1" in
  list-unit-files) echo "$3 enabled enabled" ;;
  disable) shift 2; printf '%s\\n' "$@" >> "${state}" ;;
  is-enabled) if grep -qx "$2" "${state}"; then echo disabled; exit 1; else echo enabled; fi ;;
  is-active) if grep -qx "$2" "${state}"; then echo inactive; exit 3; else echo active; fi ;;
esac
`);
  chmodSync(join(dir, 'systemctl'), 0o755);
  execFileSync('bash', [script, ...args], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: 'pipe' });
  return readFileSync(state, 'utf8').split('\n').filter(Boolean).sort();
}

test('a collect-only install keeps keel-offsite.timer and retires the rest', () => {
  assert.deepEqual(run(['collect']), ALL.filter((t) => t !== 'keel-offsite.timer').sort());
});

test('seeding offsite retires keel-offsite.timer too', () => {
  assert.deepEqual(run(['prune,offsite']), [...ALL].sort());
});

test('no kind list retires every old timer, as before', () => {
  assert.deepEqual(run([]), [...ALL].sort());
});
