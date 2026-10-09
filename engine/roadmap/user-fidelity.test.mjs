/**
 * Roadmap task-150: users are restored in place (reviewed attributes, a deleted
 * user with the same id) and licences are put back add-only, for users and for
 * groups. Every test drives the production applyWave() or reconciliation plan
 * against the in-memory fake Graph; nothing here touches a tenant.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import { OPERATIONS, capabilityFor } from '../coverage/capabilities.mjs';
import { buildOperationLedger, qualificationFor } from '../coverage/qualification.mjs';
import { buildReconciliationPlan } from '../reconcile/reconciliationPlan.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import {
  USER_WRITABLE_FIELDS, assignLicenseBody, changedUserFields, directLicences, licencePlan,
} from '../restore/userOperations.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const PROOF = 'engine/roadmap/user-fidelity.test.mjs';
const E3 = '6fd2c87f-b296-42f0-b197-1e91e994b900';
const VISIO = 'c5928f49-12ba-48f7-ada3-0d743a3601d5';
const PLAN = '57ff2da0-773e-42df-b2af-ffb7a2317929';
const FINANCE = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';

const snapshot = Object.freeze({
  id: 'u-1', userPrincipalName: 'ada@contoso.example', displayName: 'Ada Lovelace', accountEnabled: true,
  department: 'Finance', jobTitle: 'Analyst', usageLocation: 'GB', businessPhones: ['+44 20 0000 0000'], onPremisesSyncEnabled: null,
  passwordProfile: { password: 'never-sent' },
  assignedLicenses: [{ skuId: E3, disabledPlans: [PLAN] }, { skuId: VISIO, disabledPlans: [] }],
  licenseAssignmentStates: [
    { skuId: E3, disabledPlans: [PLAN], assignedByGroup: null, state: 'Active' },
    { skuId: VISIO, disabledPlans: [], assignedByGroup: FINANCE, state: 'Active' },
  ],
});

/** fakeGraph plus the method, path and body of every write. */
function recordingGraph({ readOverride = null } = {}) {
  const graph = fakeGraph();
  const bodies = [];
  const write = graph.write.bind(graph);
  const read = graph.read.bind(graph);
  graph.write = async (version, path, request) => {
    bodies.push({ method: request.method, path, body: request.body });
    return write(version, path, request);
  };
  graph.read = async (version, path) => {
    const result = await read(version, path);
    return readOverride && result.ok ? { ...result, body: readOverride(result.body) } : result;
  };
  graph.bodies = bodies;
  return graph;
}

function immediateTimers(t) {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => original(fn, 0, ...args);
  t.after(() => { globalThis.setTimeout = original; });
}

function plannedUserUpdate(graph, desired, live) {
  graph.objects.set(`/users/${live.id}`, live);
  return {
    naturalKey: `user:${desired.userPrincipalName}`, resourceType: 'user', verb: 'update', payload: desired,
    references: [], blastRadius: 'access-affecting', targetId: live.id,
    live: { state: 'present', targetId: live.id, payload: live },
  };
}

const run = (graph, wave, options = {}) => applyWave(graph, governor, wave, { targetTenant: 'fixture', mode: 'enforce', ...options });

// ------------------------------------------------------------------ registry

test('user update and soft-delete restore are fixture-tested; create and delete stay unsupported', () => {
  for (const operation of OPERATIONS) {
    const capability = capabilityFor('user', operation);
    if (operation === 'update' || operation === 'restore-soft-deleted') {
      assert.equal(capability.claim, 'fixture-tested', operation);
      assert.equal(capability.proofRef, PROOF);
    } else {
      assert.equal(capability.claim, 'unsupported', operation);
    }
  }
  assert.equal(qualificationFor('user').expansion.status, 'qualified-subset');
  const row = buildOperationLedger().types.find((entry) => entry.resourceType === 'user');
  assert.equal(row.decision, 'automated');
  for (const forbidden of ['accountEnabled', 'passwordProfile', 'userPrincipalName', 'mail', 'onPremisesImmutableId', 'assignedLicenses']) {
    assert.ok(!USER_WRITABLE_FIELDS.includes(forbidden), `${forbidden} is never PATCHed`);
  }
});

// ------------------------------------------------------------------ update

