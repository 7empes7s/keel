// Service settings and content backups count beside the Entra ID and Intune settings
// backup: the per-workload reader, the content run record, and recovery freshness.
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { runContentCollection } from '../../cli/keel-content-collect.mjs';
import { createMemoryContentStore } from '../content/store.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { loadRecoveryMetrics } from './recoveryMetrics.mjs';
import { loadServiceBackups, loadServiceObservations, recordContentRun } from './serviceBackups.mjs';

const NOW = new Date('2026-10-03T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

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

async function workloadRun(tenantRef, workload, outcome, from, to, settings = 0) {
  const { rows: [row] } = await client.query(
    `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
    [tenantRef, workload, outcome, from, to],
  );
  for (let index = 0; index < settings; index += 1) {
    await client.query('INSERT INTO workload_observation (collection_id, resource_key) VALUES ($1, $2)', [row.id, `KEEL-RT-${workload}-${index}`]);
  }
  return row.id;
}

async function contentItem(tenantRef, workload, container, itemKey, version, bytes) {
  await client.query(
    `INSERT INTO content_item (tenant_ref, workload, container, item_key, version, sha256, bytes, chunks, key_id, new_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, 'k1', $7)`,
    [tenantRef, workload, container, itemKey, version, 'b'.repeat(64), bytes],
  );
}

async function snapshot(tenantRef, startedAt, completedAt) {
  await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, $2, $3, 'complete', $4)`,
    [tenantRef, startedAt, completedAt, { user: { outcome: 'complete', itemCount: 3 } }],
  );
}

test('each service-settings and content workload reads its latest and last good run', async () => {
  const tenantRef = 'sha256:sb-reader';
  await workloadRun(tenantRef, 'exchange-mail-flow', 'complete', '2026-10-02T02:00:00Z', '2026-10-02T02:05:00Z', 3);
  await workloadRun(tenantRef, 'exchange-mail-flow', 'failed', '2026-10-03T02:00:00Z', '2026-10-03T02:01:00Z');
  await workloadRun(tenantRef, 'power-platform', 'disabled', '2026-10-03T02:00:00Z', '2026-10-03T02:00:00Z');
  await workloadRun('sha256:sb-other', 'teams-org-policies', 'complete', '2026-10-03T02:00:00Z', '2026-10-03T02:05:00Z', 1);
  await recordContentRun(client, { tenantRef, workload: 'exchange-mail', outcome: 'succeeded', items: 2, bytes: 300, skipped: ['KEEL-RT-x: no mailbox'], namePrefix: 'KEEL-RT-', startedAt: '2026-10-03T01:00:00Z', completedAt: '2026-10-03T01:02:00Z' });
  await recordContentRun(client, { tenantRef, workload: 'planner', outcome: 'failed', reasons: ['KEEL-RT- throttled'], startedAt: '2026-10-03T01:03:00Z', completedAt: '2026-10-03T01:04:00Z' });
  await contentItem(tenantRef, 'exchange-mail', 'mailbox:KEEL-RT-a', 'm1', 'v1', 100);
  await contentItem(tenantRef, 'exchange-mail', 'mailbox:KEEL-RT-a', 'm1', 'v2', 120);
  await contentItem(tenantRef, 'exchange-mail', 'mailbox:KEEL-RT-b', 'm2', 'v1', 80);
  // Content stored before runs were recorded still shows as held.
  await contentItem(tenantRef, 'onedrive', 'drive:KEEL-RT-c', 'f1', 'v1', 50);

  const { settings, content } = await loadServiceBackups(client, { tenantRef });
  assert.deepEqual(settings.map((entry) => entry.workload), ['exchange-mail-flow', 'power-platform'], 'another tenant is never read');
  const mailFlow = settings[0];
  assert.equal(mailFlow.latest.outcome, 'failed');
  assert.equal(mailFlow.lastGood.at, '2026-10-02T02:05:00.000Z', 'a failed newer run never replaces the last good one');
  assert.equal(mailFlow.lastGood.settings, 3);
  assert.equal(settings[1].switchedOn, false, 'a workload that only ran disabled is switched off');
  assert.equal(settings[1].lastGood, null);

  assert.deepEqual(content.map((entry) => entry.workload), ['exchange-mail', 'onedrive', 'planner']);
  const mail = content[0];
  assert.equal(mail.latest.namePrefix, 'KEEL-RT-');
  assert.deepEqual(mail.latest.skipped, ['KEEL-RT-x: no mailbox']);
  assert.equal(mail.lastGood.items, 2);
  assert.deepEqual(mail.stored, { items: 2, versions: 3, containers: 2, bytes: 300, storedBytes: 300, newestAt: mail.stored.newestAt });
  assert.equal(content[1].latest, null);
  assert.equal(content[1].stored.items, 1);
  assert.equal(content[2].lastGood, null);
  assert.deepEqual(content[2].latest.reasons, ['KEEL-RT- throttled']);
  assert.deepEqual(content[2].latest.skipped, [], 'a run with nothing skipped lists nothing');

  const { required } = await loadServiceObservations(client, { tenantRef });
  assert.deepEqual(required.map((dependency) => dependency.key), ['workload:exchange-mail-flow', 'content:exchange-mail', 'content:planner'],
    'a disabled-only workload is not required; content is required once a run is recorded');
});

test('freshness counts every service: the oldest good backup across all of them decides', async () => {
  const tenantRef = 'sha256:sb-freshness';
  await snapshot(tenantRef, '2026-10-03T11:00:00Z', '2026-10-03T11:05:00Z');
  await workloadRun(tenantRef, 'teams-org-policies', 'complete', '2026-10-03T02:00:00Z', '2026-10-03T02:10:00Z', 2);
  await recordContentRun(client, { tenantRef, workload: 'teams', outcome: 'succeeded', items: 1, bytes: 10, startedAt: '2026-10-02T01:00:00Z', completedAt: '2026-10-02T01:30:00Z' });
  await recordContentRun(client, { tenantRef, workload: 'teams', outcome: 'failed', startedAt: '2026-10-03T01:00:00Z', completedAt: '2026-10-03T01:30:00Z' });

  let metrics = await loadRecoveryMetrics(client, { tenantRef, requiredTypes: ['user'], now: NOW });
  assert.equal(metrics.freshness.state, 'measured');
  assert.equal(metrics.freshness.required, 3);
  assert.equal(metrics.freshness.oldestDependency.key, 'content:teams');
  assert.equal(metrics.freshness.oldestDependency.workload, 'teams');
  assert.equal(metrics.freshness.achievedRpoMs, 35 * HOUR, 'the failed newer content run does not move it forward');
  assert.deepEqual(metrics.freshness.latestFailures.map((failure) => failure.key), ['content:teams']);
  assert.equal(metrics.recoverablePoint.scope, 'entra-intune-settings');
  assert.deepEqual(metrics.services.settings.map((entry) => entry.workload), ['teams-org-policies']);
  assert.deepEqual(metrics.services.content.map((entry) => entry.workload), ['teams']);

  // A workload that has run but never succeeded is a gap: freshness is not measured.
  await workloadRun(tenantRef, 'purview-labels', 'failed', '2026-10-03T02:00:00Z', '2026-10-03T02:01:00Z');
  metrics = await loadRecoveryMetrics(client, { tenantRef, requiredTypes: ['user'], now: NOW });
  assert.equal(metrics.freshness.state, 'gaps');
  assert.equal(metrics.freshness.achievedRpoMs, null);
  assert.deepEqual(metrics.freshness.gaps.map((gap) => [gap.key, gap.kind, gap.workload]), [['workload:purview-labels', 'workload', 'purview-labels']]);
});

test('a content backup run records each workload, and a dry run without a database records nothing', async () => {
  const tenantRef = 'sha256:sb-run';
  const logger = { log: () => {} };
  let clock = Date.parse('2026-10-03T01:00:00Z');
  const now = () => { clock += 60_000; return new Date(clock); };
  const collectors = [
    { workload: 'teams', collect: async () => ({ outcome: 'succeeded', items: 4, bytes: 40, reasons: [], skipped: ['KEEL-RT-team: locked'] }) },
    { workload: 'planner', collect: async () => { throw new Error('KEEL-RT- planner read failed'); } },
  ];
  const store = createMemoryContentStore();
  await runContentCollection(client, { tenantRef, store, transport: null, collectors, scope: { namePrefix: 'KEEL-RT-' }, now, logger });
  const { rows } = await client.query(
    'SELECT workload, outcome, items, bytes, reasons, skipped, name_prefix, started_at < completed_at AS ordered FROM content_run WHERE tenant_ref = $1 ORDER BY workload',
    [tenantRef],
  );
  assert.deepEqual(rows.map((row) => [row.workload, row.outcome, Number(row.items), Number(row.bytes), row.name_prefix, row.ordered]),
    [['planner', 'failed', 0, 0, 'KEEL-RT-', true], ['teams', 'succeeded', 4, 40, 'KEEL-RT-', true]]);
  assert.deepEqual(rows[0].reasons, ['KEEL-RT- planner read failed']);
  assert.deepEqual(rows[1].skipped, ['KEEL-RT-team: locked']);
  assert.deepEqual(await recordContentRun(null, { tenantRef, workload: 'teams', outcome: 'succeeded' }), { recorded: false, reason: 'no-database' });
});
