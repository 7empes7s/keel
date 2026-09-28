import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { initialSchedules, seedSchedules } from './scheduleSeed.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
try {
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await client.query(schema);
  await client.query(schema); // schema re-application must preserve existing tables
  // Exercise the actual index independently of the seed's ON CONFLICT inference.
  for (const kind of ['prune', 'drift-detect', 'offsite']) {
    const insert = () => client.query(
      `INSERT INTO schedule (tenant_ref, job_kind, tier, cadence, next_due_at)
       VALUES ('duplicate-test', $1, NULL, '{}', now() + interval '1 day')`, [kind],
    );
    await insert();
    await assert.rejects(insert, { code: '23505' }, `${kind} duplicate null tier must be rejected`);
  }
  const { rows: jobs } = await client.query(
    "INSERT INTO job (kind, requested_by) VALUES ('offsite', 'schema-test') RETURNING kind",
  );
  assert.equal(jobs[0].kind, 'offsite');
  const now = new Date();
  await seedSchedules(client, { tenantRef: 'seed-test', now });
  const { rows } = await client.query('SELECT * FROM schedule WHERE tenant_ref = $1 ORDER BY job_kind, tier', ['seed-test']);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((row) => [row.job_kind, row.tier]), [
    ['api-drift', null], ['collect', 'tier1'], ['collect', 'tier2'], ['collect', 'tier3'], ['offsite', null], ['prune', null],
  ]);
  for (const row of rows) assert.ok(row.next_due_at > now);
  await seedSchedules(client, { tenantRef: 'seed-test', now: new Date(now.valueOf() + 86400000) });
  assert.deepEqual((await client.query('SELECT * FROM schedule WHERE tenant_ref = $1 ORDER BY job_kind, tier', ['seed-test'])).rows, rows);
  const boundary = initialSchedules(new Date('2026-09-14T00:00:00Z'));
  assert.deepEqual(boundary.map((row) => row.nextDueAt.toISOString()), [
    '2026-09-14T01:00:00.000Z', '2026-09-15T00:00:00.000Z', '2026-09-21T00:00:00.000Z',
    '2026-09-15T00:00:00.000Z', '2026-09-14T05:00:00.000Z', '2026-09-21T03:00:00.000Z',
  ]);
  assert.deepEqual(boundary.map((row) => row.cadence), [
    { every: 'hour', n: 1, atTime: null }, { every: 'day', n: 1, atTime: '00:00' },
    { every: 'week', n: 1, atTime: '00:00' }, { every: 'day', n: 1, atTime: '00:00' },
    { every: 'day', n: 1, atTime: '05:00' }, { every: 'week', n: 1, atTime: '03:00' },
  ]);
  assert.equal(boundary[2].cronOverride, '0 0 * * 1');
  assert.equal(boundary[5].cronOverride, '0 3 * * 1');
  assert.equal(initialSchedules(new Date('2026-09-20T23:59:59Z'))[2].nextDueAt.toISOString(), '2026-09-21T00:00:00.000Z');
  assert.equal(initialSchedules(new Date('2026-09-14T05:00:00Z'))[4].nextDueAt.toISOString(), '2026-09-15T05:00:00.000Z');
  console.log('schedule.test.mjs — all assertions passed (six future seed rows incl. weekly api-drift, duplicate NULL tiers rejected, offsite CHECK accepted)');
} finally {
  await client.end();
  await database.cleanup();
}
