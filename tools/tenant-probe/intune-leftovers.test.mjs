import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import intuneLeftovers from './catalog.d/intune-leftovers.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';
import { get } from '../../engine/collect/registry.mjs';
import '../../engine/collect/entraAdapter.mjs';

// Independent expectations: the documented Graph route for each type, written
// out here rather than derived from the catalogue under test.
const OWNER_SELECT = 'id,accountId,configureWifi,createdDateTime,description,deviceNameTemplate,displayName,enrollmentMode,enrollmentTokenType,isTeamsDeviceProfile,lastModifiedDateTime,roleScopeTagIds,tokenCreationDateTime,tokenExpirationDateTime,wifiHidden,wifiSecurityType,wifiSsid';
const WORK_SELECT = 'id,accountId,createdDateTime,description,displayName,lastModifiedDateTime,tokenExpirationDateTime';
const SYMANTEC_SELECT = 'id,expirationDateTime,issuer,issuerName,status,subject,subjectName,uploadDateTime';
const EXPECTED = [
  ['deviceManagementSettings', '/beta/deviceManagement', 'tier1', 'singleton'],
  ['androidDeviceOwnerEnrollmentProfile', `/beta/deviceManagement/androidDeviceOwnerEnrollmentProfiles?$select=${OWNER_SELECT}`, 'tier2', 'list'],
  ['androidForWorkEnrollmentProfile', `/beta/deviceManagement/androidForWorkEnrollmentProfiles?$select=${WORK_SELECT}`, 'tier3', 'list'],
  ['appleUserInitiatedEnrollmentProfile', '/beta/deviceManagement/appleUserInitiatedEnrollmentProfiles', 'tier2', 'list'],
  ['androidForWorkSettings', '/beta/deviceManagement/androidForWorkSettings', 'tier3', 'singleton'],
  ['deviceManagementDerivedCredentialSettings', '/beta/deviceManagement/derivedCredentials', 'tier2', 'list'],
  ['microsoftTunnelConfiguration', '/beta/deviceManagement/microsoftTunnelConfigurations', 'tier2', 'list'],
  ['microsoftTunnelHealthThreshold', '/beta/deviceManagement/microsoftTunnelHealthThresholds', 'tier3', 'list'],
  ['iosLobAppProvisioningConfiguration', '/beta/deviceAppManagement/iosLobAppProvisioningConfigurations', 'tier2', 'per-object'],
  ['mobileAppRelationship', '/beta/deviceAppManagement/mobileAppRelationships', 'tier3', 'list'],
  ['managedEBook', '/beta/deviceAppManagement/managedEBooks', 'tier3', 'list'],
  ['managedEBookCategory', '/beta/deviceAppManagement/managedEBookCategories', 'tier3', 'list'],
  ['cartToClassAssociation', '/beta/deviceManagement/cartToClassAssociations', 'tier3', 'list'],
  ['windowsManagedAppProtection', '/beta/deviceAppManagement/windowsManagedAppProtections', 'tier2', 'per-object'],
  ['enterpriseCodeSigningCertificate', '/beta/deviceAppManagement/enterpriseCodeSigningCertificates', 'tier3', 'list'],
  ['symantecCodeSigningCertificate', `/beta/deviceAppManagement/symantecCodeSigningCertificate?$select=${SYMANTEC_SELECT}`, 'tier3', 'singleton'],
  ['userExperienceAnalyticsBaseline', '/beta/deviceManagement/userExperienceAnalyticsBaselines', 'tier3', 'list'],
];

test('the Intune leftovers family holds exactly the planned types, all in CATALOG', () => {
  assert.deepEqual(intuneLeftovers.map((entry) => entry.type), EXPECTED.map(([type]) => type));
  for (const [type, , criticality, shape] of EXPECTED) {
    const entry = catalogEntryFor(type);
    assert.ok(entry, `${type} is in CATALOG`);
    assert.equal(entry.criticality, criticality, type);
    assert.ok(['tenant-lockout', 'access-affecting', 'cosmetic'].includes(entry.blastRadius), type);
    assert.equal(entry.singleton === true, shape === 'singleton', `${type} is a ${shape}`);
    // A singleton never set up, or an object deleted after the list, may answer 404; a list read never hides one.
    assert.equal(entry.absentWhenNotFound === true, shape !== 'list', type);
    assert.ok(!entry.needsOrgId, type);
    assert.equal(Boolean(entry.parent), shape === 'per-object', `${type} is read at a fixed path, or per object`);
    if (shape !== 'per-object') assert.ok(!entry.query, `${type} is read unfiltered`);
    // A page cap would leave the backup incomplete; these types are read in full.
    assert.equal(entry.pageCap, undefined, type);
  }
});

