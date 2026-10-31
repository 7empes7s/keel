/**
 * A failed Graph read keeps the ids a Microsoft support case cites: the
 * request-id and client-request-id of the last call and when Microsoft
 * answered. Found live 2026-10-31 (operator queue Q301): every backup since
 * 28 Oct got 500 UnknownError from GET /beta/admin/todo, and the stored
 * failure held no request id. Runs offline: fetch is stubbed.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GraphReader, failureIds, supportIds } from './graph.mjs';
import { collectWithOutcomes, progressEntry } from '../../engine/collect/entraAdapter.mjs';
import { readOutcomeDetail } from '../../engine/coverage/snapshots.mjs';

const REQUEST_ID = 'df497c08-8f9b-4950-9a7a-e3fdde7457d5';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function faultingFetch(sent, headers = {}) {
  return async (url, options) => {
    sent.push(options.headers['client-request-id']);
    const values = { 'request-id': REQUEST_ID, date: 'Sat, 31 Oct 2026 21:38:07 GMT', ...headers };
    return {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: { get: (name) => values[name] ?? null },
      json: async () => ({ error: { code: 'UnknownError', message: '' } }),
    };
  };
}

test('a lasting 500 keeps the request id, the last client request id and the time', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const sent = [];
  globalThis.fetch = faultingFetch(sent);
  const reader = new GraphReader(async () => 'fixture-token', { serverErrorDelayMs: 0 });
  const result = await reader.collect('beta', '/admin/todo');
  assert.equal(sent.length, 3);
  assert.ok(sent.every((id) => GUID.test(id)), 'every try sends its own client-request-id');
  assert.equal(new Set(sent).size, 3, 'a fresh id per try');
  assert.equal(result.error.requestId, REQUEST_ID);
  assert.equal(result.error.clientRequestId, sent[2], 'the id of the try that failed last');
  assert.equal(result.error.requestAt, '2026-10-31T21:38:07.000Z');
});

test('the ids also come from the error body, and only GUIDs are kept', () => {
  const body = { error: { code: 'UnknownError', innerError: { 'request-id': 'AD90C348-CC9B-45A4-B848-4F66132F49D4', 'client-request-id': 'not a guid', date: '2026-10-31T21:38:20' } } };
  const ids = failureIds({ headers: { get: () => null } }, body, '0f0e0d0c-0b0a-4908-8706-050403020100');
  assert.deepEqual(ids, {
    requestId: 'ad90c348-cc9b-45a4-b848-4f66132f49d4',
    clientRequestId: '0f0e0d0c-0b0a-4908-8706-050403020100',
    requestAt: '2026-10-31T21:38:20.000Z',
  });
  assert.deepEqual(supportIds({ requestId: 'Bearer abc', clientRequestId: 42, requestAt: '2026-10-31T21:38:20Z' }), {}, 'nothing but GUIDs is stored');
  assert.deepEqual(supportIds({ requestAt: '2026-10-31T21:38:20Z' }), {}, 'a time alone names no call');
});

test('the backup digest, the job progress line and the coverage detail carry the ids', async () => {
  const failure = { ok: false, status: 500, code: 'UnknownError', error: '', tries: 3, requestId: REQUEST_ID, clientRequestId: '965fbbd0-0f48-4b94-8d30-1f0407312efe', requestAt: '2026-10-31T21:38:07.000Z' };
  const reader = {
    async collect(version, path) {
      if (path === '/admin/todo') return { items: [], pages: 0, status: null, capped: false, error: failure };
      return { items: [], pages: 1, status: 200, error: null };
    },
  };
  const { coverageDigest } = await collectWithOutcomes(reader, { tenantId: 'fixture-tenant' });
  const todo = coverageDigest.todoSettings;
  assert.equal(todo.outcome, 'failed');
  assert.equal(todo.requestId, REQUEST_ID);
  assert.equal(todo.clientRequestId, '965fbbd0-0f48-4b94-8d30-1f0407312efe');
  assert.equal(todo.requestAt, '2026-10-31T21:38:07.000Z');

  const line = progressEntry(todo, new Date('2026-10-31T21:38:00Z'));
  assert.equal(line.requestId, REQUEST_ID);
  assert.equal(line.clientRequestId, '965fbbd0-0f48-4b94-8d30-1f0407312efe');
  assert.equal(line.requestAt, '2026-10-31T21:38:07.000Z');

  const detail = readOutcomeDetail(todo);
  assert.equal(detail.requestId, REQUEST_ID);
  assert.equal(detail.requestAt, '2026-10-31T21:38:07.000Z');

  const ok = coverageDigest.organization;
  assert.equal(ok.requestId, undefined, 'a read that worked records no ids');
  assert.equal(progressEntry(ok, new Date()).requestId, undefined);
});
