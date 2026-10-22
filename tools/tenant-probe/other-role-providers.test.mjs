import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import otherRoleProviders from './catalog.d/other-role-providers.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';
import { SKIPPED_PATHS } from '../../engine/discovery/notGaps.mjs';

// Independent expectations: the documented Graph route for each type, written
// out here rather than derived from the catalogue under test.
const EXPECTED = [
  ['exchangeRoleDefinition', '/beta/roleManagement/exchange/roleDefinitions', 'tier2'],
  ['exchangeRoleAssignment', '/beta/roleManagement/exchange/roleAssignments', 'tier1'],
  ['exchangeCustomAppScope', '/beta/roleManagement/exchange/customAppScopes', 'tier2'],
  ['defenderRoleDefinition', '/beta/roleManagement/defender/roleDefinitions', 'tier2'],
  ['defenderRoleAssignment', '/beta/roleManagement/defender/roleAssignments', 'tier2'],
  ['defenderCustomAppScope', '/beta/roleManagement/defender/customAppScopes', 'tier2'],
];

test('the other role providers family holds exactly the planned types, all in CATALOG', () => {
  assert.deepEqual(otherRoleProviders.map((entry) => entry.type), EXPECTED.map(([type]) => type));
  for (const [type, , criticality] of EXPECTED) {
    const entry = catalogEntryFor(type);
    assert.ok(entry, `${type} is in CATALOG`);
    assert.equal(entry.criticality, criticality, type);
    assert.equal(entry.blastRadius, 'access-affecting', type);
    assert.ok(!entry.singleton && !entry.absentWhenNotFound, `${type} is a list, and a list read never hides a 404`);
    assert.ok(!entry.needsOrgId && !entry.parent && !entry.query, `${type} is read at a fixed path, unfiltered`);
    // A page cap would leave the backup incomplete; these types are read in full.
    assert.equal(entry.pageCap, undefined, type);
    // None holds a secret, so each object is read whole.
    assert.equal(entry.select, undefined, type);
  }
});

test('no other role providers type duplicates an existing catalogue path or type', () => {
  const ours = new Set(otherRoleProviders.map((entry) => entry.type));
  const others = CATALOG.filter((entry) => !ours.has(entry.type));
  assert.equal(CATALOG.length, others.length + ours.size, 'each type appears once');
  const otherPaths = new Set(others.map((entry) => `${entry.version}${entry.path}`.toLowerCase()));
  for (const entry of otherRoleProviders) assert.ok(!otherPaths.has(`${entry.version}${entry.path}`.toLowerCase()), entry.type);
  // Entitlement management roles are all Microsoft's, so discovery skips them instead.
  assert.equal(SKIPPED_PATHS['/roleManagement/entitlementManagement/roleDefinitions'], 'microsoft-published');
  // Their assignments are read per role, in batch 8; the roles themselves never are.
  assert.deepEqual(CATALOG.filter((entry) => entry.path.startsWith('/roleManagement/entitlementManagement/')).map((entry) => [entry.type, entry.parent?.path]),
    [['entitlementManagementRoleAssignment', '/roleManagement/entitlementManagement/roleDefinitions']]);
});

test('each other role providers type reads KEEL-RT- fixtures with GET only, across every page', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [type, endpoint] of EXPECTED) {
      const entry = catalogEntryFor(type);
      const first = { id: `${type}-1`, displayName: `KEEL-RT-${type}-1` };
      const second = { id: `${type}-2`, displayName: `KEEL-RT-${type}-2` };
      const nextLink = `https://graph.microsoft.com${endpoint}?$skiptoken=page2`;
      const urls = [];
      globalThis.fetch = async (url, opts) => {
        assert.equal(opts.method, 'GET', `${type}: read-only`);
        urls.push(url);
        const body = urls.length === 1 ? { value: [first], '@odata.nextLink': nextLink } : { value: [second] };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
      };
      const reader = new GraphReader(async () => 'fixture-token');
      const result = await reader.collect(entry.version, catalogReadPath(entry), { pageCap: entry.pageCap ?? Infinity });
      assert.equal(result.error, null, type);
      assert.equal(result.capped, false, type);
      assert.deepEqual(urls, [`https://graph.microsoft.com${endpoint}`, nextLink], `${type}: documented route, nextLink followed verbatim`);
      assert.deepEqual(result.items, [first, second], `${type}: every page kept`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
