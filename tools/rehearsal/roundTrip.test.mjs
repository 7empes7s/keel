import { strict as assert } from 'node:assert';
import {
  assertDisposable, assertSingleModifiedDrift, readGroupWithRetry, runRoundTrip,
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

// readGroup (used by collectRehearsalSnapshot) must retry a 404 rather than propagate it
// immediately — this is the exact failure observed live right after group creation.
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

console.log('roundTrip.test.mjs — all assertions passed');
