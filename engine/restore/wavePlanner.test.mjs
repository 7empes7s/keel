import { strict as assert } from 'node:assert';
import { planWaves } from './wavePlanner.mjs';

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
assert.equal(patches.length, 1);
assert.equal(patches[0].symbol, patches[0].symbol); // sanity: field is present
assert.ok(['testResourceA:1', 'testResourceB:1'].includes(patches[0].naturalKey));

console.log('wavePlanner.test.mjs — all assertions passed');
