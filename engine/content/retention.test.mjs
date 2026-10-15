// Wave 2 RET: content item versions rotate per item, legal holds keep them, and a chunk
// goes only when no kept item (of any tenant) still lists it. The dry run and the real
// run remove the same set.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { placeLegalHold, releaseLegalHold, runPrune, setRetentionPolicy } from '../store/retention.mjs';
import { createMemoryContentIndex } from './index.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
await client.query(schemaSql());
after(async () => {
  await client.end();
  await database.cleanup();
});

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-15T12:00:00Z');
const chunkId = (name) => createHash('sha256').update(name).digest('hex');

async function addChunk(name) {
  await client.query(
    `INSERT INTO content_chunk (id, key_id, object_name, plain_bytes, stored_bytes) VALUES ($1, 'k1', $2, 10, 38)
     ON CONFLICT (id) DO NOTHING`,
    [chunkId(name), `content/${chunkId(name)}`],
  );
}

async function addVersion({ tenantRef, workload = 'exchange-mail', container, itemKey, version, daysAgo, chunks, metadata = {} }) {
  for (const name of chunks) await addChunk(name);
  const { rows: [row] } = await client.query(
    `INSERT INTO content_item (tenant_ref, workload, container, item_key, version, sha256, bytes, chunks, key_id, created_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'k1', $9, $10) RETURNING id`,
    [tenantRef, workload, container, itemKey, version, chunkId(`${itemKey}:${version}`), chunks.length * 10,
      JSON.stringify(chunks.map((name) => [chunkId(name), 10])), new Date(now - daysAgo * DAY), metadata],
  );
  return row.id;
}

const chunkExists = async (name) => (await client.query('SELECT 1 FROM content_chunk WHERE id = $1', [chunkId(name)])).rowCount === 1;
const itemExists = async (id) => (await client.query('SELECT 1 FROM content_item WHERE id = $1', [id])).rowCount === 1;

