// Live Q45 (2026-10-13, test tenant): a namedLocation update was demoted because
// its PATCH body dropped @odata.type and Graph answered 400 "1042: Unexpected
// type: namedLocationType". The same PATCH with @odata.type returned 204. The
// update body now keeps @odata.type for namedLocation, at every depth, and still
// drops every other annotation and server-owned field.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { UPDATE_KEEPS_ODATA_TYPE, writableProjection } from '../reconcile/writableProjection.mjs';
import { applyWave } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';

const governor = new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });

const snapshot = Object.freeze({
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#identity/conditionalAccess/namedLocations/$entity',
  '@odata.type': '#microsoft.graph.ipNamedLocation',
  id: 'loc-1',
  createdDateTime: '2025-01-01T00:00:00Z',
  modifiedDateTime: '2025-02-01T00:00:00Z',
  displayName: 'HQ',
  isTrusted: true,
  ipRanges: [{ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '203.0.113.0/24' }],
});

// Behaves like Graph for the named location route: a PATCH without the derived
// type (top level, or on an ipRanges entry) is the live 400; otherwise 204.
function namedLocationGraph(live) {
  const calls = [];
  let object = { ...live };
  return {
    calls,
    write: async (version, path, opts) => {
      calls.push({ path, opts });
      const body = opts.body ?? {};
      const untypedRange = (body.ipRanges ?? []).some((range) => typeof range?.['@odata.type'] !== 'string');
      if (typeof body['@odata.type'] !== 'string' || untypedRange) {
        return { ok: false, status: 400, body: { error: { code: '1042', message: '1042: Unexpected type: namedLocationType' } } };
      }
      object = { ...object, ...body };
      return { ok: true, status: 204, body: null };
    },
    read: async () => ({ ok: true, status: 200, body: object }),
  };
}

test('a namedLocation PATCH body keeps @odata.type at every depth and drops other annotations', () => {
  assert.deepEqual(writableProjection(snapshot, 'namedLocation'), {
    '@odata.type': '#microsoft.graph.ipNamedLocation',
    displayName: 'HQ',
    isTrusted: true,
    ipRanges: [{ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '203.0.113.0/24' }],
  });
  const country = writableProjection({
    '@odata.type': '#microsoft.graph.countryNamedLocation', '@odata.etag': 'W/"1"', id: 'loc-2',
    displayName: 'Blocked countries', countriesAndRegions: ['KP'], includeUnknownCountriesAndRegions: false,
  }, 'namedLocation');
  assert.deepEqual(country, {
    '@odata.type': '#microsoft.graph.countryNamedLocation',
    displayName: 'Blocked countries', countriesAndRegions: ['KP'], includeUnknownCountriesAndRegions: false,
  });
});

test('types outside the reviewed set still drop @odata.type from a PATCH body', () => {
  assert.deepEqual([...UPDATE_KEEPS_ODATA_TYPE], ['namedLocation']);
  assert.deepEqual(
    writableProjection({ '@odata.type': '#microsoft.graph.group', displayName: 'Finance Admins' }, 'group'),
    { displayName: 'Finance Admins' },
  );
});

test('a namedLocation update reaches Graph with its derived type and is applied', async () => {
  // A rename: what the location trusts matches live (a trust change is never
  // written, namedLocationTrust.test.mjs).
  const live = { ...snapshot, displayName: 'HQ (renamed)' };
  const graph = namedLocationGraph(live);
  const result = await applyWave(graph, governor, [{
    naturalKey: 'namedLocation:HQ', resourceType: 'namedLocation', verb: 'update', targetId: 'loc-1',
    blastRadius: 'tenant-lockout', payload: snapshot, live: { state: 'present', payload: live, targetId: 'loc-1' },
  }], { targetTenant: 'target', mode: 'enforce' });

  assert.deepEqual(result.failed, [], JSON.stringify(result.failed));
  assert.deepEqual(result.applied, [{ naturalKey: 'namedLocation:HQ', targetId: 'loc-1' }]);
  assert.equal(graph.calls.length, 1);
  const [patch] = graph.calls;
  assert.equal(patch.path, '/identity/conditionalAccess/namedLocations/loc-1');
  assert.equal(patch.opts.method, 'PATCH');
  assert.equal(patch.opts.body['@odata.type'], '#microsoft.graph.ipNamedLocation');
  for (const field of ['@odata.context', 'id', 'createdDateTime', 'modifiedDateTime']) {
    assert.equal(Object.hasOwn(patch.opts.body, field), false, `PATCH body must not carry ${field}`);
  }
});
