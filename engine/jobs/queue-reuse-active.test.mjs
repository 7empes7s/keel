import { strict as assert } from 'node:assert';
import { claimNext, complete, enqueue, PORTAL_QUEUED_JOBS_PER_PRINCIPAL } from './queue.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

// UI audit B1: "Back up Tier 3" pressed twice queued two jobs. A backup request for a
// tier that is already queued or running returns that job instead of adding another.
const database = await createIsolatedTestDatabase(import.meta.url);
let client;
let other;

try {
  const admin = await database.connect();
  try {
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await admin.query(schemaSql());
  } finally {
    await admin.end();
  }
  client = await database.connect();
  other = await database.connect();

  const reuse = (tier) => ({ kinds: ['backup', 'collect'], params: { tier } });
  const backUp = (db, tier, key, requestedBy = 'person-a') => enqueue(db, {
    kind: 'backup', params: { tier }, requestedBy, idempotencyKey: key,
    maxQueuedForRequester: PORTAL_QUEUED_JOBS_PER_PRINCIPAL, reuseActive: reuse(tier),
  });
  const count = async (tier) => (await client.query(
    `SELECT count(*)::int AS n FROM job WHERE params->>'tier' = $1`, [tier])).rows[0].n;

  // --- a second request with a new key returns the queued job ---
  const first = await backUp(client, 'tier3', 'k1');
  assert.equal(first.reused, undefined);
  const second = await backUp(client, 'tier3', 'k2');
  assert.equal(second.id, first.id);
  assert.equal(second.reused, true);
  assert.equal(await count('tier3'), 1);

  // --- another person asking for the same tier gets the same job ---
  const third = await backUp(client, 'tier3', 'k3', 'person-b');
  assert.equal(third.id, first.id);
  assert.equal(third.reused, true);

  // --- a different tier is its own job ---
  const tier1 = await backUp(client, 'tier1', 'k4');
  assert.notEqual(tier1.id, first.id);
  assert.equal(tier1.reused, undefined);

  // --- a running job is reused too; a finished one is not ---
  let claimed;
  while ((claimed = await claimNext(client, { workerId: 'w1' }))) {
    if (claimed.id === first.id) break;
  }
  assert.equal(claimed.id, first.id);
  assert.equal((await backUp(client, 'tier3', 'k5')).id, first.id);
  // A running job whose worker died (stale heartbeat) does not block a new run.
  await client.query(`UPDATE job SET heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [first.id]);
  const afterCrash = await backUp(client, 'tier3', 'k5b');
  assert.notEqual(afterCrash.id, first.id);
  assert.equal(afterCrash.reused, undefined);
  await client.query(`UPDATE job SET status = 'succeeded' WHERE id = $1`, [afterCrash.id]);
  await complete(client, { id: first.id, result: {} });
  const after = await backUp(client, 'tier3', 'k6');
  assert.notEqual(after.id, first.id);
  assert.equal(after.reused, undefined);

  // --- a scheduled tier run (kind collect) already queued counts as the same run ---
  const scheduled = await enqueue(client, {
    kind: 'collect', params: { tier: 'tier2', tenantRef: 't' }, requestedBy: 'scheduler',
    idempotencyKey: 'schedule:x:1',
  });
  const onDemand = await backUp(client, 'tier2', 'k7');
  assert.equal(onDemand.id, scheduled.id);
  assert.equal(onDemand.reused, true);

  // --- two parallel requests for an idle tier add exactly one job ---
  await client.query(`UPDATE job SET status = 'succeeded' WHERE status IN ('queued', 'running')`);
  const [left, right] = await Promise.all([
    backUp(client, 'tier1', 'p1'),
    backUp(other, 'tier1', 'p2', 'person-b'),
  ]);
  assert.equal(left.id, right.id);
  assert.equal((await client.query(
    `SELECT count(*)::int AS n FROM job WHERE params->>'tier' = 'tier1' AND status = 'queued'`)).rows[0].n, 1);

  // --- without reuseActive nothing changes: a new key is a new job ---
  const plain = await enqueue(client, { kind: 'backup', params: { tier: 'tier1' }, requestedBy: 'person-a', idempotencyKey: 'n1' });
  assert.notEqual(plain.id, left.id);

  console.log('queue reuse-active: ok');
} finally {
  await client?.end();
  await other?.end();
  await database.cleanup();
}
