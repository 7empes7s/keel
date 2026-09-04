import { strict as assert } from 'node:assert';
import { decideVerb } from './verb.mjs';

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

console.log('verb.test.mjs — all assertions passed');
