import { strict as assert } from 'node:assert';
import { M1_TYPES } from '../collect/entraAdapter.mjs';
import { canonicalHash, canonicalize } from './canonicalHash.mjs';

for (const resourceType of M1_TYPES) {
  const baseline = {
    id: `${resourceType}-before`,
    createdDateTime: '2026-09-04T00:00:00Z',
    modifiedDateTime: '2026-09-04T00:00:00Z',
    displayName: 'Finance Admins',
  };
  const serverOwnedChanged = {
    ...baseline,
    id: `${resourceType}-after`,
    createdDateTime: '2026-09-05T00:00:00Z',
    modifiedDateTime: '2026-09-05T00:00:00Z',
  };
  const writableChanged = { ...baseline, displayName: 'Legal Admins' };

  assert.equal(
    canonicalHash(baseline, resourceType),
    canonicalHash(serverOwnedChanged, resourceType),
    `${resourceType} server-owned changes must converge`,
  );
  assert.notEqual(
    canonicalHash(baseline, resourceType),
    canonicalHash(writableChanged, resourceType),
    `${resourceType} writable changes must remain drift`,
  );
}

assert.notEqual(
  canonicalHash({ displayName: 'Finance Admins', mailNickname: 'finance-admins' }, 'group'),
  canonicalHash({ displayName: 'Finance Admins', mailNickname: 'legal-admins' }, 'group'),
  'immutable fields are real drift',
);

const authenticationStrengthA = {
  grantControls: { authenticationStrength: { id: 'strength-AAA' } },
};
const authenticationStrengthB = {
  grantControls: { authenticationStrength: { id: 'strength-BBB' } },
};
assert.notEqual(
  canonicalHash(authenticationStrengthA, 'conditionalAccessPolicy'),
  canonicalHash(authenticationStrengthB, 'conditionalAccessPolicy'),
  'nested authentication-strength ids are configuration references and must remain drift',
);

const topLevelIdA = { id: 'strength-AAA' };
const topLevelIdB = { id: 'strength-BBB' };
assert.equal(
  canonicalHash(topLevelIdA, 'conditionalAccessPolicy'),
  canonicalHash(topLevelIdB, 'conditionalAccessPolicy'),
  'top-level ids remain server-owned and must converge',
);

const orderedA = {
  displayName: 'Finance Admins',
  conditions: { includeUsers: ['ana'], excludeGroups: ['legacy'] },
};
const orderedB = {
  conditions: { excludeGroups: ['legacy'], includeUsers: ['ana'] },
  displayName: 'Finance Admins',
};
assert.equal(canonicalHash(orderedA, 'group'), canonicalHash(orderedB, 'group'));

const nestedA = {
  nested: { z: 3, a: 1 },
  array: [{ z: 'second', a: 'first' }, { b: 2, a: 1 }],
};
const nestedB = {
  array: [{ a: 'first', z: 'second' }, { a: 1, b: 2 }],
  nested: { a: 1, z: 3 },
};
assert.deepEqual(canonicalize(nestedA, 'group'), canonicalize(nestedB, 'group'));
assert.equal(canonicalHash(nestedA, 'group'), canonicalHash(nestedB, 'group'));

assert.equal(
  canonicalHash({ '@odata.etag': 'root-etag', nested: { '@odata.etag': 'nested-etag', value: 'same' } }, 'group'),
  canonicalHash({ '@odata.etag': 'other-root-etag', nested: { '@odata.etag': 'other-nested-etag', value: 'same' } }, 'group'),
);

console.log('canonicalHash.test.mjs — all assertions passed');
