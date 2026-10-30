// Service settings inside the approved setup (baselineWorkloads.mjs).
//
// Acceptance:
//  - a baseline captured from a backup holds every setting of the service read nearest
//    that backup (the newest at or before it; the first after it when there is none),
//    names the read in its scope with a setting count, and lists services never read;
//  - creating it makes those settings the approved setup service drift compares with,
//    so a later read that differs is a change against the baseline;
//  - accepting that change points the active baseline's row at the read that found it;
//    accepting a removal takes the row out;
//  - a new version captures the newer read and leaves the old version's rows as they
//    were; reinstating the old version puts its service settings back in the approved
//    setup, so the newer value shows as a change again;
//  - a service the baseline does not hold keeps the approved setup it had.
// Mutation checks:
//  - capture the newest read overall instead of the one nearest the backup;
//  - skip applyBaselineWorkloads on create or activate;
//  - leave the baseline row alone on accept.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { activateBaseline, listBaselines, reinstateBaseline, resnapshotBaseline, seedFromSnapshot } from './baseline.mjs';
import { acceptServiceChange } from './workloadApproved.mjs';
import { detectWorkloadDrift } from './workloadDrift.mjs';
import { baselineWorkloads, nearestWorkloadReads } from './baselineWorkloads.mjs';
import { completeSnapshot, createSnapshot } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

const MAIL = 'exchange-mail-flow';
const TEAMS = 'teams-settings';
const RULE = 'transport-rule:KEEL-RT-rule';
const OTHER = 'transport-rule:KEEL-RT-other';
const rule = (over = {}) => ({ identity: 'KEEL-RT-rule', kind: 'transportRule', Name: 'KEEL-RT-rule', State: 'Disabled', ...over });
const other = (over = {}) => ({ identity: 'KEEL-RT-other', kind: 'transportRule', Name: 'KEEL-RT-other', State: 'Enabled', ...over });
const tenant = () => `sha256:bw-${crypto.randomUUID()}`;
// Times are relative to the run, so nothing here ages out.
const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();

async function read(client, tenantRef, { workload = MAIL, at, observations, outcome = 'complete' }) {
  const { rows: [collection] } = await client.query(
    `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
     VALUES ($1, $2, $3, $4, $4, $4) RETURNING id`,
    [tenantRef, workload, outcome, at],
  );
  for (const [resourceKey, fields] of Object.entries(observations)) {
    await client.query('INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, $2, $3)', [collection.id, resourceKey, fields]);
  }
  return collection.id;
}

async function backup(client, tenantRef, completedAt) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: fullSuccessfulCoverageDigest() });
  await client.query('UPDATE snapshot SET started_at = $2, completed_at = $2 WHERE id = $1', [snapshotId, completedAt]);
  return snapshotId;
}

const rowsOf = async (client, baselineId) => new Map((await client.query(
  'SELECT * FROM baseline_workload WHERE baseline_id = $1', [baselineId],
)).rows.map((row) => [`${row.workload}|${row.resource_key}`, row.collection_id]));
const approved = async (client, tenantRef, workload = MAIL) => new Map((await client.query(
  'SELECT * FROM workload_approved WHERE tenant_ref = $1 AND workload = $2', [tenantRef, workload],
)).rows.map((row) => [row.resource_key, row]));
const scopeOf = async (client, baselineId) => (await client.query('SELECT observation_scope FROM baseline WHERE id = $1', [baselineId])).rows[0].observation_scope;

test('a baseline holds the service read nearest its backup and makes it the approved setup', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  await read(client, tenantRef, { at: hoursAgo(30), observations: { [RULE]: rule({ State: 'Old' }) } });
  const nearest = await read(client, tenantRef, { at: hoursAgo(20), observations: { [RULE]: rule(), [OTHER]: other() } });
  await read(client, tenantRef, { at: hoursAgo(15), observations: { [RULE]: rule({ State: 'Broken' }) }, outcome: 'failed' });
  const later = await read(client, tenantRef, { at: hoursAgo(5), observations: { [RULE]: rule({ State: 'Enabled' }) } });
  const snapshotId = await backup(client, tenantRef, hoursAgo(10));

  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId, setBy: 'test-operator' });

  assert.deepEqual(await rowsOf(client, baselineId), new Map([[`${MAIL}|${RULE}`, nearest], [`${MAIL}|${OTHER}`, nearest]]));
  const scope = await scopeOf(client, baselineId);
  assert.deepEqual(scope.workloads.map(({ collectedAt, ...entry }) => entry), [{ workload: MAIL, collectionId: nearest, outcome: 'complete', settings: 2 }]);
  assert.ok(scope.workloadsNotRead.includes(TEAMS));
  assert.ok(!scope.workloadsNotRead.includes(MAIL));
  assert.equal(scope.workloadsNotRead.length, baselineWorkloads().length - 1);
  assert.ok(Array.isArray(scope.types), 'the Graph scope is kept');

  const live = await approved(client, tenantRef);
  assert.equal(live.get(RULE).fields.State, 'Disabled');
  assert.equal(live.get(RULE).collection_id, nearest);
  assert.equal(live.size, 2);
  const [listed] = await listBaselines(client, { tenantRef });
  assert.equal(listed.service_setting_count, 2);

  // The read after the backup differs from the baseline: it is a change against it.
  const found = await detectWorkloadDrift(client, { collectionId: later });
  assert.equal(found.status, 'detected');
  const byKey = new Map(found.drift.map((item) => [item.resourceKey, item]));
  assert.equal(byKey.get(RULE).changeType, 'modified');
  assert.equal(byKey.get(RULE).previousCollectionId, nearest);
  assert.equal(byKey.get(OTHER).changeType, 'removed');
});

