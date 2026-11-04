/**
 * The trust-field rule (CLAUDE.md restore writers) for writers that send the
 * whole payload minus a few fields: a record with no `writable` list and the
 * built-in Intune policy body. defineRecord() only checks declared lists, so
 * these tests check the body itself: a trust, certificate or sign-in field is
 * never sent, and a difference in one becomes a step for a person. Everything
 * runs against the in-memory Graph (engine/test/idoFakeGraph.mjs); fixture
 * names use the KEEL-RT- prefix.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { applyWave } from './applyEngine.mjs';
import { planCompensation } from './compensation.mjs';
import { IDENTITY_RECORDS, applyIdentityObjectWrite } from './identityObjectOperations.mjs';
import { INTUNE_EXTENDED_RECORDS, INTUNE_RECORDS, applyIntuneExtendedWrite, changedIntuneFields, intuneTrustFieldStep, intuneWriteBody } from './intuneOperations.mjs';
import { applyRecordWrite, changedRecordFields, defineRecord, journalIntendedState, recordTrustFieldStep, recordWriteBody, trustFieldStep } from './recordWriter.mjs';
import { isTrustField } from './workloads/writeDeclarations.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';

const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };
// Field names the rule refuses by name: a trusted root, a signing certificate,
// an identity provider's issuer and sign-in endpoint, and cross-tenant trust.
const TRUST = Object.freeze({
  trustedRootCertificate: 'MIIBfakeRootCertificate', signingCertificate: 'MIIBfakeSigning',
  issuerUri: 'https://issuer.example.test', passiveSignInUri: 'https://signin.example.test/login', inboundTrust: { isMfaAccepted: true },
});

const resourceOf = (resourceType, payload, extra = {}) => ({
  naturalKey: `${resourceType}:${payload.displayName ?? payload.id}`, resourceType, payload, references: [], blastRadius: 'access-affecting', ...extra,
});

test('every fixture trust field is one the rule names', () => {
  for (const field of Object.keys(TRUST)) assert.equal(isTrustField('anyType', field), true, field);
});

test('no record that writes the whole payload sends a trust, certificate or sign-in field', () => {
  const records = [...Object.values(INTUNE_EXTENDED_RECORDS), ...Object.values(IDENTITY_RECORDS)]
    .filter((record) => record.writable === null && record.operations.some((verb) => verb !== 'delete'));
  assert.ok(records.length >= 30, `the whole-payload records are found (${records.length})`);
  for (const record of records) {
    for (const verb of record.operations.filter((operation) => operation !== 'delete')) {
      const payload = { displayName: 'KEEL-RT-Trust', description: 'Fixture', ...TRUST };
      let body;
      try {
        body = recordWriteBody(record, payload, verb);
      } catch {
        continue; // a transform that needs a fuller payload never gets this far in a write either
      }
      const sent = Object.keys(body ?? {}).filter((field) => isTrustField(record.resourceType, field));
      assert.deepEqual(sent, [], `${record.resourceType} ${verb}`);
    }
  }
});

test('a record transform cannot put a trust field back into the body', () => {
  const record = defineRecord({
    resourceType: 'keelFixtureType', version: 'v1.0', collection: '/fixture', operations: ['create'],
    transform: (body) => ({ ...body, signingCertificate: 'MIIBadded' }),
  });
  assert.deepEqual(recordWriteBody(record, { displayName: 'KEEL-RT-Added' }, 'create'), { displayName: 'KEEL-RT-Added' });
});

test('a trust field that differs is not a change to write, and is a step for a person', () => {
  const record = INTUNE_EXTENDED_RECORDS.deviceCategory;
  const live = { displayName: 'KEEL-RT-Cat', description: 'Live', trustedRootCertificate: 'MIIBlive' };
  const desired = { displayName: 'KEEL-RT-Cat', description: 'Backup', trustedRootCertificate: 'MIIBbackup' };
  assert.deepEqual(changedRecordFields(record, desired, live), ['description']);
  const step = trustFieldStep(record.resourceType, desired, live, 'update');
  assert.equal(step.kind, 'manual-setting');
  assert.equal(step.requirement, 'trustFields');
  assert.deepEqual(step.fields, ['trustedRootCertificate']);
  assert.match(step.description, /never writes trust, certificate or sign-in settings.*trustedRootCertificate/);
  assert.equal(trustFieldStep(record.resourceType, desired, { ...live, trustedRootCertificate: 'MIIBbackup' }, 'update'), null, 'the same value needs no step');
  assert.equal(trustFieldStep(record.resourceType, { displayName: 'x', signingCertificate: null }, null, 'create'), null, 'an empty value needs no step');
});

test('a whole-payload record update sends only the other fields and lists the trust fields for a person', async () => {
  const path = '/deviceManagement/deviceCategories/cat-1';
  const live = { id: 'cat-1', displayName: 'KEEL-RT-Cat', description: 'Live', ...TRUST, issuerUri: 'https://other.example.test' };
  const desired = { id: 'cat-src', displayName: 'KEEL-RT-Cat', description: 'Backup', ...TRUST };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceCategory', desired, { live: { state: 'present', targetId: 'cat-1', payload: live } }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const writes = graph.calls.filter((call) => call.method === 'PATCH');
  assert.deepEqual(writes.map((call) => call.body), [{ description: 'Backup' }]);
  assert.deepEqual(result.applied.completion.map((step) => [step.requirement, step.fields]), [['trustFields', ['issuerUri']]]);
});

test('an update whose only difference is a trust field writes nothing and lists it', async () => {
  const path = '/deviceManagement/deviceCategories/cat-2';
  const live = { id: 'cat-2', displayName: 'KEEL-RT-Cat2', description: 'Same', trustedRootCertificate: 'MIIBlive' };
  const desired = { id: 'cat-src', displayName: 'KEEL-RT-Cat2', description: 'Same', trustedRootCertificate: 'MIIBbackup' };
  for (const mode of ['dry-run', 'enforce']) {
    const graph = idoFakeGraph({ seed: { [path]: live } });
    const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceCategory', desired, { live: { state: 'present', targetId: 'cat-2', payload: live } }), 'update', { ...FAST, mode });
    assert.equal(result.failed, undefined, result.failed?.error);
    assert.equal(graph.calls.some((call) => call.method !== 'GET' && call.method !== undefined), false, `${mode}: nothing is written`);
    assert.deepEqual(result.applied.changes.fields, [], mode);
    assert.deepEqual(result.applied.completion[0].fields, ['trustedRootCertificate'], mode);
  }
});

test('a whole-payload record create leaves the trust fields out and lists them', async () => {
  const graph = idoFakeGraph();
  const desired = { id: 'cat-src', displayName: 'KEEL-RT-New', description: 'Backup', signingCertificate: 'MIIBbackup' };
  const result = await applyRecordWrite(graph, INTUNE_EXTENDED_RECORDS.deviceCategory, resourceOf('deviceCategory', desired), 'create', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.deepEqual(post.body, { displayName: 'KEEL-RT-New', description: 'Backup' });
  assert.deepEqual(result.applied.completion[0].fields, ['signingCertificate']);
});

test('the built-in Intune policy body never carries a trust, certificate or sign-in field', () => {
  for (const resourceType of Object.keys(INTUNE_RECORDS)) {
    const payload = { '@odata.type': '#microsoft.graph.windows10EndpointProtectionConfiguration', displayName: 'KEEL-RT-Policy', name: 'KEEL-RT-Policy', settings: [], ...TRUST };
    for (const verb of ['create', 'update']) {
      const body = intuneWriteBody(resourceType, payload, verb);
      assert.deepEqual(Object.keys(body).filter((field) => isTrustField(resourceType, field)), [], `${resourceType} ${verb}`);
      assert.equal(body.displayName, 'KEEL-RT-Policy', `${resourceType} ${verb}: the other fields are kept`);
    }
  }
  const step = intuneTrustFieldStep('deviceConfiguration', { firewallCertificateRevocationListCheckMethod: 'attempt' }, { firewallCertificateRevocationListCheckMethod: 'none' }, 'update');
  assert.deepEqual(step.fields, ['firewallCertificateRevocationListCheckMethod']);
});

test('a device\'s failed sign-in count and sign-in options page are settings, not sign-in endpoints', () => {
  for (const field of ['passcodeSignInFailureCountBeforeWipe', 'passwordSignInFailureCountBeforeFactoryReset', 'settingsBlockSignInOptionsPage']) {
    assert.equal(isTrustField('deviceConfiguration', field), false, field);
    assert.equal(intuneWriteBody('deviceConfiguration', { '@odata.type': '#microsoft.graph.iosGeneralDeviceConfiguration', [field]: 5 }, 'update')[field], 5, field);
  }
  for (const field of ['passiveSignInUri', 'signInUri', 'activeSignInUri']) assert.equal(isTrustField('anyType', field), true, field);
});

test('a create lists only trust fields the backup sets; off, zero and empty values need no step', () => {
  for (const value of [null, false, 0, '', [], {}]) {
    assert.equal(trustFieldStep('deviceConfiguration', { displayName: 'KEEL-RT-x', firewallCertificateRevocationListCheckMethod: value }, null, 'create'), null, JSON.stringify(value));
  }
  assert.deepEqual(trustFieldStep('deviceConfiguration', { certificatesBlockManualRootCertificateInstallation: true }, null, 'create').fields,
    ['certificatesBlockManualRootCertificateInstallation']);
});

test('a record with its own writable list gets no second trust step: it sends nothing else and lists its own', () => {
  for (const record of [...Object.values(INTUNE_EXTENDED_RECORDS), ...Object.values(IDENTITY_RECORDS)].filter((entry) => entry.writable)) {
    assert.equal(recordTrustFieldStep(record, { issuerUri: 'https://a.example.test' }, { issuerUri: 'https://b.example.test' }, 'update'), null, record.resourceType);
  }
});

test('a create that finds the same object already there still lists a trust field that differs', async () => {
  const path = '/deviceManagement/deviceCategories/cat-3';
  const live = { id: 'cat-3', displayName: 'KEEL-RT-Exists', description: 'Same', trustedRootCertificate: 'MIIBlive' };
  const desired = { id: 'cat-src', displayName: 'KEEL-RT-Exists', description: 'Same', trustedRootCertificate: 'MIIBbackup' };
  const resource = resourceOf('deviceCategory', desired);
  for (const mode of ['dry-run', 'enforce']) {
    const graph = idoFakeGraph({ seed: { [path]: live } });
    const result = await applyRecordWrite(graph, INTUNE_EXTENDED_RECORDS.deviceCategory, resource, 'create', { ...FAST, mode, existingTargetIds: new Map([[resource.naturalKey, 'cat-3']]) });
    assert.equal(result.failed, undefined, result.failed?.error);
    assert.equal(graph.calls.some((call) => call.method === 'POST' || call.method === 'PATCH'), false, mode);
    assert.deepEqual(result.applied.completion?.[0]?.fields, ['trustedRootCertificate'], mode);
  }
});

// A trust field one or more levels down: inside a nested settings block and inside a list of objects.
const nestedTrust = () => ({
  vpnSettings: { connectionName: 'KEEL-RT-Vpn', signingCertificate: 'MIIBnested', servers: [{ address: 'vpn.example.test', trustedRootCertificate: 'MIIBroot' }] },
  identityProviders: [{ name: 'KEEL-RT-Idp', issuerUri: 'https://issuer.example.test', inboundTrust: { isMfaAccepted: true } }],
});
const trustKeysAt = (resourceType, value) => (Array.isArray(value) ? value.flatMap((item) => trustKeysAt(resourceType, item))
  : value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, child]) => [...(key !== '@odata.type' && isTrustField(resourceType, key) ? [key] : []), ...trustKeysAt(resourceType, child)])
    : []);

test('no whole-payload body sends a trust field nested inside an object or a list', () => {
  const records = [...Object.values(INTUNE_EXTENDED_RECORDS), ...Object.values(IDENTITY_RECORDS)]
    .filter((record) => record.writable === null && record.operations.some((verb) => verb !== 'delete'));
  for (const record of records) {
    for (const verb of record.operations.filter((operation) => operation !== 'delete')) {
      let body;
      try {
        body = recordWriteBody(record, { displayName: 'KEEL-RT-Nested', description: 'Fixture', ...nestedTrust() }, verb);
      } catch {
        continue; // a transform that needs a fuller payload never gets this far in a write either
      }
      assert.deepEqual(trustKeysAt(record.resourceType, body), [], `${record.resourceType} ${verb}`);
    }
  }
  for (const resourceType of Object.keys(INTUNE_RECORDS)) {
    for (const verb of ['create', 'update']) {
      const body = intuneWriteBody(resourceType, { '@odata.type': '#microsoft.graph.windows10VpnConfiguration', displayName: 'KEEL-RT-Nested', settings: [], ...nestedTrust() }, verb);
      assert.deepEqual(trustKeysAt(resourceType, body), [], `${resourceType} ${verb}`);
    }
  }
});

test('a create drops a nested trust field and keeps its neighbours; an update leaves the whole field out', () => {
  const payload = { '@odata.type': '#microsoft.graph.windows10VpnConfiguration', displayName: 'KEEL-RT-Vpn', ...nestedTrust() };
  const created = intuneWriteBody('deviceConfiguration', payload, 'create');
  assert.deepEqual(created.vpnSettings, { connectionName: 'KEEL-RT-Vpn', servers: [{ address: 'vpn.example.test' }] });
  assert.deepEqual(created.identityProviders, [{ name: 'KEEL-RT-Idp' }]);
  // Graph replaces a nested object or list whole: sent without its trust field, it would clear the live one.
  const updated = intuneWriteBody('deviceConfiguration', payload, 'update');
  assert.deepEqual(Object.keys(updated).filter((key) => key !== '@odata.type'), ['displayName']);
});

test('an update never clears a live nested trust field: the field holding it is left for a person', async () => {
  const path = '/deviceManagement/deviceCategories/cat-5';
  const live = { id: 'cat-5', displayName: 'KEEL-RT-Cat5', description: 'Live', extra: { label: 'old', signingCertificate: 'MIIBlive' } };
  const desired = { id: 'cat-src', displayName: 'KEEL-RT-Cat5', description: 'Backup', extra: { label: 'new', signingCertificate: 'MIIBlive' } };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceCategory', desired, { live: { state: 'present', targetId: 'cat-5', payload: live } }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(graph.calls.filter((call) => call.method === 'PATCH').map((call) => call.body), [{ description: 'Backup' }]);
  const step = result.applied.completion[0];
  assert.deepEqual(step.fields, ['extra'], 'the trust value is the same; the other values are what a person sets');
  assert.match(step.description, /extra holds a trust setting, so it was not restored/);
  // Neither the trust value nor its neighbours differ: nothing to do.
  assert.equal(trustFieldStep('deviceCategory', { extra: { label: 'x', issuerUri: 'a' } }, { extra: { label: 'x', issuerUri: 'a' } }, 'update'), null);
});

test('a body with no trust field anywhere is sent as it is, and values that mention a certificate are kept', () => {
  const settings = [{ settingInstance: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance', settingDefinitionId: 'device_vendor_msft_policy_config_trustedrootcertificate', simpleSettingValue: { value: 'certificate' } } }];
  const body = intuneWriteBody('configurationPolicy', { name: 'KEEL-RT-Catalog', settings }, 'update');
  assert.deepEqual(body.settings.map((setting) => setting.settingInstance), settings.map((setting) => setting.settingInstance));
});

test('a nested trust field is listed for a person by its path, only when it differs', () => {
  const desired = { displayName: 'KEEL-RT-Vpn', ...nestedTrust() };
  const created = trustFieldStep('deviceConfiguration', desired, null, 'create');
  assert.deepEqual(created.fields, ['vpnSettings.signingCertificate', 'vpnSettings.servers[0].trustedRootCertificate', 'identityProviders[0].issuerUri', 'identityProviders[0].inboundTrust']);
  assert.match(created.description, /vpnSettings\.servers\[0\]\.trustedRootCertificate/);
  assert.equal(trustFieldStep('deviceConfiguration', desired, nestedTrust(), 'update'), null, 'the same nested values need no step');
  const live = nestedTrust();
  live.vpnSettings.servers[0].trustedRootCertificate = 'MIIBlive';
  assert.deepEqual(trustFieldStep('deviceConfiguration', desired, live, 'update').fields, ['vpnSettings.servers[0].trustedRootCertificate']);
  assert.equal(trustFieldStep('deviceConfiguration', { vpnSettings: { signingCertificate: null, servers: [{ trustedRootCertificate: '' }] } }, null, 'create'), null, 'empty nested values need no step');
});

test('an update whose only difference is a nested trust field writes nothing and lists it', async () => {
  const path = '/deviceManagement/deviceCategories/cat-4';
  const live = { id: 'cat-4', displayName: 'KEEL-RT-Cat4', description: 'Same', extra: { label: 'KEEL-RT', signingCertificate: 'MIIBlive' } };
  const desired = { id: 'cat-src', displayName: 'KEEL-RT-Cat4', description: 'Same', extra: { label: 'KEEL-RT', signingCertificate: 'MIIBbackup' } };
  for (const mode of ['dry-run', 'enforce']) {
    const graph = idoFakeGraph({ seed: { [path]: live } });
    const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceCategory', desired, { live: { state: 'present', targetId: 'cat-4', payload: live } }), 'update', { ...FAST, mode });
    assert.equal(result.failed, undefined, result.failed?.error);
    assert.equal(graph.calls.some((call) => call.method !== 'GET' && call.method !== undefined), false, `${mode}: nothing is written`);
    assert.deepEqual(result.applied.completion[0].fields, ['extra.signingCertificate'], mode);
  }
});

test('a whole-payload record create sends a nested object without its trust field', async () => {
  const graph = idoFakeGraph();
  const desired = { id: 'cat-src', displayName: 'KEEL-RT-NewNested', extra: { label: 'KEEL-RT', issuerUri: 'https://issuer.example.test' } };
  const result = await applyRecordWrite(graph, INTUNE_EXTENDED_RECORDS.deviceCategory, resourceOf('deviceCategory', desired), 'create', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(graph.calls.find((call) => call.method === 'POST').body, { displayName: 'KEEL-RT-NewNested', extra: { label: 'KEEL-RT' } });
  assert.deepEqual(result.applied.completion[0].fields, ['extra.issuerUri']);
});

test('an update never clears a live nested trust field the backup does not hold', async () => {
  const path = '/deviceManagement/deviceCategories/cat-6';
  const live = { id: 'cat-6', displayName: 'KEEL-RT-Cat6', description: 'Live', extra: { label: 'old', signingCertificate: 'MIIBlive' } };
  const desired = { id: 'cat-src', displayName: 'KEEL-RT-Cat6', description: 'Backup', extra: { label: 'new' } };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceCategory', desired, { live: { state: 'present', targetId: 'cat-6', payload: live } }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(graph.calls.filter((call) => call.method === 'PATCH').map((call) => call.body), [{ description: 'Backup' }]);
  assert.deepEqual(result.applied.completion[0].fields, ['extra.signingCertificate', 'extra']);
  const before = { displayName: 'KEEL-RT-Vpn', vpnSettings: { connectionName: 'old', servers: [{ address: 'a', trustedRootCertificate: 'MIIBlive' }] } };
  const backup = { displayName: 'KEEL-RT-Vpn', vpnSettings: { connectionName: 'new', servers: [{ address: 'a' }] } };
  assert.deepEqual(changedIntuneFields('deviceConfiguration', backup, before), [], 'the built-in Intune writer leaves it out too');
  assert.deepEqual(intuneTrustFieldStep('deviceConfiguration', backup, before, 'update').fields, ['vpnSettings.servers[0].trustedRootCertificate', 'vpnSettings']);
});

// A lifecycle workflow custom extension: the Logic App it calls and how Entra signs in to it.
const EXTENSION = 'lifecycleWorkflowCustomTaskExtension';
const extensionPayload = (overrides = {}) => ({
  '@odata.type': '#microsoft.graph.identityGovernance.customTaskExtension', id: 'src-ext', displayName: 'KEEL-RT-Extension', description: 'Backup',
  endpointConfiguration: { '@odata.type': '#microsoft.graph.logicAppTriggerEndpointConfiguration', subscriptionId: 'sub-backup', resourceGroupName: 'rg', logicAppWorkflowName: 'KEEL-RT-App' },
  authenticationConfiguration: { '@odata.type': '#microsoft.graph.azureAdPopTokenAuthentication' },
  ...overrides,
});

test('a custom extension\'s Logic App and sign-in settings are trust fields', () => {
  for (const field of ['authenticationConfiguration', 'endpointConfiguration']) assert.equal(isTrustField(EXTENSION, field), true, field);
  assert.equal(isTrustField(EXTENSION, 'description'), false);
  assert.deepEqual(Object.keys(recordWriteBody(IDENTITY_RECORDS[EXTENSION], extensionPayload(), 'update')).sort(), ['@odata.type', 'description', 'displayName']);
});

test('a custom extension update sends only the other fields and lists the Logic App and sign-in for a person', async () => {
  const path = `${IDENTITY_RECORDS[EXTENSION].collection}/ext-1`;
  const live = extensionPayload({
    id: 'ext-1', description: 'Live',
    endpointConfiguration: { '@odata.type': '#microsoft.graph.logicAppTriggerEndpointConfiguration', subscriptionId: 'sub-live', resourceGroupName: 'rg', logicAppWorkflowName: 'KEEL-RT-App' },
    authenticationConfiguration: { '@odata.type': '#microsoft.graph.azureAdTokenAuthentication', resourceId: 'app-live' },
  });
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIdentityObjectWrite(graph, resourceOf(EXTENSION, extensionPayload(), { live: { state: 'present', targetId: 'ext-1', payload: live } }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const writes = graph.calls.filter((call) => call.method === 'PATCH');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, path);
  assert.deepEqual(Object.keys(writes[0].body).filter((field) => isTrustField(EXTENSION, field)), []);
  assert.equal(writes[0].body.description, 'Backup');
  assert.deepEqual(result.applied.completion.map((step) => [step.requirement, [...step.fields].sort()]),
    [['trustFields', ['authenticationConfiguration', 'endpointConfiguration']]]);
});

test('a custom extension whose only difference is its Logic App or sign-in writes nothing and lists it', async () => {
  const path = `${IDENTITY_RECORDS[EXTENSION].collection}/ext-2`;
  const live = extensionPayload({ id: 'ext-2', authenticationConfiguration: { '@odata.type': '#microsoft.graph.azureAdTokenAuthentication', resourceId: 'app-live' } });
  for (const mode of ['dry-run', 'enforce']) {
    const graph = idoFakeGraph({ seed: { [path]: live } });
    const result = await applyIdentityObjectWrite(graph, resourceOf(EXTENSION, extensionPayload(), { live: { state: 'present', targetId: 'ext-2', payload: live } }), 'update', { ...FAST, mode });
    assert.equal(result.failed, undefined, result.failed?.error);
    assert.equal(graph.calls.some((call) => call.method === 'PATCH' || call.method === 'POST'), false, `${mode}: nothing is written`);
    assert.deepEqual(result.applied.completion.map((step) => step.fields), [['authenticationConfiguration']], mode);
  }
});

test('a custom extension is never created: Graph needs the Logic App and sign-in a restore never writes', async () => {
  assert.deepEqual(IDENTITY_RECORDS[EXTENSION].operations, ['update']);
  const graph = idoFakeGraph();
  const result = await applyIdentityObjectWrite(graph, resourceOf(EXTENSION, extensionPayload()), 'create', FAST);
  assert.match(result.failed.error, /unsupported operation/);
  assert.equal(graph.calls.length, 0);
});

// Skipped writes: nothing is sent, and the trust step a write would have listed is
// listed on the skip too, after the skip's own steps.
const fixtureRecord = (extra) => defineRecord({
  resourceType: 'keelFixtureSetting', version: 'v1.0', collection: '/fixture/settings', operations: ['create', 'update'], ...extra,
});
const skipLive = { id: 'set-1', displayName: 'KEEL-RT-Setting', description: 'Live', issuerUri: 'https://live.example.test' };
const skipDesired = { id: 'set-src', displayName: 'KEEL-RT-Setting', description: 'Backup', issuerUri: 'https://backup.example.test' };
const skipResource = () => resourceOf('keelFixtureSetting', skipDesired, { live: { state: 'present', targetId: 'set-1', payload: skipLive } });
const sentNothing = (graph) => graph.calls.every((call) => call.method === 'GET' || call.method === undefined);
const trustSteps = (entry) => (entry.completion ?? []).filter((step) => step.requirement === 'trustFields').map((step) => step.fields);

test('a tenant-wide setting skipped by the test tenant guard still lists its trust fields', async () => {
  const record = fixtureRecord({ tenantWide: true });
  for (const mode of ['dry-run', 'enforce']) {
    const graph = idoFakeGraph({ seed: { '/fixture/settings/set-1': skipLive } });
    const result = await applyRecordWrite(graph, record, skipResource(), 'update', {
      ...FAST, mode, tenantRef: 'tenant-test', testTenantRefs: ['tenant-test'],
    });
    assert.ok(result.skipped, `${mode}: skipped`);
    assert.match(result.skipped.reason, /tenant-wide/);
    assert.equal(sentNothing(graph), true, `${mode}: nothing is written`);
    assert.deepEqual(trustSteps(result.skipped), [['issuerUri']], mode);
  }
});

test('a write a preflight skips still lists its trust fields', async () => {
  const record = fixtureRecord({ preflight: async () => ({ skipped: 'live already holds this setting' }) });
  for (const mode of ['dry-run', 'enforce']) {
    const graph = idoFakeGraph({ seed: { '/fixture/settings/set-1': skipLive } });
    const result = await applyRecordWrite(graph, record, skipResource(), 'update', { ...FAST, mode });
    assert.equal(result.skipped?.reason, 'live already holds this setting', mode);
    assert.equal(sentNothing(graph), true, `${mode}: nothing is written`);
    assert.deepEqual(trustSteps(result.skipped), [['issuerUri']], mode);
  }
});

test('an update its guard holds back keeps the guard\'s own step and adds the trust step after it', async () => {
  const own = { kind: 'manual-setting', requirement: 'fixtureGuard', description: 'Check the setting by hand.' };
  const record = fixtureRecord({ updateGuard: async () => ({ reason: 'manual: held by the guard', completion: [own] }) });
  for (const mode of ['dry-run', 'enforce']) {
    const graph = idoFakeGraph({ seed: { '/fixture/settings/set-1': skipLive } });
    const result = await applyRecordWrite(graph, record, skipResource(), 'update', { ...FAST, mode });
    assert.equal(result.skipped?.reason, 'manual: held by the guard', mode);
    assert.equal(sentNothing(graph), true, `${mode}: nothing is written`);
    assert.deepEqual(result.skipped.completion.map((step) => step.requirement), ['fixtureGuard', 'trustFields'], mode);
    assert.deepEqual(trustSteps(result.skipped), [['issuerUri']], mode);
  }
});

test('a write its route reports as not possible still lists its trust fields', async () => {
  const record = fixtureRecord({
    writeVia: async () => ({ ok: false, status: 409, skipped: 'the route cannot write this setting' }),
    readVia: async () => ({ ok: true, status: 200, body: skipLive }),
  });
  const graph = idoFakeGraph({ seed: { '/fixture/settings/set-1': skipLive } });
  const result = await applyRecordWrite(graph, record, skipResource(), 'update', FAST);
  assert.equal(result.skipped?.reason, 'the route cannot write this setting');
  assert.deepEqual(trustSteps(result.skipped), [['issuerUri']]);
});

test('a skip with no trust difference adds no trust step, and keeps the skip\'s own steps as they were', async () => {
  const own = { kind: 'manual-setting', requirement: 'fixtureGuard', description: 'Check the setting by hand.' };
  const sameTrust = { ...skipDesired, issuerUri: skipLive.issuerUri };
  const resource = resourceOf('keelFixtureSetting', sameTrust, { live: { state: 'present', targetId: 'set-1', payload: skipLive } });
  const graph = idoFakeGraph({ seed: { '/fixture/settings/set-1': skipLive } });
  const guarded = await applyRecordWrite(graph, fixtureRecord({ updateGuard: async () => ({ reason: 'manual: held', completion: [own] }) }), resource, 'update', FAST);
  assert.deepEqual(guarded.skipped.completion, [own]);
  const preflighted = await applyRecordWrite(graph, fixtureRecord({ preflight: async () => ({ skipped: 'already there' }) }), resource, 'update', FAST);
  assert.equal(preflighted.skipped.completion, undefined);
});

test('a record with its own writable list adds no trust step to a skip', async () => {
  const record = fixtureRecord({ writable: ['description'], preflight: async () => ({ skipped: 'already there' }) });
  const graph = idoFakeGraph({ seed: { '/fixture/settings/set-1': skipLive } });
  const result = await applyRecordWrite(graph, record, skipResource(), 'update', FAST);
  assert.equal(result.skipped?.reason, 'already there');
  assert.equal(result.skipped.completion, undefined);
});

// The rollback journal, kept in memory: the entries a restore with a restore reference records.
function memoryJournal() {
  const rows = [];
  return {
    rows,
    async query(sql, params) {
      if (sql.includes('INSERT INTO rollback_entry')) {
        const [, naturalKey, priorState, , resourceType, operation, , , intendedState] = params;
        rows.push({ naturalKey, resourceType, operation, priorState, intendedState: JSON.parse(intendedState ?? 'null') });
        return { rows: [{ id: rows.length }] };
      }
      return { rows: [] };
    },
  };
}

const intuneWave = (graph, journal, resources, existingTargetIds = new Map()) => applyWave(graph, { async acquire() {}, observeRetryAfter() {} }, resources, {
  targetTenant: 'fixture', mode: 'enforce', existingTargetIds, readAfterWriteOptions: { attempts: 1, delayMs: 0 },
  rollbackClient: journal, runId: 'run-1', restoreRef: 'restore-1',
});

test('the Intune policy journal never records a trust field value the write did not send', async () => {
  const kind = { '@odata.type': '#microsoft.graph.windows10EndpointProtectionConfiguration' };
  const desired = { ...kind, id: 'src-1', displayName: 'KEEL-RT-Journal', description: 'Backup', firewallCertificateRevocationListCheckMethod: 'attempt' };

  // Create: the journal's intent is the payload minus the trust field.
  let graph = idoFakeGraph();
  let journal = memoryJournal();
  let outcome = await intuneWave(graph, journal, [resourceOf('deviceConfiguration', desired, { verb: 'create' })]);
  assert.deepEqual(outcome.failed, []);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal('firewallCertificateRevocationListCheckMethod' in post.body, false);
  assert.equal(journal.rows.length, 1);
  assert.equal(journal.rows[0].operation, 'create');
  assert.equal('firewallCertificateRevocationListCheckMethod' in journal.rows[0].intendedState, false);
  assert.deepEqual(journal.rows[0].intendedState, { ...kind, id: 'src-1', displayName: 'KEEL-RT-Journal', description: 'Backup' });

  // Update: the trust field stays as live holds it, and the prior state is the whole live policy.
  const path = '/deviceManagement/deviceConfigurations/cfg-1';
  const live = { ...kind, id: 'cfg-1', displayName: 'KEEL-RT-Journal', description: 'Live', firewallCertificateRevocationListCheckMethod: 'none' };
  graph = idoFakeGraph({ seed: { [path]: live } });
  journal = memoryJournal();
  outcome = await intuneWave(graph, journal, [resourceOf('deviceConfiguration', desired, { verb: 'update', targetId: 'cfg-1', live: { state: 'present', targetId: 'cfg-1', payload: live } })]);
  assert.deepEqual(outcome.failed, []);
  const patch = graph.calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(Object.keys(patch.body).sort(), ['@odata.type', 'description']);
  assert.equal(journal.rows[0].operation, 'update');
  // Not sent, so the policy keeps its live value: that is what the journal intends.
  assert.equal(journal.rows[0].intendedState.firewallCertificateRevocationListCheckMethod, 'none');
  assert.equal(journal.rows[0].intendedState.description, 'Backup');
  assert.equal(journal.rows[0].priorState.firewallCertificateRevocationListCheckMethod, 'none');
});

test('an undo of that update reverts only what was written, never the trust field', async () => {
  const kind = { '@odata.type': '#microsoft.graph.windows10EndpointProtectionConfiguration' };
  const path = '/deviceManagement/deviceConfigurations/cfg-2';
  const live = { ...kind, id: 'cfg-2', displayName: 'KEEL-RT-Undo', description: 'Live', firewallCertificateRevocationListCheckMethod: 'none' };
  const desired = { ...kind, id: 'src-2', displayName: 'KEEL-RT-Undo', description: 'Backup', firewallCertificateRevocationListCheckMethod: 'attempt' };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const journal = memoryJournal();
  const outcome = await intuneWave(graph, journal, [resourceOf('deviceConfiguration', desired, { verb: 'update', targetId: 'cfg-2', live: { state: 'present', targetId: 'cfg-2', payload: live } })]);
  assert.deepEqual(outcome.failed, []);

  const [row] = journal.rows;
  const after = (await graph.read('beta', path)).body;
  const plan = planCompensation({
    restoreRef: 'restore-1',
    entries: [{ id: 'entry-1', ...row, targetId: 'cfg-2', blastRadius: 'access-affecting', outcome: 'succeeded', outcomeDetail: null, postState: null }],
    current: new Map([[row.naturalKey, { targetId: 'cfg-2', payload: after }]]),
  });
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.operations.map((op) => op.revertedFields), [['description']]);
});

test('the journal keeps a trust field live holds even when the backup has none, and changes no other field', () => {
  const kind = { '@odata.type': '#microsoft.graph.windows10EndpointProtectionConfiguration' };
  const live = { ...kind, description: 'Live', firewallCertificateRevocationListCheckMethod: 'none' };
  assert.deepEqual(journalIntendedState('deviceConfiguration', { ...kind, description: 'Backup' }, live),
    { ...kind, description: 'Backup', firewallCertificateRevocationListCheckMethod: 'none' });
  // A trust field only the backup holds is left out on an update too: live does not get it.
  assert.deepEqual(journalIntendedState('deviceConfiguration', { ...kind, description: 'Backup', firewallCertificateRevocationListCheckMethod: 'attempt' }, { ...kind, description: 'Live' }),
    { ...kind, description: 'Backup' });
  const plain = { ...kind, description: 'Backup' };
  assert.equal(journalIntendedState('deviceConfiguration', plain, { ...kind, description: 'Live' }), plain);
});

test('the journal follows the nested rule: a field holding a trust field is never claimed as written', () => {
  const kind = { '@odata.type': '#microsoft.graph.windows10VpnConfiguration' };
  const desired = { ...kind, description: 'Backup', vpnSettings: { connectionName: 'KEEL-RT-Backup', signingCertificate: 'MIIBbackup' } };
  // A create sends the field without its trust value, so that is what it intends.
  assert.deepEqual(journalIntendedState('deviceConfiguration', desired, null, { verb: 'create' }),
    { ...kind, description: 'Backup', vpnSettings: { connectionName: 'KEEL-RT-Backup' } });
  // An update leaves the whole field out, so it keeps live's value, trust value and all.
  const live = { ...kind, description: 'Live', vpnSettings: { connectionName: 'KEEL-RT-Live', signingCertificate: 'MIIBlive' } };
  assert.deepEqual(journalIntendedState('deviceConfiguration', desired, live), { ...kind, description: 'Backup', vpnSettings: live.vpnSettings });
  // A field only live's value holds a trust field in is left out too.
  const plainBackup = { ...kind, description: 'Backup', vpnSettings: { connectionName: 'KEEL-RT-Backup' } };
  assert.deepEqual(journalIntendedState('deviceConfiguration', plainBackup, live).vpnSettings, live.vpnSettings);
  // A writer that strips top-level fields only journals nested values as it sends them.
  assert.deepEqual(journalIntendedState('deviceConfiguration', desired, live, { nested: false }), desired);
  // A field the write does send (an approved compliance fix) is journaled as sent.
  assert.deepEqual(journalIntendedState('namedLocation', { displayName: 'KEEL-RT-Office', isTrusted: true }, { displayName: 'KEEL-RT-Office', isTrusted: false }, { keep: ['isTrusted'] }),
    { displayName: 'KEEL-RT-Office', isTrusted: true });
});

test('no trust value the write did not send reaches the record writer journal', async () => {
  const record = fixtureRecord({});
  const graph = idoFakeGraph({ seed: { '/fixture/settings/set-1': skipLive } });
  const journal = memoryJournal();
  const result = await applyRecordWrite(graph, record, skipResource(), 'update', { ...FAST, rollbackClient: journal, runId: 'run-1', restoreRef: 'restore-1' });
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(journal.rows.length, 1);
  assert.notEqual(journal.rows[0].intendedState.issuerUri, skipDesired.issuerUri);
  assert.deepEqual(trustSteps(result.applied), [['issuerUri']]);
});
