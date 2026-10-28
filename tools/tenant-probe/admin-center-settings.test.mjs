import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import adminCenterSettings from './catalog.d/admin-center-settings.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';
import { missingGrant } from '../../engine/discovery/grants.mjs';
import { KEEL_PERMISSIONS } from '../../engine/bootstrap/permissionCatalog.mjs';
import { qualificationFor } from '../../engine/coverage/qualification.mjs';
import { typeInfo } from '../../engine/insights/taxonomy.mjs';
import { naturalKeyFor } from '../../engine/cir/naturalKey.mjs';

// Independent expectations: the documented Graph route for each type and the read
// permission the 2026-10-22 probe (operator queue Q151) found missing, written out
// here rather than derived from the catalogue under test.
const TEAMS_APPS = "/v1.0/appCatalogs/teamsApps?$filter=distributionMethod eq 'organization'&$expand=appDefinitions";
const EXPECTED = [
  ['formsSettings', '/beta/admin/forms', 'singleton', 'OrgSettings-Forms.Read.All'],
  ['todoSettings', '/beta/admin/todo', 'singleton', 'OrgSettings-Todo.Read.All'],
  ['microsoft365AppsInstallationOptions', '/v1.0/admin/microsoft365Apps/installationOptions', 'singleton', 'OrgSettings-Microsoft365Install.Read.All'],
  ['appsAndServicesSettings', '/beta/admin/appsAndServices', 'singleton', 'OrgSettings-AppsAndServices.Read.All'],
  ['adminReportSettings', '/v1.0/admin/reportSettings', 'singleton', 'ReportSettings.Read.All'],
  ['profileCardProperty', '/v1.0/admin/people/profileCardProperties', 'list', 'PeopleSettings.Read.All'],
  ['pronounsSettings', '/v1.0/admin/people/pronouns', 'singleton', 'PeopleSettings.Read.All'],
  ['defenderDetectionRule', '/beta/security/rules/detectionRules', 'list', 'CustomDetection.Read.All'],
  ['teamsCatalogApp', TEAMS_APPS, 'list', 'AppCatalog.Read.All'],
  ['engageCommunity', '/v1.0/employeeExperience/communities', 'list', 'Community.Read.All'],
];
const pathOf = (endpoint) => endpoint.replace(/^\/(v1\.0|beta)/, '').split('?')[0];

test('the admin center settings family holds exactly the planned types, all in CATALOG', () => {
  assert.deepEqual(adminCenterSettings.map((entry) => entry.type), EXPECTED.map(([type]) => type));
  for (const [type, , shape] of EXPECTED) {
    const entry = catalogEntryFor(type);
    assert.ok(entry, `${type} is in CATALOG`);
    assert.ok(['tier1', 'tier2', 'tier3'].includes(entry.criticality), type);
    assert.ok(['tenant-lockout', 'access-affecting', 'cosmetic'].includes(entry.blastRadius), type);
    assert.equal(entry.singleton === true, shape === 'singleton', `${type} is a ${shape}`);
    // A singleton never set up may answer 404; a list read never hides one.
    assert.equal(entry.absentWhenNotFound === true, shape === 'singleton', type);
    assert.ok(!entry.needsOrgId && !entry.parent, `${type} is read at a fixed path`);
    assert.equal(entry.pageCap, undefined, `${type} is read in full`);
  }
  // A detection rule can isolate devices or disable users on its own.
  assert.equal(catalogEntryFor('defenderDetectionRule').criticality, 'tier2');
});

test('no type duplicates an existing catalogue path or type, and none reads a secret', () => {
  const ours = new Set(adminCenterSettings.map((entry) => entry.type));
  const others = CATALOG.filter((entry) => !ours.has(entry.type));
  assert.equal(CATALOG.length, others.length + ours.size, 'each type appears once');
  const otherPaths = new Set(others.map((entry) => `${entry.version}${entry.path}`.toLowerCase()));
  for (const entry of adminCenterSettings) {
    assert.ok(!otherPaths.has(`${entry.version}${entry.path}`.toLowerCase()), entry.type);
    assert.ok(!/password|token|secret|key/i.test(`${entry.path} ${entry.select ?? ''} ${entry.query ?? ''}`), entry.type);
  }
});

test('a refused read names the permission the probe found missing, and the setup page lists it for the backup reader', () => {
  const collector = new Set(KEEL_PERMISSIONS.filter((entry) => entry.identity === 'collector').map((entry) => entry.name));
  for (const [type, endpoint, , grant] of EXPECTED) {
    // Graph often answers these with a 403 that names nothing ("UnknownError").
    assert.deepEqual(missingGrant(pathOf(endpoint), 'Forbidden', []), { grant, source: 'documented', held: false }, type);
    assert.equal(missingGrant(pathOf(endpoint), 'Forbidden', [grant]).held, true, `${type}: held once granted`);
    assert.ok(collector.has(grant), `${grant} is listed for the backup reader`);
  }
  // A longer prefix still wins over the area's usual permission.
  assert.equal(missingGrant('/security/alerts_v2', '', null).grant, 'SecurityEvents.Read.All');
  assert.equal(missingGrant('/admin/sharepoint/settings', '', null).grant, 'SharePointTenantSettings.Read.All');
});

test('each type is backed up only (manual restore), named, placed in its service group, and keyed', () => {
  for (const [type] of EXPECTED) {
    assert.equal(qualificationFor(type).decision, 'manual', type);
    const info = typeInfo(type);
    assert.equal(info.known, true, `${type} has a plain name`);
    assert.notEqual(info.category, 'other', `${type} sits in a group`);
  }
  assert.equal(typeInfo('defenderDetectionRule').service, 'Defender');
  assert.equal(typeInfo('teamsCatalogApp').service, 'Teams');
  assert.equal(naturalKeyFor('formsSettings', { id: 'forms' }), 'formsSettings');
  assert.equal(naturalKeyFor('profileCardProperty', { id: 'x', directoryPropertyName: 'customAttribute1' }), 'customAttribute1');
  assert.equal(naturalKeyFor('engageCommunity', { id: 'community-1', displayName: 'Same name' }), 'community-1');
});

test('each type reads a KEEL-RT- fixture with GET only, across pages or as one object', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [type, endpoint, shape] of EXPECTED) {
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

test('a read refused for the missing permission is reported as an error, not as an empty backup', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: false, status: 403, headers: { get: () => null },
      json: async () => ({ error: { code: 'Forbidden', message: 'Missing application roles. API required roles: CustomDetection.ReadWrite.All,CustomDetection.Read.All' } }),
      text: async () => '{"error":{"code":"Forbidden"}}',
    });
    const entry = catalogEntryFor('defenderDetectionRule');
    const result = await new GraphReader(async () => 'fixture-token').collect(entry.version, catalogReadPath(entry), { pageCap: Infinity });
    assert.notEqual(result.error, null);
    assert.deepEqual(result.items ?? [], []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
