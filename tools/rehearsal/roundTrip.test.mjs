import { strict as assert } from 'node:assert';
import {
  assertDisposable, assertRehearsalDatabase, assertSingleModifiedDrift, collectRehearsalSnapshot,
  getWithRetry, readGroupWithRetry, runRoundTrip, writeWithRetry,
} from './roundTrip.mjs';

// Production and rehearsal URLs with the same host and database identify the
// same governance store even when their credentials differ.
assert.throws(
  () => assertRehearsalDatabase(
    'postgres://u:p@127.0.0.1:5433/keel',
    'postgres://u:p@127.0.0.1:5433/keel',
  ),
  /production/i,
);
assert.throws(
  () => assertRehearsalDatabase(
    'postgres://other:creds@127.0.0.1:5433/keel',
    'postgres://u:p@127.0.0.1:5433/keel',
  ),
  /production/i,
);
assert.equal(
  assertRehearsalDatabase(
    'postgres://u:p@127.0.0.1:5433/keel_test',
    'postgres://u:p@127.0.0.1:5433/keel',
  ),
  'postgres://u:p@127.0.0.1:5433/keel_test',
);
assert.throws(
  () => assertRehearsalDatabase(
    'postgres://u:p@LOCALHOST:5432/keel',
    'postgres://u:p@localhost/keel',
  ),
  /production/i,
);
assert.throws(
  () => assertRehearsalDatabase(undefined, 'postgres://u:p@localhost/keel'),
  /KEEL_DB_TEST_URL|--db-url/,
);

function fakeWriter() {
  const writes = [];
  return {
    writes,
    async write(...args) {
      writes.push(args);
      return { ok: true, status: 204, body: null };
    },
  };
}

// Dry-run must traverse the complete advertised rehearsal sequence without
// issuing a write, even when a writer is supplied by a caller.
const writer = fakeWriter();
const evidence = [];
const dryRun = await runRoundTrip({
  writer,
  log: (line) => evidence.push(line),
});
assert.equal(dryRun.mode, 'dry-run');
assert.equal(writer.writes.length, 0);
assert.ok(evidence.some((line) => line.includes('create group keel-rehearsal-<ISO timestamp>')));
assert.ok(evidence.some((line) => line.includes('hard-delete the group; assert absence')));

// The interlock's allowed and refused fixtures differ in the natural key
// prefix, so removing its gate cannot leave this test green.
assert.doesNotThrow(() => assertDisposable('group:keel-rehearsal-2026-09-05T00-00-00-000Z'));
assert.throws(
  () => assertDisposable('group:production-admins'),
  /refusing to mutate non-disposable natural key/,
);

const oneModifiedDrift = [{
  id: 'drift-1',
  natural_key: 'group:keel-rehearsal-2026-09-05T00-00-00-000Z',
  change_type: 'modified',
}];
assert.equal(
  assertSingleModifiedDrift(oneModifiedDrift, oneModifiedDrift[0].natural_key),
  oneModifiedDrift[0],
);

// Step 4 must fail loudly rather than silently choosing an arbitrary row.
assert.throws(
  () => assertSingleModifiedDrift([
    ...oneModifiedDrift,
    {
      id: 'drift-2',
      natural_key: 'group:keel-rehearsal-a-second-object',
      change_type: 'modified',
    },
  ], oneModifiedDrift[0].natural_key),
  /expected exactly one drift row/,
);

// readGroupWithRetry must retry a 404 rather than propagate it immediately — this is the
// exact failure observed live right after a group write (creation, mutation, or rollback).
// This generically exercises the retry behavior shared by all three call sites in
// roundTrip.mjs — collectRehearsalSnapshot (step 2/step 4 collection), the step 3
// post-mutation read, and the step 5 post-rollback read — since each is a plain
// `readGroupWithRetry(reader, groupId)` call with no call-site-specific branching. A
// duplicate fixture per call site would not exercise anything this one doesn't already cover.
{
  let calls = 0;
  const reader = {
    get: async () => {
      calls += 1;
      if (calls <= 2) return { ok: false, status: 404, body: null };
      return { ok: true, status: 200, body: { id: 'g1', displayName: 'x', mailNickname: 'x' } };
    },
  };
  const result = await readGroupWithRetry(reader, 'g1');
  assert.equal(result.id, 'g1');
  assert.equal(calls, 3, 'expected two failed attempts before the third succeeded');
}

