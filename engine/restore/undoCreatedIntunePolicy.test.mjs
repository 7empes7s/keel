/**
 * Undo of a restore that created an Intune policy, for every Intune record
 * type with a delete. The undo is planned by compensation.mjs from the
 * restore's journal and run through applyWave, as `keel-restore --compensate`
 * does. A compensation run passes no snapshot coverage, so before PR #651 each
 * of these failed with "partial observation cannot authorise delete". Each
 * test drives the production code against an in-memory Graph
 * (engine/test/idoFakeGraph.mjs); nothing here reads or writes a tenant.
 * Fixture names use the KEEL-RT- prefix. App links (mobileAppRelationship)
 * are covered in intuneAppLinks.test.mjs.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { applyWave } from './applyEngine.mjs';
import { applyUndoChoices, compensationDigestInput, planCompensation, undoChoicesOf } from './compensation.mjs';
import { assignmentTarget, readUndoAssignments } from './undoAssignedPolicy.mjs';
import { INTUNE_EXTENDED_RECORDS } from './intuneOperations.mjs';
import { capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const GUARD = { breakGlassUserIds: ['break-glass-1'], keelAppIds: [], caPolicies: [] };
const ID = 'created-1';

// One object per type, as a restore would have created it. The collection is
// where Intune keeps it (an app protection policy lives at its subtype's).
const FIXTURES = Object.freeze({
  deviceCompliancePolicy: { collection: '/deviceManagement/deviceCompliancePolicies', payload: { '@odata.type': '#microsoft.graph.windows10CompliancePolicy', displayName: 'KEEL-RT-undo-compliance' } },
  deviceConfiguration: { collection: '/deviceManagement/deviceConfigurations', payload: { '@odata.type': '#microsoft.graph.windows10GeneralConfiguration', displayName: 'KEEL-RT-undo-config' } },
  configurationPolicy: { collection: '/deviceManagement/configurationPolicies', payload: { name: 'KEEL-RT-undo-catalog', platforms: 'windows10', technologies: 'mdm' } },
  managedAppPolicy: { collection: '/deviceAppManagement/iosManagedAppProtections', payload: { '@odata.type': '#microsoft.graph.iosManagedAppProtection', displayName: 'KEEL-RT-undo-protection' } },
  targetedManagedAppConfiguration: { collection: '/deviceAppManagement/targetedManagedAppConfigurations', payload: { displayName: 'KEEL-RT-undo-app-config' } },
  mobileAppConfiguration: { collection: '/deviceAppManagement/mobileAppConfigurations', payload: { '@odata.type': '#microsoft.graph.iosMobileAppConfiguration', displayName: 'KEEL-RT-undo-device-app-config' } },
  windowsFeatureUpdateProfile: { collection: '/deviceManagement/windowsFeatureUpdateProfiles', payload: { displayName: 'KEEL-RT-undo-feature' } },
  windowsQualityUpdateProfile: { collection: '/deviceManagement/windowsQualityUpdateProfiles', payload: { displayName: 'KEEL-RT-undo-quality' } },
  windowsDriverUpdateProfile: { collection: '/deviceManagement/windowsDriverUpdateProfiles', payload: { displayName: 'KEEL-RT-undo-driver' } },
});

// Every Intune record type that can be deleted, except app links, which are
// deleted only through their app (intuneAppLinks.test.mjs).
const DELETABLE = Object.values(INTUNE_EXTENDED_RECORDS)
  .filter((record) => record.operations.includes('delete') && record.resourceType !== 'mobileAppRelationship')
  .map((record) => record.resourceType)
  .sort();

const created = (type) => {
  const { collection, payload } = FIXTURES[type];
  const object = { ...payload, id: ID };
  return { type, path: `${collection}/${ID}`, object, naturalKey: `${type}:${payload.displayName ?? payload.name}` };
};

// What the promoted restore journaled for the create.
const journaledCreate = ({ type, object, naturalKey }) => ({
  id: 'entry-1', naturalKey, resourceType: type, targetId: ID, blastRadius: 'access-affecting',
  outcome: 'succeeded', outcomeDetail: null, operation: 'create', priorState: null, intendedState: object, postState: object,
});

const undoOf = (item) => planCompensation({
  restoreRef: 'restore-1', entries: [journaledCreate(item)], current: new Map([[item.naturalKey, { targetId: ID, payload: item.object }]]),
});

// As the compensation promotion runs it: no snapshot coverage is passed.
const wave = (graph, resources) => applyWave(graph, governor, resources, {
  targetTenant: 'fixture', mode: 'enforce', existingTargetIds: new Map(), readAfterWriteOptions: { attempts: 1, delayMs: 0 }, deletionGuardOptions: GUARD,
});
const writesOf = (graph) => graph.calls.filter((call) => call.method !== 'GET').map(({ method, path }) => `${method} ${path}`);

test('every Intune record type with a delete has an undo fixture here, and can be created and deleted', () => {
  assert.deepEqual(DELETABLE, Object.keys(FIXTURES).sort(), 'a new deletable Intune type needs a fixture in this file');
  for (const type of DELETABLE) {
    assert.equal(isSupportedClaim(capabilityFor(type, 'create').claim), true, `${type} create`);
    assert.equal(isSupportedClaim(capabilityFor(type, 'delete').claim), true, `${type} delete`);
  }
});

for (const type of Object.keys(FIXTURES)) {
  test(`undo of a restore that created a ${type} deletes it, without a snapshot observation`, async () => {
    const item = created(type);
    const graph = idoFakeGraph({ seed: { [item.path]: item.object } });
    const plan = undoOf(item);
    assert.deepEqual(plan.operations.map((op) => [op.verb, op.undoes, op.targetId]), [['delete', 'create', ID]]);
    assert.deepEqual([plan.conflicts, plan.manual, plan.notApplied], [[], [], []]);

    const outcome = await wave(graph, plan.operations);
    assert.deepEqual(outcome.failed, []);
    assert.deepEqual(outcome.skipped, []);
    assert.deepEqual(outcome.applied.map((entry) => entry.naturalKey), [item.naturalKey]);
    assert.deepEqual(writesOf(graph), [`DELETE ${item.path}`]);
    assert.equal(graph.objects.has(item.path), false);
  });
}

test('an undo of a policy that has assignments (the restore\'s own, or added since) is a plain step, and nothing is deleted', async () => {
  const item = created('deviceConfiguration');
  const graph = idoFakeGraph({ seed: { [item.path]: item.object } });
  await graph.write('v1.0', `${item.path}/assign`, { method: 'POST', body: { assignments: [{ target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }] } });
  graph.calls.length = 0;

  const outcome = await wave(graph, undoOf(item).operations);
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(outcome.applied, []);
  assert.match(outcome.skipped[0].reason, /^manual: the policy is assigned \(1 assignment\)/);
  assert.deepEqual(writesOf(graph), []);
  assert.equal(graph.objects.has(item.path), true);
});

test('only an undo of a create skips the snapshot observation: any other delete still needs it', async () => {
  for (const type of Object.keys(FIXTURES)) {
    const item = created(type);
    const [undo] = undoOf(item).operations;
    for (const [label, resource] of [
      ['a forward delete', { ...undo, undoes: undefined, compensates: undefined }],
      ['an undo that names no journal entry', { ...undo, compensates: [] }],
      ['an undo of an update', { ...undo, undoes: 'update' }],
    ]) {
      const graph = idoFakeGraph({ seed: { [item.path]: item.object } });
      const outcome = await wave(graph, [resource]);
      assert.equal(outcome.applied.length, 0, `${type}: ${label}`);
      assert.match(outcome.failed[0]?.error ?? '', /^partial observation cannot authorise delete/, `${type}: ${label}`);
      assert.deepEqual(writesOf(graph), [], `${type}: ${label}`);
    }
  }
});

test('an object changed after the restore created it is a conflict, and is not deleted', async () => {
  const item = created('windowsFeatureUpdateProfile');
  const changed = { ...item.object, displayName: 'KEEL-RT-undo-feature (renamed)' };
  const plan = planCompensation({
    restoreRef: 'restore-1', entries: [journaledCreate(item)], current: new Map([[item.naturalKey, { targetId: ID, payload: changed }]]),
  });
  assert.deepEqual(plan.operations, []);
  assert.match(plan.conflicts[0].reason, /^concurrent-change: displayName changed after this restore wrote the object/);
});

// ------------------------------------------- an assigned policy: delete it or skip it
// Decided 2026-10-28: the undo of a created policy that is assigned now shows
// the person a choice, delete it (its assignments first) or skip it.

const ALL_DEVICES = { target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } };
const GROUP = (groupId) => ({ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId } });

async function assignedPolicy(type, assignments) {
  const item = created(type);
  const graph = idoFakeGraph({ seed: { [item.path]: item.object } });
  await graph.write('v1.0', `${item.path}/assign`, { method: 'POST', body: { assignments } });
  graph.calls.length = 0;
  return { item, graph };
}

// The collector's read, served from the same in-memory Graph.
const readerOf = (graph) => ({ get: (version, path) => graph.read(version, path) });

for (const type of Object.keys(FIXTURES)) {
  test(`undo of a created ${type} that is assigned now waits for a choice, then deletes it with its assignments when chosen`, async () => {
    const { item, graph } = await assignedPolicy(type, [ALL_DEVICES, GROUP('group-1')]);
    const planned = undoOf(item);
    const assigned = await readUndoAssignments(readerOf(graph), planned.operations);
    assert.deepEqual([...assigned.keys()], [item.naturalKey], `${type}: the assignments are read where the policy keeps them`);

    // No choice yet: held out of the plan, and listed for the person.
    const waiting = applyUndoChoices(planned, { assigned });
    assert.deepEqual(waiting.operations, []);
    assert.deepEqual(waiting.choices.map((entry) => [entry.naturalKey, entry.assignmentCount, entry.choice]), [[item.naturalKey, 2, null]]);
    assert.deepEqual(waiting.choices[0].targets, [{ kind: 'all-devices' }, { kind: 'group', groupId: 'group-1' }]);

    // Skip: nothing is written.
    const skipped = applyUndoChoices(planned, { assigned, choices: { [item.naturalKey]: 'skip' } });
    assert.deepEqual(skipped.operations, []);
    assert.equal(skipped.choices[0].choice, 'skip');

    // Delete: the assignments go first, then the policy.
    const chosen = applyUndoChoices(planned, { assigned, choices: { [item.naturalKey]: 'delete' } });
    assert.deepEqual(chosen.operations[0].removeAssignments, { ids: ['assignment-0', 'assignment-1'] });
    const outcome = await wave(graph, chosen.operations);
    assert.deepEqual(outcome.failed, []);
    assert.deepEqual(outcome.skipped, []);
    assert.deepEqual(outcome.applied.map((entry) => [entry.naturalKey, entry.changes]), [[item.naturalKey, { assignmentsRemoved: 2 }]]);
    assert.deepEqual(writesOf(graph), [`POST ${item.path}/assign`, `DELETE ${item.path}`]);
    assert.deepEqual(graph.calls.find((call) => call.method === 'POST').body, { assignments: [] });
    assert.equal(graph.objects.has(item.path), false);
  });
}

test('a policy assigned differently after the choice is not deleted, and nothing is written', async () => {
  const { item, graph } = await assignedPolicy('deviceConfiguration', [ALL_DEVICES]);
  const planned = undoOf(item);
  const chosen = applyUndoChoices(planned, {
    assigned: await readUndoAssignments(readerOf(graph), planned.operations), choices: { [item.naturalKey]: 'delete' },
  });
  // Someone assigns it to one more group before the undo runs.
  await graph.write('v1.0', `${item.path}/assign`, { method: 'POST', body: { assignments: [ALL_DEVICES, GROUP('group-2')] } });
  graph.calls.length = 0;

  const outcome = await wave(graph, chosen.operations);
  assert.deepEqual(outcome.applied, []);
  assert.match(outcome.skipped[0].reason, /^manual: the policy's assignments changed after you chose to delete it with its 1 assignment \(it has 2 now\)/);
  assert.deepEqual(writesOf(graph), []);
  assert.equal(graph.objects.has(item.path), true);
});

test('a choice to remove assignments counts only on an undo of a create: a forward delete of an assigned policy is still a manual step', async () => {
  const { item, graph } = await assignedPolicy('configurationPolicy', [ALL_DEVICES]);
  const [undo] = undoOf(item).operations;
  const forward = { ...undo, undoes: undefined, compensates: undefined, removeAssignments: { ids: ['assignment-0'] } };
  const outcome = await wave(graph, [forward]);
  assert.deepEqual(outcome.applied, []);
  assert.equal(outcome.skipped.length + outcome.failed.length, 1);
  assert.deepEqual(writesOf(graph), []);
});

test('when removing the assignments fails, the policy is not deleted and the undo fails', async () => {
  const item = created('windowsDriverUpdateProfile');
  const graph = idoFakeGraph({
    seed: { [item.path]: item.object },
    failWrites: ({ method, path, body }) => (method === 'POST' && path.endsWith('/assign') && body.assignments.length === 0
      ? { ok: false, status: 400, body: { error: { code: 'BadRequest' } } } : null),
  });
  await graph.write('beta', `${item.path}/assign`, { method: 'POST', body: { assignments: [ALL_DEVICES] } });
  graph.calls.length = 0;
  const planned = undoOf(item);
  const chosen = applyUndoChoices(planned, {
    assigned: await readUndoAssignments(readerOf(graph), planned.operations), choices: { [item.naturalKey]: 'delete' },
  });
  const outcome = await wave(graph, chosen.operations);
  assert.deepEqual(outcome.applied, []);
  assert.match(outcome.failed[0].error, /^removing the policy's assignments failed, so it was not deleted/, 'a 400 is a clear refusal');
  assert.deepEqual(writesOf(graph), [`POST ${item.path}/assign`]);
  assert.equal(graph.objects.has(item.path), true);
});

test('when the policy cannot be deleted after its assignments were removed, the failure says so', async () => {
  const item = created('deviceCompliancePolicy');
  const graph = idoFakeGraph({
    seed: { [item.path]: item.object },
    failWrites: ({ method }) => (method === 'DELETE' ? { ok: false, status: 400, body: { error: { code: 'BadRequest' } } } : null),
  });
  await graph.write('v1.0', `${item.path}/assign`, { method: 'POST', body: { assignments: [ALL_DEVICES] } });
  graph.calls.length = 0;
  const planned = undoOf(item);
  const chosen = applyUndoChoices(planned, {
    assigned: await readUndoAssignments(readerOf(graph), planned.operations), choices: { [item.naturalKey]: 'delete' },
  });
  const outcome = await wave(graph, chosen.operations);
  assert.deepEqual(outcome.applied, []);
  assert.match(outcome.failed[0].error, /its 1 assignment\(s\) were already removed, and the policy was not deleted/);
  assert.deepEqual(writesOf(graph), [`POST ${item.path}/assign`, `DELETE ${item.path}`]);
});

test('assignments that do not read back as removed stop the delete, and say Graph accepted the removal', async () => {
  const item = created('targetedManagedAppConfiguration');
  const graph = idoFakeGraph({ seed: { [item.path]: item.object } });
  await graph.write('v1.0', `${item.path}/assign`, { method: 'POST', body: { assignments: [GROUP('group-1')] } });
  const planned = undoOf(item);
  const chosen = applyUndoChoices(planned, {
    assigned: await readUndoAssignments(readerOf(graph), planned.operations), choices: { [item.naturalKey]: 'delete' },
  });
  // Graph accepts the removal, but the list still reads as assigned.
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => (path.endsWith('/assign') ? { ok: true, status: 200, body: null } : write(version, path, request));
  graph.calls.length = 0;
  const outcome = await applyWave(graph, governor, chosen.operations, {
    targetTenant: 'fixture', mode: 'enforce', existingTargetIds: new Map(), readAfterWriteOptions: { attempts: 1, delayMs: 0 }, deletionGuardOptions: GUARD,
  });
  assert.deepEqual(outcome.applied, []);
  assert.match(outcome.failed[0].error, /^post-state: Graph accepted removing the policy's assignments, but they did not read back as removed, so it was not deleted/);
  assert.equal(graph.objects.has(item.path), true);
});

test('a policy with more assignments than one read returns is not deleted on a choice', async () => {
  const { item, graph } = await assignedPolicy('deviceConfiguration', [ALL_DEVICES]);
  const planned = undoOf(item);
  const chosen = applyUndoChoices(planned, {
    assigned: await readUndoAssignments(readerOf(graph), planned.operations), choices: { [item.naturalKey]: 'delete' },
  });
  const read = graph.read.bind(graph);
  graph.read = async (version, path) => {
    const result = await read(version, path);
    return path.endsWith('/assignments') ? { ...result, body: { ...result.body, '@odata.nextLink': 'https://graph.microsoft.com/next' } } : result;
  };
  const outcome = await wave(graph, chosen.operations);
  assert.match(outcome.skipped[0].reason, /^manual: the policy has more assignments than one read returns/);
  assert.deepEqual(writesOf(graph), []);
});

test('the choices are part of what an approval binds, and a plan with none keeps the digest it had', () => {
  const item = created('deviceCompliancePolicy');
  const planned = undoOf(item);
  const assigned = new Map([[item.naturalKey, { ids: ['a-1'], targets: [{ kind: 'all-devices' }] }]]);
  const before = compensationDigestInput(planned);
  assert.equal('choices' in before, false);
  assert.equal('removeAssignments' in before.operations[0], false);
  assert.deepEqual(compensationDigestInput(applyUndoChoices(planned, { assigned: new Map() })), before, 'nothing assigned: the same digest as before choices existed');

  const deleting = compensationDigestInput(applyUndoChoices(planned, { assigned, choices: { [item.naturalKey]: 'delete' } }));
  const skipping = compensationDigestInput(applyUndoChoices(planned, { assigned, choices: { [item.naturalKey]: 'skip' } }));
  const waiting = compensationDigestInput(applyUndoChoices(planned, { assigned }));
  assert.deepEqual(deleting.operations[0].removeAssignments, ['a-1']);
  assert.notDeepEqual(deleting, skipping);
  assert.notDeepEqual(skipping, waiting);
  const other = compensationDigestInput(applyUndoChoices(planned, {
    assigned: new Map([[item.naturalKey, { ids: ['a-2'], targets: [] }]]), choices: { [item.naturalKey]: 'delete' },
  }));
  assert.notDeepEqual(deleting, other, 'other assignments are another plan');

  // A stored plan gives back the choices it was made with; an unknown value is no choice.
  const stored = applyUndoChoices(planned, { assigned, choices: { [item.naturalKey]: 'delete' } });
  assert.deepEqual(undoChoicesOf(stored), { [item.naturalKey]: 'delete' });
  assert.deepEqual(applyUndoChoices(planned, { assigned, choices: { [item.naturalKey]: 'remove' } }).choices[0].choice, null);
});

test('only an undo of a create of an assigned policy waits for a choice', async () => {
  const { item, graph } = await assignedPolicy('mobileAppConfiguration', [ALL_DEVICES]);
  const [undo] = undoOf(item).operations;
  const reader = readerOf(graph);
  assert.equal((await readUndoAssignments(reader, [{ ...undo, undoes: 'update', verb: 'update' }])).size, 0);
  assert.equal((await readUndoAssignments(reader, [{ ...undo, resourceType: 'group' }])).size, 0);
  // An assignment read that fails leaves the undo as planned: the delete reads again and never deletes an assigned policy unchosen.
  assert.equal((await readUndoAssignments({ get: async () => ({ ok: false, status: 403 }) }, [undo])).size, 0);
  // An unassigned policy is undone as before.
  const bare = created('windowsQualityUpdateProfile');
  const empty = idoFakeGraph({ seed: { [bare.path]: bare.object } });
  assert.equal((await readUndoAssignments(readerOf(empty), undoOf(bare).operations)).size, 0);
});

test('who an assignment applies to is kept as a kind and a group id', () => {
  assert.deepEqual(assignmentTarget(ALL_DEVICES), { kind: 'all-devices' });
  assert.deepEqual(assignmentTarget({ target: { '@odata.type': '#microsoft.graph.allLicensedUsersAssignmentTarget' } }), { kind: 'all-users' });
  assert.deepEqual(assignmentTarget(GROUP('g-1')), { kind: 'group', groupId: 'g-1' });
  assert.deepEqual(assignmentTarget({ target: { '@odata.type': '#microsoft.graph.exclusionGroupAssignmentTarget', groupId: 'g-2' } }), { kind: 'excluded-group', groupId: 'g-2' });
  assert.deepEqual(assignmentTarget({ target: { '@odata.type': '#microsoft.graph.configurationManagerCollectionAssignmentTarget' } }), { kind: 'other' });
});
