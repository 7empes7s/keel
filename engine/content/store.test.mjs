import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createLocalStorageAdapter } from '../storage/local.mjs';
import { createPgContentIndex } from './index.mjs';
import {
  CHUNKING, chunkObjectName, chunkStream, createContentStore, createMemoryContentStore, parseContentKey,
} from './store.mjs';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * A deterministic synthetic stream: an AES-CTR keystream (incompressible, repeatable),
 * delivered in odd-sized pieces so chunk boundaries never line up with reads. `insert`
 * splices extra bytes in at an offset, to model an edit inside a large file.
 */
function synthetic(total, { seed = 'KEEL-RT-synthetic', piece = 64 * 1024 + 17, insert = null, observed = null } = {}) {
  const key = createHash('sha256').update(seed).digest();
  const hash = observed ? createHash('sha256') : null;
  async function* generate() {
    const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16));
    let sent = 0;
    while (sent < total) {
      const size = Math.min(piece, total - sent);
      let out = cipher.update(Buffer.alloc(size));
      if (insert && insert.at >= sent && insert.at < sent + size) {
        const cut = insert.at - sent;
        out = Buffer.concat([out.subarray(0, cut), insert.bytes, out.subarray(cut)]);
      }
      sent += size;
      if (hash) { hash.update(out); observed.bytes = (observed.bytes ?? 0) + out.length; }
      yield out;
    }
    // The generator's own record of what it produced, independent of the store.
    if (hash) observed.sha256 = hash.digest('hex');
  }
  return Readable.from(generate(), { objectMode: false });
}

async function digest(stream) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}

function directoryBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath ?? entry.path, entry.name)).size;
  }
  return total;
}

/** Samples resident memory while `work` runs; returns its result and the peak growth. */
async function peakMemory(work) {
  globalThis.gc?.();
  const base = process.memoryUsage().rss;
  let peak = base;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  try {
    const result = await work();
    peak = Math.max(peak, process.memoryUsage().rss);
    return { result, growth: peak - base };
  } finally {
    clearInterval(timer);
  }
}

const item = (overrides = {}) => ({
  tenantRef: 'sha256:KEEL-RT-tenant', workload: 'onedrive', container: 'drive:KEEL-RT-drive', itemKey: 'KEEL-RT-file', ...overrides,
});

test('content-defined chunks stay within bounds and do not depend on read sizes', async () => {
  const sizes = async (piece) => {
    const out = [];
    for await (const chunk of chunkStream(synthetic(24 * MiB, { piece }))) out.push(chunk.length);
    return out;
  };
  const a = await sizes(4096);
  const b = await sizes(3 * MiB + 1);
  assert.deepEqual(a, b, 'boundaries come from the content, not from how it was read');
  assert.equal(a.reduce((sum, size) => sum + size, 0), 24 * MiB);
  for (const size of a.slice(0, -1)) assert.ok(size >= CHUNKING.min && size <= CHUNKING.max, `chunk of ${size} bytes is out of bounds`);
  assert.ok(a.length > 6 && a.length < 96, `${a.length} chunks for 24 MiB`);
});

