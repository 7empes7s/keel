// keel-scheduler (#1010): a tick that can't reach the database is recorded as "database
// unreachable", not a generic failure, and the gap reaches the audit record (and so the
// Activity page) on the first tick that reaches it again. The refused connection is a
// closed local port, the shape the live outage had (`connect ECONNREFUSED`, #1005).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { schemaSql } from '../engine/store/loadSchema.mjs';
import { OUTAGE_FILE } from '../engine/schedules/outage.mjs';
import { runOnce, schedulerPrincipal } from './keel-scheduler.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
await client.query(schemaSql());
const REFUSED = 'postgres://keel@127.0.0.1:1/keel';
const quiet = { log: () => {}, error: () => {} };
// Relative to the run, so the "late" count never depends on the day the test runs.
const start = new Date(Date.now() - 3 * 3600_000);
const at = (minutes) => () => new Date(start.valueOf() + minutes * 60_000);

test.after(async () => { await client.end(); await database.cleanup(); });

test('refused ticks are noted as database unreachable, then written to the audit record once it answers', async () => {
  const stateDir = join(mkdtempSync(join(tmpdir(), 'keel-scheduler-outage-')), 'state');
  await client.query(`INSERT INTO schedule (tenant_ref, job_kind, tier, cadence, next_due_at)
    VALUES ('fixture', 'collect', 'tier1', '{"every":"hour","n":1,"atTime":null}', $1)`, [at(10)()]);

  const errors = [];
  const first = await runOnce({ dbUrl: REFUSED, stateDir, now: at(0), logger: { log: () => {}, error: (line) => errors.push(line) } });
  assert.deepEqual(first, { unreachable: 'ECONNREFUSED' });
  assert.match(errors[0], /^scheduler: database unreachable \(ECONNREFUSED\); no schedules checked/);
  await runOnce({ dbUrl: REFUSED, stateDir, now: at(5), logger: quiet });
  const noted = JSON.parse(readFileSync(join(stateDir, OUTAGE_FILE), 'utf8'));
  assert.deepEqual(noted, { since: at(0)().toISOString(), lastAt: at(5)().toISOString(), reason: 'ECONNREFUSED', missedTicks: 2 });

  const healed = await runOnce({ dbUrl: database.url, stateDir, now: at(60), logger: quiet });
  assert.deepEqual(healed, { unreachable: null });
  assert.equal(existsSync(join(stateDir, OUTAGE_FILE)), false);
  const { rows } = await client.query(`SELECT tenant_ref, actor, subject FROM evidence WHERE kind = 'scheduler.database-unreachable'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_ref, 'fixture');
  assert.equal(rows[0].actor, (await schedulerPrincipal(client)).id);
  assert.deepEqual(rows[0].subject, {
    since: at(0)().toISOString(), until: at(60)().toISOString(), reason: 'ECONNREFUSED', missedTicks: 2, lateSchedules: 1,
  });
  // The late schedule still ran on the tick that reached the database.
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM job WHERE kind = 'collect'`)).rows[0].n, 1);

  await runOnce({ dbUrl: database.url, stateDir, now: at(65), logger: quiet });
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM evidence WHERE kind = 'scheduler.database-unreachable'`)).rows[0].n, 1);
});

test('any other failure is not called database unreachable and leaves no gap behind', async () => {
  const stateDir = join(mkdtempSync(join(tmpdir(), 'keel-scheduler-outage-')), 'state');
  const broken = async () => { throw new Error('relation "schedule" does not exist'); };
  await assert.rejects(() => runOnce({ dbUrl: database.url, stateDir, connectFn: broken, logger: quiet }), /does not exist/);
  assert.equal(existsSync(join(stateDir, OUTAGE_FILE)), false);
});
