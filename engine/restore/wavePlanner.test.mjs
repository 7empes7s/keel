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
assert.ok(patches.length > 0);
for (const patch of patches) {
  assert.ok(patch.naturalKey);
  assert.ok(patch.field);
  assert.ok(patch.symbol);
}

console.log('wavePlanner.test.mjs — all assertions passed');
