// Q43 step 49: a drift that renamed a Conditional Access policy made the plan a
// `create` (Graph 400, duplicate) because the natural key is the display name and
// the renamed live object no longer matched the snapshot key. A same-tenant
// restore matches live objects by object id first, so the rename is one `update`
// that puts the name back. A cross-tenant restore keeps the natural key.
import { strict as assert } from 'node:assert';
import { buildReconciliationPlan } from './reconciliationPlan.mjs';
import { DELETED_ITEM_ROUTES } from './liveState.mjs';
import { catalogEntryFor, catalogReadPath } from '../../tools/tenant-probe/catalog.mjs';

const policiesPath = catalogReadPath(catalogEntryFor('conditionalAccessPolicy'));
const deletedPoliciesPath = DELETED_ITEM_ROUTES.conditionalAccessPolicy.list;

function reader({ policies = [] }) {
  return {
    async collect(version, path) {
      assert.equal(version, 'v1.0');
      if (path === policiesPath) return { items: policies, error: null };
      if (path === deletedPoliciesPath) return { items: [], error: null };
      throw new Error(`unexpected collection: ${path}`);
    },
  };
}

const snapshotPolicy = {
  id: 'ca-block-legacy', displayName: 'Block legacy authentication', state: 'enabled',
  conditions: { clientAppTypes: ['exchangeActiveSync', 'other'] }, grantControls: { operator: 'OR', builtInControls: ['block'] },
};
const renamedLive = { ...snapshotPolicy, displayName: 'Block legacy authentication (renamed by drift)' };
const snapshotKey = 'conditionalAccessPolicy:Block legacy authentication';
const liveKey = `conditionalAccessPolicy:${renamedLive.displayName}`;

const snapshot = [{
  naturalKey: snapshotKey, resourceType: 'conditionalAccessPolicy', payload: snapshotPolicy,
  references: [], blastRadius: 'tenant-lockout', restorePriority: 100,
}];
// The live tenant canonicalized: the renamed object carries the live (renamed) key.
const targetResources = [{
  naturalKey: liveKey, resourceType: 'conditionalAccessPolicy', sourceId: renamedLive.id, payload: renamedLive, references: [],
}];

// Same tenant: one update of the snapshot resource, no create.
{
  const plan = await buildReconciliationPlan(reader({ policies: [renamedLive] }), snapshot, { targetResources, sameTenant: true });
  const verbs = plan.resources.map((resource) => resource.verb);
  assert.deepEqual(verbs, ['update'], 'a renamed policy is updated in place, never created beside itself');
  assert.equal(plan.resources[0].naturalKey, snapshotKey);
  assert.equal(plan.resources[0].targetId, 'ca-block-legacy');
  assert.equal(plan.resources[0].payload.displayName, 'Block legacy authentication', 'the update carries the snapshot name back');
  assert.equal(plan.resources[0].live.payload.displayName, renamedLive.displayName);
  assert.ok(!verbs.includes('create'));
}

// Same tenant, id written in another case: still matched.
{
  const upper = { ...renamedLive, id: renamedLive.id.toUpperCase() };
  const plan = await buildReconciliationPlan(reader({ policies: [upper] }), snapshot, {
    targetResources: [{ ...targetResources[0], sourceId: upper.id, payload: upper }], sameTenant: true,
  });
  assert.equal(plan.resources[0].verb, 'update');
}

// Cross tenant: ids differ between tenants, so the natural key decides. A live
// object that happens to share the id but not the name is not the same policy.
{
  const plan = await buildReconciliationPlan(reader({ policies: [renamedLive] }), snapshot, { targetResources, sameTenant: false });
  assert.equal(plan.resources[0].verb, 'create', 'cross-tenant restore plans by natural key');
  const sameName = { ...snapshotPolicy, id: 'other-tenant-id' };
  const byName = await buildReconciliationPlan(reader({ policies: [sameName] }), snapshot, {
    targetResources: [{ naturalKey: snapshotKey, resourceType: 'conditionalAccessPolicy', sourceId: sameName.id, payload: sameName, references: [] }],
    sameTenant: false,
  });
  assert.equal(byName.resources[0].verb, 'noop');
  assert.equal(byName.resources[0].targetId, 'other-tenant-id');
}

console.log('renameDrift.test.mjs — all assertions passed');