test('enrollment tokens, QR codes, Wi-Fi passwords and certificate files are left out of the read', () => {
  const fields = (type) => catalogEntryFor(type).select.split(',');
  const owner = fields('androidDeviceOwnerEnrollmentProfile');
  for (const secret of ['tokenValue', 'qrCodeContent', 'qrCodeImage', 'wifiPassword']) assert.ok(!owner.includes(secret), `${secret} is never read`);
  for (const needed of ['displayName', 'enrollmentMode', 'wifiSsid', 'tokenExpirationDateTime']) assert.ok(owner.includes(needed), needed);
  const work = fields('androidForWorkEnrollmentProfile');
  for (const secret of ['tokenValue', 'qrCodeContent', 'qrCodeImage']) assert.ok(!work.includes(secret), `${secret} is never read`);
  const symantec = fields('symantecCodeSigningCertificate');
  for (const secret of ['content', 'password']) assert.ok(!symantec.includes(secret), `${secret} is never read`);
  assert.ok(symantec.includes('expirationDateTime'), 'the expiry a renewal needs is kept');
  // The tenant Intune object carries runtime counters; only its settings are read.
  const dm = catalogEntryFor('deviceManagementSettings').selectEach;
  assert.deepEqual(dm, ['settings', 'managedDeviceCleanupSettings']);
  for (const counter of ['deviceProtectionOverview', 'windowsMalwareOverview', 'connectorStatus', 'subscriptionState']) assert.ok(!dm.includes(counter), counter);
  // Issue #447: a $select naming fields outside the core Intune object sent the
  // whole read to another backend, which answered HTTP 400. The brand is read
  // as the default branding profile instead.
  assert.equal(catalogEntryFor('deviceManagementSettings').select, undefined, 'never one read of several fields');
  for (const foreign of ['intuneBrand', 'adminConsent', 'dataProcessorServiceForWindowsFeaturesOnboarding', 'userExperienceAnalyticsSettings',
    'legacyPcManangementEnabled', 'unlicensedAdminstratorsEnabled']) assert.ok(!dm.includes(foreign), foreign);
  // Types read whole have no secret field.
  for (const entry of intuneLeftovers.filter((e) => !e.select)) assert.ok(!/password|token|secret/i.test(entry.path), entry.type);
});

test('types held back for secrets stay out of the catalogue, or are read without the secret (batch 8)', () => {
  for (const path of ['/deviceManagement/groupPolicyObjectFiles', '/deviceManagement/embeddedSIMActivationCodePools',
    '/deviceManagement/resourceAccessProfiles']) {
    assert.equal(CATALOG.filter((entry) => entry.path === path).length, 0, path);
  }
  const hardware = CATALOG.filter((entry) => entry.path === '/deviceManagement/hardwareConfigurations');
  assert.equal(hardware.length, 1);
  assert.ok(hardware[0].select && !hardware[0].select.split(',').includes('configurationFileContent'), 'the BIOS settings file is never read');
});

test('no Intune leftovers type duplicates an existing catalogue path or type', () => {
  const ours = new Set(intuneLeftovers.map((entry) => entry.type));
  const others = CATALOG.filter((entry) => !ours.has(entry.type));
  assert.equal(CATALOG.length, others.length + ours.size, 'each type appears once');
  const otherPaths = new Set(others.map((entry) => `${entry.version}${entry.path}`.toLowerCase()));
  for (const entry of intuneLeftovers) assert.ok(!otherPaths.has(`${entry.version}${entry.path}`.toLowerCase()), entry.type);
});

