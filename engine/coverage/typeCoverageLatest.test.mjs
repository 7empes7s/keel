/**
 * The per-type "latest coverage" table (store/schema.d/83-type-coverage-latest.sql)
 * must always equal what the old query computed by expanding every complete
 * backup's digest. Each test changes snapshots the way a real writer would and
 * then compares the two; a timing test checks the read no longer grows with
 * the number of backups.
 */
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, test } from 'node:test';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { completeSnapshot, createSnapshot } from '../store/db.mjs';
import { TYPE_COVERAGE_CTES } from './snapshots.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

before(async () => {
  client = await database.connect();
  await client.query(schemaSql());
});

after(async () => {
  await client?.end();
  await database.cleanup();
});

beforeEach(async () => {
  await client.query('DELETE FROM snapshot');
});

// The query TYPE_COVERAGE_CTES ran before this table existed.
const FULL_SCAN = `
  SELECT DISTINCT ON (entry.key)
    entry.key AS resource_type, entry.value AS coverage_entry,
    s.id AS snapshot_id, s.started_at, s.completed_at
  FROM snapshot s
  CROSS JOIN LATERAL jsonb_each(COALESCE(s.coverage_digest, '{}'::jsonb)) entry
  WHERE s.tenant_ref = $1 AND s.status = 'complete' AND s.completed_at IS NOT NULL
    AND entry.value ->> 'outcome' IS DISTINCT FROM 'not-requested'
  ORDER BY entry.key, s.completed_at DESC, s.started_at DESC, s.id DESC`;

const FROM_TABLE = `WITH ${TYPE_COVERAGE_CTES}
  SELECT resource_type, coverage_entry, snapshot_id, started_at, completed_at
  FROM latest_type_coverage ORDER BY resource_type`;

async function assertMatchesFullScan(tenantRef = 'tenant-a') {
  const expected = (await client.query(FULL_SCAN, [tenantRef])).rows;
  const actual = (await client.query(FROM_TABLE, [tenantRef])).rows;
  assert.deepEqual(actual, expected);
  return actual;
}

const HOUR = 3600 * 1000;
const BASE = Date.now() - 1000 * HOUR;
const at = (hours) => new Date(BASE + hours * HOUR);

async function snapshot({ tenantRef = 'tenant-a', hour, digest, status = 'complete', completed = true }) {
  const { rows: [row] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantRef, at(hour - 0.1), completed ? at(hour) : null, status, digest],
  );
  return row.id;
}

const ok = (itemCount) => ({ outcome: 'complete', itemCount });

test('newest mention wins, a later failure shadows an older success, not-requested never shadows', async () => {
  await snapshot({ hour: 1, digest: { user: ok(3), group: ok(2), policy: ok(1) } });
  await snapshot({ hour: 2, digest: { user: { outcome: 'failed', error: 'x' }, group: { outcome: 'not-requested' } } });
  await snapshot({ hour: 3, digest: { group: { outcome: 'not-requested' } } });
  const rows = await assertMatchesFullScan();
  const byType = Object.fromEntries(rows.map((row) => [row.resource_type, row.coverage_entry]));
  assert.equal(byType.user.outcome, 'failed');
  assert.equal(byType.group.outcome, 'complete');
  assert.equal(byType.policy.outcome, 'complete');
});

test('running, failed and unfinished snapshots never count; completing one through the store does', async () => {
  await snapshot({ hour: 1, digest: { user: ok(1) } });
  await snapshot({ hour: 2, digest: { user: ok(9) }, status: 'failed' });
  await snapshot({ hour: 3, digest: { user: ok(8) }, completed: false });
  assert.equal((await assertMatchesFullScan())[0].coverage_entry.itemCount, 1);

  const id = await createSnapshot(client, { tenantRef: 'tenant-a' });
  await completeSnapshot(client, { id, status: 'complete', coverageDigest: { user: ok(5), legacy: 4, nothing: null } });
  const rows = await assertMatchesFullScan();
  assert.equal(rows.find((row) => row.resource_type === 'user').coverage_entry.itemCount, 5);
  assert.deepEqual(rows.map((row) => row.resource_type), ['legacy', 'nothing', 'user']);
});

