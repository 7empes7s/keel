import { strict as assert } from 'node:assert';
import { buildReconciliationPlan } from './reconciliationPlan.mjs';
import { planDeletionWaves } from '../restore/wavePlanner.mjs';

const groupPath = '/groups?$select=id,displayName,mailNickname,groupTypes,securityEnabled,mailEnabled,membershipRule,membershipRuleProcessingState,onPremisesSyncEnabled,isAssignableToRole,visibility,createdDateTime';
const deletedGroupPath = '/directory/deletedItems/microsoft.graph.group';
const roleAssignmentPath = '/roleManagement/directory/roleAssignments';

function reader({ groups = [], deletedGroups = [], roleAssignments = [] }) {
  return {
    async collect(version, path) {
      assert.equal(version, 'v1.0');
      if (path === groupPath) return { items: groups, error: null };
      if (path === deletedGroupPath) return { items: deletedGroups, error: null };
      if (path === roleAssignmentPath) return { items: roleAssignments, error: null };
      throw new Error(`unexpected collection: ${path}`);
    },
  };
}

const desired = (naturalKey, payload) => ({
  naturalKey,
  resourceType: 'group',
  payload,
  references: [],
  blastRadius: 'access-affecting',
  restorePriority: 100,
});

const current = {
  id: 'target-finance-id', displayName: 'Finance changed', mailNickname: 'finance', description: 'drift',
};
const removed = {
  id: 'deleted-hr-id', displayName: 'HR', mailNickname: 'hr', deletedDateTime: '2026-09-08T00:00:00Z',
};
const equal = {
  id: 'target-ops-id', displayName: 'Ops', mailNickname: 'ops',
};

const plan = await buildReconciliationPlan(reader({
  groups: [current, equal],
  deletedGroups: [removed],
}), [
  desired('group:finance', { displayName: 'Finance', mailNickname: 'finance' }),
  desired('group:added', null),
  desired('group:hr', { displayName: 'HR', mailNickname: 'hr' }),
  desired('group:ops', { displayName: 'Ops', mailNickname: 'ops' }),
]);

const byKey = new Map(plan.resources.map((resource) => [resource.naturalKey, resource]));
assert.equal(byKey.get('group:finance').verb, 'update');
assert.equal(byKey.get('group:finance').targetId, 'target-finance-id');
assert.deepEqual(byKey.get('group:finance').live.payload, current);

assert.equal(byKey.get('group:added').verb, 'noop', 'desired absence remains a no-op until an added object is live');

assert.equal(byKey.get('group:hr').verb, 'restore-soft-deleted');
assert.equal(byKey.get('group:hr').targetId, 'deleted-hr-id');
assert.equal(byKey.get('group:hr').deletedItemId, 'deleted-hr-id');
assert.deepEqual(byKey.get('group:hr').live.payload, removed);

assert.equal(byKey.get('group:ops').verb, 'noop');
assert.equal(byKey.get('group:ops').targetId, 'target-ops-id');

const addedPlan = await buildReconciliationPlan(reader({
  groups: [{ id: 'target-added-id', displayName: 'Added', mailNickname: 'added' }],
}), [desired('group:added', null)]);
assert.equal(addedPlan.resources[0].verb, 'delete');
assert.equal(addedPlan.resources[0].targetId, 'target-added-id');
assert.deepEqual(addedPlan.resources[0].live.payload, {
  id: 'target-added-id', displayName: 'Added', mailNickname: 'added',
});

const createPlan = await buildReconciliationPlan(reader({ groups: [] }), [
  desired('group:new', { displayName: 'New', mailNickname: 'new' }),
]);
assert.equal(createPlan.resources[0].verb, 'create');

// Added-drift resources do not exist in the baseline and therefore carry no
// source references. Deletion ordering must retain the target resource's
// references: delete the live role assignment before the live group it uses.
{
  const group = { id: 'target-group-id', displayName: 'Finance', mailNickname: 'finance' };
  const assignment = {
    id: 'target-assignment-id', roleDefinitionId: 'global-admin-id',
    principalId: group.id, directoryScopeId: '/',
  };
  const groupKey = 'group:Finance';
  const assignmentKey = 'roleAssignment:GlobalAdministrator@group:Finance@/';
  const deletionPlan = await buildReconciliationPlan(reader({
    groups: [group], roleAssignments: [assignment],
  }), [
    { naturalKey: assignmentKey, resourceType: 'roleAssignment', payload: null, references: [], blastRadius: 'tenant-lockout' },
    { naturalKey: groupKey, resourceType: 'group', payload: null, references: [], blastRadius: 'access-affecting' },
  ], {
    targetResources: [
      { naturalKey: groupKey, resourceType: 'group', sourceId: group.id, payload: group, references: [] },
      {
        naturalKey: assignmentKey, resourceType: 'roleAssignment', sourceId: assignment.id, payload: assignment,
        references: [{ field: 'principalId', symbol: groupKey, required: true }],
      },
    ],
  });
  const byDeletionKey = new Map(deletionPlan.resources.map((resource) => [resource.naturalKey, resource]));
  assert.deepEqual(byDeletionKey.get(assignmentKey).references, [
    { field: 'principalId', symbol: groupKey, required: true },
  ]);
  assert.deepEqual(planDeletionWaves(deletionPlan.resources).waves, [
    [assignmentKey], [groupKey],
  ], 'the role assignment must be deleted before the group it references');
}

console.log('reconciliationPlan.test.mjs — all assertions passed');
