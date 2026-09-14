import { strict as assert } from 'node:assert';
import {
  GraphWriter,
  RETRY_AFTER_FALLBACK_SECONDS,
  parseRetryAfter,
  retryAfterFor,
} from './graphWriter.mjs';

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
      headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? (res.retryAfter ?? null) : null) },
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

// Retry-After accepts delay-seconds and HTTP-date. A fixed clock makes the
// date form deterministic, and invalid/negative forms must use the one
// bounded throttle fallback rather than a made-up delay.
const now = Date.parse('2026-09-08T00:00:00Z');
assert.equal(parseRetryAfter('7', now), 7);
assert.equal(parseRetryAfter('Tue, 08 Sep 2026 00:00:09 GMT', now), 9);
assert.equal(parseRetryAfter('-1', now), undefined);
assert.equal(parseRetryAfter('not-a-date', now), undefined);
assert.equal(retryAfterFor(429, { 'Retry-After': '-1' }, now), RETRY_AFTER_FALLBACK_SECONDS);

// Ordinary Graph read/write failures retain the validated retry delay so the
// apply layer can honor exactly what Graph told it.
globalThis.fetch = mockFetch([
  { status: 429, retryAfter: '7', body: { error: { code: 'TooManyRequests' } } },
  { status: 503, retryAfter: 'Tue, 08 Sep 2026 00:00:09 GMT', body: { error: { code: 'serviceNotAvailable' } } },
]);
const timedWriter = new GraphWriter(async () => 'fake-token', { clock: () => now });
const writeFailure = await timedWriter.write('v1.0', '/groups', { method: 'POST', body: {} });
const readFailure = await timedWriter.read('v1.0', '/groups');
assert.equal(writeFailure.retryAfter, 7);
assert.equal(readFailure.retryAfter, 9);

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

// An outer throttle is not an empty successful batch, and a 200 envelope
// without Graph's responses array is malformed rather than harmless.
globalThis.fetch = mockFetch([
  { status: 429, body: { error: { code: 'TooManyRequests' } } },
  { status: 200, body: { value: [] } },
]);
const outerThrottle = await writer.batch('v1.0', [
  { id: '1', method: 'POST', url: '/groups', body: {} },
]);
assert.equal(outerThrottle.ok, false);
assert.equal(outerThrottle.succeeded.length, 0);
assert.equal(outerThrottle.failed[0].status, 429);
assert.equal(outerThrottle.failed[0].retryAfter, RETRY_AFTER_FALLBACK_SECONDS);
const malformedEnvelope = await writer.batch('v1.0', [
  { id: '1', method: 'POST', url: '/groups', body: {} },
]);
assert.equal(malformedEnvelope.ok, false);
assert.equal(malformedEnvelope.succeeded.length, 0);
assert.match(malformedEnvelope.failed[0].error.message, /malformed/i);

// Non-Graph host refusal, same guarantee as GraphReader.
await assert.rejects(() => writer.write('v1.0', 'https://evil.example.com/x', { method: 'POST', body: {} }),
  /refused/i);

console.log('graphWriter.test.mjs — all assertions passed');
