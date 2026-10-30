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

import { IDENTITY_RECORDS } from './identityObjectOperations.mjs';
import { INTUNE_EXTENDED_RECORDS, INTUNE_RECORDS, applyIntuneExtendedWrite, intuneTrustFieldStep, intuneWriteBody } from './intuneOperations.mjs';
import { applyRecordWrite, changedRecordFields, defineRecord, recordTrustFieldStep, recordWriteBody, trustFieldStep } from './recordWriter.mjs';
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
