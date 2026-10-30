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
