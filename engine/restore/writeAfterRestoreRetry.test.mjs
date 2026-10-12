import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import { applyWave } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';

// Live Q43 step 3: a group restored from deleted items came back, but Graph
// 404'd the follow-up PATCH for a few seconds (replication lag). The PATCH must
// retry that 404 (bounded) and the journal must record the write as succeeded.

const governor = new ThrottleGovernor({
  'target/entra/write': { capacity: 100, refillPerSecond: 100 },
});

const desired = { displayName: 'Finance Admins', mailNickname: 'FIN-Admins', description: 'Baseline description' };
const stale = { ...desired, id: 'original-group-id', description: 'Modified before deletion' };
const converged = { ...desired, id: 'original-group-id' };
assert.notEqual(canonicalHash(stale, 'group'), canonicalHash(converged, 'group'));

const resource = {
  naturalKey: 'group:FIN-Admins',
  resourceType: 'group',
  payload: desired,
  targetId: 'original-group-id',
  deletedItemId: 'original-group-id',
  verb: 'restore-soft-deleted',
};

/** PATCH answers 404 `lagFor` times, then 204. Reads: stale once, then converged. */
function fakeWriter({ lagFor }) {
  const calls = [];
  let patches = 0;
  let reads = 0;
  return {
    calls,
    write: async (version, path, opts) => {
      calls.push({ kind: 'write', path, method: opts.method });
      if (opts.method === 'POST') return { ok: true, status: 200, body: { id: 'original-group-id' } };
      patches += 1;
      if (patches <= lagFor) return { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
      return { ok: true, status: 204, body: null };
    },
    read: async (version, path) => {
      calls.push({ kind: 'read', path });
      reads += 1;
      return { ok: true, status: 200, body: reads === 1 ? stale : converged };
    },
  };
}

/** Journal fake: one entry id, and every outcome recorded against it. */
function fakeJournal() {
  const outcomes = [];
  return {
    outcomes,
    async query(text, values) {
      if (text.includes('INSERT INTO rollback_entry')) return { rows: [{ id: 'entry-1' }] };
      if (text.includes('SET outcome')) outcomes.push({ entryId: values[0], outcome: values[1], postState: values[2] ? JSON.parse(values[2]) : null, detail: values[4] });
      return { rows: [] };
    },
  };
}

const apply = (writer, rollbackClient, attempts) => applyWave(writer, governor, [resource], {
  targetTenant: 'target', mode: 'enforce', rollbackClient, runId: 'run-q43', restoreRef: 'restore-q43',
  readAfterWriteOptions: { attempts, delayMs: 0 },
});

test('a 404 on the follow-up PATCH right after a group restore is retried and the write succeeds', async () => {
  const writer = fakeWriter({ lagFor: 2 });
  const journal = fakeJournal();
  const result = await apply(writer, journal, 6);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [{ naturalKey: 'group:FIN-Admins', targetId: 'original-group-id' }]);
  assert.deepEqual(writer.calls, [
    { kind: 'write', path: '/directory/deletedItems/original-group-id/restore', method: 'POST' },
    { kind: 'read', path: '/groups/original-group-id' },
    { kind: 'write', path: '/groups/original-group-id', method: 'PATCH' },
    { kind: 'write', path: '/groups/original-group-id', method: 'PATCH' },
    { kind: 'write', path: '/groups/original-group-id', method: 'PATCH' },
    { kind: 'read', path: '/groups/original-group-id' },
  ]);
  // The journal (what the live capture reads) records the verified write, not a failure.
  assert.deepEqual(journal.outcomes, [{ entryId: 'entry-1', outcome: 'succeeded', postState: converged, detail: null }]);
});

test('a 404 that outlasts the retry bound still fails cleanly with the existing error', async () => {
  const writer = fakeWriter({ lagFor: Infinity });
  const journal = fakeJournal();
  const result = await apply(writer, journal, 3);
  assert.deepEqual(result.applied, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].naturalKey, 'group:FIN-Admins');
  assert.equal(result.failed[0].error, JSON.stringify({ error: { code: 'Request_ResourceNotFound' } }));
  assert.equal(writer.calls.filter((c) => c.method === 'PATCH').length, 3, 'bounded: exactly `attempts` PATCHes');
  assert.deepEqual(journal.outcomes, [{ entryId: 'entry-1', outcome: 'uncertain', postState: stale, detail: 'restored; follow-up update status 404' }]);
});
