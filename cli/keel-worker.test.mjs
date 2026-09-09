import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isProcessGroupAlive, runJob, signalProcessGroup, startJobChild,
} from './keel-worker.mjs';

const fixtureDir = mkdtempSync(join(tmpdir(), 'keel-worker-test-'));
const grandchildPidPath = join(fixtureDir, 'grandchild.pid');
const fixturePath = join(fixtureDir, 'spawns-grandchild.mjs');

writeFileSync(fixturePath, `
  import { spawn } from 'node:child_process';
  import { writeFileSync } from 'node:fs';
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  writeFileSync(process.argv[2], String(grandchild.pid));
  setInterval(() => {}, 1000);
`);

const execution = startJobChild(fixturePath, [grandchildPidPath], { timeoutMs: 100 });
const processGroupId = execution.child.pid;

try {
  await assert.rejects(execution.completed, /execution timed out after 100ms/);
  assert.equal(
    isProcessGroupAlive(processGroupId),
    false,
    'the timed-out child process group, including its grandchild, must be gone',
  );

  const grandchildPid = Number(readFileSync(grandchildPidPath, 'utf8'));
  assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' });
} finally {
  if (isProcessGroupAlive(processGroupId)) signalProcessGroup(processGroupId, 'SIGKILL');
}

// --- an unknown kind fails the job rather than completing it ---
// Drives runJob with a fake client; no database needed. The dispatch table's default
// branch must call fail(), never complete().
const failedCalls = [];
const completedCalls = [];
const fakeClient = {
  async query(sql, params) {
    if (sql.includes("SET status = 'succeeded'")) {
      completedCalls.push(params);
      return { rows: [{ id: params[0], status: 'succeeded' }] };
    }
    if (sql.includes("SET status = 'failed'")) {
      failedCalls.push(params);
      return { rows: [{ id: params[0], status: 'failed', error: params[1] }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
};
await runJob(fakeClient, { id: 'job-unknown-kind', kind: 'bogus', params: {} }, {
  dbUrl: 'postgres://unused',
  onInFlightChange: () => {},
});
assert.equal(completedCalls.length, 0, 'an unknown kind must never complete the job');
assert.equal(failedCalls.length, 1, 'an unknown kind must fail the job');
assert.match(failedCalls[0][1], /no worker handler registered for kind: bogus/);

console.log('keel-worker.test.mjs — all assertions passed');
