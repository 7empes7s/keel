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
  const logs = [];
  const exitCode = await runCli({
    argv: ['node', 'keel-notify.mjs'],
    logger: { log: (line) => logs.push(line), error: () => {} },
  });
  assert.equal(exitCode, 1, 'a missing --delivery-id is a failure, not a success');
  assert.ok(logs.some((line) => line.startsWith('usage:')), 'a missing mode prints usage');
}

// Listing is an operator read path: it prints the durable fields operators need,
// never calls attemptDelivery, and leaves every listed delivery unchanged.
{
  const logs = [];
  let attemptCalls = 0;
  let clientEnds = 0;
  const deliveries = [
    {
      id: 'delivery-delivered', channel_id: 'channel-1', status: 'delivered',
      attempts: 1, max_attempts: 5, next_attempt_at: '2026-09-08T00:00:00.000Z', last_error: null,
    },
    {
      id: 'delivery-retrying', channel_id: 'channel-1', status: 'retrying',
      attempts: 2, max_attempts: 5, next_attempt_at: '2026-09-08T00:01:00.000Z', last_error: 'fixture retry error',
    },
    {
      id: 'delivery-failed', channel_id: 'channel-2', status: 'failed',
      attempts: 5, max_attempts: 5, next_attempt_at: '2026-09-08T00:02:00.000Z', last_error: 'fixture terminal error',
    },
  ];
  const beforeListing = structuredClone(deliveries);
  const exitCode = await runCli({
    argv: [
      'node', 'keel-notify.mjs', '--list', '--channel-id', 'channel-1', '--status', 'failed',
      '--limit', '25', '--db-url', 'postgres://fake',
    ],
    logger: { log: (line) => logs.push(line), error: () => {} },
    dependencies: {
      connect: async () => ({ end: async () => { clientEnds += 1; } }),
      listDeliveries: async (client, options) => {
        assert.deepEqual(options, { channelId: 'channel-1', status: 'failed', limit: 25 });
        return deliveries;
      },
      attemptDelivery: async () => {
        attemptCalls += 1;
        for (const delivery of deliveries) {
          delivery.status = 'delivered';
          delivery.attempts += 1;
        }
      },
    },
  });
  assert.equal(exitCode, 0, 'listing delivery history exits 0');
  assert.deepEqual(deliveries, beforeListing, 'listing never mutates delivery status or attempts');
  assert.equal(attemptCalls, 0, 'listing never attempts a delivery or calls a transport');
  assert.equal(clientEnds, 1, 'the database client is released after listing');
  const output = logs.join('\n');
  for (const delivery of deliveries) {
    assert.match(output, new RegExp(`id=${delivery.id}`));
    assert.match(output, new RegExp(`channel=${delivery.channel_id}`));
    assert.match(output, new RegExp(`status=${delivery.status}`));
    assert.match(output, new RegExp(`attempts=${delivery.attempts}/${delivery.max_attempts}`));
    assert.match(output, new RegExp(`next_attempt_at=${delivery.next_attempt_at}`));
    assert.match(output, new RegExp(`last_error=${delivery.last_error ?? 'null'}`));
  }
}

// The two notification modes are mutually exclusive.
{
  const exitCode = await runCli({
    argv: ['node', 'keel-notify.mjs', '--list', '--delivery-id', 'delivery-4'],
    logger: { log: () => {}, error: () => {} },
  });
  assert.equal(exitCode, 1, '--list and --delivery-id cannot be used together');
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
