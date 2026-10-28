// Security audit run 1, finding 2: a named location restore never changes what
// Conditional Access trusts, and the sign-in path gate reads named locations.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { applyWave } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';
import {
  namedLocationTrustChanges, namedLocationTrustKept, namedLocationTrustRefusal, withoutNamedLocationTrust,
} from './namedLocationTrust.mjs';
import { compareSignInPaths, NAMED_LOCATIONS_PATH, snapshotSignInPath } from '../safety/signInPathGate.mjs';

const IP = '#microsoft.graph.ipNamedLocation';
const COUNTRY = '#microsoft.graph.countryNamedLocation';
const range = (cidrAddress) => ({ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress });
const BREAK_GLASS = 'bg-1';

const liveOffice = Object.freeze({
  '@odata.type': IP, id: 'loc-1', displayName: 'KEEL-RT-Office', isTrusted: false, ipRanges: [range('198.51.100.0/24')],
});

/** One fake tenant the writer and the sign-in path reader share. */
function tenant(locations = [liveOffice]) {
  const store = new Map(locations.map((location) => [location.id, structuredClone(location)]));
  const writes = [];
  let next = 1;
  const writer = {
    async write(_version, path, { method, body }) {
      writes.push({ method, path, body: structuredClone(body) });
      if (method === 'POST') {
        const id = `loc-new-${next++}`;
        store.set(id, { ...structuredClone(body), id });
        return { ok: true, status: 201, body: store.get(id) };
      }
      const id = path.split('/').pop();
      if (method === 'PATCH') store.set(id, { ...store.get(id), ...structuredClone(body) });
      if (method === 'DELETE') store.delete(id);
      return { ok: true, status: 204, body: null };
    },
    async read(_version, path) {
      const item = store.get(path.split('/').pop());
      return item ? { ok: true, status: 200, body: structuredClone(item) } : { ok: false, status: 404, body: null };
    },
  };
  const reader = {
    async collect(_version, path) {
      if (path === NAMED_LOCATIONS_PATH) return { items: [...store.values()].map((item) => structuredClone(item)), capped: false, error: null };
      return { items: [], capped: false, error: null };
    },
    async get(_version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { isEnabled: false } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: BREAK_GLASS, accountEnabled: true } };
      return { ok: false, status: 404 };
    },
  };
  return { store, writes, writer, reader };
}

const governor = () => new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });

const update = (payload, live = liveOffice, extras = {}) => ({
  naturalKey: `namedLocation:${live.displayName}`, resourceType: 'namedLocation', verb: 'update', targetId: live.id,
  blastRadius: 'tenant-lockout', references: [], payload, live: { state: 'present', targetId: live.id, payload: live }, ...extras,
});
const create = (payload) => ({
  naturalKey: `namedLocation:${payload.displayName}`, resourceType: 'namedLocation', verb: 'create',
  blastRadius: 'tenant-lockout', references: [], payload,
});

async function run(graph, resources, mode = 'enforce') {
  return applyWave(graph.writer, governor(), resources, {
    targetTenant: 'target', mode, signInPathGate: { reader: graph.reader, protectedPrincipalIds: [BREAK_GLASS] },
  });
}

test('the audit repro: an update that trusts a wider range is skipped with a manual step and sends nothing', async () => {
  const backup = { '@odata.type': IP, displayName: 'KEEL-RT-Office', isTrusted: true, ipRanges: [range('0.0.0.0/1')] };
  for (const mode of ['dry-run', 'enforce']) {
    const graph = tenant();
    const result = await run(graph, [update(backup)], mode);
    assert.equal(graph.writes.length, 0, mode);
    assert.deepEqual(result.applied, [], mode);
    assert.deepEqual(result.failed, [], mode);
    assert.equal(result.skipped.length, 1, mode);
    const [skip] = result.skipped;
    assert.match(skip.reason, /^manual: .*isTrusted, ipRanges/);
    assert.equal(skip.completion[0].kind, 'manual-setting');
    assert.equal(skip.completion[0].requirement, 'namedLocationTrust');
    assert.deepEqual(skip.completion[0].fields, ['isTrusted', 'ipRanges']);
    assert.deepEqual(graph.store.get('loc-1'), liveOffice, `${mode}: the live location is unchanged`);
  }
});

