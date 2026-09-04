import { strict as assert } from 'node:assert';
import { evaluatePromotion } from './simulationGate.mjs';

function fakeWriter(policyApplies) {
  return { whatIf: async () => [{ id: 'p1', displayName: 'Require-MFA', policyApplies,
    grantControls: policyApplies ? { builtInControls: ['block'] } : null }] };
}

const matrix = [
  { label: 'global-admin', userId: 'ga-1' },
  { label: 'standard-user', userId: 'std-1' },
  { label: 'break-glass-1', userId: 'bg-1' },
];

// Safe case: no policy blocks anyone, including break-glass.
const safe = await evaluatePromotion(fakeWriter(false), { principalMatrix: matrix, breakGlassUserIds: ['bg-1'] });
assert.equal(safe.allowed, true);

// Dangerous case: the policy set would block a break-glass account. This is a
// HARD failure with NO override parameter — the function signature has none,
// by design (spec §10.3: "no override").
const blocked = await evaluatePromotion(fakeWriter(true), { principalMatrix: matrix, breakGlassUserIds: ['bg-1'] });
assert.equal(blocked.allowed, false);
assert.match(blocked.reason, /bg-1/);

console.log('simulationGate.test.mjs — all assertions passed');
