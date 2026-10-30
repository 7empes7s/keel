/**
 * Settings catalog policies, settings catalog compliance policies and reusable
 * settings groups name each setting by its settingDefinitionId value, so the
 * key-based trust check (isTrustField) never sees a trusted root certificate
 * or a single sign-on setting in them. These tests drive the production
 * refusals with fixtures only; nothing here reads or writes a tenant.
 *
 * Required mutation check: drop the trustSettingRefusal call from any of the
 * three refusals and a test here fails.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { applyIntuneExtendedWrite, intuneWriteRefusal, trustSettingRefusal } from './intuneOperations.mjs';
import { TRUST_SETTING_PATTERN, trustSettingIds } from './workloads/writeDeclarations.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';

const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };
const resourceOf = (resourceType, payload, extra = {}) => ({
  naturalKey: `${resourceType}:${payload.displayName ?? payload.name ?? payload.id}`, resourceType, payload, references: [], blastRadius: 'access-affecting', ...extra,
});

const choice = (settingDefinitionId, value, children = []) => ({
  '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance',
  settingDefinitionId, settingInstanceTemplateReference: null,
  choiceSettingValue: { value: `${settingDefinitionId}_${value}`, settingValueTemplateReference: null, children },
});
const simple = (settingDefinitionId, value) => ({
  '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance',
  settingDefinitionId, simpleSettingValue: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationStringSettingValue', value },
});
const settingOf = (id, settingInstance) => ({ id, settingInstance });

const DEFENDER = 'device_vendor_msft_policy_config_defender_allowrealtimemonitoring';
const WIPE_AFTER = 'device_vendor_msft_policy_config_devicelock_maxdevicepasswordfailedattempts';
const WINDOWS_ROOT = 'device_vendor_msft_rootcatrustedcertificates_root_{certhash}_encodedcertificate';
const APPLE_ROOT = 'com.apple.security.root_payloadcontent';
const APPLE_SSO = 'com.apple.extensiblesso_url';
const EDGE_SSO = 'device_vendor_msft_policy_config_microsoft_edgev117~policy~microsoft_edge_browsersignin';

const catalogPolicy = (settings) => Object.freeze({
  id: 'src-catalog', name: 'KEEL-RT-catalog', description: 'Fixture', platforms: 'windows10', technologies: 'mdm',
  roleScopeTagIds: ['0'], settingCount: settings.length, settings,
});

test('trust, certificate and sign-in settings are found by their definition id at any depth', () => {
  const policy = catalogPolicy([
    settingOf('0', choice(DEFENDER, '1')),
    settingOf('1', simple(WINDOWS_ROOT, 'MIIB...')),
    // An Apple payload: the certificate is a child of a group setting.
    settingOf('2', {
      '@odata.type': '#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance', settingDefinitionId: 'com.apple.security.root',
      groupSettingCollectionValue: [{ children: [simple(APPLE_ROOT, 'MIIC...'), simple('com.apple.security.root_payloaddisplayname', 'Root')] }],
    }),
    settingOf('3', choice('com.apple.extensiblesso', 'true', [simple(APPLE_SSO, 'https://idp.example.test')])),
    settingOf('4', choice(EDGE_SSO, '1')),
  ]);
  // Every setting of the Apple root certificate payload counts, its display name included.
  assert.deepEqual(trustSettingIds(policy), [
    APPLE_SSO, 'com.apple.extensiblesso', 'com.apple.security.root', APPLE_ROOT, 'com.apple.security.root_payloaddisplayname', WINDOWS_ROOT, EDGE_SSO,
  ].sort());
  for (const id of [DEFENDER, WIPE_AFTER, 'linux_deviceencryption_required', 'com.apple.mail.managed_emailaddress']) {
    assert.equal(TRUST_SETTING_PATTERN.test(id), false, id);
  }
  for (const id of [
    'device_vendor_msft_policy_config_kerberos_kdcproxyservers', 'device_vendor_msft_policy_config_kerberos_cloudkerberosticketretrievalenabled',
    'device_vendor_msft_policy_config_microsoft_edge~policy~microsoft_edge~httpauthentication_authserverallowlist',
    'device_vendor_msft_policy_config_microsoft_edge~policy~microsoft_edge~httpauthentication_authnegotiatedelegateallowlist',
    'com.apple.sso_realm', 'com.apple.loginwindow_loginwindowtext', 'com.apple.security.identitypreference_name',
  ]) assert.equal(TRUST_SETTING_PATTERN.test(id), true, id);
  assert.deepEqual(trustSettingIds(catalogPolicy([settingOf('0', choice(DEFENDER, '1')), settingOf('1', simple(WIPE_AFTER, '10'))])), []);
  assert.deepEqual(trustSettingIds(null), []);
});

test('a settings catalog policy holding a trust setting is manual on create and update, and names the setting', () => {
  const trusted = catalogPolicy([settingOf('0', choice(DEFENDER, '1')), settingOf('1', simple(WINDOWS_ROOT, 'MIIB...'))]);
  const plain = catalogPolicy([settingOf('0', choice(DEFENDER, '1'))]);
  const live = (payload) => ({ live: { state: 'present', targetId: 'tgt-1', payload } });

  for (const verb of ['create', 'update']) {
    const refusal = intuneWriteRefusal(resourceOf('configurationPolicy', trusted, verb === 'update' ? live(plain) : {}), verb);
    assert.equal(refusal?.outcome, 'skipped', verb);
    assert.match(refusal.reason, /^manual: this policy holds trust, certificate or sign-in settings/, verb);
    assert.ok(refusal.reason.includes(WINDOWS_ROOT), verb);
  }
  // The policy is written whole, so a backup without the setting would delete the live one.
  const removes = intuneWriteRefusal(resourceOf('configurationPolicy', plain, live(trusted)), 'update');
  assert.equal(removes?.outcome, 'skipped');
  assert.ok(removes.reason.includes(WINDOWS_ROOT));
  // A create never looks at a live policy, and a policy with no trust setting is written as before.
  assert.equal(trustSettingRefusal(resourceOf('configurationPolicy', plain, live(trusted)), 'create'), null);
  assert.equal(intuneWriteRefusal(resourceOf('configurationPolicy', plain, live(plain)), 'update'), null);
});

test('a settings catalog compliance policy holding a trust setting is never written', async () => {
  const compliance = {
    id: 'cp-src', name: 'KEEL-RT-compliance', description: 'Fixture', platforms: 'macOS', technologies: 'mdm', roleScopeTagIds: ['0'],
    settingCount: 1, settings: [settingOf('0', choice('com.apple.security.pkcs1', 'true'))],
    scheduledActionsForRule: [{ ruleName: null, scheduledActionConfigurations: [{ actionType: 'block', gracePeriodHours: 0, notificationTemplateId: '', notificationMessageCCList: [] }] }],
  };
  const graph = idoFakeGraph();
  const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceManagementCompliancePolicy', compliance), 'create', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.match(result.skipped?.reason ?? '', /^manual: this policy holds trust, certificate or sign-in settings \(com\.apple\.security\.pkcs1\)/);
  assert.equal(graph.calls.length, 0, 'nothing is read or written');
});

test('a reusable settings group for a trust setting is never written', async () => {
  const instance = simple('com.apple.security.scep_url', 'https://scep.example.test');
  const group = { id: 'r-1', displayName: 'KEEL-RT-group', description: 'Fixture', settingDefinitionId: 'com.apple.security.scep', settingInstance: instance };
  for (const verb of ['create', 'update']) {
    const graph = idoFakeGraph({ seed: verb === 'update' ? { '/deviceManagement/reusablePolicySettings/r-1': group } : {} });
    const extra = verb === 'update' ? { live: { state: 'present', targetId: 'r-1', payload: { ...group, description: 'old' } } } : {};
    const result = await applyIntuneExtendedWrite(graph, resourceOf('deviceManagementReusablePolicySetting', group, extra), verb, FAST);
    assert.match(result.skipped?.reason ?? '', /^manual: this policy holds trust, certificate or sign-in settings \(com\.apple\.security\.scep, com\.apple\.security\.scep_url\)/, verb);
    assert.equal(graph.calls.length, 0, `${verb}: nothing is read or written`);
  }
});
