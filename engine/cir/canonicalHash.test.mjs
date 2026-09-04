import { strict as assert } from 'node:assert';
import { M1_TYPES } from '../collect/entraAdapter.mjs';
import { canonicalHash, canonicalize, VOLATILE_FIELDS } from './canonicalHash.mjs';

for (const resourceType of M1_TYPES) {
  assert.ok(VOLATILE_FIELDS.has(resourceType), `missing volatile-field entry for ${resourceType}`);
}

const orderedA = {
  displayName: 'Finance Admins',
  conditions: { includeUsers: ['ana'], excludeGroups: ['legacy'] },
};
const orderedB = {
  conditions: { excludeGroups: ['legacy'], includeUsers: ['ana'] },
  displayName: 'Finance Admins',
};
assert.equal(canonicalHash(orderedA, 'order'), canonicalHash(orderedB, 'order'));

VOLATILE_FIELDS.set('volatile-fixture', new Set(['modifiedDateTime']));
assert.equal(
  canonicalHash({ displayName: 'Finance Admins', modifiedDateTime: '2026-09-04T00:00:00Z' }, 'volatile-fixture'),
  canonicalHash({ displayName: 'Finance Admins', modifiedDateTime: '2026-09-04T00:01:00Z' }, 'volatile-fixture'),
);

assert.notEqual(
  canonicalHash({ displayName: 'Finance Admins', modifiedDateTime: '2026-09-04T00:00:00Z' }, 'volatile-fixture'),
  canonicalHash({ displayName: 'Legal Admins', modifiedDateTime: '2026-09-04T00:01:00Z' }, 'volatile-fixture'),
);

const nestedA = {
  nested: { z: 3, a: 1 },
  array: [{ z: 'second', a: 'first' }, { b: 2, a: 1 }],
};
const nestedB = {
  array: [{ a: 'first', z: 'second' }, { a: 1, b: 2 }],
  nested: { a: 1, z: 3 },
};
assert.deepEqual(canonicalize(nestedA, new Set()), canonicalize(nestedB, new Set()));
assert.equal(canonicalHash(nestedA, 'nested'), canonicalHash(nestedB, 'nested'));

assert.equal(
  canonicalHash({ '@odata.etag': 'root-etag', nested: { '@odata.etag': 'nested-etag', value: 'same' } }, 'odata'),
  canonicalHash({ '@odata.etag': 'other-root-etag', nested: { '@odata.etag': 'other-nested-etag', value: 'same' } }, 'odata'),
);

console.log('canonicalHash.test.mjs — all assertions passed');
