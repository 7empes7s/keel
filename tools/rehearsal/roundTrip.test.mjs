import { strict as assert } from 'node:assert';
import {
  assertDisposable, assertSingleModifiedDrift, readGroupWithRetry, runRoundTrip, writeWithRetry,
} from './roundTrip.mjs';

function fakeWriter() {
  const writes = [];
  return {
    writes,
    async write(...args) {
      writes.push(args);
      return { ok: true, status: 204, body: null };
    },
  };
}

// Dry-run must traverse the complete advertised rehearsal sequence without
// issuing a write, even when a writer is supplied by a caller.
const writer = fakeWriter();
const evidence = [];
const dryRun = await runRoundTrip({
  writer,
  log: (line) => evidence.push(line),
});
assert.equal(dryRun.mode, 'dry-run');
assert.equal(writer.writes.length, 0);
assert.ok(evidence.some((line) => line.includes('create group keel-rehearsal-<ISO timestamp>')));
assert.ok(evidence.some((line) => line.includes('hard-delete the group; assert absence')));

// The interlock's allowed and refused fixtures differ in the natural key
// prefix, so removing its gate cannot leave this test green.
assert.doesNotThrow(() => assertDisposable('group:keel-rehearsal-2026-09-05T00-00-00-000Z'));
assert.throws(
  () => assertDisposable('group:production-admins'),
  /refusing to mutate non-disposable natural key/,
);

const oneModifiedDrift = [{
  id: 'drift-1',
  natural_key: 'group:keel-rehearsal-2026-09-05T00-00-00-000Z',
  change_type: 'modified',
}];
assert.equal(
  assertSingleModifiedDrift(oneModifiedDrift, oneModifiedDrift[0].natural_key),
  oneModifiedDrift[0],
);

// Step 4 must fail loudly rather than silently choosing an arbitrary row.
assert.throws(
  () => assertSingleModifiedDrift([
    ...oneModifiedDrift,
    {
      id: 'drift-2',
      natural_key: 'group:keel-rehearsal-a-second-object',
      change_type: 'modified',
    },
  ], oneModifiedDrift[0].natural_key),
  /expected exactly one drift row/,
);

// readGroupWithRetry must retry a 404 rather than propagate it immediately — this is the
// exact failure observed live right after a group write (creation, mutation, or rollback).
// This generically exercises the retry behavior shared by all three call sites in
// roundTrip.mjs — collectRehearsalSnapshot (step 2/step 4 collection), the step 3
// post-mutation read, and the step 5 post-rollback read — since each is a plain
// `readGroupWithRetry(reader, groupId)` call with no call-site-specific branching. A
// duplicate fixture per call site would not exercise anything this one doesn't already cover.
{
  let calls = 0;
  const reader = {
    get: async () => {
      calls += 1;
      if (calls <= 2) return { ok: false, status: 404, body: null };
      return { ok: true, status: 200, body: { id: 'g1', displayName: 'x', mailNickname: 'x' } };
    },
  };
  const result = await readGroupWithRetry(reader, 'g1');
  assert.equal(result.id, 'g1');
  assert.equal(calls, 3, 'expected two failed attempts before the third succeeded');
}

// readGroupWithRetry must also retry a read that succeeds but doesn't yet satisfy a caller-given
// expectation — the stale-200 failure mode confirmed live on 2026-09-07, distinct from a 404.
{
  let calls = 0;
  const reader = {
    get: async () => {
      calls += 1;
      const description = calls <= 2 ? 'stale' : 'fresh';
      return { ok: true, status: 200, body: { id: 'g1', description } };
    },
  };
  const result = await readGroupWithRetry(reader, 'g1', { isExpected: (body) => body.description === 'fresh' });
  assert.equal(result.description, 'fresh');
  assert.equal(calls, 3, 'expected two stale reads before the third satisfied isExpected');
}

// Without an isExpected predicate, existing behavior (retry only on 404, accept the first
// successful read regardless of content) must be unchanged — this is collectRehearsalSnapshot's
// use, which only needs the object to exist, not to match specific content.
{
  let calls = 0;
  const reader = { get: async () => { calls += 1; return { ok: true, status: 200, body: { id: 'g2' } }; } };
  const result = await readGroupWithRetry(reader, 'g2');
  assert.equal(result.id, 'g2');
  assert.equal(calls, 1, 'expected no retry when no isExpected predicate is given and the read succeeds immediately');
}

// A write that 404s on a freshly-created object (this tenant's confirmed write-path lag,
// distinct from the read-path lag already covered) must retry, not fail immediately.
{
  let calls = 0;
  const writer = {
    write: async () => {
      calls += 1;
      if (calls <= 2) return { ok: false, status: 404, body: null };
      return { ok: true, status: 200, body: { id: 'g1' } };
    },
  };
  const result = await writeWithRetry(writer, 'v1.0', '/groups/g1', { method: 'PATCH', body: { displayName: 'x' } });
  assert.equal(result.ok, true);
  assert.equal(calls, 3, 'expected two failed attempts before the third succeeded');
}

// A non-404 failure (a real rejection) must NOT be retried — it should fail on the first attempt.
{
  let calls = 0;
  const writer = {
    write: async () => { calls += 1; return { ok: false, status: 400, body: { error: 'bad request' } }; },
  };
  const result = await writeWithRetry(writer, 'v1.0', '/groups/g1', { method: 'PATCH', body: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(calls, 1, 'a 400 must never be retried');
}

console.log('roundTrip.test.mjs — all assertions passed');
