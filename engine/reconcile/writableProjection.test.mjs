import { strict as assert } from 'node:assert';
import { immutableDrift, writableProjection } from './writableProjection.mjs';

assert.deepEqual(
  writableProjection({
    id: 'group-id',
    createdDateTime: '2026-09-04T00:00:00Z',
    mailNickname: 'finance-admins',
    displayName: 'Finance Admins',
  }, 'group'),
  { mailNickname: 'finance-admins', displayName: 'Finance Admins' },
);

assert.throws(
  () => writableProjection({ displayName: 'Finance Admins' }, 'unknown'),
  /unknown resourceType/,
);

assert.deepEqual(
  writableProjection({
    '@odata.etag': 'etag',
    displayName: 'Finance Admins',
  }, 'group'),
  { displayName: 'Finance Admins' },
);

assert.deepEqual(
  immutableDrift(
    { mailEnabled: false, displayName: 'Finance Admins' },
    { mailEnabled: true, displayName: 'Finance Admins' },
    'group',
  ),
  ['mailEnabled'],
);

console.log('writableProjection.test.mjs — all assertions passed');