test('each trust field on its own is withheld: trust, ranges, countries and unknown countries', async () => {
  const country = { '@odata.type': COUNTRY, id: 'loc-2', displayName: 'KEEL-RT-Countries', countriesAndRegions: ['FR'], includeUnknownCountriesAndRegions: false };
  const cases = [
    [update({ ...liveOffice, isTrusted: true }), ['isTrusted']],
    [update({ ...liveOffice, ipRanges: [range('198.51.100.0/24'), range('203.0.113.0/24')] }), ['ipRanges']],
    [update({ ...country, countriesAndRegions: ['FR', 'MA'] }, country), ['countriesAndRegions']],
    [update({ ...country, includeUnknownCountriesAndRegions: true }, country), ['includeUnknownCountriesAndRegions']],
  ];
  for (const [resource, fields] of cases) {
    const graph = tenant([liveOffice, country]);
    const result = await run(graph, [resource]);
    assert.equal(graph.writes.length, 0, fields.join());
    assert.deepEqual(result.skipped[0]?.completion?.[0]?.fields, fields);
  }
});

test('a narrower range is withheld too: live policies that name the location would change', () => {
  const wide = { ...liveOffice, ipRanges: [range('198.51.100.0/24'), range('203.0.113.0/24')] };
  assert.deepEqual(namedLocationTrustChanges(update(liveOffice, wide), 'update'), ['ipRanges']);
});

test('the same ranges in another order, or with other annotations, are not a change', () => {
  const live = { ...liveOffice, ipRanges: [range('198.51.100.0/24'), range('203.0.113.0/24')] };
  const backup = { ...live, ipRanges: [{ cidrAddress: '203.0.113.0/24' }, range('198.51.100.0/24')] };
  assert.deepEqual(namedLocationTrustChanges(update(backup, live), 'update'), []);
  // Graph's defaults: absent, null and false read the same.
  assert.deepEqual(namedLocationTrustChanges(update({ displayName: 'x', isTrusted: false }, { id: 'loc-1', displayName: 'x' }), 'update'), []);
});

