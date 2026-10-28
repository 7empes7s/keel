// Security audit run 2, finding 11: approval-minted jobs are claimed first, and a capped
// enqueue refuses a person who already has too many jobs waiting.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  APPROVED_JOB_PRIORITY, claimNext, enqueue, QueueFullError,
} from './queue.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
await client.query(schemaSql());

test.after(async () => {
  await client.end();
  await database.cleanup();
});

test('an approved job is claimed before older ordinary jobs; ties stay first-in first-out', async () => {
  await client.query('DELETE FROM job');
  const older = await enqueue(client, { kind: 'collect', params: {}, requestedBy: 'flooder' });
  const old2 = await enqueue(client, { kind: 'collect', params: {}, requestedBy: 'flooder' });
  const approved = await enqueue(client, {
    kind: 'restore', params: {}, requestedBy: 'requester', idempotencyKey: 'approval:fairness-1',
    priority: APPROVED_JOB_PRIORITY,
  });
  assert.equal(approved.priority, APPROVED_JOB_PRIORITY);
  assert.equal(older.priority, 0, 'jobs are ordinary unless the caller says otherwise');

  assert.equal((await claimNext(client, { workerId: 'w', eventSink: () => {} })).id, approved.id);
  assert.equal((await claimNext(client, { workerId: 'w', eventSink: () => {} })).id, older.id);
  assert.equal((await claimNext(client, { workerId: 'w', eventSink: () => {} })).id, old2.id);
});

test('a capped enqueue refuses the next job once the person has the cap waiting', async () => {
  await client.query('DELETE FROM job');
  const cap = 3;
  for (let index = 0; index < cap; index++) {
    await enqueue(client, { kind: 'collect', params: {}, requestedBy: 'busy', idempotencyKey: `k${index}`, maxQueuedForRequester: cap });
  }
  await assert.rejects(
    () => enqueue(client, { kind: 'collect', params: {}, requestedBy: 'busy', maxQueuedForRequester: cap }),
    (error) => error instanceof QueueFullError && error.limit === cap,
  );
  const replay = await enqueue(client, { kind: 'collect', params: {}, requestedBy: 'busy', idempotencyKey: 'k1', maxQueuedForRequester: cap });
  assert.equal(replay.idempotency_key, 'k1', 'a replay at the cap returns the job it already made');

  // Only waiting jobs count: once one starts, there is room again.
  await claimNext(client, { workerId: 'w', eventSink: () => {} });
  await enqueue(client, { kind: 'collect', params: {}, requestedBy: 'busy', maxQueuedForRequester: cap });

  // Uncapped callers (the scheduler, approvals) are never refused.
  await enqueue(client, { kind: 'collect', params: {}, requestedBy: 'busy' });
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM job WHERE requested_by = 'busy' AND status = 'queued'`);
  assert.equal(rows[0].n, cap + 1);
});
