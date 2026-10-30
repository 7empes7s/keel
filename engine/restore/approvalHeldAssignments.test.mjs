/**
 * Approval-held kinds, batch 2: who holds Intune, Exchange and Defender admin roles,
 * and Intune multi admin approval policies. Driven through the production applyWave
 * path: the users, groups, apps and roles each names are matched in the target by
 * their natural keys, the approval effects name them, and nothing is written without
 * the approval. This file is the remapping proof qualification.mjs records for them.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { withItemReadsForTest } from '../collect/entraAdapter.mjs';
import { remappingFor } from '../coverage/qualification.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';
import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { applyWave } from './applyEngine.mjs';
import { APPROVAL_HELD_KINDS } from './approvalHeld.mjs';

const SOURCE_GROUP = 'aaaaaaaa-0000-0000-0000-000000000001';
const TARGET_GROUP = 'bbbbbbbb-0000-0000-0000-000000000001';
const SOURCE_USER = 'aaaaaaaa-0000-0000-0000-000000000002';
const TARGET_USER = 'bbbbbbbb-0000-0000-0000-000000000002';
const SOURCE_ROLE = 'aaaaaaaa-0000-0000-0000-000000000003';
const TARGET_ROLE = 'bbbbbbbb-0000-0000-0000-000000000003';

const GROUP = 'group:KEEL-RT-helpdesk';
const USER = 'user:ann@contoso.example';
const TARGET_IDS = new Map([[GROUP, TARGET_GROUP], [USER, TARGET_USER]]);
const governor = { async acquire() {}, observeRetryAfter() {} };

const KINDS = {
  deviceManagementRoleAssignment: {
    collection: '/deviceManagement/roleAssignments',
    payload: {
      '@odata.type': '#microsoft.graph.deviceAndAppManagementRoleAssignment', id: 'source-assignment', displayName: 'KEEL-RT-helpdesk admins', description: 'Fixture',
      members: [SOURCE_GROUP], scopeMembers: [], resourceScopes: [SOURCE_GROUP], scopeType: 'resourceScope', roleScopeTagIds: ['0'],
      roleDefinition: { id: SOURCE_ROLE, displayName: 'KEEL-RT-helpdesk role', isBuiltIn: false },
    },
    references: [
      { field: 'members[0]', symbol: GROUP, required: true },
      { field: 'resourceScopes[0]', symbol: GROUP, required: true },
      { field: 'roleDefinition.id', symbol: 'deviceManagementRoleDefinition:KEEL-RT-helpdesk role', required: true },
    ],
    targetIds: [['deviceManagementRoleDefinition:KEEL-RT-helpdesk role', TARGET_ROLE]],
    written: (body) => {
      assert.deepEqual(body.members, [TARGET_GROUP]);
      assert.deepEqual(body.resourceScopes, [TARGET_GROUP]);
      assert.equal(body['roleDefinition@odata.bind'], `https://graph.microsoft.com/beta/deviceManagement/roleDefinitions/${TARGET_ROLE}`);
      assert.equal(body.roleDefinition, undefined, 'the role is sent as its link only');
    },
    shown: { field: 'members', after: `[${JSON.stringify(GROUP)}]` },
  },
  operationApprovalPolicy: {
    collection: '/deviceManagement/operationApprovalPolicies',
    payload: { id: 'source-policy', displayName: 'KEEL-RT-approval', policyType: 'deviceWipe', policyPlatform: 'notApplicable', approverGroupIds: [SOURCE_GROUP] },
    references: [{ field: 'approverGroupIds[0]', symbol: GROUP, required: true }],
    written: (body) => assert.deepEqual(body.approverGroupIds, [TARGET_GROUP]),
    shown: { field: 'approverGroupIds', after: `[${JSON.stringify(GROUP)}]` },
  },
  exchangeRoleAssignment: {
    collection: '/roleManagement/exchange/roleAssignments',
    payload: { id: 'source-exchange', principalId: `/Users/${SOURCE_USER}`, roleDefinitionId: SOURCE_ROLE, directoryScopeId: '/', appScopeId: '/' },
    references: [
      { field: 'principalId', symbol: USER, required: true, prefix: '/Users/' },
      { field: 'roleDefinitionId', symbol: 'exchangeRoleDefinition:fixture', required: true },
    ],
    targetIds: [['exchangeRoleDefinition:fixture', TARGET_ROLE]],
    written: (body) => {
      assert.equal(body.principalId, `/Users/${TARGET_USER}`);
      assert.equal(body.roleDefinitionId, TARGET_ROLE);
    },
    shown: { field: 'principalId', after: USER },
  },
  defenderRoleAssignment: {
    collection: '/roleManagement/defender/roleAssignments',
    payload: {
      id: 'source-defender', displayName: 'KEEL-RT-defender assignment', principalIds: [SOURCE_USER, SOURCE_GROUP],
      roleDefinitionId: SOURCE_ROLE, directoryScopeIds: ['/'], appScopeIds: ['/'],
    },
    references: [
      { field: 'principalIds[0]', symbol: USER, required: true },
      { field: 'principalIds[1]', symbol: GROUP, required: true },
      { field: 'roleDefinitionId', symbol: 'defenderRoleDefinition:fixture', required: true },
    ],
    targetIds: [['defenderRoleDefinition:fixture', TARGET_ROLE]],
    written: (body) => {
      assert.deepEqual([...body.principalIds].sort(), [TARGET_USER, TARGET_GROUP].sort());
      assert.equal(body.roleDefinitionId, TARGET_ROLE);
    },
    shown: { field: 'principalIds', after: `[${[JSON.stringify(GROUP), JSON.stringify(USER)].join(',')}]` },
  },
};

const resourceFor = (kind) => ({
  naturalKey: `${kind}:${KINDS[kind].payload.id}`, resourceType: kind, verb: 'create',
  payload: structuredClone(KINDS[kind].payload), references: KINDS[kind].references,
});

async function restore(kind, { approved = true, graph = fakeGraph(), targetIds = TARGET_IDS } = {}) {
  const resource = resourceFor(kind);
  const result = await applyWave(graph, governor, [resource], {
    targetTenant: 'fixture-tenant', mode: 'enforce',
    existingTargetIds: new Map([...targetIds, ...(KINDS[kind].targetIds ?? [])]),
    approvedContentEffects: approved ? classifyContentEffects([resource]).effects : [],
  });
  const created = [...graph.objects.entries()].filter(([key]) => key.startsWith(`${KINDS[kind].collection}/`)).map(([, body]) => body);
  return { result, created, graph };
}

test('batch 2: the four kinds are approval-held, with a remapping proof for create', () => {
  for (const kind of Object.keys(KINDS)) {
    assert.ok(APPROVAL_HELD_KINDS.includes(kind), kind);
    assert.equal(remappingFor(kind, 'create').qualified, true, kind);
    assert.equal(remappingFor(kind, 'create').proofRef, 'engine/restore/approvalHeldAssignments.test.mjs', kind);
  }
});

test('batch 2: an approved restore writes the target tenant\'s users, groups and roles', async () => {
  for (const kind of Object.keys(KINDS)) {
    const { result, created } = await restore(kind);
    assert.deepEqual(result.failed, [], kind);
    assert.deepEqual(result.skipped, [], kind);
    assert.equal(result.applied.length, 1, kind);
    assert.equal(created.length, 1, kind);
    KINDS[kind].written(created[0]);
  }
});

test('batch 2: the approval names users, groups and roles, never their ids', () => {
  for (const kind of Object.keys(KINDS)) {
    const { effects } = classifyContentEffects([resourceFor(kind)]);
    assert.ok(effects.length > 0, kind);
    assert.ok(effects.every((effect) => effect.effect === 'access-changing'), kind);
    const shown = effects.find((effect) => effect.field === KINDS[kind].shown.field);
    assert.equal(shown?.after, KINDS[kind].shown.after, kind);
    assert.ok(!JSON.stringify(effects).includes(SOURCE_GROUP) && !JSON.stringify(effects).includes(SOURCE_USER), `${kind}: no principal id shown`);
  }
  const intune = classifyContentEffects([resourceFor('deviceManagementRoleAssignment')]).effects.find((effect) => effect.field === 'roleDefinition');
  assert.equal(intune.after, 'deviceManagementRoleDefinition:KEEL-RT-helpdesk role');
});

test('batch 2: without the approval nothing is written', async () => {
  for (const kind of Object.keys(KINDS)) {
    const { result, created } = await restore(kind, { approved: false });
    assert.equal(created.length, 0, kind);
    assert.equal(result.skipped.length, 1, kind);
    assert.match(result.skipped[0].reason, /changes admin access/, kind);
  }
});

test('batch 2: a user or group the target does not have fails the write, and nothing is written', async () => {
  // The Exchange assignment names a user only, so the target lacks its user here.
  for (const kind of Object.keys(KINDS)) {
    const known = kind === 'exchangeRoleAssignment' ? [[GROUP, TARGET_GROUP]] : [[USER, TARGET_USER]];
    const { result, created } = await restore(kind, { targetIds: new Map(known) });
    assert.equal(created.length, 0, kind);
    assert.equal(result.failed.length, 1, kind);
    assert.match(result.failed[0].error, /cannot resolve|not-found-in-target/, kind);
  }
});

test('batch 2: a second restore finds the object the first made and writes nothing', async () => {
  for (const kind of Object.keys(KINDS)) {
    const first = await restore(kind);
    assert.equal(first.created.length, 1, kind);
    const second = await restore(kind, { graph: first.graph });
    assert.equal(second.created.length, 1, `${kind}: no second object`);
    assert.equal(second.result.skipped.length, 1, kind);
    assert.match(second.result.skipped[0].reason, /already there/, kind);
  }
});

test('batch 2: an Exchange role held by a role group is a step for a person', async () => {
  const graph = fakeGraph();
  const resource = { ...resourceFor('exchangeRoleAssignment'), references: [] };
  resource.payload.principalId = '/RoleGroups/aaaaaaaa-0000-0000-0000-00000000000f';
  const result = await applyWave(graph, governor, [resource], {
    targetTenant: 'fixture-tenant', mode: 'enforce', approvedContentEffects: classifyContentEffects([resource]).effects,
  });
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /Exchange role group/);
  assert.equal(graph.writes.length, 0);
});

test('batch 2: an Intune assignment from a backup that does not name its role is a step for a person', async () => {
  const graph = fakeGraph();
  const resource = resourceFor('deviceManagementRoleAssignment');
  delete resource.payload.roleDefinition;
  resource.references = resource.references.filter((ref) => !ref.field.startsWith('roleDefinition'));
  const result = await applyWave(graph, governor, [resource], {
    targetTenant: 'fixture-tenant', mode: 'enforce', existingTargetIds: TARGET_IDS, approvedContentEffects: classifyContentEffects([resource]).effects,
  });
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /does not say which Intune role/);
  assert.equal(graph.writes.length, 0);
});

test('batch 2: a backup names an Exchange principal and an Intune role as references', () => {
  const resources = canonicalizeAll([
    ['user', [{ id: SOURCE_USER, userPrincipalName: 'ann@contoso.example' }]],
    ['group', [{ id: SOURCE_GROUP, displayName: 'KEEL-RT-helpdesk', mailNickname: 'KEEL-RT-helpdesk' }]],
    ['deviceManagementRoleDefinition', [{ id: SOURCE_ROLE, displayName: 'KEEL-RT-helpdesk role', isBuiltIn: false }]],
    ['exchangeRoleAssignment', [{ id: 'x1', principalId: `/Users/${SOURCE_USER}`, roleDefinitionId: '/', directoryScopeId: '/', appScopeId: '/' }]],
    ['deviceManagementRoleAssignment', [{ ...KINDS.deviceManagementRoleAssignment.payload }]],
  ]);
  const exchange = resources.find((resource) => resource.resourceType === 'exchangeRoleAssignment');
  assert.deepEqual(exchange.references.find((ref) => ref.field === 'principalId'), {
    field: 'principalId', symbol: 'user:ann@contoso.example', required: true, klass: 'resolvable', prefix: '/Users/',
  });
  const intune = resources.find((resource) => resource.resourceType === 'deviceManagementRoleAssignment');
  const fields = Object.fromEntries(intune.references.map((ref) => [ref.field, ref.symbol]));
  assert.equal(fields['roleDefinition.id'], 'deviceManagementRoleDefinition:KEEL-RT-helpdesk role');
  assert.equal(fields['members[0]'], 'group:KEEL-RT-helpdesk');
});

test('batch 2: the backup keeps each Intune assignment\'s role as one object with its id and name', async () => {
  const entry = { type: 'deviceManagementRoleAssignment', version: 'beta', itemReads: { as: 'roleDefinition', path: '/x/{item}/roleDefinition', single: true, fields: ['id', 'displayName', 'isBuiltIn'] } };
  const reads = [];
  const reader = {
    async collect(_version, path) {
      reads.push(path);
      if (path.includes('none')) return { items: [], pages: 1 };
      if (path.includes('two')) return { items: [{ id: 'r1' }, { id: 'r2' }], pages: 1 };
      return { items: [{ id: SOURCE_ROLE, displayName: 'Role', isBuiltIn: true, rolePermissions: [{}] }], pages: 1 };
    },
  };
  const items = [{ id: 'a1' }, { id: 'none' }];
  assert.equal((await withItemReadsForTest(reader, entry, items)).error, null);
  assert.deepEqual(items[0].roleDefinition, { id: SOURCE_ROLE, displayName: 'Role', isBuiltIn: true });
  assert.equal('roleDefinition' in items[1], false, 'no role read leaves the field out');
  assert.match((await withItemReadsForTest(reader, entry, [{ id: 'two' }])).error.error, /more than one object/);
});
