import { strict as assert } from 'node:assert';
import { collectWithOutcomes, collectM1, M1_TYPES } from './entraAdapter.mjs';
import { get } from './registry.mjs';

const calls = [];
const reader = {
  async collect(version, path) {
    calls.push(path);
    if (path.startsWith('/users?')) return { items: [{ id: 'u1' }], pages: 1, status: 200 };
    if (path.startsWith('/groups?')) return { items: [{ id: 'partial' }], pages: 1, error: { status: 403, code: 'Error_AccessDenied', error: 'denied on page 2' } };
    if (path === '/roleManagement/directory/roleAssignments') throw new Error('connection reset');
    return { items: [], pages: 1, status: 200, error: null };
  },
};
const { collected, coverageDigest } = await collectWithOutcomes(reader, { tenantId: 'fixture-tenant' });
assert.equal(calls.length, M1_TYPES.length, 'errors do not prevent later types from being attempted');
assert.deepEqual(Object.keys(coverageDigest), M1_TYPES);

// A completed non-empty read keeps its outcome and structured evidence.
assert.equal(coverageDigest.user.outcome, 'complete');
assert.equal(coverageDigest.user.itemCount, 1);
assert.equal(coverageDigest.user.httpStatus, 200);
assert.equal(coverageDigest.user.error, null);
assert.equal(coverageDigest.user.apiVersion, 'v1.0');
assert.ok(coverageDigest.user.endpoint.startsWith('/users'));
assert.ok(!Number.isNaN(Date.parse(coverageDigest.user.startedAt)));
assert.ok(!Number.isNaN(Date.parse(coverageDigest.user.completedAt)));

// A successful empty read is complete-empty: a strict success, never a failure.
assert.equal(coverageDigest.namedLocation.outcome, 'complete-empty');
assert.equal(coverageDigest.namedLocation.itemCount, 0);
assert.deepEqual(Object.fromEntries(collected).namedLocation, []);

// A second-page failure is partial: the first-page count survives but
// completeness fails, and the partial payload is never stored as complete.
assert.equal(coverageDigest.group.outcome, 'partial');
assert.equal(coverageDigest.group.itemCount, 1);
assert.equal(coverageDigest.group.httpStatus, 403);
assert.equal(coverageDigest.group.graphCode, 'Error_AccessDenied');
assert.match(coverageDigest.group.error, /denied on page 2/);
assert.equal(collected.some(([t]) => t === 'group'), false, 'failed partial payload is not stored as complete');

// A transport failure before any page is failed with unknown cardinality.
assert.equal(coverageDigest.roleAssignment.outcome, 'failed');
assert.equal(coverageDigest.roleAssignment.itemCount, null);
assert.match(coverageDigest.roleAssignment.error, /connection reset/);
assert.equal(collected.some(([t]) => t === 'roleAssignment'), false);

await assert.rejects(() => collectM1(reader), /denied on page 2/, 'planning/restore still require all reads to succeed');

const adapter = get('group').adapter;
await assert.rejects(() => adapter.collect({ collect: async () => ({ items: [{}], capped: true }) }), /pagination incomplete/);
await assert.rejects(() => adapter.collect({ collect: async () => ({}) }), /missing items/);
assert.deepEqual(await adapter.collect({ collect: async () => ({ items: [], capped: false }) }), []);

// A capped enumeration records a partial outcome with the sampled count, not
// a completion and not an invented zero.
const capped = await collectWithOutcomes({ collect: async () => ({ items: [{}], pages: 20, capped: true }) }, { tenantId: 'fixture-tenant' });
assert.equal(capped.coverageDigest.user.outcome, 'partial');
assert.equal(capped.coverageDigest.user.itemCount, 1);
assert.match(capped.coverageDigest.user.error, /pagination incomplete/);
assert.equal(capped.collected.some(([t]) => t === 'user'), false);
console.log('outcomes.test.mjs — all assertions passed');
