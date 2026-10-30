import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import defenderXdr from './catalog.d/defender-xdr.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';
import { missingGrant } from '../../engine/discovery/grants.mjs';
import { SKIPPED_PATHS } from '../../engine/discovery/notGaps.mjs';
import { KEEL_PERMISSIONS } from '../../engine/bootstrap/permissionCatalog.mjs';
import { qualificationFor } from '../../engine/coverage/qualification.mjs';
import { typeInfo } from '../../engine/insights/taxonomy.mjs';
import { fieldClass } from '../../engine/cir/serverOwned.mjs';
import { naturalKeyFor } from '../../engine/cir/naturalKey.mjs';

// Independent expectations (baselines gap audit, section E), written out from the
// Microsoft Learn pages for each route rather than derived from the catalogue.
// Neither route documents $select, so each is read whole.
const SENSORS = '/v1.0/security/identities/sensors';
const CONTROLS = '/v1.0/security/secureScoreControlProfiles';
const EXPECTED = [
  ['defenderIdentitySensor', SENSORS, 'SecurityIdentitiesSensors.Read.All'],
  ['secureScoreControlProfile', CONTROLS, 'SecurityEvents.Read.All'],
];
const pathOf = (endpoint) => endpoint.replace(/^\/(v1\.0|beta)/, '').split('?')[0];

test('the Defender XDR family holds exactly the planned list reads, all in CATALOG', () => {
  assert.deepEqual(defenderXdr.map((entry) => entry.type), EXPECTED.map(([type]) => type));
  for (const [type, endpoint] of EXPECTED) {
    const entry = catalogEntryFor(type);
    assert.ok(entry, `${type} is in CATALOG`);
    assert.equal(`/${entry.version}${catalogReadPath(entry)}`, endpoint, `${type}: documented route`);
    assert.ok(!entry.singleton && !entry.parent && entry.pageCap === undefined, `${type}: a full list read`);
  }
});

test('only what an admin sets counts as a change: health and Microsoft text are server owned', () => {
  for (const field of ['healthStatus', 'deploymentStatus', 'serviceStatus', 'version', 'openHealthIssuesCount']) {
    assert.equal(fieldClass(field, 'defenderIdentitySensor'), 'serverOwned', field);
  }
  for (const field of ['displayName', 'domainName', 'sensorType', 'settings']) assert.equal(fieldClass(field, 'defenderIdentitySensor'), 'writable', field);
  for (const field of ['title', 'maxScore', 'rank', 'remediation', 'userImpact', 'implementationCost', 'threats', 'deprecated']) {
    assert.equal(fieldClass(field, 'secureScoreControlProfile'), 'serverOwned', field);
  }
  assert.equal(fieldClass('controlStateUpdates', 'secureScoreControlProfile'), 'writable');
  for (const entry of defenderXdr) assert.equal(entry.select, undefined, `${entry.type}: no undocumented $select`);
  // The control states are configuration now, so discovery no longer skips the path.
  assert.equal(SKIPPED_PATHS['/security/secureScoreControlProfiles'], undefined);
});

test('no path duplicates another catalogue entry, and none reads a secret', () => {
  const ours = new Set(defenderXdr.map((entry) => entry.type));
  const otherPaths = new Set(CATALOG.filter((entry) => !ours.has(entry.type)).map((entry) => `${entry.version}${entry.path}`.toLowerCase()));
  for (const entry of defenderXdr) {
    assert.ok(!otherPaths.has(`${entry.version}${entry.path}`.toLowerCase()), entry.type);
    assert.ok(!/password|token|secret|key/i.test(`${entry.path} ${entry.select ?? ''}`), entry.type);
  }
});

test('a refused read names the permission, and the setup page lists it for the backup reader', () => {
  const collector = new Set(KEEL_PERMISSIONS.filter((entry) => entry.identity === 'collector').map((entry) => entry.name));
  for (const [type, endpoint, grant] of EXPECTED) {
    assert.deepEqual(missingGrant(pathOf(endpoint), 'Forbidden', []), { grant, source: 'documented', held: false }, type);
    assert.ok(collector.has(grant), `${grant} is listed for the backup reader`);
  }
});

test('each kind is restored by hand, named, placed under Defender and keyed by id', () => {
  for (const [type] of EXPECTED) {
    assert.equal(qualificationFor(type).decision, 'manual', type);
    const info = typeInfo(type);
    assert.deepEqual([info.known, info.service], [true, 'Defender'], type);
    assert.notEqual(info.category, 'other', type);
  }
  assert.equal(typeInfo('defenderIdentitySensor').categoryName, 'Sensors and coverage');
  assert.equal(typeInfo('secureScoreControlProfile').categoryName, 'Exposure management');
  assert.equal(naturalKeyFor('secureScoreControlProfile', { id: 'AdminMFAV2', title: 'Ensure multifactor authentication is enabled' }), 'AdminMFAV2');
  assert.equal(naturalKeyFor('defenderIdentitySensor', { id: 'sensor-1', displayName: 'KEEL-RT-DC01' }), 'sensor-1');
});

test('each kind reads a KEEL-RT- fixture with GET only, across pages', async () => {
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
      const result = await new GraphReader(async () => 'fixture-token').collect(entry.version, catalogReadPath(entry), { pageCap: Infinity });
      assert.equal(result.error, null, type);
      assert.deepEqual(urls, [`https://graph.microsoft.com${endpoint}`, nextLink], type);
      assert.deepEqual(result.items, [first, second], type);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