test('the memory store round-trips, dedupes and keeps only ciphertext', async () => {
  const store = createMemoryContentStore();
  const plain = Buffer.from('KEEL-RT- a small message body that must never be stored in the clear. '.repeat(50));
  const first = await store.putItem(Readable.from([plain]), item({ workload: 'mailbox', container: 'mailbox:KEEL-RT-user', itemKey: 'm1', version: 'ck-1' }));
  assert.match(first.ref, /^keel-content:[0-9a-f-]{36}$/);
  assert.equal(first.bytes, plain.length);
  assert.equal(first.sha256, createHash('sha256').update(plain).digest('hex'));
  assert.equal(first.deduped, false);
  assert.ok(Buffer.concat(await Readable.from(await store.getItem(first.ref)).toArray()).equals(plain));
  for (const blob of store.storage.objects.values()) assert.equal(blob.includes(Buffer.from('KEEL-RT- a small')), false, 'a stored chunk holds plaintext');

  // The same version is not read again; the same bytes under another key store nothing new.
  let pulled = false;
  const again = await store.putItem(Readable.from((async function* () { pulled = true; yield plain; })()),
    item({ workload: 'mailbox', container: 'mailbox:KEEL-RT-user', itemKey: 'm1', version: 'ck-1' }));
  assert.deepEqual(again, { ...first, deduped: true });
  assert.equal(pulled, false, 'a held version is not downloaded again');
  const copy = await store.putItem(Readable.from([plain]), item({ workload: 'mailbox', container: 'mailbox:KEEL-RT-user', itemKey: 'm2', version: 'ck-1' }));
  assert.equal(copy.deduped, true);
  assert.notEqual(copy.ref, first.ref);
  assert.equal(store.storage.objects.size, 1);

  // Two runs racing on one version with different bytes: the second is refused, not merged.
  const racing = createContentStore({ index: { ...store.index, findItem: async () => null }, storage: store.storage, key: randomBytes(32) });
  await assert.rejects(racing.putItem(Readable.from([Buffer.from('other')]),
    item({ workload: 'mailbox', container: 'mailbox:KEEL-RT-user', itemKey: 'm1', version: 'ck-1' })), /different content/);
  const empty = await store.putItem(Readable.from([]), item({ itemKey: 'empty' }));
  assert.equal(empty.bytes, 0);
  assert.equal((await Readable.from(await store.getItem(empty.ref)).toArray()).length, 0);

  const listed = await store.listItems({ container: 'mailbox:KEEL-RT-user' });
  assert.deepEqual(listed.map((row) => row.itemKey), ['m1', 'm2']);
  assert.deepEqual((await store.listItems({ container: 'mailbox:KEEL-RT-user', since: listed[0].createdAt })).map((row) => row.itemKey), ['m2']);

  await assert.rejects(store.putItem(Readable.from([plain]), item({ workload: 'exchange' })), /workload must be one of/);
  await assert.rejects(store.putItem(Readable.from([plain]), item({ container: '' })), /container/);
  await assert.rejects(store.getItem('not-a-ref'), /not a content ref/);
  await assert.rejects(store.listItems({}), /container/);
});

test('a tampered, swapped or foreign-key chunk fails the read instead of returning wrong bytes', async () => {
  const key = randomBytes(32);
  const store = createMemoryContentStore({ key });
  const body = randomBytes(3 * MiB);
  const put = await store.putItem(Readable.from([body]), item({ itemKey: 'tamper' }));
  const other = await store.putItem(Readable.from([randomBytes(1000)]), item({ itemKey: 'other' }));
  const names = [...store.storage.objects.keys()];
  const [{ chunks: [[firstId]] }, { chunks: [[otherId]] }] = [await store.index.getItem(put.ref.split(':')[1]), await store.index.getItem(other.ref.split(':')[1])];

  const original = store.storage.objects.get(chunkObjectName(firstId));
  const flipped = Buffer.from(original);
  flipped[flipped.length - 40] ^= 1;
  store.storage.objects.set(chunkObjectName(firstId), flipped);
  await assert.rejects(digest(await store.getItem(put.ref)), /failed its integrity check/);
  store.storage.objects.set(chunkObjectName(firstId), store.storage.objects.get(chunkObjectName(otherId)));
  await assert.rejects(digest(await store.getItem(put.ref)), /failed its integrity check/, 'a chunk is bound to its own name');
  store.storage.objects.set(chunkObjectName(firstId), original);
  assert.equal((await digest(await store.getItem(put.ref))).sha256, put.sha256);
  assert.ok(names.length >= 2);

  const foreign = createContentStore({ index: store.index, storage: store.storage, key: randomBytes(32) });
  await assert.rejects(foreign.getItem(put.ref), /encrypted under another key/);
  assert.throws(() => parseContentKey('short'), /32 bytes/);
  assert.equal(parseContentKey('ab'.repeat(32)).length, 32);
});

