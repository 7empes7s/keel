/** Ask answers month-long and whole-service change questions within the query budget.
 *
 * Live check K5 (2026-10-27) found four questions always cancelled by the 5 s statement
 * timeout: each listed change looked up the last complete backup of its kind by reading
 * every earlier backup's coverage digest. This builds a month of hourly backups with a
 * digest for every kind, plus enough changes to fill a page, and asks those questions
 * under the real budget. Without snapshot_complete_time_idx (schema.d/76), three of them
 * are cancelled here and the fourth takes over half the budget.
 *
 * Every time is fixed (NOW below and backups placed relative to it), so the result does
 * not depend on the day the test runs.
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { answerQuestion } from './execute.mjs';
import { BUDGET } from './intent.mjs';

const NOW = new Date('2026-10-27T15:30:00Z');
const TENANT = 'sha256:00000000a5c5beed';
const DAYS = 27;
const CHANGES_PER_BACKUP = 4;
// Half the budget: a slow runner still passes, a regression to a per-row scan does not.
const LIMIT_MS = Math.floor(BUDGET.statementTimeoutMs / 2);

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

before(async () => {
  client = await database.connect();
  await client.query(schemaSql());
  const kinds = DESCRIPTORS.map(({ type }, index) => ({ type, daily: index % 3 === 0 }));
  const { rows: [baseline] } = await client.query(
    `INSERT INTO baseline (tenant_ref, set_by) VALUES ($1, 'fixture') RETURNING id`, [TENANT]);
  // Hourly backups for the month up to NOW; a third of the kinds are read once a day,
  // as users are, so their windows reach back to midnight.
  await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
     SELECT $1, 'complete', t - interval '5 minutes', t,
            (SELECT jsonb_object_agg(k.type, jsonb_build_object(
                      'outcome', CASE WHEN k.daily AND extract(hour FROM t AT TIME ZONE 'UTC') <> 0 THEN 'not-requested' ELSE 'complete' END,
                      'itemCount', 12, 'httpStatus', 200, 'requests', 1, 'path', '/beta/fixture/' || k.type))
               FROM jsonb_to_recordset($3::jsonb) AS k(type text, daily boolean))
       FROM generate_series($2::timestamptz - make_interval(days => ${DAYS}), $2::timestamptz, interval '1 hour') t`,
    [TENANT, new Date(Math.floor(NOW.getTime() / 3_600_000) * 3_600_000 - 3_600_000), JSON.stringify(kinds)],
  );
  // Each backup sees a few changes to different resources, spread over every kind.
  await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
                        before_hash, after_hash, before_payload, after_payload, blast_radius, detected_at)
     SELECT s.tenant_ref, $2, s.id, k.type || ':KEEL-RT-' || s.n || '-' || g, k.type, 'modified', 'a', 'b',
            jsonb_build_object('displayName', 'KEEL-RT-' || s.n, 'state', 'enabled', 'note', repeat('x', 200)),
            jsonb_build_object('displayName', 'KEEL-RT-' || s.n, 'state', 'disabled', 'note', repeat('x', 200)),
            'low', s.completed_at + interval '2 minutes'
       FROM (SELECT id, tenant_ref, completed_at, row_number() OVER (ORDER BY completed_at) AS n FROM snapshot WHERE tenant_ref = $1) s
      CROSS JOIN generate_series(1, $3::int) g
       JOIN (SELECT type, ordinality - 1 AS i FROM jsonb_array_elements_text($4::jsonb) WITH ORDINALITY AS e(type, ordinality)) k
         ON k.i = (s.n * $3 + g) % $5`,
    [TENANT, baseline.id, CHANGES_PER_BACKUP, JSON.stringify(kinds.map(({ type }) => type)), kinds.length],
  );
  await client.query('ANALYZE snapshot; ANALYZE drift');
});

after(async () => {
  await client?.end();
  await database.cleanup();
});

for (const question of [
  'What changed since the beginning of the month?',
  'What changed since 17/10?',
  'What changed in Azure AD this month?',
  'Which admins changed this month?',
]) {
  test(`answers "${question}" well within the query budget`, async () => {
    const started = performance.now();
    const answer = await answerQuestion(client, { tenantRef: TENANT, scope: { central: true, entities: [] }, question, now: NOW });
    const elapsed = performance.now() - started;
    assert.ok(answer.total > 0, `the fixture has changes for "${question}"`);
    assert.ok(answer.records.length > 0);
    assert.ok(elapsed < LIMIT_MS, `"${question}" took ${Math.round(elapsed)} ms (limit ${LIMIT_MS} ms)`);
    // Each listed change opens at an earlier complete backup of its kind, never at the sighting.
    for (const record of answer.records) {
      assert.ok(record.window.from, `${record.naturalKey} has a window start`);
      assert.ok(record.window.from < record.window.to, `${record.naturalKey} window is not zero-width`);
    }
  });
}

test('a kind read once a day opens its window at that day\'s read, not the hour before', async () => {
  const daily = DESCRIPTORS.filter((_, index) => index % 3 === 0).map(({ type }) => type);
  const answer = await answerQuestion(client, {
    tenantRef: TENANT, scope: { central: true, entities: [] }, now: NOW,
    question: 'What changed since the beginning of the month?',
  });
  const record = answer.records.find((entry) => daily.includes(entry.resourceType) && !entry.window.to.endsWith('T00:00:00.000Z'));
  assert.ok(record, 'the page lists a change to a daily kind seen after midnight');
  assert.equal(record.window.from.slice(11), '00:00:00.000Z');
  assert.equal(record.window.from.slice(0, 10), record.window.to.slice(0, 10));
});
