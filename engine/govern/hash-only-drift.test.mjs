/** A resource whose content did not change is never a change, even when its stored
 * hashes differ.
 *
 * Live check K10 (2026-10-27) found Ask listing 51 roleAssignmentSchedule and 12
 * permissionGrantPolicy changes with no changed fields. On 2026-10-15 a field of each
 * type was classified server-owned (issues #288 and #294). Baselines captured before
 * that kept a hash that still counted the field, so the next detection compared an old
 * hash with a new one and recorded a 'modified' row with equal payloads.
 *
 * Every time here is fixed (NOW, and backups placed relative to it).
 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';

import { canonicalHash, sameContent } from '../cir/canonicalHash.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { currentResourceState } from '../policy/changeIntent.mjs';
import { evaluateOpenDrifts } from '../policy/evaluate.mjs';
import { answerQuestion } from '../query/execute.mjs';
import { insertResourceVersion } from '../store/db.mjs';
import { listLatestOpenDrift, listOpenDrift, markSameContentDrift, recordDrift } from '../store/governance.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { getOpenDriftCounts } from '../../status/queries.mjs';
import { baselineCompliance } from './baselineCompliance.mjs';
import { diffSnapshots } from './diffSnapshots.mjs';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const NOW = new Date('2026-10-27T15:30:00Z');
const TENANT = 'sha256:00000000a5c5b0a1';

// A role assignment as Graph returns it, and the same object hashed as it was before
// scheduleInfo.startDateTime was classified server-owned.
const SCHEDULE = {
  principalId: 'p-1', roleDefinitionId: 'r-1', directoryScopeId: '/', memberType: 'Direct',
  scheduleInfo: { startDateTime: '2026-10-14T09:00:00Z', expiration: { type: 'noExpiration' } },
};
const OLD_RULES_HASH = 'hash-before-2026-10-15-rule';

function version(naturalKey, resourceType, payload, payloadHash = canonicalHash(payload, resourceType)) {
  return { natural_key: naturalKey, resource_type: resourceType, payload, payload_hash: payloadHash, hash_version: 2, blast_radius: 'low' };
}

describe('sameContent', () => {
  test('equal payloads are the same content whatever hash was stored', () => {
    assert.equal(sameContent({ payload: SCHEDULE, payload_hash: OLD_RULES_HASH }, version('k', 'roleAssignmentSchedule', SCHEDULE), 'roleAssignmentSchedule'), true);
  });
  test('a difference only in a server-owned field is the same content', () => {
    const later = { ...SCHEDULE, scheduleInfo: { ...SCHEDULE.scheduleInfo, startDateTime: '2026-10-17T11:00:00Z' } };
    assert.equal(sameContent({ payload: SCHEDULE, payload_hash: OLD_RULES_HASH }, version('k', 'roleAssignmentSchedule', later), 'roleAssignmentSchedule'), true);
  });
  test('a permission grant policy whose rules only got new ids is the same content', () => {
    const policy = { displayName: 'KEEL-RT-consent', includes: [{ id: 'a', permissionType: 'delegated' }], excludes: [] };
    const recreated = { ...policy, includes: [{ id: 'b', permissionType: 'delegated' }] };
    assert.equal(sameContent({ payload: policy, payload_hash: 'old' }, version('k', 'permissionGrantPolicy', recreated), 'permissionGrantPolicy'), true);
  });
  test('a changed setting is a difference', () => {
    const changed = { ...SCHEDULE, roleDefinitionId: 'r-2' };
    assert.equal(sameContent(version('k', 'roleAssignmentSchedule', SCHEDULE), version('k', 'roleAssignmentSchedule', changed), 'roleAssignmentSchedule'), false);
  });
  test('without both payloads, or for an unknown type, unequal hashes stay a difference', () => {
    assert.equal(sameContent({ payload_hash: 'a' }, { payload_hash: 'b', payload: SCHEDULE }, 'roleAssignmentSchedule'), false);
    assert.equal(sameContent({ payload_hash: 'a', payload: {} }, { payload_hash: 'b', payload: {} }, 'notAType'), false);
  });
});

describe('diffSnapshots', () => {
  test('a hash stored under older rules is not drift; a changed setting still is', () => {
    const changed = { ...SCHEDULE, principalId: 'p-2' };
    const drift = diffSnapshots(
      [version('a', 'roleAssignmentSchedule', SCHEDULE, OLD_RULES_HASH), version('b', 'roleAssignmentSchedule', SCHEDULE, OLD_RULES_HASH)],
      [version('a', 'roleAssignmentSchedule', SCHEDULE), version('b', 'roleAssignmentSchedule', changed)],
    );
    assert.deepEqual(drift.map((item) => [item.naturalKey, item.changeType]), [['b', 'modified']]);
  });
});

const database = await createIsolatedTestDatabase(import.meta.url);

describe('stored rows', () => {
  let client;
  let baselineId;
  let observed;
  let captured;
  const ids = {};

  before(async () => {
    client = await database.connect();
    await client.query(schemaSql());
    const coverage = Object.fromEntries(DESCRIPTORS.map(({ type }) => [type, { outcome: 'complete', itemCount: 1 }]));
    const snapshot = async (completedAt) => (await client.query(
      `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
       VALUES ($1, 'complete', $2, $2, $3) RETURNING id`, [TENANT, completedAt, coverage])).rows[0].id;
    captured = await snapshot(new Date(NOW.getTime() - 14 * 86_400_000));
    observed = await snapshot(new Date(NOW.getTime() - 3_600_000));
    const resource = (naturalKey, payload, payloadHash) => ({
      naturalKey, resourceType: 'roleAssignmentSchedule', payload, payloadHash,
      criticality: 'high', blastRadius: 'low', fidelity: 'read-only', provenance: {},
    });
    const changed = { ...SCHEDULE, principalId: 'p-2' };
    // The baseline was captured before the rule, so both of its hashes are the old kind.
    const baselineVersions = [
      await insertResourceVersion(client, { snapshotId: captured, resource: resource('schedule:same', SCHEDULE, OLD_RULES_HASH) }),
      await insertResourceVersion(client, { snapshotId: captured, resource: resource('schedule:changed', SCHEDULE, OLD_RULES_HASH) }),
    ];
    await insertResourceVersion(client, { snapshotId: observed, resource: resource('schedule:same', SCHEDULE) });
    await insertResourceVersion(client, { snapshotId: observed, resource: resource('schedule:changed', changed) });
    ({ rows: [{ id: baselineId }] } = await client.query(
      `INSERT INTO baseline (tenant_ref, set_by, active) VALUES ($1, 'fixture', true) RETURNING id`, [TENANT]));
    for (const [naturalKey, versionId] of [['schedule:same', baselineVersions[0]], ['schedule:changed', baselineVersions[1]]]) {
      await client.query('INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) VALUES ($1, $2, $3)', [baselineId, naturalKey, versionId]);
    }
    // Rows as detection recorded them before the fix: one with equal payloads, one real.
    const drift = async (naturalKey, afterPayload) => (await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
                          before_hash, after_hash, before_payload, after_payload, blast_radius)
       VALUES ($1, $2, $3, $4, 'roleAssignmentSchedule', 'modified', $5, $6, $7, $8, 'low') RETURNING id`,
      [TENANT, baselineId, observed, naturalKey, OLD_RULES_HASH, canonicalHash(afterPayload, 'roleAssignmentSchedule'), SCHEDULE, afterPayload],
    )).rows[0].id;
    ids.same = await drift('schedule:same', SCHEDULE);
    ids.changed = await drift('schedule:changed', changed);
    // Read again before the rule: its start time had moved, the only difference.
    ids.readTime = await drift('schedule:read-time', { ...SCHEDULE, scheduleInfo: { ...SCHEDULE.scheduleInfo, startDateTime: '2026-10-13T09:00:00Z' } });
  });

  after(async () => {
    await client?.end();
    await database.cleanup();
  });

  test('the schema marks equal payloads at once; detection checks the rest under the current rules', async () => {
    const marks = async () => Object.fromEntries((await client.query('SELECT id, same_content FROM drift')).rows.map((row) => [row.id, row.same_content]));
    assert.deepEqual(await marks(), { [ids.same]: null, [ids.changed]: null, [ids.readTime]: null });
    await client.query(schemaSql());
    assert.deepEqual(await marks(), { [ids.same]: true, [ids.changed]: null, [ids.readTime]: null });
    assert.equal(await markSameContentDrift(client, { tenantRef: TENANT, batchSize: 1 }), 1);
    assert.deepEqual(await marks(), { [ids.same]: true, [ids.changed]: false, [ids.readTime]: true });
    assert.equal(await markSameContentDrift(client, { tenantRef: TENANT }), 0);
  });

  test('open change lists and counts leave the row out', async () => {
    assert.deepEqual((await listOpenDrift(client, { tenantRef: TENANT })).map((row) => row.id), [ids.changed]);
    assert.deepEqual((await listLatestOpenDrift(client, { tenantRef: TENANT, baselineId })).map((row) => row.id), [ids.changed]);
    const counts = await getOpenDriftCounts(client, { tenantRef: TENANT });
    assert.equal(counts.reduce((sum, row) => sum + row.count, 0), 1);
  });

  test('Ask lists only the change in content', async () => {
    const answer = await answerQuestion(client, {
      tenantRef: TENANT, scope: { central: true, entities: [] }, now: NOW, question: 'What changed this week?',
    });
    assert.equal(answer.total, 1);
    assert.deepEqual(answer.records.map((record) => record.naturalKey), ['schedule:changed']);
  });

  test('a resource whose only difference is its stored hash matches the baseline', async () => {
    const same = await currentResourceState(client, { tenantRef: TENANT, naturalKey: 'schedule:same', resourceType: 'roleAssignmentSchedule' });
    assert.equal(same.state, 'matches-baseline');
    const changed = await currentResourceState(client, { tenantRef: TENANT, naturalKey: 'schedule:changed', resourceType: 'roleAssignmentSchedule' });
    assert.equal(changed.state, 'drifted');
  });

  test('changes since capture count only the change in content', async () => {
    const [entry] = await baselineCompliance(client, { tenantRef: TENANT, now: NOW });
    assert.equal(entry.changesSinceCapture.state, 'compared');
    assert.deepEqual(
      [entry.changesSinceCapture.added, entry.changesSinceCapture.modified, entry.changesSinceCapture.removed],
      [0, 1, 0],
    );
  });

  test('detection records no row for it again', async () => {
    const baselineRows = (await client.query(
      `SELECT rv.* FROM baseline_resource br JOIN resource_version rv ON rv.id = br.resource_version_id WHERE br.baseline_id = $1`,
      [baselineId])).rows;
    const observedRows = (await client.query('SELECT * FROM resource_version WHERE snapshot_id = $1', [observed])).rows;
    assert.deepEqual(diffSnapshots(baselineRows, observedRows).map((item) => item.naturalKey), ['schedule:changed']);
  });

  test('policy evaluation marks unchecked rows first and never evaluates them', async () => {
    const { rows: [{ id: unchecked }] } = await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
                          before_hash, after_hash, before_payload, after_payload, blast_radius)
       SELECT tenant_ref, baseline_id, observed_snapshot, 'schedule:evaluated', resource_type, change_type,
              before_hash, after_hash, before_payload, after_payload, blast_radius
         FROM drift WHERE id = $1 RETURNING id`, [ids.readTime]);
    const evaluations = await evaluateOpenDrifts(client, { tenantRef: TENANT });
    assert.equal((await client.query('SELECT same_content FROM drift WHERE id = $1', [unchecked])).rows[0].same_content, true);
    assert.deepEqual(evaluations.map((entry) => entry.driftId), [ids.changed]);
  });

  test('a detection run records nothing new for it and marks older rows', async () => {
    const { rows: [{ id: unchecked }] } = await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
                          before_hash, after_hash, before_payload, after_payload, blast_radius)
       SELECT tenant_ref, baseline_id, $2, 'schedule:older', resource_type, change_type,
              before_hash, after_hash, before_payload, after_payload, blast_radius
         FROM drift WHERE id = $1 RETURNING id`, [ids.readTime, captured]);
    const before = (await client.query('SELECT count(*)::int AS n FROM drift')).rows[0].n;
    await exec(process.execPath, ['cli/keel-drift.mjs', 'detect', '--snapshot-id', observed,
      '--tenant-ref', TENANT, '--db-url', database.url], { cwd: repoRoot });
    const { rows } = await client.query('SELECT natural_key, same_content FROM drift WHERE id = $1 OR observed_snapshot = $2 ORDER BY natural_key', [unchecked, observed]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM drift')).rows[0].n, before, 'no new row');
    assert.deepEqual(rows.map((row) => [row.natural_key, row.same_content]), [
      ['schedule:changed', false], ['schedule:evaluated', true], ['schedule:older', true], ['schedule:read-time', true], ['schedule:same', true],
    ]);
  });

  test('a change recorded under older hashes is the same change in a newer backup: kept, and settlement finds it', async () => {
    const changed = { ...SCHEDULE, principalId: 'p-2' };
    // The open row was recorded before the rule, so its after hash is the old kind too.
    await client.query('UPDATE drift SET after_hash = $2 WHERE id = $1', [ids.changed, 'after-hash-before-2026-10-15-rule']);
    const { rows: [{ id: newer }] } = await client.query(
      `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
       SELECT tenant_ref, 'complete', $2, $2, coverage_digest FROM snapshot WHERE id = $1 RETURNING id`,
      [observed, new Date(NOW.getTime() - 1_800_000)]);
    const resource = (naturalKey, payload) => ({
      naturalKey, resourceType: 'roleAssignmentSchedule', payload, payloadHash: canonicalHash(payload, 'roleAssignmentSchedule'),
      criticality: 'high', blastRadius: 'low', fidelity: 'read-only', provenance: {},
    });
    await insertResourceVersion(client, { snapshotId: newer, resource: resource('schedule:same', SCHEDULE) });
    await insertResourceVersion(client, { snapshotId: newer, resource: resource('schedule:changed', changed) });

    const state = await currentResourceState(client, { tenantRef: TENANT, naturalKey: 'schedule:changed', resourceType: 'roleAssignmentSchedule' });
    assert.equal(state.state, 'drifted');
    assert.equal(state.drift.id, ids.changed);
    const reused = await recordDrift(client, {
      tenantRef: TENANT, baselineId, observedSnapshot: newer, naturalKey: 'schedule:changed', resourceType: 'roleAssignmentSchedule',
      changeType: 'modified', beforeHash: canonicalHash(SCHEDULE, 'roleAssignmentSchedule'), afterHash: canonicalHash(changed, 'roleAssignmentSchedule'),
      beforePayload: SCHEDULE, afterPayload: changed, blastRadius: 'low',
    });
    assert.equal(reused, ids.changed, 'detection keeps the row instead of recording the change again');
  });
});
