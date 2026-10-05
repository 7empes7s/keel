import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { seedSchedules } from '../engine/store/scheduleSeed.mjs';
import { complete, fail } from '../engine/jobs/queue.mjs';
import { processCollectionCompletions } from '../engine/schedules/completions.mjs';
import { schedulerPrincipal } from './keel-scheduler.mjs';
import { preflight, runNow, health, cancel, TIERS } from './keel-schedules-host.mjs';

const TENANT = 'sha256:00000000000000aa';
const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
try {
  await client.query(await readFile(new URL('../engine/store/schema.sql', import.meta.url), 'utf8'));

  await test('preflight passes on an empty store and blocks on a job backlog or another tenant', async () => {
    assert.equal((await preflight(client, { tenantRef: TENANT })).ok, true);

    await client.query(`INSERT INTO job (kind, requested_by) VALUES ('restore', 'operator')`);
    const backlog = await preflight(client, { tenantRef: TENANT });
    assert.equal(backlog.ok, false);
    assert.deepEqual(backlog.backlog.map(({ kind, status, count }) => [kind, status, count]), [['restore', 'queued', 1]]);
    await client.query('DELETE FROM job');

    await seedSchedules(client, { tenantRef: 'sha256:00000000000000bb', jobKinds: ['collect'] });
    const other = await preflight(client, { tenantRef: TENANT });
    assert.deepEqual(other.blockers, ['enabled schedules exist for another tenant']);
    await client.query('DELETE FROM schedule');
  });

  await test('cancel withdraws a queued job with its reason and leaves running ones alone', async () => {
    const { rows: [queued] } = await client.query(`INSERT INTO job (kind, requested_by) VALUES ('restore', 'operator') RETURNING id`);
    const { rows: [running] } = await client.query(`INSERT INTO job (kind, requested_by, status) VALUES ('backup', 'operator', 'running') RETURNING id`);
    await assert.rejects(cancel(client, { jobId: queued.id, reason: ' ' }), /reason is required/);
    assert.deepEqual(await cancel(client, { jobId: queued.id, reason: 'stale before worker install' }),
      { jobId: queued.id, kind: 'restore', status: 'cancelled', ok: true });
    const { rows: [row] } = await client.query('SELECT status, error, finished_at FROM job WHERE id = $1', [queued.id]);
    assert.equal(row.error, 'cancelled: stale before worker install');
    assert.ok(row.finished_at);
    assert.deepEqual(await cancel(client, { jobId: queued.id, reason: 'again' }),
      { jobId: queued.id, kind: 'restore', status: 'cancelled', ok: false });
    assert.deepEqual(await cancel(client, { jobId: running.id, reason: 'no' }),
      { jobId: running.id, kind: 'backup', status: 'running', ok: false });
    const after = await preflight(client, { tenantRef: TENANT });
    assert.deepEqual(after.backlog.map(({ kind, status }) => [kind, status]), [['backup', 'running']]);
    await client.query('DELETE FROM job');
  });

  await test('run-now enqueues one collect job per tier, once per day', async () => {
    const now = new Date('2026-10-05T10:00:00Z');
    const first = await runNow(client, { tenantRef: TENANT, now });
    const again = await runNow(client, { tenantRef: TENANT, now });
    assert.deepEqual(first.jobs.map((job) => job.tier), TIERS);
    assert.deepEqual(again.jobs.map((job) => job.jobId), first.jobs.map((job) => job.jobId));
    const { rows } = await client.query(`SELECT params, requested_by FROM job WHERE kind = 'collect' ORDER BY params->>'tier'`);
    const principal = await schedulerPrincipal(client);
    assert.deepEqual(rows.map((row) => row.params), TIERS.map((tier) => ({ tier, tenantRef: TENANT })));
    assert.ok(rows.every((row) => row.requested_by === principal.id));
  });

  await test('health passes only for a scheduled tier whose last run succeeded with full coverage', async () => {
    const now = new Date();
    await seedSchedules(client, { tenantRef: TENANT, now, jobKinds: ['collect'] });
    const { rows: jobs } = await client.query(`SELECT * FROM job WHERE kind = 'collect' ORDER BY params->>'tier'`);
    const outcomes = { tier1: 'complete', tier2: 'partial' };
    for (const job of jobs) {
      const tier = job.params.tier;
      if (!outcomes[tier]) continue; // tier3 never ran
      const { rows: [snapshot] } = await client.query(
        `INSERT INTO snapshot (tenant_ref, status, completed_at, coverage_digest)
         VALUES ($1, 'complete', now(), $2) RETURNING id`,
        [TENANT, { user: { outcome: outcomes[tier] }, group: { outcome: 'not-requested' } }],
      );
      await client.query(`UPDATE job SET status = 'running', started_at = now() WHERE id = $1`, [job.id]);
      if (outcomes[tier] === 'complete') await complete(client, { id: job.id, result: { snapshotId: snapshot.id } });
      else await fail(client, { id: job.id, error: `snapshot ${snapshot.id} complete\ncoverage failed` });
    }
    await processCollectionCompletions(client, (await schedulerPrincipal(client)).id);

    const report = await health(client, { tenantRef: TENANT, now });
    assert.equal(report.ok, false);
    const [tier1, tier2, tier3] = report.tiers;
    assert.equal(tier1.ok, true);
    assert.deepEqual(tier2.checks, { scheduled: true, lastRunSucceeded: false, fullCoverage: false, driftQueued: false });
    assert.deepEqual(tier2.failedTypes, ['user: partial']);
    assert.equal(tier3.lastJob, null);
    assert.equal(tier3.checks.scheduled, true);

    await client.query(`UPDATE schedule SET enabled = false WHERE tier = 'tier1'`);
    assert.equal((await health(client, { tenantRef: TENANT, now })).tiers[0].checks.scheduled, false);
  });
} finally {
  await client.end();
  await database.cleanup();
}
