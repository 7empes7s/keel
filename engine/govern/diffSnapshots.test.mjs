import { strict as assert } from 'node:assert';
import { diffSnapshots } from './diffSnapshots.mjs';

const baselineRows = [
  {
    natural_key: 'group:removed',
    resource_type: 'group',
    payload_hash: 'removed-before',
    hash_version: 1,
    blast_radius: 'access-affecting',
  },
  {
    natural_key: 'group:modified',
    resource_type: 'group',
    payload_hash: 'modified-before',
    hash_version: 1,
    blast_radius: 'access-affecting',
  },
  {
    natural_key: 'group:unchanged',
    resource_type: 'group',
    payload_hash: 'unchanged',
    hash_version: 1,
    blast_radius: 'access-affecting',
  },
];

const observedRows = [
  {
    natural_key: 'group:modified',
    resource_type: 'group',
    payload_hash: 'modified-after',
    hash_version: 1,
    blast_radius: 'access-affecting',
  },
  {
    natural_key: 'group:unchanged',
    resource_type: 'group',
    payload_hash: 'unchanged',
    hash_version: 1,
    blast_radius: 'access-affecting',
  },
  {
    natural_key: 'conditionalAccessPolicy:added',
    resource_type: 'conditionalAccessPolicy',
    payload_hash: 'added-after',
    hash_version: 1,
    blast_radius: 'tenant-lockout',
  },
];

assert.deepEqual(diffSnapshots(baselineRows, observedRows), [
  {
    naturalKey: 'group:removed',
    resourceType: 'group',
    changeType: 'removed',
    beforeHash: 'removed-before',
    afterHash: null,
    blastRadius: 'access-affecting',
  },
  {
    naturalKey: 'group:modified',
    resourceType: 'group',
    changeType: 'modified',
    beforeHash: 'modified-before',
    afterHash: 'modified-after',
    blastRadius: 'access-affecting',
  },
  {
    naturalKey: 'conditionalAccessPolicy:added',
    resourceType: 'conditionalAccessPolicy',
    changeType: 'added',
    beforeHash: null,
    afterHash: 'added-after',
    blastRadius: 'tenant-lockout',
  },
]);

assert.throws(
  () => diffSnapshots(
    [{ ...baselineRows[0], natural_key: 'group:hash-version' }],
    [{ ...observedRows[0], natural_key: 'group:hash-version', hash_version: 2 }],
  ),
);

assert.deepEqual(diffSnapshots(baselineRows, baselineRows), []);

console.log('diffSnapshots.test.mjs — all assertions passed');
