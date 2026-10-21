import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import tenantConnectors from './catalog.d/tenant-connectors.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';

// Independent expectations: the documented Graph route for each type, written
// out here rather than derived from the catalogue under test.
const APNS_SELECT = 'id,appleIdentifier,topicIdentifier,lastModifiedDateTime,expirationDateTime,certificateSerialNumber,certificateUploadStatus,certificateUploadFailureReason';
const EXPECTED = [
  ['applePushNotificationCertificate', `/v1.0/deviceManagement/applePushNotificationCertificate?$select=${APNS_SELECT}`, 'tier2', 'singleton'],
  ['mobileThreatDefenseConnector', '/v1.0/deviceManagement/mobileThreatDefenseConnectors', 'tier2', 'list'],
  ['deviceManagementPartner', '/v1.0/deviceManagement/deviceManagementPartners', 'tier3', 'list'],
  ['complianceManagementPartner', '/v1.0/deviceManagement/complianceManagementPartners', 'tier2', 'list'],
  ['remoteAssistancePartner', '/v1.0/deviceManagement/remoteAssistancePartners', 'tier3', 'list'],
  ['deviceManagementExchangeConnector', '/v1.0/deviceManagement/exchangeConnectors', 'tier3', 'list'],
  ['onPremisesConditionalAccessSettings', '/v1.0/deviceManagement/conditionalAccessSettings', 'tier2', 'singleton'],
  ['mobileAppCategory', '/v1.0/deviceAppManagement/mobileAppCategories', 'tier3', 'list'],
  ['intuneBrandingProfile', '/beta/deviceManagement/intuneBrandingProfiles', 'tier3', 'list'],
  ['customAuthenticationExtension', '/v1.0/identity/customAuthenticationExtensions', 'tier2', 'list'],
];

test('the tenant connectors family holds exactly the planned types, all in CATALOG', () => {
  assert.deepEqual(tenantConnectors.map((entry) => entry.type), EXPECTED.map(([type]) => type));
  for (const [type, , criticality, shape] of EXPECTED) {
    const entry = catalogEntryFor(type);
    assert.ok(entry, `${type} is in CATALOG`);
    assert.equal(entry.criticality, criticality, type);
    assert.ok(['tenant-lockout', 'access-affecting', 'cosmetic'].includes(entry.blastRadius), type);
    assert.equal(entry.singleton === true, shape === 'singleton', `${type} is a ${shape}`);
    // A singleton never set up may answer 404; a list read never hides one.
    assert.equal(entry.absentWhenNotFound === true, shape === 'singleton', type);
    assert.ok(!entry.needsOrgId && !entry.parent, `${type} is read at a fixed path`);
    // A page cap would leave the backup incomplete; these types are read in full.
    assert.equal(entry.pageCap, undefined, type);
  }
});

test('the Apple push certificate read leaves the certificate itself out', () => {
  const entry = catalogEntryFor('applePushNotificationCertificate');
  const fields = entry.select.split(',');
  assert.ok(!fields.includes('certificate'), 'the certificate is never read');
  for (const needed of ['appleIdentifier', 'topicIdentifier', 'expirationDateTime']) assert.ok(fields.includes(needed), needed);
});

test('no tenant connectors type duplicates an existing catalogue path', () => {
  const ours = new Set(tenantConnectors.map((entry) => entry.type));
  const otherPaths = new Set(CATALOG.filter((entry) => !ours.has(entry.type)).map((entry) => `${entry.version}${entry.path}`.toLowerCase()));
  for (const entry of tenantConnectors) assert.ok(!otherPaths.has(`${entry.version}${entry.path}`.toLowerCase()), entry.type);
});

test('each tenant connectors type reads a KEEL-RT- fixture with GET only, across pages or as one object', async () => {
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
