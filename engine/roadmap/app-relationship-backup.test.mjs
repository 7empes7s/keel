/**
 * Full-coverage DESC: every scheduled collection also reads who owns each app
 * and service principal and which application permissions each service
 * principal holds, beside the group edges it already read. The snapshot holds
 * those edges by natural key, together with the nested membership of groups a
 * Conditional Access policy names.
 *
 * Fixture reader and isolated test database only; no tenant is read or written.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { collectSnapshot } from '../collect/snapshot.mjs';
import { loadSnapshotRelationships } from '../collect/relationships.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { COLLECT_RELATIONSHIPS, describeAppPrivilegeReads, runCollect } from '../../cli/keel-collect.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const APP = '11111111-aaaa-aaaa-aaaa-000000000001';
const SP = '22222222-bbbb-bbbb-bbbb-000000000002';
const GRAPH_SP = '33333333-cccc-cccc-cccc-000000000003';
const OUTER = '44444444-dddd-dddd-dddd-000000000004';
const INNER = '55555555-dddd-dddd-dddd-000000000005';
const OWNER = 'aaaaaaaa-0000-0000-0000-000000000001';
const MEMBER = 'aaaaaaaa-0000-0000-0000-000000000002';
const ROLE = '88888888-ffff-ffff-ffff-000000000008';

const ok = (items) => ({ items, pages: 1, status: 200, capped: false, error: null });
const denied = { items: undefined, pages: 0, status: 403, capped: false, error: { status: 403, code: 'Authorization_RequestDenied', error: 'insufficient privileges' } };
const asUser = (id) => ({ id, '@odata.type': '#microsoft.graph.user' });
const asGroup = (id) => ({ id, '@odata.type': '#microsoft.graph.group' });

function fixtureReader({ grantsDenied = false } = {}) {
  const calls = [];
  return {
    calls,
    async collect(version, path) {
      calls.push(path);
      if (path.startsWith('/identity/conditionalAccess/policies')) {
        return ok([{ id: 'ca-1', displayName: 'KEEL-RT-require-mfa', state: 'enabled', conditions: { users: { includeUsers: ['All'], excludeGroups: [OUTER] } }, grantControls: { builtInControls: ['mfa'] } }]);
      }
      if (path === '/groups' || path.startsWith('/groups?')) {
        return ok([
          { id: OUTER, displayName: 'KEEL-RT-exclusions', mailNickname: 'keel-rt-exclusions' },
          { id: INNER, displayName: 'KEEL-RT-nested', mailNickname: 'keel-rt-nested' },
        ]);
      }
      if (path === '/users' || path.startsWith('/users?')) {
        return ok([
          { id: OWNER, displayName: 'KEEL-RT-owner', userPrincipalName: 'keel-rt-owner@contoso.example' },
          { id: MEMBER, displayName: 'KEEL-RT-member', userPrincipalName: 'keel-rt-member@contoso.example' },
        ]);
      }
      if (path === '/applications' || path.startsWith('/applications?')) return ok([{ id: APP, appId: 'app-keel-rt', displayName: 'KEEL-RT-app' }]);
      if (path === '/servicePrincipals' || path.startsWith('/servicePrincipals?')) {
        return ok([
          { id: SP, appId: 'app-keel-rt', displayName: 'KEEL-RT-app' },
          { id: GRAPH_SP, appId: '00000003-0000-0000-c000-000000000000', displayName: 'Microsoft Graph' },
        ]);
      }
      if (path === `/groups/${OUTER}/members?$select=id`) return ok([asGroup(INNER)]);
      if (path === `/groups/${INNER}/members?$select=id`) return ok([asUser(MEMBER)]);
      if (path === `/groups/${OUTER}/transitiveMembers?$select=id`) return ok([asGroup(INNER), asUser(MEMBER)]);
      if (path === `/applications/${APP}/owners?$select=id`) return ok([asUser(OWNER)]);
      if (path === `/servicePrincipals/${SP}/owners?$select=id`) return ok([asUser(OWNER)]);
      if (path === `/servicePrincipals/${SP}/appRoleAssignments`) {
        if (grantsDenied) return denied;
        return ok([{ id: 'grant-1', resourceId: GRAPH_SP, appRoleId: ROLE, principalId: SP, createdDateTime: '2026-10-01T00:00:00Z' }]);
      }
      return ok([]);
    },
  };
}

async function collect(t, tenantRef, options) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(schemaSql());
  const reader = fixtureReader(options);
  const result = await collectSnapshot(client, { reader, tenantRef, tenantId: 'tid', relationships: COLLECT_RELATIONSHIPS });
  return { client, reader, result };
}

test('every scheduled backup reads app and service principal owners and app permission grants', () => {
  for (const family of ['appOwner', 'servicePrincipalOwner', 'appRoleGrant']) {
    assert.ok(COLLECT_RELATIONSHIPS.families.includes(family), family);
  }
  assert.equal(COLLECT_RELATIONSHIPS.conditionalAccessTransitive, true);
});

test('a scheduled backup snapshot holds app owner, service principal owner, app permission and nested membership edges', async (t) => {
  const { client, reader, result } = await collect(t, 'sha256:desc-app-edges');
  assert.equal(result.coverageDigest.application.outcome, 'complete');
  assert.equal(result.coverageDigest.servicePrincipal.outcome, 'complete');
  assert.deepEqual(result.relationshipsByFamily.appOwner, { complete: 1 });
  // Microsoft Graph's own service principal has no owners and no grants: an
  // empty read, recorded as such.
  assert.deepEqual(result.relationshipsByFamily.servicePrincipalOwner, { complete: 1, 'complete-empty': 1 });
  assert.deepEqual(result.relationshipsByFamily.appRoleGrant, { complete: 1, 'complete-empty': 1 });
  assert.deepEqual(result.relationshipsByFamily.transitiveMember, { complete: 1 });
  // Only the group a policy names gets the nested read.
  assert.deepEqual(reader.calls.filter((path) => path.includes('transitiveMembers')), [`/groups/${OUTER}/transitiveMembers?$select=id`]);

  const sets = await loadSnapshotRelationships(client, {
    snapshotId: result.snapshotId, families: ['appOwner', 'servicePrincipalOwner', 'appRoleGrant', 'transitiveMember'],
  });
  const byFamily = (family) => [...sets.values()].filter((set) => set.family === family && set.targets.length > 0);

  const [appOwners] = byFamily('appOwner');
  assert.equal(appOwners.outcome, 'complete');
  assert.equal(appOwners.parentType, 'application');
  assert.deepEqual(appOwners.targets.map((target) => target.targetNaturalKey), ['user:keel-rt-owner@contoso.example']);

  const [spOwners] = byFamily('servicePrincipalOwner');
  assert.equal(spOwners.parentType, 'servicePrincipal');
  assert.equal(spOwners.parentSourceId, SP);
  assert.deepEqual(spOwners.targets.map((target) => target.targetNaturalKey), ['user:keel-rt-owner@contoso.example']);

  const [grants] = byFamily('appRoleGrant');
  assert.equal(grants.parentSourceId, SP);
  assert.deepEqual(grants.targets.map((target) => target.edgeKey), [`${GRAPH_SP}:${ROLE}`]);
  assert.equal(grants.targets[0].targetType, 'servicePrincipal');

  const [nested] = byFamily('transitiveMember');
  assert.equal(nested.parentSourceId, OUTER);
  assert.deepEqual(nested.targets.map((target) => target.targetId).sort(), [INNER, MEMBER].sort());
});

test('a denied permission grant read is kept as failed and does not change the service principal outcome', async (t) => {
  const { client, result } = await collect(t, 'sha256:desc-grants-denied', { grantsDenied: true });
  assert.equal(result.coverageDigest.servicePrincipal.outcome, 'complete');
  assert.deepEqual(result.relationshipsByFamily.appRoleGrant, { failed: 1, 'complete-empty': 1 });
  const sets = await loadSnapshotRelationships(client, { snapshotId: result.snapshotId, families: ['appRoleGrant'] });
  const failed = [...sets.values()].find((set) => set.parentSourceId === SP);
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets, []);
});

test('collection logs app owner and permission grant read counts, naming the permission on failure', async () => {
  assert.equal(describeAppPrivilegeReads(null), null);
  assert.equal(describeAppPrivilegeReads({ member: { complete: 2 } }), null);
  assert.equal(describeAppPrivilegeReads({ appOwner: { complete: 1 }, servicePrincipalOwner: { 'complete-empty': 2 }, appRoleGrant: { complete: 3 } }),
    'app owner and permission grant reads: 6 complete, 0 partial, 0 failed');
  assert.match(describeAppPrivilegeReads({ appRoleGrant: { failed: 2 } }), /2 failed .*Application\.Read\.All/);

  const lines = [];
  await runCollect({
    config: { tenantId: 'fixture-tenant' },
    dbUrl: 'postgres://fixture',
    dependencies: {
      connect: async () => ({ end: async () => {} }),
      getToken: async () => ({ accessToken: 'fixture-token' }),
      GraphReader: class {},
      collectSnapshot: async () => ({
        snapshotId: 'fixture-snapshot',
        coverageDigest: { application: { outcome: 'complete', itemCount: 1 } },
        relationshipsByFamily: { appOwner: { complete: 1 }, servicePrincipalOwner: { complete: 1 }, appRoleGrant: { failed: 1 } },
      }),
    },
    logger: { log: (line) => lines.push(line), error() {} },
  });
  assert.ok(lines.some((line) => line.startsWith('app owner and permission grant reads: 2 complete, 0 partial, 1 failed')), lines.join('\n'));
});
