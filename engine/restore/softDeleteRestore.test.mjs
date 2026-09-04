import { strict as assert } from 'node:assert';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import { applyWave } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';

function fakeWriter({ restored, afterUpdate = restored } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    write: async (version, path, opts) => {
      calls.push({ kind: 'write', version, path, opts });
      if (opts.method === 'POST') return { ok: true, status: 200, body: { id: restored.id } };
      return { ok: true, status: 204, body: null };
    },
    read: async (version, path) => {
      calls.push({ kind: 'read', version, path });
      reads += 1;
      return { ok: true, status: 200, body: reads === 1 ? restored : afterUpdate };
    },
  };
}

const governor = new ThrottleGovernor({
  'target/entra/write': { capacity: 100, refillPerSecond: 100 },
});

const desired = {
  displayName: 'Finance Admins',
  mailNickname: 'FIN-Admins',
  description: 'Baseline description',
};
const restoreResource = {
  naturalKey: 'group:FIN-Admins',
  resourceType: 'group',
  payload: desired,
  targetId: 'original-group-id',
  deletedItemId: 'original-group-id',
  verb: 'restore-soft-deleted',
};

// A clean restore uses the deleted-items restore endpoint with an empty body,
// then re-reads the live object before reporting success.
const cleanWriter = fakeWriter({ restored: { ...desired, id: 'original-group-id' } });
const clean = await applyWave(cleanWriter, governor, [restoreResource], {
  targetTenant: 'target', mode: 'enforce',
});
assert.equal(clean.applied.length, 1);
assert.equal(clean.failed.length, 0);
assert.deepEqual(cleanWriter.calls, [
  {
    kind: 'write',
    version: 'v1.0',
    path: '/directory/deletedItems/original-group-id/restore',
    opts: { method: 'POST', body: {} },
  },
  { kind: 'read', version: 'v1.0', path: '/groups/original-group-id' },
]);

// A restored object may retain pre-deletion drift. These fixtures have
// different hashes, so the restore must PATCH and then re-read to converge.
const staleRestore = { ...desired, id: 'original-group-id', description: 'Modified before deletion' };
const convergedRestore = { ...desired, id: 'original-group-id' };
assert.notEqual(canonicalHash(staleRestore, 'group'), canonicalHash(convergedRestore, 'group'));
const convergeWriter = fakeWriter({ restored: staleRestore, afterUpdate: convergedRestore });
const converged = await applyWave(convergeWriter, governor, [restoreResource], {
  targetTenant: 'target', mode: 'enforce',
});
assert.equal(converged.applied.length, 1);
assert.equal(converged.failed.length, 0);
assert.deepEqual(
  convergeWriter.calls.map(({ kind, path, opts }) => ({ kind, path, method: opts?.method })),
  [
    { kind: 'write', path: '/directory/deletedItems/original-group-id/restore', method: 'POST' },
    { kind: 'read', path: '/groups/original-group-id', method: undefined },
    { kind: 'write', path: '/groups/original-group-id', method: 'PATCH' },
    { kind: 'read', path: '/groups/original-group-id', method: undefined },
  ],
);

// A restore that returns a new id would break existing references and must be
// refused before any live-object read or PATCH is attempted.
const differentIdWriter = fakeWriter({ restored: { ...desired, id: 'different-group-id' } });
const differentId = await applyWave(differentIdWriter, governor, [restoreResource], {
  targetTenant: 'target', mode: 'enforce',
});
assert.equal(differentId.applied.length, 0);
assert.deepEqual(differentId.failed, [{
  naturalKey: 'group:FIN-Admins',
  error: 'restore returned a different objectId — references would be broken',
}]);
assert.equal(differentIdWriter.calls.length, 1);

console.log('softDeleteRestore.test.mjs — all assertions passed');
