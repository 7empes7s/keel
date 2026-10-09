/**
 * Issue #155 boundary tests: Intune compliance policies, device configuration
 * profiles and settings catalog policies are restored (create and update) with
 * their assignments; every other Intune type has an explicit manual decision;
 * assignments are collected for every policy type that has them.
 *
 * Every test drives the production code (applyWave, the relationship
 * collector, collectSnapshot, the restore planning helper) against an
 * in-memory fake Graph. Nothing here reads or writes a tenant. Required
 * mutation checks:
 *
 * - Send a server-owned field (id, version, a child id) in a write body.
 * - Write a policy whose backup holds a password, key or certificate.
 * - Write an assignment to a group that does not exist in the target.
 * - Create a compliance policy without its actions for noncompliance.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { fakeGraph, runFixtureHarness } from '../../tools/qualification/operations.mjs';
import { CATALOG, catalogReadPath } from '../../tools/tenant-probe/catalog.mjs';
import { COLLECT_RELATIONSHIPS, describeAssignmentReads } from '../../cli/keel-collect.mjs';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import '../collect/entraAdapter.mjs';
import {
  ASSIGNMENT_PARENT_TYPES, collectRelationships, loadSnapshotRelationships,
} from '../collect/relationships.mjs';
import { collectSnapshot } from '../collect/snapshot.mjs';
import { OPERATIONS, capabilityFor } from '../coverage/capabilities.mjs';
import { TYPE_DECISIONS, buildExpansionInventory, buildOperationLedger, qualificationFor } from '../coverage/qualification.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import {
  INTUNE_RECORDS, assignmentPlan, attachIntuneAssignments, buildIntuneLedger, intuneSecretFields, intuneWriteBody,
} from '../restore/intuneOperations.mjs';
import { selectRecoveryMechanism } from '../restore/recoveryMechanism.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const PROOF = 'engine/roadmap/intune-restore.test.mjs';
const RESTORABLE = Object.freeze(['deviceCompliancePolicy', 'deviceConfiguration', 'configurationPolicy']);
const INTUNE_TYPES = Object.freeze([
  'deviceConfiguration', 'deviceCompliancePolicy', 'configurationPolicy', 'deviceEnrollmentConfiguration',
  'windowsAutopilotDeploymentProfile', 'managedAppPolicy', 'targetedManagedAppConfiguration', 'mobileAppConfiguration',
  'deviceManagementIntent', 'deviceCategory', 'termsAndConditions', 'deviceManagementRoleDefinition', 'mobileApp', 'managedDevice',
]);

// Source-tenant and target-tenant ids of the same groups differ: a group is
// always mapped by natural key, never written by its backup id.
const SOURCE_FINANCE = '1a1a1a1a-0000-4000-8000-000000000001';
const TARGET_FINANCE = '2b2b2b2b-0000-4000-8000-000000000002';
const SOURCE_KIOSKS = '3c3c3c3c-0000-4000-8000-000000000003';
const TARGET_KIOSKS = '4d4d4d4d-0000-4000-8000-000000000004';
const FILTER = '5e5e5e5e-0000-4000-8000-000000000005';
const TARGETS = new Map([['group:finance', TARGET_FINANCE], ['group:kiosks', TARGET_KIOSKS]]);

const compliance = Object.freeze({
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#deviceManagement/deviceCompliancePolicies/$entity',
  '@odata.type': '#microsoft.graph.windows10CompliancePolicy',
  id: 'source-compliance', createdDateTime: '2026-01-01T00:00:00Z', lastModifiedDateTime: '2026-09-01T00:00:00Z', version: 7,
  displayName: 'Windows baseline', description: 'Require BitLocker', roleScopeTagIds: ['0'],
  passwordRequired: true, passwordMinimumLength: 12, bitLockerEnabled: true, secureBootEnabled: true,
  scheduledActionsForRule: [{
    id: 'rule-id', ruleName: 'PasswordRequired',
    scheduledActionConfigurations: [
      { id: 'action-1', actionType: 'block', gracePeriodHours: 24, notificationTemplateId: '00000000-0000-0000-0000-000000000000', notificationMessageCCList: [] },
    ],
  }],
});

const restrictions = Object.freeze({
  '@odata.type': '#microsoft.graph.windows10GeneralConfiguration',
  id: 'source-config', version: 4, supportsScopeTags: true, createdDateTime: '2026-01-01T00:00:00Z',
  displayName: 'Windows restrictions', description: 'Camera and store', roleScopeTagIds: ['0'],
  cameraBlocked: true, storageBlockRemovableStorage: true, passwordRequired: true,
});

const catalogPolicy = Object.freeze({
  id: 'source-catalog', name: 'Defender real-time', description: 'Settings catalog', platforms: 'windows10', technologies: 'mdm',
  roleScopeTagIds: ['0'], settingCount: 1, creationSource: null, isAssigned: true, lastModifiedDateTime: '2026-09-01T00:00:00Z',
  templateReference: { templateId: '', templateFamily: 'none', templateDisplayName: null, templateDisplayVersion: null },
  settings: [{
    id: '0',
    settingInstance: {
      '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance',
      settingDefinitionId: 'device_vendor_msft_policy_config_defender_allowrealtimemonitoring',
      settingInstanceTemplateReference: null,
      choiceSettingValue: { value: 'device_vendor_msft_policy_config_defender_allowrealtimemonitoring_1', settingValueTemplateReference: null, children: [] },
    },
  }],
});

const groupAssignment = (sourceId, naturalKey, { exclusion = false, filter = null } = {}) => ({
  edgeKey: `${exclusion ? 'exclusionGroupAssignmentTarget' : 'groupAssignmentTarget'}|${sourceId}`,
  targetId: sourceId, targetType: 'group', targetNaturalKey: naturalKey,
  attributes: {
    targetType: exclusion ? 'exclusionGroupAssignmentTarget' : 'groupAssignmentTarget', mode: exclusion ? 'exclude' : 'include',
    filterId: filter, filterType: filter ? 'include' : 'none', intent: null, settingsDigest: null,
  },
});
const allDevices = Object.freeze({
  edgeKey: 'allDevicesAssignmentTarget|all-devices', targetId: 'all-devices', targetType: 'allDevices', targetNaturalKey: null,
  attributes: { targetType: 'allDevicesAssignmentTarget', mode: 'include', filterId: null, filterType: null, intent: null, settingsDigest: null },
});

/** fakeGraph plus the method, path and body of every write, and the version of every call. */
function recordingGraph({ readOverride = null } = {}) {
  const graph = fakeGraph();
  const bodies = [];
  const reads = [];
  const write = graph.write.bind(graph);
  const read = graph.read.bind(graph);
  graph.write = async (version, path, request) => {
    bodies.push({ version, method: request.method, path, body: request.body });
    return write(version, path, request);
  };
  graph.read = async (version, path) => {
    reads.push({ version, path });
    const result = await read(version, path);
    return readOverride && result.ok ? { ...result, body: readOverride(path, result.body) } : result;
  };
  graph.bodies = bodies;
  graph.reads = reads;
  return graph;
}

