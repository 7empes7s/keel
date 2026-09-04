import { strict as assert } from 'node:assert';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import { applyWave } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';

function fakeWriter(reRead) {
  const calls = [];
  return {
    calls,
    write: async (version, path, opts) => {
      calls.push({ kind: 'write', version, path, opts });
      return { ok: true, status: 204, body: null };
    },
    read: async (version, path) => {
      calls.push({ kind: 'read', version, path });
      return { ok: true, status: 200, body: reRead };
    },
  };
}

const governor = new ThrottleGovernor({
  'target/entra/write': { capacity: 100, refillPerSecond: 100 },
});

const desiredGroup = {
  displayName: 'Finance Admins',
  mailNickname: 'FIN-Admins',
};
const groupUpdate = {
  naturalKey: 'group:FIN-Admins',
  resourceType: 'group',
  payload: desiredGroup,
  targetId: 'target-group-id',
  verb: 'update',
};

// A converging update is applied only after the re-read hashes to the desired
// state, and it issues exactly one PATCH.
const convergingWriter = fakeWriter({ ...desiredGroup, id: 'target-group-id' });
const converging = await applyWave(convergingWriter, governor, [groupUpdate], {
  targetTenant: 'target', mode: 'enforce',
});
assert.equal(converging.applied.length, 1);
assert.equal(converging.failed.length, 0);
assert.equal(convergingWriter.calls.filter((call) => call.kind === 'write' && call.opts.method === 'PATCH').length, 1);

// PATCH is a merge: an added writable property remains after the baseline
// payload is patched. The differing hashes make this fixture distinct from
// the converging case above.
const nonConvergingLive = { ...desiredGroup, id: 'target-group-id', description: 'added by drift' };
assert.notEqual(
  canonicalHash(desiredGroup, 'group'),
  canonicalHash(nonConvergingLive, 'group'),
);
const nonConvergingWriter = fakeWriter(nonConvergingLive);
const nonConverging = await applyWave(nonConvergingWriter, governor, [groupUpdate], {
  targetTenant: 'target', mode: 'enforce',
});
assert.equal(nonConverging.applied.length, 0);
assert.equal(nonConverging.failed.length, 1);
assert.equal(nonConverging.failed[0].error, 'residual drift after update');
assert.ok(nonConverging.failed[0].residual.length > 0);
assert.ok(nonConverging.failed[0].residual.includes('description'));

// Conditional Access writes are report-only even when the desired payload
// says enabled; inspect the body actually supplied to PATCH.
const caUpdate = {
  naturalKey: 'conditionalAccessPolicy:Finance',
  resourceType: 'conditionalAccessPolicy',
  payload: { displayName: 'Finance policy', state: 'enabled' },
  targetId: 'target-ca-id',
  verb: 'update',
};
const caWriter = fakeWriter({
  id: 'target-ca-id',
  displayName: 'Finance policy',
  state: 'enabledForReportingButNotEnforced',
});
await applyWave(caWriter, governor, [caUpdate], { targetTenant: 'target', mode: 'enforce' });
const caPatch = caWriter.calls.find((call) => call.kind === 'write' && call.opts.method === 'PATCH');
assert.equal(caPatch.opts.body.state, 'enabledForReportingButNotEnforced');

console.log('updatePath.test.mjs — all assertions passed');
