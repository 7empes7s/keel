// Wave 2 RST: a wave writes independent resources concurrently under the
// throttle governor, skips a resource whose target already holds the desired
// state, and a rerun of the same run resumes from its journal without writing
// anything twice. Fixtures only: the writer below is an in-memory tenant.
import { strict as assert } from 'node:assert';
import { applyWave, DEFAULT_WAVE_CONCURRENCY } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';

const TENANT = 'target';
const LATENCY_MS = 2;
const roomyGovernor = () => new ThrottleGovernor({ [`${TENANT}/entra/write`]: { capacity: 1e6, refillPerSecond: 1e6 } });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tenant of groups. Every call takes LATENCY_MS, like a Graph round trip.
 * `hangAfterPosts` models a killed run: from that POST on, a write still lands
 * but nothing ever answers. */
function fakeTenant({ hangAfterPosts = Infinity } = {}) {
  const objects = new Map();
  const posts = [];
  const patches = [];
  let nextId = 1;
  const never = new Promise(() => {});
  const tenant = {
    objects, posts, patches,
    writerFor({ hangAfter = hangAfterPosts } = {}) {
      return {
        async write(version, path, { method, body }) {
          await delay(LATENCY_MS);
          if (method === 'POST' && path === '/groups') {
            const id = `group-${nextId++}`;
            objects.set(id, { id, ...body });
            posts.push(body.mailNickname);
            if (posts.length >= hangAfter) return never;
            return { ok: true, status: 201, body: { id, ...body } };
          }
          if (method === 'PATCH') {
            const id = path.split('/').at(-1);
            objects.set(id, { ...objects.get(id), ...body });
            patches.push(id);
            return { ok: true, status: 204, body: null };
          }
          throw new Error(`unexpected ${method} ${path}`);
        },
        async read(version, path) {
          await delay(LATENCY_MS);
          const object = objects.get(path.split('/').at(-1));
          return object ? { ok: true, status: 200, body: { ...object } } : { ok: false, status: 404, body: null };
        },
      };
    },
  };
  return tenant;
}

/** The three rollback_entry statements the journal issues, kept in memory. */
function memoryJournal() {
  const rows = [];
  return {
    rows,
    async query(sql, params) {
      if (sql.includes('INSERT INTO rollback_entry')) {
        const [runId, naturalKey, priorState, restoreRef, resourceType, operation, targetId, blastRadius, intendedState, outcome] = params;
        const id = rows.length + 1;
        rows.push({ id, run_id: runId, natural_key: naturalKey, prior_state: priorState, restore_ref: restoreRef ?? null,
          resource_type: resourceType, operation, target_id: targetId ?? null, blast_radius: blastRadius,
          intended_state: intendedState, outcome, outcome_detail: null, post_state: null, recorded_at: id });
        return { rows: [{ id }] };
      }
      if (sql.includes('UPDATE rollback_entry')) {
        const [id, outcome, , targetId, detail] = params;
        const row = rows.find((candidate) => candidate.id === id);
        row.outcome = outcome;
        row.target_id = targetId ?? row.target_id;
        row.outcome_detail = detail;
        return { rows: [] };
      }
      if (sql.includes('FROM rollback_entry') && sql.includes('restore_ref = $1')) {
        return { rows: rows.filter((row) => row.restore_ref === params[0]) };
      }
      throw new Error(`unexpected journal query: ${sql}`);
    },
  };
}

const groups = (count) => Array.from({ length: count }, (_, index) => {
  const nick = `KEEL-RT-rst-${String(index).padStart(3, '0')}`;
  return {
    naturalKey: `group:${nick}`, resourceType: 'group', verb: 'create', blastRadius: 'access-affecting', references: [],
    payload: { displayName: nick, mailNickname: nick, mailEnabled: false, securityEnabled: true },
  };
});

const run = (tenant, wave, options = {}) => applyWave(tenant.writerFor(options.writer), options.governor ?? roomyGovernor(), wave, {
  targetTenant: TENANT, mode: 'enforce', runId: 'run-rst', restoreRef: 'artifact-rst', ...options,
});

