// Issue #461: a restore writes assignments for scripts, remediations and app
// policies (batches 14 and 15), so recreating one, or assigning it to more
// devices, reaches devices. The content-effect review judges those writes.
import test from 'node:test';
import assert from 'node:assert/strict';

import { attachIntuneAssignments, newAssignmentReach } from '../restore/intuneOperations.mjs';
import { classifyContentEffects, contentEffectsDigest } from './contentEffects.mjs';

const encoded = (text) => Buffer.from(text, 'utf8').toString('base64');
const GROUP = 'group:KEEL-RT-Empty';
const OTHER = 'group:KEEL-RT-Empty-2';
const resolve = (key) => ({ [GROUP]: 'g-1', [OTHER]: 'g-2' }[key] ?? null);
const include = (key, extra = {}) => ({ targetNaturalKey: key, attributes: { targetType: 'groupAssignmentTarget', ...extra } });
const exclude = (key) => ({ targetNaturalKey: key, attributes: { targetType: 'exclusionGroupAssignmentTarget' } });
const liveEdge = (targetId, targetType = 'groupAssignmentTarget', extra = {}) => ({
  targetId, edgeKey: `${targetType}|${targetId}`, attributes: { targetType, ...extra },
});

const script = { id: 's-1', displayName: 'KEEL-RT-script', scriptContent: encoded('Write-Output "KEEL-RT"'), runAsAccount: 'system' };
const scriptResource = (verb, extra = {}) => ({
  naturalKey: 'deviceManagementScript:KEEL-RT-script', resourceType: 'deviceManagementScript', verb, payload: script,
  live: verb === 'create' ? { state: 'absent' } : { state: 'present', targetId: 's-1', payload: script }, ...extra,
});

test('a recreated script the restore assigns runs on devices, so it needs the separate approval, showing the text and who it reaches', () => {
  const { effects, refusals } = classifyContentEffects([scriptResource('create', { newAssignments: [GROUP] })]);
  assert.deepEqual(refusals, []);
  assert.equal(effects.length, 1);
  const [effect] = effects;
  assert.equal(effect.effect, 'runs-on-devices');
  assert.equal(effect.field, 'scriptContent');
  assert.equal(effect.before, null);
  assert.deepEqual(effect.newAssignments, [GROUP]);
  assert.deepEqual(effect.script, { before: null, after: 'Write-Output "KEEL-RT"' });
  // Recreated without assignments, it reaches no one.
  assert.deepEqual(classifyContentEffects([scriptResource('create', { newAssignments: [] })]).effects, []);
  assert.deepEqual(classifyContentEffects([scriptResource('create')]).effects, []);
});

test('an existing script assigned to more devices is judged even when its text is the same', () => {
  const [effect] = classifyContentEffects([scriptResource('update', { newAssignments: [OTHER] })]).effects;
  assert.equal(effect.effect, 'runs-on-devices');
  assert.equal(effect.before, effect.after);
  assert.deepEqual(effect.newAssignments, [OTHER]);
  // Same text, nobody new: nothing to approve.
  assert.deepEqual(classifyContentEffects([scriptResource('update', { newAssignments: [] })]).effects, []);
  // Who it reaches is bound into the digest: an approval for one group never covers another.
  const [wider] = classifyContentEffects([scriptResource('update', { newAssignments: [GROUP, OTHER] })]).effects;
  assert.notEqual(contentEffectsDigest([effect]), contentEffectsDigest([wider]));
});

test('an effect without new assignments keeps the digest it had before', () => {
  const effect = { naturalKey: 'n', resourceType: 'group', field: 'visibility', effect: 'externally-sharing', before: 'Private', after: 'Public', disclosure: 'x' };
  // The digest this effect had before issue #461, so approvals already given still match.
  assert.equal(contentEffectsDigest([effect]), 'a949a6e932916cdaf9dde915bd2417bc9445ef92dd02af7346ac9acd728acdf0');
  assert.equal(contentEffectsDigest([effect]), contentEffectsDigest([{ ...effect, newAssignments: undefined }]));
});

test('a resource that carries assignments without the plan\'s answer is judged as reaching every include target', () => {
  const [effect] = classifyContentEffects([scriptResource('create', {
    assignments: { outcome: 'complete', targets: [include(GROUP), exclude(OTHER)] },
  })]).effects;
  assert.deepEqual(effect.newAssignments, [GROUP]);
  // Exclusions alone reach no one.
  assert.deepEqual(classifyContentEffects([scriptResource('create', {
    assignments: { outcome: 'complete', targets: [exclude(OTHER)] },
  })]).effects, []);
});

