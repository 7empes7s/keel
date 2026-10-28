/** A change whose content did not change is never acted on, and an identical setting
 * is never planned as an update or kept from verifying.
 *
 * Follow-up to the hash-only drift fix (hash-only-drift.test.mjs). On 2026-10-15 a field
 * of roleAssignmentSchedule and of permissionGrantPolicy was classified server-owned.
 * Hashes stored before that still count the field, so comparing a stored hash with a
 * fresh one called identical content different. Here:
 *   - reconcile hashes the backup again instead of trusting its stored hash;
 *   - the value report decides by content when hashes differ;
 *   - accept, ignore, roll back, remediation (and its preview) and approvals refuse a
 *     drift row that records no change, with a plain message.
 *
 * Every time here is fixed (NOW, and backups placed relative to it).
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';

import { resolveRestoreScope } from '../../cli/keel-remediate.mjs';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { buildReconciliationPlan } from '../reconcile/reconciliationPlan.mjs';
import { observationVerdict } from '../reports/value.mjs';
import { insertResourceVersion } from '../store/db.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { SameContentDriftError, recordsNoChange } from '../store/openDrift.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { approveRequest, requestApproval } from './approvals.mjs';
import { acceptDrift } from './baseline.mjs';
import { applyDisposition } from './disposition.mjs';

const NOW = new Date('2026-10-27T15:30:00Z');
const TENANT = 'sha256:00000000a5c5b0a2';
const TYPE = 'roleAssignmentSchedule';
const SCHEDULE = {
  principalId: 'p-1', roleDefinitionId: 'r-1', directoryScopeId: '/', memberType: 'Direct',
  scheduleInfo: { startDateTime: '2026-10-14T09:00:00Z', expiration: { type: 'noExpiration' } },
};
const MOVED_START = { ...SCHEDULE, scheduleInfo: { ...SCHEDULE.scheduleInfo, startDateTime: '2026-10-17T11:00:00Z' } };
const CHANGED = { ...SCHEDULE, roleDefinitionId: 'r-2' };
const OLD_RULES_HASH = 'hash-before-2026-10-15-rule';
const fresh = (payload) => canonicalHash(payload, TYPE);

const row = (fields) => ({
  id: 'd', change_type: 'modified', resource_type: TYPE, same_content: null,
  before_hash: OLD_RULES_HASH, before_payload: SCHEDULE, after_hash: fresh(SCHEDULE), after_payload: SCHEDULE, ...fields,
});

describe('recordsNoChange', () => {
  test('a marked row, or an unchecked one whose payloads hold the same content, records no change', () => {
    assert.equal(recordsNoChange(row({ same_content: true, after_payload: CHANGED })), true);
    assert.equal(recordsNoChange(row({})), true);
    assert.equal(recordsNoChange(row({ after_payload: MOVED_START, after_hash: fresh(MOVED_START) })), true);
  });
  test('a changed setting, a row checked as changed, and added or removed rows are changes', () => {
    assert.equal(recordsNoChange(row({ after_payload: CHANGED, after_hash: fresh(CHANGED) })), false);
    assert.equal(recordsNoChange(row({ same_content: false })), false);
    assert.equal(recordsNoChange(row({ change_type: 'added', before_payload: null, before_hash: null })), false);
    assert.equal(recordsNoChange(row({ change_type: 'removed', after_payload: null, after_hash: null })), false);
    assert.equal(recordsNoChange(row({ before_payload: null })), false, 'without both payloads it stays a change');
  });
});

describe('value report: observationVerdict', () => {
  const base = { changeType: 'modified', beforeHash: OLD_RULES_HASH, baselineHashVersion: 2, covered: true, resourceType: TYPE };
  const seen = (payload) => ({ payload_hash: fresh(payload), hash_version: 2, payload });
  test('a rolled-back setting matches the baseline even when its stored hash predates a rule', () => {
    assert.equal(observationVerdict({ ...base, beforePayload: SCHEDULE, version: seen(SCHEDULE) }), 'matches');
    assert.equal(observationVerdict({ ...base, beforePayload: SCHEDULE, version: seen(MOVED_START) }), 'matches');
  });
  test('a setting still changed differs', () => {
    assert.equal(observationVerdict({ ...base, beforePayload: SCHEDULE, version: seen(CHANGED) }), 'differs');
  });
  test('without payloads, the hashes decide as before', () => {
    const { payload, ...hashOnly } = seen(SCHEDULE);
    assert.equal(observationVerdict({ ...base, version: hashOnly }), 'differs');
    assert.equal(observationVerdict({ ...base, beforeHash: hashOnly.payload_hash, version: hashOnly }), 'matches');
    assert.equal(observationVerdict({ ...base, baselineHashVersion: 1, version: hashOnly }), 'not-comparable');
  });
  test('hashed under another version, both payloads are compared under the current rules', () => {
    assert.equal(observationVerdict({ ...base, baselineHashVersion: 1, beforePayload: SCHEDULE, version: seen(SCHEDULE) }), 'matches');
  });
});

describe('reconcile', () => {
  const groupPath = '/groups?$select=id,displayName,description,mailNickname,groupTypes,securityEnabled,mailEnabled,membershipRule,membershipRuleProcessingState,onPremisesSyncEnabled,isAssignableToRole,visibility,createdDateTime,assignedLicenses';
  const reader = (groups) => ({
    async collect(version, path) {
      if (path === groupPath) return { items: groups, error: null };
      return { items: [], error: null };
    },
  });
  const resource = (payload) => ({
    naturalKey: 'group:ops', resourceType: 'group', payload, payloadHash: 'stored-under-older-rules',
    references: [], blastRadius: 'access-affecting', restorePriority: 100,
  });
  test('identical content with a stale stored hash is a noop, never an update', async () => {
    const plan = await buildReconciliationPlan(reader([{ id: 'ops-id', displayName: 'Ops', mailNickname: 'ops' }]), [
      resource({ displayName: 'Ops', mailNickname: 'ops' }),
    ]);
    assert.equal(plan.resources[0].verb, 'noop');
  });
  test('a changed setting is still an update', async () => {
    const plan = await buildReconciliationPlan(reader([{ id: 'ops-id', displayName: 'Ops changed', mailNickname: 'ops' }]), [
      resource({ displayName: 'Ops', mailNickname: 'ops' }),
    ]);
    assert.equal(plan.resources[0].verb, 'update');
  });
});

const database = await createIsolatedTestDatabase(import.meta.url);

describe('acting on a drift id', () => {
  let client;
  let requester;
  const ids = {};
  const refused = (error) => error instanceof SameContentDriftError
    && /did not change anything/.test(error.message) && /nothing to accept or roll back/.test(error.message);
  const count = async (sql, values) => Number((await client.query(sql, values)).rows[0].count);

  before(async () => {
    client = await database.connect();
    await client.query(schemaSql());
    const coverage = Object.fromEntries(DESCRIPTORS.map(({ type }) => [type, { outcome: 'complete', itemCount: 1 }]));
    const snapshot = async (completedAt) => (await client.query(
      `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
       VALUES ($1, 'complete', $2, $2, $3) RETURNING id`, [TENANT, completedAt, coverage])).rows[0].id;
    const captured = await snapshot(new Date(NOW.getTime() - 14 * 86_400_000));
    const observed = await snapshot(new Date(NOW.getTime() - 3_600_000));
    const resource = (naturalKey, payload, payloadHash) => ({
      naturalKey, resourceType: TYPE, payload, payloadHash,
      criticality: 'high', blastRadius: 'low', fidelity: 'read-only', provenance: {},
    });
    const { rows: [{ id: baselineId }] } = await client.query(
      `INSERT INTO baseline (tenant_ref, set_by, active) VALUES ($1, 'fixture', true) RETURNING id`, [TENANT]);
    const drift = async (naturalKey, afterPayload, sameContent = null) => {
      const baseVersion = await insertResourceVersion(client, { snapshotId: captured, resource: resource(naturalKey, SCHEDULE, OLD_RULES_HASH) });
      await insertResourceVersion(client, { snapshotId: observed, resource: resource(naturalKey, afterPayload) });
      await client.query('INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) VALUES ($1, $2, $3)', [baselineId, naturalKey, baseVersion]);
      return (await client.query(
        `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
                            before_hash, after_hash, before_payload, after_payload, blast_radius, same_content)
         VALUES ($1, $2, $3, $4, $5, 'modified', $6, $7, $8, $9, 'low', $10) RETURNING id::text AS id`,
        [TENANT, baselineId, observed, naturalKey, TYPE, OLD_RULES_HASH, fresh(afterPayload), SCHEDULE, afterPayload, sameContent],
      )).rows[0].id;
    };
    ids.marked = await drift('schedule:marked', SCHEDULE, true);
    ids.unchecked = await drift('schedule:unchecked', MOVED_START);
    ids.changed = await drift('schedule:changed', CHANGED);
    ids.later = await drift('schedule:later', CHANGED);
    ({ rows: [{ id: requester }] } = await client.query(
      `INSERT INTO principal (email, display_name) VALUES ('requester@same-content.test', 'Requester') RETURNING id::text AS id`));
  });

  after(async () => {
    await client?.end();
    await database.cleanup();
  });

  test('accept refuses a marked row and an unchecked row with the same content, and changes nothing', async () => {
    const before = await client.query('SELECT natural_key, resource_version_id FROM baseline_resource ORDER BY natural_key');
    for (const driftId of [ids.marked, ids.unchecked]) {
      await assert.rejects(acceptDrift(client, { driftId, actor: 'tester', reason: 'r' }), refused);
      await assert.rejects(applyDisposition(client, { driftId, action: 'accept', actor: 'tester', reason: 'r' }), refused);
    }
    assert.deepEqual((await client.query('SELECT natural_key, resource_version_id FROM baseline_resource ORDER BY natural_key')).rows, before.rows);
    assert.equal(await count('SELECT count(*) FROM disposition'), 0);
  });

  test('ignore and roll back refuse it too', async () => {
    await assert.rejects(applyDisposition(client, {
      driftId: ids.marked, action: 'ignore', actor: 'tester', reason: 'r', expiresAt: new Date(Date.now() + 86_400_000),
    }), refused);
    await assert.rejects(applyDisposition(client, { driftId: ids.unchecked, action: 'rollback', actor: 'tester', reason: 'r' }), refused);
    assert.equal(await count('SELECT count(*) FROM disposition'), 0);
  });

  test('remediation (CLI, worker and preview share this) refuses any selection holding such a row', async () => {
    await assert.rejects(resolveRestoreScope(client, { driftIds: [ids.changed, ids.marked] }), (error) => refused(error)
      && error.driftIds.length === 1 && error.driftIds[0] === ids.marked);
    await assert.rejects(resolveRestoreScope(client, { driftIds: [ids.unchecked] }), refused);
    const scope = await resolveRestoreScope(client, { driftIds: [ids.changed] });
    assert.deepEqual(scope.selection, ['schedule:changed']);
  });

  test('an approval request to roll it back is refused; a real change can still be requested', async () => {
    await assert.rejects(requestApproval(client, {
      tenantRef: TENANT, action: 'remediate', params: { driftIds: [ids.unchecked] }, requestedBy: requester,
    }), refused);
    assert.equal(await count('SELECT count(*) FROM approval_request'), 0);
    const request = await requestApproval(client, {
      tenantRef: TENANT, action: 'remediate', params: { driftIds: [ids.changed] }, requestedBy: requester,
    });
    assert.equal(request.status, 'pending');
  });

  test('a request made before its row was found to hold the same content is refused at approval', async () => {
    const request = await requestApproval(client, {
      tenantRef: TENANT, action: 'remediate', params: { driftIds: [ids.later] }, requestedBy: requester,
    });
    await client.query('UPDATE drift SET same_content = true WHERE id = $1', [ids.later]);
    await assert.rejects(approveRequest(client, { tenantRef: TENANT, id: request.id, decidedBy: 'principal-approver' }), refused);
    assert.equal((await client.query('SELECT status FROM approval_request WHERE id = $1', [request.id])).rows[0].status, 'pending');
    assert.equal(await count("SELECT count(*) FROM job WHERE kind = 'remediate'"), 0);
  });
});
