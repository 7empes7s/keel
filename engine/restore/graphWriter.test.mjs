import { strict as assert } from 'node:assert';
import { GraphWriter } from './graphWriter.mjs';

// Mock fetch: a batch of 2 requests where the OUTER response is 200 but one
// inner item is a 429. A client that checks only the outer status reports
// total success having silently dropped a write — precisely spec §11.3's
// trap, and precisely how a restore can report success having done nothing.
function mockFetch(responses) {
  let call = 0;
  return async (url, opts) => {
    const res = responses[call++];
    return {
      ok: res.status < 400,
      status: res.status,
      headers: { get: (h) => (h === 'retry-after' ? String(res.retryAfter ?? 10) : null) },
      json: async () => res.body,
      statusText: 'mock',
    };
  };
}

globalThis.fetch = mockFetch([
  {
    status: 200,
    body: {
      responses: [
        { id: '1', status: 200, body: { id: 'created-1' } },
        { id: '2', status: 429, headers: { 'Retry-After': '5' }, body: { error: { code: 'TooManyRequests' } } },
      ],
    },
  },
]);

const writer = new GraphWriter(async () => 'fake-token');
const result = await writer.batch('v1.0', [
  { id: '1', method: 'POST', url: '/groups', body: {} },
  { id: '2', method: 'POST', url: '/groups', body: {} },
]);

// The batch call must report PARTIAL failure, not overall success — this is
// the assertion the spec names explicitly.
assert.equal(result.ok, false);
assert.equal(result.succeeded.length, 1);
assert.equal(result.failed.length, 1);
assert.equal(result.failed[0].id, '2');
assert.equal(result.failed[0].retryAfter, 5);

// A batch where every item succeeds IS overall success — this is the
// diverging case: same code path, different input, different (correct)
// outcome, so a "just always report failure" bug would also be caught.
globalThis.fetch = mockFetch([
  { status: 200, body: { responses: [{ id: '1', status: 200, body: {} }, { id: '2', status: 201, body: {} }] } },
]);
const allOk = await writer.batch('v1.0', [
  { id: '1', method: 'POST', url: '/groups', body: {} },
  { id: '2', method: 'POST', url: '/groups', body: {} },
]);
assert.equal(allOk.ok, true);
assert.equal(allOk.succeeded.length, 2);

// Non-Graph host refusal, same guarantee as GraphReader.
await assert.rejects(() => writer.write('v1.0', 'https://evil.example.com/x', { method: 'POST', body: {} }),
  /refused/i);

console.log('graphWriter.test.mjs — all assertions passed');
