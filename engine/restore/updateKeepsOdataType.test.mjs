// An update PATCH body keeps @odata.type, as a create body does (#173). Reproduces
// live step 40: Graph refused a namedLocation PATCH with 400 "1042: Unexpected
// type: namedLocationType" because writableProjection dropped @odata.type; the
// same PATCH with it was accepted (204). An ipRanges entry needs its own type too.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyWave } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';
import { writableProjection } from '../reconcile/writableProjection.mjs';

const governor = new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });

const payload = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#identity/conditionalAccess/namedLocations/$entity',
  '@odata.type': '#microsoft.graph.ipNamedLocation',
  id: 'loc-1',
  createdDateTime: '2026-10-01T00:00:00Z',
  modifiedDateTime: '2026-10-02T00:00:00Z',
  displayName: 'KEEL-RT-148 HQ',
  isTrusted: false,
  ipRanges: [{ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '203.0.113.0/24' }],
};

// Behaves like Graph on a namedLocation PATCH: no discriminator is a 400.
function graphLikeWriter() {
  const calls = [];
  let live = { ...payload, displayName: 'KEEL-RT-148 HQ (renamed)' };
  return {
    calls,
    write: async (version, path, opts) => {
      calls.push({ path, opts });
      if (opts.body?.['@odata.type'] === undefined) {
        return { ok: false, status: 400, body: { error: { code: 'BadRequest', message: '1042: Unexpected type: namedLocationType' } } };
      }
      live = { ...live, ...opts.body };
      return { ok: true, status: 204, body: null };
    },
    read: async () => ({ ok: true, status: 200, body: live }),
  };
}

test('writableProjection keeps @odata.type at every depth and still drops other annotations and server-owned fields', () => {
  assert.deepEqual(writableProjection(payload, 'namedLocation'), {
    '@odata.type': '#microsoft.graph.ipNamedLocation',
    displayName: 'KEEL-RT-148 HQ',
    isTrusted: false,
    ipRanges: [{ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '203.0.113.0/24' }],
  });
  // Nothing is invented when the snapshot did not record a type.
  const { '@odata.type': _drop, ...untyped } = payload;
  assert.equal(Object.hasOwn(writableProjection(untyped, 'namedLocation'), '@odata.type'), false);
});

test('a namedLocation update PATCH carries @odata.type and is accepted', async () => {
  const writer = graphLikeWriter();
  const resource = {
    naturalKey: 'namedLocation:KEEL-RT-148 HQ', resourceType: 'namedLocation', blastRadius: 'tenant-lockout',
    verb: 'update', targetId: 'loc-1', payload,
  };
  const result = await applyWave(writer, governor, [resource], { targetTenant: 'target', mode: 'enforce' });

  const patches = writer.calls.filter((call) => call.opts?.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path, '/identity/conditionalAccess/namedLocations/loc-1');
  assert.equal(patches[0].opts.body['@odata.type'], '#microsoft.graph.ipNamedLocation');
  assert.equal(patches[0].opts.body.ipRanges[0]['@odata.type'], '#microsoft.graph.iPv4CidrRange');
  assert.equal(Object.hasOwn(patches[0].opts.body, '@odata.context'), false);
  assert.equal(Object.hasOwn(patches[0].opts.body, 'id'), false);
  assert.deepEqual(result.failed, [], `update must not fail: ${JSON.stringify(result.failed)}`);
});