test('update PATCHes only the changed reviewed attributes, then assigns the missing direct licence', async () => {
  const graph = recordingGraph();
  const live = {
    ...snapshot, department: 'Sales', passwordProfile: undefined,
    assignedLicenses: [{ skuId: VISIO, disabledPlans: [] }],
    licenseAssignmentStates: [{ skuId: VISIO, disabledPlans: [], assignedByGroup: FINANCE, state: 'Active' }],
  };
  const result = await run(graph, [plannedUserUpdate(graph, snapshot, live)]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [
    { method: 'PATCH', path: '/users/u-1', body: { department: 'Finance' } },
    { method: 'POST', path: '/users/u-1/assignLicense', body: { addLicenses: [{ skuId: E3, disabledPlans: [PLAN] }], removeLicenses: [] } },
  ]);
  assert.deepEqual(result.applied[0].changes, { fields: ['department'], addLicences: [E3], manual: [] });
});

test('a licence is never removed, and an inherited one is never assigned directly', () => {
  // Live holds an extra licence and lacks the group-inherited one: nothing to add.
  const live = { ...snapshot, licenseAssignmentStates: [snapshot.licenseAssignmentStates[0], { skuId: 'extra', disabledPlans: [], assignedByGroup: null }] };
  assert.deepEqual(licencePlan(snapshot, live).add, []);
  assert.deepEqual([...directLicences(snapshot).keys()], [E3.toLowerCase()]);
  assert.deepEqual(assignLicenseBody([{ skuId: E3, disabledPlans: [] }]).removeLicenses, []);
  // Different disabled plans on a direct licence are put back.
  const replanned = { ...snapshot, licenseAssignmentStates: [{ ...snapshot.licenseAssignmentStates[0], disabledPlans: [] }] };
  assert.deepEqual(licencePlan(snapshot, replanned).add, [{ skuId: E3, disabledPlans: [PLAN] }]);
  // An older snapshot without assignment states compares no licences at all.
  const { licenseAssignmentStates: _states, ...older } = snapshot;
  assert.deepEqual(licencePlan(older, { ...live, licenseAssignmentStates: [] }), { add: [], note: 'licences not compared: the snapshot predates licence assignment states' });
});

test('an attribute the snapshot never captured is not cleared', () => {
  const { department: _department, ...older } = snapshot;
  assert.deepEqual(changedUserFields(older, { ...snapshot, department: 'Sales' }), []);
  assert.deepEqual(changedUserFields(snapshot, { ...snapshot, businessPhones: ['+44 20 0000 0000'] }), []);
});

test('a synced user is refused before any write', async () => {
  const graph = recordingGraph();
  const live = { ...snapshot, department: 'Sales', onPremisesSyncEnabled: true };
  const result = await run(graph, [plannedUserUpdate(graph, snapshot, live)]);
  assert.equal(graph.bodies.length, 0);
  assert.match(result.skipped[0].reason, /onPremisesSyncEnabled=true/);
});

test('whether an account is enabled is reported, never written', async () => {
  const graph = recordingGraph();
  const result = await run(graph, [plannedUserUpdate(graph, { ...snapshot, accountEnabled: false }, { ...snapshot })], { mode: 'dry-run' });
  assert.deepEqual(result.applied[0].changes, { fields: [], addLicences: [], manual: ['accountEnabled'] });
  const enforced = recordingGraph();
  await run(enforced, [plannedUserUpdate(enforced, { ...snapshot, accountEnabled: false, jobTitle: 'Lead' }, { ...snapshot })]);
  assert.deepEqual(enforced.bodies.map((write) => write.body), [{ jobTitle: 'Lead' }]);
});

test('a usage location is never cleared', () => {
  assert.deepEqual(changedUserFields({ ...snapshot, usageLocation: null }, snapshot), []);
});

test('a deleted synced user is refused on the snapshot\'s evidence, and a restored one that turns out synced is not written', async () => {
  let graph = recordingGraph();
  const synced = { ...snapshot, onPremisesSyncEnabled: true };
  graph.deleted.set('u-1', { path: '/users/u-1', body: { id: 'u-1', userPrincipalName: snapshot.userPrincipalName } });
  let result = await run(graph, [{
    naturalKey: 'user:ada', resourceType: 'user', verb: 'restore-soft-deleted', payload: synced, references: [], targetId: 'u-1', deletedItemId: 'u-1',
    live: { state: 'soft-deleted', targetId: 'u-1', deletedItemId: 'u-1', payload: { id: 'u-1', userPrincipalName: snapshot.userPrincipalName } },
  }]);
  assert.equal(graph.bodies.length, 0);
  assert.match(result.skipped[0].reason, /on-premises Active Directory/);

  graph = recordingGraph();
  graph.deleted.set('u-1', { path: '/users/u-1', body: { ...snapshot, jobTitle: null, onPremisesImmutableId: 'abc==' } });
  result = await run(graph, [{ naturalKey: 'user:ada', resourceType: 'user', verb: 'restore-soft-deleted', payload: snapshot, references: [], targetId: 'u-1', deletedItemId: 'u-1' }]);
  assert.deepEqual(graph.bodies.map((write) => write.path), ['/directory/deletedItems/u-1/restore']);
  assert.match(result.failed[0].error, /synced from on-premises AD/);
});