// 1. A 500-object wave runs at least 3x faster than the serial path, with the
//    same result.
{
  const wave = groups(500);
  const serialTenant = fakeTenant();
  const serialStart = performance.now();
  const serial = await run(serialTenant, wave, { concurrency: 1, rollbackClient: memoryJournal() });
  const serialMs = performance.now() - serialStart;

  const concurrentTenant = fakeTenant();
  const concurrentStart = performance.now();
  const concurrent = await run(concurrentTenant, wave, { rollbackClient: memoryJournal() });
  const concurrentMs = performance.now() - concurrentStart;

  assert.equal(serial.applied.length, 500);
  assert.equal(concurrent.applied.length, 500);
  assert.deepEqual(concurrent.failed, []);
  assert.deepEqual(concurrent.applied.map((entry) => entry.naturalKey), wave.map((resource) => resource.naturalKey),
    'results keep wave order whatever finishes first');
  assert.equal(concurrentTenant.posts.length, 500);
  assert.ok(DEFAULT_WAVE_CONCURRENCY > 1);
  const speedup = serialMs / concurrentMs;
  console.log(`500 objects: serial ${serialMs.toFixed(0)} ms, concurrent ${concurrentMs.toFixed(0)} ms, ${speedup.toFixed(1)}x`);
  assert.ok(speedup >= 3, `expected at least 3x faster, got ${speedup.toFixed(2)}x (serial ${serialMs.toFixed(0)} ms, concurrent ${concurrentMs.toFixed(0)} ms)`);
}

// 2. A second run of the same restore writes nothing: every created object is
//    read back and counted as applied.
{
  const wave = groups(500);
  const tenant = fakeTenant();
  const journal = memoryJournal();
  const first = await run(tenant, wave, { rollbackClient: journal });
  assert.equal(first.applied.length, 500);
  const postsBefore = tenant.posts.length;
  const journalBefore = journal.rows.length;

  const second = await run(tenant, wave, { rollbackClient: journal });
  assert.equal(tenant.posts.length, postsBefore, 'a second run sends no create');
  assert.equal(journal.rows.length, journalBefore, 'a second run journals no write');
  assert.equal(second.applied.length, 500);
  assert.ok(second.applied.every((entry) => entry.resumed === true));
  assert.deepEqual(second.applied.map((entry) => entry.targetId), first.applied.map((entry) => entry.targetId));
}

// 3. An update whose target already holds the desired state is not written,
//    whether the plan's live read says so or a resumed run reads it fresh.
{
  const tenant = fakeTenant();
  tenant.objects.set('group-a', { id: 'group-a', displayName: 'KEEL-RT-same', mailNickname: 'KEEL-RT-same' });
  tenant.objects.set('group-b', { id: 'group-b', displayName: 'KEEL-RT-old', mailNickname: 'KEEL-RT-diff' });
  const same = {
    naturalKey: 'group:KEEL-RT-same', resourceType: 'group', verb: 'update', targetId: 'group-a', blastRadius: 'access-affecting',
    references: [], payload: { displayName: 'KEEL-RT-same', mailNickname: 'KEEL-RT-same' },
    live: { targetId: 'group-a', payload: { id: 'group-a', displayName: 'KEEL-RT-same', mailNickname: 'KEEL-RT-same' } },
  };
  const diff = {
    naturalKey: 'group:KEEL-RT-diff', resourceType: 'group', verb: 'update', targetId: 'group-b', blastRadius: 'access-affecting',
    references: [], payload: { displayName: 'KEEL-RT-new', mailNickname: 'KEEL-RT-diff' },
    live: { targetId: 'group-b', payload: { id: 'group-b', displayName: 'KEEL-RT-old', mailNickname: 'KEEL-RT-diff' } },
  };
  const journal = memoryJournal();
  const first = await run(tenant, [same, diff], { rollbackClient: journal });
  assert.deepEqual(first.failed, []);
  assert.deepEqual(tenant.patches, ['group-b'], 'only the update that changes something is written');
  assert.equal(first.applied.find((entry) => entry.naturalKey === same.naturalKey).unchanged, true);

  // Rerun the same run: the plan still says group-b is old, but a fresh read says
  // it already holds the desired state.
  const second = await run(tenant, [same, diff], { rollbackClient: journal });
  assert.deepEqual(second.failed, []);
  assert.deepEqual(tenant.patches, ['group-b'], 'the rerun writes nothing');
  assert.equal(second.applied.find((entry) => entry.naturalKey === diff.naturalKey).resumed, true);
}

