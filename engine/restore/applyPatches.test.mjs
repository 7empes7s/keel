import { strict as assert } from 'node:assert';
import { applyPatches } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';

function fakeWriter() {
  const calls = [];
  return {
    calls,
    write: async (version, path, opts) => {
      calls.push({ version, path, opts });
      return { ok: true, status: 204, body: null };
    },
  };
}

const governor = new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });
const patch = { naturalKey: 'group:FIN-Admins', field: 'parentGroupId', symbol: 'group:FIN-Parent' };
const appliedIds = new Map([
  ['group:FIN-Admins', 'group-id-1'],
  ['group:FIN-Parent', 'group-id-2'],
]);

// A resolved symbol PATCHes the resource that carries the deferred field, with
// the target resource's id as the field value and no other payload fields.
const writer = fakeWriter();
const result = await applyPatches(writer, governor, [patch], {
  targetTenant: 'target', mode: 'enforce', appliedIds,
});
assert.equal(writer.calls.length, 1);
assert.deepEqual(writer.calls[0], {
  version: 'v1.0', path: '/groups/group-id-1',
  opts: { method: 'PATCH', body: { parentGroupId: 'group-id-2' } },
});
assert.equal(result.applied.length, 1);

// A missing symbol is reported rather than silently skipped, and is not an
// exception that would conceal the rest of the run's outcome.
const unresolvedResult = await applyPatches(fakeWriter(), governor, [
  { naturalKey: 'group:FIN-Admins', field: 'parentGroupId', symbol: 'group:Missing' },
], { targetTenant: 'target', mode: 'enforce', appliedIds });
assert.equal(unresolvedResult.failed.length, 1);
assert.equal(unresolvedResult.failed[0].reason, 'patch symbol group:Missing was never applied');

// Dry-run records the intended patch but performs no writes.
const dryWriter = fakeWriter();
const dryResult = await applyPatches(dryWriter, governor, [patch], {
  targetTenant: 'target', mode: 'dry-run', appliedIds,
});
assert.equal(dryWriter.calls.length, 0);
assert.equal(dryResult.applied.length, 1);

console.log('applyPatches.test.mjs — all assertions passed');