test('a direct licence verifies against its own assignment state, not the merged list', async () => {
  // Live: the licence inherited from a group with no disabled plans; the snapshot also held it directly.
  const graph = recordingGraph();
  const live = {
    ...snapshot,
    assignedLicenses: [{ skuId: E3, disabledPlans: [] }],
    licenseAssignmentStates: [{ skuId: E3, disabledPlans: [], assignedByGroup: FINANCE, state: 'Active' }],
  };
  graph.objects.set('/users/u-1', live);
  // The fake keeps the merged entry at the snapshot's plans; a real tenant shows the union. Model that.
  const read = graph.read.bind(graph);
  graph.read = async (version, path) => {
    const result = await read(version, path);
    return result.ok ? { ...result, body: { ...result.body, assignedLicenses: [{ skuId: E3, disabledPlans: [] }] } } : result;
  };
  const result = await run(graph, [{
    naturalKey: 'user:ada', resourceType: 'user', verb: 'update', payload: snapshot, references: [], targetId: 'u-1',
    live: { state: 'present', targetId: 'u-1', payload: live },
  }]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied[0].changes.addLicences, [E3]);
});

test('a user already matching the snapshot is not written, and a dry run sends nothing', async () => {
  let graph = recordingGraph();
  let result = await run(graph, [plannedUserUpdate(graph, snapshot, { ...snapshot })]);
  assert.deepEqual(result.failed, []);
  assert.equal(graph.bodies.length, 0);

  graph = recordingGraph();
  result = await run(graph, [plannedUserUpdate(graph, snapshot, { ...snapshot, jobTitle: 'Intern', licenseAssignmentStates: [] })], { mode: 'dry-run' });
  assert.equal(graph.bodies.length, 0);
  assert.deepEqual(result.applied[0].changes, { fields: ['jobTitle'], addLicences: [E3], manual: [] });
});

test('an attribute or licence that does not read back as written fails with it named', async (t) => {
  immediateTimers(t);
  const graph = recordingGraph({ readOverride: (body) => ({ ...body, department: 'Sales', assignedLicenses: [], licenseAssignmentStates: [] }) });
  const result = await run(graph, [plannedUserUpdate(graph, snapshot, { ...snapshot, department: 'Sales', licenseAssignmentStates: [] })]);
  assert.match(result.failed[0].error, /post-state: department, licence 6fd2c87f/);
});

test('a licence without a usage location fails and says so', async () => {
  const graph = recordingGraph();
  const { usageLocation: _location, ...noLocation } = snapshot;
  const result = await run(graph, [plannedUserUpdate(graph, noLocation, { ...noLocation, licenseAssignmentStates: [] })]);
  assert.match(result.failed[0].error, /assignLicense failed/);
});

// ------------------------------------------------------------------ restore

test('a deleted user is restored with the same id, then its attributes and licences are put back', async () => {
  const graph = recordingGraph();
  graph.deleted.set('u-1', { path: '/users/u-1', body: { ...snapshot, jobTitle: null, assignedLicenses: [], licenseAssignmentStates: [] } });
  const resource = {
    naturalKey: 'user:ada@contoso.example', resourceType: 'user', verb: 'restore-soft-deleted', payload: snapshot,
    references: [], targetId: 'u-1', deletedItemId: 'u-1',
  };
  const result = await run(graph, [resource]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((write) => `${write.method} ${write.path}`), [
    'POST /directory/deletedItems/u-1/restore', 'PATCH /users/u-1', 'POST /users/u-1/assignLicense',
  ]);
  assert.deepEqual(graph.bodies[1].body, { jobTitle: 'Analyst' });
  assert.equal(graph.objects.get('/users/u-1').id, 'u-1');
});

