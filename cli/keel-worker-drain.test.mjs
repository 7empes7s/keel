// Issue #448: a deploy reloads keel-worker (SIGUSR2) instead of restarting it, so a long job
// such as the nightly content backup finishes instead of being killed. No database needed:
// the loop runs with injected claim/run/requeue/fail seams.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createShutdownControl, installShutdownSignals, runWorkerLoop } from './keel-worker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const quiet = { log: () => {}, logError: () => {} };

function harness({ jobs, onRun }) {
  const proc = new EventEmitter();
  const shutdown = createShutdownControl({ workerId: 'w-test', ...quiet });
  installShutdownSignals(shutdown, proc);
  const seen = { ran: [], finished: [], terminated: [], requeued: [], failed: [], claims: 0 };
  const queue = [...jobs];
  const loop = runWorkerLoop({
    shutdown,
    pollIntervalMs: 1,
    wait: () => new Promise((r) => setTimeout(r, 1)),
    claim: async () => { seen.claims += 1; return queue.shift() ?? null; },
    idle: async () => {},
    run: async (job) => {
      seen.ran.push(job.id);
      let release;
      const done = new Promise((r) => { release = r; });
      shutdown.setInFlight({ job, terminate: async () => { seen.terminated.push(job.id); release('terminated'); } });
      await onRun({ job, proc, release });
      const outcome = await done;
      shutdown.setInFlight(null);
      if (outcome === 'finished') seen.finished.push(job.id);
    },
    requeue: async (job) => { seen.requeued.push(job.id); },
    failUnrun: async (job) => { seen.failed.push(job.id); },
  });
  return { proc, shutdown, seen, loop };
}

test('SIGUSR2 lets the running job finish, then the loop ends without claiming more', async () => {
  const { seen, loop } = harness({
    jobs: [{ id: 'long' }, { id: 'next' }],
    onRun: async ({ proc, release }) => {
      proc.emit('SIGUSR2');
      setTimeout(() => release('finished'), 20);
    },
  });
  await loop;
  assert.deepEqual(seen.ran, ['long']);
  assert.deepEqual(seen.finished, ['long']);
  assert.deepEqual(seen.terminated, [], 'a drain must not terminate the running job');
  assert.equal(seen.claims, 1, 'nothing is claimed after a drain starts');
});

test('SIGTERM still terminates the running job', async () => {
  const { seen, loop } = harness({
    jobs: [{ id: 'long' }],
    onRun: async ({ proc }) => { proc.emit('SIGTERM'); },
  });
  await loop;
  assert.deepEqual(seen.terminated, ['long']);
  assert.deepEqual(seen.finished, []);
});

test('SIGTERM during a drain terminates the running job', async () => {
  const { seen, loop } = harness({
    jobs: [{ id: 'long' }],
    onRun: async ({ proc }) => {
      proc.emit('SIGUSR2');
      setTimeout(() => proc.emit('SIGTERM'), 10);
    },
  });
  await loop;
  assert.deepEqual(seen.terminated, ['long']);
});

test('a job claimed as a drain begins goes back to the queue; one claimed as a stop begins fails', async () => {
  for (const [signal, expected] of [['SIGUSR2', 'requeued'], ['SIGTERM', 'failed']]) {
    const proc = new EventEmitter();
    const shutdown = createShutdownControl({ workerId: 'w-test', ...quiet });
    installShutdownSignals(shutdown, proc);
    const seen = { requeued: [], failed: [], ran: [] };
    await runWorkerLoop({
      shutdown,
      pollIntervalMs: 1,
      claim: async () => { proc.emit(signal); return { id: 'raced' }; },
      idle: async () => {},
      run: async (job) => { seen.ran.push(job.id); },
      requeue: async (job) => { seen.requeued.push(job.id); },
      failUnrun: async (job) => { seen.failed.push(job.id); },
    });
    assert.deepEqual(seen.ran, [], `${signal}: the raced job must not run`);
    assert.deepEqual(seen[expected], ['raced'], `${signal}: the raced job must be ${expected}`);
  }
});

test('an idle worker exits promptly on SIGUSR2', async () => {
  const proc = new EventEmitter();
  const shutdown = createShutdownControl({ workerId: 'w-test', ...quiet });
  installShutdownSignals(shutdown, proc);
  let claims = 0;
  const loop = runWorkerLoop({
    shutdown,
    pollIntervalMs: 1,
    wait: () => new Promise((r) => setTimeout(r, 1)),
    claim: async () => { claims += 1; if (claims === 3) proc.emit('SIGUSR2'); return null; },
    idle: async () => {},
    run: async () => { throw new Error('no job should run'); },
    requeue: async () => {},
    failUnrun: async () => {},
  });
  await loop;
  assert.equal(claims, 3);
});

test('keel-worker.service maps reload to SIGUSR2 and still restarts after a clean exit', () => {
  const unit = readFileSync(join(__dirname, '../ops/keel-worker.service'), 'utf8');
  assert.match(unit, /^ExecReload=\/bin\/kill -USR2 \$MAINPID$/m);
  assert.match(unit, /^Restart=always$/m, 'the drained worker exits 0; systemd must start it again');
});
