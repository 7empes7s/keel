import { strict as assert } from 'node:assert';
import { M1_TYPES } from '../collect/entraAdapter.mjs';
import {
  fieldClass,
  IMMUTABLE,
  SERVER_OWNED,
  SERVER_OWNED_ALWAYS,
} from './serverOwned.mjs';

for (const resourceType of M1_TYPES) {
  assert.ok(SERVER_OWNED.has(resourceType), `missing server-owned entry for ${resourceType}`);
  assert.ok(IMMUTABLE.has(resourceType), `missing immutable entry for ${resourceType}`);
}

assert.deepEqual(SERVER_OWNED_ALWAYS, new Set([
  'id', 'createdDateTime', 'modifiedDateTime', 'deletedDateTime', 'renewedDateTime',
]));
assert.equal(fieldClass('id', 'user'), 'serverOwned');
assert.equal(fieldClass('nested.modifiedDateTime', 'namedLocation'), 'writable');
assert.equal(fieldClass('nested.id', 'conditionalAccessPolicy'), 'writable');
assert.equal(fieldClass('conditions.@odata.type', 'conditionalAccessPolicy'), 'serverOwned');
assert.equal(fieldClass('mailNickname', 'group'), 'immutable');
assert.equal(fieldClass('nested.mailNickname', 'group'), 'writable');
assert.equal(fieldClass('mailEnabled', 'group'), 'immutable');
assert.equal(fieldClass('securityEnabled', 'group'), 'immutable');
assert.equal(fieldClass('groupTypes', 'group'), 'immutable');
assert.equal(fieldClass('displayName', 'group'), 'writable');
assert.throws(() => fieldClass('displayName', 'unknown'), /unknown resourceType/);

console.log('serverOwned.test.mjs — all assertions passed');
