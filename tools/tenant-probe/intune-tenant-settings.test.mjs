import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import intuneTenantSettings from './catalog.d/intune-tenant-settings.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';
import { get } from '../../engine/collect/registry.mjs';
import '../../engine/collect/entraAdapter.mjs';

// Independent expectations: the documented Graph route for each type, written
// out here rather than derived from the catalogue under test.
const VPP_SELECT = 'id,organizationName,vppTokenAccountType,appleId,expirationDateTime,lastSyncDateTime,lastModifiedDateTime,state,lastSyncStatus,automaticallyUpdateApps,countryOrRegionCode';
const PLAY_SELECT = 'id,bindStatus,lastAppSyncDateTime,lastAppSyncStatus,ownerUserPrincipalName,ownerOrganizationName,lastModifiedDateTime,enrollmentTarget,targetGroupIds,deviceOwnerManagementEnabled,androidDeviceAdministratorEnrollmentEnabled';
const EXPECTED = [
  ['deviceManagementCompliancePolicy', '/beta/deviceManagement/compliancePolicies?$expand=settings', 'tier1', 'list'],
  ['deviceManagementReusablePolicySetting', '/beta/deviceManagement/reusablePolicySettings', 'tier2', 'list'],
  ['policySet', '/beta/deviceAppManagement/policySets', 'tier3', 'list'],
  ['vppToken', `/v1.0/deviceAppManagement/vppTokens?$select=${VPP_SELECT}`, 'tier2', 'list'],
  ['depOnboardingSetting', '/beta/deviceManagement/depOnboardingSettings', 'tier2', 'list'],
  ['androidManagedStoreAccountEnterpriseSettings', `/beta/deviceManagement/androidManagedStoreAccountEnterpriseSettings?$select=${PLAY_SELECT}`, 'tier2', 'singleton'],
  ['managedDeviceCleanupRule', '/beta/deviceManagement/managedDeviceCleanupRules', 'tier3', 'list'],
  ['windowsQualityUpdatePolicy', '/beta/deviceManagement/windowsQualityUpdatePolicies', 'tier2', 'list'],
  ['operationApprovalPolicy', '/beta/deviceManagement/operationApprovalPolicies', 'tier1', 'list'],
  // Listed, then each script read on its own: Graph returns the body only per script.
  ['deviceCustomAttributeShellScript', '/beta/deviceManagement/deviceCustomAttributeShellScripts', 'tier3', 'per-script'],
];

test('the Intune tenant settings family holds exactly the planned types, all in CATALOG', () => {
  assert.deepEqual(intuneTenantSettings.map((entry) => entry.type), EXPECTED.map(([type]) => type));
  for (const [type, , criticality, shape] of EXPECTED) {
    const entry = catalogEntryFor(type);
    assert.ok(entry, `${type} is in CATALOG`);
    assert.equal(entry.criticality, criticality, type);
    assert.ok(['tenant-lockout', 'access-affecting', 'cosmetic'].includes(entry.blastRadius), type);
    assert.equal(entry.singleton === true, shape === 'singleton', `${type} is a ${shape}`);
    // A singleton never set up, or a script deleted after the list, may answer 404; a list read never hides one.
    assert.equal(entry.absentWhenNotFound === true, shape !== 'list', type);
    assert.ok(!entry.needsOrgId, type);
    assert.equal(Boolean(entry.parent), shape === 'per-script', `${type} is read at a fixed path, or per script`);
    // A page cap would leave the backup incomplete; these types are read in full.
    assert.equal(entry.pageCap, undefined, type);
  }
});

test('token and enrollment code fields are left out of the read', () => {
  const vpp = catalogEntryFor('vppToken').select.split(',');
  assert.ok(!vpp.includes('token'), 'the VPP token is never read');
  for (const needed of ['appleId', 'organizationName', 'expirationDateTime']) assert.ok(vpp.includes(needed), needed);
  const play = catalogEntryFor('androidManagedStoreAccountEnterpriseSettings').select.split(',');
  assert.ok(!play.includes('companyCodes'), 'enrollment tokens and QR codes are never read');
  assert.ok(play.includes('ownerUserPrincipalName'), 'the Google account a rebind needs is kept');
});

test('no Intune tenant settings type duplicates an existing catalogue path or type', () => {
  const ours = new Set(intuneTenantSettings.map((entry) => entry.type));
  const others = CATALOG.filter((entry) => !ours.has(entry.type));
  assert.equal(CATALOG.length, others.length + ours.size, 'each type appears once');
  const otherPaths = new Set(others.map((entry) => `${entry.version}${entry.path}`.toLowerCase()));
  for (const entry of intuneTenantSettings) assert.ok(!otherPaths.has(`${entry.version}${entry.path}`.toLowerCase()), entry.type);
});

test('each Intune tenant settings type reads a KEEL-RT- fixture with GET only, across pages or as one object', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [type, endpoint, , shape] of EXPECTED.filter(([, , , kind]) => kind !== 'per-script')) {
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

test('each macOS custom attribute script is listed, then read on its own so the backup holds its body', async () => {
  const entry = catalogEntryFor('deviceCustomAttributeShellScript');
  const list = '/beta/deviceManagement/deviceCustomAttributeShellScripts';
  assert.equal(`/${entry.version}${entry.parent.path}`, list);
  const urls = [];
  const reader = {
    async collect(version, path) {
      urls.push(`/${version}${path}`);
      if (path.startsWith(`${entry.parent.path}?`)) return { items: [{ id: 's-1' }, { id: 's-2' }], pages: 1, status: 200, capped: false, error: null };
      const id = path.split('/').pop();
      if (id === 's-2') return { items: [], pages: 0, status: 404, capped: false, error: { status: 404, error: 'gone' } };
      return { items: [{ id, displayName: 'KEEL-RT-attribute', scriptContent: 'ZWNobyBLRUVMLVJU' }], pages: 1, status: 200, capped: false, error: null };
    },
  };
  const result = await get('deviceCustomAttributeShellScript').adapter.collectRaw(reader, {});
  assert.deepEqual(urls, [`${list}?$select=id`, `${list}/s-1`, `${list}/s-2`], 'list, then one GET per script');
  assert.equal(result.error, null);
  // A script deleted between the list and its own read is absent, not a failure.
  assert.deepEqual(result.items, [{ id: 's-1', displayName: 'KEEL-RT-attribute', scriptContent: 'ZWNobyBLRUVMLVJU' }]);
});
