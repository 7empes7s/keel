// #447 for service backups: a settings-by-service backup where no workload failed but
// some were read only in part exits 3, prints one `incomplete types:` line naming each
// partial workload and what it could not read, and lists those parts on the job's
// progress. A failed workload or a failed drift detection still exits 1.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { schemaSql } from '../engine/store/loadSchema.mjs';
import { progressWriter } from '../engine/jobs/progress.mjs';
import { INCOMPLETE_TYPES_PREFIX, PARTIAL_EXIT_CODE } from '../engine/collect/incomplete.mjs';
import { incompleteWorkloadsOf, runWorkloadCollection, workloadExitCode } from './keel-workload-collect.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) { await client.query(schemaSql()); schemaReady = true; }
  return client;
}

let tick = Date.parse('2026-10-23T02:00:00Z');
const clock = () => new Date((tick += 1000));

/** Stores one workload run with `settings` observations, as a collector does. */
function storeFor(client, tenantRef) {
  return async (workload, outcome, digest, settings) => {
    const at = clock().toISOString();
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1, $2, $3, $4, $4, $5) RETURNING *`, [tenantRef, workload, outcome, at, JSON.stringify(digest)],
    );
    for (let i = 0; i < settings; i += 1) {
      await client.query('INSERT INTO workload_observation (collection_id, resource_key) VALUES ($1, $2)', [run.id, `KEEL-RT-${i}`]);
    }
    return run;
  };
}

const refused = {
  failures: [{ family: 'transportRule', status: 'denied', error: { code: 'HTTP_403', httpStatus: 403, message: 'Access is denied' } }],
  unavailable: [{ family: 'atpPolicy', status: 'not-licensed', license: 'Defender for Office 365' }],
  discovery: { capped: false, unidentified: 0 },
  fieldCounts: { observed: 5 },
  reasons: [],
};

async function runningJob(client) {
  const { rows } = await client.query(
    `INSERT INTO job (kind, status, requested_by, started_at) VALUES ('workload-collect', 'running', 'KEEL-RT-tester', now()) RETURNING id`,
  );
  return rows[0].id;
}

function collectorsFor(store, outcomes) {
  return outcomes.map(([workload, outcome, digest = { reasons: [] }, settings = 2]) => ({
    workload,
    record: async (_client, { result }) => store(result.workload, 'failed', { reasons: result.reasons }, 0),
    collect: async () => {
      if (outcome === 'throws') throw new Error('the scope file names no SharePoint host');
      return { run: await store(workload, outcome, digest, settings), activation: { enabled: true } };
    },
  }));
}

test('a backup where some workloads are only partial exits 3 and names what was not read', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = `sha256:KEEL-RT-${crypto.randomUUID()}`;
  const store = storeFor(client, tenantRef);
  const jobId = await runningJob(client);
  const lines = [];
  const result = await runWorkloadCollection(client, {
    tenantRef, config: { tenantId: 't' }, transport: null, now: clock, logger: { log: (line) => lines.push(line) },
    collectors: collectorsFor(store, [['KEEL-RT-mail-flow', 'partial', refused, 5], ['KEEL-RT-teams', 'complete'], ['KEEL-RT-purview', 'disabled', { reasons: [] }, 0]]),
    onProgress: progressWriter(client, jobId),
  });
  assert.equal(result.exitCode, PARTIAL_EXIT_CODE);
  const marked = lines.filter((line) => line.startsWith(INCOMPLETE_TYPES_PREFIX));
  assert.equal(marked.length, 1, 'exactly one machine-readable line');
  const listed = JSON.parse(marked[0].slice(INCOMPLETE_TYPES_PREFIX.length));
  assert.deepEqual(listed, [{
    type: 'workload:KEEL-RT-mail-flow', outcome: 'partial', httpStatus: null, items: 5, reasonCount: 2,
    reasons: ['Transport rule: access denied: HTTP 403: Access is denied', 'Atp policy: not licensed in this tenant (Defender for Office 365)'],
  }]);
  // The Job page lists each part the workload could not read.
  const { rows: [job] } = await client.query('SELECT progress FROM job WHERE id = $1', [jobId]);
  const flow = job.progress.types['workload:KEEL-RT-mail-flow'];
  assert.equal(flow.outcome, 'partial');
  assert.equal(flow.itemCount, 5);
  assert.deepEqual(flow.reasons, listed[0].reasons);
  assert.equal(flow.reasonCount, 2);
  assert.match(flow.error, /Transport rule: access denied/);
  assert.equal(job.progress.types['workload:KEEL-RT-teams'].outcome, 'complete');
  assert.equal(job.progress.types['workload:KEEL-RT-teams'].reasons, undefined);
});

test('a failed workload beside a partial one still fails the backup, with no partial line', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = `sha256:KEEL-RT-${crypto.randomUUID()}`;
  const lines = [];
  const result = await runWorkloadCollection(client, {
    tenantRef, config: { tenantId: 't' }, transport: null, now: clock, logger: { log: (line) => lines.push(line) },
    collectors: collectorsFor(storeFor(client, tenantRef), [['KEEL-RT-mail-flow', 'partial', refused], ['KEEL-RT-sites', 'throws']]),
  });
  assert.equal(result.exitCode, 1);
  assert.ok(!lines.some((line) => line.startsWith(INCOMPLETE_TYPES_PREFIX)));
});

test('a failed drift detection beside a partial workload still fails the backup', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = `sha256:KEEL-RT-${crypto.randomUUID()}`;
  const store = storeFor(client, tenantRef);
  const lines = [];
  const collectors = [
    ...collectorsFor(store, [['KEEL-RT-mail-flow', 'partial', refused]]),
    // A run the drift detection cannot find: its detection fails.
    { workload: 'KEEL-RT-ghost', record: async () => null, collect: async () => ({ run: { id: crypto.randomUUID(), outcome: 'complete', digest: {} }, activation: { enabled: true } }) },
  ];
  const result = await runWorkloadCollection(client, {
    tenantRef, config: { tenantId: 't' }, transport: null, now: clock, logger: { log: (line) => lines.push(line) }, collectors,
  });
  assert.equal(result.runs.find((run) => run.workload === 'KEEL-RT-ghost').drift.status, 'failed');
  assert.equal(result.exitCode, 1);
  assert.ok(!lines.some((line) => line.startsWith(INCOMPLETE_TYPES_PREFIX)));
});

test('the exit code table', () => {
  const run = (outcome, drift = 'none') => ({ workload: 'w', outcome, drift: { status: drift } });
  assert.equal(workloadExitCode([run('complete'), run('complete-empty'), run('disabled')]), 0);
  assert.equal(workloadExitCode([run('complete'), run('partial')]), PARTIAL_EXIT_CODE);
  assert.equal(workloadExitCode([run('partial'), run('partial')]), PARTIAL_EXIT_CODE);
  assert.equal(workloadExitCode([run('partial'), run('failed')]), 1);
  assert.equal(workloadExitCode([run('partial'), run('complete', 'failed')]), 1);
  assert.equal(workloadExitCode([run('failed')]), 1);
  // Only partial workloads are listed; at most 50 parts each, each cut to 300 characters.
  const many = Array.from({ length: 60 }, (_, i) => `KEEL-RT-${i}: ${'x'.repeat(400)}`);
  const [listed, ...rest] = incompleteWorkloadsOf([{ ...run('partial'), gaps: many, settings: 9 }, run('complete')]);
  assert.equal(rest.length, 0);
  assert.equal(listed.reasons.length, 50);
  assert.equal(listed.reasonCount, 60);
  assert.ok(listed.reasons.every((reason) => reason.length <= 300));
});
