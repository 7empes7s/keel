// ops/keel-deploy/deploy.sh (#1017): healthy() must prove the database answers too, so a release
// with an unreachable database rolls back (the 2026-11-04 outage). The script's own healthy(),
// db_answers() and rollback() are run with curl, node, sleep, systemctl and the build stubbed, so
// nothing here touches a real portal, database, unit or GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = readFileSync(fileURLToPath(new URL('../ops/keel-deploy/deploy.sh', import.meta.url)), 'utf8');
const fn = (name) => {
  const body = script.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(body, `deploy.sh defines ${name}()`);
  return body[0];
};
const TARGET = 'b'.repeat(40);
const CURRENT = 'a'.repeat(40);

// One host: a live tree, a state directory and stubs that record calls. `database` is what the
// probe finds; `probe` says whether the live tree has cli/keel-db-watchdog.mjs (from #1010 on).
function host({ database, probe = true, rollbackTreeHasProbe = probe }) {
  const dir = mkdtempSync(join(tmpdir(), 'keel-deploy-'));
  const bin = join(dir, 'bin');
  const live = join(dir, 'live');
  const state = join(dir, 'state');
  for (const path of [bin, join(live, 'cli'), join(state, 'failed')]) mkdirSync(path, { recursive: true });
  const watchdog = join(live, 'cli', 'keel-db-watchdog.mjs');
  if (probe) writeFileSync(watchdog, '');
  const calls = join(dir, 'calls');
  const log = join(dir, 'deploy.log');
  const dbEnv = join(dir, 'db.env');
  writeFileSync(calls, '');
  writeFileSync(log, '');
  writeFileSync(dbEnv, 'KEEL_DB_URL=postgres://keel@127.0.0.1:5433/keel\n');
  writeFileSync(join(dir, 'database'), database);
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('curl', `echo "curl" >> "${calls}"; printf '{"status":"ok"}'`);
  stub('node', `echo "node $* in $PWD url=$KEEL_DB_URL" >> "${calls}"
[ "$(cat "${dir}/database")" = up ] && { echo 'database answers'; exit 0; }
echo 'database unreachable (ECONNREFUSED)' >&2; exit 2`);
  stub('sleep', ':');
  stub('systemctl', `echo "systemctl $*" >> "${calls}"`);
  const harness = `set -Eeuo pipefail
LIVE='${live}' LOG='${log}' DB_ENV='${dbEnv}' STATE='${state}' UNIT=keel-portal
HEALTH_URL=http://127.0.0.1:3600/api/health TARGET=${TARGET} CURRENT=${CURRENT}
log() { printf '%s\\n' "$*" >> "$LOG"; }
post_status() { echo "status $2 $3" >> '${calls}'; }
agent() { echo "agent $1" >> '${calls}'; }
build_at() { echo "build $1" >> '${calls}'; [ "$1" = "$CURRENT" ] && ${rollbackTreeHasProbe ? ':' : `rm -f '${watchdog}'`}; return 0; }
${fn('db_answers')}
${fn('healthy')}
${fn('rollback')}
healthy || rollback "health check failed"
log "deployed"`;
  const run = spawnSync('bash', ['-c', harness], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const result = {
    status: run.status,
    stderr: run.stderr,
    calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    log: readFileSync(log, 'utf8'),
    failed: existsSync(join(state, 'failed', TARGET)),
  };
  rmSync(dir, { recursive: true, force: true });
  return { ...result, live };
}

test('the deploy calls healthy() after the restart and rolls back when it fails', () => {
  assert.match(script, /^systemctl restart "\$UNIT" \|\| rollback "service restart failed"\nhealthy \|\| rollback "health check failed"$/m);
  assert.match(script, /^DB_ENV=\/etc\/keel\/db\.env /m);
});

test('portal ok and the database answers: healthy, one probe with the db.env URL, no rollback', () => {
  const box = host({ database: 'up' });
  assert.equal(box.status, 0, box.stderr);
  assert.deepEqual(box.calls, ['curl', `node cli/keel-db-watchdog.mjs probe in ${box.live} url=postgres://keel@127.0.0.1:5433/keel`]);
  assert.match(box.log, /database answers\ndeployed\n$/);
  assert.equal(box.failed, false);
});

test('portal ok but the database is unreachable: not healthy, so the deploy rolls back', () => {
  const box = host({ database: 'down', rollbackTreeHasProbe: false });
  assert.equal(box.status, 1);
  assert.equal(box.calls.filter((call) => call.startsWith('node ')).length, 20);
  assert.ok(box.calls.includes(`status failure Deploy failed (health check failed); rolled back to ${CURRENT.slice(0, 7)}`));
  assert.ok(box.calls.includes(`build ${CURRENT}`));
  assert.ok(box.calls.includes('agent rolled-back'));
  assert.match(box.log, /ROLLBACK bbbbbbb -> aaaaaaa: health check failed/);
  assert.match(box.log, /database unreachable \(ECONNREFUSED\)/);
  assert.match(box.log, /rollback ok: live is aaaaaaa/);
  assert.doesNotMatch(box.log, /deployed/);
  assert.equal(box.failed, true);
});

test('the database stays unreachable after the rollback too: reported as critical', () => {
  const box = host({ database: 'down' });
  assert.equal(box.status, 1);
  assert.ok(box.calls.includes('agent critical'));
  assert.match(box.log, /CRITICAL: rollback to aaaaaaa failed/);
  assert.doesNotMatch(box.log, /rollback ok|deployed/);
});

test('a tree from before #1010 has no probe: the database check is skipped, not failed', () => {
  const box = host({ database: 'down', probe: false });
  assert.equal(box.status, 0, box.stderr);
  assert.deepEqual(box.calls, ['curl']);
  assert.match(box.log, /^deployed\n$/);
  assert.equal(box.failed, false);
});