function immediateTimers(t) {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => original(fn, 0, ...args);
  t.after(() => { globalThis.setTimeout = original; });
}

const keyOf = (resourceType, payload) => `${resourceType}:${payload.displayName ?? payload.name}`;

function plannedCreate(resourceType, payload, extra = {}) {
  return { naturalKey: keyOf(resourceType, payload), resourceType, verb: 'create', payload, references: [], blastRadius: 'access-affecting', ...extra };
}

function plannedUpdate(graph, resourceType, desired, live, extra = {}) {
  const targetId = 'target-policy';
  graph.objects.set(`${INTUNE_RECORDS[resourceType].collection}/${targetId}`, { ...live, id: targetId });
  return {
    naturalKey: keyOf(resourceType, desired), resourceType, verb: 'update', payload: desired, references: [],
    blastRadius: 'access-affecting', targetId, live: { state: 'present', targetId, payload: { ...live, id: targetId } }, ...extra,
  };
}

const run = (graph, wave, options = {}) => applyWave(graph, governor, wave, {
  targetTenant: 'fixture', mode: 'enforce', existingTargetIds: new Map(TARGETS), ...options,
});

const ODATA_ANNOTATION = /@odata\.(?!type$)/;
function assertNoServerOwned(body, label) {
  for (const field of ['id', 'createdDateTime', 'lastModifiedDateTime', 'version', 'supportsScopeTags', 'settingCount', 'creationSource', 'isAssigned']) {
    assert.ok(!Object.hasOwn(body, field), `${label}: ${field} is never sent`);
  }
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /"id":/, `${label}: no child id is sent`);
  assert.ok(!Object.keys(body).some((key) => ODATA_ANNOTATION.test(key)), `${label}: no @odata annotation but the type`);
}

// ------------------------------------------------------------------ registry

test('compliance, device configuration and settings catalog create/update are fixture-tested; delete stays unsupported', () => {
  for (const resourceType of RESTORABLE) {
    for (const operation of OPERATIONS) {
      const capability = capabilityFor(resourceType, operation);
      if (operation === 'create' || operation === 'update') {
        assert.equal(capability.claim, 'fixture-tested', `${resourceType} ${operation}`);
        assert.equal(capability.proofRef, PROOF);
        assert.equal(capability.path, INTUNE_RECORDS[resourceType].collection);
      } else {
        assert.equal(capability.claim, 'unsupported', `${resourceType} ${operation}`);
      }
    }
    assert.equal(qualificationFor(resourceType).decision, 'automated');
  }
  assert.equal(INTUNE_RECORDS.configurationPolicy.version, 'beta', 'the settings catalog is beta-only');
  assert.equal(INTUNE_RECORDS.deviceCompliancePolicy.version, 'v1.0');
  assert.equal(INTUNE_RECORDS.deviceConfiguration.version, 'v1.0');
  assert.equal(buildIntuneLedger().operations.length, RESTORABLE.length * 2);
});

test('no Intune type is left unknown: every other one is manual with a plain reason', () => {
  const ledger = buildOperationLedger();
  for (const type of INTUNE_TYPES) {
    const decision = TYPE_DECISIONS[type];
    assert.notEqual(decision.decision, 'unknown', `${type} has an explicit decision`);
    assert.ok(decision.reason.length > 20, `${type} says why`);
    assert.doesNotMatch(decision.reason, /[0-9a-f]{8}-[0-9a-f]{4}-/i, `${type}: no raw id in the reason`);
    if (!RESTORABLE.includes(type)) {
      assert.equal(decision.decision, 'manual', type);
      const row = ledger.types.find((entry) => entry.resourceType === type);
      assert.ok(row.operations.every((op) => op.decision === 'manual'), `${type} has no supported operation`);
    }
  }
  const batch = buildExpansionInventory().batches.find((entry) => entry.id === 'device-management');
  assert.ok(batch.types.every((entry) => entry.status !== 'research-needed'), 'nothing in the Intune batch is left for research');
  for (const type of RESTORABLE) assert.equal(batch.types.find((entry) => entry.resourceType === type).status, 'qualified-subset');
});

test('the fixture harness drives every Intune record through applyWave', async () => {
  const results = await runFixtureHarness({ types: RESTORABLE });
  assert.equal(results.length, 6);
  assert.deepEqual(results.filter((result) => result.result !== 'passed'), []);
  const settingsUpdate = results.find((result) => result.resourceType === 'configurationPolicy' && result.operation === 'update');
  assert.ok(settingsUpdate.writes.includes('PUT /deviceManagement/configurationPolicies/fixture-existing'));
});