test('each Intune leftovers type reads a KEEL-RT- fixture with GET only, across pages or as one object', async () => {
  const originalFetch = globalThis.fetch;
  try {
    // The Intune tenant settings are read one field per request (test below).
    for (const [type, endpoint, , shape] of EXPECTED.filter(([type, , , kind]) => kind !== 'per-object' && type !== 'deviceManagementSettings')) {
      const entry = catalogEntryFor(type);
      const first = { id: `${type}-1`, displayName: `KEEL-RT-${type}-1` };
      const second = { id: `${type}-2`, displayName: `KEEL-RT-${type}-2` };
      const nextLink = `https://graph.microsoft.com${endpoint}${endpoint.includes('?') ? '&' : '?'}$skiptoken=page2`;
      const urls = [];
      globalThis.fetch = async (url, opts) => {
        assert.equal(opts.method, 'GET', `${type}: read-only`);
        urls.push(url);
        const body = shape === 'singleton' ? first : urls.length === 1 ? { value: [first], '@odata.nextLink': nextLink } : { value: [second] };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
      };
      const reader = new GraphReader(async () => 'fixture-token');
      const result = await reader.collect(entry.version, catalogReadPath(entry), { pageCap: entry.pageCap ?? Infinity });
      assert.equal(result.error, null, type);
      assert.equal(result.capped, false, type);
      if (shape === 'singleton') {
        assert.deepEqual(urls, [`https://graph.microsoft.com${endpoint}`], `${type}: documented route`);
        assert.deepEqual(result.items, [first], `${type}: the one object kept`);
      } else {
        assert.deepEqual(urls, [`https://graph.microsoft.com${endpoint}`, nextLink], `${type}: documented route, nextLink followed verbatim`);
        assert.deepEqual(result.items, [first, second], `${type}: every page kept`);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the Intune tenant settings are read one field per request and merged into one object (issue #447)', async () => {
  const adapter = get('deviceManagementSettings').adapter;
  const answers = {
    '/deviceManagement?$select=settings': { '@odata.context': 'x(settings)', settings: { secureByDefault: true } },
    '/deviceManagement?$select=managedDeviceCleanupSettings': { '@odata.context': 'x(cleanup)', managedDeviceCleanupSettings: { deviceInactivityBeforeRetirementInDays: '180' } },
  };
  const calls = [];
  const reader = {
    async collect(version, path) {
      calls.push(`/${version}${path}`);
      return { items: [answers[path]], pages: 1, status: 200, capped: false, error: null };
    },
  };
  const raw = await adapter.collectRaw(reader, {});
  assert.deepEqual(calls, ['/beta/deviceManagement?$select=settings', '/beta/deviceManagement?$select=managedDeviceCleanupSettings']);
  assert.equal(raw.error, null);
  assert.equal(raw.pages, 2);
  assert.equal(raw.items.length, 1);
  assert.deepEqual(raw.items[0].settings, { secureByDefault: true });
  assert.deepEqual(raw.items[0].managedDeviceCleanupSettings, { deviceInactivityBeforeRetirementInDays: '180' });

  // One field Graph refuses fails the type; it is never saved half read.
  const refusing = {
    async collect(version, path) {
      if (path.endsWith('managedDeviceCleanupSettings')) return { items: [], pages: 0, status: 400, capped: false, error: { status: 400, error: 'No method match route template' } };
      return { items: [answers[path]], pages: 1, status: 200, capped: false, error: null };
    },
  };
  const failed = await adapter.collectRaw(refusing, {});
  assert.equal(failed.error?.status, 400);
  await assert.rejects(adapter.collect(refusing, {}), /collecting deviceManagementSettings failed/);

  // A 404 after a field was read is a failed read, not an absent singleton.
  const gone = {
    async collect(version, path) {
      if (path.endsWith('managedDeviceCleanupSettings')) return { items: [], pages: 0, status: 404, capped: false, error: { status: 404, error: 'gone' } };
      return { items: [answers[path]], pages: 1, status: 200, capped: false, error: null };
    },
  };
  assert.equal((await adapter.collectRaw(gone, {})).error?.status, 404);
});

test('Windows app protection policies and iOS provisioning profiles are listed, then read on their own (restore gaps batch 12)', async () => {
  for (const [type, list, query, field, value] of [
    ['windowsManagedAppProtection', '/beta/deviceAppManagement/windowsManagedAppProtections', '?$expand=apps', 'apps',
      [{ id: 'a-1', mobileAppIdentifier: { '@odata.type': '#microsoft.graph.windowsAppIdentifier', windowsAppId: 'com.microsoft.edge' } }]],
    ['iosLobAppProvisioningConfiguration', '/beta/deviceAppManagement/iosLobAppProvisioningConfigurations', '', 'payload', 'S0VFTC1SVA=='],
  ]) {
    const entry = catalogEntryFor(type);
    assert.equal(`/${entry.version}${entry.parent.path}`, list, type);
    const urls = [];
    const reader = {
      async collect(version, path) {
        urls.push(`/${version}${path}`);
        if (path.startsWith(`${entry.parent.path}?`)) return { items: [{ id: 'p-1' }, { id: 'p-2' }], pages: 1, status: 200, capped: false, error: null };
        const id = path.split('?')[0].split('/').pop();
        if (id === 'p-2') return { items: [], pages: 0, status: 404, capped: false, error: { status: 404, error: 'gone' } };
        return { items: [{ id, displayName: `KEEL-RT-${type}`, [field]: value }], pages: 1, status: 200, capped: false, error: null };
      },
    };
    const result = await get(type).adapter.collectRaw(reader, {});
    assert.deepEqual(urls, [`${list}?$select=id`, `${list}/p-1${query}`, `${list}/p-2${query}`], `${type}: list, then one GET per object`);
    assert.equal(result.error, null, type);
    // An object deleted between the list and its own read is absent, not a failure.
    assert.deepEqual(result.items, [{ id: 'p-1', displayName: `KEEL-RT-${type}`, [field]: value }], type);
  }
});
