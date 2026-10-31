import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { FAILED_RESTORE_RECENT_DAYS, FAILED_RESTORES_HREF, countFailedRestores, listFailedRestores } from './failedRestores.mjs';

// Every time is set from NOW and NOW is passed in, so nothing depends on the wall clock.
const NOW = new Date('2026-10-31T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY).toISOString();
const TENANT = 'sha256:failed-restores';
const OTHER = 'sha256:failed-restores-other';

let database;
let client;

before(async () => {
  database = await createIsolatedTestDatabase(import.meta.url);
  client = await database.connect();
  await client.query(schemaSql());
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

async function plan(tenantRef) {
  const { rows: [snapshot] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status) VALUES ($1, $2, $2, 'complete') RETURNING id`,
    [tenantRef, daysAgo(100)],
  );
  const { rows: [row] } = await client.query(
    `INSERT INTO restore_dry_run (tenant_ref, snapshot_id, selection, closure_keys, target_tenant_id, collector_config_path,
       target_config_path, waves, patches, results, current_state_fingerprint, digest, status, requested_by)
     VALUES ($1, $2, '[]', '[]', 'fixture', '/c', '/t', '[]', '[]', '[]', 'f', 'd', 'completed', 'operator') RETURNING id`,
    [tenantRef, snapshot.id],
  );
  return row.id;
}

async function job({ tenantRef = TENANT, status = 'failed', finishedAt, params }) {
  const planId = await plan(tenantRef);
  const { rows: [row] } = await client.query(
    `INSERT INTO job (kind, params, status, requested_by, created_at, started_at, finished_at)
     VALUES ('restore', $1, $2, 'operator', $3, $3, $3) RETURNING id`,
    [params ? params(planId) : { artifactId: planId, mode: 'enforce' }, status, finishedAt],
  );
  return row.id;
}

test('counts failed enforced restores of this tenant, in all and in the last 30 days', async () => {
  // More failed restores than the Restore page's 25-row list holds.
  const failed = [];
  for (let index = 0; index < 28; index += 1) failed.push(await job({ finishedAt: daysAgo(index < 20 ? 1 + index : 40 + index) }));
  // A legacy enforced job (params hold only the plan) counts.
  failed.push(await job({ finishedAt: daysAgo(2.5), params: (planId) => ({ artifactId: planId }) }));
  // None of these is a failed restore.
  await job({ status: 'cancelled', finishedAt: daysAgo(1) });
  await job({ status: 'succeeded', finishedAt: daysAgo(1) });
  await job({ finishedAt: daysAgo(1), params: (planId) => ({ artifactId: planId, mode: 'dry-run' }) });
  await job({ tenantRef: OTHER, finishedAt: daysAgo(1) });
  // Finished after "now": not counted yet.
  await job({ finishedAt: new Date(NOW.getTime() + DAY).toISOString() });

  const counts = await countFailedRestores(client, { tenantRef: TENANT, now: NOW });
  assert.equal(counts.total, 29);
  assert.deepEqual(counts.recent, { days: FAILED_RESTORE_RECENT_DAYS, count: 21 });
  assert.equal(counts.period, null);
  assert.equal(counts.href, FAILED_RESTORES_HREF);
  assert.equal(counts.newest.jobId, failed[0]);
  assert.equal(counts.newest.at, daysAgo(1));

  // A report period counts the jobs that finished inside it.
  const period = await countFailedRestores(client, { tenantRef: TENANT, now: NOW, from: daysAgo(10), to: daysAgo(2) });
  assert.equal(period.period.count, 9);
  assert.equal(period.total, 29);

  // The list uses the same rule: newest first, capped, and never another tenant's job.
  const listed = await listFailedRestores(client, { tenantRef: TENANT, now: NOW, limit: 25 });
  assert.equal(listed.length, 25);
  assert.equal(listed[0].id, failed[0]);
  assert.ok(listed.every((row) => row.status === 'failed' && row.kind === 'restore'));
  const all = await listFailedRestores(client, { tenantRef: TENANT, now: NOW, limit: 100 });
  assert.equal(all.length, counts.total);
});

test('refuses a raw tenant id', async () => {
  await assert.rejects(() => countFailedRestores(client, { tenantRef: 'contoso.onmicrosoft.com' }), TypeError);
});
