/**
 * Restore gaps batch 18: Intune apps. Each test drives the production writer
 * against an in-memory Graph (engine/test/idoFakeGraph.mjs); nothing here
 * reads or writes a tenant. Fixture names use the KEEL-RT- prefix.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { applyIntuneExtendedWrite, attachIntuneAssignments, unreadAssignmentsStep, writesIntuneAssignments } from './intuneOperations.mjs';
import { APP_KINDS, appGroupOf, appHasPackage } from './intuneAppKinds.mjs';
import { projectAssignment } from '../collect/relationships.mjs';
import { diffRelationships } from '../govern/diffSnapshots.mjs';
import { TYPE_DECISIONS } from '../coverage/qualification.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';

const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };
const APPS = '/deviceAppManagement/mobileApps';
const GROUP = 'group:KEEL-RT-Sales';
const context = () => ({ targetIndex: new Map([[GROUP, 'target-group']]), mappingTable: new Map(), runProvenance: new Map() });

const resourceOf = (payload, extra = {}) => ({
  naturalKey: `mobileApp:${payload.displayName}`, resourceType: 'mobileApp', payload, references: [], blastRadius: 'access-affecting', ...extra,
});

const webApp = Object.freeze({
  '@odata.type': '#microsoft.graph.webApp', id: 'src-web', displayName: 'KEEL-RT-app-web', description: 'Fixture link', publisher: 'KEEL',
  appUrl: 'https://example.com/', useManagedBrowser: true, isFeatured: false, roleScopeTagIds: ['0'],
  createdDateTime: '2026-01-01T00:00:00Z', lastModifiedDateTime: '2026-09-01T00:00:00Z',
  uploadState: 1, publishingState: 'published', isAssigned: true, dependentAppCount: 0, supersedingAppCount: 0, supersededAppCount: 0,
});

const DETECTION = { '@odata.type': '#microsoft.graph.win32LobAppFileSystemRule', ruleType: 'detection', path: 'C:\\KEEL', fileOrFolderName: 'keel.txt', check32BitOn64System: false, operationType: 'exists' };
const win32 = Object.freeze({
  '@odata.type': '#microsoft.graph.win32LobApp', id: 'src-win32', displayName: 'KEEL-RT-app-win32', description: 'Fixture shell', publisher: 'KEEL',
  fileName: 'keel-fixture.intunewin', setupFilePath: 'install.cmd', installCommandLine: 'cmd /c echo install', uninstallCommandLine: 'cmd /c echo uninstall',
  applicableArchitectures: 'x64', minimumSupportedWindowsRelease: '1607', roleScopeTagIds: ['0'],
  installExperience: { '@odata.type': '#microsoft.graph.win32LobAppInstallExperience', runAsAccount: 'system', deviceRestartBehavior: 'suppress' },
  returnCodes: [{ '@odata.type': '#microsoft.graph.win32LobAppReturnCode', returnCode: 0, type: 'success' }],
  rules: [DETECTION], detectionRules: [{ '@odata.type': '#microsoft.graph.win32LobAppFileSystemDetection', path: 'C:\\KEEL', fileOrFolderName: 'keel.txt', detectionType: 'exists' }],
  requirementRules: [],
  publishingState: 'published', committedContentVersion: '1', size: 1024, uploadState: 1,
});

const settings = { '@odata.type': '#microsoft.graph.win32LobAppAssignmentSettings', notifications: 'showReboot', deliveryOptimizationPriority: 'foreground' };
const assigned = (intent, extra = {}) => ({
  outcome: 'complete',
  targets: [{ targetNaturalKey: GROUP, attributes: { targetType: 'groupAssignmentTarget', mode: 'include', filterId: null, filterType: null, intent, settingsDigest: null, ...extra } }],
});

test('every kind is in exactly one group, and an app is a writable restore kind with assignments', () => {
  const all = Object.values(APP_KINDS).flat();
  assert.equal(new Set(all).size, all.length);
  assert.equal(appGroupOf(webApp), 'settings');
  assert.equal(appGroupOf(win32), 'packaged');
  assert.equal(appGroupOf({ '@odata.type': '#microsoft.graph.iosVppApp' }), 'synced');
  assert.equal(appGroupOf({ '@odata.type': '#microsoft.graph.somethingNew' }), null);
  assert.equal(TYPE_DECISIONS.mobileApp.decision, 'automated');
  assert.equal(writesIntuneAssignments('mobileApp'), true);
  assert.equal(appHasPackage({ ...win32, publishingState: 'notPublished' }), false);
});

test('a web link is created from its settings, then assigned with each assignment\'s intent and settings', async () => {
  const graph = idoFakeGraph();
  const webSettings = { '@odata.type': '#microsoft.graph.webAppAssignmentSettings', foo: null };
  const resource = resourceOf(webApp, { assignments: assigned('available', { settings: webSettings, settingsDigest: 'd' }) });
  const result = await applyIntuneExtendedWrite(graph, resource, 'create', { ...FAST, referenceContext: context() });
  assert.equal(result.failed, undefined, result.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST' && call.path === APPS);
  for (const field of ['id', 'uploadState', 'publishingState', 'isAssigned', 'dependentAppCount', 'createdDateTime']) assert.equal(field in post.body, false, field);
  assert.equal(post.body['@odata.type'], '#microsoft.graph.webApp');
  assert.equal(post.body.appUrl, 'https://example.com/');
  const assign = graph.calls.find((call) => call.path.endsWith('/assign'));
  assert.equal(assign.path, `${APPS}/${result.applied.targetId}/assign`);
  assert.deepEqual(assign.body, {
    mobileAppAssignments: [{
      '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'available', settings: webSettings,
      target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'target-group' },
    }],
  });
  assert.equal(result.applied.changes.assignments, 'written');
  assert.deepEqual(result.applied.followUp, [], 'a web link leaves nothing to do');
  assert.equal(result.applied.completion, undefined);
});

test('a Win32 app comes back as an unassigned shell with an upload step and the assignments to set after it', async () => {
  const graph = idoFakeGraph();
  const resource = resourceOf(win32, { assignments: assigned('required', { settings, settingsDigest: 'd' }) });
  const result = await applyIntuneExtendedWrite(graph, resource, 'create', { ...FAST, referenceContext: context() });
  assert.equal(result.failed, undefined, result.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST' && call.path === APPS);
  assert.deepEqual(post.body.rules, [DETECTION]);
  assert.equal('detectionRules' in post.body, false, 'only one form of the rules is sent');
  assert.equal('requirementRules' in post.body, false);
  for (const field of ['size', 'committedContentVersion', 'publishingState']) assert.equal(field in post.body, false, field);
  assert.equal(post.body.fileName, 'keel-fixture.intunewin');
  assert.equal(post.body.installCommandLine, 'cmd /c echo install');
  assert.equal(graph.calls.some((call) => call.path.endsWith('/assign')), false, 'never assigned without its package');
  const [upload] = result.applied.followUp;
  assert.equal(upload.reason, 'binary-route');
  assert.match(upload.description, /Upload it again/);
  assert.deepEqual(upload.values, [{ name: 'keel-fixture.intunewin', expires: null }]);
  assert.equal(result.applied.completion, undefined, 'the plan holds the step (applyEngine adds it to the result)');
  const assignLater = unreadAssignmentsStep({ ...resource, verb: 'create' });
  assert.equal(assignLater.requirement, 'assignments');
  assert.match(assignLater.description, /Upload the package/);
  assert.match(assignLater.description, /group:KEEL-RT-Sales \(required\)/);
});

test('an existing Win32 app is assigned once its package is in Intune, and not before', async () => {
  const path = `${APPS}/live-win32`;
  const resourceIn = (state) => resourceOf(win32, {
    targetId: 'live-win32', live: { state: 'present', payload: { ...win32, id: 'live-win32', publishingState: state, description: 'Changed' } },
    assignments: assigned('required', { settings, settingsDigest: 'd' }),
  });
  const graph = idoFakeGraph({ seed: { [path]: { ...win32, id: 'live-win32', publishingState: 'published', description: 'Changed' } } });
  const result = await applyIntuneExtendedWrite(graph, resourceIn('published'), 'update', { ...FAST, referenceContext: context() });
  assert.equal(result.failed, undefined, result.failed?.error);
  const patch = graph.calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(Object.keys(patch.body).sort(), ['@odata.type', 'description']);
  assert.equal(graph.calls.some((call) => call.path.endsWith('/assign')), true);
  assert.equal(result.applied.completion, undefined, 'the plan already holds the step');

  // Issue #642 (live): Intune refuses any PATCH of an app whose package is not
  // uploaded, so nothing is written and the step says to upload it first.
  const shell = idoFakeGraph({ seed: { [path]: { ...win32, id: 'live-win32', publishingState: 'notPublished', description: 'Changed' } } });
  const held = await applyIntuneExtendedWrite(shell, resourceIn('notPublished'), 'update', { ...FAST, referenceContext: context() });
  assert.match(held.skipped?.reason ?? '', /until its package is uploaded/);
  assert.equal(shell.calls.some((call) => call.method !== 'GET'), false);
});

test('an app synced from Apple is never created; on update only who it is assigned to is written', async () => {
  const vpp = { '@odata.type': '#microsoft.graph.iosVppApp', id: 'src-vpp', displayName: 'KEEL-RT-app-vpp', bundleId: 'com.example.keel', usedLicenseCount: 3, totalLicenseCount: 10 };
  const created = await applyIntuneExtendedWrite(idoFakeGraph(), resourceOf(vpp), 'create', FAST);
  assert.match(created.skipped.reason, /Apple Business Manager/);
  const path = `${APPS}/live-vpp`;
  const graph = idoFakeGraph({ seed: { [path]: { ...vpp, id: 'live-vpp', bundleId: 'com.example.other' } } });
  const resource = resourceOf(vpp, {
    targetId: 'live-vpp', live: { state: 'present', payload: { ...vpp, id: 'live-vpp', bundleId: 'com.example.other' } }, assignments: assigned('available'),
  });
  const result = await applyIntuneExtendedWrite(graph, resource, 'update', { ...FAST, referenceContext: context() });
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(graph.calls.some((call) => call.method === 'PATCH'), false, 'the store owns its settings');
  assert.equal(graph.calls.some((call) => call.path.endsWith('/assign')), true);
});

test('an uninstall assignment is never written, and the step names it', async () => {
  const graph = idoFakeGraph();
  const resource = resourceOf(webApp, { assignments: assigned('uninstall') });
  const result = await applyIntuneExtendedWrite(graph, resource, 'create', { ...FAST, referenceContext: context() });
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(graph.calls.some((call) => call.path.endsWith('/assign')), false);
  assert.match(unreadAssignmentsStep({ ...resource, verb: 'create' }).description, /uninstalls this app for group:KEEL-RT-Sales \(uninstall\)/);
});

test('a backup that holds only a fingerprint of the assignment settings is not assigned', async () => {
  const graph = idoFakeGraph();
  const resource = resourceOf(webApp, { assignments: assigned('required', { settingsDigest: 'abc' }) });
  const result = await applyIntuneExtendedWrite(graph, resource, 'create', { ...FAST, referenceContext: context() });
  assert.match(result.applied.changes.assignments, /fingerprint/);
  assert.equal(graph.calls.some((call) => call.path.endsWith('/assign')), false);
  assert.match(unreadAssignmentsStep({ ...resource, verb: 'create' }).description, /Take a new backup/);
});

test('a kind KEEL does not know, and an app whose kind changed, are left to a person', async () => {
  const unknown = await applyIntuneExtendedWrite(idoFakeGraph(), resourceOf({ ...webApp, '@odata.type': '#microsoft.graph.somethingNewApp' }), 'create', FAST);
  assert.match(unknown.skipped.reason, /does not write this kind of app/);
  const changed = await applyIntuneExtendedWrite(idoFakeGraph(), resourceOf(webApp, {
    targetId: 'x', live: { state: 'present', payload: { ...win32, displayName: webApp.displayName } },
  }), 'update', FAST);
  assert.match(changed.skipped.reason, /never changes kind/);
});

test('content effects: new install commands or detection scripts on an existing app, and removing older Office', () => {
  const script = (text) => ({ ...DETECTION, '@odata.type': '#microsoft.graph.win32LobAppPowerShellScriptRule', scriptContent: Buffer.from(text).toString('base64') });
  const live = { ...win32, installCommandLine: 'cmd /c echo old', rules: [script('exit 0')] };
  const { effects, refusals } = classifyContentEffects([{
    naturalKey: 'mobileApp:KEEL-RT-app-win32', resourceType: 'mobileApp', verb: 'update', payload: { ...win32, rules: [script('exit 1')] }, live: { state: 'present', payload: live },
  }]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(effects.map((effect) => [effect.field, effect.effect]), [
    ['installCommandLine', 'runs-on-devices'], ['rules (detection and requirement scripts)', 'runs-on-devices'],
  ]);
  assert.deepEqual(effects[1].script, { before: 'exit 0', after: 'exit 1' });
  const office = { '@odata.type': '#microsoft.graph.officeSuiteApp', displayName: 'KEEL-RT-office', useSharedComputerActivation: true, shouldUninstallOlderVersionsOfOffice: true };
  const officeEffects = classifyContentEffects([{
    naturalKey: 'mobileApp:KEEL-RT-office', resourceType: 'mobileApp', verb: 'update', payload: office,
    live: { state: 'present', payload: { ...office, useSharedComputerActivation: false, shouldUninstallOlderVersionsOfOffice: false } },
  }]);
  assert.deepEqual(officeEffects.refusals, [], 'shared computer activation is reviewed, not refused');
  assert.deepEqual(officeEffects.effects.map((effect) => effect.effect), ['irreversible']);
  const create = classifyContentEffects([{ naturalKey: 'mobileApp:KEEL-RT-app-win32', resourceType: 'mobileApp', verb: 'create', payload: win32 }]);
  assert.deepEqual(create.effects, [], 'a recreated shell is never assigned, so it runs nowhere');
});

test('an app assignment keeps its settings, and a backup that starts keeping them reads as no change', () => {
  const edge = projectAssignment({ id: 'a-1', intent: 'required', settings: { ...settings, 'x@odata.context': 'drop' }, target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'g-1' } });
  assert.deepEqual(edge.attributes.settings, settings);
  assert.match(edge.attributes.settingsDigest, /^[0-9a-f]{64}$/);
  const plain = projectAssignment({ id: 'a-2', intent: 'required', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'g-1' } });
  assert.equal('settings' in plain.attributes, false);
  const { settings: _held, ...before } = edge.attributes;
  const state = (attributes) => ({
    tenantRef: 't',
    entries: new Map([['k', { family: 'assignment', edgeType: 'assignment', parentSourceId: 'app-1', state: 'current', targets: [{ edgeKey: edge.edgeKey, targetId: 'g-1', attributes }] }]]),
  });
  assert.deepEqual(diffRelationships(state(before), state(edge.attributes)).drift, []);
  const other = { ...edge.attributes, settingsDigest: 'f'.repeat(64) };
  assert.equal(diffRelationships(state(edge.attributes), state(other)).drift[0].changeType, 'modified');
});

test('a recreated Microsoft 365 Apps that removes older Office is judged for the devices it reaches', () => {
  const office = { '@odata.type': '#microsoft.graph.officeSuiteApp', displayName: 'KEEL-RT-office', shouldUninstallOlderVersionsOfOffice: true };
  const [planned] = attachIntuneAssignments([resourceOf(office, { verb: 'create' })], {
    desired: new Map([['mobileApp:KEEL-RT-office|assignment', assigned('required', { settings, settingsDigest: 'd' })]]),
    resolve: (key) => (key === GROUP ? 'target-group' : null),
  });
  assert.deepEqual(planned.newAssignments, ['group:KEEL-RT-Sales, intent: "required"']);
  const { effects } = classifyContentEffects([planned]);
  assert.deepEqual(effects.map((effect) => [effect.field, effect.effect]), [['shouldUninstallOlderVersionsOfOffice', 'irreversible']]);
});

test('a recreated Win32 shell reaches no one, and the dry run already says it waits for its package', () => {
  const [planned] = attachIntuneAssignments([resourceOf(win32, { verb: 'create' })], {
    desired: new Map([['mobileApp:KEEL-RT-app-win32|assignment', assigned('required', { settings, settingsDigest: 'd' })]]),
    resolve: (key) => (key === GROUP ? 'target-group' : null),
  });
  assert.deepEqual(planned.newAssignments, []);
  assert.deepEqual(classifyContentEffects([planned]).effects, []);
  const step = unreadAssignmentsStep(planned);
  assert.equal(step.requirement, 'assignments');
  assert.match(step.description, /Upload the package/);
});

test('a package that disappears between the plan and the write still holds the assignments back, with the step', async () => {
  const path = `${APPS}/live-win32`;
  const graph = idoFakeGraph({ seed: { [path]: { ...win32, id: 'live-win32', publishingState: 'notPublished' } } });
  const resource = resourceOf(win32, {
    targetId: 'live-win32', live: { state: 'present', payload: { ...win32, id: 'live-win32', description: 'Changed' } },
    assignments: assigned('required', { settings, settingsDigest: 'd' }),
  });
  const result = await applyIntuneExtendedWrite(graph, resource, 'update', { ...FAST, referenceContext: context() });
  assert.equal(graph.calls.some((call) => call.path.endsWith('/assign')), false);
  assert.match(result.applied.completion[0].description, /Upload the package/);
});
