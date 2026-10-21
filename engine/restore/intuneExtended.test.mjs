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

// ------------------------------------------------------------------- delete

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
