import { strict as assert } from 'node:assert';
import { collectWithOutcomes, collectM1, M1_TYPES } from './entraAdapter.mjs';
import { get } from './registry.mjs';

const calls = [];
const reader = {
  async collect(version, path) {
    calls.push(path);
    if (path.startsWith('/users?')) return { items: [{ id: 'u1' }] };
    if (path.startsWith('/groups?')) return { items: [{ id: 'partial' }], error: { status: 403, error: 'denied on page 2' } };
    if (path === '/roleManagement/directory/roleAssignments') throw new Error('connection reset');
    return { items: [], error: null };
  },
};
const { collected, coverageDigest } = await collectWithOutcomes(reader);
assert.equal(calls.length, M1_TYPES.length, 'errors do not prevent later types from being attempted');
assert.deepEqual(Object.keys(coverageDigest), M1_TYPES);
assert.deepEqual(coverageDigest.user, { outcome: 'complete', itemCount: 1 });
assert.deepEqual(coverageDigest.namedLocation, { outcome: 'complete', itemCount: 0 });
assert.deepEqual(Object.fromEntries(collected).namedLocation, []);
for (const type of ['group', 'roleAssignment']) {
  assert.equal(coverageDigest[type].outcome, 'failed');
  assert.equal(coverageDigest[type].itemCount, null);
  assert.ok(coverageDigest[type].error);
  assert.equal(collected.some(([t]) => t === type), false, 'failed partial payload is not stored as complete');
}
assert.match(coverageDigest.group.error, /denied on page 2/);
assert.match(coverageDigest.roleAssignment.error, /connection reset/);
await assert.rejects(() => collectM1(reader), /denied on page 2/, 'planning/restore still require all reads to succeed');

const adapter = get('group').adapter;
await assert.rejects(() => adapter.collect({ collect: async () => ({ items: [{}], capped: true }) }), /pagination incomplete/);
await assert.rejects(() => adapter.collect({ collect: async () => ({}) }), /missing items/);
assert.deepEqual(await adapter.collect({ collect: async () => ({ items: [], capped: false }) }), []);
console.log('outcomes.test.mjs — all assertions passed');
