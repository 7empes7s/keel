import { strict as assert } from 'node:assert';
import { decideVerb, verbCapability } from './verb.mjs';

assert.deepEqual(
  decideVerb({ desired: { payloadHash: 'abc123' }, live: null, softDeleted: true }),
  {
    verb: 'restore-soft-deleted',
    reason: 'desired present: baseline abc123; live absent; soft-deleted',
  },
);
assert.deepEqual(
  decideVerb({ desired: { payloadHash: 'abc123' }, live: null, softDeleted: false }),
  {
    verb: 'create',
    reason: 'desired present: baseline abc123; live absent; not soft-deleted',
  },
);
assert.deepEqual(
  decideVerb({ desired: { payloadHash: 'abc123' }, live: { payloadHash: 'def456' }, softDeleted: false }),
  {
    verb: 'update',
    reason: 'hash differs: baseline abc123 vs live def456',
  },
);
assert.deepEqual(
  decideVerb({ desired: { payloadHash: 'abc123' }, live: { payloadHash: 'abc123' }, softDeleted: false }),
  {
    verb: 'noop',
    reason: 'hash equal: baseline abc123 vs live abc123',
  },
);
assert.deepEqual(
  decideVerb({ desired: null, live: { payloadHash: 'def456' }, softDeleted: false }),
  {
    verb: 'delete',
    reason: 'desired absent; live present: live def456',
  },
);
assert.deepEqual(
  decideVerb({ desired: null, live: null, softDeleted: false }),
  {
    verb: 'noop',
    reason: 'desired absent; live absent',
  },
);

const update = decideVerb({
  desired: { payloadHash: 'abc123' },
  live: { payloadHash: 'def456' },
  softDeleted: false,
});
const noop = decideVerb({
  desired: { payloadHash: 'abc123' },
  live: { payloadHash: 'abc123' },
  softDeleted: false,
});
assert.equal(update.verb, 'update');
assert.equal(noop.verb, 'noop');

assert.throws(() => decideVerb({ desired: { payloadHash: 'abc123' }, live: undefined, softDeleted: false }));

// Roadmap task-52: verbCapability answers "can applyWave do this" —
// independent of decideVerb's "what does the diff require" above. A noop
// is always attemptable (applyWave never writes for it); a registered type
// with a genuinely unregistered verb, or an entirely unregistered type,
// must both read unsupported.
assert.deepEqual(verbCapability('group', 'noop'), { supported: true, capability: null });
assert.equal(verbCapability('group', 'update').supported, true);
assert.equal(verbCapability('roleAssignment', 'restore-soft-deleted').supported, false);
assert.equal(verbCapability('domain', 'update').supported, false);
assert.equal(verbCapability('domain', 'update').capability.claim, 'unsupported');

console.log('verb.test.mjs — all assertions passed');
