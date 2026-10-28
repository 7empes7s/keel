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
import { planCompensation } from './compensation.mjs';
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
