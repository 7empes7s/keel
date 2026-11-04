import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import family from './catalog.d/attack-simulation-content.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';
import { skippedGraphPaths } from '../../engine/discovery/catalogue.mjs';
import { typeInfo } from '../../engine/insights/taxonomy.mjs';

// Independent expectations: the documented Graph route for each type (Microsoft Learn,
// "List payloads", "List loginPages", "List landingPages", "List endUserNotifications"),
// written out here rather than derived from the catalogue under test.
const TENANT = "$filter=source eq 'tenant'";
const EXPECTED = [
  ['attackSimulationPayload', `/v1.0/security/attackSimulation/payloads?${TENANT}`],
  ['attackSimulationLoginPage', `/v1.0/security/attackSimulation/loginPages?${TENANT}`],
  ['attackSimulationLandingPage', `/v1.0/security/attackSimulation/landingPages?${TENANT}`],
  ['attackSimulationNotification', `/v1.0/security/attackSimulation/endUserNotifications?${TENANT}`],
];

test('the attack simulation content family holds exactly the planned types, tenant items only, in CATALOG', () => {
  assert.deepEqual(family.map((entry) => entry.type), EXPECTED.map(([type]) => type));
  for (const [type, endpoint] of EXPECTED) {
    const entry = catalogEntryFor(type);
    assert.ok(entry, `${type} is in CATALOG`);
    assert.equal(`/${entry.version}${catalogReadPath(entry)}`, endpoint, type);
    assert.equal(entry.criticality, 'tier3', type);
    assert.equal(entry.blastRadius, 'cosmetic', type);
    assert.ok(!entry.singleton && !entry.parent && entry.pageCap === undefined, `${type} is a full list read`);
  }
  // Each type appears once, and no path is read twice.
  assert.equal(new Set(CATALOG.map((entry) => entry.type)).size, CATALOG.length);
  const paths = CATALOG.map((entry) => `${entry.version}${entry.path}`.toLowerCase());
  assert.equal(new Set(paths).size, paths.length);
  // Microsoft's training modules stay skipped; these lists are not.
  const skipped = skippedGraphPaths();
  assert.equal(skipped.get('/security/attacksimulation/trainings'), 'not-configuration');
  for (const entry of family) assert.ok(!skipped.has(entry.path.toLowerCase()), entry.path);
});

test('the content sits in the Defender attack simulation group, after the simulations that use it', () => {
  const simulation = typeInfo('attackSimulation');
  let previous = typeInfo('simulationAutomation').typeRank;
  for (const [type] of EXPECTED) {
    const info = typeInfo(type);
    assert.deepEqual([info.service, info.categoryName, info.known], ['Defender', simulation.categoryName, true], type);
    assert.ok(info.typeRank > previous, `${type} after the one before it`);
    previous = info.typeRank;
  }
});

test('each type reads a KEEL-RT- fixture with GET only, following nextLink', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [type, endpoint] of EXPECTED) {
      const entry = catalogEntryFor(type);
      const first = { id: `${type}-1`, displayName: `KEEL-RT-${type}-1`, source: 'tenant' };
      const second = { id: `${type}-2`, displayName: `KEEL-RT-${type}-2`, source: 'tenant' };
      const urls = [];
      const nextLink = `https://graph.microsoft.com${endpoint}&$skiptoken=page2`;
      globalThis.fetch = async (url, opts) => {
        assert.equal(opts.method, 'GET', `${type}: read-only`);
        urls.push(url);
        const body = urls.length === 1 ? { value: [first], '@odata.nextLink': nextLink } : { value: [second] };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
      };
      const reader = new GraphReader(async () => 'fixture-token');
      const result = await reader.collect(entry.version, catalogReadPath(entry), { pageCap: Infinity });
      assert.equal(result.error, null, type);
      assert.equal(urls.length, 2, type);
      assert.ok(decodeURIComponent(urls[0]).includes("source eq 'tenant'"), `${type}: only the tenant's own items`);
      assert.equal(urls[1], nextLink, type);
      assert.deepEqual(result.items, [first, second], `${type}: every page kept`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
