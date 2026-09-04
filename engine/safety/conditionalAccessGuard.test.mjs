import { strict as assert } from 'node:assert';
import { enforceReportOnly } from './conditionalAccessGuard.mjs';

// The dangerous direction: a source policy that was ENABLED must never reach
// the write payload as enabled. This is the one assertion that matters most —
// deliberately checked against a source state that is NOT already report-only,
// so a no-op guard would fail this test (fixtures must diverge).
const enabledSource = { displayName: 'Require-MFA', state: 'enabled' };
assert.equal(enforceReportOnly(enabledSource).state, 'enabledForReportingButNotEnforced');

const alreadyDisabled = { displayName: 'Old-Policy', state: 'disabled' };
assert.equal(enforceReportOnly(alreadyDisabled).state, 'enabledForReportingButNotEnforced');

// Every other field passes through unchanged.
const result = enforceReportOnly({ displayName: 'X', state: 'enabled', conditions: { foo: 1 } });
assert.equal(result.displayName, 'X');
assert.deepEqual(result.conditions, { foo: 1 });

// Override requires BOTH a reason and a signer — a partial override must
// throw, not silently fall through to enforcement.
assert.throws(() => enforceReportOnly(enabledSource, { override: { reason: 'ok' } }));
assert.throws(() => enforceReportOnly(enabledSource, { override: { signedBy: 'op' } }));
const overridden = enforceReportOnly(enabledSource, { override: { reason: 'operator-approved', signedBy: 'marouane' } });
assert.equal(overridden.state, 'enabled');

console.log('conditionalAccessGuard.test.mjs — all assertions passed');
