import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeAll, isReferenceCandidate } from './canonicalize.mjs';
import { restoreCandidates } from '../restore/dryRunArtifact.mjs';

// Issue #704: an iOS app configuration setting value "1" was stored as a
// reference to scope tag 1, because the same backup held a scope tag whose
// id is "1". Setting values are what the admin typed, never object ids.
const collected = [
  ['roleScopeTag', [
    { id: '0', displayName: 'Default', isBuiltIn: true },
    { id: '1', displayName: 'KEEL-RT-Paris', isBuiltIn: false },
  ]],
  ['mobileAppConfiguration', [{
    id: '33333333-3333-4333-8333-333333333333',
    displayName: 'KEEL-RT-704-config',
    description: '1',
    roleScopeTagIds: ['1'],
    settings: [
      { appConfigKey: 'KEELRT', appConfigKeyType: 'stringType', appConfigKeyValue: '1' },
      { appConfigKey: '0', appConfigKeyType: 'integerType', appConfigKeyValue: '0' },
    ],
  }]],
  ['assignmentFilter', [{
    id: '55555555-5555-4555-8555-555555555555', displayName: 'KEEL-RT-704-filter', platform: 'iOS',
    rule: '(device.osVersion -eq "1")', roleScopeTags: ['1'], payloads: [],
  }]],
  ['policySet', [{
    id: '66666666-6666-4666-8666-666666666666', displayName: 'KEEL-RT-704-set', roleScopeTags: ['1'], guidedDeploymentTags: [],
  }]],
  ['configurationPolicy', [{
    id: '44444444-4444-4444-8444-444444444444', name: 'KEEL-RT-704-policy', roleScopeTagIds: ['0'],
    settings: [{ settingInstance: { simpleSettingValue: { value: '1' } } }],
  }]],
];

const byType = (resources, type) => resources.find((r) => r.resourceType === type);

test('an app configuration value equal to a scope tag id is not a reference', () => {
  const config = byType(canonicalizeAll(collected), 'mobileAppConfiguration');
  const fields = config.references.map((r) => r.field);
  assert.ok(!fields.some((f) => f.startsWith('settings')), `setting fields: ${fields.join(', ')}`);
  assert.ok(!fields.includes('description'));
  assert.equal(config.payload.settings[0].appConfigKeyValue, '1', 'the value is kept as typed');
});

test('a settings catalog value equal to a scope tag id is not a reference', () => {
  const policy = byType(canonicalizeAll(collected), 'configurationPolicy');
  assert.ok(!policy.references.some((r) => r.field.startsWith('settings')));
});

test('roleScopeTagIds still reference the scope tags', () => {
  const resources = canonicalizeAll(collected);
  const tagKey = resources.find((r) => r.resourceType === 'roleScopeTag' && r.sourceId === '1').naturalKey;
  const config = byType(resources, 'mobileAppConfiguration');
  const ref = config.references.find((r) => r.field === 'roleScopeTagIds[0]');
  assert.ok(ref, 'roleScopeTagIds[0] is a reference');
  assert.equal(ref.symbol, tagKey);
});

test('roleScopeTags on assignment filters and policy sets still reference the scope tag', () => {
  const resources = canonicalizeAll(collected);
  const tagKey = resources.find((r) => r.resourceType === 'roleScopeTag' && r.sourceId === '1').naturalKey;
  for (const type of ['assignmentFilter', 'policySet']) {
    const ref = byType(resources, type).references.find((r) => r.field === 'roleScopeTags[0]');
    assert.ok(ref, `${type} roleScopeTags[0] is a reference`);
    assert.equal(ref.symbol, tagKey);
  }
});

// Snapshots stored before the collector rule (Q229's S 76a393be) still hold the
// bad reference. The restore drops it, so the dry run neither fails on it nor
// rewrites the value; the scope tag reference on roleScopeTagIds stays.
test('a stored reference on an app configuration value is dropped at restore', () => {
  const payload = {
    displayName: 'KEEL-RT-704-config',
    roleScopeTagIds: ['1'],
    settings: [{ appConfigKey: 'KEELRT', appConfigKeyType: 'stringType', appConfigKeyValue: '1' }],
  };
  const versions = [{ id: 7, natural_key: 'mobileAppConfiguration:KEEL-RT-704-config', resource_type: 'mobileAppConfiguration', payload }];
  const references = [
    { from_version: 7, field_path: 'settings[0].appConfigKeyValue', to_symbol: 'roleScopeTag:1', required: true, prefix: null },
    { from_version: 7, field_path: 'roleScopeTagIds[0]', to_symbol: 'roleScopeTag:1', required: true, prefix: null },
  ];
  const [config] = restoreCandidates(versions, references);
  assert.deepEqual(config.references.map((r) => r.field), ['roleScopeTagIds[0]']);
});

test('isReferenceCandidate matches the collector rule', () => {
  assert.equal(isReferenceCandidate('settings[0].appConfigKeyValue', '1'), false);
  assert.equal(isReferenceCandidate('description', '33333333-3333-4333-8333-333333333333'), false);
  assert.equal(isReferenceCandidate('settings[0].settingInstance.simpleSettingValue.value', '1'), false);
  assert.equal(isReferenceCandidate('roleScopeTagIds[0]', '1'), true);
  assert.equal(isReferenceCandidate('roleScopeTags[0]', '1'), true);
  assert.equal(isReferenceCandidate('settings[0].value', '33333333-3333-4333-8333-333333333333'), true);
});
