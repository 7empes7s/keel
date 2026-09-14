import { strict as assert } from 'node:assert';
import { applyPatches, applyWave } from './applyEngine.mjs';

function governor() {
  const acquired = [];
  const observed = [];
  return {
    acquired,
    observed,
    async acquire(...args) { acquired.push(args); },
    observeRetryAfter(...args) { observed.push(args); },
  };
}

function retryFixture() {
  const delays = [];
  return { delays, throttleRetryOptions: { sleep: async (seconds) => { delays.push(seconds); } } };
}

const desired = { displayName: 'Finance Admins', mailNickname: 'finance-admins' };
const group = (overrides = {}) => ({
  naturalKey: 'group:finance-admins',
  resourceType: 'group',
  payload: desired,
  references: [],
  ...overrides,
});

function throttleThenOk({ status = 429, retryAfter = 7, writeOk, readOk }) {
  const calls = [];
  let writes = 0;
  let reads = 0;
  return {
    calls,
    get writes() { return writes; },
    get reads() { return reads; },
    async write(version, path, options) {
      calls.push({ kind: 'write', version, path, options });
      writes += 1;
      if (writes === 1) return { ok: false, status, retryAfter, body: { error: { code: 'throttled' } } };
      return writeOk(options, path);
    },
    async read(version, path) {
      calls.push({ kind: 'read', version, path });
      reads += 1;
      return readOk(path);
    },
  };
}

async function assertRetriedMutation(name, resource, writeOk, readOk, expectedMethod) {
  const writer = throttleThenOk({ writeOk, readOk });
  const throttle = governor();
  const retry = retryFixture();
  const result = await applyWave(writer, throttle, [resource], {
    targetTenant: 'target',
    mode: 'enforce',
    ...(resource.verb === 'delete' ? {
      deletionGuardOptions: { breakGlassUserIds: ['break-glass-id'], keelAppIds: [], caPolicies: [] },
    } : {}),
    ...retry,
  });
  assert.equal(result.failed.length, 0, `${name}: ${JSON.stringify(result)}`);
  assert.equal(result.applied.length, 1, `${name} must verify before applying`);
  assert.equal(writer.writes, 2, `${name} must retry its throttled write exactly once`);
  assert.equal(writer.calls.find((call) => call.kind === 'write').options.method, expectedMethod);
  assert.deepEqual(retry.delays, [7], `${name} must honor Graph's exact Retry-After`);
  assert.deepEqual(throttle.observed, [['target', 'entra', 'write', 7]], `${name} must tune the governor before sleeping`);
  assert.equal(throttle.acquired.length, 3, `${name} must re-acquire before its retry and verification read`);
}

// Authorization and validation failures are permanent: one attempt only.
for (const status of [400, 401, 403]) {
  let writes = 0;
  const result = await applyWave({
    async write() {
      writes += 1;
      return { ok: false, status, body: { error: { code: 'permanent' } } };
    },
    async read() { throw new Error('permanent create failure must not verify'); },
  }, governor(), [group()], {
    targetTenant: 'target', mode: 'enforce', ...retryFixture(),
  });
  assert.equal(writes, 1, `${status} must not retry`);
  assert.equal(result.failed.length, 1);
}

await assertRetriedMutation(
  'create',
  group(),
  () => ({ ok: true, status: 201, body: { id: 'created-id' } }),
  () => ({ ok: true, status: 200, body: { ...desired, id: 'created-id' } }),
  'POST',
);

await assertRetriedMutation(
  'update',
  group({ verb: 'update', targetId: 'existing-id' }),
  () => ({ ok: true, status: 204, body: null }),
  () => ({ ok: true, status: 200, body: { ...desired, id: 'existing-id' } }),
  'PATCH',
);

await assertRetriedMutation(
  'delete',
  group({ verb: 'delete', targetId: 'existing-id', blastRadius: 'access-affecting' }),
  () => ({ ok: true, status: 204, body: null }),
  () => ({ ok: false, status: 404, body: null }),
  'DELETE',
);