// ---------------------------------------------------------------- collection

test('assignments are read for every policy type with an /assignments collection', async () => {
  const calls = [];
  const reader = { async collect(version, path) { calls.push({ version, path }); return { items: [], pages: 1, status: 200 }; } };
  const parents = ASSIGNMENT_PARENT_TYPES.map((type) => ({ type, sourceId: `${type}-id`, naturalKey: `${type}:x` }));
  const observations = await collectRelationships(reader, { tenantRef: 'sha256:t', parents, families: ['assignment'] });
  for (const type of ['deviceConfiguration', 'deviceCompliancePolicy', 'configurationPolicy', 'deviceEnrollmentConfiguration',
    'windowsAutopilotDeploymentProfile', 'targetedManagedAppConfiguration', 'mobileAppConfiguration', 'deviceManagementIntent', 'termsAndConditions']) {
    assert.equal(observations.find((obs) => obs.parentType === type).outcome, 'complete-empty', `${type} assignments are read`);
  }
  // An app protection policy is routed by its platform subtype; the tenant default has no assignments.
  const ios = await collectRelationships(reader, {
    tenantRef: 'sha256:t', families: ['assignment'],
    parents: [
      { type: 'managedAppPolicy', sourceId: 'ios-id', subtype: '#microsoft.graph.iosManagedAppProtection' },
      { type: 'managedAppPolicy', sourceId: 'default-id', subtype: '#microsoft.graph.defaultManagedAppProtection' },
      { type: 'deviceCategory', sourceId: 'cat-id' },
    ],
  });
  assert.ok(calls.some((call) => call.path === '/deviceAppManagement/iosManagedAppProtections/ios-id/assignments'));
  assert.equal(ios[1].outcome, 'unsupported');
  assert.match(ios[1].error, /defaultManagedAppProtection/);
  assert.equal(ios[2].outcome, 'unsupported', 'a device category has no assignments to read');
  assert.equal(calls.filter((call) => call.path.includes('cat-id')).length, 0);
  assert.deepEqual(COLLECT_RELATIONSHIPS.families, ['assignment'], 'every scheduled backup reads assignments');
});

test('compliance actions and settings catalog settings are collected through $expand', () => {
  const byType = new Map(CATALOG.map((entry) => [entry.type, entry]));
  assert.equal(catalogReadPath(byType.get('deviceCompliancePolicy')),
    '/deviceManagement/deviceCompliancePolicies?$expand=scheduledActionsForRule($expand=scheduledActionConfigurations)');
  assert.equal(catalogReadPath(byType.get('configurationPolicy')), '/deviceManagement/configurationPolicies?$expand=settings');
  assert.equal(catalogReadPath(byType.get('deviceConfiguration')), '/deviceManagement/deviceConfigurations');
});

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

test('a backup records each policy\'s assignments with group, filter and kind, ready for restore', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = 'sha256:intune-backup';
  const reader = {
    async collect(version, path) {
      const ok = (items) => ({ items, pages: 1, status: 200, capped: false, error: null });
      if (path === '/groups' || path.startsWith('/groups?')) return ok([{ id: SOURCE_FINANCE, displayName: 'Finance', mailNickname: 'finance' }]);
      if (path === catalogReadPath(CATALOG.find((entry) => entry.type === 'deviceCompliancePolicy'))) return ok([{ ...compliance, id: 'p-1' }]);
      if (path === '/deviceAppManagement/managedAppPolicies') return ok([{ id: 'app-1', displayName: 'iOS protection', '@odata.type': '#microsoft.graph.iosManagedAppProtection' }]);
      if (path === '/deviceManagement/deviceCompliancePolicies/p-1/assignments') {
        return ok([{ id: 'a1', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: SOURCE_FINANCE, deviceAndAppManagementAssignmentFilterId: FILTER, deviceAndAppManagementAssignmentFilterType: 'include' } }]);
      }
      if (path === '/deviceAppManagement/iosManagedAppProtections/app-1/assignments') {
        return ok([{ id: 'a2', target: { '@odata.type': '#microsoft.graph.allLicensedUsersAssignmentTarget' } }]);
      }
      return ok([]);
    },
  };
  const result = await collectSnapshot(client, { reader, tenantRef, tenantId: 'tid', relationships: COLLECT_RELATIONSHIPS });
  assert.equal(result.coverageDigest.deviceCompliancePolicy.outcome, 'complete');
  const sets = await loadSnapshotRelationships(client, { snapshotId: result.snapshotId, families: ['assignment'] });
  const policy = sets.get('deviceCompliancePolicy:Windows baseline|assignment');
  assert.equal(policy?.outcome, 'complete', JSON.stringify([...sets.keys()]));
  assert.equal(policy.targets[0].targetNaturalKey, 'group:finance', 'the group is named by natural key');
  assert.equal(policy.targets[0].attributes.filterId, FILTER);
  assert.equal(policy.targets[0].attributes.targetType, 'groupAssignmentTarget');
  const appProtection = [...sets.values()].find((set) => set.parentType === 'managedAppPolicy');
  assert.equal(appProtection.outcome, 'complete', 'an iOS app protection policy is read through its own collection');
  assert.equal(appProtection.targets[0].attributes.targetType, 'allLicensedUsersAssignmentTarget');
});

// --------------------------------------------------------------- write bodies

