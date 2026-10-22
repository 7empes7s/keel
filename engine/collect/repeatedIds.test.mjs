import { strict as assert } from 'node:assert';
import { collectWithOutcomes, dropRepeatedIds } from './entraAdapter.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';

// Issue #438: the beta Exchange role reads returned the same object on more
// than one page. The repeats collided in the canonicalizer and failed every
// hourly collect. Fixtures only; no tenant is read.

// Exact repeats are dropped; key order does not make two copies different.
{
  const { items, conflicts } = dropRepeatedIds([
    { id: 'a', name: 'one', scope: { x: 1, y: 2 } },
    { id: 'b', name: 'two' },
    { scope: { y: 2, x: 1 }, name: 'one', id: 'a' },
    { name: 'no id' },
    { name: 'no id' },
  ]);
  assert.deepEqual(items.map((i) => i.id ?? null), ['a', 'b', null, null]);
  assert.deepEqual(conflicts, []);
}

// A repeat with different content is kept and reported.
{
  const { items, conflicts } = dropRepeatedIds([{ id: 'a', v: 1 }, { id: 'a', v: 2 }, { id: 'a', v: 1 }]);
  assert.deepEqual(items, [{ id: 'a', v: 1 }, { id: 'a', v: 2 }]);
  assert.deepEqual(conflicts, ['a']);
}

const assignment = {
  id: '4fba087b-301f-4aa1-96d1-dfe7b985590a',
  roleDefinitionId: 'b1c2d3e4-0000-4000-8000-000000000001',
  principalId: '/RoleGroups/KEEL-RT-Exchange',
  directoryScopeId: '/', appScopeId: null,
};
const otherAssignment = { ...assignment, id: '1eadf23a-6728-4332-b66c-5b94fce6bb69' };
const definition = { id: 'e731bb7f-0000-4000-8000-000000000002', displayName: 'KEEL-RT-Role', isBuiltIn: false };

function readerFor(fixtures) {
  return {
    async collect(version, path) {
      const items = fixtures.get(path.split('?')[0]);
      return { items: structuredClone(items ?? []), pages: 2, status: 200, error: null };
    },
  };
}

// Exact repeats across pages: the kind completes with each object once, and
// the canonicalizer no longer throws.
{
  const { collected, coverageDigest } = await collectWithOutcomes(readerFor(new Map([
    ['/roleManagement/exchange/roleAssignments', [assignment, otherAssignment, assignment, otherAssignment]],
    ['/roleManagement/exchange/roleDefinitions', [definition, definition]],
  ])), { tenantId: 'fixture-tenant' });
  assert.equal(coverageDigest.exchangeRoleAssignment.outcome, 'complete');
  assert.equal(coverageDigest.exchangeRoleAssignment.itemCount, 2);
  assert.equal(coverageDigest.exchangeRoleDefinition.itemCount, 1);
  const resources = canonicalizeAll(collected);
  assert.deepEqual(
    resources.filter((r) => r.resourceType === 'exchangeRoleAssignment').map((r) => r.naturalKey).sort(),
    [`exchangeRoleAssignment:${otherAssignment.id}`, `exchangeRoleAssignment:${assignment.id}`],
  );
}

// Repeats that differ: only that kind fails; the rest of the collect stays
// complete and canonicalizes.
{
  const { collected, coverageDigest } = await collectWithOutcomes(readerFor(new Map([
    ['/roleManagement/exchange/roleAssignments', [assignment, { ...assignment, directoryScopeId: '/Users/other' }]],
    ['/roleManagement/exchange/roleDefinitions', [definition]],
  ])), { tenantId: 'fixture-tenant' });
  assert.notEqual(coverageDigest.exchangeRoleAssignment.outcome, 'complete');
  assert.match(coverageDigest.exchangeRoleAssignment.error, /different objects under one id: 4fba087b/);
  assert.equal(Object.fromEntries(collected).exchangeRoleAssignment, undefined);
  assert.equal(coverageDigest.exchangeRoleDefinition.outcome, 'complete');
  assert.doesNotThrow(() => canonicalizeAll(collected));
}

console.log('repeatedIds.test.mjs — all assertions passed');