await assertRetriedMutation(
  'soft-delete restore',
  group({ verb: 'restore-soft-deleted', targetId: 'deleted-id', deletedItemId: 'deleted-id' }),
  () => ({ ok: true, status: 200, body: { id: 'deleted-id' } }),
  () => ({ ok: true, status: 200, body: { ...desired, id: 'deleted-id' } }),
  'POST',
);

// Deferred patches use the same retry path, then verify the nested field.
{
  const writer = throttleThenOk({
    writeOk: () => ({ ok: true, status: 204, body: null }),
    readOk: () => ({ ok: true, status: 200, body: { parentGroupId: 'parent-id' } }),
  });
  const throttle = governor();
  const retry = retryFixture();
  const result = await applyPatches(writer, throttle, [{
    naturalKey: 'group:finance-admins', resourceType: 'group', field: 'parentGroupId', symbol: 'group:parent',
  }], {
    targetTenant: 'target',
    mode: 'enforce',
    appliedIds: new Map([['group:finance-admins', 'group-id'], ['group:parent', 'parent-id']]),
    ...retry,
  });
  assert.equal(result.failed.length, 0, JSON.stringify(result));
  assert.equal(writer.writes, 2);
  assert.deepEqual(retry.delays, [7]);
  assert.deepEqual(throttle.observed, [['target', 'entra', 'write', 7]]);
}

// A 503 follows exactly the same measured-delay and governor-tuning path.
{
  const writer = throttleThenOk({
    status: 503,
    retryAfter: 11,
    writeOk: () => ({ ok: true, status: 201, body: { id: 'created-id' } }),
    readOk: () => ({ ok: true, status: 200, body: { ...desired, id: 'created-id' } }),
  });
  const throttle = governor();
  const retry = retryFixture();
  const result = await applyWave(writer, throttle, [group()], {
    targetTenant: 'target', mode: 'enforce', ...retry,
  });
  assert.equal(result.failed.length, 0, JSON.stringify(result));
  assert.deepEqual(retry.delays, [11]);
  assert.deepEqual(throttle.observed, [['target', 'entra', 'write', 11]]);
}

// Verification reads, not just writes, must retry their own throttle result.
{
  let reads = 0;
  const writer = {
    writes: 0,
    async write() {
      this.writes += 1;
      return { ok: true, status: 201, body: { id: 'created-id' } };
    },
    async read() {
      reads += 1;
      if (reads === 1) return { ok: false, status: 429, retryAfter: 13, body: { error: { code: 'throttled' } } };
      return { ok: true, status: 200, body: { ...desired, id: 'created-id' } };
    },
  };
  const throttle = governor();
  const retry = retryFixture();
  const result = await applyWave(writer, throttle, [group()], {
    targetTenant: 'target', mode: 'enforce', ...retry,
  });
  assert.equal(result.failed.length, 0, JSON.stringify(result));
  assert.equal(reads, 2);
  assert.deepEqual(retry.delays, [13]);
  assert.deepEqual(throttle.observed, [['target', 'entra', 'write', 13]]);
}

// Exhaustion reports the final Graph status and bounded attempt count rather
// than spinning forever.
{
  let writes = 0;
  const throttle = governor();
  const retry = retryFixture();
  const result = await applyWave({
    async write() {
      writes += 1;
      return { ok: false, status: 429, retryAfter: 5, body: { error: { code: 'throttled' } } };
    },
    async read() { throw new Error('exhausted create must not verify'); },
  }, throttle, [group()], {
    targetTenant: 'target', mode: 'enforce', ...retry,
  });
  assert.equal(writes, 3);
  assert.deepEqual(retry.delays, [5, 5]);
  assert.deepEqual(result.failed[0], {
    naturalKey: 'group:finance-admins',
    error: '{"error":{"code":"throttled"}}',
    status: 429,
    attempts: 3,
  });
}

console.log('throttleRetry.test.mjs — all assertions passed');
