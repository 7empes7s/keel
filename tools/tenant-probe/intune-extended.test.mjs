import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import intuneExtended from './catalog.d/intune-extended.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';
import { get } from '../../engine/collect/registry.mjs';
import '../../engine/collect/entraAdapter.mjs';

// Independent expectations: the documented Graph route for each type, written
// out here rather than derived from the catalogue under test.
// Scripts are listed, then each is read on its own: Graph returns the script
// body only on a GET of one script.
const SCRIPTS = [
  ['deviceManagementScript', '/beta/deviceManagement/deviceManagementScripts', 'scriptContent'],
  ['deviceShellScript', '/beta/deviceManagement/deviceShellScripts', 'scriptContent'],
  ['deviceHealthScript', '/beta/deviceManagement/deviceHealthScripts', 'detectionScriptContent'],
  ['deviceComplianceScript', '/beta/deviceManagement/deviceComplianceScripts', 'detectionScriptContent'],
];

const LISTED = [
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

const EXPECTED = [...SCRIPTS.map(([type, list]) => [type, list, 'tier2']), ...LISTED];

test('the extended Intune family holds exactly the planned types, all in CATALOG', () => {
  assert.deepEqual(intuneExtended.map((entry) => entry.type), EXPECTED.map(([type]) => type));
  for (const [type, , criticality] of EXPECTED) {
    const entry = catalogEntryFor(type);
    assert.ok(entry, `${type} is in CATALOG`);
    assert.equal(entry.criticality, criticality, type);
    assert.ok(['tenant-lockout', 'access-affecting', 'cosmetic'].includes(entry.blastRadius), type);
    assert.ok(!entry.singleton && !entry.needsOrgId, `${type} is a collection`);
    // A page cap would leave the backup incomplete; these types are read in full.
    assert.equal(entry.pageCap, undefined, type);
  }
});

test('no extended Intune type duplicates an existing catalogue path', () => {
  const ours = new Set(intuneExtended.map((entry) => entry.type));
  const otherPaths = new Set(CATALOG.filter((entry) => !ours.has(entry.type)).map((entry) => `${entry.version}${entry.path}`));
  for (const entry of intuneExtended) assert.ok(!otherPaths.has(`${entry.version}${entry.path}`), entry.type);
});

test('each script is listed, then read on its own so the backup holds its body', async () => {
  for (const [type, list, body] of SCRIPTS) {
    const entry = catalogEntryFor(type);
    assert.equal(`/${entry.version}${entry.parent.path}`, list, type);
    const urls = [];
    const reader = {
      async collect(version, path) {
        urls.push(`/${version}${path}`);
        if (path.startsWith(entry.parent.path + '?')) return { items: [{ id: 's-1' }, { id: 's-2' }], pages: 1, status: 200, capped: false, error: null };
        const id = path.split('/').pop();
        if (id === 's-2') return { items: [], pages: 0, status: 404, capped: false, error: { status: 404, error: 'gone' } };
        return { items: [{ id, displayName: `KEEL-RT-${type}`, [body]: 'ZWNobyBLRUVMLVJU' }], pages: 1, status: 200, capped: false, error: null };
      },
    };
    const result = await get(type).adapter.collectRaw(reader, {});
    assert.deepEqual(urls, [`${list}?$select=id`, `${list}/s-1`, `${list}/s-2`], `${type}: list, then one GET per script`);
    assert.equal(result.error, null, type);
    // A script deleted between the list and its own read is absent, not a failure.
    assert.deepEqual(result.items, [{ id: 's-1', displayName: `KEEL-RT-${type}`, [body]: 'ZWNobyBLRUVMLVJU' }], `${type}: the payload is the script as Graph returns it`);
  }
});

test('each extended Intune type reads a KEEL-RT- fixture with GET only, across pages', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [type, endpoint] of LISTED) {
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
