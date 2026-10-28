// Security audit run 2, finding 11: the safety sweeps (SIEM outbox, alert escalation,
// break-glass canary) keep running while the worker is busy with a long job. No database:
// the job loop and the sweeps run with injected seams.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createShutdownControl, runWorkerLoop, startSafetySweeps } from './keel-worker.mjs';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('sweeps keep running while a long job holds the worker', async () => {
  const shutdown = createShutdownControl({ workerId: 'w', log: () => {}, logError: () => {} });
  let sweeps = 0;
  const lane = startSafetySweeps({ intervalMs: 5, sweep: async () => { sweeps += 1; } });
  const queue = [{ id: 'long-restore' }];
  let sweepsDuringJob = 0;
  await runWorkerLoop({
    shutdown,
    pollIntervalMs: 1,
    wait: () => tick(1),
    claim: async () => queue.shift() ?? null,
    run: async () => {
      const before = sweeps;
      await tick(80);
      sweepsDuringJob = sweeps - before;
      shutdown.stop('test');
    },
    requeue: async () => {},
    failUnrun: async () => {},
  });
  await lane.stop();
  assert.ok(sweepsDuringJob >= 3, `expected sweeps during the job, saw ${sweepsDuringJob}`);
});

test('a failing sweep is logged and the next tick still runs', async () => {
  const errors = [];
  let calls = 0;
  const lane = startSafetySweeps({
    intervalMs: 2,
    logError: (line) => errors.push(line),
    sweep: async () => { calls += 1; if (calls === 1) throw new Error('database gone'); },
  });
  await tick(30);
  await lane.stop();
  assert.ok(calls >= 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /safety sweep failed/);
});

test('sweeps never overlap, and stop waits for the one in flight', async () => {
  let running = 0;
  let maxRunning = 0;
  let finished = 0;
  const lane = startSafetySweeps({
    intervalMs: 1,
    sweep: async () => {
      running += 1; maxRunning = Math.max(maxRunning, running);
      await tick(15);
      running -= 1; finished += 1;
    },
  });
  await tick(5);
  await lane.stop();
  assert.equal(running, 0, 'stop returned only after the running sweep finished');
  assert.equal(maxRunning, 1);
  const after = finished;
  await tick(20);
  assert.equal(finished, after, 'nothing runs after stop');
});

test('the worker runs the sweeps on their own lane and connection, not in the idle hook', () => {
  const source = readFileSync(new URL('./keel-worker.mjs', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  assert.match(main, /const sweepClient = await connect\(dbUrl\);/);
  assert.match(main, /startSafetySweeps\(\{[\s\S]*runSafetySweeps\(sweepClient/);
  assert.doesNotMatch(main, /idle:/, 'sweeps must not wait for an empty queue');
  assert.match(main, /await sweeps\.stop\(\);/);
});
