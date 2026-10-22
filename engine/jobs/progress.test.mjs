// Job page: service (workload) and content backups report each workload live onto their
// running job, as settings backups do: waiting, then reading, then the outcome with a
// count, timing and a short error. Nothing is written without a job id, and a failed
// write never changes the run.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { progressTracker, progressWriter, reasonsLine } from './progress.mjs';
import { runWorkloadCollection } from '../../cli/keel-workload-collect.mjs';
import { runContentCollection } from '../../cli/keel-content-collect.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) { await client.query(schemaSql()); schemaReady = true; }
  return client;
}

const silent = { log() {} };
let tick = Date.parse('2026-10-22T02:00:00Z');
const clock = () => new Date((tick += 1000));

async function runningJob(client, kind) {
  const { rows } = await client.query(
    `INSERT INTO job (kind, status, requested_by, started_at) VALUES ($1, 'running', 'KEEL-RT-tester', now()) RETURNING id`, [kind],
  );
  return rows[0].id;
}

/** A writer that stores on the job and keeps each report, to check the order of states. */
function recordingWriter(client, jobId, reports) {
  const write = progressWriter(client, jobId);
  return async (types) => { reports.push(structuredClone(types)); await write(types); };
}

test('a content backup reports each workload as waiting, reading, then its outcome on its job', async (t) => {
  const client = await schemaClient(t);
  const jobId = await runningJob(client, 'content-collect');
  const reports = [];
  const collectors = [
    { workload: 'teams', collect: async () => ({ outcome: 'succeeded', items: 4, bytes: 10, reasons: [] }) },
    { workload: 'planner', collect: async () => { throw new Error('HTTP 403 Forbidden'); } },
    { workload: 'onedrive', collect: async () => ({ outcome: 'skipped', items: 0, bytes: 0, reasons: ['no licence'] }) },
  ];
  const result = await runContentCollection(client, {
    tenantRef: 'sha256:KEEL-RT-progress', store: {}, transport: null, collectors, now: clock, logger: silent,
    onProgress: recordingWriter(client, jobId, reports),
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(Object.keys(reports[0]), ['content:teams', 'content:planner', 'content:onedrive']);
  assert.ok(Object.values(reports[0]).every((entry) => entry.outcome === 'waiting'));
  assert.equal(reports[1]['content:teams'].outcome, 'reading');
  assert.equal(reports[1]['content:planner'].outcome, 'waiting');
  const { rows: [job] } = await client.query('SELECT progress FROM job WHERE id = $1', [jobId]);
  const types = job.progress.types;
  assert.equal(types['content:teams'].outcome, 'complete');
  assert.equal(types['content:teams'].itemCount, 4);
  assert.equal(types['content:planner'].outcome, 'failed');
  assert.match(types['content:planner'].error, /403/);
  assert.equal(types['content:onedrive'].outcome, 'unavailable');
  for (const entry of Object.values(types)) {
    assert.ok(Date.parse(entry.startedAt) <= Date.parse(entry.completedAt));
  }
  assert.ok(!Number.isNaN(Date.parse(job.progress.updatedAt)));
});

test('a service backup reports each workload with the settings it stored', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = `sha256:KEEL-RT-${crypto.randomUUID()}`;
  const jobId = await runningJob(client, 'workload-collect');
  const reports = [];
  const store = async (workload, outcome, settings, reasons = []) => {
    const at = clock().toISOString();
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1, $2, $3, $4, $4, $5) RETURNING *`, [tenantRef, workload, outcome, at, JSON.stringify({ reasons })],
    );
    for (let i = 0; i < settings; i += 1) {
      await client.query('INSERT INTO workload_observation (collection_id, resource_key) VALUES ($1, $2)', [run.id, `KEEL-RT-${i}`]);
    }
    return run;
  };
  const collectors = [
    { workload: 'KEEL-RT-mail', record: async () => null, collect: async () => ({ run: await store('KEEL-RT-mail', 'complete', 3), activation: { enabled: true } }) },
    {
      workload: 'KEEL-RT-sites',
      record: async (_client, { result }) => store(result.workload, 'failed', 0, result.reasons),
      collect: async () => { throw new Error('the scope file names no SharePoint host'); },
    },
  ];
  await runWorkloadCollection(client, { tenantRef, config: { tenantId: 't' }, transport: null, collectors, now: clock, logger: silent, onProgress: recordingWriter(client, jobId, reports) });
  assert.deepEqual(Object.values(reports[0]).map((entry) => entry.outcome), ['waiting', 'waiting']);
  assert.equal(reports[1]['workload:KEEL-RT-mail'].outcome, 'reading');
  const { rows: [job] } = await client.query('SELECT progress FROM job WHERE id = $1', [jobId]);
  assert.deepEqual(job.progress.types['workload:KEEL-RT-mail'].outcome, 'complete');
  assert.equal(job.progress.types['workload:KEEL-RT-mail'].itemCount, 3);
  assert.equal(job.progress.types['workload:KEEL-RT-sites'].outcome, 'failed');
  assert.match(job.progress.types['workload:KEEL-RT-sites'].error, /SharePoint host/);
});

test('progress is never written onto a job that is no longer running', async (t) => {
  const client = await schemaClient(t);
  const jobId = await runningJob(client, 'content-collect');
  await client.query(`UPDATE job SET status = 'cancelled' WHERE id = $1`, [jobId]);
  await progressWriter(client, jobId)({ 'content:teams': { outcome: 'waiting' } });
  const { rows: [job] } = await client.query('SELECT progress FROM job WHERE id = $1', [jobId]);
  assert.equal(job.progress, null);
});

test('without a job id nothing is written, and a failing write never changes the run', async () => {
  assert.equal(progressWriter({}, undefined), undefined);
  const quiet = progressTracker(['content:teams'], undefined);
  assert.equal(quiet.enabled, false);
  await quiet.start();
  const failing = progressTracker(['content:teams'], async () => { throw new Error('db down'); });
  await failing.reading('content:teams');
  await failing.done('content:teams', { outcome: 'complete', itemCount: 1 });
  const result = await runContentCollection(null, {
    tenantRef: 't', store: {}, collectors: [{ workload: 'teams', collect: async () => ({ outcome: 'succeeded', items: 1, bytes: 1 }) }],
    logger: silent, onProgress: async () => { throw new Error('db down'); },
  });
  assert.deepEqual(result.runs.map((run) => run.outcome), ['succeeded']);
});

test('an error line joins the reasons and is capped', () => {
  assert.equal(reasonsLine([]), null);
  assert.equal(reasonsLine(['a', { code: 'b' }]), 'a\n{"code":"b"}');
  assert.equal(reasonsLine(['x'.repeat(900)]).length, 500);
});
