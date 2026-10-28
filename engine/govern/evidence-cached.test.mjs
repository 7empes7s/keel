// Security audit run 2, finding 10: repeated chain checks hash only new records, and any
// change to an already-verified record is still caught on the very next check.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { appendEvidence, verifyChainCached } from './evidence.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
await client.query(schemaSql());

test.after(async () => {
  await client.end();
  await database.cleanup();
});

// Counts the evidence rows each check loads for hashing.
function counting(target) {
  const seen = { hashed: 0 };
  return {
    seen,
    async query(text, values) {
      const result = await target.query(text, values);
      if (/SELECT seq, tenant_ref, occurred_at, kind, subject, actor, prev_hash, record_hash/.test(text)) {
        seen.hashed += result.rows.length;
      }
      return result;
    },
  };
}

async function check(spy, tenantRef, cache, now = 0) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { return await verifyChainCached(spy, { tenantRef, cache, now }); } finally { await client.query('COMMIT'); }
}

async function append(tenantRef, count) {
  for (let index = 0; index < count; index++) {
    await appendEvidence(client, { tenantRef, kind: 'policy-evaluation', subject: { index }, actor: 'operator' });
  }
}

test('the first check walks everything, later checks hash only the new records', async () => {
  const tenantRef = 'cached-incremental';
  const cache = new Map();
  const spy = counting(client);
  await append(tenantRef, 6);
  assert.deepEqual(await check(spy, tenantRef, cache), { ok: true });
  assert.equal(spy.seen.hashed, 6);

  spy.seen.hashed = 0;
  assert.deepEqual(await check(spy, tenantRef, cache), { ok: true });
  assert.equal(spy.seen.hashed, 0, 'nothing new, nothing re-hashed');

  await append(tenantRef, 2);
  spy.seen.hashed = 0;
  assert.deepEqual(await check(spy, tenantRef, cache), { ok: true });
  assert.equal(spy.seen.hashed, 2);
});

test('an edited old record is caught on the next check, even with a warm cache', async () => {
  const tenantRef = 'cached-tamper';
  const cache = new Map();
  await append(tenantRef, 5);
  assert.deepEqual(await check(client, tenantRef, cache), { ok: true });
  const { rows } = await client.query('SELECT seq FROM evidence WHERE tenant_ref = $1 ORDER BY seq', [tenantRef]);
  await client.query(`UPDATE evidence SET subject = '{"index": 99}' WHERE seq = $1`, [rows[1].seq]);
  assert.deepEqual(await check(client, tenantRef, cache), { ok: false, brokenAtSeq: rows[1].seq });
  assert.equal(cache.has(tenantRef), false, 'a broken result is never cached');
  assert.deepEqual(await check(client, tenantRef, cache), { ok: false, brokenAtSeq: rows[1].seq });
});

test('a deleted old record is caught on the next check', async () => {
  const tenantRef = 'cached-delete';
  const cache = new Map();
  await append(tenantRef, 4);
  assert.deepEqual(await check(client, tenantRef, cache), { ok: true });
  const { rows } = await client.query('SELECT seq FROM evidence WHERE tenant_ref = $1 ORDER BY seq', [tenantRef]);
  await client.query('DELETE FROM evidence WHERE seq = $1', [rows[1].seq]);
  assert.equal((await check(client, tenantRef, cache)).ok, false);
});

test('the cache is dropped for a full walk once it is older than the full-walk interval', async () => {
  const tenantRef = 'cached-expiry';
  const cache = new Map();
  const spy = counting(client);
  await append(tenantRef, 3);
  await check(spy, tenantRef, cache, 0);
  spy.seen.hashed = 0;
  await check(spy, tenantRef, cache, 60 * 1000);
  assert.equal(spy.seen.hashed, 0);
  await check(spy, tenantRef, cache, 11 * 60 * 1000);
  assert.equal(spy.seen.hashed, 3);
});