test('mutation: no server-owned field or child id reaches a write body; @odata.type does where Graph needs it', () => {
  const create = intuneWriteBody('deviceCompliancePolicy', compliance, 'create');
  assertNoServerOwned(create, 'compliance create');
  assert.equal(create['@odata.type'], '#microsoft.graph.windows10CompliancePolicy');
  assert.deepEqual(create.scheduledActionsForRule, [{
    ruleName: 'PasswordRequired',
    scheduledActionConfigurations: [{ actionType: 'block', gracePeriodHours: 24, notificationTemplateId: '00000000-0000-0000-0000-000000000000', notificationMessageCCList: [] }],
  }]);
  assert.ok(!('scheduledActionsForRule' in intuneWriteBody('deviceCompliancePolicy', compliance, 'update')), 'PATCH never carries the actions');
  assertNoServerOwned(intuneWriteBody('deviceConfiguration', restrictions, 'update'), 'configuration update');
  const settings = intuneWriteBody('configurationPolicy', catalogPolicy, 'create');
  assertNoServerOwned(settings, 'settings catalog create');
  assert.ok(!('@odata.type' in settings), 'a settings catalog policy is not a derived type');
  assert.equal(settings.settings[0].settingInstance['@odata.type'], '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance', 'a setting keeps its own kind');
});

test('server-owned changes (version, child ids, counts) are not drift', () => {
  const bumped = {
    ...catalogPolicy, settingCount: 9, isAssigned: false,
    settings: catalogPolicy.settings.map((setting) => ({ ...setting, id: '7' })),
  };
  assert.equal(canonicalHash(bumped, 'configurationPolicy'), canonicalHash(catalogPolicy, 'configurationPolicy'));
  assert.equal(canonicalHash({ ...restrictions, version: 99 }, 'deviceConfiguration'), canonicalHash(restrictions, 'deviceConfiguration'));
  const renumbered = { ...compliance, version: 8, scheduledActionsForRule: [{ ...compliance.scheduledActionsForRule[0], id: 'other' }] };
  assert.equal(canonicalHash(renumbered, 'deviceCompliancePolicy'), canonicalHash(compliance, 'deviceCompliancePolicy'));
  assert.notEqual(canonicalHash({ ...restrictions, cameraBlocked: false }, 'deviceConfiguration'), canonicalHash(restrictions, 'deviceConfiguration'));
});

test('settings catalog template ids are Microsoft-global, never a reference to remap', () => {
  const templated = {
    ...catalogPolicy,
    templateReference: { templateId: 'd02f2162-fcac-48db-9b7b-b0a3f160d2c2_1', templateFamily: 'endpointSecurityAntivirus' },
    settings: [{
      id: '0',
      settingInstance: {
        ...catalogPolicy.settings[0].settingInstance,
        settingInstanceTemplateReference: { settingInstanceTemplateId: 'b7f4d3ba-6a2a-4c4c-9c5a-0f4c3a1b2c3d' },
        choiceSettingValue: { ...catalogPolicy.settings[0].settingInstance.choiceSettingValue, settingValueTemplateReference: { settingValueTemplateId: 'c8e5e4cb-7b3b-4d5d-8d6b-1a5d4b2c3d4e', useTemplateDefault: false } },
      },
    }],
  };
  const [resource] = canonicalizeAll([['configurationPolicy', [templated]]]);
  assert.ok(resource.references.every((ref) => ref.symbol?.startsWith('global:')), JSON.stringify(resource.references));
});

// ------------------------------------------------------------------- secrets

