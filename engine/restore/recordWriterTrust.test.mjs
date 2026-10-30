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
import { IDENTITY_RECORDS } from './identityObjectOperations.mjs';
import { INTUNE_EXTENDED_RECORDS, INTUNE_RECORDS, applyIntuneExtendedWrite, intuneJournalState, intuneTrustFieldStep, intuneWriteBody } from './intuneOperations.mjs';
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
  assert.deepEqual(intuneJournalState('deviceConfiguration', { ...kind, description: 'Backup' }, live),
    { ...kind, description: 'Backup', firewallCertificateRevocationListCheckMethod: 'none' });
  // A trust field only the backup holds is left out on an update too: live does not get it.
  assert.deepEqual(intuneJournalState('deviceConfiguration', { ...kind, description: 'Backup', firewallCertificateRevocationListCheckMethod: 'attempt' }, { ...kind, description: 'Live' }),
    { ...kind, description: 'Backup' });
  const plain = { ...kind, description: 'Backup' };
  assert.equal(intuneJournalState('deviceConfiguration', plain, { ...kind, description: 'Live' }), plain);
});
