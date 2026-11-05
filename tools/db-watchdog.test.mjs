// ops/keel-db-watchdog.sh (#1010): the database watchdog's decisions, with docker, systemctl
// and the node probe stubbed, so nothing here touches a real container, unit or database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../ops/keel-db-watchdog.sh', import.meta.url));
// Fixed clock: 2026-11-04 22:47 UTC, two minutes after the live port forward died.
const NOW = Date.parse('2026-11-04T22:47:00Z') / 1000;

function decide(...args) {
  const run = spawnSync('bash', ['-c', `source "${script}"; decide "$@"`, 'decide', ...args.map(String)], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

test('decide: healthy, one failure, two failures, stopped, missing, and the hourly limit', () => {
  assert.equal(decide('ok', 0, 'running', 0, 'no'), 'none');
  assert.equal(decide('ok', 5, 'running', 3, 'yes'), 'none');
  assert.equal(decide('fail', 1, 'running', 0, 'no'), 'wait');
  assert.equal(decide('fail', 2, 'running', 0, 'no'), 'restart');
  assert.equal(decide('fail', 2, 'exited', 0, 'no'), 'start');
  assert.equal(decide('fail', 2, 'restarting', 0, 'no'), 'wait');
  assert.equal(decide('fail', 2, 'missing', 0, 'no'), 'give-up');
  assert.equal(decide('fail', 2, 'running', 2, 'no'), 'restart');
  assert.equal(decide('fail', 2, 'running', 3, 'no'), 'give-up');
  assert.equal(decide('fail', 9, 'running', 0, 'yes'), 'none');
});

// One host: a state directory, a daily-log directory and stub commands that record calls.
function host() {
  const dir = mkdtempSync(join(tmpdir(), 'keel-db-watchdog-'));
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  const vault = join(dir, 'vault');
  for (const path of [bin, state, vault]) mkdirSync(path);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('docker', `echo "docker $*" >> "${calls}"
if [ "$1" = inspect ]; then [ "$(cat "${dir}/container")" = missing ] && exit 1; cat "${dir}/container"; fi`);
  stub('systemctl', `echo "systemctl $*" >> "${calls}"`);
  // $1 is cli/keel-db-watchdog.mjs; the probe answers from a file, alerts are recorded.
  stub('node', `case "$2" in
  probe) [ "$(cat "${dir}/database")" = up ] && { echo 'database answers'; exit 0; }; echo 'database unreachable (ECONNREFUSED)' >&2; exit 2 ;;
  alert) shift 2; echo "alert $*" >> "${calls}"; echo 'alert queued to 1 channel' ;;
esac`);
  const run = ({ database, container = 'running', at = NOW }) => {
    writeFileSync(join(dir, 'database'), database);
    writeFileSync(join(dir, 'container'), container);
    writeFileSync(calls, '');
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KEEL_DB_WATCHDOG_STATE: state, KEEL_VAULT_DIR: vault, KEEL_LIVE: '/opt/keel-live', KEEL_WATCHDOG_NOW: String(at) },
    });
    const lines = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
    return { status: result.status, stdout: result.stdout, actions: lines.filter((line) => !line.startsWith('docker inspect')), lines };
  };
  const alerts = () => (existsSync(join(state, 'alerts')) ? readdirSync(join(state, 'alerts')) : []);
  return { run, alerts, vault, state };
}

const RESTART = ['docker restart -t 30 keel-postgres', 'systemctl restart keel-portal'];

test('healthy does nothing; one failure does nothing; the second restarts the container, then the portal', () => {
  const box = host();
  assert.deepEqual(box.run({ database: 'up' }), { status: 0, stdout: '', actions: [], lines: [] });
  const first = box.run({ database: 'down' });
  assert.equal(first.status, 1);
  assert.deepEqual(first.actions, []);
  assert.match(first.stdout, /1 in a row, keel-postgres running\): database unreachable \(ECONNREFUSED\)/);
  const second = box.run({ database: 'down', at: NOW + 60 });
  assert.deepEqual(second.actions, RESTART);
  assert.deepEqual(box.alerts(), [`${NOW + 60}-restarted`]);
  const log = readFileSync(join(box.vault, '2026-11-04.md'), 'utf8');
  assert.match(log, /^- 2026-11-04 22:48 UTC keel-db-watchdog: database unreachable on 2 checks in a row with keel-postgres running: restarting keel-postgres, then keel-portal$/m);
});

test('the alert goes out once the database answers again, and only once', () => {
  const box = host();
  box.run({ database: 'down' });
  box.run({ database: 'down', at: NOW + 60 });
  const healed = box.run({ database: 'up', at: NOW + 120 });
  assert.equal(healed.status, 0);
  assert.deepEqual(healed.actions, ['alert --action restarted --at 2026-11-04T22:48:00Z --detail Restarted keel-postgres and keel-portal.']);
  assert.match(healed.stdout, /database answers again \(first failed check 2026-11-04 22:47 UTC\)/);
  assert.deepEqual(box.alerts(), []);
  assert.deepEqual(box.run({ database: 'up', at: NOW + 180 }).actions, []);
});

test('a stopped container is started, then the portal restarted', () => {
  const box = host();
  box.run({ database: 'down', container: 'exited' });
  const second = box.run({ database: 'down', container: 'exited', at: NOW + 60 });
  assert.deepEqual(second.actions, ['docker start keel-postgres', 'systemctl restart keel-portal']);
  assert.deepEqual(box.alerts(), [`${NOW + 60}-started`]);
});

test('the 4th restart in an hour gives up and alerts, then stays quiet until the database answers', () => {
  const box = host();
  let at = NOW;
  const restarts = [];
  // Each action resets the count, so every restart needs two failed checks first.
  for (let round = 0; round < 3; round += 1) {
    assert.deepEqual(box.run({ database: 'down', at }).actions, []);
    at += 60;
    restarts.push(box.run({ database: 'down', at }).actions);
    at += 60;
  }
  assert.deepEqual(restarts, [RESTART, RESTART, RESTART]);
  box.run({ database: 'down', at });
  const fourth = box.run({ database: 'down', at: at + 60 });
  assert.deepEqual(fourth.actions, []);
  assert.match(fourth.stdout, /GAVE UP: database still unreachable \(keel-postgres running, 3 restarts in the last hour\)/);
  assert.equal(box.alerts().filter((name) => name.endsWith('-gave-up')).length, 1);
  assert.deepEqual(box.run({ database: 'down', at: at + 120 }).actions, [], 'no more restarts once given up');
  const healed = box.run({ database: 'up', at: at + 180 });
  assert.equal(healed.actions.filter((line) => line.startsWith('alert --action gave-up')).length, 1);
  assert.equal(healed.actions.filter((line) => line.startsWith('alert --action restarted')).length, 3);
  assert.equal(existsSync(join(box.state, 'gave-up')), false);
});

test('restarts older than an hour no longer count toward the limit', () => {
  const box = host();
  writeFileSync(join(box.state, 'restarts'), `${NOW - 3700}\n${NOW - 3650}\n${NOW - 3601}\n`, { flag: 'w' });
  box.run({ database: 'down' });
  assert.deepEqual(box.run({ database: 'down', at: NOW + 60 }).actions, RESTART);
});

test('no container at all gives up at once: there is nothing to start', () => {
  const box = host();
  box.run({ database: 'down', container: 'missing' });
  const second = box.run({ database: 'down', container: 'missing', at: NOW + 60 });
  assert.deepEqual(second.actions, []);
  assert.deepEqual(box.alerts(), [`${NOW + 60}-gave-up`]);
});
