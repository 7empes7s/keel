/**
 * The trust-field rule (CLAUDE.md restore writers) for writes that replace the
 * whole object with PUT: a settings catalog policy, a reusable settings group
 * and a settings catalog compliance policy. The body never carries a trust,
 * certificate or sign-in field, and a PUT clears every field it leaves out, so
 * when the backup or the live object holds one (at the top level, or nested in
 * a field the write sends) nothing is written and a person restores the object.
 * Everything runs against in-memory fakes; fixture names use the KEEL-RT- prefix.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';
import { applyWave } from './applyEngine.mjs';
import { INTUNE_RECORDS, applyIntuneExtendedWrite, intuneReplaceTrustRefusal } from './intuneOperations.mjs';
import { wholeReplaceTrustSettings } from './recordWriter.mjs';

const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };
const governor = { async acquire() {}, observeRetryAfter() {} };
const MODES = ['dry-run', 'enforce'];

const choice = (id, settingDefinitionId, value) => ({
  id,
  settingInstance: {
    '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance',
    settingDefinitionId, settingInstanceTemplateReference: null,
    choiceSettingValue: { value, settingValueTemplateReference: null, children: [] },
  },
});
const REALTIME = choice('0', 'device_vendor_msft_policy_config_defender_allowrealtimemonitoring', 'device_vendor_msft_policy_config_defender_allowrealtimemonitoring_1');
const TRUSTED_ROOT = choice('1', 'device_vendor_msft_rootcatrustedcertificates_root', 'device_vendor_msft_rootcatrustedcertificates_root_1');

const catalogPolicy = Object.freeze({
  id: 'source-catalog', name: 'KEEL-RT-Catalog', description: 'Backup', platforms: 'windows10', technologies: 'mdm',
  roleScopeTagIds: ['0'], settingCount: 1, creationSource: null, isAssigned: false, lastModifiedDateTime: '2026-09-01T00:00:00Z',
  templateReference: { templateId: '', templateFamily: 'none', templateDisplayName: null, templateDisplayVersion: null },
  settings: [REALTIME],
});

function catalogUpdate(graph, desired, live) {
  const targetId = 'target-policy';
  const payload = live ? { ...live, id: targetId } : null;
  if (payload) graph.objects.set(`${INTUNE_RECORDS.configurationPolicy.collection}/${targetId}`, payload);
  return {
    naturalKey: `configurationPolicy:${desired.name}`, resourceType: 'configurationPolicy', verb: 'update', payload: desired, references: [],
    blastRadius: 'access-affecting', targetId, ...(payload ? { live: { state: 'present', targetId, payload } } : {}),
  };
}

function writesOf(graph) {
  const writes = [];
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => {
    writes.push(`${request.method} ${path}`);
    return write(version, path, request);
  };
  return writes;
}

const run = (graph, wave, mode) => applyWave(graph, governor, wave, { targetTenant: 'fixture', mode, existingTargetIds: new Map() });

test('the trust settings a replace would touch: top-level by name, nested by key or setting definition', () => {
  const body = { name: 'x', settings: [] };
  assert.deepEqual(wholeReplaceTrustSettings('configurationPolicy', { payload: catalogPolicy, live: catalogPolicy, body }), []);
  assert.deepEqual(wholeReplaceTrustSettings('configurationPolicy', {
    payload: catalogPolicy, live: { ...catalogPolicy, trustedRootCertificate: 'MIIBlive' }, body,
  }), ['trustedRootCertificate'], 'a live field the PUT would clear');
  assert.deepEqual(wholeReplaceTrustSettings('configurationPolicy', {
    payload: { ...catalogPolicy, settings: [REALTIME, TRUSTED_ROOT] }, live: catalogPolicy, body,
  }), ['device_vendor_msft_rootcatrustedcertificates_root'], 'a nested setting whose definition names a trusted certificate');
  assert.deepEqual(wholeReplaceTrustSettings('configurationPolicy', {
    payload: { ...catalogPolicy, templateReference: { templateId: '', signingCertificate: 'MIIBnested' } }, live: catalogPolicy, body,
  }), ['signingCertificate'], 'a nested key');
  const vpnXml = '<EapHostConfig><TrustedRootCA>ab12</TrustedRootCA></EapHostConfig>';
  const vpn = {
    id: '2', settingInstance: {
      '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance', settingDefinitionId: 'device_vendor_msft_vpnv2_eap_configuration',
      simpleSettingValue: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationStringSettingValue', value: vpnXml },
    },
  };
  assert.deepEqual(wholeReplaceTrustSettings('configurationPolicy', {
    payload: catalogPolicy, live: { ...catalogPolicy, settings: [REALTIME, vpn] }, body,
  }), ['device_vendor_msft_vpnv2_eap_configuration'], 'a nested value that names a trusted root, named by its setting');
  assert.deepEqual(wholeReplaceTrustSettings('configurationPolicy', {
    payload: { ...catalogPolicy, description: 'Trusted certificate rollout' }, live: catalogPolicy, body,
  }), [], 'the object\'s own name and description are labels, not settings');
  assert.deepEqual(wholeReplaceTrustSettings('configurationPolicy', {
    payload: { ...catalogPolicy, signingCertificate: null, issuerUri: '' }, live: catalogPolicy, body,
  }), [], 'empty values hold nothing a replace could clear');
  assert.deepEqual(wholeReplaceTrustSettings('configurationPolicy', {
    payload: catalogPolicy, live: { ...catalogPolicy, assignments: [{ target: { trustedRootCertificate: 'x' } }] }, body, excluded: ['assignments'],
  }), [], 'an excluded field is not touched by the replace');
});

test('a settings catalog update is replaced with PUT when nothing in it is a trust setting', async () => {
  const graph = fakeGraph();
  const writes = writesOf(graph);
  const result = await run(graph, [catalogUpdate(graph, catalogPolicy, { ...catalogPolicy, description: 'Live' })], 'enforce');
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(writes, ['PUT /deviceManagement/configurationPolicies/target-policy']);
});

test('a settings catalog update is never PUT when the live policy holds a trust field the body leaves out', async () => {
  for (const mode of MODES) {
    const graph = fakeGraph();
    const writes = writesOf(graph);
    const live = { ...catalogPolicy, description: 'Live', trustedRootCertificate: 'MIIBlive' };
    const result = await run(graph, [catalogUpdate(graph, catalogPolicy, live)], mode);
    assert.deepEqual(result.failed, [], mode);
    assert.deepEqual(result.applied, [], mode);
    assert.deepEqual(writes, [], `${mode}: nothing is written`);
    const [skipped] = result.skipped;
    assert.match(skipped.reason, /^manual: .*written whole.*trustedRootCertificate.*Nothing was written/, mode);
    assert.deepEqual(skipped.completion.map((step) => [step.kind, step.requirement, step.fields]), [['manual-setting', 'trustFields', ['trustedRootCertificate']]], mode);
  }
});

test('a settings catalog update is never PUT when the backup or the live policy holds a trusted certificate setting', async () => {
  const withRoot = { ...catalogPolicy, settingCount: 2, settings: [REALTIME, TRUSTED_ROOT] };
  for (const [label, desired, live] of [
    ['in the backup', withRoot, { ...catalogPolicy, description: 'Live' }],
    ['only live', catalogPolicy, { ...withRoot, description: 'Live' }],
  ]) {
    const graph = fakeGraph();
    const writes = writesOf(graph);
    const result = await run(graph, [catalogUpdate(graph, desired, live)], 'enforce');
    assert.deepEqual(writes, [], `${label}: nothing is written`);
    assert.deepEqual(result.failed, [], label);
    assert.deepEqual(result.skipped[0]?.completion?.[0]?.fields, ['device_vendor_msft_rootcatrustedcertificates_root'], label);
  }
});

test('a settings catalog update with no live policy read is never PUT', () => {
  const refusal = intuneReplaceTrustRefusal('configurationPolicy', catalogPolicy, null);
  assert.equal(refusal.outcome, 'skipped');
  assert.match(refusal.reason, /live object was not read/);
  assert.equal(intuneReplaceTrustRefusal('deviceConfiguration', { displayName: 'KEEL-RT-x' }, null), null, 'a PATCH policy is not a replace');
});

const REUSABLE_PATH = '/deviceManagement/reusablePolicySettings/r-1';
const instance = (settingDefinitionId) => ({
  '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance', settingDefinitionId,
  simpleSettingValue: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationStringSettingValue', value: 'MIIBfixture' },
});

test('a reusable settings group that holds a certificate is never PUT', async () => {
  const definition = 'vendor_msft_clientcertificateinstall_pfxcertinstall_certificate';
  const live = { id: 'r-1', displayName: 'KEEL-RT-Certificate group', description: 'Live', settingDefinitionId: definition, settingInstance: instance(definition) };
  for (const mode of MODES) {
    const graph = idoFakeGraph({ seed: { [REUSABLE_PATH]: live } });
    const backup = { ...live, description: 'Backup' };
    const result = await applyIntuneExtendedWrite(graph, {
      naturalKey: 'deviceManagementReusablePolicySetting:KEEL-RT-Certificate group', resourceType: 'deviceManagementReusablePolicySetting',
      payload: backup, references: [], blastRadius: 'access-affecting', live: { state: 'present', targetId: 'r-1', payload: live },
    }, 'update', { ...FAST, mode });
    assert.equal(result.failed, undefined, result.failed?.error);
    assert.equal(graph.calls.some((call) => call.method === 'PUT'), false, `${mode}: nothing is written`);
    assert.match(result.skipped.reason, /^manual: /, mode);
    assert.deepEqual(result.skipped.completion[0].fields, [definition], mode);
  }
});

test('a reusable settings group with no trust setting is still written with PUT', async () => {
  const live = { id: 'r-1', displayName: 'KEEL-RT-Addresses', description: 'Live', settingDefinitionId: 'def-a', settingInstance: instance('def-a_addresses') };
  const graph = idoFakeGraph({ seed: { [REUSABLE_PATH]: live } });
  const result = await applyIntuneExtendedWrite(graph, {
    naturalKey: 'deviceManagementReusablePolicySetting:KEEL-RT-Addresses', resourceType: 'deviceManagementReusablePolicySetting',
    payload: { ...live, description: 'Backup' }, references: [], blastRadius: 'access-affecting', live: { state: 'present', targetId: 'r-1', payload: live },
  }, 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(result.skipped, undefined);
  assert.equal(graph.calls.filter((call) => call.method === 'PUT').length, 1);
});

test('a settings catalog compliance policy whose live copy holds a trust setting is never PUT', async () => {
  const path = '/deviceManagement/compliancePolicies/cp-1';
  const compliance = {
    id: 'cp-1', name: 'KEEL-RT-compliance', description: 'Backup', platforms: 'linux', technologies: 'linuxMdm', roleScopeTagIds: ['0'],
    settingCount: 1, settings: [choice('0', 'linux_deviceencryption_required', 'linux_deviceencryption_required_true')], scheduledActionsForRule: [],
  };
  const live = {
    ...compliance, description: 'Live', settingCount: 2,
    settings: [...compliance.settings, choice('1', 'linux_customcompliance_trustedrootcertificate', 'linux_customcompliance_trustedrootcertificate_1')],
  };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIntuneExtendedWrite(graph, {
    naturalKey: 'deviceManagementCompliancePolicy:KEEL-RT-compliance', resourceType: 'deviceManagementCompliancePolicy',
    payload: compliance, references: [], blastRadius: 'access-affecting', live: { state: 'present', targetId: 'cp-1', payload: live },
  }, 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(graph.calls.some((call) => call.method !== 'GET' && call.method !== undefined), false, 'nothing is written');
  assert.deepEqual(result.skipped.completion[0].fields, ['linux_customcompliance_trustedrootcertificate']);
});

test('a nested trust key inside the settings refuses the PUT, though an update body leaves the settings out', async () => {
  const keyed = { ...REALTIME, settingInstance: { ...REALTIME.settingInstance, trustedRootCertificate: 'MIIBnested' } };
  for (const [label, desired, live] of [
    ['in the backup', { ...catalogPolicy, settings: [keyed] }, { ...catalogPolicy, description: 'Live' }],
    ['only live', catalogPolicy, { ...catalogPolicy, description: 'Live', settings: [keyed] }],
  ]) {
    const graph = fakeGraph();
    const writes = writesOf(graph);
    const result = await run(graph, [catalogUpdate(graph, desired, live)], 'enforce');
    assert.deepEqual(writes, [], `${label}: nothing is written`);
    assert.deepEqual(result.failed, [], label);
    assert.deepEqual(result.skipped[0]?.completion?.[0]?.fields, ['trustedRootCertificate'], label);
  }
});
