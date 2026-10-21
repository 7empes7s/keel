import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ASSIGNMENT_PARENT_TYPES, collectRelationships, projectAssignment } from './relationships.mjs';
import { COMPLETENESS } from '../coverage/completeness.mjs';
import { catalogEntryFor } from '../../tools/tenant-probe/catalog.mjs';

// Independent expectations: the documented Graph beta route of each policy's
// assignments, written out here rather than derived from the registry.
const POLICY = 'c0ffee00-0000-4000-8000-000000000001';
const EXPECTED = [
  ['deviceManagementScript', `/deviceManagement/deviceManagementScripts/${POLICY}/assignments`],
  ['deviceShellScript', `/deviceManagement/deviceShellScripts/${POLICY}/assignments`],
  ['deviceHealthScript', `/deviceManagement/deviceHealthScripts/${POLICY}/assignments`],
  ['deviceComplianceScript', `/deviceManagement/deviceComplianceScripts/${POLICY}/assignments`],
  ['windowsFeatureUpdateProfile', `/deviceManagement/windowsFeatureUpdateProfiles/${POLICY}/assignments`],
  ['windowsQualityUpdateProfile', `/deviceManagement/windowsQualityUpdateProfiles/${POLICY}/assignments`],
  ['windowsDriverUpdateProfile', `/deviceManagement/windowsDriverUpdateProfiles/${POLICY}/assignments`],
  ['groupPolicyConfiguration', `/deviceManagement/groupPolicyConfigurations/${POLICY}/assignments`],
  ['intuneBrandingProfile', `/deviceManagement/intuneBrandingProfiles/${POLICY}/assignments`],
];

const GROUP = 'aaaaaaaa-0000-4000-8000-00000000000a';
const groupTarget = { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: GROUP };

test('each newly covered Intune type has its assignments read at the documented beta route, GET only', async () => {
  const calls = [];
  const reader = {
    async collect(version, path, options) {
      calls.push({ version, path, options });
      return { items: [{ id: 'a-1', target: groupTarget }], pages: 1, status: 200, capped: false, error: null };
    },
  };
  for (const [type] of EXPECTED) {
    assert.ok(catalogEntryFor(type), `${type} is a backed-up type`);
    assert.ok(ASSIGNMENT_PARENT_TYPES.includes(type), `${type} has a registered assignments route`);
  }
  const observations = await collectRelationships(reader, {
    tenantRef: 'sha256:t', families: ['assignment'],
    parents: EXPECTED.map(([type]) => ({ type, sourceId: POLICY, naturalKey: `${type}:KEEL-RT-${type}` })),
  });
  assert.deepEqual(calls.map((call) => [call.version, call.path]), EXPECTED.map(([, path]) => ['beta', path]));
  for (const [type, path] of EXPECTED) {
    const observation = observations.find((obs) => obs.parentType === type);
    assert.equal(observation.outcome, 'complete', type);
    assert.equal(observation.endpoint, path, type);
    assert.deepEqual(observation.targets.map((edge) => edge.targetId), [GROUP], `${type}: the group it is assigned to`);
  }
});

test('a denied assignment read is failed, never an empty set', async () => {
  const reader = {
    async collect() {
      return { items: undefined, pages: 0, status: 403, capped: false, error: { status: 403, code: 'Forbidden', error: 'denied' } };
    },
  };
  const [observation] = await collectRelationships(reader, {
    tenantRef: 'sha256:t', families: ['assignment'], parents: [{ type: 'deviceHealthScript', sourceId: POLICY }],
  });
  assert.equal(observation.outcome, 'failed');
  assert.equal(observation.itemCount, null);
});

test('a remediation assignment keeps its run schedule and whether the fix runs', () => {
  const runSchedule = { '@odata.type': '#microsoft.graph.deviceHealthScriptDailySchedule', interval: 1, time: '09:00:00.0000000', useUtc: false };
  const edge = projectAssignment({ id: 'a-1', target: groupTarget, runRemediationScript: true, runSchedule });
  assert.deepEqual(edge.attributes.runSchedule, runSchedule);
  assert.equal(edge.attributes.runRemediationScript, true);
  // A policy assignment without them keeps exactly the attributes it had before.
  const plain = projectAssignment({ id: 'a-2', target: groupTarget, intent: 'required' });
  assert.deepEqual(Object.keys(plain.attributes).sort(), ['filterId', 'filterType', 'intent', 'mode', 'settingsDigest', 'targetType']);
});

test('coverage no longer says these assignments are missing from the backup', () => {
  for (const [type] of EXPECTED) {
    assert.ok(COMPLETENESS[type], `${type} has a completeness record`);
    for (const { part, reason } of COMPLETENESS[type].missing ?? []) {
      if (/assigned/i.test(part)) assert.notEqual(reason, 'other-route', `${type}: assignments are in the backup`);
    }
  }
});
