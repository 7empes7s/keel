/** "Not set up yet": a control fails with reason not-configured when the setting it
 * looks for does not exist at all, and fails plainly when it exists but is wrong.
 * Shown with the legacy-authentication control. Pure: no database. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { defineObservation } from '../contracts/observation.mjs';
import { evaluateControl } from './evaluate.mjs';
import { NOT_CONFIGURED, registerControl, registerPredicate } from './registry.mjs';

const TENANT = 'sha256:block-legacy-test';
const NOW = new Date('2026-10-22T12:00:00.000Z');
const CONTROL = 'keel-custom.conditional-access.block-legacy';

function check(policies, controlId = CONTROL, resourceType = 'conditionalAccessPolicy') {
  const endedAt = new Date(NOW.getTime() - 60_000).toISOString();
  return evaluateControl({
    controlId,
    tenantRef: TENANT,
    now: NOW,
    observations: {
      [resourceType]: {
        observation: defineObservation({
          tenantRef: TENANT, observationId: `obs-${resourceType}`, resourceType,
          window: { startedAt: endedAt, endedAt }, sourceBuild: 'test-build', completeness: 'complete',
          evidenceLevel: 'fixture-tested',
        }),
        resources: policies,
      },
    },
  });
}

const policy = (id, state, clientAppTypes, builtInControls = ['block']) => ({
  id, displayName: `KEEL-RT-${id}`, state,
  conditions: { clientAppTypes, users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] } },
  grantControls: { operator: 'OR', builtInControls },
});

test('no policy blocks legacy sign-in: fails as not set up yet', () => {
  const result = check([policy('mfa', 'enabled', ['all'], ['mfa'])]);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.reason, NOT_CONFIGURED);
});

test('no Conditional Access policy at all: not set up yet', () => {
  const result = check([]);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.reason, NOT_CONFIGURED);
});

test('an enabled policy that blocks both legacy client types passes', () => {
  const result = check([policy('legacy', 'enabled', ['exchangeActiveSync', 'other'])]);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.reason, null);
});

test('a report-only, off or half policy fails, and is not "not set up"', () => {
  for (const policies of [
    [policy('legacy', 'enabledForReportingButNotEnforced', ['exchangeActiveSync', 'other'])],
    [policy('legacy', 'disabled', ['exchangeActiveSync', 'other'])],
    [policy('legacy', 'enabled', ['exchangeActiveSync'])],
  ]) {
    const result = check(policies);
    assert.equal(result.verdict, 'fail');
    assert.equal(result.reason, null);
  }
});

test('a missing read is still could not check, never not set up', () => {
  const result = evaluateControl({ controlId: CONTROL, tenantRef: TENANT, now: NOW, observations: {} });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.reason, 'conditionalAccessPolicy:no-observation');
});

test('only a fail may carry the not-configured reason', () => {
  registerPredicate('test.not-configured-pass', () => ({ verdict: 'pass', reason: NOT_CONFIGURED }));
  registerControl({
    controlId: 'test.not-configured-pass', title: 'Test', description: 'Test only.',
    framework: 'test', edition: '1', profile: 'default', evaluatorVersion: 1,
    requiredObservations: [{ resourceType: 'group', maxAgeMs: 3_600_000 }],
    predicate: { name: 'test.not-configured-pass', args: {} },
  });
  assert.throws(() => check([], 'test.not-configured-pass', 'group'), /predicate must return|only a fail may give a reason/);
});
