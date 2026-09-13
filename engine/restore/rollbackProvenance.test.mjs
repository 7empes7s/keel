import { strict as assert } from 'node:assert';
import { applyWave } from './applyEngine.mjs';

const governor = { async acquire() {} };

function journal({ fails = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      if (fails) throw new Error('journal unavailable');
    },
  };
}

function writer({ id = 'target-id', verify, deleted = false } = {}) {
  const calls = [];
  return {
    calls,
    async write(version, path, options) {
      calls.push({ kind: 'write', version, path, options });
      return { ok: true, status: options.method === 'POST' ? 201 : 204, body: { id } };
    },
    async read(version, path) {
      calls.push({ kind: 'read', version, path });
      return deleted
        ? { ok: false, status: 404, body: null }
        : { ok: true, status: 200, body: verify };
    },
  };
}

async function apply(resource, fakeWriter, rollbackClient) {
  return applyWave(fakeWriter, governor, [resource], {
    targetTenant: 'target',
    mode: 'enforce',
    rollbackClient,
    runId: 'provenance-run',
    deletionGuardOptions: {
      breakGlassUserIds: ['break-glass-id'], breakGlassGroupIds: [], keelAppIds: [], caPolicies: [],
    },
  });
}

const desired = { displayName: 'Finance', mailNickname: 'finance' };
const current = { id: 'target-id', displayName: 'Finance changed', mailNickname: 'finance', description: 'drift' };

// Update journals the complete current payload before PATCH.
{
  const rollbackClient = journal();
  const fakeWriter = writer({ verify: { ...desired, id: 'target-id' } });
  const result = await apply({
    naturalKey: 'group:finance', resourceType: 'group', payload: desired,
    live: { targetId: 'target-id', payload: current }, targetId: 'target-id', verb: 'update', references: [],
  }, fakeWriter, rollbackClient);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(rollbackClient.calls[0].values, ['provenance-run', 'group:finance', current]);
  assert.equal(fakeWriter.calls[0].kind, 'write');
  assert.equal(fakeWriter.calls[0].options.method, 'PATCH');
}

// Create is the only mutating verb with no reversible prior object.
{
  const rollbackClient = journal();
  const fakeWriter = writer({ id: 'new-id', verify: { ...desired, id: 'new-id' } });
  const result = await apply({
    naturalKey: 'group:new', resourceType: 'group', payload: desired, verb: 'create', references: [],
  }, fakeWriter, rollbackClient);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(rollbackClient.calls[0].values, ['provenance-run', 'group:new', null]);
  assert.equal(fakeWriter.calls[0].options.method, 'POST');
}

// Delete records the actual live addition, not the desired absence.
{
  const rollbackClient = journal();
  const fakeWriter = writer({ deleted: true });
  const result = await apply({
    naturalKey: 'group:added', resourceType: 'group', payload: null,
    live: { targetId: 'target-id', payload: current }, targetId: 'target-id', verb: 'delete', references: [],
    blastRadius: 'access-affecting',
  }, fakeWriter, rollbackClient);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(rollbackClient.calls[0].values, ['provenance-run', 'group:added', current]);
  assert.equal(fakeWriter.calls[0].options.method, 'DELETE');
}

// Restore records the soft-deleted object before the restore endpoint changes it.
{
  const rollbackClient = journal();
  const softDeleted = { ...current, deletedDateTime: '2026-09-08T00:00:00Z' };
  const fakeWriter = writer({ verify: { ...desired, id: 'target-id' } });
  const result = await apply({
    naturalKey: 'group:finance', resourceType: 'group', payload: desired,
    live: { targetId: 'target-id', deletedItemId: 'target-id', payload: softDeleted },
    targetId: 'target-id', deletedItemId: 'target-id', verb: 'restore-soft-deleted', references: [],
  }, fakeWriter, rollbackClient);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(rollbackClient.calls[0].values, ['provenance-run', 'group:finance', softDeleted]);
  assert.equal(fakeWriter.calls[0].options.method, 'POST');
  assert.equal(fakeWriter.calls[0].path, '/directory/deletedItems/target-id/restore');
}

// A failed journal entry prevents the corresponding Graph write entirely (update verb).
{
  const fakeWriter = writer({ verify: { ...desired, id: 'target-id' } });
  const result = await apply({
    naturalKey: 'group:finance', resourceType: 'group', payload: desired,
    live: { targetId: 'target-id', payload: current }, targetId: 'target-id', verb: 'update', references: [],
  }, fakeWriter, journal({ fails: true }));
  assert.deepEqual(result.failed, [{
    naturalKey: 'group:finance', error: 'refusing to update: rollback journal write failed',
  }]);
  assert.equal(fakeWriter.calls.length, 0);
}

// A failed journal entry prevents a create's Graph write entirely too — create
// journals `null` as its prior state, and that journal write can still fail.
{
  const fakeWriter = writer({ id: 'new-id', verify: { ...desired, id: 'new-id' } });
  const result = await apply({
    naturalKey: 'group:new', resourceType: 'group', payload: desired, verb: 'create', references: [],
  }, fakeWriter, journal({ fails: true }));
  assert.deepEqual(result.failed, [{
    naturalKey: 'group:new', error: 'refusing to create: rollback journal write failed',
  }]);
  assert.equal(fakeWriter.calls.length, 0);
}

console.log('rollbackProvenance.test.mjs — all assertions passed');
