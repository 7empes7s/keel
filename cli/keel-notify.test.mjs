import { strict as assert } from 'node:assert';
import { runCli } from './keel-notify.mjs';

// keel-worker detects a failed notify job by this process's exit code, so runCli's
// 0/1 contract is the seam the delivery-log failure model depends on: a failed
// transport must surface as a failed job, not a completed one. These tests drive
// runCli with injected fakes only — no database, no live tenant, no transport.

// Success: a delivered attempt exits 0.
{
  const logs = [];
  const exitCode = await runCli({
    argv: ['node', 'keel-notify.mjs', '--delivery-id', 'delivery-1', '--db-url', 'postgres://fake'],
    logger: { log: (line) => logs.push(line), error: () => {} },
    dependencies: {
      connect: async () => ({ end: async () => {} }),
      attemptDelivery: async () => ({ delivery: { id: 'delivery-1', status: 'delivered' }, attempted: true }),
    },
  });
  assert.equal(exitCode, 0, 'a successful delivery attempt exits 0');
  assert.ok(logs.some((line) => line.includes('delivered')));
}

// Failure: a rejected attempt (e.g. DeliveryAttemptError from a failed transport)
// must exit 1. Returning 0 here is the surviving task-20 mutation this test exists
// to kill — keel-worker would record the failed delivery's job as completed and the
// retry/backoff visibility would be silently abandoned.
{
  const errors = [];
  const exitCode = await runCli({
    argv: ['node', 'keel-notify.mjs', '--delivery-id', 'delivery-2', '--db-url', 'postgres://fake'],
    logger: { log: () => {}, error: (error) => errors.push(error) },
    dependencies: {
      connect: async () => ({ end: async () => {} }),
      attemptDelivery: async () => { throw new Error('fixture transport failure'); },
    },
  });
  assert.equal(exitCode, 1, 'a failed delivery attempt must exit non-zero so the worker fails the job');
  assert.equal(errors.length, 1, 'the failure is reported on the error logger');
}

// Usage failure: a missing --delivery-id exits 1, not 0.
{
  const exitCode = await runCli({
    argv: ['node', 'keel-notify.mjs'],
    logger: { log: () => {}, error: () => {} },
  });
  assert.equal(exitCode, 1, 'a missing --delivery-id is a failure, not a success');
}

// The database client is released even when the attempt throws.
{
  let closed = false;
  await runCli({
    argv: ['node', 'keel-notify.mjs', '--delivery-id', 'delivery-3', '--db-url', 'postgres://fake'],
    logger: { log: () => {}, error: () => {} },
    dependencies: {
      connect: async () => ({ end: async () => { closed = true; } }),
      attemptDelivery: async () => { throw new Error('fixture transport failure'); },
    },
  });
  assert.equal(closed, true, 'the database client is released on failure');
}

console.log('keel-notify.test.mjs — all assertions passed');