// readGroupWithRetry must also retry a read that succeeds but doesn't yet satisfy a caller-given
// expectation — the stale-200 failure mode confirmed live on 2026-09-07, distinct from a 404.
{
  let calls = 0;
  const reader = {
    get: async () => {
      calls += 1;
      const description = calls <= 2 ? 'stale' : 'fresh';
      return { ok: true, status: 200, body: { id: 'g1', description } };
    },
  };
  const result = await readGroupWithRetry(reader, 'g1', { isExpected: (body) => body.description === 'fresh' });
  assert.equal(result.description, 'fresh');
  assert.equal(calls, 3, 'expected two stale reads before the third satisfied isExpected');
}

// Without an isExpected predicate, existing behavior (retry only on 404, accept the first
// successful read regardless of content) must be unchanged — this is step 2's baseline collect,
// which only needs the object to exist, not to match specific content.
{
  let calls = 0;
  const reader = { get: async () => { calls += 1; return { ok: true, status: 200, body: { id: 'g2' } }; } };
  const result = await readGroupWithRetry(reader, 'g2');
  assert.equal(result.id, 'g2');
  assert.equal(calls, 1, 'expected no retry when no isExpected predicate is given and the read succeeds immediately');
}

// A write that 404s on a freshly-created object (this tenant's confirmed write-path lag,
// distinct from the read-path lag already covered) must retry, not fail immediately.
{
  let calls = 0;
  const writer = {
    write: async () => {
      calls += 1;
      if (calls <= 2) return { ok: false, status: 404, body: null };
      return { ok: true, status: 200, body: { id: 'g1' } };
    },
  };
  const result = await writeWithRetry(writer, 'v1.0', '/groups/g1', { method: 'PATCH', body: { displayName: 'x' } });
  assert.equal(result.ok, true);
  assert.equal(calls, 3, 'expected two failed attempts before the third succeeded');
}

