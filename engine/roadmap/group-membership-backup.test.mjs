/**
 * Group membership backup: every scheduled collection reads each group's
 * direct members and owners beside the group, so the snapshot holds what a
 * restore needs to put a group's membership back.
 *
 * Fixture reader and isolated test database only; no tenant is read or written.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { collectSnapshot } from '../collect/snapshot.mjs';
import { loadSnapshotRelationships } from '../collect/relationships.mjs';
import { planRelationshipOperations } from '../restore/relationshipWriter.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { COLLECT_RELATIONSHIPS, describeGroupMembershipReads, runCollect } from '../../cli/keel-collect.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const GROUP = '11111111-1111-1111-1111-111111111111';
const ALICE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const ok = (items) => ({ items, pages: 1, status: 200, capped: false, error: null });

function fixtureReader({ ownersFail = false } = {}) {
  const calls = [];
  return {
    calls,
    async collect(version, path) {
      calls.push(path);
      if (path === '/groups' || path.startsWith('/groups?')) {
        return ok([{ id: GROUP, displayName: 'Finance', mailNickname: 'finance' }]);
      }
      if (path === '/users' || path.startsWith('/users?')) {
        return ok([
          { id: ALICE, displayName: 'Alice', userPrincipalName: 'alice@contoso.example' },
          { id: BOB, displayName: 'Bob', userPrincipalName: 'bob@contoso.example' },
        ]);
      }
      if (path === `/groups/${GROUP}/members?$select=id`) {
        return ok([
          { id: ALICE, '@odata.type': '#microsoft.graph.user' },
          { id: BOB, '@odata.type': '#microsoft.graph.user' },
        ]);
      }
      if (path === `/groups/${GROUP}/owners?$select=id`) {
        if (ownersFail) return { items: undefined, pages: 0, status: 403, capped: false, error: { status: 403, code: 'Authorization_RequestDenied' } };
        return ok([{ id: ALICE, '@odata.type': '#microsoft.graph.user' }]);
      }
      return ok([]);
    },
  };
}

test('every scheduled backup reads group members and owners beside policy assignments', () => {
  assert.deepEqual([...COLLECT_RELATIONSHIPS.families].sort(), ['assignment', 'member', 'owner']);
  assert.ok(!COLLECT_RELATIONSHIPS.families.includes('transitiveMember'), 'the derived nested set is not backed up as direct membership');
});

test('a backup records each group\'s members and owners by natural key, and a restore re-adds a removed member', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(schemaSql());
  const tenantRef = 'sha256:group-membership-backup';
  const reader = fixtureReader();

  const result = await collectSnapshot(client, { reader, tenantRef, tenantId: 'tid', relationships: COLLECT_RELATIONSHIPS });
  assert.equal(result.coverageDigest.group.outcome, 'complete');
  assert.deepEqual(result.relationshipsByFamily.member, { complete: 1 });
  assert.deepEqual(result.relationshipsByFamily.owner, { complete: 1 });

  const sets = await loadSnapshotRelationships(client, { snapshotId: result.snapshotId, families: ['member', 'owner'] });
  const members = sets.get('group:finance|member');
  const owners = sets.get('group:finance|owner');
  assert.equal(members?.outcome, 'complete', JSON.stringify([...sets.keys()]));
  assert.deepEqual(members.targets.map((target) => target.targetNaturalKey).sort(),
    ['user:alice@contoso.example', 'user:bob@contoso.example']);
  assert.deepEqual(owners.targets.map((target) => target.targetNaturalKey), ['user:alice@contoso.example']);

  // Bob was removed from the live group after the backup: restoring the group
  // from this snapshot plans exactly one member add, and nothing else.
  const live = new Map([
    ['group:finance|member', { outcome: 'complete', targets: [{ targetId: ALICE }] }],
    ['group:finance|owner', { outcome: 'complete', targets: [{ targetId: ALICE }] }],
  ]);
  const ids = new Map([['user:alice@contoso.example', ALICE], ['user:bob@contoso.example', BOB]]);
  const plan = planRelationshipOperations({
    parents: [{ naturalKey: 'group:finance', verb: 'update', liveTargetId: GROUP }],
    desired: sets,
    live,
    resolveTargetId: (naturalKey) => ids.get(naturalKey) ?? null,
  });
  assert.deepEqual(plan.refusals, []);
  assert.deepEqual(plan.operations, [
    { parentNaturalKey: 'group:finance', family: 'member', action: 'add', targetNaturalKey: 'user:bob@contoso.example', targetId: BOB },
  ]);
});

test('a failed owner read is kept as failed, never as an empty owner list, and does not change the group\'s outcome', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(schemaSql());
  const tenantRef = 'sha256:group-membership-owner-failure';

  const result = await collectSnapshot(client, { reader: fixtureReader({ ownersFail: true }), tenantRef, tenantId: 'tid', relationships: COLLECT_RELATIONSHIPS });
  assert.equal(result.coverageDigest.group.outcome, 'complete');
  assert.deepEqual(result.relationshipsByFamily.owner, { failed: 1 });
  const sets = await loadSnapshotRelationships(client, { snapshotId: result.snapshotId, families: ['owner'] });
  assert.equal(sets.get('group:finance|owner')?.outcome, 'failed');

  const plan = planRelationshipOperations({
    parents: [{ naturalKey: 'group:finance', verb: 'update', liveTargetId: GROUP }],
    desired: sets,
    live: new Map([['group:finance|owner', { outcome: 'complete', targets: [{ targetId: ALICE }] }]]),
  });
  assert.deepEqual(plan.operations, [], 'a failed backup read never removes the live owners');
});

test('collection logs group member and owner read counts, naming the permission on failure', async () => {
  assert.equal(describeGroupMembershipReads(null), null);
  assert.equal(describeGroupMembershipReads({ assignment: { complete: 2 } }), null);
  assert.equal(describeGroupMembershipReads({ member: { complete: 3, 'complete-empty': 1 }, owner: { complete: 4 } }),
    'group member and owner reads: 8 complete, 0 partial, 0 failed');
  assert.match(describeGroupMembershipReads({ member: { complete: 1 }, owner: { failed: 2 } }), /2 failed .*GroupMember\.Read\.All/);

  const lines = [];
  await runCollect({
    config: { tenantId: 'fixture-tenant' },
    dbUrl: 'postgres://fixture',
    dependencies: {
      connect: async () => ({ end: async () => {} }),
      getToken: async () => ({ accessToken: 'fixture-token' }),
      GraphReader: class {},
      collectSnapshot: async (_client, options) => {
        assert.equal(options.relationships, COLLECT_RELATIONSHIPS);
        return {
          snapshotId: 'fixture-snapshot',
          coverageDigest: { group: { outcome: 'complete', itemCount: 1 } },
          relationships: { complete: 3 },
          relationshipsByFamily: { assignment: { complete: 1 }, member: { complete: 1 }, owner: { complete: 1 } },
        };
      },
    },
    logger: { log: (line) => lines.push(line), error() {} },
  });
  assert.ok(lines.includes('policy assignment reads: 1 complete, 0 partial, 0 failed, 0 not supported'), lines.join('\n'));
  assert.ok(lines.includes('group member and owner reads: 2 complete, 0 partial, 0 failed'), lines.join('\n'));
});