test('versions rotate per item; a shared chunk survives; holds and keep-forever keep versions; dry run equals apply', async () => {
  const tenantRef = 'sha256:content-retention';
  await setRetentionPolicy(client, { tenantRef, workload: 'exchange-mail', policy: { daily: 2 }, setBy: 'test-operator' });

  // Item A: four versions; the policy keeps the newest two days.
  const a1 = await addVersion({ tenantRef, container: 'KEEL-RT-mbx-1', itemKey: 'a', version: '1', daysAgo: 10, chunks: ['only-a1', 'shared-with-b', 'shared-a1-a3'] });
  const a2 = await addVersion({ tenantRef, container: 'KEEL-RT-mbx-1', itemKey: 'a', version: '2', daysAgo: 5, chunks: ['shared-other-tenant'] });
  const a3 = await addVersion({ tenantRef, container: 'KEEL-RT-mbx-1', itemKey: 'a', version: '3', daysAgo: 1, chunks: ['shared-a1-a3'] });
  const a4 = await addVersion({ tenantRef, container: 'KEEL-RT-mbx-1', itemKey: 'a', version: '4', daysAgo: 0, chunks: ['a4'] });
  // Item B: one version, holding a chunk A's pruned version also holds.
  const b1 = await addVersion({ tenantRef, container: 'KEEL-RT-mbx-2', itemKey: 'b', version: '1', daysAgo: 400, chunks: ['shared-with-b'] });
  // Another tenant holds the chunk of A's other pruned version.
  await addVersion({ tenantRef: 'sha256:content-retention-other', container: 'KEEL-RT-mbx-9', itemKey: 'z', version: '1', daysAgo: 30, chunks: ['shared-other-tenant'] });
  // Item C is under a legal hold on its mailbox.
  const c1 = await addVersion({ tenantRef, container: 'KEEL-RT-mbx-held', itemKey: 'c', version: '1', daysAgo: 90, chunks: ['c1'] });
  const c2 = await addVersion({ tenantRef, container: 'KEEL-RT-mbx-held', itemKey: 'c', version: '2', daysAgo: 60, chunks: ['c2'] });
  const c3 = await addVersion({ tenantRef, container: 'KEEL-RT-mbx-held', itemKey: 'c', version: '3', daysAgo: 0, chunks: ['c3'] });
  const hold = await placeLegalHold(client, { tenantRef, workload: 'exchange-mail', container: 'KEEL-RT-mbx-held', reason: 'litigation', placedBy: 'test-operator' });
  // Item D has its own keep-forever policy.
  const d1 = await addVersion({ tenantRef, container: 'KEEL-RT-mbx-1', itemKey: 'd', version: '1', daysAgo: 300, chunks: ['d1'] });
  const d2 = await addVersion({ tenantRef, container: 'KEEL-RT-mbx-1', itemKey: 'd', version: '2', daysAgo: 0, chunks: ['d2'] });
  await setRetentionPolicy(client, { tenantRef, workload: 'exchange-mail', container: 'KEEL-RT-mbx-1', itemKey: 'd', policy: { keepForever: true }, setBy: 'test-operator' });

  const dry = await runPrune(client, { tenantRef, now });
  assert.equal(dry.report.mode, 'dry-run');
  assert.deepEqual(dry.report.content.delete.map((d) => d.id).sort(), [a1, a2].sort());
  assert.match(dry.report.content.delete[0].reason, /^outside policy \(exchange-mail: 2 daily\)$/);
  assert.deepEqual(dry.report.content.chunks.map((c) => c.id), [chunkId('only-a1')]);
  assert.equal(dry.report.content.freedBytes, 38);
  assert.deepEqual(dry.report.content.kept, { 'latest version': 3, daily: 1, 'legal hold': 2, 'keep forever': 1 });
  assert.equal(dry.report.content.singleVersionItems, 1);
  assert.deepEqual(dry.report.holds, [{ id: hold.id, scope: 'exchange-mail / KEEL-RT-mbx-held', reason: 'litigation' }]);
  for (const id of [a1, a2, a3, a4, b1, c1, c2, c3, d1, d2]) assert.ok(await itemExists(id), 'a dry run deletes nothing');
  assert.ok(await chunkExists('only-a1'));

  const real = await runPrune(client, { tenantRef, now, apply: true });
  assert.deepEqual(real.report.content, dry.report.content, 'the real run removes what the dry run listed');
  for (const id of [a1, a2]) assert.equal(await itemExists(id), false);
  for (const id of [a3, a4, b1, c1, c2, c3, d1, d2]) assert.ok(await itemExists(id));
  assert.equal(await chunkExists('only-a1'), false);
  for (const name of ['shared-with-b', 'shared-a1-a3', 'shared-other-tenant', 'a4', 'c1', 'c2']) assert.ok(await chunkExists(name), `${name} is still held`);

  const { rows: reports } = await client.query(
    'SELECT mode, versions_deleted, chunks_deleted FROM retention_prune_report WHERE tenant_ref = $1 ORDER BY created_at',
    [tenantRef],
  );
  assert.deepEqual(reports, [
    { mode: 'dry-run', versions_deleted: 2, chunks_deleted: 1 },
    { mode: 'apply', versions_deleted: 2, chunks_deleted: 1 },
  ]);

  // Released, the hold no longer keeps C's old versions.
  await assert.rejects(releaseLegalHold(client, { tenantRef, holdId: hold.id, reason: ' ', releasedBy: 'test-operator' }), /reason is required/);
  await releaseLegalHold(client, { tenantRef, holdId: hold.id, reason: 'case closed', releasedBy: 'test-operator' });
  await assert.rejects(releaseLegalHold(client, { tenantRef, holdId: hold.id, reason: 'again', releasedBy: 'test-operator' }), /not found/);
  const afterRelease = await runPrune(client, { tenantRef, now });
  assert.deepEqual(afterRelease.report.content.delete.map((d) => d.id), [c1]);
});

