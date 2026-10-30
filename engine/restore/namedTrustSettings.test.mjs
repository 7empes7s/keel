/**
 * Custom (OMA-URI) profiles name each setting by its omaUri value, and
 * administrative templates by a GUID definition id, so the key-based trust
 * check (isTrustField) never sees a trusted root certificate or a sign-in
 * setting in them. These tests drive the production refusals with fixtures
 * only; nothing here reads or writes a tenant.
 *
 * Base64 custom values and Apple custom profile files (a property list) are
 * decoded and read the same way.
 *
 * Mutation check: drop the omaTrustRefusal call from intuneWriteRefusal, the
 * trust check from groupPolicyRefusal, or groupPolicyLiveTrust from the
 * template's preflight, and a test here fails.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { applyIntuneExtendedWrite, intuneWriteRefusal, omaTrustRefusal } from './intuneOperations.mjs';
import { appleProfileTrust, groupPolicyTrustSettings, isTrustSettingName, trustOmaUris } from './namedTrustSettings.mjs';
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
  // So is a live profile read without its custom settings list: the backup list would replace settings nobody checked.
  const { omaSettings: _list, ...withoutList } = plain;
  for (const liveProfile of [withoutList, { ...plain, omaSettings: null }]) {
    const refusal = intuneWriteRefusal(resourceOf('deviceConfiguration', plain, live(liveProfile)), 'update');
    assert.equal(refusal?.outcome, 'skipped');
    assert.match(refusal.reason, /^manual: the live profile was not read/);
  }
  // An empty live list was read, so it holds no trust setting to remove.
  assert.equal(intuneWriteRefusal(resourceOf('deviceConfiguration', plain, live({ ...plain, omaSettings: [] })), 'update'), null);
});

// --------------------------------------------- base64 values and Apple files

const b64 = (data) => Buffer.from(data).toString('base64');
// The shape of a DER certificate (an ASN.1 sequence with a two-byte length), not a real one.
const DER = Buffer.from([0x30, 0x82, 0x00, 0x04, 0x30, 0x02, 0x05, 0x00]);
const NEUTRAL = './Device/Vendor/MSFT/Policy/Config/Fixture/Value';
const base64Setting = (value, odataType = '#microsoft.graph.omaSettingBase64') => ({ '@odata.type': odataType, displayName: 'Fixture', omaUri: NEUTRAL, fileName: 'fixture.bin', value });

test('a base64 custom value is decoded: trust text or a certificate is found under an OMA-URI that does not say so', () => {
  for (const value of [
    b64('<EapHostConfig><TrustedRootCA>ab cd</TrustedRootCA></EapHostConfig>'),
    b64(DER),
    b64('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'),
    // UTF-16 with a byte order mark, as Windows tools save XML.
    b64(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<WLANProfile><ServerNames>x</ServerNames><TrustedRootCA>ab</TrustedRootCA></WLANProfile>', 'utf16le')])),
  ]) assert.deepEqual(trustOmaUris(customProfile([base64Setting(value)])), [NEUTRAL], value);
  // Graph returns a StringXml value as base64.
  const xml = b64('<EapHostConfig><TrustedRootCA>ab</TrustedRootCA></EapHostConfig>');
  assert.deepEqual(trustOmaUris(customProfile([base64Setting(xml, '#microsoft.graph.omaSettingStringXml')])), [NEUTRAL]);
  // Ordinary text, binary that is not a certificate, and text that is not base64 are not trust.
  for (const value of [b64('<Config><Volume>3</Volume></Config>'), b64(Buffer.from([0x00, 0x01, 0xfe, 0x30, 0x82])), 'not base64 at all, trust']) {
    assert.deepEqual(trustOmaUris(customProfile([base64Setting(value)])), [], value);
  }
  // Other encodings: ISO-8859-1 XML, UTF-16 without a byte order mark, and a PKCS #12 file (BER, indefinite length).
  const wlan = '<?xml version="1.0" encoding="ISO-8859-1"?><WLANProfile><name>Caf\u00e9</name><TrustedRootCA>ab cd</TrustedRootCA></WLANProfile>';
  for (const value of [b64(Buffer.from(wlan, 'latin1')), b64(Buffer.from(wlan, 'utf16le')), b64(Buffer.from(wlan, 'utf16le').swap16()), b64(Buffer.from([0x30, 0x80, 0x02, 0x01, 0x03, 0x30, 0x80]))]) {
    assert.deepEqual(trustOmaUris(customProfile([base64Setting(value)])), [NEUTRAL], value);
  }
  // UTF-16 without a byte order mark whose text is mostly not ASCII (Cyrillic, CJK), either byte order.
  for (const words of ['\u041f\u0440\u043e\u0444\u0438\u043b\u044c \u0441\u0435\u0442\u0438 ', '\u7121\u7dda\u8a2d\u5b9a\u30d7\u30ed\u30d5\u30a1\u30a4\u30eb ']) {
    const text = `${words.repeat(20)}<TrustedRootCA>ab</TrustedRootCA>${words.repeat(20)}`;
    for (const bytes of [Buffer.from(text, 'utf16le'), Buffer.from(text, 'utf16le').swap16()]) {
      assert.deepEqual(trustOmaUris(customProfile([base64Setting(b64(bytes))])), [NEUTRAL], text);
    }
    // The same text without a trust name is not trust.
    assert.deepEqual(trustOmaUris(customProfile([base64Setting(b64(Buffer.from(words.repeat(40), 'utf16le')))])), []);
  }
  // A StringXml value that is not base64 is read as written, XML or not.
  assert.deepEqual(trustOmaUris(customProfile([base64Setting('ServerNames: TrustedRootCA x', '#microsoft.graph.omaSettingStringXml')])), [NEUTRAL]);
  const refusal = intuneWriteRefusal(resourceOf('deviceConfiguration', customProfile([base64Setting(b64(DER))])), 'create');
  assert.equal(refusal?.outcome, 'skipped');
  assert.deepEqual(refusal.completion[0].fields, [NEUTRAL]);
});

const plist = (...payloads) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>PayloadContent</key><array>${payloads.join('')}</array>
  <key>PayloadDisplayName</key><string>KEEL-RT-profile</string>
  <key>PayloadIdentifier</key><string>com.example.keel-rt</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict></plist>`;
const payloadOf = (type, body = '') => `<dict><key>PayloadType</key><string>${type}</string>${body}<key>PayloadVersion</key><integer>1</integer></dict>`;
const DOCK = payloadOf('com.apple.dock', '<key>autohide</key><true/><key>tilesize</key><integer>48</integer>');
const appleProfile = (file, odataType = '#microsoft.graph.macOSCustomConfiguration', field = 'payload') => Object.freeze({
  '@odata.type': odataType, id: 'src-mac', displayName: 'KEEL-RT-mac', description: 'Fixture', roleScopeTagIds: ['0'], payloadName: 'KEEL-RT', payloadFileName: 'keel-rt.mobileconfig', [field]: file,
});

test('an Apple custom profile file is read: trust payload types and trust content are found, ordinary ones are not', () => {
  assert.deepEqual(appleProfileTrust(appleProfile(b64(plist(DOCK)))), { trust: [], unreadable: [] });
  assert.deepEqual(appleProfileTrust(appleProfile(b64(plist(DOCK, payloadOf('com.apple.security.root', `<key>PayloadContent</key><data>${b64(DER)}</data>`))))), {
    trust: ['com.apple.security.root'], unreadable: [],
  });
  for (const type of ['com.apple.security.pkcs12', 'com.apple.security.scep', 'com.apple.extensiblesso', 'com.apple.sso', 'com.apple.security.pem']) {
    assert.deepEqual(appleProfileTrust(appleProfile(b64(plist(payloadOf(type))))).trust, [type], type);
  }
  // Trust content in a payload whose type does not say so: Wi-Fi trusted servers, or a certificate in a data block.
  const wifi = payloadOf('com.apple.wifi.managed', '<key>EAPClientConfiguration</key><dict><key>TLSTrustedServerNames</key><array><string>radius.example</string></array></dict>');
  assert.deepEqual(appleProfileTrust(appleProfile(b64(plist(wifi)))).trust, ['payload']);
  const certData = payloadOf('com.example.agent', `<key>Blob</key><data>${b64(DER)}</data>`);
  assert.deepEqual(appleProfileTrust(appleProfile(b64(plist(certData)))).trust, ['payload']);
  // Data blocks are never read as text, so base64 that happens to spell a trust word is not trust.
  const noisy = payloadOf('com.example.agent', '<key>Blob</key><data>trustpfxScepPkcs+AA=</data>');
  assert.deepEqual(appleProfileTrust(appleProfile(b64(plist(noisy)))).trust, []);
  // A signed profile wraps the XML in binary CMS.
  const signed = Buffer.concat([Buffer.from([0x30, 0x80, 0x06, 0x09, 0x2a, 0x86, 0x48]), Buffer.from(plist(payloadOf('com.apple.security.root'))), Buffer.from([0x00, 0x00, 0xa0, 0x82])]);
  assert.deepEqual(appleProfileTrust(appleProfile(b64(signed))).trust, ['com.apple.security.root']);
  // A file that never closes its payload type is read in linear time.
  const started = Date.now();
  assert.deepEqual(appleProfileTrust(appleProfile(b64(`<plist><key>PayloadType</key><string>${' '.repeat(50000)}x`))).trust, []);
  assert.ok(Date.now() - started < 2000, 'payload type scan is linear');
  // A binary property list cannot be read.
  assert.deepEqual(appleProfileTrust(appleProfile(b64(Buffer.concat([Buffer.from('bplist00'), Buffer.from([0xd1, 0x01, 0x02, 0x00])])))), { trust: [], unreadable: ['payload'] });
  // iOS custom profiles and macOS preference files are read the same way.
  assert.deepEqual(appleProfileTrust(appleProfile(b64(plist(payloadOf('com.apple.security.root'))), '#microsoft.graph.iosCustomConfiguration')).trust, ['com.apple.security.root']);
  const prefs = b64('<?xml version="1.0"?><plist version="1.0"><dict><key>KerberosRealm</key><string>EXAMPLE.COM</string></dict></plist>');
  assert.deepEqual(appleProfileTrust(appleProfile(prefs, '#microsoft.graph.macOSCustomAppConfiguration', 'configurationXml')).trust, ['configurationXml']);
  // Other profile kinds and empty files are not read.
  assert.deepEqual(appleProfileTrust(appleProfile(b64(plist(payloadOf('com.apple.security.root'))), '#microsoft.graph.macOSGeneralDeviceConfiguration')), { trust: [], unreadable: [] });
  assert.deepEqual(appleProfileTrust(null), { trust: [], unreadable: [] });
});

test('an Apple custom profile holding trust content is manual on create and update, and an unreadable one is manual too', () => {
  const trusted = appleProfile(b64(plist(DOCK, payloadOf('com.apple.security.root'))));
  const plain = appleProfile(b64(plist(DOCK)));
  for (const verb of ['create', 'update']) {
    const refusal = intuneWriteRefusal(resourceOf('deviceConfiguration', trusted, verb === 'update' ? live(plain) : {}), verb);
    assert.equal(refusal?.outcome, 'skipped', verb);
    assert.match(refusal.reason, /^manual: this profile holds custom settings for trust, certificates or sign-in \(com\.apple\.security\.root\)/, verb);
    assert.deepEqual(refusal.completion.map(({ kind, requirement, fields }) => ({ kind, requirement, fields })), [{ kind: 'manual-setting', requirement: 'trustFields', fields: ['com.apple.security.root'] }], verb);
  }
  // The file is written whole, so a backup without the trust payload would remove the live one.
  assert.ok(intuneWriteRefusal(resourceOf('deviceConfiguration', plain, live(trusted)), 'update')?.reason.includes('com.apple.security.root'));
  assert.match(intuneWriteRefusal(resourceOf('deviceConfiguration', plain), 'update')?.reason ?? '', /^manual: the live profile was not read/);
  // So is a live profile read without its file.
  const { payload: _file, ...withoutFile } = plain;
  assert.match(intuneWriteRefusal(resourceOf('deviceConfiguration', plain, live(withoutFile)), 'update')?.reason ?? '', /^manual: the live profile was not read/);
  const binary = appleProfile(b64(Buffer.concat([Buffer.from('bplist00'), Buffer.from([0xd1, 0x01])])));
  const unreadable = intuneWriteRefusal(resourceOf('deviceConfiguration', binary), 'create');
  assert.match(unreadable?.reason ?? '', /^manual: the profile file \(payload\) could not be read/);
  assert.deepEqual(unreadable.completion[0].fields, ['payload']);
  // A file with a few stray bytes before its XML is never guessed to be UTF-16 text, which would hide its trust payload.
  const prefixed = Buffer.concat([Buffer.from([0x00, 0x41, 0x01, 0x41]), Buffer.from(plist(payloadOf('com.apple.security.root')))]);
  const even = prefixed.length % 2 === 0 ? prefixed : Buffer.concat([prefixed, Buffer.from(' ')]);
  assert.deepEqual(appleProfileTrust(appleProfile(b64(even))).trust, ['com.apple.security.root']);
  // A profile with no trust content is written as before.
  assert.equal(intuneWriteRefusal(resourceOf('deviceConfiguration', plain), 'create'), null);
  assert.equal(intuneWriteRefusal(resourceOf('deviceConfiguration', plain, live(plain)), 'update'), null);
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
