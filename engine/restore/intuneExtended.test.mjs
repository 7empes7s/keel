/**
 * Wave 2 IDO: fixture tests for the Intune record writers (app protection, app
 * configuration, update profiles, filters, scope tags, notification templates)
 * and for policy delete. Each drives the production writer against an
 * in-memory Graph (engine/test/idoFakeGraph.mjs); nothing here reads or writes
 * a tenant. Fixture names use the KEEL-RT- prefix.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  INTUNE_BEST_EFFORT, INTUNE_EXTENDED_RECORDS, INTUNE_RECORDS, applyIntuneExtendedWrite, buildIntuneExtendedLedger, intuneExtendedOperations,
  targetAppsBody,
} from './intuneOperations.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';

const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };
const GUARD = { breakGlassUserIds: ['break-glass-1'], keelAppIds: [], caPolicies: [] };
const COMPLETE = (type) => ({ [type]: { outcome: 'complete' } });

const resourceOf = (resourceType, payload, extra = {}) => ({
  naturalKey: `${resourceType}:${payload.displayName ?? payload.id}`, resourceType, payload, references: [], blastRadius: 'access-affecting', ...extra,
});

const iosApp = (bundleId) => ({
  id: `${bundleId}.ios`, version: '1',
  mobileAppIdentifier: { '@odata.type': '#microsoft.graph.iosMobileAppIdentifier', bundleId },
});

const protection = Object.freeze({
  '@odata.type': '#microsoft.graph.iosManagedAppProtection',
  id: 'T_src-ios', displayName: 'KEEL-RT-iOS protection', description: 'Fixture', version: '"3"', createdDateTime: '2026-01-01T00:00:00Z',
  roleScopeTagIds: ['0'], isAssigned: true, deployedAppCount: 2,
  pinRequired: true, minimumPinLength: 6, dataBackupBlocked: true, allowedOutboundDataTransferDestinations: 'managedApps',
  apps: [iosApp('com.microsoft.office.outlook'), iosApp('com.microsoft.skype.teams')],
});

test('an app protection policy is created at its subtype collection, then its apps and assignments are written', async () => {
  const graph = idoFakeGraph({ seed: { '/deviceManagement/assignmentFilters/filter-1': { id: 'filter-1' } } });
  const resource = resourceOf('managedAppPolicy', protection, {
    assignments: {
      outcome: 'complete',
      targets: [{ targetNaturalKey: 'group:KEEL-RT-Mobile', attributes: { targetType: 'groupAssignmentTarget', filterId: 'filter-1', filterType: 'include' } }],
    },
  });
  const result = await applyIntuneExtendedWrite(graph, resource, 'create', {
    ...FAST, referenceContext: { targetIndex: new Map([['group:KEEL-RT-Mobile', 'target-group']]), mappingTable: new Map(), runProvenance: new Map() },
  });
  assert.equal(result.failed, undefined, result.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceAppManagement/iosManagedAppProtections');
  for (const field of ['apps', 'id', 'version', 'isAssigned', 'deployedAppCount', 'createdDateTime']) assert.equal(field in post.body, false, field);
  assert.equal(post.body['@odata.type'], '#microsoft.graph.iosManagedAppProtection');
  const targetApps = graph.calls.find((call) => call.path.endsWith('/targetApps'));
  assert.deepEqual(targetApps.body, targetAppsBody(protection));
  assert.equal(targetApps.body.apps.length, 2);
  const assign = graph.calls.find((call) => call.path.endsWith('/assign'));
  assert.deepEqual(assign.body.assignments, [{
    '@odata.type': '#microsoft.graph.targetedManagedAppPolicyAssignment',
    target: {
      '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'target-group',
      deviceAndAppManagementAssignmentFilterId: 'filter-1', deviceAndAppManagementAssignmentFilterType: 'include',
    },
  }]);
  assert.equal(result.applied.changes.apps, 'written');
  assert.equal(result.applied.changes.assignments, 'written');
});

test('an app protection policy without its apps in the backup is never created', async () => {
  const { apps: _apps, ...withoutApps } = protection;
  const graph = idoFakeGraph();
  const result = await applyIntuneExtendedWrite(graph, resourceOf('managedAppPolicy', withoutApps), 'create', FAST);
  assert.match(result.failed.error, /protects nothing/);
  assert.equal(graph.calls.length, 0);
});

test('an app protection update patches changed settings and leaves matching apps alone', async () => {
  const path = '/deviceAppManagement/iosManagedAppProtections/T_live';
  const live = { ...protection, id: 'T_live', minimumPinLength: 4 };
  const graph = idoFakeGraph({ seed: { [path]: { ...live, apps: undefined } } });
  await graph.write('v1.0', `${path}/targetApps`, { method: 'POST', body: targetAppsBody(protection) });
  graph.calls.length = 0;
  const result = await applyIntuneExtendedWrite(graph, resourceOf('managedAppPolicy', protection, {
    live: { state: 'present', targetId: 'T_live', payload: live },
  }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const patch = graph.calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(patch.body, { '@odata.type': '#microsoft.graph.iosManagedAppProtection', minimumPinLength: 6 });
  assert.equal(graph.calls.some((call) => call.path.endsWith('/targetApps')), false);
});

test('protection subtypes without a write route, and targeted configurations listed with them, are manual', async () => {
  for (const odata of ['#microsoft.graph.windowsInformationProtectionPolicy', '#microsoft.graph.targetedManagedAppConfiguration', '#microsoft.graph.defaultManagedAppProtection']) {
    const graph = idoFakeGraph();
    const result = await applyIntuneExtendedWrite(graph, resourceOf('managedAppPolicy', { ...protection, '@odata.type': odata }), 'create', FAST);
    assert.match(result.skipped.reason, /has no write route/);
    assert.equal(graph.calls.length, 0);
  }
});

test('a managed app configuration is created with its custom settings and apps', async () => {
  const configuration = {
    id: 'src-cfg', displayName: 'KEEL-RT-Outlook config', description: 'Fixture', version: '"1"', isAssigned: false,
    customSettings: [{ name: 'com.microsoft.outlook.Mail.FocusedInbox', value: 'false' }], apps: [iosApp('com.microsoft.office.outlook')],
  };
  const graph = idoFakeGraph();
  const result = await applyIntuneExtendedWrite(graph, resourceOf('targetedManagedAppConfiguration', configuration), 'create', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST' && call.path === '/deviceAppManagement/targetedManagedAppConfigurations');
  assert.deepEqual(post.body.customSettings, configuration.customSettings);
  assert.equal(graph.calls.filter((call) => call.path.endsWith('/targetApps')).length, 1);
});

test('a device app configuration needs its apps to exist in the target before anything is written', async () => {
  const configuration = {
    '@odata.type': '#microsoft.graph.iosMobileAppConfiguration', id: 'src-mac', displayName: 'KEEL-RT-Device config', version: 2,
    targetedMobileApps: ['app-in-target', 'app-missing'], settings: [{ appConfigKey: 'k', appConfigKeyType: 'stringType', appConfigKeyValue: 'v' }],
  };
  const graph = idoFakeGraph({ seed: { '/deviceAppManagement/mobileApps/app-in-target': { id: 'app-in-target' } } });
  const refused = await applyIntuneExtendedWrite(graph, resourceOf('mobileAppConfiguration', configuration), 'create', FAST);
  assert.match(refused.failed.error, /dependency: the app app-missing .* does not exist in the target/);
  assert.equal(graph.calls.some((call) => call.method !== 'GET'), false);

  const created = await applyIntuneExtendedWrite(graph, resourceOf('mobileAppConfiguration', { ...configuration, targetedMobileApps: ['app-in-target'] }), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.body['@odata.type'], '#microsoft.graph.iosMobileAppConfiguration');
  assert.equal('version' in post.body, false);
});

test('a configuration holding a secret is manual', async () => {
  const configuration = {
    '@odata.type': '#microsoft.graph.androidManagedStoreAppConfiguration', id: 'src', displayName: 'KEEL-RT-Secret', targetedMobileApps: [],
    payloadJson: 'e30=', vpnPassword: '',
  };
  const result = await applyIntuneExtendedWrite(idoFakeGraph(), resourceOf('mobileAppConfiguration', configuration), 'create', FAST);
  assert.match(result.skipped.reason, /manual: the policy holds values Graph never returns/);
});

test('update profiles, filters, scope tags and notification templates are created and read back', async () => {
  const cases = [
    ['windowsFeatureUpdateProfile', { id: 's1', displayName: 'KEEL-RT-Feature', featureUpdateVersion: 'Windows 11, version 24H2', endOfSupportDate: '2027-10-01T00:00:00Z', deployableContentDisplayName: 'x', roleScopeTagIds: ['0'] }],
    ['windowsQualityUpdateProfile', { id: 's2', displayName: 'KEEL-RT-Quality', expeditedUpdateSettings: { qualityUpdateRelease: '2026-10-08T00:00:00Z', daysUntilForcedReboot: 1 }, releaseDateDisplayText: 'x' }],
    ['windowsDriverUpdateProfile', { id: 's3', displayName: 'KEEL-RT-Drivers', approvalType: 'manual', inventorySyncStatus: { lastSuccessfulSyncDateTime: 'x' }, newUpdates: 3 }],
    ['assignmentFilter', { id: 's4', displayName: 'KEEL-RT-Corporate', platform: 'windows10AndLater', rule: '(device.deviceOwnership -eq "Corporate")', roleScopeTags: ['0'], payloads: [] }],
    ['roleScopeTag', { id: '7', displayName: 'KEEL-RT-Paris', description: 'Fixture tag', isBuiltIn: false }],
  ];
  for (const [type, payload] of cases) {
    const graph = idoFakeGraph();
    const result = await applyIntuneExtendedWrite(graph, resourceOf(type, payload), 'create', FAST);
    assert.equal(result.failed, undefined, `${type}: ${result.failed?.error}`);
    const post = graph.calls.find((call) => call.method === 'POST');
    assert.equal(post.path, INTUNE_EXTENDED_RECORDS[type].collection);
    assert.equal(post.version, 'beta');
    for (const field of ['id', 'endOfSupportDate', 'deployableContentDisplayName', 'releaseDateDisplayText', 'inventorySyncStatus', 'newUpdates', 'isBuiltIn', 'payloads']) {
      assert.equal(field in post.body, false, `${type}.${field}`);
    }
  }
});

test('an assignment filter update never changes its platform', async () => {
  const path = '/deviceManagement/assignmentFilters/f-1';
  const live = { id: 'f-1', displayName: 'KEEL-RT-Corporate', platform: 'iOS', rule: 'old' };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('assignmentFilter', { ...live, platform: 'android', rule: 'new' }, {
    live: { state: 'present', targetId: 'f-1', payload: live },
  }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(graph.calls.find((call) => call.method === 'PATCH').body, { rule: 'new' });
});

test('the built-in Default scope tag is never written', async () => {
  const graph = idoFakeGraph();
  const result = await applyIntuneExtendedWrite(graph, resourceOf('roleScopeTag', { id: '0', displayName: 'Default', isBuiltIn: true }), 'update', FAST);
  assert.match(result.skipped.reason, /built-in/);
  assert.equal(graph.calls.length, 0);
});

test('a notification template is created, then its localized messages are added and updated by locale', async () => {
  const template = {
    id: 'src-tpl', displayName: 'KEEL-RT-Noncompliance', defaultLocale: 'en-us', brandingOptions: 'includeCompanyLogo', roleScopeTagIds: ['0'],
    localizedNotificationMessages: [
      { id: 'm1', locale: 'en-us', subject: 'Action needed', messageTemplate: 'Your device is not compliant', isDefault: true, lastModifiedDateTime: 'x' },
      { id: 'm2', locale: 'fr-fr', subject: 'Action requise', messageTemplate: 'Votre appareil', isDefault: false },
    ],
  };
  const graph = idoFakeGraph();
  const created = await applyIntuneExtendedWrite(graph, resourceOf('notificationMessageTemplate', template), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  assert.deepEqual(created.applied.changes.localizedMessages, ['en-us', 'fr-fr']);
  const templateId = created.applied.targetId;
  const base = `/deviceManagement/notificationMessageTemplates/${templateId}`;

  // The French text changed live; an update puts it back and leaves English alone.
  const live = (await graph.read('v1.0', `${base}?$expand=localizedNotificationMessages`)).body;
  const french = live.localizedNotificationMessages.find((message) => message.locale === 'fr-fr');
  await graph.write('v1.0', `${base}/localizedNotificationMessages/${french.id}`, { method: 'PATCH', body: { subject: 'Changed' } });
  const changed = (await graph.read('v1.0', `${base}?$expand=localizedNotificationMessages`)).body;
  graph.calls.length = 0;
  const updated = await applyIntuneExtendedWrite(graph, resourceOf('notificationMessageTemplate', template, {
    live: { state: 'present', targetId: templateId, payload: changed },
  }), 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  const writes = graph.calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(writes.map((call) => `${call.method} ${call.path.split('/').slice(-1)[0]}`), [`PATCH ${french.id}`]);
});

// ------------------------------------------- restore gaps, batch 1

test('reusable settings groups, hotpatch policies and device categories are created without server-owned fields', async () => {
  const cases = [
    ['deviceManagementReusablePolicySetting', 'beta', {
      id: 'r1', displayName: 'KEEL-RT-Firewall addresses', description: 'Fixture', version: 3, createdDateTime: 'x',
      referencingConfigurationPolicyCount: 2, settingDefinitionId: 'vendor_msft_firewall_mdmstore_dynamickeywords_addresses_{id}',
      settingInstance: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance', settingDefinitionId: 'vendor_msft_firewall_mdmstore_dynamickeywords_addresses_{id}', groupSettingCollectionValue: [] },
    }, ['id', 'version', 'createdDateTime', 'referencingConfigurationPolicyCount']],
    ['windowsQualityUpdatePolicy', 'beta', {
      id: 'q1', displayName: 'KEEL-RT-Hotpatch', description: 'Fixture', hotpatchEnabled: true, roleScopeTagIds: ['0'], assignments: [], lastModifiedDateTime: 'x',
    }, ['id', 'assignments', 'lastModifiedDateTime']],
    ['deviceCategory', 'v1.0', { id: 'c1', displayName: 'KEEL-RT-Kiosks', description: 'Fixture' }, ['id']],
  ];
  for (const [type, version, payload, dropped] of cases) {
    const graph = idoFakeGraph();
    const result = await applyIntuneExtendedWrite(graph, resourceOf(type, payload), 'create', FAST);
    assert.equal(result.failed, undefined, `${type}: ${result.failed?.error}`);
    const post = graph.calls.find((call) => call.method === 'POST');
    assert.equal(post.path, INTUNE_EXTENDED_RECORDS[type].collection, type);
    assert.equal(post.version, version, type);
    assert.equal(post.body.displayName, payload.displayName, type);
    for (const field of dropped) assert.equal(field in post.body, false, `${type}.${field}`);
  }
});

test('a reusable settings group update never changes its setting definition', async () => {
  const path = '/deviceManagement/reusablePolicySettings/r-1';
  const live = { id: 'r-1', displayName: 'KEEL-RT-Firewall addresses', description: 'old', settingDefinitionId: 'def-a' };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceManagementReusablePolicySetting', { ...live, description: 'Fixture', settingDefinitionId: 'def-b' }, {
    live: { state: 'present', targetId: 'r-1', payload: live },
  }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(graph.calls.find((call) => call.method === 'PATCH').body, { description: 'Fixture' });
});

test('a cleanup rule is only ever made to wait longer before retiring devices, and is never created', async () => {
  const path = '/deviceManagement/managedDeviceCleanupRules/k-1';
  const live = { id: 'k-1', displayName: 'KEEL-RT-Cleanup', deviceCleanupRulePlatformType: 'windows', deviceInactivityBeforeRetirementInDays: 60 };
  const asLive = (payload) => resourceOf('managedDeviceCleanupRule', payload, { live: { state: 'present', targetId: 'k-1', payload: live } });

  const sooner = idoFakeGraph({ seed: { [path]: live } });
  const refused = await applyIntuneExtendedWrite(sooner, asLive({ ...live, deviceInactivityBeforeRetirementInDays: 30 }), 'update', FAST);
  assert.match(refused.skipped.reason, /sooner than the 60 days set now/);
  assert.equal(sooner.calls.length, 0);

  const later = idoFakeGraph({ seed: { [path]: live } });
  const written = await applyIntuneExtendedWrite(later, asLive({ ...live, deviceInactivityBeforeRetirementInDays: 90, deviceCleanupRulePlatformType: 'ios' }), 'update', FAST);
  assert.equal(written.failed, undefined, written.failed?.error);
  const patch = later.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.version, 'beta');
  assert.deepEqual(patch.body, { deviceInactivityBeforeRetirementInDays: 90 });

  const create = await applyIntuneExtendedWrite(idoFakeGraph(), resourceOf('managedDeviceCleanupRule', live), 'create', FAST);
  assert.match(create.failed.error, /unsupported operation/);
});

// ------------------------------------------- restore gaps, batch 4

const SCRIPT_CASES = Object.freeze([
  ['deviceManagementScript', { scriptContent: 'V3JpdGUtT3V0cHV0ICdLRUVMLVJUJw==', fileName: 'keel-rt.ps1', runAsAccount: 'system', enforceSignatureCheck: false, runAs32Bit: false }],
  ['deviceShellScript', { scriptContent: 'ZWNobyBLRUVMLVJU', fileName: 'keel-rt.sh', runAsAccount: 'system', executionFrequency: 'PT0S', retryCount: 0, blockExecutionNotifications: true }],
  ['deviceHealthScript', { detectionScriptContent: 'ZXhpdCAw', remediationScriptContent: 'ZXhpdCAw', publisher: 'KEEL-RT', runAsAccount: 'system', isGlobalScript: false, highestAvailableVersion: '1' }],
  ['deviceComplianceScript', { detectionScriptContent: 'cmV0dXJuIEB7fQ==', publisher: 'KEEL-RT', runAsAccount: 'system' }],
  // Restore gaps, batch 5.
  ['deviceCustomAttributeShellScript', { scriptContent: 'ZWNobyBLRUVMLVJU', fileName: 'keel-rt.sh', runAsAccount: 'system', customAttributeName: 'KEELRTAttribute', customAttributeType: 'string' }],
]);

test('scripts and remediations are created with their script body, without run results or assignments', async () => {
  for (const [type, fields] of SCRIPT_CASES) {
    const payload = {
      id: `${type}-1`, displayName: `KEEL-RT-${type}`, description: 'Fixture', roleScopeTagIds: ['0'], createdDateTime: 'x', lastModifiedDateTime: 'x',
      assignments: [], runSummary: { successCount: 3 }, ...fields,
    };
    const graph = idoFakeGraph();
    const result = await applyIntuneExtendedWrite(graph, resourceOf(type, payload), 'create', FAST);
    assert.equal(result.failed, undefined, `${type}: ${result.failed?.error}`);
    const post = graph.calls.find((call) => call.method === 'POST');
    assert.equal(post.path, `/deviceManagement/${type}s`, type);
    assert.equal(post.version, 'beta', type);
    for (const [field, value] of Object.entries(fields)) {
      if (['isGlobalScript', 'highestAvailableVersion'].includes(field)) assert.equal(field in post.body, false, `${type}.${field}`);
      else assert.deepEqual(post.body[field], value, `${type}.${field}`);
    }
    for (const field of ['id', 'createdDateTime', 'lastModifiedDateTime', 'assignments', 'runSummary']) assert.equal(field in post.body, false, `${type}.${field}`);
  }
});

test('a script update writes back a changed script body once a second person approved that text', async () => {
  const path = '/deviceManagement/deviceManagementScripts/s-1';
  const live = { id: 's-1', displayName: 'KEEL-RT-script', description: 'Fixture', scriptContent: 'dGFtcGVyZWQ=', runAsAccount: 'system' };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const resource = resourceOf('deviceManagementScript', { ...live, scriptContent: 'V3JpdGUtT3V0cHV0ICdLRUVMLVJUJw==' }, {
    live: { state: 'present', targetId: 's-1', payload: live },
  });
  const { effects } = classifyContentEffects([{ ...resource, verb: 'update' }]);
  assert.equal(effects.length, 1);
  const result = await applyIntuneExtendedWrite(graph, resource, 'update', { ...FAST, approvedContentEffects: effects });
  assert.equal(result.failed, undefined, result.failed?.error);
  const patch = graph.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.path, path);
  assert.deepEqual(patch.body, { scriptContent: 'V3JpdGUtT3V0cHV0ICdLRUVMLVJUJw==' });
});

test('a script update that changes its text is not written without that approval; a dry run plans it', async () => {
  const path = '/deviceManagement/deviceHealthScripts/h-1';
  const live = { id: 'h-1', displayName: 'KEEL-RT-remediation', detectionScriptContent: 'ZXhpdCAw', remediationScriptContent: 'ZXhpdCAx' };
  const backup = { ...live, remediationScriptContent: 'V3JpdGUtT3V0cHV0ICdLRUVMLVJUJw==' };
  const resource = resourceOf('deviceHealthScript', backup, { live: { state: 'present', targetId: 'h-1', payload: live } });
  const [effect] = classifyContentEffects([{ ...resource, verb: 'update' }]).effects;
  const otherText = { ...effect, after: '3 characters, sha256 0000' };
  for (const approvedContentEffects of [[], [otherText]]) {
    const graph = idoFakeGraph({ seed: { [path]: live } });
    const result = await applyIntuneExtendedWrite(graph, resource, 'update', { ...FAST, approvedContentEffects });
    assert.match(result.skipped?.reason ?? '', /runs on every device the script is assigned to/);
    assert.equal(graph.calls.filter((call) => call.method !== 'GET').length, 0);
  }
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const planned = await applyIntuneExtendedWrite(graph, resource, 'update', { ...FAST, mode: 'dry-run' });
  assert.equal(planned.skipped, undefined, planned.skipped?.reason);
  // Only the name changes: nothing new runs on devices, so no approval is needed.
  const renamed = resourceOf('deviceHealthScript', { ...live, displayName: 'KEEL-RT-renamed' }, { live: { state: 'present', targetId: 'h-1', payload: live } });
  assert.deepEqual(classifyContentEffects([{ ...renamed, verb: 'update' }]).effects, []);
  const renameGraph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIntuneExtendedWrite(renameGraph, renamed, 'update', FAST);
  assert.equal(result.skipped, undefined, result.skipped?.reason);
});

test('a script backed up without its body, and a Microsoft-published remediation, are never written', async () => {
  for (const [type, fields] of SCRIPT_CASES) {
    const { scriptContent, detectionScriptContent, ...settingsOnly } = fields;
    const graph = idoFakeGraph();
    const result = await applyIntuneExtendedWrite(graph, resourceOf(type, { id: 'old', displayName: `KEEL-RT-${type}`, ...settingsOnly }), 'create', FAST);
    assert.match(result.skipped?.reason ?? '', /not the script itself/, type);
    assert.equal(graph.calls.length, 0, type);
  }
  const graph = idoFakeGraph();
  const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceHealthScript', {
    id: 'ms-1', displayName: 'Restart stopped Office C2R svc', publisher: 'Microsoft', isGlobalScript: true, detectionScriptContent: 'ZXhpdCAw',
  }), 'create', FAST);
  assert.match(result.skipped?.reason ?? '', /Microsoft publishes this remediation/);
  assert.equal(graph.calls.length, 0);
});

// ------------------------------------------- restore gaps, batch 5

const TEMPLATE_PATH = '/deviceManagement/groupPolicyConfigurations';
const definitionsSeed = (...ids) => Object.fromEntries(ids.map((id) => [`/deviceManagement/groupPolicyDefinitions/${id}`, { id }]));
const textValue = (presentation, value, id = `v-${presentation}`) => ({
  '@odata.type': '#microsoft.graph.groupPolicyPresentationValueText', id, value, createdDateTime: 'x', presentation: { id: presentation, label: 'Home page' },
});
const setting = (definition, enabled, values, id = `s-${definition}`) => ({
  id, enabled, configurationType: 'policy', createdDateTime: 'x', definition: { id: definition, displayName: `Setting ${definition}` }, presentationValues: values,
});
const template = Object.freeze({
  id: 'gp-src', displayName: 'KEEL-RT-admx', description: 'Fixture', roleScopeTagIds: ['0'], createdDateTime: 'x', lastModifiedDateTime: 'x',
  policyConfigurationIngestionType: 'builtIn',
  definitionValues: [setting('d-1', true, [textValue('p-1', 'https://example.com')]), setting('d-2', false, [])],
});
const bind = (definition, presentation) => `https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions('${definition}')${presentation ? `/presentations('${presentation}')` : ''}`;

test('an administrative template is created, then its settings are added with the values entered for them', async () => {
  const graph = idoFakeGraph({ seed: definitionsSeed('d-1', 'd-2') });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('groupPolicyConfiguration', template), 'create', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const writes = graph.calls.filter((call) => call.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].path, TEMPLATE_PATH);
  assert.equal(writes[0].version, 'beta');
  assert.deepEqual(writes[0].body, { displayName: 'KEEL-RT-admx', description: 'Fixture', roleScopeTagIds: ['0'] });
  assert.equal(writes[1].path, `${TEMPLATE_PATH}/${result.applied.targetId}/updateDefinitionValues`);
  assert.deepEqual(writes[1].body, {
    added: [
      {
        enabled: true, 'definition@odata.bind': bind('d-1'),
        presentationValues: [{ '@odata.type': '#microsoft.graph.groupPolicyPresentationValueText', value: 'https://example.com', 'presentation@odata.bind': bind('d-1', 'p-1') }],
      },
      { enabled: false, 'definition@odata.bind': bind('d-2'), presentationValues: [] },
    ],
    updated: [],
    deletedIds: [],
  });
  assert.deepEqual(result.applied.changes.settings, { removed: 0, added: 2 });
});

test('an administrative template update removes changed and extra settings, then adds the backup ones', async () => {
  const path = `${TEMPLATE_PATH}/gp-1`;
  const live = { id: 'gp-1', displayName: 'KEEL-RT-admx', description: 'Changed', roleScopeTagIds: ['0'] };
  const graph = idoFakeGraph({
    seed: {
      ...definitionsSeed('d-1', 'd-2'),
      [path]: { ...live, definitionValues: [setting('d-1', true, [], 'live-1'), setting('d-2', false, [], 'live-2'), setting('d-3', true, [], 'live-3')] },
      [`${path}/definitionValues/live-1`]: { id: 'live-1', presentationValues: [textValue('p-1', 'https://tampered.example')] },
      [`${path}/definitionValues/live-2`]: { id: 'live-2', presentationValues: [] },
      [`${path}/definitionValues/live-3`]: { id: 'live-3', presentationValues: [] },
    },
  });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('groupPolicyConfiguration', template, {
    live: { state: 'present', targetId: 'gp-1', payload: live },
  }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(graph.calls.find((call) => call.method === 'PATCH').body, { description: 'Fixture' });
  const updates = graph.calls.filter((call) => call.path.endsWith('/updateDefinitionValues'));
  // d-2 already matches and stays; d-1's value drifted and d-3 is not in the backup.
  assert.deepEqual(updates.map((call) => call.body.deletedIds), [['live-1', 'live-3'], []]);
  assert.deepEqual(updates[1].body.added.map((entry) => entry['definition@odata.bind']), [bind('d-1')]);
  assert.deepEqual(result.applied.changes.settings, { removed: 2, added: 1 });
});

test('an administrative template without its setting values, or with a setting the target lacks, is never written', async () => {
  const valueless = { ...template, definitionValues: template.definitionValues.map(({ presentationValues, ...rest }) => rest) };
  let graph = idoFakeGraph({ seed: definitionsSeed('d-1', 'd-2') });
  let result = await applyIntuneExtendedWrite(graph, resourceOf('groupPolicyConfiguration', valueless), 'create', FAST);
  assert.match(result.skipped?.reason ?? '', /not the values entered for them/);
  assert.equal(graph.calls.length, 0);

  const { definitionValues, ...settingsless } = template;
  result = await applyIntuneExtendedWrite(idoFakeGraph(), resourceOf('groupPolicyConfiguration', settingsless), 'create', FAST);
  assert.match(result.skipped?.reason ?? '', /does not hold the template's settings/);

  graph = idoFakeGraph({ seed: definitionsSeed('d-1') });
  result = await applyIntuneExtendedWrite(graph, resourceOf('groupPolicyConfiguration', template), 'create', FAST);
  assert.match(result.failed?.error ?? '', /dependency: the setting d-2 this template uses does not exist in the target/);
  assert.equal(graph.calls.filter((call) => call.method !== 'GET').length, 0);
});

// ------------------------------------------------------------------- delete

// ------------------------------------------- restore gaps, batch 6

test('an app category is created and updated, and a built-in category is never written', async () => {
  const graph = idoFakeGraph();
  const created = await applyIntuneExtendedWrite(graph, resourceOf('mobileAppCategory', { id: 'c-src', displayName: 'KEEL-RT-Field apps', lastModifiedDateTime: 'x' }), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceAppManagement/mobileAppCategories');
  assert.equal(post.version, 'v1.0');
  assert.deepEqual(post.body, { displayName: 'KEEL-RT-Field apps' });

  const path = '/deviceAppManagement/mobileAppCategories/c-1';
  const live = { id: 'c-1', displayName: 'KEEL-RT-Field apps (renamed)' };
  const renamed = idoFakeGraph({ seed: { [path]: live } });
  const updated = await applyIntuneExtendedWrite(renamed, resourceOf('mobileAppCategory', { id: 'c-1', displayName: 'KEEL-RT-Field apps' }, {
    live: { state: 'present', targetId: 'c-1', payload: live },
  }), 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  assert.deepEqual(renamed.calls.find((call) => call.method === 'PATCH').body, { displayName: 'KEEL-RT-Field apps' });

  for (const displayName of ['Productivity', 'Books & Reference', 'other apps']) {
    const builtIn = idoFakeGraph();
    const result = await applyIntuneExtendedWrite(builtIn, resourceOf('mobileAppCategory', { id: 'b-1', displayName }), 'create', FAST);
    assert.match(result.skipped?.reason ?? '', /built-in/, displayName);
    assert.equal(builtIn.calls.length, 0, displayName);
  }
});

const autopilot = Object.freeze({
  '@odata.type': '#microsoft.graph.azureADWindowsAutopilotDeploymentProfile',
  id: 'ap-src', displayName: 'KEEL-RT-Autopilot', description: 'Fixture', language: 'os-default', deviceNameTemplate: 'KEELRT-%RAND:4%',
  deviceType: 'windowsPc', extractHardwareHash: false, enableWhiteGlove: false, roleScopeTagIds: ['0'], createdDateTime: 'x', lastModifiedDateTime: 'x',
  outOfBoxExperienceSettings: { hidePrivacySettings: true, hideEULA: true, userType: 'standard', deviceUsageType: 'singleUser', skipKeyboardSelectionPage: true, hideEscapeLink: true },
  assignedDevices: [{ id: 'dev-1' }], assignments: [{ id: 'a-1', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'g-1' } }],
});

test('an Autopilot profile is created with its kind, never with its devices or assignments', async () => {
  const graph = idoFakeGraph();
  const result = await applyIntuneExtendedWrite(graph, resourceOf('windowsAutopilotDeploymentProfile', autopilot), 'create', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceManagement/windowsAutopilotDeploymentProfiles');
  assert.equal(post.version, 'beta');
  assert.equal(post.body['@odata.type'], '#microsoft.graph.azureADWindowsAutopilotDeploymentProfile');
  assert.deepEqual(post.body.outOfBoxExperienceSettings, autopilot.outOfBoxExperienceSettings);
  for (const field of ['id', 'assignedDevices', 'assignments', 'createdDateTime', 'lastModifiedDateTime']) assert.equal(field in post.body, false, field);
});

test('an Autopilot profile update puts its settings back and never changes its kind', async () => {
  const path = '/deviceManagement/windowsAutopilotDeploymentProfiles/ap-1';
  const live = { ...autopilot, id: 'ap-1', deviceNameTemplate: 'CHANGED-%SERIAL%', assignedDevices: undefined, assignments: undefined };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('windowsAutopilotDeploymentProfile', { ...autopilot, id: 'ap-1' }, {
    live: { state: 'present', targetId: 'ap-1', payload: live },
  }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(graph.calls.find((call) => call.method === 'PATCH').body, {
    '@odata.type': '#microsoft.graph.azureADWindowsAutopilotDeploymentProfile', deviceNameTemplate: 'KEELRT-%RAND:4%',
  });

  const hybrid = idoFakeGraph({ seed: { [path]: live } });
  const changedKind = await applyIntuneExtendedWrite(hybrid, resourceOf('windowsAutopilotDeploymentProfile', {
    ...autopilot, id: 'ap-1', '@odata.type': '#microsoft.graph.activeDirectoryWindowsAutopilotDeploymentProfile',
  }, { live: { state: 'present', targetId: 'ap-1', payload: live } }), 'update', FAST);
  assert.ok(changedKind.failed || changedKind.skipped, 'a profile never changes kind');
  assert.equal(hybrid.calls.filter((call) => call.method !== 'GET').length, 0);
});

const SET_PATH = '/deviceAppManagement/policySets';
const setItem = (kind, payloadId, extra = {}) => ({
  '@odata.type': `#microsoft.graph.${kind}`, id: `item-${payloadId}`, payloadId, displayName: `KEEL-RT-${payloadId}`, status: 'notAssigned',
  createdDateTime: 'x', itemType: `#microsoft.graph.${kind}`, guidedDeploymentTags: [], ...extra,
});
const policySet = Object.freeze({
  id: 'set-src', displayName: 'KEEL-RT-Set', description: 'Fixture', status: 'notAssigned', errorCode: 'noError', roleScopeTags: ['0'], guidedDeploymentTags: [],
  items: [
    setItem('deviceConfigurationPolicySetItem', 'cfg-1'),
    setItem('mobileAppPolicySetItem', 'app-1', { intent: 'required', settings: null }),
  ],
});
const itemTargets = {
  '/deviceManagement/deviceConfigurations/cfg-1': { id: 'cfg-1' },
  '/deviceAppManagement/mobileApps/app-1': { id: 'app-1' },
};

test('a policy set is created, then its apps and policies are added through its update action', async () => {
  const graph = idoFakeGraph({ seed: itemTargets });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('policySet', policySet), 'create', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const writes = graph.calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(writes.map((call) => `${call.method} ${call.path}`), ['POST /deviceAppManagement/policySets', `POST ${SET_PATH}/${result.applied.targetId}/update`]);
  assert.equal(writes[0].version, 'beta');
  for (const field of ['id', 'items', 'status', 'errorCode', 'assignments']) assert.equal(field in writes[0].body, false, field);
  assert.deepEqual(writes[1].body, {
    addedPolicySetItems: [
      { '@odata.type': '#microsoft.graph.deviceConfigurationPolicySetItem', payloadId: 'cfg-1', guidedDeploymentTags: [] },
      { '@odata.type': '#microsoft.graph.mobileAppPolicySetItem', payloadId: 'app-1', guidedDeploymentTags: [], intent: 'required', settings: null },
    ],
    updatedPolicySetItems: [], deletedPolicySetItemIds: [],
  });
  assert.equal('assignments' in writes[1].body, false);
  assert.deepEqual(result.applied.changes.items, { removed: 0, added: 2 });
});

test('a policy set update removes extra or changed items, then adds the backup ones', async () => {
  const path = `${SET_PATH}/set-1`;
  const liveItems = [
    { ...setItem('deviceConfigurationPolicySetItem', 'cfg-1'), id: 'live-cfg' },
    { ...setItem('mobileAppPolicySetItem', 'app-1', { intent: 'available' }), id: 'live-app' },
    { ...setItem('deviceCompliancePolicyPolicySetItem', 'extra-1'), id: 'live-extra' },
  ];
  const live = { id: 'set-1', displayName: 'KEEL-RT-Set', description: 'Fixture', roleScopeTags: ['0'], guidedDeploymentTags: [] };
  const graph = idoFakeGraph({ seed: { ...itemTargets, [path]: live } });
  graph.objects.set(path, { ...live, items: liveItems });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('policySet', { ...policySet, id: 'set-1' }, {
    live: { state: 'present', targetId: 'set-1', payload: { ...live, items: liveItems } },
  }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const actions = graph.calls.filter((call) => call.method === 'POST').map((call) => call.body);
  assert.deepEqual(actions.map((body) => body.deletedPolicySetItemIds), [['live-app', 'live-extra'], []]);
  assert.deepEqual(actions[1].addedPolicySetItems.map((item) => item.payloadId), ['app-1']);
  assert.deepEqual(result.applied.changes.items, { removed: 2, added: 1 });
});

test('a policy set without its items, with an unknown item, or with an item missing in the target is never written', async () => {
  const { items, ...withoutItems } = policySet;
  for (const [payload, reason] of [
    [withoutItems, /not the apps and policies in it/],
    [{ ...policySet, items: [setItem('somethingNewPolicySetItem', 'x-1')] }, /a kind of item KEEL does not write/],
  ]) {
    const graph = idoFakeGraph({ seed: itemTargets });
    const result = await applyIntuneExtendedWrite(graph, resourceOf('policySet', payload), 'create', FAST);
    assert.match(result.skipped?.reason ?? '', reason);
    assert.equal(graph.calls.length, 0);
  }
  const graph = idoFakeGraph({ seed: { '/deviceManagement/deviceConfigurations/cfg-1': { id: 'cfg-1' } } });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('policySet', policySet), 'create', FAST);
  assert.match(result.failed?.error ?? '', /dependency: the item KEEL-RT-app-1 in this set does not exist in the target/);
  assert.equal(graph.calls.filter((call) => call.method !== 'GET').length, 0);
});

// ------------------------------------------- restore gaps, batch 7

const CP_PATH = '/deviceManagement/compliancePolicies';
const linuxSetting = (id, value) => ({
  id,
  settingInstance: {
    '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance',
    settingDefinitionId: 'linux_deviceencryption_required', settingInstanceTemplateReference: null,
    choiceSettingValue: { value, settingValueTemplateReference: null, children: [] },
  },
});
const actionsFor = (graceHours) => [{
  id: 'rule-src', ruleName: null,
  scheduledActionConfigurations: [
    { id: 'act-block', actionType: 'block', gracePeriodHours: graceHours, notificationTemplateId: '', notificationMessageCCList: [] },
    { id: 'act-mail', actionType: 'notification', gracePeriodHours: 24, notificationTemplateId: 'tpl-1', notificationMessageCCList: [] },
  ],
}];
const compliance = Object.freeze({
  id: 'cp-src', name: 'KEEL-RT-compliance', description: 'Fixture', platforms: 'linux', technologies: 'linuxMdm', roleScopeTagIds: ['0'],
  settingCount: 1, creationSource: null, isAssigned: false, createdDateTime: 'x', lastModifiedDateTime: 'x',
  settings: [linuxSetting('0', 'linux_deviceencryption_required_true')],
  scheduledActionsForRule: actionsFor(0),
});

test('a settings catalog compliance policy is created with its settings and actions for noncompliance, never its assignments', async () => {
  const graph = idoFakeGraph();
  const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceManagementCompliancePolicy', { ...compliance, assignments: [{ id: 'a-1' }] }), 'create', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const writes = graph.calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(writes.map((call) => `${call.method} ${call.path}`), [`POST ${CP_PATH}`], 'one create; the actions go with it');
  const [post] = writes;
  assert.equal(post.version, 'beta');
  for (const field of ['id', 'settingCount', 'creationSource', 'isAssigned', 'assignments', 'createdDateTime', 'lastModifiedDateTime']) assert.equal(field in post.body, false, field);
  assert.equal(post.body.settings.length, 1);
  assert.equal('id' in post.body.settings[0], false, 'setting ids are Intune\'s');
  assert.deepEqual(post.body.scheduledActionsForRule, [{
    ruleName: null,
    scheduledActionConfigurations: [
      { actionType: 'block', gracePeriodHours: 0, notificationTemplateId: '', notificationMessageCCList: [] },
      { actionType: 'notification', gracePeriodHours: 24, notificationTemplateId: 'tpl-1', notificationMessageCCList: [] },
    ],
  }]);
  const read = graph.calls.filter((call) => call.method === 'GET').at(-1);
  assert.match(read.path, /\$expand=settings,scheduledActionsForRule/, 'read back with settings and actions');
});

test('a compliance policy update puts the whole policy back, then its changed actions through setScheduledActions', async () => {
  const path = `${CP_PATH}/cp-1`;
  const live = { ...compliance, id: 'cp-1', description: 'Changed', settings: [linuxSetting('live-0', 'linux_deviceencryption_required_false')], scheduledActionsForRule: actionsFor(72) };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceManagementCompliancePolicy', { ...compliance, id: 'cp-1' }, {
    live: { state: 'present', targetId: 'cp-1', payload: live },
  }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const writes = graph.calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(writes.map((call) => `${call.method} ${call.path}`), [`PUT ${path}`, `POST ${path}/setScheduledActions`]);
  assert.equal(writes[0].body.description, 'Fixture');
  assert.equal(writes[0].body.settings[0].settingInstance.choiceSettingValue.value, 'linux_deviceencryption_required_true');
  assert.equal('scheduledActionsForRule' in writes[0].body, false, 'actions are never sent with an update');
  assert.equal(writes[1].body.scheduledActions[0].scheduledActionConfigurations[0].gracePeriodHours, 0);
  assert.deepEqual(result.applied.changes.fields.sort(), ['description', 'settings']);
  assert.equal(result.applied.changes.scheduledActions, 'written');
});

test('a compliance policy that matches the backup is not written, and an older backup leaves the live actions alone', async () => {
  const path = `${CP_PATH}/cp-1`;
  const live = { ...compliance, id: 'cp-1', settings: [linuxSetting('live-0', 'linux_deviceencryption_required_true')], scheduledActionsForRule: actionsFor(0) };
  const same = idoFakeGraph({ seed: { [path]: live } });
  const unchanged = await applyIntuneExtendedWrite(same, resourceOf('deviceManagementCompliancePolicy', { ...compliance, id: 'cp-1' }, {
    live: { state: 'present', targetId: 'cp-1', payload: live },
  }), 'update', FAST);
  assert.equal(unchanged.failed, undefined, unchanged.failed?.error);
  assert.equal(same.calls.filter((call) => call.method !== 'GET').length, 0);
  assert.equal(unchanged.applied.changes.scheduledActions, 'already as in the backup');

  const { scheduledActionsForRule, ...older } = compliance;
  const drifted = { ...live, description: 'Changed' };
  const graph = idoFakeGraph({ seed: { [path]: drifted } });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceManagementCompliancePolicy', { ...older, id: 'cp-1' }, {
    live: { state: 'present', targetId: 'cp-1', payload: drifted },
  }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(graph.calls.filter((call) => call.method !== 'GET').map((call) => call.method), ['PUT']);
  assert.match(result.applied.changes.scheduledActions, /left as they are/);
});

test('a compliance policy without all its settings, without actions to create it, without a block action, or with a secret is never written', async () => {
  const { settings, ...noSettings } = compliance;
  const { scheduledActionsForRule, ...noActions } = compliance;
  const noBlock = { ...compliance, scheduledActionsForRule: [{ ruleName: null, scheduledActionConfigurations: [{ actionType: 'notification', gracePeriodHours: 0 }] }] };
  const secret = { ...compliance, settings: [{ id: '0', settingInstance: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance', simpleSettingValue: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationSecretSettingValue', value: null } } }] };
  for (const [payload, verb, pattern] of [
    [noSettings, 'create', /does not hold this compliance policy's settings/],
    [{ ...compliance, settingCount: 3 }, 'update', /holds 1 of this compliance policy's 3 settings/],
    [noActions, 'create', /does not hold this compliance policy's actions for noncompliance/],
    [noBlock, 'create', /no block action/],
    [secret, 'create', /manual: the policy holds values Graph never returns/],
  ]) {
    const graph = idoFakeGraph({ seed: { [`${CP_PATH}/cp-1`]: { ...compliance, id: 'cp-1' } } });
    const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceManagementCompliancePolicy', { ...payload, id: 'cp-1' }, {
      live: { state: 'present', targetId: 'cp-1', payload: { ...compliance, id: 'cp-1' } },
    }), verb, FAST);
    assert.match(result.failed?.error ?? result.skipped?.reason ?? '', pattern, String(pattern));
    assert.equal(graph.calls.length, 0, String(pattern));
  }
});

// ------------------------------------------- restore gaps, batch 8

test('an e-book category is created and updated through beta by its name', async () => {
  const graph = idoFakeGraph();
  const created = await applyIntuneExtendedWrite(graph, resourceOf('managedEBookCategory', { id: 'e-src', displayName: 'KEEL-RT-Books', lastModifiedDateTime: 'x' }), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceAppManagement/managedEBookCategories');
  assert.equal(post.version, 'beta');
  assert.deepEqual(post.body, { displayName: 'KEEL-RT-Books' });

  const path = '/deviceAppManagement/managedEBookCategories/e-1';
  const live = { id: 'e-1', displayName: 'KEEL-RT-Books (renamed)' };
  const renamed = idoFakeGraph({ seed: { [path]: live } });
  const updated = await applyIntuneExtendedWrite(renamed, resourceOf('managedEBookCategory', { id: 'e-1', displayName: 'KEEL-RT-Books' }, {
    live: { state: 'present', targetId: 'e-1', payload: live },
  }), 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  assert.deepEqual(renamed.calls.find((call) => call.method === 'PATCH').body, { displayName: 'KEEL-RT-Books' });
});

const tunnel = Object.freeze({
  id: 't-src', displayName: 'KEEL-RT-Tunnel', description: 'Fixture', network: '10.99.0.0/24', dnsServers: ['10.99.0.1'], defaultDomainSuffix: '',
  routesInclude: ['10.98.0.0/16'], routesExclude: [], routeIncludes: ['10.98.0.0/16'], routeExcludes: [], splitDNS: [], listenPort: 443,
  advancedSettings: [], roleScopeTagIds: ['0'], disableUdpConnections: false, lastUpdateDateTime: '2026-10-01T00:00:00Z',
});

test('a Microsoft Tunnel configuration is created and updated with its network, DNS, routes and port, never the older route fields', async () => {
  const graph = idoFakeGraph();
  const created = await applyIntuneExtendedWrite(graph, resourceOf('microsoftTunnelConfiguration', tunnel), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceManagement/microsoftTunnelConfigurations');
  assert.equal(post.version, 'beta');
  for (const field of ['id', 'lastUpdateDateTime', 'routesInclude', 'routesExclude']) assert.equal(field in post.body, false, field);
  assert.deepEqual(post.body.routeIncludes, ['10.98.0.0/16']);
  assert.equal(post.body.network, '10.99.0.0/24');
  assert.equal(post.body.listenPort, 443);

  const path = '/deviceManagement/microsoftTunnelConfigurations/t-1';
  const live = { ...tunnel, id: 't-1', listenPort: 8443, dnsServers: ['10.99.0.2'] };
  const drifted = idoFakeGraph({ seed: { [path]: live } });
  const updated = await applyIntuneExtendedWrite(drifted, resourceOf('microsoftTunnelConfiguration', { ...tunnel, id: 't-1' }, {
    live: { state: 'present', targetId: 't-1', payload: live },
  }), 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  const patch = drifted.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.path, path);
  assert.equal(patch.body.listenPort, 443);
  assert.deepEqual(patch.body.dnsServers, ['10.99.0.1']);
  assert.equal('routesInclude' in patch.body, false);
});

const appleEnrollment = Object.freeze({
  id: 'a-src', displayName: 'KEEL-RT-Apple enrollment', description: 'Fixture', platform: 'iOS', priority: 3, defaultEnrollmentType: 'device',
  availableEnrollmentTypeOptions: [{ ownerType: 'company', enrollmentType: 'device' }, { ownerType: 'personal', enrollmentType: 'accountDrivenUserEnrollment' }],
  createdDateTime: 'x', lastModifiedDateTime: 'x',
});

test('an Apple user enrollment profile is created with its platform, and updated without it; its priority is never written', async () => {
  const graph = idoFakeGraph();
  const created = await applyIntuneExtendedWrite(graph, resourceOf('appleUserInitiatedEnrollmentProfile', appleEnrollment), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceManagement/appleUserInitiatedEnrollmentProfiles');
  assert.equal(post.version, 'beta');
  assert.deepEqual(post.body, {
    displayName: 'KEEL-RT-Apple enrollment', description: 'Fixture', platform: 'iOS', defaultEnrollmentType: 'device',
    availableEnrollmentTypeOptions: appleEnrollment.availableEnrollmentTypeOptions,
  });

  const path = '/deviceManagement/appleUserInitiatedEnrollmentProfiles/a-1';
  const live = { ...appleEnrollment, id: 'a-1', priority: 1, description: 'Changed', defaultEnrollmentType: 'accountDrivenUserEnrollment' };
  const drifted = idoFakeGraph({ seed: { [path]: live } });
  const updated = await applyIntuneExtendedWrite(drifted, resourceOf('appleUserInitiatedEnrollmentProfile', { ...appleEnrollment, id: 'a-1' }, {
    live: { state: 'present', targetId: 'a-1', payload: live },
  }), 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  const patch = drifted.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.body.description, 'Fixture');
  assert.equal(patch.body.defaultEnrollmentType, 'device');
  for (const field of ['platform', 'priority']) assert.equal(field in patch.body, false, field);
});

// ------------------------------------------- restore gaps, batch 9

const branding = Object.freeze({
  id: 'b-src', profileName: 'KEEL-RT-branding', profileDescription: 'Fixture', isDefaultProfile: false, displayName: 'KEEL-RT IT',
  showLogo: false, themeColor: { r: 27, g: 42, b: 74 }, themeColorLogo: null, lightBackgroundLogo: null, landingPageCustomizedImage: null,
  contactITName: 'Help desk', contactITEmailAddress: 'helpdesk@example.com', roleScopeTagIds: ['0'], assignments: [],
  createdDateTime: 'x', lastModifiedDateTime: 'x',
});

test('a branding profile is created and updated through beta, never its logos, assignments or default flag', async () => {
  const graph = idoFakeGraph();
  const created = await applyIntuneExtendedWrite(graph, resourceOf('intuneBrandingProfile', branding), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceManagement/intuneBrandingProfiles');
  assert.equal(post.version, 'beta');
  for (const field of ['id', 'isDefaultProfile', 'themeColorLogo', 'lightBackgroundLogo', 'landingPageCustomizedImage', 'assignments', 'createdDateTime']) {
    assert.equal(field in post.body, false, field);
  }
  assert.deepEqual(post.body.themeColor, { r: 27, g: 42, b: 74 });
  assert.equal(post.body.contactITName, 'Help desk');

  const path = '/deviceManagement/intuneBrandingProfiles/b-1';
  const live = { ...branding, id: 'b-1', contactITName: 'Changed', themeColor: { r: 245, g: 166, b: 35 }, themeColorLogo: { type: 'image/png', value: 'bG9nbw==' } };
  const drifted = idoFakeGraph({ seed: { [path]: live } });
  const updated = await applyIntuneExtendedWrite(drifted, resourceOf('intuneBrandingProfile', { ...branding, id: 'b-1' }, {
    live: { state: 'present', targetId: 'b-1', payload: live },
  }), 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  const patch = drifted.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.path, path);
  assert.equal(patch.body.contactITName, 'Help desk');
  assert.deepEqual(patch.body.themeColor, { r: 27, g: 42, b: 74 });
  assert.equal('themeColorLogo' in patch.body, false, 'the live logo is kept');
});

test('the default branding profile is never written', async () => {
  for (const [verb, extra] of [
    ['create', {}],
    ['update', { live: { state: 'present', targetId: 'd-1', payload: { ...branding, id: 'd-1', isDefaultProfile: true, contactITName: 'Changed' } } }],
  ]) {
    const graph = idoFakeGraph();
    const result = await applyIntuneExtendedWrite(graph, resourceOf('intuneBrandingProfile', { ...branding, id: 'd-1', isDefaultProfile: true }, extra), verb, FAST);
    assert.ok(result.skipped || result.failed, verb);
    assert.match(JSON.stringify(result), /default Company Portal branding/, verb);
    assert.equal(graph.calls.filter((call) => call.method !== 'GET').length, 0, verb);
  }
});

// ------------------------------------------- restore gaps, batch 10

const writesOf = (graph) => graph.calls.filter((call) => call.method !== 'GET');

test('a custom Endpoint analytics baseline is created and renamed by its name only; a built-in one is never written', async () => {
  const baseline = { id: 'bl-src', displayName: 'KEEL-RT-baseline', overallScore: 61, isBuiltIn: false, createdDateTime: 'x' };
  const graph = idoFakeGraph();
  const created = await applyIntuneExtendedWrite(graph, resourceOf('userExperienceAnalyticsBaseline', baseline), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceManagement/userExperienceAnalyticsBaselines');
  assert.equal(post.version, 'beta');
  assert.deepEqual(post.body, { displayName: 'KEEL-RT-baseline' });

  const path = '/deviceManagement/userExperienceAnalyticsBaselines/bl-1';
  const live = { ...baseline, id: 'bl-1', displayName: 'KEEL-RT-baseline (renamed)', overallScore: 70 };
  const renamed = idoFakeGraph({ seed: { [path]: live } });
  const updated = await applyIntuneExtendedWrite(renamed, resourceOf('userExperienceAnalyticsBaseline', { ...baseline, id: 'bl-1' }, {
    live: { state: 'present', targetId: 'bl-1', payload: live },
  }), 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  const patch = renamed.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.path, path);
  assert.deepEqual(patch.body, { displayName: 'KEEL-RT-baseline' });

  for (const [verb, extra] of [
    ['create', {}],
    ['update', { live: { state: 'present', targetId: 'bl-0', payload: { id: 'bl-0', displayName: 'Commercial median', isBuiltIn: true } } }],
  ]) {
    const builtIn = idoFakeGraph();
    const result = await applyIntuneExtendedWrite(builtIn, resourceOf('userExperienceAnalyticsBaseline', { id: 'bl-0', displayName: 'Commercial median', isBuiltIn: true }, extra), verb, FAST);
    assert.ok(result.skipped || result.failed, verb);
    assert.match(JSON.stringify(result), /built-in/, verb);
    assert.equal(writesOf(builtIn).length, 0, verb);
  }
});

test('a classroom cart association is created and updated with its devices and classes', async () => {
  const cart = { id: 'c-src', displayName: 'KEEL-RT-cart', description: 'Fixture', version: 3, deviceIds: [], classroomIds: [], createdDateTime: 'x', lastModifiedDateTime: 'x' };
  const graph = idoFakeGraph();
  const created = await applyIntuneExtendedWrite(graph, resourceOf('cartToClassAssociation', cart), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceManagement/cartToClassAssociations');
  assert.equal(post.version, 'beta');
  assert.deepEqual(post.body, { displayName: 'KEEL-RT-cart', description: 'Fixture', deviceIds: [], classroomIds: [] });

  const path = '/deviceManagement/cartToClassAssociations/c-1';
  const live = { ...cart, id: 'c-1', description: 'Changed', classroomIds: ['class-9'], version: 4 };
  const drifted = idoFakeGraph({ seed: { [path]: live } });
  const updated = await applyIntuneExtendedWrite(drifted, resourceOf('cartToClassAssociation', { ...cart, id: 'c-1' }, {
    live: { state: 'present', targetId: 'c-1', payload: live },
  }), 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  const patch = drifted.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.body.description, 'Fixture');
  assert.deepEqual(patch.body.classroomIds, []);
  assert.equal('version' in patch.body, false);
});

test('a legacy Android work profile enrollment profile is written by name and description, never its token', async () => {
  const profile = { id: 'aw-src', displayName: 'KEEL-RT-android-work', description: 'Fixture', accountId: 'acct-1', tokenExpirationDateTime: '2026-11-01T00:00:00Z', createdDateTime: 'x', lastModifiedDateTime: 'x' };
  const graph = idoFakeGraph();
  const created = await applyIntuneExtendedWrite(graph, resourceOf('androidForWorkEnrollmentProfile', profile), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceManagement/androidForWorkEnrollmentProfiles');
  assert.deepEqual(post.body, { displayName: 'KEEL-RT-android-work', description: 'Fixture' });

  const path = '/deviceManagement/androidForWorkEnrollmentProfiles/aw-1';
  const live = { ...profile, id: 'aw-1', description: 'Changed' };
  const drifted = idoFakeGraph({ seed: { [path]: live } });
  const updated = await applyIntuneExtendedWrite(drifted, resourceOf('androidForWorkEnrollmentProfile', { ...profile, id: 'aw-1' }, {
    live: { state: 'present', targetId: 'aw-1', payload: live },
  }), 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  assert.deepEqual(drifted.calls.find((call) => call.method === 'PATCH').body, { description: 'Fixture' });
});

const deviceOwner = Object.freeze({
  id: 'ad-src', displayName: 'KEEL-RT-android-owner', description: 'Fixture', accountId: 'acct-1', enrollmentMode: 'corporateOwnedDedicatedDevice',
  enrollmentTokenType: 'default', isTeamsDeviceProfile: false, deviceNameTemplate: 'KEEL-{{SERIAL}}', configureWifi: false, wifiSsid: null,
  wifiHidden: false, wifiSecurityType: 'none', roleScopeTagIds: ['0'], tokenCreationDateTime: 'x', tokenExpirationDateTime: 'x', createdDateTime: 'x', lastModifiedDateTime: 'x',
});

test('an Android Enterprise enrollment profile is created with its mode, and updated without mode, token type or token', async () => {
  const graph = idoFakeGraph();
  const created = await applyIntuneExtendedWrite(graph, resourceOf('androidDeviceOwnerEnrollmentProfile', deviceOwner), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceManagement/androidDeviceOwnerEnrollmentProfiles');
  assert.equal(post.version, 'beta');
  assert.equal(post.body.enrollmentMode, 'corporateOwnedDedicatedDevice');
  assert.equal(post.body.deviceNameTemplate, 'KEEL-{{SERIAL}}');
  for (const field of ['id', 'accountId', 'tokenCreationDateTime', 'tokenExpirationDateTime', 'createdDateTime']) assert.equal(field in post.body, false, field);

  const path = '/deviceManagement/androidDeviceOwnerEnrollmentProfiles/ad-1';
  const live = { ...deviceOwner, id: 'ad-1', description: 'Changed', deviceNameTemplate: 'X-{{SERIAL}}' };
  const drifted = idoFakeGraph({ seed: { [path]: live } });
  const updated = await applyIntuneExtendedWrite(drifted, resourceOf('androidDeviceOwnerEnrollmentProfile', { ...deviceOwner, id: 'ad-1' }, {
    live: { state: 'present', targetId: 'ad-1', payload: live },
  }), 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  const patch = drifted.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.body.description, 'Fixture');
  assert.equal(patch.body.deviceNameTemplate, 'KEEL-{{SERIAL}}');
  for (const field of ['enrollmentMode', 'enrollmentTokenType', 'isTeamsDeviceProfile']) assert.equal(field in patch.body, false, field);
});

test('an Android Enterprise profile on a secured Wi-Fi network is written only when the live profile already joins that network', async () => {
  const secured = { ...deviceOwner, configureWifi: true, wifiSsid: 'KEEL-RT-wifi', wifiSecurityType: 'wpa' };
  const refused = idoFakeGraph();
  const create = await applyIntuneExtendedWrite(refused, resourceOf('androidDeviceOwnerEnrollmentProfile', secured), 'create', FAST);
  assert.ok(create.skipped || create.failed);
  assert.match(JSON.stringify(create), /password is not backed up/);
  assert.equal(writesOf(refused).length, 0);

  const otherNetwork = { ...secured, id: 'ad-2', wifiSsid: 'Other' };
  const moved = idoFakeGraph();
  const change = await applyIntuneExtendedWrite(moved, resourceOf('androidDeviceOwnerEnrollmentProfile', { ...secured, id: 'ad-2' }, {
    live: { state: 'present', targetId: 'ad-2', payload: otherNetwork },
  }), 'update', FAST);
  assert.ok(change.skipped || change.failed);
  assert.equal(writesOf(moved).length, 0);

  const path = '/deviceManagement/androidDeviceOwnerEnrollmentProfiles/ad-3';
  const live = { ...secured, id: 'ad-3', description: 'Changed' };
  const same = idoFakeGraph({ seed: { [path]: live } });
  const kept = await applyIntuneExtendedWrite(same, resourceOf('androidDeviceOwnerEnrollmentProfile', { ...secured, id: 'ad-3' }, {
    live: { state: 'present', targetId: 'ad-3', payload: live },
  }), 'update', FAST);
  assert.equal(kept.failed, undefined, kept.failed?.error);
  const patch = same.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.body.description, 'Fixture');
  assert.equal('wifiPassword' in patch.body, false);
});

// ------------------------------------------- restore gaps, batch 11

const admxFile = Object.freeze({
  id: 'gp-src', fileName: 'keel-rt-fixture.admx', displayName: 'keel-rt-fixture.admx', defaultLanguageCode: 'en-US', languageCodes: ['en-US'],
  targetPrefix: 'keelrt', targetNamespace: 'KEEL.RT.Fixture', policyType: 'admxIngested', revision: '1.0', status: 'available',
  uploadDateTime: 'x', lastModifiedDateTime: 'x', content: 'PHBvbGljeURlZmluaXRpb25zLz4=',
  groupPolicyUploadedLanguageFiles: [{ id: 'lf-1', fileName: 'keel-rt-fixture.adml', languageCode: 'en-US', content: 'PHJlc291cmNlcy8+', lastModifiedDateTime: 'x' }],
});

// A fake Graph whose uploaded ADMX file reads back with the status Intune gives it.
function admxGraph(status) {
  const graph = idoFakeGraph();
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => {
    const result = await write(version, path, request);
    const created = `${path}/${result.body?.id}`;
    if (request.method === 'POST' && result.ok) graph.objects.set(created, { ...graph.objects.get(created), status });
    return result;
  };
  return graph;
}

test('an imported ADMX file is uploaded again with its ADML files, and waits for Intune to read it', async () => {
  const graph = admxGraph('available');
  const created = await applyIntuneExtendedWrite(graph, resourceOf('groupPolicyUploadedDefinitionFile', admxFile), 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceManagement/groupPolicyUploadedDefinitionFiles');
  assert.equal(post.version, 'beta');
  assert.deepEqual(post.body, {
    fileName: 'keel-rt-fixture.admx', defaultLanguageCode: 'en-US', content: admxFile.content,
    groupPolicyUploadedLanguageFiles: [{ fileName: 'keel-rt-fixture.adml', languageCode: 'en-US', content: 'PHJlc291cmNlcy8+' }],
  });
  assert.equal(created.applied.changes.status, 'available');
  assert.deepEqual(created.applied.completion, undefined);
  // Never updated in place.
  const update = await applyIntuneExtendedWrite(idoFakeGraph(), resourceOf('groupPolicyUploadedDefinitionFile', admxFile, {
    live: { state: 'present', targetId: 'gp-src', payload: admxFile },
  }), 'update', FAST);
  assert.match(update.failed.error, /unsupported operation/);
});

test('an ADMX upload Intune fails to read fails the restore; one still being read leaves a step', async () => {
  for (const [status, check] of [
    ['uploadFailed', (result) => assert.match(result.failed.error, /uploadFailed/)],
    ['uploadInProgress', (result) => {
      assert.equal(result.failed, undefined, result.failed?.error);
      assert.deepEqual(result.applied.completion.map((step) => step.requirement), ['admxUploadProcessing']);
    }],
  ]) {
    check(await applyIntuneExtendedWrite(admxGraph(status), resourceOf('groupPolicyUploadedDefinitionFile', admxFile), 'create', FAST));
  }
});

test('an ADMX file backed up without its file content is never uploaded', async () => {
  for (const payload of [
    { ...admxFile, content: undefined },
    { ...admxFile, groupPolicyUploadedLanguageFiles: [] },
    { ...admxFile, groupPolicyUploadedLanguageFiles: [{ fileName: 'keel-rt-fixture.adml', languageCode: 'en-US' }] },
  ]) {
    const graph = idoFakeGraph();
    const result = await applyIntuneExtendedWrite(graph, resourceOf('groupPolicyUploadedDefinitionFile', payload), 'create', FAST);
    assert.match(result.skipped.reason, /does not hold its ADMX and ADML file content/);
    assert.equal(writesOf(graph).length, 0);
  }
});

const bios = Object.freeze({
  id: 'hw-1', displayName: 'KEEL-RT-bios', description: 'Fixture', fileName: 'keel-rt.cctk', hardwareConfigurationFormat: 'dell',
  perDevicePasswordDisabled: false, roleScopeTagIds: ['0'], version: 2, createdDateTime: 'x', lastModifiedDateTime: 'x',
});

test('a BIOS configuration is updated in place, never its settings file, and is never created', async () => {
  const path = '/deviceManagement/hardwareConfigurations/hw-1';
  const live = { ...bios, description: 'Changed', perDevicePasswordDisabled: true, version: 3 };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const updated = await applyIntuneExtendedWrite(graph, resourceOf('hardwareConfiguration', bios, {
    live: { state: 'present', targetId: 'hw-1', payload: live },
  }), 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  const patch = graph.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.path, path);
  assert.equal(patch.version, 'beta');
  assert.deepEqual(patch.body, { description: 'Fixture', perDevicePasswordDisabled: false });

  const create = await applyIntuneExtendedWrite(idoFakeGraph(), resourceOf('hardwareConfiguration', bios), 'create', FAST);
  assert.match(create.failed.error, /unsupported operation/);
});

test('a restore never turns per-device BIOS passwords off', async () => {
  const path = '/deviceManagement/hardwareConfigurations/hw-1';
  const graph = idoFakeGraph({ seed: { [path]: bios } });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('hardwareConfiguration', { ...bios, perDevicePasswordDisabled: true, description: 'Old' }, {
    live: { state: 'present', targetId: 'hw-1', payload: bios },
  }), 'update', FAST);
  assert.match(result.skipped.reason, /never weakens BIOS passwords/);
  assert.equal(writesOf(graph).length, 0);
});

test('a policy delete passes the deletion guard and refuses a policy that is still assigned', async () => {
  for (const type of ['deviceCompliancePolicy', 'deviceConfiguration', 'configurationPolicy']) {
    const collection = INTUNE_RECORDS[type].collection;
    const path = `${collection}/p-1`;
    const payload = { '@odata.type': '#microsoft.graph.windows10CompliancePolicy', id: 'p-1', displayName: 'KEEL-RT-Old', name: 'KEEL-RT-Old' };
    const graph = idoFakeGraph({ seed: { [path]: payload } });
    await graph.write('v1.0', `${path}/assign`, { method: 'POST', body: { assignments: [{ target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }] } });
    const resource = resourceOf(type, payload, { live: { state: 'present', targetId: 'p-1', payload } });
    const ctx = { ...FAST, deletionGuardOptions: GUARD, observedCoverage: COMPLETE(type) };

    const assigned = await applyIntuneExtendedWrite(graph, resource, 'delete', ctx);
    assert.match(assigned.skipped.reason, /assigned \(1 assignment\)/, type);
    assert.equal(graph.calls.some((call) => call.method === 'DELETE'), false);

    await graph.write('v1.0', `${path}/assign`, { method: 'POST', body: { assignments: [] } });
    const deleted = await applyIntuneExtendedWrite(graph, resource, 'delete', ctx);
    assert.deepEqual(deleted.applied, { naturalKey: resource.naturalKey, targetId: 'p-1' }, type);
    assert.equal(graph.objects.has(path), false);
  }
});

test('a policy delete needs a complete observation and break-glass accounts', async () => {
  const path = '/deviceManagement/windowsFeatureUpdateProfiles/p-2';
  const payload = { id: 'p-2', displayName: 'KEEL-RT-Feature' };
  const graph = idoFakeGraph({ seed: { [path]: payload } });
  const resource = resourceOf('windowsFeatureUpdateProfile', payload, { live: { state: 'present', targetId: 'p-2', payload } });
  const partial = await applyIntuneExtendedWrite(graph, resource, 'delete', { ...FAST, deletionGuardOptions: GUARD, observedCoverage: { windowsFeatureUpdateProfile: { outcome: 'failed' } } });
  assert.match(partial.failed.error, /partial observation/);
  await assert.rejects(() => applyIntuneExtendedWrite(graph, resource, 'delete', { ...FAST, deletionGuardOptions: { breakGlassUserIds: [] }, observedCoverage: COMPLETE('windowsFeatureUpdateProfile') }), /break-glass/);
  assert.equal(graph.calls.some((call) => call.method === 'DELETE'), false);
});

test('a delete that does not read back as gone fails', async () => {
  const path = '/deviceAppManagement/targetedManagedAppConfigurations/c-1';
  const payload = { id: 'c-1', displayName: 'KEEL-RT-Cfg' };
  const graph = idoFakeGraph({
    seed: { [path]: payload },
    failWrites: ({ method }) => (method === 'DELETE' ? { ok: true, status: 204, body: null } : null),
  });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('targetedManagedAppConfiguration', payload, {
    live: { state: 'present', targetId: 'c-1', payload },
  }), 'delete', { ...FAST, deletionGuardOptions: GUARD, observedCoverage: COMPLETE('targetedManagedAppConfiguration') });
  assert.match(result.failed.error, /did not verify/);
});

test('create and update stay on the built-in path for the three built-in policy types', async () => {
  for (const type of Object.keys(INTUNE_RECORDS)) assert.deepEqual(INTUNE_EXTENDED_RECORDS[type].operations, ['delete']);
  const result = await applyIntuneExtendedWrite(idoFakeGraph(), resourceOf('deviceConfiguration', { displayName: 'x' }), 'create', FAST);
  assert.match(result.failed.error, /unsupported operation/);
});

test('every record operation is in the ledger, and best-effort types have no record', () => {
  const ledger = buildIntuneExtendedLedger().operations;
  for (const { resourceType, operation } of intuneExtendedOperations()) {
    assert.ok(ledger.some((row) => row.resourceType === resourceType && row.operation === operation), `${resourceType} ${operation}`);
  }
  for (const type of Object.keys(INTUNE_BEST_EFFORT)) assert.equal(INTUNE_EXTENDED_RECORDS[type], undefined, type);
});
