/** The approved setup's match percentage and its history (baselineScore.mjs).
 *
 * Acceptance:
 *  - a kind the setup holds: changed and removed settings stop matching, added ones are
 *    judged but never match; a service read: added and changed stop matching, removed
 *    ones are judged; the percentage rounds down (never 100% with a change left);
 *  - a service read with no count, a read that failed, and a kind not covered are left out;
 *  - the stored point counts only open changes (an accepted one counts as matching), the
 *    newest change per setting, and the newest read per service, per service and overall;
 *  - nothing is stored without an approved setup;
 *  - drift detection after a backup stores one point for that backup.
 *
 * Every time here is fixed (NOW, and rows placed relative to it).
 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

import { canonicalHash } from '../cir/canonicalHash.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { insertResourceVersion } from '../store/db.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { seedFromSnapshot } from './baseline.mjs';
import {
  computeBaselineScore, kindMatch, listBaselineScorePoints, matchPercent, overallCount, recordBaselineScore, scoreByService,
} from './baselineScore.mjs';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const NOW = new Date('2026-10-30T08:00:00Z');
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000);
const database = await createIsolatedTestDatabase(import.meta.url);
after(() => database.cleanup());

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

test('kind match: what counts as matching for a held kind and for a service read', () => {
  const changes = { added: 1, modified: 2, removed: 3 };
  assert.deepEqual(kindMatch(10, changes, 'approved-setup'), { judged: 11, matching: 5 });
  assert.deepEqual(kindMatch(10, changes, 'previous-backup'), { judged: 13, matching: 7 });
  assert.deepEqual(kindMatch(1, { added: 0, modified: 4, removed: 0 }, 'approved-setup'), { judged: 1, matching: 0 });
  assert.equal(matchPercent({ matching: 999, judged: 1000 }), 99);
  assert.equal(matchPercent({ matching: 0, judged: 0 }), null);
});

test('score by service: unread, uncounted and empty kinds are left out', () => {
  const counts = scoreByService({
    captured: ['user', 'deviceCompliancePolicy', 'namedLocation'],
    held: { user: 8, deviceCompliancePolicy: 2 },
    changes: { user: { added: 1, modified: 1, removed: 0 } },
    reads: [
      { type: 'exchange-mail-flow', read: true, itemCount: 5, open: { added: 1, modified: 0, removed: 0 } },
      { type: 'teams-org-policies', read: false, itemCount: 9, open: { added: 0, modified: 0, removed: 0 } },
      { type: 'purview-labels', read: true, itemCount: null, open: { added: 0, modified: 0, removed: 0 } },
    ],
  });
  assert.deepEqual(Object.fromEntries(counts), {
    Entra: { matching: 7, judged: 9 },
    Intune: { matching: 2, judged: 2 },
    Exchange: { matching: 4, judged: 5 },
  });
  assert.deepEqual(overallCount(counts), { matching: 13, judged: 16 });
  assert.equal(overallCount(new Map()), null);
});

test('a stored point counts open changes, the newest read per service, and each service', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = 'sha256:00000000b5c09e01';
  assert.equal(await recordBaselineScore(client, { tenantRef, trigger: 'backup', now: hoursAgo(5) }), null, 'no approved setup, no point');

  const { rows: [snapshot] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', $2, $2) RETURNING id`,
    [tenantRef, hoursAgo(48)],
  );
  const { rows: [baseline] } = await client.query(
    `INSERT INTO baseline (tenant_ref, set_by, active, observation_scope, captured_at) VALUES ($1, 'fixture', true, $2, $3) RETURNING id`,
    [tenantRef, { types: ['user', 'deviceCompliancePolicy'] }, hoursAgo(48)],
  );
  const hold = async (naturalKey, resourceType) => {
    const payload = { displayName: naturalKey };
    const { rows: [version] } = await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, 'tier3', 'low', 'full', '{}') RETURNING id`,
      [snapshot.id, naturalKey, resourceType, payload, canonicalHash(payload, resourceType)],
    );
    await client.query('INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) VALUES ($1, $2, $3)', [baseline.id, naturalKey, version.id]);
  };
  for (let index = 1; index <= 8; index++) await hold(`user:keel-rt-${index}`, 'user');
  for (let index = 1; index <= 2; index++) await hold(`deviceCompliancePolicy:KEEL-RT-${index}`, 'deviceCompliancePolicy');

  const drift = async (naturalKey, changeType, detectedAt) => (await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, blast_radius, detected_at)
     VALUES ($1, $2, $3, $4, 'user', $5, 'low', $6) RETURNING id`,
    [tenantRef, baseline.id, snapshot.id, naturalKey, changeType, detectedAt],
  )).rows[0].id;
  // Recorded on two backups: only the newest row counts, so it is one change, not two.
  const { rows: [later] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', $2, $2) RETURNING id`,
    [tenantRef, hoursAgo(24)],
  );
  await drift('user:keel-rt-1', 'modified', hoursAgo(30));
  await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, blast_radius, detected_at)
     VALUES ($1, $2, $3, 'user:keel-rt-1', 'user', 'modified', 'low', $4)`,
    [tenantRef, baseline.id, later.id, hoursAgo(20)],
  );
  await drift('user:keel-rt-new', 'added', hoursAgo(20));
  // Accepted: no longer open, so the setting counts as matching.
  const accepted = await drift('user:keel-rt-2', 'removed', hoursAgo(20));
  await client.query(`INSERT INTO disposition (drift_id, action, actor, reason) VALUES ($1, 'accept', 'fixture', 'Approved change')`, [accepted]);

  const collection = async (workload, outcome, createdAt) => (await client.query(
    `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
     VALUES ($1, $2, $3, $4, $4, $4) RETURNING id`,
    [tenantRef, workload, outcome, createdAt],
  )).rows[0].id;
  const older = await collection('exchange-mail-flow', 'complete', hoursAgo(26));
  const mailFlow = await collection('exchange-mail-flow', 'complete', hoursAgo(2));
  for (let index = 1; index <= 5; index++) {
    await client.query('INSERT INTO workload_observation (collection_id, resource_key) VALUES ($1, $2)', [mailFlow, `rule:KEEL-RT-${index}`]);
  }
  const changed = async (resourceKey, changeType) => client.query(
    `INSERT INTO workload_drift (tenant_ref, workload, collection_id, previous_collection_id, resource_key, change_type, blast_radius, detected_at)
     VALUES ($1, 'exchange-mail-flow', $2, $3, $4, $5, 'cosmetic', $6)`,
    [tenantRef, mailFlow, older, resourceKey, changeType, hoursAgo(2)],
  );
  await changed('rule:KEEL-RT-1', 'modified');
  await changed('rule:KEEL-RT-9', 'added');
  // The modified rule's alert is resolved (it was put back), so it no longer counts.
  await client.query(
    `INSERT INTO alert (tenant_ref, resource_key, control, condition, state, condition_active, severity,
                        first_opened_at, occurrence_started_at, last_firing_at, last_observed_at, last_event_id)
     VALUES ($1, 'exchange-mail-flow:rule:KEEL-RT-1', 'baseline', 'drift', 'resolved', false, 'warning', $2, $2, $2, $2, 'fixture')`,
    [tenantRef, hoursAgo(2)],
  );
  // Teams read fine once, but its newest read failed: left out.
  const teams = await collection('teams-org-policies', 'complete', hoursAgo(30));
  await client.query('INSERT INTO workload_observation (collection_id, resource_key) VALUES ($1, $2)', [teams, 'policy:KEEL-RT-1']);
  await collection('teams-org-policies', 'failed', hoursAgo(1));
  // A service Keel no longer reads: its old rows are not scored.
  const retired = await collection('retired-workload', 'complete', hoursAgo(3));
  await client.query('INSERT INTO workload_observation (collection_id, resource_key) VALUES ($1, $2)', [retired, 'thing:KEEL-RT-1']);

  const score = await computeBaselineScore(client, { tenantRef });
  assert.deepEqual(score.services, {
    // 8 held + 1 added judged; 1 changed and the added one do not match.
    Entra: { matching: 7, judged: 9 },
    Intune: { matching: 2, judged: 2 },
    // 5 read; the added rule does not match, the put-back one does.
    Exchange: { matching: 4, judged: 5 },
  });
  assert.deepEqual(score.overall, { matching: 13, judged: 16 });

  // A setup from before scopes were recorded is scoped to the kinds it holds, as the
  // page does: the Intune kind with no change still counts.
  await client.query(`UPDATE baseline SET observation_scope = '{"types":["user"]}' WHERE id = $1`, [baseline.id]);
  assert.deepEqual((await computeBaselineScore(client, { tenantRef })).overall, { matching: 11, judged: 14 }, 'a recorded scope is used');
  await client.query('UPDATE baseline SET captured_at = NULL WHERE id = $1', [baseline.id]);
  assert.deepEqual((await computeBaselineScore(client, { tenantRef })).overall, { matching: 13, judged: 16 }, 'no recorded capture: the kinds held');

  const first = await recordBaselineScore(client, { tenantRef, trigger: 'service-read', now: hoursAgo(1) });
  assert.equal(first.percent, 81);
  assert.equal(first.services.Entra.percent, 77);
  await client.query(`INSERT INTO disposition (drift_id, action, actor, reason)
    SELECT id, 'accept', 'fixture', 'Approved change' FROM drift WHERE natural_key = 'user:keel-rt-new'`);
  const second = await recordBaselineScore(client, { tenantRef, trigger: 'backup', sourceId: later.id, now: hoursAgo(0) });
  assert.deepEqual([second.matching, second.judged], [13, 15]);

  const points = await listBaselineScorePoints(client, { tenantRef });
  assert.deepEqual(points.map((point) => [point.trigger, point.percent]), [['service-read', 81], ['backup', 86]]);
  assert.equal(points[1].sourceId, String(later.id));
  assert.equal(points[1].baselineId, String(baseline.id));
  const newest = await listBaselineScorePoints(client, { tenantRef, limit: 1 });
  assert.deepEqual(newest.map((point) => point.trigger), ['backup']);
  await assert.rejects(recordBaselineScore(client, { tenantRef, trigger: 'page-view' }), /unknown score trigger/);
});

test('drift detection after a backup stores one point for that backup', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = 'sha256:00000000b5c09e02';
  const snapshot = async (completedAt) => (await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
     VALUES ($1, 'complete', $2, $2, $3) RETURNING id`,
    [tenantRef, completedAt, Object.fromEntries(DESCRIPTORS.map(({ type }) => [type, { itemCount: 1, outcome: 'complete' }]))],
  )).rows[0].id;
  const add = (snapshotId, naturalKey, resourceType, payload) => insertResourceVersion(client, {
    snapshotId,
    resource: { naturalKey, resourceType, payload, payloadHash: canonicalHash(payload, resourceType), criticality: 'tier3', blastRadius: 'low', fidelity: 'full', provenance: {} },
  });
  const policy = { displayName: 'KEEL-RT-score', state: 'enabled' };
  const captured = await snapshot(hoursAgo(48));
  await add(captured, 'conditionalAccessPolicy:KEEL-RT-score', 'conditionalAccessPolicy', policy);
  await seedFromSnapshot(client, { tenantRef, snapshotId: captured, setBy: 'fixture', label: 'Golden' });

  // A group was added since: one setting of two judged does not match.
  const observed = await snapshot(hoursAgo(1));
  await add(observed, 'conditionalAccessPolicy:KEEL-RT-score', 'conditionalAccessPolicy', policy);
  await add(observed, 'group:keel-rt-score', 'group', { displayName: 'KEEL-RT-score', mailNickname: 'keel-rt-score', securityEnabled: true, mailEnabled: false, groupTypes: [] });

  const { stdout } = await exec(process.execPath, ['cli/keel-drift.mjs', 'detect', '--snapshot-id', observed,
    '--tenant-ref', tenantRef, '--db-url', database.url], { cwd: repoRoot });
  assert.match(stdout, /approved setup match: 50% \(1 of 2 settings\)/);
  const points = await listBaselineScorePoints(client, { tenantRef });
  assert.equal(points.length, 1);
  assert.deepEqual([points[0].trigger, points[0].sourceId, points[0].percent], ['backup', String(observed), 50]);
  assert.deepEqual(points[0].services, { Entra: { matching: 1, judged: 2, percent: 50 } });
});
