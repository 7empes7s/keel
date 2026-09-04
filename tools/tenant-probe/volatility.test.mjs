import { strict as assert } from 'node:assert';
import { volatilePaths } from './volatility.mjs';

const collectionA = new Map([
  ['group', [
    { id: 'stable-group', displayName: 'Finance Admins', modifiedDateTime: '2026-09-04T00:00:00Z' },
    { id: 'removed-group', displayName: 'Legal Admins' },
  ]],
]);
const collectionB = new Map([
  ['group', [
    { id: 'stable-group', displayName: 'Finance Admins', modifiedDateTime: '2026-09-04T00:01:00Z' },
    { id: 'added-group', displayName: 'HR Admins' },
  ]],
]);

const paths = volatilePaths(collectionA, collectionB);
assert.ok(paths.get('group').has('modifiedDateTime'));
assert.ok(!paths.get('group').has('displayName'));

console.log('volatility.test.mjs — all assertions passed');