// 4. A run killed mid-wave resumes with no duplicate writes. The kill leaves the
//    writes in flight unanswered (they landed, nobody heard); those are never
//    sent again and are reported for a person to check.
{
  const wave = groups(500);
  const tenant = fakeTenant();
  const journal = memoryJournal();
  run(tenant, wave, { rollbackClient: journal, writer: { hangAfter: 200 } }); // killed: never settles
  // Wait until the killed run has gone quiet: every worker is stuck on a write.
  for (let seen = -1; seen !== tenant.posts.length || seen < 200;) {
    seen = tenant.posts.length;
    await delay(50);
  }
  const landedAtKill = tenant.posts.length;
  assert.ok(landedAtKill >= 200 && landedAtKill <= 200 + DEFAULT_WAVE_CONCURRENCY, `posts at kill: ${landedAtKill}`);

  const resumed = await run(tenant, wave, { rollbackClient: journal, writer: { hangAfter: Infinity } });
  const sent = tenant.posts.reduce((counts, nick) => counts.set(nick, (counts.get(nick) ?? 0) + 1), new Map());
  assert.ok([...sent.values()].every((count) => count === 1), 'no group was created twice');
  assert.equal(sent.size, 500, 'every group was created exactly once');
  assert.equal(tenant.objects.size, 500);

  const unanswered = landedAtKill - 199;
  assert.equal(resumed.failed.length, unanswered, 'only the writes the kill left unanswered need a person');
  assert.ok(resumed.failed.every((failure) => /^resume: an earlier attempt of this run to create /.test(failure.error)));
  assert.equal(resumed.applied.length, 500 - unanswered);
  assert.equal(resumed.applied.filter((entry) => entry.resumed).length, 199, 'what finished before the kill is not written again');
}

// 5. Retry-After pauses every concurrent write on the bucket, not just the one
//    that was throttled, and the throttled write is retried once.
{
  const sleeps = [];
  let throttled = false;
  let attempts = 0;
  const objects = new Map();
  const writer = {
    async write(version, path, { body }) {
      attempts += 1;
      await delay(1);
      if (!throttled) { throttled = true; return { ok: false, status: 429, retryAfter: 30, body: { error: 'throttled' } }; }
      const id = `group-${attempts}`;
      objects.set(id, { id, ...body });
      return { ok: true, status: 201, body: { id, ...body } };
    },
    async read(version, path) {
      const object = objects.get(path.split('/').at(-1));
      return object ? { ok: true, status: 200, body: object } : { ok: false, status: 404, body: null };
    },
  };
  const result = await applyWave(writer, roomyGovernor(), groups(6), {
    targetTenant: TENANT, mode: 'enforce', concurrency: 2,
    throttleRetryOptions: { sleep: async (seconds) => { sleeps.push(seconds); } },
  });
  assert.equal(result.applied.length, 6);
  assert.equal(attempts, 7, 'six creates and one retry');
  assert.equal(sleeps[0], 30, 'the throttled write waits its Retry-After');
  assert.ok(sleeps.length >= 2 && sleeps.slice(1).every((seconds) => seconds > 29 && seconds <= 30),
    `the other write waits out the same pause: ${JSON.stringify(sleeps)}`);
}

// 6. The governor keeps the pause, and an injected clock ends it.
{
  let now = 1_000_000;
  const governor = new ThrottleGovernor({ [`${TENANT}/entra/write`]: { capacity: 5, refillPerSecond: 5 } }, { now: () => now });
  assert.equal(governor.pauseRemainingSeconds(TENANT, 'entra', 'write'), 0);
  governor.observeRetryAfter(TENANT, 'entra', 'write', 10);
  assert.equal(governor.pauseRemainingSeconds(TENANT, 'entra', 'write'), 10);
  now += 4000;
  assert.equal(governor.pauseRemainingSeconds(TENANT, 'entra', 'write'), 6);
  now += 7000;
  assert.equal(governor.pauseRemainingSeconds(TENANT, 'entra', 'write'), 0);
}

// 7. Sign-in path resources never run alongside each other: two tenant-lockout
//    resources in one wave are written one after the other.
{
  let inFlight = 0;
  let peak = 0;
  const writer = {
    async write(version, path, { body }) {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight -= 1;
      return { ok: true, status: 201, body: { id: `id-${body.mailNickname}`, ...body } };
    },
    async read(version, path) {
      const nick = path.split('/').at(-1).replace(/^id-/, '');
      return { ok: true, status: 200, body: { id: `id-${nick}`, displayName: nick, mailNickname: nick, mailEnabled: false, securityEnabled: true } };
    },
  };
  const wave = groups(3).map((resource) => ({ ...resource, blastRadius: 'tenant-lockout' }));
  const result = await applyWave(writer, roomyGovernor(), wave, { targetTenant: TENANT, mode: 'enforce' });
  assert.equal(result.applied.length, 3);
  assert.equal(peak, 1, 'lockout-sensitive writes run one at a time');
}

console.log('fasterRestore.test.mjs — all assertions passed');
