/**
 * Regression test for the roleEligibilityScheduleInstances 400.
 *
 * Measured live against the tenant on 2026-09-08: GET
 * .../roleManagement/directory/roleEligibilityScheduleInstances returns
 *   {"ErrorCode":"CultureNotFoundException","Message":"Culture is not
 *   supported. Parameter name: name\n* is an invalid culture identifier."}
 * with no Accept-Language header, and HTTP 200 (15 records) with
 * `Accept-Language: en-US` added — nothing else about the request differs.
 * PIM role eligibility is catalogued tier1 / blastRadius tenant-lockout, so
 * this was a real, silent collection gap, not a permissions issue.
 *
 * Runs fully offline: global fetch is stubbed so this suite never calls
 * Microsoft Graph.
 */

import { strict as assert } from 'node:assert';
import { GraphReader } from './graph.mjs';

// Records every request's (url, headers) pair so assertions can inspect
// exactly what GraphReader sent, without caring how many requests were made.
function mockFetch(calls) {
  return async (url, opts) => {
    calls.push({ url, headers: { ...opts.headers } });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ value: [] }),
      statusText: 'mock',
    };
  };
}

// --- get(): a single request must carry Accept-Language ------------------
{
  const calls = [];
  globalThis.fetch = mockFetch(calls);
  const reader = new GraphReader(async () => 'fake-token');
  const res = await reader.get('v1.0', '/roleManagement/directory/roleEligibilityScheduleInstances');

  assert.equal(res.ok, true, 'sanity: stubbed request should succeed');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].headers['Accept-Language'],
    'en-US',
    'get() must send Accept-Language: en-US on every request — Graph\'s PIM ' +
      'endpoints 400 with CultureNotFoundException without it',
  );
  // The existing auth header must still be present — the fix must add to the
  // headers, not replace them.
  assert.equal(calls[0].headers.Authorization, 'Bearer fake-token');
}

// --- get() with consistencyLevel: both headers must coexist ---------------
{
  const calls = [];
  globalThis.fetch = mockFetch(calls);
  const reader = new GraphReader(async () => 'fake-token');
  await reader.get('v1.0', '/users', { consistencyLevel: true });

  assert.equal(calls[0].headers['Accept-Language'], 'en-US');
  assert.equal(calls[0].headers.ConsistencyLevel, 'eventual');
}

// --- collect(): pagination must not drop the header on later pages --------
{
  const calls = [];
  let call = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, headers: { ...opts.headers } });
    call++;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ value: [{ id: 'a' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page' }),
        statusText: 'mock',
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ value: [{ id: 'b' }] }),
      statusText: 'mock',
    };
  };

  const reader = new GraphReader(async () => 'fake-token');
  const result = await reader.collect('v1.0', '/roleManagement/directory/roleEligibilityScheduleInstances');

  assert.equal(result.items.length, 2);
  assert.equal(calls.length, 2, 'sanity: pagination must have followed the nextLink');
  for (const c of calls) {
    assert.equal(c.headers['Accept-Language'], 'en-US', 'every paged request must carry Accept-Language');
  }
}

console.log('graph.test.mjs — all assertions passed');