test('deleting the newest backup (prune) falls back to the next newest mention', async () => {
  await snapshot({ hour: 1, digest: { user: ok(1), group: ok(1) } });
  const newest = await snapshot({ hour: 2, digest: { user: ok(2) } });
  await client.query('DELETE FROM snapshot WHERE id = ANY($1::uuid[])', [[newest]]);
  const rows = await assertMatchesFullScan();
  assert.equal(rows.find((row) => row.resource_type === 'user').coverage_entry.itemCount, 1);
  await client.query('DELETE FROM snapshot');
  assert.deepEqual(await assertMatchesFullScan(), []);
});

test('updates to a stored snapshot are followed: status, digest, times and tenant', async () => {
  await snapshot({ hour: 1, digest: { user: ok(1) } });
  const id = await snapshot({ hour: 2, digest: { user: ok(2), group: ok(2) } });
  await client.query(`UPDATE snapshot SET coverage_digest = $2 WHERE id = $1`, [id, { user: { outcome: 'not-requested' } }]);
  await assertMatchesFullScan();
  await client.query(`UPDATE snapshot SET coverage_digest = $2 WHERE id = $1`, [id, { user: ok(7) }]);
  await assertMatchesFullScan();
  await client.query(`UPDATE snapshot SET completed_at = $2 WHERE id = $1`, [id, at(0.5)]);
  await assertMatchesFullScan();
  await client.query(`UPDATE snapshot SET status = 'failed' WHERE id = $1`, [id]);
  await assertMatchesFullScan();
  await client.query(`UPDATE snapshot SET status = 'complete', tenant_ref = 'tenant-b' WHERE id = $1`, [id]);
  await assertMatchesFullScan('tenant-a');
  await assertMatchesFullScan('tenant-b');
});

test('ties on completion time break by start time, then id, exactly like the full scan', async () => {
  const sameEnd = at(5);
  for (const startHour of [4.5, 4.5, 4.9, 4.2]) {
    await client.query(
      `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest) VALUES ('tenant-a', $1, $2, 'complete', $3)`,
      [at(startHour), sameEnd, { user: ok(Math.round(startHour * 10)) }],
    );
  }
  assert.equal((await assertMatchesFullScan())[0].coverage_entry.itemCount, 49);
});

test('tenants never see each other', async () => {
  await snapshot({ tenantRef: 'tenant-a', hour: 1, digest: { user: ok(1) } });
  await snapshot({ tenantRef: 'tenant-b', hour: 2, digest: { user: ok(2), group: ok(2) } });
  assert.equal((await assertMatchesFullScan('tenant-a')).length, 1);
  assert.equal((await assertMatchesFullScan('tenant-b')).length, 2);
});

test('a random mix of writes, updates and deletes always matches the full scan', async () => {
  let seed = 7;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const types = ['user', 'group', 'policy', 'role', 'site'];
  const outcomes = ['complete', 'complete-empty', 'failed', 'partial', 'not-requested'];
  const ids = [];
  for (let step = 0; step < 150; step += 1) {
    const action = random();
    if (action < 0.6 || ids.length === 0) {
      const digest = {};
      for (const type of types) if (random() < 0.6) digest[type] = { outcome: pick(outcomes), itemCount: step };
      ids.push(await snapshot({
        tenantRef: pick(['tenant-a', 'tenant-b']), hour: Math.floor(random() * 40), digest,
        status: random() < 0.85 ? 'complete' : 'failed',
      }));
    } else if (action < 0.8) {
      const id = ids.splice(Math.floor(random() * ids.length), 1)[0];
      await client.query('DELETE FROM snapshot WHERE id = $1', [id]);
    } else {
      await client.query(`UPDATE snapshot SET completed_at = $2, status = $3 WHERE id = $1`,
        [pick(ids), at(Math.floor(random() * 40)), random() < 0.8 ? 'complete' : 'failed']);
    }
    await assertMatchesFullScan('tenant-a');
    await assertMatchesFullScan('tenant-b');
  }
});

