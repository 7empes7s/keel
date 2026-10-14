import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import intuneExtended from './catalog.d/intune-extended.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';

// Independent expectations: the documented Graph route for each type, written
// out here rather than derived from the catalogue under test.
const EXPECTED = [
  ['deviceManagementScript', '/beta/deviceManagement/deviceManagementScripts', 'tier2'],
  ['deviceShellScript', '/beta/deviceManagement/deviceShellScripts', 'tier2'],
  ['deviceHealthScript', '/beta/deviceManagement/deviceHealthScripts', 'tier2'],
  ['deviceComplianceScript', '/beta/deviceManagement/deviceComplianceScripts', 'tier2'],
  ['assignmentFilter', '/beta/deviceManagement/assignmentFilters', 'tier2'],
  ['roleScopeTag', '/beta/deviceManagement/roleScopeTags', 'tier2'],
  ['windowsFeatureUpdateProfile', '/beta/deviceManagement/windowsFeatureUpdateProfiles', 'tier2'],
  ['windowsQualityUpdateProfile', '/beta/deviceManagement/windowsQualityUpdateProfiles', 'tier2'],
  ['windowsDriverUpdateProfile', '/beta/deviceManagement/windowsDriverUpdateProfiles', 'tier3'],
  ['groupPolicyConfiguration', '/beta/deviceManagement/groupPolicyConfigurations?$expand=definitionValues($expand=definition)', 'tier2'],
  ['groupPolicyUploadedDefinitionFile', '/beta/deviceManagement/groupPolicyUploadedDefinitionFiles', 'tier3'],
  ['notificationMessageTemplate', '/v1.0/deviceManagement/notificationMessageTemplates?$expand=localizedNotificationMessages', 'tier3'],
  ['windowsAutopilotDeviceIdentity', '/v1.0/deviceManagement/windowsAutopilotDeviceIdentities', 'tier2'],
  ['deviceManagementRoleAssignment', '/beta/deviceManagement/roleAssignments', 'tier1'],
];

test('the extended Intune family holds exactly the planned types, all in CATALOG', () => {
  assert.deepEqual(intuneExtended.map((entry) => entry.type), EXPECTED.map(([type]) => type));
  for (const [type, , criticality] of EXPECTED) {
    const entry = catalogEntryFor(type);
    assert.ok(entry, `${type} is in CATALOG`);
    assert.equal(entry.criticality, criticality, type);
    assert.ok(['tenant-lockout', 'access-affecting', 'cosmetic'].includes(entry.blastRadius), type);
    assert.ok(!entry.singleton && !entry.needsOrgId, `${type} is a plain collection`);
    // A page cap would leave the backup incomplete; these types are read in full.
    assert.equal(entry.pageCap, undefined, type);
  }
});

test('no extended Intune type duplicates an existing catalogue path', () => {
  const ours = new Set(intuneExtended.map((entry) => entry.type));
  const otherPaths = new Set(CATALOG.filter((entry) => !ours.has(entry.type)).map((entry) => `${entry.version}${entry.path}`));
  for (const entry of intuneExtended) assert.ok(!otherPaths.has(`${entry.version}${entry.path}`), entry.type);
});

test('each extended Intune type reads a KEEL-RT- fixture with GET only, across pages', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [type, endpoint] of EXPECTED) {
      const entry = catalogEntryFor(type);
      const first = { id: `${type}-1`, displayName: `KEEL-RT-${type}-1` };
      const second = { id: `${type}-2`, displayName: `KEEL-RT-${type}-2` };
      const nextLink = `https://graph.microsoft.com${endpoint}${endpoint.includes('?') ? '&' : '?'}$skiptoken=page2`;
      const urls = [];
      globalThis.fetch = async (url, opts) => {
        assert.equal(opts.method, 'GET', `${type}: read-only`);
        urls.push(url);
        const body = urls.length === 1 ? { value: [first], '@odata.nextLink': nextLink } : { value: [second] };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
      };
      const reader = new GraphReader(async () => 'fixture-token');
      const result = await reader.collect(entry.version, catalogReadPath(entry), {
        pageCap: entry.pageCap ?? Infinity,
        ...(entry.acceptLanguage ? { acceptLanguage: entry.acceptLanguage } : {}),
      });
      assert.deepEqual(urls, [`https://graph.microsoft.com${endpoint}`, nextLink], `${type}: documented route, nextLink followed verbatim`);
      assert.equal(result.error, null, type);
      assert.equal(result.capped, false, type);
      assert.deepEqual(result.items, [first, second], `${type}: every page kept`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
