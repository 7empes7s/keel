import { strict as assert } from 'node:assert';
import { buildRollbackPlan } from './rollbackPlan.mjs';

const baselineRows = [
  {
    natural_key: 'group:alpha',
    resource_type: 'group',
    payload: { displayName: 'Alpha' },
    blast_radius: 'access-affecting',
  },
  {
    natural_key: 'group:beta',
    resource_type: 'group',
    payload: { displayName: 'Beta' },
    blast_radius: 'access-affecting',
  },
  {
    natural_key: 'group:gamma',
    resource_type: 'group',
    payload: { displayName: 'Gamma' },
    blast_radius: 'access-affecting',
  },
  {
    natural_key: 'group:delta',
    resource_type: 'group',
    payload: { displayName: 'Delta' },
    blast_radius: 'access-affecting',
  },
  {
    natural_key: 'group:epsilon',
    resource_type: 'group',
    payload: { displayName: 'Epsilon' },
    blast_radius: 'access-affecting',
  },
];

// A rollback is scoped to the selected drift row, never the whole baseline.
const scoped = buildRollbackPlan([
  {
    natural_key: 'group:gamma',
    resource_type: 'group',
    change_type: 'modified',
    blast_radius: 'access-affecting',
  },
], baselineRows);
assert.equal(scoped.resources.length, 1);
assert.deepEqual(scoped.resources, [{
  naturalKey: 'group:gamma',
  resourceType: 'group',
  payload: { displayName: 'Gamma' },
  blastRadius: 'access-affecting',
}]);
assert.deepEqual(scoped.expectedVerbs, new Map([['group:gamma', 'update']]));

const plan = buildRollbackPlan([
  {
    natural_key: 'group:alpha',
    resource_type: 'group',
    change_type: 'modified',
    blast_radius: 'access-affecting',
  },
  {
    natural_key: 'group:added',
    resource_type: 'group',
    change_type: 'added',
    blast_radius: 'access-affecting',
  },
  {
    natural_key: 'group:beta',
    resource_type: 'group',
    change_type: 'removed',
    blast_radius: 'access-affecting',
  },
], baselineRows);

assert.deepEqual(plan.resources, [
  {
    naturalKey: 'group:alpha',
    resourceType: 'group',
    payload: { displayName: 'Alpha' },
    blastRadius: 'access-affecting',
  },
  {
    naturalKey: 'group:added',
    resourceType: 'group',
    payload: null,
    blastRadius: 'access-affecting',
  },
  {
    naturalKey: 'group:beta',
    resourceType: 'group',
    payload: { displayName: 'Beta' },
    blastRadius: 'access-affecting',
  },
]);
assert.deepEqual(plan.expectedVerbs, new Map([
  ['group:alpha', 'update'],
  ['group:added', 'delete'],
  ['group:beta', 'create|restore-soft-deleted'],
]));

console.log('rollbackPlan.test.mjs — all assertions passed');
