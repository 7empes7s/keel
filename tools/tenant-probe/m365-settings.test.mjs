import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import m365Settings from './catalog.d/m365-settings.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';
import { WORKLOAD_GRAPH_PATHS, catalogedGraphPaths, skippedGraphPaths } from '../../engine/discovery/catalogue.mjs';

// Independent expectations: the documented Graph route for each type, written
// out here rather than derived from the catalogue under test.
const SIMULATION_SELECT = 'id,attackTechnique,attackType,automationId,completionDateTime,createdBy,createdDateTime,description,displayName,durationInDays,endUserNotificationSetting,excludedAccountTarget,includedAccountTarget,isAutomated,lastModifiedBy,lastModifiedDateTime,launchDateTime,oAuthConsentAppDetail,payloadDeliveryPlatform,status,trainingSetting';
const EXPECTED = [
  ['sharepointSettings', '/v1.0/admin/sharepoint/settings', 'tier1', 'singleton'],
  ['itemInsightsSettings', '/v1.0/admin/people/itemInsights', 'tier3', 'singleton'],
  ['externalConnection', '/v1.0/external/connections', 'tier3', 'list'],
  ['simulationAutomation', '/v1.0/security/attackSimulation/simulationAutomations', 'tier3', 'list'],
  ['attackSimulation', `/v1.0/security/attackSimulation/simulations?$select=${SIMULATION_SELECT}`, 'tier3', 'list'],
];

test('the Microsoft 365 settings family holds exactly the planned types, all in CATALOG', () => {
  assert.deepEqual(m365Settings.map((entry) => entry.type), EXPECTED.map(([type]) => type));
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

test('simulation results are left out of the read, and no type reads a secret', () => {
  const fields = catalogEntryFor('attackSimulation').select.split(',');
  assert.ok(!fields.includes('report'), 'who clicked is results, not settings');
  for (const needed of ['displayName', 'attackTechnique', 'includedAccountTarget', 'trainingSetting']) assert.ok(fields.includes(needed), needed);
  for (const entry of m365Settings) assert.ok(!/password|token|secret|key/i.test(`${entry.path} ${entry.select ?? ''}`), entry.type);
});

test('no Microsoft 365 settings type duplicates an existing catalogue path or type', () => {
  const ours = new Set(m365Settings.map((entry) => entry.type));
  const others = CATALOG.filter((entry) => !ours.has(entry.type));
  assert.equal(CATALOG.length, others.length + ours.size, 'each type appears once');
  const otherPaths = new Set(others.map((entry) => `${entry.version}${entry.path}`.toLowerCase()));
  for (const entry of m365Settings) assert.ok(!otherPaths.has(`${entry.version}${entry.path}`.toLowerCase()), entry.type);
});

test('discovery counts Graph sensitivity labels as the Purview label backup, and skips Teams status and Purview policy files', () => {
  const catalogued = catalogedGraphPaths();
  for (const path of ['/security/informationProtection/sensitivityLabels', '/security/informationProtection/labelPolicySettings',
    '/informationProtection/policy/labels', '/dataClassification/sensitivityLabels']) {
    assert.equal(WORKLOAD_GRAPH_PATHS[path], 'purview-labels', path);
    assert.deepEqual(catalogued.get(path.toLowerCase()).map((entry) => entry.source), ['workload'], path);
    // Not read a second time through Graph.
    assert.equal(CATALOG.filter((entry) => entry.path.toLowerCase() === path.toLowerCase()).length, 0, path);
  }
  assert.equal(catalogued.get('/admin/sharepoint/settings')[0].type, 'sharepointSettings');
  const skipped = skippedGraphPaths();
  assert.equal(skipped.get('/teamwork'), 'not-configuration');
  assert.equal(skipped.get('/security/datasecurityandgovernance/policyfiles'), 'not-configuration');
  for (const path of ['/admin/people/itemInsights', '/external/connections', '/security/attackSimulation/simulations',
    '/security/attackSimulation/simulationAutomations']) {
    assert.ok(!skipped.has(path.toLowerCase()), `${path} is backed up, not skipped`);
  }
});

test('each Microsoft 365 settings type reads a KEEL-RT- fixture with GET only, across pages or as one object', async () => {
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
