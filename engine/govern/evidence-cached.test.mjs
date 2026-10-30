// Security audit run 2, finding 10: repeated chain checks hash only new records, and any
// change to an already-verified record is still caught on the very next check.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { appendEvidence, refreshChainCache, verifyChainCached } from './evidence.mjs';
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

async function check(spy, tenantRef, cache, now = 0, extra = {}) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { return await verifyChainCached(spy, { tenantRef, cache, now, ...extra }); } finally { await client.query('COMMIT'); }
}

// Records each fingerprint query's range start (null = the whole prefix).
function fingerprints(target) {
  const starts = [];
  return {
    starts,
    query(text, values) {
      if (/hashtextextended/.test(text)) starts.push(values[1]);
      return target.query(text, values);
    },
  };
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

test('a full walk reads the record a page at a time and still catches a change on a later page', async () => {
  const tenantRef = 'cached-pages';
  const cache = new Map();
  await append(tenantRef, 7);
  const pages = [];
  const spy = { query(text, values) {
    if (/SELECT seq, tenant_ref, occurred_at/.test(text)) pages.push(text.match(/LIMIT (\d+)/)[1]);
    return client.query(text, values);
  } };
  assert.deepEqual(await check(spy, tenantRef, cache, 0, { pageSize: 3 }), { ok: true });
  assert.deepEqual(pages, ['3', '3', '3'], 'three pages of at most three records');
  assert.equal(cache.get(tenantRef).tip.count, '7');

  const { rows } = await client.query('SELECT seq FROM evidence WHERE tenant_ref = $1 ORDER BY seq', [tenantRef]);
  await client.query(`UPDATE evidence SET subject = '{"index": 99}' WHERE seq = $1`, [rows[5].seq]);
  cache.clear();
  assert.deepEqual(await check(client, tenantRef, cache, 0, { pageSize: 3 }), { ok: false, brokenAtSeq: rows[5].seq });
});

test('moving the verified tip forward fingerprints only the new records', async () => {
  const tenantRef = 'cached-additive';
  const cache = new Map();
  const spy = fingerprints(client);
  await append(tenantRef, 4);
  await check(spy, tenantRef, cache);
  const tip = cache.get(tenantRef).tip.seq;
  await append(tenantRef, 2);
  spy.starts.length = 0;
  assert.deepEqual(await check(spy, tenantRef, cache), { ok: true });
  assert.deepEqual(spy.starts, [null, tip], 'one check of the stored prefix, one of the new records only');

  // The added-up fingerprint equals a fresh one, so the next check trusts the prefix.
  const fresh = new Map();
  await check(client, tenantRef, fresh);
  assert.deepEqual(cache.get(tenantRef).fingerprint, fresh.get(tenantRef).fingerprint);
  const counter = counting(client);
  await check(counter, tenantRef, cache);
  assert.equal(counter.seen.hashed, 0);
});

test('the timer refresh does the full walk before a page load would have to', async () => {
  const tenantRef = 'cached-refresh';
  const cache = new Map();
  await append(tenantRef, 3);
  assert.deepEqual(await refreshChainCache(client, { tenantRef, cache, now: 0 }), { ok: true });

  const spy = counting(client);
  // At 8.5 minutes the timer's walk is due (two minutes ahead of the page loads' 10).
  await refreshChainCache(spy, { tenantRef, cache, now: 8.5 * 60 * 1000 });
  assert.equal(spy.seen.hashed, 3, 'the timer re-walked the whole chain');
  spy.seen.hashed = 0;
  assert.deepEqual(await check(spy, tenantRef, cache, 11 * 60 * 1000), { ok: true });
  assert.equal(spy.seen.hashed, 0, 'a page load at 11 minutes needs no full walk');
});

test('page loads that find no verified records share one full walk', async () => {
  const tenantRef = 'cached-shared';
  const cache = new Map();
  await append(tenantRef, 5);
  const other = await database.connect();
  try {
    const seen = { hashed: 0 };
    const spyOn = (target) => ({ async query(text, values) {
      const result = await target.query(text, values);
      if (/SELECT seq, tenant_ref, occurred_at/.test(text)) seen.hashed += result.rows.length;
      return result;
    } });
    const results = await Promise.all([client, other].map(async (connection) => {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try { return await verifyChainCached(spyOn(connection), { tenantRef, cache, now: 0 }); } finally { await connection.query('COMMIT'); }
    }));
    assert.deepEqual(results, [{ ok: true }, { ok: true }]);
    assert.equal(seen.hashed, 5, 'the record was walked once, not twice');
  } finally {
    await other.end();
  }
});

test('a check that started before a break never writes an "ok" back', async () => {
  const tenantRef = 'cached-stale-write';
  const cache = new Map();
  await append(tenantRef, 4);
  await check(client, tenantRef, cache);
  await append(tenantRef, 1);

  const slow = await database.connect();
  const breaker = await database.connect();
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let reached;
    const paused = new Promise((resolve) => { reached = resolve; });
    const gated = { async query(text, values) {
      const result = await slow.query(text, values);
      if (/SELECT seq, tenant_ref, occurred_at/.test(text)) { reached(); await gate; }
      return result;
    } };
    await slow.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const staleCheck = verifyChainCached(gated, { tenantRef, cache, now: 0 });
    await paused;

    const { rows } = await client.query('SELECT seq FROM evidence WHERE tenant_ref = $1 ORDER BY seq', [tenantRef]);
    await client.query(`UPDATE evidence SET subject = '{"index": 99}' WHERE seq = $1`, [rows[0].seq]);
    await breaker.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal((await verifyChainCached(breaker, { tenantRef, cache, now: 0 })).ok, false);
    await breaker.query('COMMIT');

    release();
    assert.deepEqual(await staleCheck, { ok: true }, 'its own snapshot predates the change');
    await slow.query('COMMIT');
    assert.equal(cache.has(tenantRef), false, 'but it does not put the broken record back in the cache');
  } finally {
    await slow.end();
    await breaker.end();
  }
});