test('an edit inside a large item stores only the chunks around it', async () => {
  const store = createMemoryContentStore();
  const size = 64 * MiB;
  await store.putItem(synthetic(size), item({ itemKey: 'large', version: 'v1' }));
  const stored = () => [...store.storage.objects.values()].reduce((sum, blob) => sum + blob.length, 0);
  const before = stored();
  const edited = await store.putItem(synthetic(size, { insert: { at: 20 * MiB + 3, bytes: Buffer.from('KEEL-RT- inserted paragraph') } }),
    item({ itemKey: 'large', version: 'v2' }));
  assert.equal(edited.deduped, false);
  const added = stored() - before;
  assert.ok(added < size * 0.15, `an insert stored ${added} new bytes of ${size}`);
});

test('Postgres index: a 1 GB stream reads back byte-identical, a second store adds under 1%, memory stays bounded', { timeout: 10 * 60 * 1000 }, async (t) => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  const root = mkdtempSync(join(tmpdir(), 'keel-content-'));
  t.after(async () => {
    rmSync(root, { recursive: true, force: true });
    await client.end();
    await database.cleanup();
  });
  await client.query(schemaSql());
  const keyFile = join(root, 'content.key');
  writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const storage = createLocalStorageAdapter({ root: join(root, 'storage') });
  const store = createContentStore({ index: createPgContentIndex(client), storage, key: parseContentKey(readFileSync(keyFile, 'utf8')) });

  const expected = {};
  const first = await peakMemory(() => store.putItem(synthetic(GiB, { observed: expected }), item({ itemKey: 'KEEL-RT-1gb', metadata: { name: 'KEEL-RT-1gb.bin' } })));
  assert.equal(expected.bytes, GiB);
  assert.equal(first.result.sha256, expected.sha256);
  assert.equal(first.result.bytes, GiB);
  assert.equal(first.result.deduped, false);
  const storedAfterFirst = directoryBytes(join(root, 'storage'));
  assert.ok(storedAfterFirst >= GiB && storedAfterFirst < GiB * 1.01, `ciphertext overhead: ${storedAfterFirst} bytes for 1 GiB`);

  const readBack = await peakMemory(async () => digest(await store.getItem(first.result.ref)));
  assert.deepEqual(readBack.result, { sha256: expected.sha256, bytes: expected.bytes }, 'the stream reads back byte-identical');

  const second = await peakMemory(() => store.putItem(synthetic(GiB), item({ itemKey: 'KEEL-RT-1gb-copy' })));
  assert.equal(second.result.sha256, expected.sha256);
  assert.equal(second.result.deduped, true);
  const added = directoryBytes(join(root, 'storage')) - storedAfterFirst;
  const { rows: [index] } = await client.query(
    `SELECT pg_column_size(chunks) + pg_column_size(metadata) + 200 AS row_bytes, new_bytes FROM content_item WHERE item_key = 'KEEL-RT-1gb-copy'`,
  );
  assert.equal(Number(index.new_bytes), 0);
  assert.ok(added + index.row_bytes < GiB * 0.01, `storing it again added ${added} storage bytes and a ${index.row_bytes}-byte index row`);

  const budget = 256 * MiB;
  for (const [phase, run] of [['put', first], ['get', readBack], ['second put', second]]) {
    assert.ok(run.growth < budget, `${phase} grew resident memory by ${Math.round(run.growth / MiB)} MiB (budget ${budget / MiB} MiB)`);
  }
  t.diagnostic(`peak growth MiB: put ${Math.round(first.growth / MiB)}, get ${Math.round(readBack.growth / MiB)}, second ${Math.round(second.growth / MiB)}`);

  const listed = await store.listItems({ container: 'drive:KEEL-RT-drive' });
  assert.deepEqual(listed.map((row) => row.itemKey), ['KEEL-RT-1gb', 'KEEL-RT-1gb-copy']);
  assert.deepEqual(listed[0].metadata, { name: 'KEEL-RT-1gb.bin' });
  assert.equal(listed[0].bytes, GiB);
  assert.deepEqual((await store.listItems({ container: 'drive:KEEL-RT-drive', since: listed[1].createdAt })), []);
});
