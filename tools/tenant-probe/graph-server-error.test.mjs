/**
 * A 500, 502 or 504 from Graph is a fault on Microsoft's side. Backup reads
 * (collect) try it again with a growing wait; one-off reads (get) fail fast.
 * A fault that lasts is still a gap in the backup, worded as a Microsoft
 * service error, never as a bare "HTTP 500" or an empty message.
 * Found live 2026-10-28 (operator queue Q181): GET /beta/admin/todo answered
 * 500 UnknownError with an empty message. Runs offline: fetch is stubbed.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GraphReader, isServerError } from './graph.mjs';
import { collectWithOutcomes, serviceErrorMessage } from '../../engine/collect/entraAdapter.mjs';

function answers(list, calls) {
  return async (url) => {
    calls.push(url);
    const [status, body] = list[Math.min(calls.length - 1, list.length - 1)];
    return { ok: status < 400, status, statusText: 'x', headers: { get: () => null }, json: async () => body };
  };
}
const FAULT = [500, { error: { code: 'UnknownError', message: '' } }];
const OK = [200, { isExternalJoinEnabled: false }];

test('collect tries a 500 again and keeps the answer that gets through', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = answers([FAULT, OK], calls);
  const reader = new GraphReader(async () => 'fixture-token', { serverErrorDelayMs: 1 });
  const result = await reader.collect('beta', '/admin/todo');
  assert.equal(calls.length, 2);
  assert.equal(result.error, null);
  assert.deepEqual(result.items, [{ isExternalJoinEnabled: false }]);
  assert.equal(reader.stats.serverErrors, 1);
});

test('a lasting 500 is reported after three tries, with a doubling wait', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = answers([FAULT], calls);
  const reader = new GraphReader(async () => 'fixture-token', { serverErrorDelayMs: 20 });
  const started = Date.now();
  const result = await reader.collect('beta', '/admin/todo');
  assert.ok(Date.now() - started >= 55, 'waited 20 ms, then 40 ms');
  assert.equal(calls.length, 3);
  assert.equal(result.pages, 0);
  assert.equal(result.error.status, 500);
  assert.equal(result.error.code, 'UnknownError');
  assert.equal(result.error.tries, 3);
});

test('502 and 504 are retried; 403, 404 and one-off get() reads are not', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const status of [502, 504]) {
    const calls = [];
    globalThis.fetch = answers([[status, null], OK], calls);
    const result = await new GraphReader(async () => 't', { serverErrorDelayMs: 0 }).collect('beta', '/admin/todo');
    assert.equal(calls.length, 2, String(status));
    assert.equal(result.error, null, String(status));
  }
  for (const status of [403, 404]) {
    const calls = [];
    globalThis.fetch = answers([[status, { error: { code: 'x', message: 'no' } }], OK], calls);
    const result = await new GraphReader(async () => 't', { serverErrorDelayMs: 0 }).collect('beta', '/admin/todo');
    assert.equal(calls.length, 1, String(status));
    assert.equal(result.error.status, status);
    assert.equal(result.error.tries, undefined);
  }
  const calls = [];
  globalThis.fetch = answers([FAULT, OK], calls);
  const single = await new GraphReader(async () => 't', { serverErrorDelayMs: 0 }).get('beta', '/admin/todo');
  assert.equal(calls.length, 1, 'a one-off read fails fast');
  assert.equal(single.status, 500);
  assert.deepEqual([500, 502, 504, 503, 501, 403].map(isServerError), [true, true, true, false, false, false]);
});

test('the backup digest names a lasting 500 as a Microsoft service error, still a gap', async () => {
  const reader = {
    async collect(version, path) {
      if (path === '/admin/todo') return { items: [], pages: 0, status: null, capped: false, error: { ok: false, status: 500, code: 'UnknownError', error: '', tries: 3 } };
      return { items: [], pages: 1, status: 200, error: null };
    },
  };
  const { coverageDigest } = await collectWithOutcomes(reader, { tenantId: 'fixture-tenant' });
  const todo = coverageDigest.todoSettings;
  assert.equal(todo.outcome, 'failed', 'To Do settings were not backed up: never hidden');
  assert.equal(todo.itemCount, null);
  assert.equal(todo.httpStatus, 500);
  assert.equal(todo.graphCode, 'UnknownError');
  assert.equal(todo.error, "Microsoft service error: Microsoft 365 answered HTTP 500 UnknownError on all 3 tries. This is a fault on Microsoft's side, not a missing permission. The next backup tries again.");
});

test('the service error words keep Graph\'s own text and leave out a single try', () => {
  assert.equal(serviceErrorMessage(504, null, 'Gateway Timeout', 1),
    "Microsoft service error: Microsoft 365 answered HTTP 504 (Gateway Timeout). This is a fault on Microsoft's side, not a missing permission. The next backup tries again.");
});
