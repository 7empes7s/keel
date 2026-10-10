import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { snapshotSignInPath } from './signInPathGate.mjs';
import {
  GLOBAL_ADMINISTRATOR_TEMPLATE_ID, globalAdministratorPrincipalIds, isGlobalAdministratorAssignment,
} from './protectedPrincipals.mjs';

const GA = GLOBAL_ADMINISTRATOR_TEMPLATE_ID;
const READER = 'f2ef992c-3afb-46b9-b7cf-a126ee74c451'; // Global Reader template id
const users = ['user', [
  { id: 'u-admin', userPrincipalName: 'admin@contoso.test' },
  { id: 'u-reader', userPrincipalName: 'reader@contoso.test' },
]];
const assignments = ['roleAssignment', [
  { id: 'ra-admin', roleDefinitionId: GA, principalId: 'u-admin', directoryScopeId: '/' },
  { id: 'ra-reader', roleDefinitionId: READER, principalId: 'u-reader', directoryScopeId: '/' },
]];

test('a live collection that includes role definitions keys Global Administrator by its definition id, and still matches', () => {
  const resources = canonicalizeAll([users, assignments, ['roleDefinition', [
    { id: GA, templateId: GA, displayName: 'Global Administrator' },
    { id: READER, templateId: READER, displayName: 'Global Reader' },
  ]]]);
  const admin = resources.find((r) => r.sourceId === 'ra-admin');
  // The key format a live collection produces; the old display-text filter never matched it.
  assert.equal(admin.naturalKey, `roleAssignment:roleDefinition:${GA}@user:admin@contoso.test@/`);
  assert.equal(admin.naturalKey.includes('GlobalAdministrator'), false);
  assert.deepEqual(globalAdministratorPrincipalIds(resources), ['u-admin']);
});

test('a collection without role definitions keeps the global symbol, and matches', () => {
  const resources = canonicalizeAll([users, assignments]);
  assert.equal(resources.find((r) => r.sourceId === 'ra-admin').naturalKey, 'roleAssignment:global:GlobalAdministrator@user:admin@contoso.test@/');
  assert.deepEqual(globalAdministratorPrincipalIds(resources), ['u-admin']);
});

test('the sign-in path gate gets a non-empty protected list from a live-format collection', async () => {
  const resources = canonicalizeAll([users, assignments, ['roleDefinition', [{ id: GA, templateId: GA }]]]);
  const reader = {
    async collect() { return { items: [] }; },
    async get() { return { ok: true, status: 200, body: { accountEnabled: true } }; },
  };
  await assert.doesNotReject(() => snapshotSignInPath(reader, { protectedPrincipalIds: globalAdministratorPrincipalIds(resources) }));
  await assert.rejects(() => snapshotSignInPath(reader, { protectedPrincipalIds: [] }), /at least one protected principal/);
});

test('legacy display-text keys still match; other roles, other types and principal names never do', () => {
  const ra = (naturalKey, payload = {}) => ({ resourceType: 'roleAssignment', naturalKey, payload });
  assert.equal(isGlobalAdministratorAssignment(ra('roleAssignment:GlobalAdministrator:break-glass')), true);
  assert.equal(isGlobalAdministratorAssignment(ra('roleAssignment:GlobalAdministrator@group:Finance@/')), true);
  assert.equal(isGlobalAdministratorAssignment(ra('roleAssignment:unknown:x@user:a@/', { roleDefinitionId: GA.toUpperCase() })), true);
  assert.equal(isGlobalAdministratorAssignment(ra(`roleAssignment:roleDefinition:${READER}@user:a@/`)), false);
  assert.equal(isGlobalAdministratorAssignment(ra(`roleAssignment:roleDefinition:${READER}@group:GlobalAdministrators@/`)), false);
  assert.equal(isGlobalAdministratorAssignment({ resourceType: 'group', naturalKey: `group:${GA}`, payload: {} }), false);
  assert.deepEqual(globalAdministratorPrincipalIds([
    ra(`roleAssignment:roleDefinition:${GA}@user:a@/`, { principalId: 'p1' }),
    ra(`roleAssignment:roleDefinition:${GA}@user:a@/administrativeUnits/x`, { principalId: 'p1' }),
    ra(`roleAssignment:roleDefinition:${GA}@user:b@/`, {}),
  ]), ['p1']);
});
