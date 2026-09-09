import { strict as assert } from 'node:assert';
import { phaseOneResources, planWaves } from './wavePlanner.mjs';

function res(naturalKey, refs, restorePriority = 100) {
  return { naturalKey, restorePriority,
    references: refs.map((symbol) => ({ field: `ref-to-${symbol}`, symbol, required: true })) };
}

const a = res('testResourceA:1', ['testResourceB:1']);
const b = res('testResourceB:1', ['testResourceA:1']);
const leaf = res('group:FIN-Admins', []);

const { waves, patches } = planWaves([a, b, leaf]);
assert.equal(waves.flat().length, 3);
// The broken edge's reference must show up as a deferred patch, not silently
// dropped — the wave planner still has to apply it, just later.
assert.ok(patches.length > 0);
for (const patch of patches) {
  assert.ok(patch.naturalKey);
  assert.ok(patch.field);
  assert.ok(patch.symbol);
}

// The planner carries immutable metadata for phase one. Omitting an array
// edge does not mutate the source payload or discard a sibling edge.
const cyclicPolicy = {
  naturalKey: 'conditionalAccessPolicy:Protect-Admins', resourceType: 'conditionalAccessPolicy', restorePriority: 100,
  payload: {
    conditions: { users: { excludeGroups: ['source-group-a', 'source-group-b'], includeUsers: ['break-glass'] } },
  },
  references: [
    { field: 'conditions.users.excludeGroups[0]', symbol: 'group:Admins', required: true },
    { field: 'conditions.users.excludeGroups[1]', symbol: 'group:Operators', required: true },
  ],
};
const cyclicGroup = {
  naturalKey: 'group:Admins', resourceType: 'group', restorePriority: 100,
  payload: { displayName: 'Admins', parentGroupId: 'source-policy-id' },
  references: [{ field: 'parentGroupId', symbol: 'conditionalAccessPolicy:Protect-Admins', required: true }],
};
const sourcePayload = structuredClone(cyclicPolicy.payload);
const cyclicPlan = planWaves([cyclicPolicy, cyclicGroup]);
const deferred = cyclicPlan.patches.find((patch) => patch.naturalKey === cyclicPolicy.naturalKey);
assert.ok(deferred);
assert.equal(Object.isFrozen(deferred), true);
assert.equal(Object.isFrozen(deferred.reference), true);
assert.equal(deferred.sourceValue, 'source-group-a');
const [phaseOnePolicy] = phaseOneResources([cyclicPolicy], cyclicPlan.patches);
assert.deepEqual(phaseOnePolicy.payload, {
  conditions: { users: { excludeGroups: ['source-group-b'], includeUsers: ['break-glass'] } },
});
assert.deepEqual(phaseOnePolicy.references, [
  { field: 'conditions.users.excludeGroups[0]', symbol: 'group:Operators', required: true },
]);
assert.deepEqual(cyclicPolicy.payload, sourcePayload);

console.log('wavePlanner.test.mjs — all assertions passed');
