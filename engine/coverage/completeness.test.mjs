import { strict as assert } from 'node:assert';
import test from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { COMPLETENESS, COVERAGE_STATES, MISSING_REASONS, assessBackup, assessObject, completenessFor } from './completeness.mjs';
import { renderCoverageDoc } from './coverageDoc.mjs';
import { TYPE_DECISIONS, buildOperationLedger, qualificationFor } from './qualification.mjs';

const decisionFor = (type) => TYPE_DECISIONS[type];

// The 14 Entra types that were 'not yet investigated' before coverage plan v3.
const FORMERLY_UNCLASSIFIED = [
  'oauth2PermissionGrant', 'certificateBasedAuthConfiguration', 'roleAssignmentSchedule', 'authenticationContextClassReference',
  'permissionGrantPolicy', 'activityBasedTimeoutPolicy', 'claimsMappingPolicy', 'homeRealmDiscoveryPolicy', 'tokenIssuancePolicy',
  'tokenLifetimePolicy', 'featureRolloutPolicy', 'accessReviewScheduleDefinition', 'accessPackage', 'connectedOrganization',
];

test('no type is left unknown: every catalogue type has one of the four coverage states', () => {
  const ledger = buildOperationLedger();
  assert.equal(ledger.types.length, CATALOG.length);
  for (const row of ledger.types) {
    assert.ok(['automated', 'manual'].includes(row.decision), `${row.resourceType}: ${row.decision}`);
    assert.ok(COVERAGE_STATES.includes(row.completeness.state), `${row.resourceType}: ${row.completeness.state}`);
    for (const item of row.completeness.missing) assert.ok(MISSING_REASONS.includes(item.reason), `${row.resourceType}: ${item.reason}`);
    // Full means KEEL restores it itself with nothing missing; nothing else is full.
    assert.equal(row.completeness.state === 'full', row.decision === 'automated' && row.completeness.missing.length === 0, row.resourceType);
  }
  assert.deepEqual(Object.keys(COMPLETENESS).sort(), CATALOG.map((entry) => entry.type).sort());
});

// Wave 2 ENTRA registered writers for six of them (directoryPolicyOperations.mjs).
const ENTRA_WRITERS = new Set(['oauth2PermissionGrant', 'permissionGrantPolicy', 'claimsMappingPolicy', 'homeRealmDiscoveryPolicy', 'tokenIssuancePolicy', 'tokenLifetimePolicy']);

test('the 14 formerly unclassified Entra types are incomplete configurations, recreated by hand until a writer exists', () => {
  for (const type of FORMERLY_UNCLASSIFIED) {
    if (ENTRA_WRITERS.has(type)) {
      const qualification = qualificationFor(type);
      assert.equal(qualification.decision, 'automated', type);
      assert.equal(qualification.completeness.recreate, 'keel', type);
      assert.ok(!qualification.completeness.missing.some((item) => item.part === 'The whole setting'), type);
      continue;
    }
    const qualification = qualificationFor(type);
    assert.equal(qualification.decision, 'manual', type);
    assert.match(qualification.reason, /^incomplete configuration/, type);
    assert.equal(qualification.completeness.state, 'incomplete', type);
    assert.equal(qualification.completeness.recreate, 'by-hand', type);
    assert.equal(qualification.completeness.missing[0].part, 'The whole setting', type);
  }
});

test('a backed-up app with a secret is flagged incomplete and lists the secret name and expiry', () => {
  const app = {
    id: '00000000-0000-0000-0000-00000000a001',
    displayName: 'KEEL-RT-app-with-secret',
    passwordCredentials: [{ keyId: 'k1', displayName: 'KEEL-RT-secret', hint: 'abc', endDateTime: '2027-04-01T00:00:00Z', secretText: null }],
    keyCredentials: [],
  };
  const assessed = assessObject('application', app, decisionFor('application'));
  assert.equal(assessed.incomplete, true);
  assert.equal(assessed.state, 'incomplete');
  assert.deepEqual(assessed.missing, [{
    part: 'Client secrets', reason: 'secret', why: 'Microsoft never returns it',
    items: [{ name: 'KEEL-RT-secret', expires: '2027-04-01T00:00:00Z' }],
  }]);

  const plain = assessObject('application', { displayName: 'KEEL-RT-app-plain', passwordCredentials: [], keyCredentials: [] }, decisionFor('application'));
  assert.equal(plain.incomplete, false, 'an app with no secret or certificate is not missing one');
});

