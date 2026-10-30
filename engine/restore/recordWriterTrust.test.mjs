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

import { IDENTITY_RECORDS, applyIdentityObjectWrite } from './identityObjectOperations.mjs';
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

test('a custom extension create is a step for a person, never a POST without its Logic App', async () => {
  for (const mode of ['dry-run', 'enforce']) {
    const graph = idoFakeGraph();
    const result = await applyIdentityObjectWrite(graph, resourceOf(EXTENSION, extensionPayload()), 'create', { ...FAST, mode });
    assert.equal(result.failed, undefined, `${mode}: ${result.failed?.error}`);
    assert.equal(graph.calls.length, 0, `${mode}: nothing is called`);
    assert.match(result.skipped.reason, /^manual: Recreate this custom extension by hand in Microsoft Entra admin center > Identity Governance > Lifecycle workflows > Custom extensions/);
    assert.deepEqual(result.skipped.completion.map((step) => [step.kind, step.requirement, step.fields]),
      [['manual-setting', 'trustFields', ['authenticationConfiguration', 'endpointConfiguration']]]);
  }
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

test('a custom extension create that matches one already in the target is not sent to be recreated by hand', async () => {
  const resource = resourceOf(EXTENSION, extensionPayload());
  const graph = idoFakeGraph();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', { ...FAST, mode: 'dry-run', existingTargetIds: new Map([[resource.naturalKey, 'ext-3']]) });
  assert.equal(result.skipped, undefined);
  assert.equal(result.applied.targetId, 'ext-3');
  assert.equal(graph.calls.some((call) => call.method === 'PATCH' || call.method === 'POST'), false);
});

test('a custom extension create with no Logic App in the backup still asks for a recreate by hand', async () => {
  const payload = extensionPayload();
  delete payload.endpointConfiguration;
  delete payload.authenticationConfiguration;
  const result = await applyIdentityObjectWrite(idoFakeGraph(), resourceOf(EXTENSION, payload), 'create', FAST);
  assert.equal(result.skipped.completion.length, 1);
  assert.equal('fields' in result.skipped.completion[0], false);
});
