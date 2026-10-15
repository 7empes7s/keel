// Wave 2 RET: settings snapshots rotate under the tenant's policy; legal holds and the
// existing dependency rules keep snapshots; the dry run and the real run remove the same set.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot, insertResourceVersion } from './db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from './loadSchema.mjs';
import { placeLegalHold, releaseLegalHold, runPrune, setRetentionPolicy } from './retention.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
await client.query(schemaSql());
after(async () => {
  await client.end();
  await database.cleanup();
});

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-10-15T12:00:00Z');

async function seed(tenantRef, at, { tier = 'tier1', completed = true } = {}) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: `group:KEEL-RT-${snapshotId}`, resourceType: 'group', payload: {}, payloadHash: snapshotId,
      criticality: tier, blastRadius: 'access-affecting', fidelity: 'full', provenance: { adapter: 'test' },
    },
  });
  await client.query('UPDATE snapshot SET started_at = $2, completed_at = $3 WHERE id = $1', [snapshotId, at, completed ? at : null]);
  return snapshotId;
}
const exists = async (id) => (await client.query('SELECT 1 FROM snapshot WHERE id = $1', [id])).rowCount === 1;

test('hourly snapshots rotate to one a day; a legal hold blocks prune until released', async () => {
  const tenantRef = 'sha256:retention-policy';
  await setRetentionPolicy(client, { tenantRef, workload: 'config', container: 'tier1', policy: { daily: 2 }, setBy: 'test-operator' });
  // Hourly over three days (2026-10-13 13:00 .. 2026-10-15 12:00).
  const ids = [];
  for (let h = 47; h >= 0; h -= 1) ids.push(await seed(tenantRef, new Date(now - h * HOUR)));
  // A tier3 snapshot falls under the default policy, not tier1's.
  const tier3 = await seed(tenantRef, new Date(now - 100 * 24 * HOUR), { tier: 'tier3' });

  // A tenant-wide hold keeps everything.
  const hold = await placeLegalHold(client, { tenantRef, reason: 'regulator request', placedBy: 'test-operator' });
  const held = await runPrune(client, { tenantRef, now, apply: true });
  assert.deepEqual(held.report.snapshots.delete, []);
  assert.equal(held.report.snapshots.kept['legal hold'], 49);
  for (const id of ids) assert.ok(await exists(id));
  await releaseLegalHold(client, { tenantRef, holdId: hold.id, reason: 'request closed', releasedBy: 'test-operator' });

  // One snapshot held on its own.
  const single = await placeLegalHold(client, { tenantRef, workload: 'config', container: 'tier1', itemKey: ids[0], reason: 'evidence', placedBy: 'test-operator' });
  const dry = await runPrune(client, { tenantRef, now });
  const keptIds = dry.report.snapshots.entries.filter((e) => e.keep).map((e) => e.id);
  // Newest of 2026-10-14 (ids[34] is 23:00) and of 2026-10-15 (the last), plus the held one and tier3.
  assert.deepEqual(keptIds.sort(), [ids[0], ids[34], ids.at(-1), tier3].sort());
  const entry = (id) => dry.report.snapshots.entries.find((e) => e.id === id);
  assert.deepEqual(entry(ids[0]).reasons, ['legal hold: evidence']);
  assert.deepEqual(entry(ids.at(-1)).reasons, ['daily 2026-10-15']);
  assert.deepEqual(entry(tier3).reasons, ['daily 2026-07-07', 'weekly 2026-W28', 'monthly 2026-07', 'yearly 2026']);
  assert.deepEqual(entry(ids[1]).reasons, ['outside policy (config / tier1: 2 daily)']);
  assert.equal(dry.report.snapshots.delete.length, 45);
  assert.equal(await exists(ids[1]), true, 'a dry run deletes nothing');

  const real = await runPrune(client, { tenantRef, now, apply: true });
  assert.deepEqual(real.report.snapshots, dry.report.snapshots, 'the real run removes what the dry run listed');
  const { rows } = await client.query('SELECT id FROM snapshot WHERE tenant_ref = $1', [tenantRef]);
  assert.deepEqual(rows.map((r) => r.id).sort(), keptIds.sort());
  assert.ok(single.id);
});

test('a policy on one snapshot keeps it forever; an unfinished snapshot is kept a day, then goes', async () => {
  const tenantRef = 'sha256:retention-policy-item';
  await setRetentionPolicy(client, { tenantRef, policy: { daily: 1 }, setBy: 'test-operator' });
  const old = await seed(tenantRef, new Date(now - 40 * 24 * HOUR));
  const newest = await seed(tenantRef, now);
  const running = await seed(tenantRef, new Date(now - HOUR), { completed: false });
  const abandoned = await seed(tenantRef, new Date(now - 3 * 24 * HOUR), { completed: false });
  const forever = await seed(tenantRef, new Date(now - 30 * 24 * HOUR));
  await setRetentionPolicy(client, { tenantRef, workload: 'config', container: 'tier1', itemKey: forever, policy: { keepForever: true }, setBy: 'test-operator' });

  const { report } = await runPrune(client, { tenantRef, now });
  const reasons = Object.fromEntries(report.snapshots.entries.map((e) => [e.id, e.reasons]));
  assert.deepEqual(reasons[newest], ['daily 2026-10-15']);
  assert.deepEqual(reasons[running], ['in progress']);
  assert.deepEqual(reasons[forever], ['keep forever']);
  assert.deepEqual(reasons[abandoned], ['never completed']);
  assert.deepEqual(reasons[old], ['outside policy (tenant: 1 daily)']);
  assert.deepEqual(report.snapshots.delete.sort(), [old, abandoned].sort());
  assert.deepEqual(report.policies.sort(), ['config / tier1 / ' + forever + ': keep forever', 'tenant: 1 daily'].sort());
});