test('a backup is incomplete when any object is, and lists each incomplete object', () => {
  const resources = [
    { resourceType: 'application', naturalKey: 'application:KEEL-RT-a', payload: { displayName: 'KEEL-RT-a', passwordCredentials: [{ displayName: 'KEEL-RT-s', endDateTime: null }] } },
    { resourceType: 'application', naturalKey: 'application:KEEL-RT-b', payload: { displayName: 'KEEL-RT-b' } },
    { resourceType: 'namedLocation', naturalKey: 'namedLocation:KEEL-RT-loc', payload: { displayName: 'KEEL-RT-loc' } },
    { resourceType: 'directoryRole', naturalKey: 'directoryRole:x', payload: { displayName: 'Global Reader' } },
    { resourceType: 'activityBasedTimeoutPolicy', naturalKey: 'activityBasedTimeoutPolicy:KEEL-RT-idle', payload: { displayName: 'KEEL-RT-idle', definition: ['{}'] } },
  ];
  const backup = assessBackup(resources, decisionFor);
  assert.equal(backup.incomplete, true);
  assert.deepEqual(backup.objects.map((object) => object.naturalKey), ['application:KEEL-RT-a', 'activityBasedTimeoutPolicy:KEEL-RT-idle']);
  assert.deepEqual(backup.objects[1].missing.map((item) => [item.part, item.reason]), [
    ['The whole setting', 'not-written'], ['Which apps the policy is assigned to', 'other-route'],
  ]);

  const complete = assessBackup(resources.slice(1, 4), decisionFor);
  assert.deepEqual({ incomplete: complete.incomplete, objects: complete.objects.length }, { incomplete: false, objects: 0 });
});

test('per-object parts apply only when the object has them', () => {
  const wifi = assessObject('deviceConfiguration', { displayName: 'KEEL-RT-wifi', '@odata.type': '#microsoft.graph.windowsWifiConfiguration' }, decisionFor('deviceConfiguration'));
  assert.deepEqual(wifi.missing.map((item) => item.items), [[{ name: 'KEEL-RT-wifi', expires: null }]]);
  assert.equal(assessObject('deviceConfiguration', { displayName: 'KEEL-RT-restrictions', '@odata.type': '#microsoft.graph.windows10GeneralConfiguration' }, decisionFor('deviceConfiguration')).incomplete, false);

  const policy = {
    name: 'KEEL-RT-settings',
    settings: [{ settingInstance: { settingDefinitionId: 'outer', simpleSettingValue: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationSecretSettingValue', settingDefinitionId: 'device_vendor_msft_secret', value: null } } }],
  };
  assert.deepEqual(assessObject('configurationPolicy', policy, decisionFor('configurationPolicy')).missing[0].items, [{ name: 'device_vendor_msft_secret', expires: null }]);

  const syncedUser = assessObject('user', { displayName: 'KEEL-RT-user', onPremisesSyncEnabled: true }, decisionFor('user'));
  assert.ok(syncedUser.missing.some((item) => item.reason === 'read-only'));
  const cloudUser = assessObject('user', { displayName: 'KEEL-RT-user' }, decisionFor('user'));
  assert.deepEqual(cloudUser.missing.map((item) => item.reason), ['secret', 'secret']);
});

test('a record cannot claim more than the decision behind it', () => {
  assert.throws(() => completenessFor('group', decisionFor('group'), { records: { group: { managed: true } } }), /Microsoft-managed but has a registered writer/);
  assert.throws(() => completenessFor('group', decisionFor('group'), { records: { group: { whole: 'not-written' } } }), /whole setting is not restored by hand/);
  assert.throws(() => completenessFor('group', decisionFor('group'), { records: { group: { missing: [{ part: 'x', reason: 'lost' }] } } }), /invalid reason lost/);
  assert.throws(() => completenessFor('group', decisionFor('group'), { records: { group: { fullyRestorable: true } } }), /unrecognised fields fullyRestorable/);
  assert.throws(() => completenessFor('group', decisionFor('group'), { records: {} }), /no completeness record/);
  assert.throws(() => completenessFor('group', { decision: 'unknown' }), /neither automated nor manual/);
  assert.equal(completenessFor('domain', decisionFor('domain'), { records: { domain: { unreadable: { why: 'needs Domain.Read.All' } } } }).state, 'not-readable');
});

test('the coverage doc shows the four states and nothing "not yet investigated"', () => {
  const doc = renderCoverageDoc();
  assert.ok(!/not yet investigated/i.test(doc));
  assert.match(doc, /\| Idle sign-out policy \| [^|]+ \| Incomplete \| By hand \(not built yet\) \|/);
  assert.match(doc, /\| Delegated app consents \| [^|]+ \| Full \|/);
  assert.match(doc, /\| Named locations \| [^|]+ \| Full \|/);
  assert.match(doc, /\| Built-in admin roles \| [^|]+ \| Microsoft-managed \| Nothing to restore \|/);
  assert.match(doc, /client secrets \(Microsoft never returns it\)/);
});