test('truncating snapshots empties the table; re-applying the schema fills an empty table from existing backups', async () => {
  await snapshot({ hour: 1, digest: { user: ok(1) } });
  await client.query('TRUNCATE snapshot CASCADE');
  assert.deepEqual(await assertMatchesFullScan(), []);

  await snapshot({ hour: 1, digest: { user: ok(1), group: ok(1) } });
  await snapshot({ hour: 2, digest: { user: ok(2) } });
  // A database that had backups before this table existed.
  await client.query('DELETE FROM type_coverage_latest');
  assert.equal((await client.query(FROM_TABLE, ['tenant-a'])).rows.length, 0);
  await client.query(schemaSql());
  assert.equal((await assertMatchesFullScan()).length, 2);
});

test('a recovery dump re-inserting rows the triggers already made keeps the newest and does not fail', async () => {
  await snapshot({ hour: 1, digest: { user: ok(1) } });
  const newest = await snapshot({ hour: 2, digest: { user: ok(2) } });
  const { rows } = await client.query(`SELECT * FROM type_coverage_latest WHERE tenant_ref = 'tenant-a' AND snapshot_id IS NOT NULL`);
  assert.deepEqual(rows.map((row) => row.resource_type), ['user']);
  const older = (await client.query(`SELECT id, started_at, completed_at FROM snapshot WHERE id <> $1`, [newest])).rows[0];
  // The same rows again (a dump's COPY block), plus an older candidate.
  for (const row of [...rows, { ...rows[0], snapshot_id: older.id, started_at: older.started_at, completed_at: older.completed_at, coverage_entry: ok(1) }]) {
    await client.query(
      `INSERT INTO type_coverage_latest (tenant_ref, resource_type, coverage_entry, snapshot_id, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.tenant_ref, row.resource_type, row.coverage_entry, row.snapshot_id, row.started_at, row.completed_at],
    );
  }
  assert.equal((await assertMatchesFullScan())[0].snapshot_id, newest);
});

test('a newer backup finishing while the newest one is being deleted is not lost', async () => {
  await snapshot({ hour: 1, digest: { user: ok(1) } });
  const newest = await snapshot({ hour: 2, digest: { user: ok(2) } });
  const other = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM snapshot WHERE id = $1', [newest]);
    // A second session writes a newer backup while the delete is uncommitted.
    const writing = other.query(
      `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
       VALUES ('tenant-a', $1, $2, 'complete', $3) RETURNING id`,
      [at(2.9), at(3), { user: ok(3) }],
    );
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    await client.query('COMMIT');
    const { rows: [{ id }] } = await writing;
    assert.equal((await assertMatchesFullScan())[0].snapshot_id, id);
  } finally {
    await other.end();
  }
});

test('reading latest coverage does not grow with the number of backups', async () => {
  // 2,000 hourly backups of 200 types; most hourly runs read only tier-1 types.
  // Written newest first in one statement: oldest first would make the trigger
  // rewrite every row 2,000 times inside one transaction, which is slow for a
  // test but not what happens live (one backup per transaction).
  await client.query(`
    INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
    SELECT 'tenant-a', $1::timestamptz - (g || ' hours')::interval, $1::timestamptz - (g || ' hours')::interval + interval '5 minutes', 'complete',
      (SELECT jsonb_object_agg('type' || t, jsonb_build_object(
         'outcome', CASE WHEN g % 24 <> 0 AND t > 40 THEN 'not-requested' ELSE 'complete' END, 'itemCount', t))
       FROM generate_series(1, 200) t)
    FROM generate_series(1, 2000) g`, [at(0)]);
  await client.query('ANALYZE');
  const rows = await assertMatchesFullScan();
  assert.equal(rows.length, 200);
  const median = async (sql) => {
    const timings = [];
    for (let run = 0; run < 5; run += 1) {
      const started = process.hrtime.bigint();
      await client.query(sql, ['tenant-a']);
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    return timings.sort((x, y) => x - y)[2];
  };
  const fullScan = await median(FULL_SCAN);
  const table = await median(FROM_TABLE);
  // Locally the full scan takes ~190 ms and the table read ~2 ms. Comparing the
  // two on the same runner keeps a slow machine from failing the test, while a
  // return of the scan (ratio near 1) still fails it.
  assert.ok(table * 10 < fullScan, `table ${table.toFixed(1)} ms vs full scan ${fullScan.toFixed(1)} ms`);
});
