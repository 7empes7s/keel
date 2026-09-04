import { strict as assert } from 'node:assert';
import { applyWave } from './applyEngine.mjs';
import { planDeletionWaves } from './wavePlanner.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';

const governor = new ThrottleGovernor({
  'target/entra/write': { capacity: 100, refillPerSecond: 100 },
});

const deletionGuardOptions = {
  breakGlassUserIds: ['break-glass-user-id'],
  keelAppIds: ['keel-restorer-app-id'],
  caPolicies: [],
};

function fakeWriter(events) {
  const calls = [];
  return {
    calls,
    write: async (version, path, opts) => {
      calls.push({ kind: 'write', version, path, opts });
      events?.push('delete');
      return { ok: true, status: 204, body: null };
    },
    read: async (version, path) => {
      calls.push({ kind: 'read', version, path });
      return { ok: false, status: 404, body: null };
    },
  };
}

function fakeRollbackClient({ fails = false, events } = {}) {
  const calls = [];
  return {
    calls,
    query: async (text, values) => {
      calls.push({ text, values });
      events?.push('journal');
      if (fails) throw new Error('journal unavailable');
    },
  };
}

function deletionResource(overrides = {}) {
  return {
    naturalKey: 'group:FIN-Admins',
    resourceType: 'group',
    targetId: 'target-group-id',
    verb: 'delete',
    blastRadius: 'access-affecting',
    payload: { id: 'target-group-id', displayName: 'Finance Admins', mailNickname: 'FIN-Admins' },
    references: [],
    ...overrides,
  };
}

// Reverse topology deletes the dependent role assignment before the group it references.
const group = deletionResource({ naturalKey: 'group:FIN-Admins' });
const roleAssignment = deletionResource({
  naturalKey: 'roleAssignment:Finance-Admins',
  resourceType: 'roleAssignment',
  targetId: 'target-role-assignment-id',
  references: [{ field: 'principalId', symbol: group.naturalKey, required: true }],
});
assert.deepEqual(planDeletionWaves([group, roleAssignment]).waves, [
  [roleAssignment.naturalKey],
  [group.naturalKey],
]);

// The complete prior payload is durably journaled before DELETE, and a 404 re-read
// verifies that the resource is absent before it is counted as applied.
const events = [];
const writer = fakeWriter(events);
const rollbackClient = fakeRollbackClient({ events });
const deleted = await applyWave(writer, governor, [group], {
  targetTenant: 'target',
  mode: 'enforce',
  deletionGuardOptions,
  rollbackClient,
  runId: 'delete-path-success',
});
assert.equal(deleted.applied.length, 1);
assert.equal(deleted.failed.length, 0);
assert.deepEqual(events, ['journal', 'delete']);
assert.deepEqual(rollbackClient.calls[0].values, [
  'delete-path-success',
  group.naturalKey,
  group.payload,
]);
assert.deepEqual(writer.calls.map(({ kind, path, opts }) => ({ kind, path, method: opts?.method })), [
  { kind: 'write', path: '/groups/target-group-id', method: 'DELETE' },
  { kind: 'read', path: '/groups/target-group-id', method: undefined },
]);

// A journal failure prevents the delete entirely.
const journalFailureWriter = fakeWriter();
const journalFailure = await applyWave(journalFailureWriter, governor, [group], {
  targetTenant: 'target',
  mode: 'enforce',
  deletionGuardOptions,
  rollbackClient: fakeRollbackClient({ fails: true }),
  runId: 'delete-path-journal-failure',
});
assert.equal(journalFailure.applied.length, 0);
assert.deepEqual(journalFailure.failed, [{
  naturalKey: group.naturalKey,
  error: 'refusing to delete: rollback journal write failed',
}]);
assert.equal(
  journalFailureWriter.calls.filter((call) => call.kind === 'write' && call.opts.method === 'DELETE').length,
  0,
);

// A non-overridable Task 9 guard refusal is skipped before journal or delete.
const guarded = deletionResource({
  naturalKey: 'break-glass-user-id',
  payload: { id: 'break-glass-user-id', displayName: 'Break glass' },
});
const guardedWriter = fakeWriter();
const guardRefusal = await applyWave(guardedWriter, governor, [guarded], {
  targetTenant: 'target',
  mode: 'enforce',
  deletionGuardOptions,
  rollbackClient: fakeRollbackClient(),
  runId: 'delete-path-guard-refusal',
});
assert.equal(guardRefusal.applied.length, 0);
assert.equal(guardRefusal.skipped.length, 1);
assert.match(guardRefusal.skipped[0].reason, /break-glass/i);
assert.equal(guardedWriter.calls.length, 0);

// Tenant-lockout deletes need an explicit successful simulation result.
const tenantLockout = deletionResource({
  naturalKey: 'roleAssignment:Global-Administrator',
  resourceType: 'roleAssignment',
  targetId: 'target-role-assignment-id',
  blastRadius: 'tenant-lockout',
  payload: { id: 'target-role-assignment-id', roleDefinitionId: 'global-administrator' },
});
const tenantLockoutWriter = fakeWriter();
const tenantLockoutRefusal = await applyWave(tenantLockoutWriter, governor, [tenantLockout], {
  targetTenant: 'target',
  mode: 'enforce',
  deletionGuardOptions,
  rollbackClient: fakeRollbackClient(),
  runId: 'delete-path-simulation-refusal',
});
assert.equal(tenantLockoutRefusal.applied.length, 0);
assert.deepEqual(tenantLockoutRefusal.skipped, [{
  naturalKey: tenantLockout.naturalKey,
  reason: 'refusing to delete tenant-lockout resource: simulationPassed must be true',
}]);
assert.equal(tenantLockoutWriter.calls.length, 0);

console.log('deletePath.test.mjs — all assertions passed');