test('mutation: a policy holding a password, key, certificate or encrypted setting is manual and never written', async () => {
  const cases = [
    ['deviceConfiguration', { ...restrictions, '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [{ '@odata.type': '#microsoft.graph.omaSettingString', omaUri: './Vendor/MSFT/x', isEncrypted: true, value: '****' }] }],
    ['deviceConfiguration', { ...restrictions, '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [{ omaUri: './Vendor/MSFT/y', secretReferenceValueId: 'ref-1', value: null }] }],
    ['deviceConfiguration', { ...restrictions, '@odata.type': '#microsoft.graph.windows10GeneralConfiguration', enterpriseCloudPrintOAuthClientSecret: null }],
    ['deviceConfiguration', { ...restrictions, '@odata.type': '#microsoft.graph.iosWiFiConfiguration', ssid: 'Office', preSharedKey: null }],
    ['deviceConfiguration', { ...restrictions, '@odata.type': '#microsoft.graph.windows81TrustedRootCertificate', trustedRootCertificate: null }],
    ['configurationPolicy', {
      ...catalogPolicy,
      settings: [{ id: '0', settingInstance: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance', settingDefinitionId: 'vpn_key', simpleSettingValue: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationSecretSettingValue', valueState: 'encryptedValueToken', value: null } } }],
    }],
  ];
  for (const [resourceType, payload] of cases) {
    for (const verb of ['create', 'update']) {
      const graph = recordingGraph();
      const resource = verb === 'create' ? plannedCreate(resourceType, payload) : plannedUpdate(graph, resourceType, payload, payload);
      const outcome = await run(graph, [resource]);
      assert.equal(outcome.skipped.length, 1, `${payload['@odata.type'] ?? resourceType} ${verb} is skipped`);
      assert.match(outcome.skipped[0].reason, /^manual: /);
      assert.deepEqual(graph.bodies, [], 'nothing is written as a blank');
    }
  }
  assert.deepEqual(intuneSecretFields(compliance), [], 'password settings (passwordRequired, passwordMinimumLength) are settings, not secrets');
  assert.deepEqual(intuneSecretFields(restrictions), []);
});

// ------------------------------------------------------------- compliance

test('mutation: a compliance policy is never created without its actions for noncompliance', async () => {
  const graph = recordingGraph();
  const { scheduledActionsForRule: _dropped, ...withoutActions } = compliance;
  const outcome = await run(graph, [plannedCreate('deviceCompliancePolicy', withoutActions)]);
  assert.equal(outcome.failed.length, 1);
  assert.match(outcome.failed[0].error, /actions for noncompliance/);
  assert.deepEqual(graph.bodies, []);
});

test('a compliance policy is created with its actions and assigned to the target tenant\'s groups', async () => {
  const graph = recordingGraph();
  const resource = plannedCreate('deviceCompliancePolicy', compliance, {
    assignments: { outcome: 'complete', targets: [groupAssignment(SOURCE_FINANCE, 'group:finance'), groupAssignment(SOURCE_KIOSKS, 'group:kiosks', { exclusion: true }), allDevices] },
  });
  const outcome = await run(graph, [resource]);
  assert.deepEqual(outcome.failed, []);
  assert.equal(outcome.applied.length, 1);
  const [post, assign] = graph.bodies;
  assert.equal(post.method, 'POST');
  assert.equal(post.path, '/deviceManagement/deviceCompliancePolicies');
  assert.equal(post.version, 'v1.0');
  assertNoServerOwned(post.body, 'compliance POST');
  const targetId = outcome.applied[0].targetId;
  assert.equal(assign.path, `/deviceManagement/deviceCompliancePolicies/${targetId}/assign`);
  const targets = assign.body.assignments.map((entry) => entry.target);
  assert.ok(assign.body.assignments.every((entry) => entry['@odata.type'] === '#microsoft.graph.deviceCompliancePolicyAssignment'));
  assert.ok(targets.some((target) => target.groupId === TARGET_FINANCE && target['@odata.type'] === '#microsoft.graph.groupAssignmentTarget'));
  assert.ok(targets.some((target) => target.groupId === TARGET_KIOSKS && target['@odata.type'] === '#microsoft.graph.exclusionGroupAssignmentTarget'));
  assert.ok(targets.some((target) => target['@odata.type'] === '#microsoft.graph.allDevicesAssignmentTarget'));
  assert.ok(!JSON.stringify(assign.body).includes(SOURCE_FINANCE), 'a backup group id is never written');
  assert.equal(outcome.applied[0].changes.assignments, 'written');
});

test('a compliance update PATCHes only what changed, and rewrites changed actions through scheduleActionsForRules', async () => {
  const graph = recordingGraph();
  const live = {
    ...compliance, passwordMinimumLength: 4,
    scheduledActionsForRule: [{ ...compliance.scheduledActionsForRule[0], id: 'live-rule', scheduledActionConfigurations: [{ ...compliance.scheduledActionsForRule[0].scheduledActionConfigurations[0], id: 'live-action', gracePeriodHours: 720 }] }],
  };
  const outcome = await run(graph, [plannedUpdate(graph, 'deviceCompliancePolicy', compliance, live)]);
  assert.deepEqual(outcome.failed, []);
  const [patch, actions] = graph.bodies;
  assert.equal(patch.method, 'PATCH');
  assert.deepEqual(patch.body, { '@odata.type': '#microsoft.graph.windows10CompliancePolicy', passwordMinimumLength: 12 });
  assert.equal(actions.path, '/deviceManagement/deviceCompliancePolicies/target-policy/scheduleActionsForRules');
  assert.equal(actions.body.deviceComplianceScheduledActionForRules[0].scheduledActionConfigurations[0].gracePeriodHours, 24);
  assert.equal(graph.bodies.length, 2, 'no assignment is written when the backup holds no assignment read');
  assert.match(outcome.applied[0].changes.assignments, /left as they are/);
});

test('a policy whose kind changed live is refused, never PATCHed into another kind', async () => {
  const graph = recordingGraph();
  const live = { ...compliance, '@odata.type': '#microsoft.graph.iosCompliancePolicy' };
  const outcome = await run(graph, [plannedUpdate(graph, 'deviceCompliancePolicy', compliance, live)]);
  assert.match(outcome.failed[0].error, /cannot change kind/);
  assert.deepEqual(graph.bodies, []);
});

// ------------------------------------------------------- device configuration

test('a device configuration update PATCHes the changed fields with its kind, and verifies them by reading back', async () => {
  const graph = recordingGraph();
  const outcome = await run(graph, [plannedUpdate(graph, 'deviceConfiguration', restrictions, { ...restrictions, cameraBlocked: false, version: 9 })]);
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(graph.bodies[0].body, { '@odata.type': '#microsoft.graph.windows10GeneralConfiguration', cameraBlocked: true });
  assert.deepEqual(outcome.applied[0].changes.fields, ['cameraBlocked']);
});

test('a write that does not read back as written fails with the field named', async (t) => {
  immediateTimers(t);
  const graph = recordingGraph({ readOverride: (path, body) => (path.startsWith('/deviceManagement/deviceConfigurations/') && !path.endsWith('/assignments') ? { ...body, cameraBlocked: false } : body) });
  const outcome = await run(graph, [plannedUpdate(graph, 'deviceConfiguration', restrictions, { ...restrictions, cameraBlocked: false })]);
  assert.equal(outcome.applied.length, 0);
  assert.match(outcome.failed[0].error, /cameraBlocked did not read back as written/);
});

test('a policy already matching its backup and assignments is not written', async () => {
  const graph = recordingGraph();
  const resource = plannedUpdate(graph, 'deviceConfiguration', restrictions, restrictions, {
    assignments: { outcome: 'complete', targets: [groupAssignment(SOURCE_FINANCE, 'group:finance')] },
  });
  graph.objects.set('/deviceManagement/deviceConfigurations/target-policy/assignments', {
    value: [{ id: 'x', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: TARGET_FINANCE, deviceAndAppManagementAssignmentFilterType: 'none' } }],
  });
  const outcome = await run(graph, [resource]);
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(graph.bodies, []);
  assert.equal(outcome.applied[0].changes.assignments, 'already as in the backup');
});

// ------------------------------------------------------------ settings catalog

test('a settings catalog policy is created and replaced through Graph beta, settings included', async () => {
  const createGraph = recordingGraph();
  const created = await run(createGraph, [plannedCreate('configurationPolicy', catalogPolicy)]);
  assert.deepEqual(created.failed, []);
  assert.equal(createGraph.bodies[0].version, 'beta');
  assert.equal(createGraph.bodies[0].path, '/deviceManagement/configurationPolicies');
  assert.equal(createGraph.bodies[0].body.settings.length, 1);
  assert.ok(createGraph.reads.every((read) => read.version === 'beta'));

  const graph = recordingGraph();
  const live = {
    ...catalogPolicy, description: 'changed',
    settings: [{ id: '0', settingInstance: { ...catalogPolicy.settings[0].settingInstance, choiceSettingValue: { ...catalogPolicy.settings[0].settingInstance.choiceSettingValue, value: 'device_vendor_msft_policy_config_defender_allowrealtimemonitoring_0' } } }],
  };
  const updated = await run(graph, [plannedUpdate(graph, 'configurationPolicy', catalogPolicy, live)]);
  assert.deepEqual(updated.failed, []);
  assert.equal(graph.bodies[0].method, 'PUT');
  assert.equal(graph.bodies[0].version, 'beta');
  assert.equal(graph.bodies[0].body.settings[0].settingInstance.choiceSettingValue.value, 'device_vendor_msft_policy_config_defender_allowrealtimemonitoring_1');
  assert.deepEqual(updated.applied[0].changes.fields.sort(), ['description', 'settings']);
});

test('a settings catalog backup without its settings never empties the live policy', async () => {
  const { settings: _settings, ...nameOnly } = catalogPolicy;
  const graph = recordingGraph();
  const outcome = await run(graph, [plannedUpdate(graph, 'configurationPolicy', nameOnly, catalogPolicy)]);
  assert.match(outcome.failed[0].error, /would empty the policy/);
  assert.deepEqual(graph.bodies, []);
});

// ---------------------------------------------------------------- assignments

test('mutation: an assignment to a group missing in the target refuses the policy before any write, dry run included', async () => {
  for (const mode of ['enforce', 'dry-run']) {
    const graph = recordingGraph();
    const resource = plannedCreate('deviceConfiguration', restrictions, {
      assignments: { outcome: 'complete', targets: [groupAssignment(SOURCE_FINANCE, 'group:finance'), groupAssignment('9f9f9f9f-0000-4000-8000-000000000009', 'group:contractors')] },
    });
    const outcome = await run(graph, [resource], { mode });
    assert.equal(outcome.applied.length, 0, mode);
    assert.match(outcome.failed[0].error, /the group group:contractors does not exist in the target/);
    assert.doesNotMatch(outcome.failed[0].error, /9f9f9f9f/, 'no raw id in the refusal');
    assert.deepEqual(graph.bodies, []);
  }
});

test('a group created earlier in the same run is assigned by its new id', async () => {
  const graph = recordingGraph();
  const resource = plannedCreate('deviceConfiguration', restrictions, {
    assignments: { outcome: 'complete', targets: [groupAssignment(SOURCE_FINANCE, 'group:new-starters')] },
  });
  const outcome = await run(graph, [resource], { appliedIds: new Map([['group:new-starters', 'created-group-id']]) });
  assert.deepEqual(outcome.failed, []);
  assert.equal(graph.bodies.at(-1).body.assignments[0].target.groupId, 'created-group-id');
});

test('an incomplete assignment read leaves live assignments untouched, never cleared', async () => {
  for (const assignments of [undefined, { outcome: 'partial', targets: [] }, { outcome: 'failed', targets: [] }, { outcome: 'unsupported', targets: [] }]) {
    const graph = recordingGraph();
    const resource = plannedUpdate(graph, 'deviceConfiguration', restrictions, { ...restrictions, cameraBlocked: false }, assignments ? { assignments } : {});
    const outcome = await run(graph, [resource]);
    assert.deepEqual(outcome.failed, []);
    assert.ok(graph.bodies.every((body) => !body.path.endsWith('/assign')), `${assignments?.outcome ?? 'no read'}: nothing is assigned`);
    assert.ok(graph.reads.every((read) => !read.path.endsWith('/assignments')), 'live assignments are not even read');
  }
});

test('assignments that differ from live are replaced through /assign; an empty backup set clears them only when complete', async () => {
  const graph = recordingGraph();
  const resource = plannedUpdate(graph, 'deviceConfiguration', restrictions, restrictions, { assignments: { outcome: 'complete-empty', targets: [] } });
  graph.objects.set('/deviceManagement/deviceConfigurations/target-policy/assignments', {
    value: [{ id: 'x', target: { '@odata.type': '#microsoft.graph.allLicensedUsersAssignmentTarget' } }],
  });
  const outcome = await run(graph, [resource]);
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(graph.bodies, [{ version: 'v1.0', method: 'POST', path: '/deviceManagement/deviceConfigurations/target-policy/assign', body: { assignments: [] } }]);
});

test('an assignment filter must exist in the target before anything is written', async () => {
  const graph = recordingGraph();
  const resource = plannedCreate('deviceConfiguration', restrictions, {
    assignments: { outcome: 'complete', targets: [groupAssignment(SOURCE_FINANCE, 'group:finance', { filter: FILTER })] },
  });
  const missing = await run(graph, [resource]);
  assert.match(missing.failed[0].error, /assignment filter this policy uses does not exist/);
  assert.deepEqual(graph.bodies, []);

  graph.objects.set(`/deviceManagement/assignmentFilters/${FILTER}`, { id: FILTER, displayName: 'Corporate devices' });
  const present = await run(graph, [resource]);
  assert.deepEqual(present.failed, []);
  const target = graph.bodies.at(-1).body.assignments[0].target;
  assert.equal(target.deviceAndAppManagementAssignmentFilterId, FILTER);
  assert.equal(target.deviceAndAppManagementAssignmentFilterType, 'include');
});

test('an assignment the target does not keep fails as unverified', async (t) => {
  immediateTimers(t);
  const graph = recordingGraph({ readOverride: (path, body) => (path.endsWith('/assignments') ? { value: [] } : body) });
  const resource = plannedCreate('deviceConfiguration', restrictions, {
    assignments: { outcome: 'complete', targets: [groupAssignment(SOURCE_FINANCE, 'group:finance')] },
  });
  const outcome = await run(graph, [resource]);
  assert.match(outcome.failed[0].error, /assignments did not read back as written/);
});

// ------------------------------------------------------------------ planning

test('planning: a policy whose only change is its assignments becomes an update; a matching one stays a no-op', () => {
  const base = {
    naturalKey: 'deviceConfiguration:Windows restrictions', resourceType: 'deviceConfiguration', verb: 'noop', payload: restrictions,
    live: { state: 'present', targetId: 'target-policy', payload: restrictions },
  };
  const desired = new Map([[`${base.naturalKey}|assignment`, { outcome: 'complete', targets: [groupAssignment(SOURCE_FINANCE, 'group:finance')] }]]);
  const resolve = (key) => TARGETS.get(key) ?? null;
  const liveOf = (targetId) => new Map([[`${base.naturalKey}|assignment`, {
    outcome: 'complete',
    targets: [{ edgeKey: `groupAssignmentTarget|${targetId}`, targetId, attributes: { targetType: 'groupAssignmentTarget', filterId: null, filterType: 'none' } }],
  }]]);
  const recoveryFor = (resource) => selectRecoveryMechanism(resource);

  const [drifted] = attachIntuneAssignments([base], { desired, live: liveOf(TARGET_KIOSKS), resolve, recoveryFor });
  assert.equal(drifted.verb, 'update');
  assert.match(drifted.verbReason, /assignments differ/);
  assert.equal(drifted.recovery.mechanism, 'update-existing');
  assert.equal(drifted.assignments.targets.length, 1);

  const [same] = attachIntuneAssignments([base], { desired, live: liveOf(TARGET_FINANCE), resolve, recoveryFor });
  assert.equal(same.verb, 'noop');
  assert.ok(same.assignments, 'the desired assignments still travel with the policy');

  const [missing] = attachIntuneAssignments([base], { desired, live: liveOf(TARGET_FINANCE), resolve: () => null, recoveryFor });
  assert.equal(missing.verb, 'update', 'a missing group is surfaced as a refusal in the dry run, not hidden as a no-op');
  assert.equal(assignmentPlan(missing, () => null).state, 'refused');
});

// ------------------------------------------------- review fixes (issue #155)

test('mutation: a compliance update from a backup taken before actions were backed up leaves the live actions alone', async () => {
  const graph = recordingGraph();
  const { scheduledActionsForRule: _dropped, ...oldBackup } = compliance;
  const live = { ...compliance, passwordMinimumLength: 4 };
  const outcome = await run(graph, [plannedUpdate(graph, 'deviceCompliancePolicy', oldBackup, live)]);
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(graph.bodies.map((body) => body.method), ['PATCH'], 'only the changed setting is written');
  assert.ok(graph.bodies.every((body) => !body.path.endsWith('/scheduleActionsForRules')), 'the actions are never sent');
  assert.ok(!Object.hasOwn(graph.bodies[0].body, 'scheduledActionsForRule'));
  assert.match(outcome.applied[0].changes.scheduledActions, /left as they are/);
  assert.equal(graph.objects.get('/deviceManagement/deviceCompliancePolicies/target-policy').scheduledActionsForRule.length, 1,
    'the live actions are still there');

  const dryGraph = recordingGraph();
  const dry = await run(dryGraph, [plannedUpdate(dryGraph, 'deviceCompliancePolicy', oldBackup, live)], { mode: 'dry-run' });
  assert.match(dry.applied[0].changes.scheduledActions, /left as they are/, 'the plan says so');
});

test('mutation: a compliance backup listing no actions is refused for create and update, never sent as an empty list', async () => {
  const emptyActions = { ...compliance, scheduledActionsForRule: [] };
  const createGraph = recordingGraph();
  const created = await run(createGraph, [plannedCreate('deviceCompliancePolicy', emptyActions)]);
  assert.match(created.failed[0].error, /lists no actions for noncompliance/);
  assert.deepEqual(createGraph.bodies, []);

  const graph = recordingGraph();
  const updated = await run(graph, [plannedUpdate(graph, 'deviceCompliancePolicy', emptyActions, { ...compliance, passwordMinimumLength: 4 })]);
  assert.match(updated.failed[0].error, /lists no actions for noncompliance/);
  assert.deepEqual(graph.bodies, []);
});

test('mutation: a settings catalog backup holding fewer settings than the policy has is refused, never PUT', async () => {
  const second = { id: '1', settingInstance: { ...catalogPolicy.settings[0].settingInstance, settingDefinitionId: 'device_vendor_msft_policy_config_defender_allowcloudprotection' } };
  const live = { ...catalogPolicy, settingCount: 3, settings: [catalogPolicy.settings[0], second, { ...second, id: '2' }] };
  const { settingCount: _count, ...uncounted } = catalogPolicy;
  for (const [label, backup, pattern] of [
    ['count 3, one setting', { ...catalogPolicy, settingCount: 3 }, /holds 1 of this settings catalog policy's 3 settings/],
    ['count 3, no settings', { ...catalogPolicy, settingCount: 3, settings: [] }, /holds 0 of this settings catalog policy's 3 settings/],
    ['no count, no settings', { ...uncounted, settings: [] }, /holds no settings/],
  ]) {
    const graph = recordingGraph();
    const updated = await run(graph, [plannedUpdate(graph, 'configurationPolicy', backup, live)]);
    assert.match(updated.failed[0]?.error ?? '', pattern, label);
    assert.deepEqual(graph.bodies, [], `${label}: nothing is written`);
    const createGraph = recordingGraph();
    const created = await run(createGraph, [plannedCreate('configurationPolicy', backup)]);
    assert.match(created.failed[0]?.error ?? '', pattern, `${label} (create)`);
    assert.deepEqual(createGraph.bodies, []);
  }
  const emptyByDesign = await run(recordingGraph(), [plannedCreate('configurationPolicy', { ...catalogPolicy, settingCount: 0, settings: [] })], { mode: 'dry-run' });
  assert.deepEqual(emptyByDesign.failed, [], 'a policy that really has no settings is still restorable');
});

test('the plan says plainly when a restore removes every current assignment', async () => {
  const graph = recordingGraph();
  const resource = plannedUpdate(graph, 'deviceConfiguration', restrictions, { ...restrictions, cameraBlocked: false }, {
    assignments: { outcome: 'complete-empty', targets: [] }, liveAssignmentCount: 2,
  });
  const dry = await run(graph, [resource], { mode: 'dry-run' });
  assert.equal(dry.applied[0].changes.assignments, 'removes all 2 assignments the policy has now, because the backup has none');
  assert.deepEqual(graph.bodies, []);

  const base = {
    naturalKey: 'deviceConfiguration:Windows restrictions', resourceType: 'deviceConfiguration', verb: 'noop', payload: restrictions,
    live: { state: 'present', targetId: 'target-policy', payload: restrictions },
  };
  const liveEdge = (targetId) => ({ edgeKey: `groupAssignmentTarget|${targetId}`, targetId, attributes: { targetType: 'groupAssignmentTarget', filterId: null, filterType: 'none' } });
  const [promoted] = attachIntuneAssignments([base], {
    desired: new Map([[`${base.naturalKey}|assignment`, { outcome: 'complete-empty', targets: [] }]]),
    live: new Map([[`${base.naturalKey}|assignment`, { outcome: 'complete', targets: [liveEdge(TARGET_FINANCE), liveEdge(TARGET_KIOSKS)] }]]),
    resolve: (key) => TARGETS.get(key) ?? null,
  });
  assert.equal(promoted.verb, 'update');
  assert.match(promoted.verbReason, /removes all 2 assignments the policy has now/);
  assert.equal(promoted.liveAssignmentCount, 2);
});

test('a policy outside a selection restore says its assignments were not checked; one the backup never read says so', () => {
  const resource = plannedCreate('deviceConfiguration', restrictions);
  assert.match(assignmentPlan(resource, () => null).reason, /restored only when policies are picked for a restore; they were not checked/);
  const [attached] = attachIntuneAssignments([resource], { desired: new Map() });
  assert.equal(attached.assignments.outcome, 'absent');
  assert.match(assignmentPlan(attached, () => null).reason, /the backup holds no assignment read/);
});

test('a missing assignment filter is refused in a dry run as in enforce; a preview without a writer still plans', async () => {
  const resource = plannedCreate('deviceConfiguration', restrictions, {
    assignments: { outcome: 'complete', targets: [groupAssignment(SOURCE_FINANCE, 'group:finance', { filter: FILTER })] },
  });
  const graph = recordingGraph();
  const dry = await run(graph, [resource], { mode: 'dry-run' });
  assert.match(dry.failed[0]?.error ?? '', /assignment filter this policy uses does not exist/);
  assert.deepEqual(graph.bodies, []);
  const preview = await applyWave(null, null, [resource], { targetTenant: 'fixture', mode: 'dry-run', existingTargetIds: new Map(TARGETS) });
  assert.deepEqual(preview.failed, []);
});

test('live assignments spread over several pages are read in full before deciding', async () => {
  const graph = recordingGraph();
  const resource = plannedUpdate(graph, 'deviceConfiguration', restrictions, restrictions, {
    assignments: { outcome: 'complete', targets: [groupAssignment(SOURCE_FINANCE, 'group:finance'), groupAssignment(SOURCE_KIOSKS, 'group:kiosks')] },
  });
  const nextPage = 'https://graph.microsoft.com/v1.0/deviceManagement/deviceConfigurations/target-policy/assignments?$skiptoken=2';
  graph.objects.set('/deviceManagement/deviceConfigurations/target-policy/assignments', {
    value: [{ id: 'a', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: TARGET_FINANCE } }],
    '@odata.nextLink': nextPage,
  });
  graph.objects.set(nextPage.split('?')[0], {
    value: [{ id: 'b', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: TARGET_KIOSKS } }],
  });
  const outcome = await run(graph, [resource]);
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(graph.bodies, [], 'both pages match the backup, so nothing is reassigned');
  assert.ok(graph.reads.some((read) => read.path === nextPage), 'the second page was read');
});

test('a group matched only through its history is not assigned without a review', () => {
  const resource = plannedCreate('deviceConfiguration', restrictions, {
    assignments: { outcome: 'complete', targets: [groupAssignment(SOURCE_FINANCE, 'group:finance')] },
  });
  const plan = assignmentPlan(resource, () => ({ stale: true }));
  assert.equal(plan.state, 'refused');
  assert.match(plan.reason, /group:finance was matched only through its history/);
});

test('collection logs how many assignment reads failed, with counts only', () => {
  assert.equal(describeAssignmentReads(null), null);
  assert.equal(describeAssignmentReads({ complete: 3, 'complete-empty': 1, unsupported: 2 }),
    'policy assignment reads: 4 complete, 0 partial, 0 failed, 2 not supported');
  const line = describeAssignmentReads({ complete: 1, failed: 5 });
  assert.match(line, /5 failed/);
  assert.match(line, /missing Intune read permission/);
});
