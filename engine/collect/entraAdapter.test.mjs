import { strict as assert } from 'node:assert';
import { collectM1, M1_TYPES } from './entraAdapter.mjs';

// Task 48's validation runs entirely against fixtures. Keep the collection
// and canonicalization assertions without authenticating to a live tenant.
const userId = '11111111-1111-1111-1111-111111111111';
const orgId = '99999999-9999-9999-9999-999999999999';
const fixtures = new Map([
  ['/organization', [{ id: orgId, displayName: 'Fixture Org' }]],
  ['/users', [{ id: userId, userPrincipalName: 'ana@contoso.test' }]],
  ['/identity/conditionalAccess/policies', [{
    id: '22222222-2222-2222-2222-222222222222',
    displayName: 'Fixture MFA', state: 'enabledForReportingButNotEnforced',
    conditions: { users: { includeUsers: [userId] } },
  }]],
  ['/roleManagement/directory/roleAssignments', [{
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10',
    principalId: userId, directoryScopeId: '/',
  }]],
]);
const requests = [];
const reader = {
  async collect(version, path) {
    requests.push(path);
    return { items: structuredClone(fixtures.get(path.split('?')[0]) ?? []), pages: 1, status: 200, error: null };
  },
};

const collected = await collectM1(reader);
const byType = Object.fromEntries(collected);

// Every M1 type is present, even if empty — a missing key would mean a silent
// skip rather than "the tenant genuinely has zero of these."
for (const type of M1_TYPES) {
  assert.ok(type in byType, `missing type ${type} in collection result`);
  assert.ok(Array.isArray(byType[type]));
}

// Nonempty fixtures must reach the canonicalizer; empty types remain present.
assert.ok(byType.conditionalAccessPolicy.length > 0, 'expected at least 1 CA policy');
assert.ok(byType.roleAssignment.length > 0, 'expected at least 1 role assignment');
assert.equal(requests.length, M1_TYPES.length);
assert.ok(requests.some((path) => path.includes(`/organization/${orgId}/`)),
  'organization-scoped reads use the observed organization id');

// canonicalizeAll must accept this shape without throwing.
const { canonicalizeAll } = await import('../cir/canonicalize.mjs');
const resources = canonicalizeAll(collected);
assert.ok(resources.length >= byType.group.length + byType.roleAssignment.length
  + byType.namedLocation.length + byType.conditionalAccessPolicy.length + byType.user.length);
assert.equal(resources.find((r) => r.resourceType === 'roleAssignment').naturalKey,
  'roleAssignment:global:GlobalAdministrator@user:ana@contoso.test@/');
assert.equal(resources.find((r) => r.resourceType === 'conditionalAccessPolicy')
  .references.find((r) => r.field === 'conditions.users.includeUsers[0]').symbol,
  'user:ana@contoso.test');

console.log(`entraAdapter.test.mjs — collected ${resources.length} resources — all assertions passed`);
