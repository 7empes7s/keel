import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeAll } from './canonicalize.mjs';
import { dependencyClosure } from '../restore/selection.mjs';

// Live gate #148 (queue Q43): a restore that selected only a group pulled
// organizationalBrandingLocalization:0 into its closure, because the default
// localization's id is "0" and the group's payload carried the string "0".
const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const collected = [
  ['organizationalBrandingLocalization', [
    { id: '0', signInPageText: 'Welcome' },
    { id: 'fr-FR', signInPageText: 'Bienvenue' },
  ]],
  ['group', [{
    id: GROUP_ID, displayName: 'KEEL-RT-148-group', mailNickname: 'keel-rt-148',
    preferredLanguage: 'fr-FR', classification: '0', securityEnabled: true,
  }]],
  ['configurationPolicy', [{
    id: '22222222-2222-4222-8222-222222222222', name: 'KEEL-RT-148-policy',
    settings: [{ settingInstance: { simpleSettingValue: { value: '0' } } }, { value: 'fr-FR' }],
  }]],
];

test('a language-code localization id is never read as a reference from another payload', () => {
  const resources = canonicalizeAll(collected);
  const keys = resources.map((r) => r.naturalKey);
  assert.ok(keys.includes('organizationalBrandingLocalization:0'), 'the localizations keep their keys');
  assert.ok(keys.includes('organizationalBrandingLocalization:fr-FR'));
  for (const resource of resources) {
    for (const ref of resource.references ?? []) {
      assert.doesNotMatch(String(ref.symbol), /^organizationalBrandingLocalization:/, `${resource.naturalKey} at ${ref.field}`);
    }
  }
});

test('selecting only a group or a configuration policy leaves branding out of the closure', () => {
  const resources = canonicalizeAll(collected);
  for (const type of ['group', 'configurationPolicy']) {
    const selected = resources.find((r) => r.resourceType === type).naturalKey;
    const closure = dependencyClosure(resources, [selected]);
    assert.deepEqual(closure.keys, [selected]);
    assert.deepEqual(closure.added, []);
  }
});

test('GUID references between resources still resolve', () => {
  const resources = canonicalizeAll([
    ...collected,
    ['conditionalAccessPolicy', [{
      id: '33333333-3333-4333-8333-333333333333', displayName: 'KEEL-RT-ca', state: 'disabled',
      conditions: { users: { includeGroups: [GROUP_ID] } },
    }]],
  ]);
  const ca = resources.find((r) => r.resourceType === 'conditionalAccessPolicy');
  const closure = dependencyClosure(resources, [ca.naturalKey]);
  assert.deepEqual(closure.added.map((a) => a.resourceType), ['group']);
});
