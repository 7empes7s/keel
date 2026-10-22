import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import intuneLeftovers from './catalog.d/intune-leftovers.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';

// Independent expectations: the documented Graph route for each type, written
// out here rather than derived from the catalogue under test.
const DM_SELECT = 'id,settings,intuneBrand,managedDeviceCleanupSettings';
const OWNER_SELECT = 'id,accountId,configureWifi,createdDateTime,description,deviceNameTemplate,displayName,enrollmentMode,enrollmentTokenType,isTeamsDeviceProfile,lastModifiedDateTime,roleScopeTagIds,tokenCreationDateTime,tokenExpirationDateTime,wifiHidden,wifiSecurityType,wifiSsid';
const WORK_SELECT = 'id,accountId,createdDateTime,description,displayName,lastModifiedDateTime,tokenExpirationDateTime';
const SYMANTEC_SELECT = 'id,expirationDateTime,issuer,issuerName,status,subject,subjectName,uploadDateTime';
const EXPECTED = [
  ['deviceManagementSettings', `/beta/deviceManagement?$select=${DM_SELECT}`, 'tier1', 'singleton'],
  ['androidDeviceOwnerEnrollmentProfile', `/beta/deviceManagement/androidDeviceOwnerEnrollmentProfiles?$select=${OWNER_SELECT}`, 'tier2', 'list'],
  ['androidForWorkEnrollmentProfile', `/beta/deviceManagement/androidForWorkEnrollmentProfiles?$select=${WORK_SELECT}`, 'tier3', 'list'],
  ['appleUserInitiatedEnrollmentProfile', '/beta/deviceManagement/appleUserInitiatedEnrollmentProfiles', 'tier2', 'list'],
  ['androidForWorkSettings', '/beta/deviceManagement/androidForWorkSettings', 'tier3', 'singleton'],
  ['deviceManagementDerivedCredentialSettings', '/beta/deviceManagement/derivedCredentials', 'tier2', 'list'],
  ['microsoftTunnelConfiguration', '/beta/deviceManagement/microsoftTunnelConfigurations', 'tier2', 'list'],
  ['microsoftTunnelHealthThreshold', '/beta/deviceManagement/microsoftTunnelHealthThresholds', 'tier3', 'list'],
  ['iosLobAppProvisioningConfiguration', '/beta/deviceAppManagement/iosLobAppProvisioningConfigurations', 'tier2', 'list'],
  ['mobileAppRelationship', '/beta/deviceAppManagement/mobileAppRelationships', 'tier3', 'list'],
  ['managedEBook', '/beta/deviceAppManagement/managedEBooks', 'tier3', 'list'],
  ['managedEBookCategory', '/beta/deviceAppManagement/managedEBookCategories', 'tier3', 'list'],
  ['cartToClassAssociation', '/beta/deviceManagement/cartToClassAssociations', 'tier3', 'list'],
  ['windowsManagedAppProtection', '/beta/deviceAppManagement/windowsManagedAppProtections', 'tier2', 'list'],
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
    // A singleton never set up may answer 404; a list read never hides one.
    assert.equal(entry.absentWhenNotFound === true, shape === 'singleton', type);
    assert.ok(!entry.needsOrgId && !entry.parent && !entry.query, `${type} is read at a fixed path, unfiltered`);
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
  const dm = fields('deviceManagementSettings');
  assert.ok(dm.includes('settings') && dm.includes('intuneBrand'));
  for (const counter of ['deviceProtectionOverview', 'windowsMalwareOverview', 'connectorStatus', 'subscriptionState']) assert.ok(!dm.includes(counter), counter);
  // Issue #447: a $select naming fields outside the core Intune object sent the
  // whole read to another backend, which answered HTTP 400.
  for (const foreign of ['adminConsent', 'dataProcessorServiceForWindowsFeaturesOnboarding', 'userExperienceAnalyticsSettings',
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
    for (const [type, endpoint, , shape] of EXPECTED) {
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