test('a restore that returns a different id fails before any attribute is written', async () => {
  const graph = recordingGraph();
  graph.deleted.set('u-1', { path: '/users/u-2', body: { ...snapshot, id: 'u-2' } });
  const result = await run(graph, [{ naturalKey: 'user:ada', resourceType: 'user', verb: 'restore-soft-deleted', payload: snapshot, references: [], targetId: 'u-1', deletedItemId: 'u-1' }]);
  assert.match(result.failed[0].error, /different objectId/);
  assert.equal(graph.bodies.length, 1);
});

test('create stays refused: a user cannot be rebuilt without its credentials', async () => {
  const graph = recordingGraph();
  const result = await run(graph, [{ naturalKey: 'user:ada', resourceType: 'user', verb: 'create', payload: snapshot, references: [] }]);
  assert.match(result.failed[0].error, /unsupported operation: user create/);
  assert.equal(graph.bodies.length, 0);
});

// ------------------------------------------------------------------ groups and the plan

test('a group update puts back its own missing licence, add-only', async () => {
  const graph = recordingGraph();
  const desired = { id: 'g-1', displayName: 'Finance', mailNickname: 'finance', mailEnabled: false, securityEnabled: true, groupTypes: [], assignedLicenses: [{ skuId: E3, disabledPlans: [] }] };
  const live = { ...desired, assignedLicenses: [] };
  graph.objects.set('/groups/g-1', live);
  const result = await run(graph, [{
    naturalKey: 'group:finance', resourceType: 'group', verb: 'update', payload: desired, references: [], targetId: 'g-1',
    live: { state: 'present', targetId: 'g-1', payload: live },
  }]);
  assert.deepEqual(result.failed, []);
  const licence = graph.bodies.find((write) => write.path === '/groups/g-1/assignLicense');
  assert.deepEqual(licence.body, { addLicenses: [{ skuId: E3, disabledPlans: [] }], removeLicenses: [] });
  assert.ok(!('assignedLicenses' in graph.bodies.find((write) => write.method === 'PATCH').body), 'licences are never PATCHed');
});

test('a group update without a live read checks the licences first and sends none it already holds', async () => {
  const graph = recordingGraph();
  const desired = { id: 'g-1', displayName: 'Finance', mailNickname: 'finance', mailEnabled: false, securityEnabled: true, groupTypes: [], assignedLicenses: [{ skuId: E3, disabledPlans: [] }] };
  graph.objects.set('/groups/g-1', { ...desired, displayName: 'Drifted' });
  const result = await run(graph, [{ naturalKey: 'group:finance', resourceType: 'group', verb: 'update', payload: desired, references: [], targetId: 'g-1' }]);
  assert.deepEqual(result.failed, []);
  assert.ok(!graph.bodies.some((write) => write.path.endsWith('/assignLicense')));
});

function readerFor(collections) {
  return {
    async collect(_version, path) {
      const base = path.split('?')[0];
      return { items: collections[base] ?? [], error: null };
    },
  };
}

test('the plan updates a user or group whose only difference is a missing licence', async () => {
  const liveUser = { ...snapshot, licenseAssignmentStates: [snapshot.licenseAssignmentStates[1]], assignedLicenses: [snapshot.assignedLicenses[1]] };
  assert.equal(canonicalHash(liveUser, 'user'), canonicalHash(snapshot, 'user'), 'licences are outside the hash');
  const group = { id: 'g-1', displayName: 'Finance', mailNickname: 'finance', assignedLicenses: [{ skuId: E3, disabledPlans: [] }] };
  const plan = await buildReconciliationPlan(readerFor({
    '/users': [liveUser],
    '/groups': [{ ...group, assignedLicenses: [] }],
  }), [
    { naturalKey: 'user:ada@contoso.example', resourceType: 'user', payload: snapshot, references: [] },
    { naturalKey: 'group:finance', resourceType: 'group', payload: group, references: [] },
  ]);
  const byType = new Map(plan.resources.map((resource) => [resource.resourceType, resource]));
  assert.equal(byType.get('user').verb, 'update');
  assert.match(byType.get('user').verbReason, /licences differ: 6fd2c87f/);
  assert.equal(byType.get('group').verb, 'update');

  const same = await buildReconciliationPlan(readerFor({ '/users': [{ ...snapshot }] }), [
    { naturalKey: 'user:ada@contoso.example', resourceType: 'user', payload: snapshot, references: [] },
  ]);
  assert.equal(same.resources[0].verb, 'noop');
});
