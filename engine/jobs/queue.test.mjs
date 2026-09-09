import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  claimNext, complete, enqueue, fail, listJobs, ORPHANED_HEARTBEAT_STALE_MS,
  resetOrphaned,
} from './queue.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

try {
  const admin = await database.connect();
  try {
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
    const jobSchema = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS job'));
    await admin.query(jobSchema);
  } finally {
    await admin.end();
  }

  client = await database.connect();

// --- invalid kind is rejected by the CHECK constraint (also proves 'restore' cannot be
// enqueued yet — it is intentionally excluded until the write path can remap references) ---
await assert.rejects(
  () => enqueue(client, { kind: 'restore', params: {}, requestedBy: 'test-operator' }),
  /violates check constraint/,
);
await assert.rejects(
  () => enqueue(client, { kind: 'bogus', params: {}, requestedBy: 'test-operator' }),
  /violates check constraint/,
);

// --- enqueue then claimNext returns the job and marks it running ---
const queued = await enqueue(client, {
  kind: 'collect', params: { tier: 'tier1' }, requestedBy: 'test-operator',
});
assert.ok(queued.id);
assert.equal(queued.status, 'queued');
assert.equal(queued.kind, 'collect');
assert.deepEqual(queued.params, { tier: 'tier1' });

const claimed = await claimNext(client, { workerId: 'worker-a' });
assert.ok(claimed);
assert.equal(claimed.id, queued.id);
assert.equal(claimed.status, 'running');
assert.equal(claimed.worker_id, 'worker-a');
assert.ok(claimed.started_at);
assert.ok(claimed.heartbeat_at);

// --- claimNext on an empty queue returns null and does not throw ---
await assert.doesNotReject(async () => {
  const empty = await claimNext(client, { workerId: 'worker-a' });
  assert.equal(empty, null);
});

// --- complete/fail set terminal status and timestamps ---
const succeededJob = await enqueue(client, { kind: 'prune', params: {}, requestedBy: 'test-operator' });
await claimNext(client, { workerId: 'worker-a' });
const completed = await complete(client, {
  id: succeededJob.id,
  result: { stdout: 'pruned 0 snapshot(s)', durationMs: 12 },
});
assert.equal(completed.status, 'succeeded');
assert.ok(completed.finished_at);
assert.deepEqual(completed.result, { stdout: 'pruned 0 snapshot(s)', durationMs: 12 });
assert.equal(completed.error, null);

const failedJob = await enqueue(client, { kind: 'drift-detect', params: {}, requestedBy: 'test-operator' });
await claimNext(client, { workerId: 'worker-a' });
const failed = await fail(client, { id: failedJob.id, error: 'exit code 1\nstderr: boom' });
assert.equal(failed.status, 'failed');
assert.ok(failed.finished_at);
assert.equal(failed.error, 'exit code 1\nstderr: boom');
assert.equal(failed.result, null);

// --- listJobs is newest-first ---
const listed = await listJobs(client, { limit: 10 });
assert.ok(listed.length >= 3);
for (let i = 1; i < listed.length; i++) {
  assert.ok(new Date(listed[i - 1].created_at) >= new Date(listed[i].created_at));
}

// --- resetOrphaned never reclaims a fresh heartbeat, even for the SAME worker_id ---
const ownJob = await enqueue(client, { kind: 'collect', params: {}, requestedBy: 'test-operator' });
await claimNext(client, { workerId: 'worker-recover-me' });
assert.equal(ownJob.id, (await client.query('SELECT id FROM job WHERE worker_id = $1', ['worker-recover-me'])).rows[0].id);

const otherWorkersJob = await enqueue(client, { kind: 'prune', params: {}, requestedBy: 'test-operator' });
await claimNext(client, { workerId: 'worker-still-alive' });

const freshReclaimed = await resetOrphaned(client);
assert.deepEqual(freshReclaimed, []);
const { rows: freshRows } = await client.query(
  'SELECT status, worker_id, heartbeat_at FROM job WHERE id = $1',
  [ownJob.id],
);
assert.equal(freshRows[0].status, 'running');
assert.equal(freshRows[0].worker_id, 'worker-recover-me');
assert.ok(freshRows[0].heartbeat_at);

// --- resetOrphaned reclaims a stale heartbeat for the SAME worker_id ---
await client.query(
  `UPDATE job
   SET heartbeat_at = now() - ($2 * interval '1 millisecond')
   WHERE id = $1`,
  [ownJob.id, ORPHANED_HEARTBEAT_STALE_MS + 1000],
);
const reclaimed = await resetOrphaned(client);
assert.deepEqual(reclaimed.map((row) => row.id), [ownJob.id]);
const { rows: ownRows } = await client.query('SELECT status, worker_id, started_at, heartbeat_at FROM job WHERE id = $1', [ownJob.id]);
assert.equal(ownRows[0].status, 'queued');
assert.equal(ownRows[0].worker_id, null);
assert.equal(ownRows[0].started_at, null);
assert.equal(ownRows[0].heartbeat_at, null);

const { rows: otherRows } = await client.query('SELECT status, worker_id FROM job WHERE id = $1', [otherWorkersJob.id]);
assert.equal(otherRows[0].status, 'running');
assert.equal(otherRows[0].worker_id, 'worker-still-alive');

// Drain anything left queued by earlier sections (resetOrphaned above puts ownJob back to
// 'queued') so the concurrency test below has exactly one queued job to contend over.
while (await claimNext(client, { workerId: 'drain' })) { /* drain */ }

// --- the important one: TWO concurrent claimNext calls must never return the same job ---
// Runs the claim against two SEPARATE database connections so this is a real network-level
// race, not an in-process one.
const contested = await enqueue(client, { kind: 'collect', params: {}, requestedBy: 'test-operator' });
const clientA = await database.connect();
const clientB = await database.connect();
try {
  const [claimA, claimB] = await Promise.all([
    claimNext(clientA, { workerId: 'concurrent-a' }),
    claimNext(clientB, { workerId: 'concurrent-b' }),
  ]);
  const successes = [claimA, claimB].filter(Boolean);
  assert.equal(successes.length, 1, `expected exactly one concurrent claim to succeed, got ${successes.length}`);
  assert.equal(successes[0].id, contested.id);

  const { rows: runningRows } = await client.query(
    `SELECT worker_id FROM job WHERE id = $1 AND status = 'running'`,
    [contested.id],
  );
  assert.equal(runningRows.length, 1);
  assert.equal(runningRows[0].worker_id, successes[0].worker_id);
} finally {
  await clientA.end();
  await clientB.end();
}

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('queue.test.mjs — all assertions passed');
