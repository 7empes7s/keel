/**
 * Issue #546: a policy whose backup could not read its assignments was listed
 * by a restore as applied with no changes and no step for a person, and kept
 * its live (wrong) groups. Now every Intune kind that writes assignments
 * carries a step on that object, in the dry run and in the restore result,
 * and an enforced run opens it as a follow-up item.
 *
 * Fixtures only: an in-memory fake Graph, never a tenant.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { completionStepLines } from '../../cli/keel-restore.mjs';
import { applyWave } from './applyEngine.mjs';
import { completionItemsFor } from './completion.mjs';
import {
  INTUNE_EXTENDED_RECORDS, INTUNE_RECORDS, unreadAssignmentsStep, writesIntuneAssignments,
} from './intuneOperations.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const ASSIGNED_KINDS = [...new Set([...Object.keys(INTUNE_RECORDS), ...Object.keys(INTUNE_EXTENDED_RECORDS)])]
  .filter((type) => writesIntuneAssignments(type));
const UNREAD = ['failed', 'partial', 'absent', 'unsupported'];

const noop = (resourceType, outcome, payload = { displayName: `KEEL-RT-${resourceType}` }) => ({
  naturalKey: `${resourceType}:KEEL-RT-${resourceType}`, resourceType, verb: 'noop', targetId: `target-${resourceType}`,
  payload, references: [], live: { state: 'present', targetId: `target-${resourceType}`, payload },
  ...(outcome === undefined ? {} : { assignments: { outcome, targets: [] } }),
});

const wave = (graph, resources, mode = 'dry-run') => applyWave(graph, governor, resources, {
  targetTenant: 'fixture', mode, existingTargetIds: new Map(),
});

test('every Intune kind that writes assignments has a step when its assignment read is not complete', () => {
  assert.ok(ASSIGNED_KINDS.length >= 20, `found ${ASSIGNED_KINDS.length} kinds`);
  assert.ok(ASSIGNED_KINDS.includes('deviceCustomAttributeShellScript'), 'the script from issue #546 is covered');
  for (const type of ASSIGNED_KINDS) {
    for (const outcome of UNREAD) {
      const step = unreadAssignmentsStep(noop(type, outcome));
      assert.ok(step, `${type} ${outcome}`);
      assert.equal(step.kind, 'integration');
      assert.equal(step.requirement, 'assignments');
      assert.match(step.description, /Assignments not restored/);
      assert.match(step.description, /set them by hand/);
    }
    for (const outcome of ['complete', 'complete-empty']) assert.equal(unreadAssignmentsStep(noop(type, outcome)), null, `${type} ${outcome}`);
    // Not a selection restore: assignments were never looked at, by design.
    assert.equal(unreadAssignmentsStep(noop(type, undefined)), null, `${type} unattached`);
    assert.equal(unreadAssignmentsStep({ ...noop(type, 'failed'), verb: 'delete' }), null, `${type} delete`);
  }
});

test('the step says why in plain words', () => {
  const type = 'deviceCustomAttributeShellScript';
  assert.match(unreadAssignmentsStep(noop(type, 'failed')).description, /could not read who it is assigned to/);
  assert.match(unreadAssignmentsStep(noop(type, 'partial')).description, /read only some of its assignments/);
  assert.match(unreadAssignmentsStep(noop(type, 'absent')).description, /did not read who it is assigned to/);
  assert.match(unreadAssignmentsStep(noop(type, 'too-large')).description, /was too-large/);
});

test('a kind without assignments, and the default branding profile, have no step', () => {
  assert.equal(unreadAssignmentsStep(noop('deviceCategory', 'failed')), null);
  assert.equal(unreadAssignmentsStep(noop('intuneBrandingProfile', 'failed', { profileName: 'Default', isDefaultProfile: true })), null);
  assert.ok(unreadAssignmentsStep(noop('intuneBrandingProfile', 'failed', { profileName: 'KEEL-RT', isDefaultProfile: false })));
});

test('issue #546: a dry run lists an unchanged object with an unread assignment read with its step, for every kind', async () => {
  const graph = fakeGraph();
  const resources = ASSIGNED_KINDS.map((type) => noop(type, 'failed'));
  const outcome = await wave(graph, resources);
  assert.deepEqual(outcome.failed, []);
  assert.equal(outcome.applied.length, resources.length);
  for (const entry of outcome.applied) {
    assert.equal(entry.completion?.length, 1, entry.naturalKey);
    assert.equal(entry.completion[0].requirement, 'assignments', entry.naturalKey);
  }
  const lines = outcome.applied.flatMap((entry) => completionStepLines(entry));
  assert.equal(lines.length, resources.length);
  assert.match(lines.find((line) => line.includes('deviceCustomAttributeShellScript')), /^completion step: deviceCustomAttributeShellScript:KEEL-RT-deviceCustomAttributeShellScript — Assignments not restored/);
});

test('a complete read leaves no step', async () => {
  const outcome = await wave(fakeGraph(), [noop('deviceCustomAttributeShellScript', 'complete')]);
  assert.equal(outcome.applied[0].completion, undefined);
});

test('a settings update keeps the step in the dry run and in the enforced result', async () => {
  const live = { '@odata.type': '#microsoft.graph.windows10CompliancePolicy', displayName: 'KEEL-RT-compliance', passwordMinimumLength: 4 };
  const desired = { ...live, passwordMinimumLength: 12 };
  const update = (graph) => {
    graph.objects.set(`${INTUNE_RECORDS.deviceCompliancePolicy.collection}/target-policy`, { ...live, id: 'target-policy' });
    return {
      naturalKey: 'deviceCompliancePolicy:KEEL-RT-compliance', resourceType: 'deviceCompliancePolicy', verb: 'update', payload: desired,
      references: [], targetId: 'target-policy', live: { state: 'present', targetId: 'target-policy', payload: { ...live, id: 'target-policy' } },
      assignments: { outcome: 'failed', targets: [] },
    };
  };
  for (const mode of ['dry-run', 'enforce']) {
    const graph = fakeGraph();
    const outcome = await wave(graph, [update(graph)], mode);
    assert.deepEqual(outcome.failed, [], mode);
    const [entry] = outcome.applied;
    assert.deepEqual(entry.changes.fields, ['passwordMinimumLength'], mode);
    assert.match(entry.changes.assignments, /left as they are/, mode);
    assert.equal(entry.completion.length, 1, mode);
    assert.equal(entry.completion[0].requirement, 'assignments', mode);
  }
});

test('an enforced run opens the step as a follow-up item whatever the recovery mechanism', () => {
  const step = unreadAssignmentsStep(noop('deviceCustomAttributeShellScript', 'failed'));
  for (const mechanism of ['none', 'update-existing']) {
    const items = completionItemsFor({ resourceType: 'deviceCustomAttributeShellScript', mechanism, steps: [step] });
    assert.deepEqual(items.map((item) => [item.kind, item.requirement]), [['integration', 'assignments']], mechanism);
    assert.equal(items[0].description, step.description);
  }
  const recreated = completionItemsFor({ resourceType: 'deviceCompliancePolicy', mechanism: 'recreate', steps: [step] });
  assert.ok(recreated.some((item) => item.requirement === 'newObjectId'));
  assert.ok(recreated.some((item) => item.requirement === 'assignments'));
  // A step of another kind (a manual setting) is listed by the run, not opened as an item.
  assert.deepEqual(completionItemsFor({ resourceType: 'x', mechanism: 'none', steps: [{ kind: 'manual-setting', requirement: 'r', description: 'd' }] }), []);
  assert.deepEqual(completionItemsFor({ resourceType: 'x', mechanism: 'none' }), []);
});
