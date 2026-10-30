/**
 * Custom (OMA-URI) profiles name each setting by its omaUri value, and
 * administrative templates by a GUID definition id, so the key-based trust
 * check (isTrustField) never sees a trusted root certificate or a sign-in
 * setting in them. These tests drive the production refusals with fixtures
 * only; nothing here reads or writes a tenant.
 *
 * Mutation check: drop the omaTrustRefusal call from intuneWriteRefusal, the
 * trust check from groupPolicyRefusal, or groupPolicyLiveTrust from the
 * template's preflight, and a test here fails.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { applyIntuneExtendedWrite, intuneWriteRefusal, omaTrustRefusal } from './intuneOperations.mjs';
import { groupPolicyTrustSettings, isTrustSettingName, trustOmaUris } from './namedTrustSettings.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';

const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };
const resourceOf = (resourceType, payload, extra = {}) => ({
  naturalKey: `${resourceType}:${payload.displayName ?? payload.id}`, resourceType, payload, references: [], blastRadius: 'access-affecting', ...extra,
});
const live = (payload, targetId = 'tgt-1') => ({ live: { state: 'present', targetId, payload } });

// ------------------------------------------------------------------ OMA-URI

const ROOT_CA = './Device/Vendor/MSFT/RootCATrustedCertificates/Root/0123456789abcdef/EncodedCertificate';
const WEB_SIGN_IN = './Device/Vendor/MSFT/Policy/Config/Authentication/EnableWebSignIn';
const DEFENDER = './Device/Vendor/MSFT/Policy/Config/Defender/AllowRealtimeMonitoring';
const oma = (omaUri, value) => ({ '@odata.type': '#microsoft.graph.omaSettingInteger', displayName: 'Fixture', description: null, omaUri, value });
const customProfile = (settings, odataType = '#microsoft.graph.windows10CustomConfiguration') => Object.freeze({
  '@odata.type': odataType, id: 'src-custom', displayName: 'KEEL-RT-custom', description: 'Fixture', roleScopeTagIds: ['0'], omaSettings: settings,
});

test('trust, certificate and sign-in OMA-URIs are found, ordinary ones are not', () => {
  for (const uri of [
    ROOT_CA, WEB_SIGN_IN,
    './User/Vendor/MSFT/ClientCertificateInstall/SCEP/1/Install/ServerURL',
    './Device/Vendor/MSFT/PassportForWork/tenant-1/Policies/UsePassportForWork',
    './Device/Vendor/MSFT/Policy/Config/Kerberos/CloudKerberosTicketRetrievalEnabled',
    './Device/Vendor/MSFT/Policy/Config/Authentication/ConfigureWebSignInAllowedUrls',
    './Device/Vendor/MSFT/Policy/Config/InternetExplorer/AllowSiteToZoneAssignmentList',
  ]) assert.equal(isTrustSettingName(uri), true, uri);
  for (const uri of [
    DEFENDER, './Device/Vendor/MSFT/BitLocker/RequireDeviceEncryption', './Device/Vendor/MSFT/Policy/Config/DeviceLock/MaxDevicePasswordFailedAttempts',
    './Device/Vendor/MSFT/Policy/Config/Update/ActiveHoursStart',
  ]) assert.equal(isTrustSettingName(uri), false, uri);
  assert.deepEqual(trustOmaUris(customProfile([oma(DEFENDER, 1), oma(WEB_SIGN_IN, 1), oma(ROOT_CA, 1), oma(ROOT_CA, 1)])), [ROOT_CA, WEB_SIGN_IN].sort());
  assert.deepEqual(trustOmaUris(customProfile([oma(DEFENDER, 1)])), []);
  // A VPN EAP or Wi-Fi XML names its trusted root certificates in the value, not the OMA-URI.
  const eap = './User/Vendor/MSFT/VPNv2/Office/NativeProfile/Authentication/Eap/Configuration';
  const xml = { '@odata.type': '#microsoft.graph.omaSettingStringXml', omaUri: eap, value: '<EapHostConfig><TrustedRootCA>ab cd</TrustedRootCA></EapHostConfig>' };
  assert.deepEqual(trustOmaUris(customProfile([xml])), [eap]);
  assert.deepEqual(trustOmaUris(customProfile([{ ...xml, value: '<EapHostConfig/>' }])), []);
  // A base64 value is not read as text.
  assert.deepEqual(trustOmaUris(customProfile([{ '@odata.type': '#microsoft.graph.omaSettingBase64', omaUri: './Vendor/MSFT/x', value: 'dHJ1c3Q=trust' }])), []);
  assert.deepEqual(trustOmaUris(null), []);
});

test('a custom profile holding a trust OMA-URI is manual on create and update, and names the setting', () => {
  const trusted = customProfile([oma(DEFENDER, 1), oma(ROOT_CA, 1)]);
  const plain = customProfile([oma(DEFENDER, 1)]);
  for (const verb of ['create', 'update']) {
    const refusal = intuneWriteRefusal(resourceOf('deviceConfiguration', trusted, verb === 'update' ? live(plain) : {}), verb);
    assert.equal(refusal?.outcome, 'skipped', verb);
    assert.match(refusal.reason, /^manual: this profile holds custom settings for trust, certificates or sign-in/, verb);
    assert.ok(refusal.reason.includes(ROOT_CA), verb);
    // The manual step stays open as a completion item naming the setting.
    assert.deepEqual(refusal.completion.map(({ kind, requirement, fields }) => ({ kind, requirement, fields })), [{ kind: 'manual-setting', requirement: 'trustFields', fields: [ROOT_CA] }], verb);
  }
  // The custom settings are written as one list, so a backup without the setting would remove the live one.
  const removes = intuneWriteRefusal(resourceOf('deviceConfiguration', plain, live(trusted)), 'update');
  assert.equal(removes?.outcome, 'skipped');
  assert.ok(removes.reason.includes(ROOT_CA));
  // Android custom profiles hold OMA-URIs the same way.
  const android = customProfile([oma('./Vendor/MSFT/WiFi/Profile/Office/TrustedRootCertificate', 'x')], '#microsoft.graph.androidCustomConfiguration');
  assert.equal(intuneWriteRefusal(resourceOf('deviceConfiguration', android), 'create')?.outcome, 'skipped');
  // A create never looks at a live profile, and a profile with no trust setting is written as before.
  assert.equal(omaTrustRefusal(resourceOf('deviceConfiguration', plain, live(trusted)), 'create'), null);
  assert.equal(intuneWriteRefusal(resourceOf('deviceConfiguration', plain, live(plain)), 'update'), null);
  assert.equal(intuneWriteRefusal(resourceOf('deviceConfiguration', plain), 'create'), null);
  // An update without the live profile cannot show the list removes no trust setting.
  assert.match(intuneWriteRefusal(resourceOf('deviceConfiguration', plain), 'update')?.reason ?? '', /^manual: the live profile was not read/);
});

// ------------------------------------------------- administrative templates

const TEMPLATE_PATH = '/deviceManagement/groupPolicyConfigurations';
const AUTH_SERVERS = { id: 'd-auth', displayName: 'Configure list of allowed authentication servers', categoryPath: '\\Microsoft Edge\\HTTP authentication' };
const ZONES = { id: 'd-zones', displayName: 'Site to Zone Assignment List', categoryPath: '\\Windows Components\\Internet Explorer\\Internet Control Panel\\Security Page' };
const HOME_PAGE = { id: 'd-home', displayName: 'Configure the home page URL', categoryPath: '\\Microsoft Edge\\Startup, home page and new tab page' };
const TPM = { id: 'd-tpm', displayName: 'Configure the system power state', categoryPath: '\\System\\Trusted Platform Module Services' };
const setting = (definition, id = `s-${definition.id}`) => ({
  id, enabled: true, configurationType: 'policy', createdDateTime: 'x', definition,
  presentationValues: [{ '@odata.type': '#microsoft.graph.groupPolicyPresentationValueText', id: `v-${id}`, value: 'x', presentation: { id: `p-${definition.id}` } }],
});
const template = (...definitions) => Object.freeze({
  id: 'gp-src', displayName: 'KEEL-RT-admx', description: 'Fixture', roleScopeTagIds: ['0'], definitionValues: definitions.map((definition) => setting(definition)),
});
const definitionsSeed = (...definitions) => Object.fromEntries(definitions.map(({ id }) => [`/deviceManagement/groupPolicyDefinitions/${id}`, { id }]));

test('administrative template trust settings are found by display name or category, and unnamed ones are told apart', () => {
  const { definitionValues } = template(HOME_PAGE, AUTH_SERVERS, ZONES, TPM, { id: 'd-bare' }, {
    id: 'd-sso', displayName: 'Allow single sign-on for Microsoft personal sites', categoryPath: '\\Microsoft Edge',
  }, { id: 'd-cat', displayName: 'Prevent changes', categoryPath: '\\Windows Components\\Credential User Interface\\Smart Card' });
  assert.deepEqual(groupPolicyTrustSettings(definitionValues), {
    trust: ['Allow single sign-on for Microsoft personal sites', AUTH_SERVERS.displayName, 'Prevent changes', ZONES.displayName].sort(),
    unknown: ['d-bare'],
  });
  assert.equal(isTrustSettingName('Browser sign-in settings'), true);
  // Credential delegation, and settings catalog ids that need their dots.
  for (const name of [
    'Specifies a list of servers that Microsoft Edge can delegate user credentials to', 'Allow delegating default credentials',
    '\\System\\Credentials Delegation', 'com.apple.security.root',
  ]) assert.equal(isTrustSettingName(name), true, name);
  assert.equal(isTrustSettingName('\\Windows Components\\Microsoft Defender Antivirus'), false);
});

test('an administrative template holding a trust setting is never written', async () => {
  for (const definition of [AUTH_SERVERS, ZONES]) {
    const graph = idoFakeGraph({ seed: definitionsSeed(HOME_PAGE, definition) });
    const result = await applyIntuneExtendedWrite(graph, resourceOf('groupPolicyConfiguration', template(HOME_PAGE, definition)), 'create', FAST);
    assert.equal(result.failed, undefined, result.failed?.error);
    assert.match(result.skipped?.reason ?? '', /^manual: this template holds trust, certificate or sign-in settings/);
    assert.ok(result.skipped.reason.includes(definition.displayName));
    assert.deepEqual(result.skipped.completion?.[0]?.fields, [definition.displayName]);
    assert.equal(graph.calls.length, 0, 'nothing is read or written');
  }
  // A setting the backup does not describe cannot be checked, so it is not written either.
  const graph = idoFakeGraph({ seed: definitionsSeed(HOME_PAGE, { id: 'd-bare' }) });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('groupPolicyConfiguration', template(HOME_PAGE, { id: 'd-bare' })), 'create', FAST);
  assert.match(result.skipped?.reason ?? '', /^manual: this backup does not say what the setting d-bare is/);
  assert.equal(graph.calls.length, 0);
});

test('an administrative template update is manual when the live template holds a trust setting it would remove', async () => {
  const path = `${TEMPLATE_PATH}/gp-1`;
  const liveTemplate = { id: 'gp-1', displayName: 'KEEL-RT-admx', description: 'Changed', roleScopeTagIds: ['0'] };
  const seed = (extra) => ({
    ...definitionsSeed(HOME_PAGE, AUTH_SERVERS),
    [path]: { ...liveTemplate, definitionValues: [setting(HOME_PAGE, 'live-1'), ...extra.map((definition) => setting(definition, `live-${definition.id}`))] },
    [`${path}/definitionValues/live-1`]: { id: 'live-1', presentationValues: [] },
    ...Object.fromEntries(extra.map((definition) => [`${path}/definitionValues/live-${definition.id}`, { id: `live-${definition.id}`, presentationValues: [] }])),
  });
  const backup = template(HOME_PAGE);

  // The snapshot's live payload has no settings, so only the preflight's own read finds the trust setting.
  const graph = idoFakeGraph({ seed: seed([AUTH_SERVERS]) });
  const result = await applyIntuneExtendedWrite(graph, resourceOf('groupPolicyConfiguration', backup, live(liveTemplate, 'gp-1')), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.match(result.skipped?.reason ?? '', /^manual: this template holds trust, certificate or sign-in settings \(Configure list of allowed authentication servers\)/);
  assert.deepEqual(graph.calls.filter((call) => call.method !== 'GET'), [], 'nothing is written');
  assert.deepEqual(result.skipped.completion?.[0]?.fields, [AUTH_SERVERS.displayName]);

  // A live payload that holds the settings is checked before any read.
  const known = idoFakeGraph({ seed: seed([AUTH_SERVERS]) });
  const held = await applyIntuneExtendedWrite(known, resourceOf('groupPolicyConfiguration', backup, live({ ...liveTemplate, definitionValues: [setting(AUTH_SERVERS)] }, 'gp-1')), 'update', FAST);
  assert.match(held.skipped?.reason ?? '', /^manual: this template holds trust/);
  assert.equal(known.calls.length, 0);

  // Without a trust setting live, the update goes ahead.
  const plain = idoFakeGraph({ seed: seed([]) });
  const written = await applyIntuneExtendedWrite(plain, resourceOf('groupPolicyConfiguration', backup, live(liveTemplate, 'gp-1')), 'update', FAST);
  assert.equal(written.failed, undefined, written.failed?.error);
  assert.equal(written.skipped, undefined, written.skipped?.reason);
  assert.ok(plain.calls.some((call) => call.method === 'PATCH'));
});