test('a recreated Windows app protection policy with a wipe is judged when the restore assigns it', () => {
  const policy = { '@odata.type': '#microsoft.graph.windowsManagedAppProtection', displayName: 'KEEL-RT-win-mam', minimumWipeOsVersion: '10.0.22000', appActionIfUnableToAuthenticateUser: 'wipe' };
  const resource = (verb, newAssignments, live = null) => ({
    naturalKey: 'windowsManagedAppProtection:KEEL-RT-win-mam', resourceType: 'windowsManagedAppProtection', verb, payload: policy, newAssignments,
    live: live ? { state: 'present', payload: live } : { state: 'absent' },
  });
  const created = classifyContentEffects([resource('create', [GROUP])]).effects;
  assert.deepEqual(created.map((effect) => [effect.field, effect.effect]), [
    ['appActionIfUnableToAuthenticateUser', 'irreversible'], ['minimumWipeOsVersion', 'irreversible'],
  ]);
  assert.deepEqual(classifyContentEffects([resource('create', [])]).effects, []);
  // The same wipe settings, assigned to more devices: those devices get the wipe as if the policy were new.
  const widened = classifyContentEffects([resource('update', [OTHER], policy)]).effects;
  assert.equal(widened.length, 2);
  assert.ok(widened.every((effect) => effect.before === effect.after && effect.newAssignments[0] === OTHER));
  assert.deepEqual(classifyContentEffects([resource('update', [], policy)]).effects, []);
});

test('a compliance policy with a wipe action assigned to more devices is judged', () => {
  const payload = { scheduledActionsForRule: [{ scheduledActionConfigurations: [{ actionType: 'block' }, { actionType: 'wipe' }] }] };
  const [effect, ...rest] = classifyContentEffects([{
    naturalKey: 'deviceManagementCompliancePolicy:KEEL-RT-cp', resourceType: 'deviceManagementCompliancePolicy', verb: 'update', payload,
    live: { state: 'present', payload }, newAssignments: ['all devices'],
  }]).effects;
  assert.equal(rest.length, 0);
  assert.equal(effect.effect, 'irreversible');
  assert.deepEqual(effect.newAssignments, ['all devices']);
});

test('the plan says who an assignment write newly reaches', () => {
  const base = { assignments: { outcome: 'complete', targets: [include(GROUP), exclude(OTHER)] } };
  const present = { ...base, live: { state: 'present' } };
  const observed = (...targets) => ({ outcome: 'complete', targets });
  // A create, or live assignments that were not read: every include target.
  assert.deepEqual(newAssignmentReach({ ...base, live: { state: 'absent' } }, null, resolve), [GROUP]);
  assert.deepEqual(newAssignmentReach(present, { outcome: 'partial', targets: [] }, resolve), [GROUP]);
  // Already assigned there: no one new. An added exclusion only narrows.
  assert.deepEqual(newAssignmentReach(present, observed(liveEdge('g-1')), resolve), []);
  // A live exclusion the backup does not have lets the object reach those devices again.
  const dropped = { assignments: { outcome: 'complete', targets: [include(GROUP)] }, live: { state: 'present' } };
  assert.deepEqual(newAssignmentReach(dropped, observed(liveEdge('g-1'), liveEdge('g-2', 'exclusionGroupAssignmentTarget')), resolve), ['no longer excluded: g-2']);
  // A group missing in the target: nothing is written, so nothing is reached.
  assert.equal(newAssignmentReach(present, null, () => null), null);
});

test('a remediation whose fix is turned on reaches its devices anew; a changed schedule alone does not', () => {
  const extras = ['runRemediationScript', 'runSchedule'];
  const daily = { '@odata.type': '#microsoft.graph.deviceHealthScriptDailySchedule', interval: 1 };
  const resource = { live: { state: 'present' }, assignments: { outcome: 'complete', targets: [include(GROUP, { runRemediationScript: true, runSchedule: daily })] } };
  const live = (fix, schedule) => ({ outcome: 'complete', targets: [liveEdge('g-1', 'groupAssignmentTarget', { runRemediationScript: fix, runSchedule: schedule })] });
  assert.deepEqual(newAssignmentReach(resource, live(false, daily), resolve, extras), [`${GROUP}, runRemediationScript: true`]);
  assert.deepEqual(newAssignmentReach(resource, live(true, { ...daily, interval: 7 }), resolve, extras), []);
});

test('attaching assignments records who they newly reach, and a same-text script assigned wider is promoted and judged', () => {
  const naturalKey = 'deviceManagementScript:KEEL-RT-script';
  const base = { ...scriptResource('noop'), references: [] };
  const desired = new Map([[`${naturalKey}|assignment`, { outcome: 'complete', targets: [include(GROUP), include(OTHER)] }]]);
  const live = new Map([[`${naturalKey}|assignment`, { outcome: 'complete', targets: [liveEdge('g-1')] }]]);
  const [promoted] = attachIntuneAssignments([base], { desired, live, resolve });
  assert.equal(promoted.verb, 'update');
  assert.deepEqual(promoted.newAssignments, [OTHER]);
  const [effect] = classifyContentEffects([promoted]).effects;
  assert.equal(effect.effect, 'runs-on-devices');
  assert.deepEqual(effect.newAssignments, [OTHER]);
  // A recreated script picks up every include target.
  const [created] = attachIntuneAssignments([{ ...scriptResource('create'), references: [] }], { desired, resolve });
  assert.deepEqual(created.newAssignments, [GROUP, OTHER]);
  // A backup without an assignment read writes none, so it reaches no one.
  const [unread] = attachIntuneAssignments([{ ...scriptResource('create'), references: [] }], { desired: new Map(), resolve });
  assert.deepEqual(classifyContentEffects([unread]).effects, []);
});