test('accepting a service change updates the active baseline; a removal takes its row out', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const first = await read(client, tenantRef, { at: hoursAgo(20), observations: { [RULE]: rule(), [OTHER]: other() } });
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId: await backup(client, tenantRef, hoursAgo(10)), setBy: 'test-operator' });
  const second = await read(client, tenantRef, { at: hoursAgo(5), observations: { [RULE]: rule({ State: 'Enabled' }) } });
  await detectWorkloadDrift(client, { collectionId: second });
  const { rows: changes } = await client.query('SELECT * FROM workload_drift WHERE tenant_ref = $1', [tenantRef]);
  const modified = changes.find((row) => row.resource_key === RULE);
  const removed = changes.find((row) => row.resource_key === OTHER);

  await acceptServiceChange(client, { tenantRef, changeId: modified.id, actor: 'test-operator', reason: 'planned' });
  await acceptServiceChange(client, { tenantRef, changeId: removed.id, actor: 'test-operator', reason: 'retired' });

  assert.deepEqual(await rowsOf(client, baselineId), new Map([[`${MAIL}|${RULE}`, second]]));
  assert.equal((await approved(client, tenantRef)).get(RULE).collection_id, second);
  assert.notEqual(first, second, 'the row moved off the read the baseline was captured from');
});

test('a new version captures the newer read; reinstating the old one puts its service settings back', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const first = await read(client, tenantRef, { at: hoursAgo(40), observations: { [RULE]: rule() } });
  const v1 = await seedFromSnapshot(client, { tenantRef, snapshotId: await backup(client, tenantRef, hoursAgo(30)), setBy: 'test-operator' });
  const second = await read(client, tenantRef, { at: hoursAgo(20), observations: { [RULE]: rule({ State: 'Enabled' }) } });
  const v2 = await resnapshotBaseline(client, { tenantRef, baselineId: v1, snapshotId: await backup(client, tenantRef, hoursAgo(10)), setBy: 'test-operator' });

  assert.deepEqual(await rowsOf(client, v1), new Map([[`${MAIL}|${RULE}`, first]]), 'the old version keeps its rows');
  assert.deepEqual(await rowsOf(client, v2.id), new Map([[`${MAIL}|${RULE}`, second]]));
  assert.equal((await approved(client, tenantRef)).get(RULE).fields.State, 'Enabled');

  const v3 = await reinstateBaseline(client, { tenantRef, baselineId: v1, actor: 'test-operator', reason: 'roll back' });
  assert.deepEqual(await rowsOf(client, v3.id), new Map([[`${MAIL}|${RULE}`, first]]));
  assert.equal((await approved(client, tenantRef)).get(RULE).fields.State, 'Disabled');

  const third = await read(client, tenantRef, { at: hoursAgo(1), observations: { [RULE]: rule({ State: 'Enabled' }) } });
  const found = await detectWorkloadDrift(client, { collectionId: third });
  assert.equal(found.drift.length, 1);
  assert.equal(found.drift[0].previousCollectionId, first);
});

test('with no read before the backup, the first read after it is captured', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const snapshotId = await backup(client, tenantRef, hoursAgo(30));
  const firstAfter = await read(client, tenantRef, { at: hoursAgo(20), observations: { [RULE]: rule() } });
  await read(client, tenantRef, { at: hoursAgo(10), observations: { [RULE]: rule({ State: 'Enabled' }) } });

  const { reads } = await nearestWorkloadReads(client, { tenantRef, at: hoursAgo(30) });
  assert.deepEqual(reads.map((entry) => [entry.workload, entry.collectionId]), [[MAIL, firstAfter]]);
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId, setBy: 'test-operator' });
  assert.deepEqual(await rowsOf(client, baselineId), new Map([[`${MAIL}|${RULE}`, firstAfter]]));
});

test('activating a baseline that does not hold a service keeps that service\'s approved setup', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const teamsRead = await read(client, tenantRef, { workload: TEAMS, at: hoursAgo(5), observations: { 'meeting-policy:Global': { Allow: false } } });
  assert.equal((await detectWorkloadDrift(client, { collectionId: teamsRead })).status, 'first-run');
  // A baseline from before service settings were captured: its scope names no services.
  const { rows: [legacy] } = await client.query(
    `INSERT INTO baseline (tenant_ref, set_by, active, observation_scope) VALUES ($1, 'test-operator', false, '{"types":[]}') RETURNING id`,
    [tenantRef],
  );
  await activateBaseline(client, { tenantRef, baselineId: legacy.id });
  const live = await approved(client, tenantRef, TEAMS);
  assert.equal(live.size, 1);
  assert.equal(live.get('meeting-policy:Global').fields.Allow, false);
});
