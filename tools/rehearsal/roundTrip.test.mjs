import { strict as assert } from 'node:assert';
import {
  assertDisposable, assertSingleModifiedDrift, runRoundTrip,
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

console.log('roundTrip.test.mjs — all assertions passed');
