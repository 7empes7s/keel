// Issue #641: every key the live-gate plan prints for `keel-restore --select` must be a
// key the restore's candidate set holds. A snapshot stores each object under
// `<type>:<natural key>` (canonicalizeAll), so a bare type name or fixture name is
// refused with "selected key is not present in the candidate set".
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSTANT_KEY_TYPES, ID_KEY_TYPES } from '../../engine/cir/naturalKey.mjs';
import { canonicalizeAll } from '../../engine/cir/canonicalize.mjs';
import { dependencyClosure } from '../../engine/restore/selection.mjs';
import { buildLiveGatePlan, restoreKeyFor, FIXTURE_PREFIX } from './live-gate-plan.mjs';

const plan = buildLiveGatePlan();
const selectOf = (step) => step.commands.map((command) => command.match(/--select '([^']*)'/)?.[1]).find(Boolean) ?? null;
const fixtureOf = (step) => step.commands.map((command) => command.match(/--fixture '([^']*)'/)?.[1]).find(Boolean) ?? null;
const isPlaceholder = (key) => key.startsWith('<');

test('every type-keyed singleton is selected as <type>:<type>, the key its snapshot holds', () => {
  const singletons = plan.steps.filter((step) => CONSTANT_KEY_TYPES.has(step.resourceType));
  assert.ok(singletons.length > 10, 'the plan has type-keyed singleton steps');
  for (const step of singletons) {
    const expected = `${step.resourceType}:${step.resourceType}`;
    assert.equal(step.key, expected, step.id);
    if (selectOf(step) !== null) assert.equal(selectOf(step), expected, `${step.id}: --select`);
    assert.equal(fixtureOf(step), expected, `${step.id}: --fixture`);
    // The key is the one canonicalization gives the tenant's one object, so the
    // restore's selection finds it.
    const resources = canonicalizeAll([[step.resourceType, [{ id: 'singleton-id' }]]]);
    assert.equal(resources[0].naturalKey, expected, `${step.id}: snapshot key`);
    assert.doesNotThrow(() => dependencyClosure(resources, [step.key]), step.id);
  }
});

test('accessReviewPolicy (the case in #641) prints the key the restore accepts', () => {
  const step = plan.steps.find((candidate) => candidate.resourceType === 'accessReviewPolicy' && candidate.operation === 'update');
  assert.ok(step, 'the plan has the accessReviewPolicy update step');
  assert.equal(selectOf(step), 'accessReviewPolicy:accessReviewPolicy');
  const resources = canonicalizeAll([['accessReviewPolicy', [{ id: 'accessReviewPolicy', isGroupOwnerManagementEnabled: false }]]]);
  assert.throws(() => dependencyClosure(resources, ['accessReviewPolicy']), /not present in the candidate set/);
  assert.doesNotThrow(() => dependencyClosure(resources, [selectOf(step)]));
});

test('every concrete key the plan prints is typed; descriptions stay placeholders', () => {
  for (const step of plan.steps) {
    assert.equal(typeof step.key, 'string', `${step.id}: key`);
    if (isPlaceholder(step.key)) continue;
    const type = step.resourceType.split('#')[0];
    assert.ok(step.key.startsWith(`${type}:`), `${step.id}: ${step.key} starts ${type}:`);
    if (selectOf(step) !== null) assert.equal(selectOf(step), step.key, `${step.id}: --select`);
    assert.equal(fixtureOf(step), step.key, `${step.id}: --fixture`);
  }
});

test('named fixtures, edges and the enforcement step carry their type', () => {
  assert.equal(restoreKeyFor('group', `${FIXTURE_PREFIX}-group`), `group:${FIXTURE_PREFIX}-group`);
  // An edge is restored through its parent group.
  assert.equal(restoreKeyFor('group#member', `${FIXTURE_PREFIX}-group`), `group:${FIXTURE_PREFIX}-group`);
  const enforcement = plan.steps.find((step) => step.resourceType === 'conditionalAccessPolicy' && step.commands.some((command) => command.includes('--enforce-conditional-access')));
  assert.ok(enforcement, 'the plan has the enforcement step');
  assert.ok(enforcement.commands[0].includes(`--policy 'conditionalAccessPolicy:${FIXTURE_PREFIX}-ca'`), enforcement.commands[0]);
  const resources = canonicalizeAll([['group', [{ id: 'g1', displayName: `${FIXTURE_PREFIX}-group`, mailNickname: `${FIXTURE_PREFIX}-group` }]]]);
  assert.doesNotThrow(() => dependencyClosure(resources, [restoreKeyFor('group', `${FIXTURE_PREFIX}-group`)]));
});

test('a singleton keyed by a name Graph decides is never guessed', () => {
  for (const type of ['authorizationPolicy', 'authenticationMethodsPolicy', 'crossTenantAccessPolicy']) {
    assert.ok(isPlaceholder(restoreKeyFor(type, type)), type);
  }
  assert.ok(isPlaceholder(restoreKeyFor('groupLifecyclePolicy', 'the policy id KEEL shows')));
});

test('an id-keyed kind is never selected by its fixture name', () => {
  // The snapshot keys these by Graph id (a role definition by its template id),
  // so `<type>:<fixture name>` would be refused exactly like the bare name in #641.
  const idKeyed = plan.steps.filter((step) => ID_KEY_TYPES.has(step.resourceType.split('#')[0]) || step.resourceType === 'roleDefinition');
  assert.ok(idKeyed.length > 0, 'the plan has id-keyed steps');
  for (const step of idKeyed) assert.ok(isPlaceholder(step.key), `${step.id}: ${step.key}`);
  assert.ok(isPlaceholder(restoreKeyFor('deviceCategory', `${FIXTURE_PREFIX}-category`)));
  const resources = canonicalizeAll([['deviceCategory', [{ id: 'cat-guid', displayName: `${FIXTURE_PREFIX}-category` }]]]);
  assert.equal(resources[0].naturalKey, 'deviceCategory:cat-guid');
});
