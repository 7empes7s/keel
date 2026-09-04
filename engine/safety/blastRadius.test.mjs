import { strict as assert } from 'node:assert';
import { blastRadiusOf } from './blastRadius.mjs';

assert.equal(blastRadiusOf('conditionalAccessPolicy'), 'tenant-lockout');
assert.equal(blastRadiusOf('namedLocation'), 'tenant-lockout');
assert.equal(blastRadiusOf('roleAssignment'), 'tenant-lockout');
assert.equal(blastRadiusOf('group'), 'access-affecting');
// An unclassified type must throw, never silently default — a missing entry
// here is a safety hole, not a gap to fill in later.
assert.throws(() => blastRadiusOf('someNewTypeNobodyClassifiedYet'));

console.log('blastRadius.test.mjs — all assertions passed');