// A non-404 failure (a real rejection) must NOT be retried — it should fail on the first attempt.
{
  let calls = 0;
  const writer = {
    write: async () => { calls += 1; return { ok: false, status: 400, body: { error: 'bad request' } }; },
  };
  const result = await writeWithRetry(writer, 'v1.0', '/groups/g1', { method: 'PATCH', body: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(calls, 1, 'a 400 must never be retried');
}

// Regression for the 2026-09-08 07:55Z incident: a failure at any step after
// group creation must still hard-delete the disposable group. Here step 2
// blows up (the first collect read rejects), so step 7 is never reached — yet
// the writer must still record DELETEs against the created group, and the
// original error must propagate unchanged.
{
  const calls = [];
  const failingWriter = {
    write: async (version, path, body) => {
      calls.push({ path, method: body?.method });
      if (body?.method === 'POST' && path === '/groups') {
        return { ok: true, status: 201, body: { id: 'rehearsal-group-id-1' } };
      }
      return { ok: true, status: 204, body: null };
    },
  };
  const failingReader = {
    collect: async () => { throw new Error('simulated step-2 collect failure'); },
    get: async () => { throw new Error('simulated step-2 collect failure'); },
  };
  const failingClient = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    runRoundTrip({
      mode: 'live',
      log: () => {},
      collectorConfigPath: '/etc/keel/tenant.json',
      restorerConfigPath: '/etc/keel/restorer.json',
      dbUrl: 'postgres://u:p@127.0.0.1:5433/keel_test_fake',
      writer: failingWriter,
      reader: failingReader,
      client: failingClient,
      now: () => new Date('2026-09-08T07:55:08.076Z'),
    }),
    /simulated step-2 collect failure/,
  );
  const deletes = calls.filter((call) => call.method === 'DELETE');
  assert.ok(
    deletes.some((call) => call.path === '/groups/rehearsal-group-id-1'),
    `expected a DELETE of the created group on the failure path, got ${JSON.stringify(calls)}`,
  );
}

// getWithRetry must retry toward PRESENCE on an arbitrary Graph path — the
// /directory/deletedItems/{id} read in hardDelete, which 404s until a
// soft-delete replicates.
{
  let calls = 0;
  const reader = {
    get: async () => {
      calls += 1;
      if (calls <= 2) return { ok: false, status: 404, body: null };
      return { ok: true, status: 200, body: { id: 'g1' } };
    },
  };
  const result = await getWithRetry(reader, 'v1.0', '/directory/deletedItems/g1', (r) => r.ok === true, { delayMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.body.id, 'g1');
  assert.equal(calls, 3, 'expected two failed attempts before the third succeeded');
}

// getWithRetry must also retry toward ABSENCE — the /groups/{id} read in
// hardDelete, which can still return 200 until a soft-delete replicates.
{
  let calls = 0;
  const reader = {
    get: async () => {
      calls += 1;
      if (calls <= 2) return { ok: true, status: 200, body: { id: 'g1' } };
      return { ok: false, status: 404, body: null };
    },
  };
  const result = await getWithRetry(reader, 'v1.0', '/groups/g1', (r) => r.ok === false && r.status === 404, { delayMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(calls, 3, 'expected two stale reads before the third returned 404');
}

// When the predicate never holds, getWithRetry must return the LAST result
// after exactly `attempts` calls — never throw, never hang — so the caller's
// own error handling decides the outcome.
{
  let calls = 0;
  const reader = {
    get: async () => { calls += 1; return { ok: true, status: 200, body: { id: 'g1', attempt: calls } }; },
  };
  const result = await getWithRetry(reader, 'v1.0', '/groups/g1', (r) => r.ok === false, { attempts: 3, delayMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.body.attempt, 3, 'expected the last result to be returned');
  assert.equal(calls, 3, 'expected exactly `attempts` calls when the predicate never holds');
}

// Regression for the 2026-09-08 08:59Z incident: step 4's collection read the
// group it had just mutated with no expected-content predicate, so a stale
// replica's body could be snapshotted as "after" — identical to the baseline,
// hence zero drift rows. collectRehearsalSnapshot must keep polling its
// single-object overlay read until the caller's isExpected predicate holds.
{
  let gets = 0;
  const staleBody = {
    id: 'g1', displayName: 'keel-rehearsal-x', description: 'stale', mailNickname: 'keel-rehearsal-x',
  };
  const driftedBody = { ...staleBody, description: 'drifted' };
  const reader = {
    collect: async (version, path) => ({
      items: path.startsWith('/groups') ? [staleBody] : [],
    }),
    get: async () => {
      gets += 1;
      return { ok: true, status: 200, body: gets <= 2 ? staleBody : driftedBody };
    },
  };
  const resources = await collectRehearsalSnapshot(reader, 'g1', {
    isExpected: (group) => group.description === 'drifted',
    delayMs: 1,
  });
  const group = resources.find((resource) => resource.resourceType === 'group' && resource.sourceId === 'g1');
  assert.ok(group, 'expected the rehearsal group in the collected snapshot');
  assert.equal(
    group.payload.description,
    'drifted',
    'the overlay read must wait for the drifted content, not accept a stale replica body',
  );
  assert.ok(gets > 1, `expected the overlay read to be polled more than once, got ${gets}`);
}

// Without an isExpected predicate, collectRehearsalSnapshot must accept the
// first successful overlay read — step 2's baseline collect is unchanged.
{
  let gets = 0;
  const body = {
    id: 'g2', displayName: 'keel-rehearsal-y', description: 'baseline', mailNickname: 'keel-rehearsal-y',
  };
  const reader = {
    collect: async (version, path) => ({ items: path.startsWith('/groups') ? [body] : [] }),
    get: async () => { gets += 1; return { ok: true, status: 200, body }; },
  };
  const resources = await collectRehearsalSnapshot(reader, 'g2', { delayMs: 1 });
  const group = resources.find((resource) => resource.resourceType === 'group' && resource.sourceId === 'g2');
  assert.ok(group, 'expected the rehearsal group in the collected snapshot');
  assert.equal(group.payload.description, 'baseline');
  assert.equal(gets, 1, 'expected no retry when no isExpected predicate is given and the read succeeds immediately');
}

console.log('roundTrip.test.mjs — all assertions passed');
