import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { progressWriter } from '../../cli/keel-collect.mjs';
import { collectWithOutcomes, M1_TYPES, progressEntry } from './entraAdapter.mjs';
import { get } from './registry.mjs';

// Job page redesign: a backup reports each type as it reads it, so a running job shows
// what is waiting, being read, done and failed, with counts and timings.
test('a collection reports every requested type as waiting, then reading, then its outcome', async () => {
  const reader = {
    async collect(version, path) {
      if (path.startsWith('/users?')) return { items: [{ id: 'u1' }, { id: 'u2' }], pages: 1, status: 200 };
      if (path.startsWith('/groups?')) throw new Error('connection reset');
      return { items: [], pages: 1, status: 200, error: null };
    },
  };
  const reports = [];
  const tier = get('user').descriptor.criticality;
  const planned = M1_TYPES.filter((type) => get(type).descriptor.criticality === tier);
  await collectWithOutcomes(reader, { tenantId: 'fixture-tenant', tier, onProgress: async (types) => { reports.push(types); } });
  // First report: every type of the tier is waiting, and only those.
  assert.deepEqual(Object.keys(reports[0]).sort(), [...planned].sort());
  assert.ok(Object.values(reports[0]).every((entry) => entry.outcome === 'waiting'));
  // A type is marked reading before its read, then its outcome after.
  const reading = reports.findIndex((types) => types.user.outcome === 'reading');
  assert.ok(reading > 0);
  assert.ok(reports[reading + 1].user.outcome === 'complete');
  const last = reports.at(-1);
  assert.equal(last.user.itemCount, 2);
  assert.ok(!Number.isNaN(Date.parse(last.user.startedAt)) && !Number.isNaN(Date.parse(last.user.completedAt)));
  if (planned.includes('group')) {
    assert.equal(last.group.outcome, 'failed');
    assert.match(last.group.error, /connection reset/);
  }
  assert.ok(Object.values(last).every((entry) => entry.outcome !== 'waiting' && entry.outcome !== 'reading'));
  // Nothing but the outcome, count, timing and a short error is reported.
  for (const entry of Object.values(last)) {
    assert.deepEqual(Object.keys(entry).filter((key) => !['outcome', 'itemCount', 'startedAt', 'completedAt', 'httpStatus', 'error', 'throttles'].includes(key)), []);
  }
});

test('a failing progress report never changes the collection', async () => {
  const reader = { async collect() { return { items: [], pages: 1, status: 200, error: null }; } };
  const { coverageDigest } = await collectWithOutcomes(reader, { tenantId: 't', onProgress: async () => { throw new Error('db down'); } });
  assert.deepEqual(Object.keys(coverageDigest), M1_TYPES);
});

test('progress is written onto the running job only when the worker passed a job id', async () => {
  const queries = [];
  const client = { async query(sql, values) { queries.push({ sql, values }); return { rows: [] }; } };
  assert.equal(progressWriter(client, undefined), undefined);
  assert.equal(progressWriter(client, 'not-a-uuid'), undefined);
  const write = progressWriter(client, '11111111-1111-4111-8111-111111111111');
  await write({ user: { outcome: 'waiting' } });
  assert.match(queries[0].sql, /UPDATE job SET progress = \$2 WHERE id = \$1 AND status = 'running'/);
  assert.equal(queries[0].values[0], '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(JSON.parse(queries[0].values[1]).types, { user: { outcome: 'waiting' } });
});

test('a progress entry caps the error and keeps only whole counts', () => {
  const entry = progressEntry({ outcome: 'failed', itemCount: null, error: 'x'.repeat(2000), httpStatus: 429, throttles: 3 }, new Date('2026-10-22T10:00:00Z'));
  assert.equal(entry.error.length, 500);
  assert.equal(entry.startedAt, '2026-10-22T10:00:00.000Z');
  assert.equal(entry.throttles, 3);
});