test('a rename is written, and the PATCH never carries a trust field', async () => {
  const graph = tenant();
  const backup = { ...liveOffice, displayName: 'KEEL-RT-Office (old name)' };
  delete backup.id;
  const result = await run(graph, [update(backup)]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(graph.writes, [{
    method: 'PATCH', path: '/identity/conditionalAccess/namedLocations/loc-1',
    body: { '@odata.type': IP, displayName: 'KEEL-RT-Office (old name)' },
  }]);
});

test('a trusted location is never created; an untrusted one is', async () => {
  const trusted = { '@odata.type': IP, displayName: 'KEEL-RT-Trusted', isTrusted: true, ipRanges: [range('0.0.0.0/1')] };
  const graph = tenant();
  const refused = await run(graph, [create(trusted)]);
  assert.equal(graph.writes.length, 0);
  assert.match(refused.skipped[0].reason, /^manual: .*never creates a trusted location/);
  assert.deepEqual(refused.skipped[0].completion[0].fields, ['isTrusted']);

  const untrusted = { ...trusted, displayName: 'KEEL-RT-Branch', isTrusted: false };
  const created = await run(graph, [create(untrusted)]);
  assert.deepEqual(created.failed, [], 'a new untrusted location passes the closing sign-in path comparison');
  assert.equal(created.applied.length, 1);
  assert.equal(graph.writes[0].method, 'POST');
});

test('a compliance fix changes exactly its one declared setting, and nothing else gets through with it', async () => {
  const live = { '@odata.type': COUNTRY, id: 'loc-3', displayName: 'KEEL-RT-Anywhere', isTrusted: true, countriesAndRegions: ['FR'], includeUnknownCountriesAndRegions: true };
  const fix = { controlId: 'c', resourceType: 'namedLocation', naturalKey: 'namedLocation:KEEL-RT-Anywhere', targetId: 'loc-3', field: 'includeUnknownCountriesAndRegions', from: true, to: false };
  const fixed = { ...live, includeUnknownCountriesAndRegions: false };

  const graph = tenant([live]);
  const result = await run(graph, [update(fixed, live, { complianceFix: fix })]);
  assert.deepEqual(result.failed, [], 'the closing comparison expects the fixed setting');
  assert.equal(result.applied.length, 1);
  assert.deepEqual(graph.writes[0].body, { '@odata.type': COUNTRY, displayName: 'KEEL-RT-Anywhere', includeUnknownCountriesAndRegions: false });

  assert.ok(namedLocationTrustRefusal(update({ ...fixed, countriesAndRegions: ['FR', 'US'] }, live, { complianceFix: fix }), 'update'), 'a second trust change');
  assert.ok(namedLocationTrustRefusal(update({ ...fixed, includeUnknownCountriesAndRegions: true, isTrusted: false }, live, { complianceFix: fix }), 'update'), 'another field than the fix');
  assert.ok(namedLocationTrustRefusal(update(fixed, live, { complianceFix: { ...fix, to: true } }), 'update'), 'a value other than the declared one');
  assert.ok(namedLocationTrustRefusal(update(fixed, live, { complianceFix: { ...fix, resourceType: 'group' } }), 'update'), 'a fix for another type');
});

test('other resource types are not touched by the named location gate', () => {
  const group = { resourceType: 'group', payload: { isTrusted: true, ipRanges: [] }, live: { payload: {} } };
  assert.equal(namedLocationTrustRefusal(group, 'update'), null);
  assert.deepEqual(withoutNamedLocationTrust({ isTrusted: true }, group), { isTrusted: true });
});

test('the sign-in path snapshot reads named locations, so a trust change fails the comparison', async () => {
  const graph = tenant();
  const before = await snapshotSignInPath(graph.reader, { protectedPrincipalIds: [BREAK_GLASS] });
  assert.equal(before.namedLocations.length, 1);
  graph.store.set('loc-1', { ...liveOffice, isTrusted: true });
  const after = await snapshotSignInPath(graph.reader, { protectedPrincipalIds: [BREAK_GLASS] });
  assert.deepEqual(compareSignInPaths(before, after), { allowed: false, reason: 'sign-in path changed: namedLocations', changed: ['namedLocations'] });
});

test('the closing comparison still fails when a written location reads back trusting something else', async () => {
  const graph = tenant();
  // A tenant that turns trust on behind the restore's back.
  const write = graph.writer.write;
  graph.writer.write = async (version, path, request) => {
    const result = await write(version, path, request);
    graph.store.set('loc-1', { ...graph.store.get('loc-1'), isTrusted: true });
    return result;
  };
  const backup = { ...liveOffice, displayName: 'KEEL-RT-Office (old name)' };
  const result = await run(graph, [update(backup)]);
  assert.ok(result.failed.some((entry) => entry.naturalKey === 'sign-in-path-gate' && /namedLocations/.test(entry.error)), JSON.stringify(result.failed));
});

test('namedLocationTrustKept: unchanged trust, a new untrusted location, and the fix setting', () => {
  assert.equal(namedLocationTrustKept(liveOffice, { ...liveOffice, displayName: 'renamed' }), true);
  assert.equal(namedLocationTrustKept(liveOffice, { ...liveOffice, isTrusted: true }), false);
  assert.equal(namedLocationTrustKept(null, { ...liveOffice, id: 'new' }), true);
  assert.equal(namedLocationTrustKept(null, { ...liveOffice, id: 'new', isTrusted: true }), false);
  assert.equal(namedLocationTrustKept(liveOffice, null), false);
  const fix = { field: 'includeUnknownCountriesAndRegions', to: false };
  assert.equal(namedLocationTrustKept({ ...liveOffice, includeUnknownCountriesAndRegions: true }, liveOffice, fix), true);
  assert.equal(namedLocationTrustKept({ ...liveOffice, includeUnknownCountriesAndRegions: true }, { ...liveOffice, isTrusted: true }, fix), false);
});