test("a file's record and a removal tombstone never push out the content they describe", async () => {
  const tenantRef = 'sha256:content-retention-kinds';
  // A drive file: its bytes, then its metadata record a moment later under the same key.
  const bytes1 = await addVersion({ tenantRef, workload: 'onedrive', container: 'KEEL-RT-drive', itemKey: 'f', version: 'v1', daysAgo: 0.002, chunks: ['f-v1'], metadata: { kind: 'drive-content' } });
  const record1 = await addVersion({ tenantRef, workload: 'onedrive', container: 'KEEL-RT-drive', itemKey: 'f', version: 'record:a', daysAgo: 0.001, chunks: ['f-rec-a'], metadata: { kind: 'drive-record' } });
  // A message stored, then removed the same day.
  const message = await addVersion({ tenantRef, container: 'KEEL-RT-mbx-1', itemKey: 'm', version: 'ck1', daysAgo: 0.5, chunks: ['m-1'], metadata: { kind: 'message' } });
  const tombstone = await addVersion({ tenantRef, container: 'KEEL-RT-mbx-1', itemKey: 'm', version: 'removed@x', daysAgo: 0.1, chunks: ['m-gone'], metadata: { removed: true } });
  // Older bytes and records of the same file rotate within their own kind.
  const bytes0 = await addVersion({ tenantRef, workload: 'onedrive', container: 'KEEL-RT-drive', itemKey: 'f', version: 'v0', daysAgo: 0.003, chunks: ['f-v0'], metadata: { kind: 'drive-content' } });
  const record0 = await addVersion({ tenantRef, workload: 'onedrive', container: 'KEEL-RT-drive', itemKey: 'f', version: 'record:0', daysAgo: 0.0025, chunks: ['f-rec-0'], metadata: { kind: 'drive-record' } });

  const { report } = await runPrune(client, { tenantRef, now });
  assert.deepEqual(report.content.delete.map((d) => d.id).sort(), [bytes0, record0].sort());
  assert.deepEqual(report.content.kept, { 'latest version': 4 });
  for (const id of [bytes1, record1, message, tombstone]) assert.ok(!report.content.delete.some((d) => d.id === id));
});

test('a policy or hold scope must name a known workload, and nest', async () => {
  const tenantRef = 'sha256:content-retention-scope';
  await assert.rejects(setRetentionPolicy(client, { tenantRef, workload: 'fax', policy: { daily: 1 }, setBy: 'x' }), /workload must be/);
  await assert.rejects(setRetentionPolicy(client, { tenantRef, container: 'c', policy: { daily: 1 }, setBy: 'x' }), /needs a workload/);
  await assert.rejects(placeLegalHold(client, { tenantRef, workload: 'onedrive', itemKey: 'i', reason: 'r', placedBy: 'x' }), /needs a container/);
  await assert.rejects(setRetentionPolicy(client, { tenantRef, policy: {}, setBy: 'x' }), /must keep something/);
  // Setting the same scope again replaces it.
  await setRetentionPolicy(client, { tenantRef, policy: { daily: 3 }, setBy: 'x' });
  await setRetentionPolicy(client, { tenantRef, policy: { daily: 5 }, setBy: 'y' });
  const { rows } = await client.query('SELECT daily, set_by FROM retention_policy WHERE tenant_ref = $1', [tenantRef]);
  assert.deepEqual(rows, [{ daily: 5, set_by: 'y' }]);
});

test('the memory index deletes items and only the chunks no other item holds', async () => {
  const index = createMemoryContentIndex();
  for (const id of ['x', 'y', 'z']) await index.addChunk({ id, keyId: 'k', objectName: `content/${id}`, plainBytes: 1, storedBytes: 2 });
  const base = { tenantRef: 't', workload: 'onedrive', container: 'KEEL-RT-drive', sha256: '0'.repeat(64), bytes: 2, keyId: 'k', newBytes: 0, metadata: {} };
  const one = await index.insertItem({ ...base, itemKey: 'f', version: '1', chunks: [['x', 1], ['y', 1]] });
  await index.insertItem({ ...base, itemKey: 'f', version: '2', chunks: [['y', 1], ['z', 1]] });
  assert.deepEqual(await index.orphanedChunks([one.id]), [{ id: 'x', objectName: 'content/x', storedBytes: 2 }]);
  const removed = await index.deleteItems([one.id]);
  assert.deepEqual([removed.items, removed.chunks.map((c) => c.id)], [1, ['x']]);
  assert.equal(await index.getItem(one.id), null);
  assert.deepEqual([...index.chunks.keys()].sort(), ['y', 'z']);
  assert.equal(await index.findItem({ ...base, itemKey: 'f', version: '1' }), null);
});
