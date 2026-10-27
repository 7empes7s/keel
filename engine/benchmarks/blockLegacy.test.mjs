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

const policy = (id, state, clientAppTypes, builtInControls = ['block'], includeUsers = ['All'], includeApplications = ['All']) => ({
  id, displayName: `KEEL-RT-${id}`, state,
  conditions: { clientAppTypes, users: { includeUsers, excludeUsers: [] }, applications: { includeApplications } },
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

test('a block that covers only some users or apps fails, and is not "not set up"', () => {
  for (const policies of [
    [policy('legacy', 'enabled', ['exchangeActiveSync', 'other'], ['block'], ['user-1'])],
    [policy('legacy', 'enabled', ['exchangeActiveSync', 'other'], ['block'], ['All'], ['00000002-0000-0ff1-ce00-000000000000'])],
  ]) {
    const result = check(policies);
    assert.equal(result.verdict, 'fail');
    assert.equal(result.reason, null);
  }
});

test('a block for all users with break-glass accounts left out passes', () => {
  const legacy = policy('legacy', 'enabled', ['exchangeActiveSync', 'other']);
  legacy.conditions.users.excludeUsers = ['break-glass-1'];
  assert.equal(check([legacy]).verdict, 'pass');
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

// The live shape (2026-10-27): one blocking policy is report-only, the enabled one
// covers only some users. Each must be named on the page, with what it misses.
test('a fail lists every blocking policy, line by line, with what it misses', () => {
  const reportOnly = policy('20260908-report', 'enabledForReportingButNotEnforced', ['exchangeActiveSync', 'other']);
  const someUsers = policy('20260908', 'enabled', ['exchangeActiveSync', 'other', 'browser'], ['block'], ['3f2c9d1e-user']);
  const unrelated = policy('mfa', 'enabled', ['all'], ['mfa']);
  const result = check([reportOnly, someUsers, unrelated]);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.reason, null);
  assert.equal(result.details.length, 8);
  assert.deepEqual(result.detailCounts, { checked: 8, failing: 2 });
  // Failing lines first.
  assert.deepEqual(result.details.slice(0, 2).map((line) => [line.subject, line.setting, line.value, line.expected, line.ok]), [
    ['KEEL-RT-20260908-report', 'state', 'enabledForReportingButNotEnforced', 'enabled', false],
    ['KEEL-RT-20260908', 'includeUsers', 'Only some', 'All', false],
  ]);
  const subjects = new Set(result.details.map((line) => line.subject));
  assert.deepEqual([...subjects].sort(), ['KEEL-RT-20260908', 'KEEL-RT-20260908-report']);
  for (const name of subjects) {
    assert.deepEqual(result.details.filter((line) => line.subject === name).map((line) => line.setting).sort(),
      ['clientAppTypes', 'includeApplications', 'includeUsers', 'state']);
  }
  // Only the legacy client types are listed, and no user, group or app id reaches a line.
  const clients = result.details.find((line) => line.subject === 'KEEL-RT-20260908' && line.setting === 'clientAppTypes');
  assert.deepEqual(clients.value, ['exchangeActiveSync', 'other']);
  assert.equal(clients.ok, true);
  assert.ok(!JSON.stringify(result.details).includes('3f2c9d1e-user'));
});

test('a block on one legacy client type for some apps says which', () => {
  const half = policy('half', 'enabled', ['other'], ['block'], ['All'], ['00000002-0000-0ff1-ce00-000000000000']);
  const result = check([half]);
  assert.equal(result.verdict, 'fail');
  const misses = result.details.filter((line) => !line.ok).map((line) => [line.setting, line.value]);
  assert.deepEqual(misses, [['includeApplications', 'Only some'], ['clientAppTypes', ['other']]]);
  assert.ok(!JSON.stringify(result.details).includes('00000002'));
});

test('a pass lists only the policy that blocks legacy sign-in', () => {
  const reportOnly = policy('report', 'enabledForReportingButNotEnforced', ['exchangeActiveSync', 'other']);
  const enforced = policy('legacy', 'enabled', ['exchangeActiveSync', 'other']);
  const result = check([reportOnly, enforced]);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.details.length, 4);
  assert.ok(result.details.every((line) => line.subject === 'KEEL-RT-legacy' && line.ok));
});

test('not set up yet has no lines: there is no policy to name', () => {
  const result = check([policy('mfa', 'enabled', ['all'], ['mfa'])]);
  assert.equal(result.details, null);
});

test('a rule for groups, roles or nobody says so without naming them', () => {
  const lineFor = (users, apps = ['All']) => {
    const legacy = policy('scoped', 'enabled', ['exchangeActiveSync', 'other'], ['block'], [], apps);
    Object.assign(legacy.conditions.users, users);
    const details = check([legacy]).details;
    return [details.find((line) => line.setting === 'includeUsers').value, details.find((line) => line.setting === 'includeApplications').value];
  };
  assert.deepEqual(lineFor({ includeGroups: ['group-1'] }), ['Only some', 'All']);
  assert.deepEqual(lineFor({ includeRoles: ['role-1'] }), ['Only some', 'All']);
  assert.deepEqual(lineFor({ includeGuestsOrExternalUsers: { guestOrExternalUserTypes: 'b2bCollaborationGuest' } }), ['Only some', 'All']);
  assert.deepEqual(lineFor({ includeUsers: ['None'] }, ['None']), ['None', 'None']);
});
