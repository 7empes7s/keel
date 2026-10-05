import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { tick, enqueueSchedule, schedulerPrincipal } from './keel-scheduler.mjs';
import { enqueue, claimNext, complete, fail, listJobs } from '../engine/jobs/queue.mjs';
import { capabilitiesForPrincipal } from '../engine/authz/principals.mjs';
import { nextDueAt, validateSchedule, updateSchedule } from '../engine/schedules/cadence.mjs';
import { processCollectionCompletions } from '../engine/schedules/completions.mjs';
import { verifyFreshManifest, recordShippedManifest } from '../engine/schedules/offsite.mjs';
import { localTimeToUTC, utcTimeToLocal } from '../engine/schedules/timeOfDay.mjs';
import { JOB_HANDLERS, runJob } from './keel-worker.mjs';

const exec = promisify(execFile);
const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
const directory = await mkdtemp(join(tmpdir(), 'keel-scheduler-'));
try {
  await client.query(await readFile(new URL('../engine/store/schema.sql', import.meta.url), 'utf8'));
  const principal = await schedulerPrincipal(client);
  const due = new Date('2026-09-14T00:00:00Z');
  const row = (await client.query(`INSERT INTO schedule (tenant_ref, job_kind, tier, cadence, next_due_at)
    VALUES ('fixture', 'collect', 'tier1', '{"every":"hour","n":1,"atTime":null}', $1) RETURNING *`, [due])).rows[0];
  const clearJobs = async () => {
    await client.query('UPDATE schedule SET last_job_id = NULL');
    await client.query('DELETE FROM job');
  };

  await test('timer calendar fires every five minutes across midnight and invokes the scheduler service', async () => {
    const timer = await readFile(new URL('../ops/keel-scheduler.timer', import.meta.url), 'utf8');
    const calendars = [...timer.matchAll(/^OnCalendar=(.+)$/gm)].map((match) => match[1]);
    assert.equal(calendars.length, 1);
    // Ask systemd's calendar evaluator; do not start or install a timer/service.
    const { stdout } = await exec('systemd-analyze', ['calendar',
      '--base-time=2026-09-14 23:58:00 UTC', '--iterations=3', calendars[0]],
    { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
    const firings = [...stdout.matchAll(/(?:Next elapse|Iteration #\d+): (.+)/g)]
      .map((match) => new Date(match[1]).toISOString());
    assert.deepEqual(firings, ['2026-09-15T00:00:00.000Z', '2026-09-15T00:05:00.000Z', '2026-09-15T00:10:00.000Z']);
    assert.match(timer, /^Unit=keel-scheduler\.service$/m);
    const service = await readFile(new URL('../ops/keel-scheduler.service', import.meta.url), 'utf8');
    assert.match(service, /^ExecStart=\/usr\/bin\/node \/opt\/keel\/cli\/keel-scheduler\.mjs$/m);
  });

  await test('scheduler identity has exactly two capabilities; disabled identity is refused', async () => {
    assert.deepEqual((await capabilitiesForPrincipal(client, principal)).sort(), ['collect', 'configuration']);
    await client.query('UPDATE principal SET disabled_at = now() WHERE id = $1', [principal.id]);
    await assert.rejects(() => tick(client, { now: due }), /exactly collect/);
    await client.query('UPDATE principal SET disabled_at = NULL WHERE id = $1', [principal.id]);
  });

  await test('two ticks enqueue one job and persisted-due replay uses the same idempotency key', async () => {
    const jobs = await tick(client, { now: due });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].requested_by, principal.id);
    assert.equal((await tick(client, { now: due })).length, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = await enqueueSchedule(client, row, principal.id);
    assert.equal(replay.id, jobs[0].id);
    assert.equal((await listJobs(client)).length, 1);
    assert.equal((await client.query('SELECT next_due_at FROM schedule WHERE id = $1', [row.id])).rows[0].next_due_at.toISOString(), '2026-09-14T01:00:00.000Z');
  });

  await test('crash after creation rolls back both job and due advance, retry loses no tick', async () => {
    await clearJobs();
    await client.query('UPDATE schedule SET next_due_at = $1', [due]);
    await assert.rejects(() => tick(client, { now: due, afterEnqueue: () => { throw new Error('simulated crash'); } }), /simulated crash/);
    assert.equal((await listJobs(client)).length, 0);
    assert.equal((await client.query('SELECT next_due_at FROM schedule')).rows[0].next_due_at.toISOString(), due.toISOString());
    await tick(client, { now: due });
    await tick(client, { now: due });
    assert.equal((await listJobs(client)).length, 1);
  });

  await test('concurrent scheduler connections enqueue one job', async () => {
    await clearJobs();
    await client.query('UPDATE schedule SET next_due_at = $1', [due]);
    const other = await database.connect();
    try { await Promise.all([tick(client, { now: due }), tick(other, { now: due })]); }
    finally { await other.end(); }
    assert.equal((await listJobs(client)).length, 1);
  });

  await test('due selection leaves disabled and future schedules untouched; re-enabling preserves the tick', async () => {
    await clearJobs();
    await client.query('UPDATE schedule SET enabled = false, next_due_at = $1 WHERE id = $2', [due, row.id]);
    const disabled = (await client.query('SELECT * FROM schedule WHERE id = $1', [row.id])).rows[0];
    const future = (await client.query(`INSERT INTO schedule (tenant_ref, job_kind, tier, cadence, next_due_at)
      VALUES ('fixture', 'collect', 'tier2', $1, $2) RETURNING *`, [row.cadence, new Date(due.valueOf() + 60_000)])).rows[0];
    try {
      assert.deepEqual(await tick(client, { now: due }), []);
      assert.equal((await listJobs(client)).length, 0);
      for (const unchanged of [disabled, future]) {
        assert.deepEqual((await client.query('SELECT * FROM schedule WHERE id = $1', [unchanged.id])).rows[0], unchanged);
      }
      await client.query('UPDATE schedule SET enabled = true WHERE id = $1', [row.id]);
      const jobs = await tick(client, { now: due });
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].idempotency_key, `schedule:${row.id}:${due.toISOString()}`);
      assert.equal((await client.query('SELECT * FROM schedule WHERE id = $1', [row.id])).rows[0].last_job_id, jobs[0].id);
    } finally {
      await client.query('DELETE FROM schedule WHERE id = $1', [future.id]);
      await client.query('UPDATE schedule SET enabled = true, next_due_at = $1 WHERE id = $2', [new Date(due.valueOf() + 3_600_000), row.id]);
    }
  });

  await test('late ticks advance from the persisted due instant without losing missed ticks', async () => {
    await clearJobs();
    await client.query('UPDATE schedule SET next_due_at = $1 WHERE id = $2', [due, row.id]);
    const late = new Date(due.valueOf() + 25 * 60_000);
    const jobs = await tick(client, { now: late });
    assert.equal(jobs.length, 1);
    assert.equal((await client.query('SELECT next_due_at FROM schedule WHERE id = $1', [row.id])).rows[0].next_due_at.toISOString(), '2026-09-14T01:00:00.000Z');
    assert.equal((await tick(client, { now: late })).length, 0);
  });

  await test('worker lock covers collect and manual backup in both directions, including stale heartbeat reset', async () => {
    await clearJobs();
    const operator = (await client.query("INSERT INTO principal (email) VALUES ('operator@fixture.invalid') RETURNING *")).rows[0];
    await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'operator')", [operator.id]);
    const script = join(directory, 'collection.mjs');
    await writeFile(script, "setTimeout(() => console.log('fixture collected'), 200);\n");
    for (const [firstKind, secondKind] of [['collect', 'collect'], ['collect', 'backup'], ['backup', 'collect']]) {
      await clearJobs();
      const first = await enqueue(client, { kind: firstKind, requestedBy: operator.id });
      const second = await enqueue(client, { kind: secondKind, requestedBy: operator.id });
      const firstClaim = await claimNext(client, { workerId: 'fixture-a' });
      assert.equal(firstClaim.id, first.id);
      const other = await database.connect();
      let signal;
      const started = new Promise((resolve) => { signal = resolve; });
      const handlers = Object.fromEntries(['collect', 'backup'].map((kind) => [kind, { script, argsFor: () => [] }]));
      const running = runJob(client, firstClaim, { dbUrl: database.url, handlers, onInFlightChange: (value) => { if (value) signal(); } });
      try {
        await started;
        // Even when the job row becomes queued, the live worker's session lock remains.
        await other.query("UPDATE job SET status = 'queued', not_before = now() + interval '1 hour' WHERE id = $1", [first.id]);
        const secondClaim = await claimNext(other, { workerId: 'fixture-b' });
        assert.equal(secondClaim.id, second.id);
        await runJob(other, secondClaim, { dbUrl: database.url, handlers, onInFlightChange: () => assert.fail('overlapping child started') });
        assert.equal((await other.query('SELECT status FROM job WHERE id = $1', [second.id])).rows[0].status, 'queued');
        await running;
        await other.query('UPDATE job SET not_before = now() WHERE id = $1', [second.id]);
        const retry = await claimNext(other, { workerId: 'fixture-b' });
        await runJob(other, retry, { dbUrl: database.url, handlers, onInFlightChange: () => {} });
        assert.equal((await other.query('SELECT status FROM job WHERE id = $1', [second.id])).rows[0].status, 'succeeded');
      } finally { await running; await other.end(); }
    }
  });

  await test('partial complete snapshot visibly defers drift; next successful collect retries exact snapshot once', async () => {
    await clearJobs();
    const snapshot = async (outcome) => (await client.query(`INSERT INTO snapshot (tenant_ref, status, coverage_digest)
      VALUES ('fixture', 'complete', $1) RETURNING *`, [{ 'entra.group': { outcome, itemCount: outcome === 'failed' ? null : 0 } }])).rows[0];
    const partial = await snapshot('failed');
    const failed = await enqueue(client, { kind: 'collect', requestedBy: principal.id, params: { tenantRef: 'fixture' } });
    await client.query("UPDATE job SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [failed.id, `exit code 1\nstdout: snapshot ${partial.id} complete`]);
    await processCollectionCompletions(client, principal.id);
    let drift = (await listJobs(client)).find((job) => job.kind === 'drift-detect');
    assert.equal(drift.status, 'failed');
    assert.match(drift.error, /deferred.*per-type coverage/);
    assert.equal((await client.query('SELECT result FROM job WHERE id = $1', [failed.id])).rows[0].result.driftTrigger.status, 'deferred');
    const full = await snapshot('complete');
    const successful = await enqueue(client, { kind: 'collect', requestedBy: principal.id, params: { tenantRef: 'fixture' } });
    await complete(client, { id: successful.id, result: { stdout: `snapshot ${full.id} complete` } });
    await processCollectionCompletions(client, principal.id);
    await processCollectionCompletions(client, principal.id);
    const queued = (await listJobs(client)).filter((job) => job.kind === 'drift-detect' && job.status === 'queued');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].params.snapshotId, full.id);
    drift = (await client.query('SELECT * FROM job WHERE id = $1', [drift.id])).rows[0];
    assert.equal(drift.result.retriedByJobId, queued[0].id);
    assert.deepEqual(JOB_HANDLERS['drift-detect'].argsFor(queued[0].params), ['detect', '--snapshot-id', full.id, '--tenant-ref', 'fixture']);
    // The real drift CLI must consume the saved snapshot, without reading config or Graph.
    const baseline = (await client.query("INSERT INTO baseline (tenant_ref, label, set_by) VALUES ('fixture', 'fixture', 'fixture') RETURNING *")).rows[0];
    await client.query("UPDATE baseline SET active = true WHERE id = $1", [baseline.id]);
    // Direct CLI invocation must enforce coverage independently of the scheduler.
    // A valid active baseline ensures rejection reaches the snapshot coverage gate.
    await assert.rejects(() => exec(process.execPath, ['cli/keel-drift.mjs', 'detect',
      '--snapshot-id', partial.id, '--tenant-ref', 'fixture', '--db-url', database.url],
    { cwd: '/opt/keel' }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /drift-detect deferred: snapshot coverage is incomplete/);
      assert.doesNotMatch(error.stdout, /drift report:|snapshot .* complete/);
      return true;
    });
    assert.equal((await client.query('SELECT count(*)::int AS count FROM drift WHERE observed_snapshot = $1', [partial.id])).rows[0].count, 0);
    const result = await exec(process.execPath, ['cli/keel-drift.mjs', ...JOB_HANDLERS['drift-detect'].argsFor(queued[0].params), '--db-url', database.url], { cwd: '/opt/keel' });
    assert.match(result.stdout, new RegExp(`snapshot ${full.id} complete`));
  });

  await test('tiered empty successes trigger drift only for observed types; incomplete direct CLI inputs are refused', async () => {
    await clearJobs();
    const tenantRef = 'tiered-fixture';
    const baseline = (await client.query("INSERT INTO baseline (tenant_ref, set_by) VALUES ($1, 'fixture') RETURNING *", [tenantRef])).rows[0];
    const digest = { group: { outcome: 'complete-empty', itemCount: 0 }, user: { outcome: 'not-requested', itemCount: null } };
    const snapshot = (await client.query(`INSERT INTO snapshot (tenant_ref, status, coverage_digest)
      VALUES ($1, 'complete', $2) RETURNING *`, [tenantRef, digest])).rows[0];
    for (const type of ['group', 'user']) {
      const version = (await client.query(`INSERT INTO resource_version
        (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
        VALUES ($1, $2, $3, '{}', 'fixture-hash', 'tier1', 'cosmetic', 'full', '{}') RETURNING id`,
      [snapshot.id, `${type}:fixture`, type])).rows[0];
      await client.query('INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) VALUES ($1, $2, $3)', [baseline.id, `${type}:fixture`, version.id]);
    }
    const observed = (await client.query(`INSERT INTO snapshot (tenant_ref, status, coverage_digest)
      VALUES ($1, 'complete', $2) RETURNING *`, [tenantRef, digest])).rows[0];
    const collected = await enqueue(client, { kind: 'collect', requestedBy: principal.id, params: { tenantRef } });
    await complete(client, { id: collected.id, result: { snapshotId: observed.id } });
    await processCollectionCompletions(client, principal.id);
    const driftJob = (await listJobs(client)).find((job) => job.kind === 'drift-detect');
    assert.equal(driftJob.status, 'queued');
    const args = ['cli/keel-drift.mjs', 'detect', '--snapshot-id', observed.id, '--tenant-ref', tenantRef, '--db-url', database.url];
    await exec(process.execPath, args, { cwd: '/opt/keel' });
    const drift = (await client.query('SELECT natural_key, change_type FROM drift WHERE observed_snapshot = $1', [observed.id])).rows;
    assert.deepEqual(drift, [{ natural_key: 'group:fixture', change_type: 'removed' }]);
    for (const incomplete of [
      { group: { outcome: 'partial', itemCount: 1 } },
      { group: { outcome: 'failed', itemCount: null } },
      { group: { outcome: 'not-requested', itemCount: null } },
      { group: { itemCount: 0 } }, {},
    ]) {
      await client.query('UPDATE snapshot SET coverage_digest = $2 WHERE id = $1', [observed.id, incomplete]);
      await assert.rejects(() => exec(process.execPath, args, { cwd: '/opt/keel' }), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /drift-detect deferred: snapshot coverage is incomplete/);
        return true;
      });
    }
  });

  await test('drift retry marks only the scheduling tenant\'s deferred jobs as retried', async () => {
    await clearJobs();
    // Seed tenant B's own deferred drift-detect job directly, mirroring exactly what
    // processCollectionCompletions writes for a failed/partial collection.
    const otherTenantDeferred = await enqueue(client, {
      kind: 'drift-detect', requestedBy: principal.id,
      params: { tenantRef: 'tenant-b', snapshotId: null, sourceCollectionId: null },
      idempotencyKey: 'fixture:tenant-b-deferred',
    });
    await fail(client, {
      id: otherTenantDeferred.id,
      error: 'drift-detect deferred: collection snapshot has failed or missing per-type coverage; retry on next successful collect',
    });
    const fullA = (await client.query(`INSERT INTO snapshot (tenant_ref, status, coverage_digest)
      VALUES ('tenant-a', 'complete', $1) RETURNING *`, [{ 'entra.group': { outcome: 'complete', itemCount: 0 } }])).rows[0];
    const collectA = await enqueue(client, { kind: 'collect', requestedBy: principal.id, params: { tenantRef: 'tenant-a' } });
    await complete(client, { id: collectA.id, result: { snapshotId: fullA.id } });
    await processCollectionCompletions(client, principal.id);
    const untouched = (await client.query('SELECT * FROM job WHERE id = $1', [otherTenantDeferred.id])).rows[0];
    assert.equal(untouched.result?.retriedByJobId, undefined);
  });

  await test('collection completion refuses a snapshot whose tenant differs from the collect job\'s tenant', async () => {
    await clearJobs();
    const otherTenantSnapshot = (await client.query(`INSERT INTO snapshot (tenant_ref, status, coverage_digest)
      VALUES ('tenant-b', 'complete', $1) RETURNING *`, [{ 'entra.group': { outcome: 'complete', itemCount: 0 } }])).rows[0];
    const jobForTenantA = await enqueue(client, { kind: 'collect', requestedBy: principal.id, params: { tenantRef: 'tenant-a' } });
    await complete(client, { id: jobForTenantA.id, result: { snapshotId: otherTenantSnapshot.id } });
    await processCollectionCompletions(client, principal.id);
    const drift = (await listJobs(client)).find((job) => job.kind === 'drift-detect');
    assert.equal(drift.status, 'failed');
    assert.match(drift.error, /deferred.*per-type coverage/);
  });

  await test('keel-drift CLI refuses a --snapshot-id belonging to a different tenant than --tenant-ref', async () => {
    const baseline = (await client.query(
      "INSERT INTO baseline (tenant_ref, label, set_by) VALUES ('tenant-a', 'fixture', 'fixture') RETURNING *",
    )).rows[0];
    await client.query('UPDATE baseline SET active = true WHERE id = $1', [baseline.id]);
    const otherTenantSnapshot = (await client.query(`INSERT INTO snapshot (tenant_ref, status, coverage_digest)
      VALUES ('tenant-b', 'complete', $1) RETURNING *`, [{ 'entra.group': { outcome: 'complete', itemCount: 0 } }])).rows[0];
    await assert.rejects(() => exec(process.execPath, ['cli/keel-drift.mjs', 'detect',
      '--snapshot-id', otherTenantSnapshot.id, '--tenant-ref', 'tenant-a', '--db-url', database.url],
    { cwd: '/opt/keel' }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /drift-detect deferred: snapshot coverage is incomplete/);
      return true;
    });
  });

  await test('offsite rejects stale/equal manifests, verifies checksums, and records only successful shipment', async () => {
    const dump = join(directory, 'keel-db.sql.gz');
    const manifestPath = join(directory, 'keel-db-manifest.json');
    const shippedPath = join(directory, 'keel-db-shipped-manifest.json');
    const data = gzipSync(Array.from({ length: 5 }, (_, n) => `COPY public.fixture${n} (id) FROM stdin;\n\\.\n`).join(''));
    await writeFile(dump, data);
    const manifest = { path: dump, checksum: createHash('sha256').update(data).digest('hex'), timestamp: '2026-09-14T05:00:00Z' };
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.deepEqual(await verifyFreshManifest(manifestPath, shippedPath), manifest);
    await recordShippedManifest(manifestPath, shippedPath);
    await assert.rejects(() => verifyFreshManifest(manifestPath, shippedPath), /not newer/);
    await writeFile(manifestPath, JSON.stringify({ ...manifest, timestamp: '2026-09-13T05:00:00Z' }));
    await assert.rejects(() => verifyFreshManifest(manifestPath, shippedPath), /not newer/);
    // Install fake transports before any script/worker invocation, including
    // stale-manifest paths exercised with the freshness guard mutated away.
    await writeFile(join(directory, 'scp'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await writeFile(join(directory, 'ssh'), `#!/bin/sh\ncase "$*" in *sha256sum*) echo '${manifest.checksum} fixture';; esac\n`, { mode: 0o700 });
    // KEEL_OFFSITE_REMOTE selects the SSH transport, so the fake ssh/scp above stand in for the target.
    const env = { ...process.env, KEEL_OFFSITE_BACKUP_ROOT: directory, KEEL_OFFSITE_REMOTE: 'fixture@offsite', PATH: `${directory}:${process.env.PATH}` };
    await assert.rejects(() => exec('bash', ['ops/keel-offsite.sh', '--dry-run'], { env }), (error) => /not newer/.test(error.stderr));
    // A scheduled stale shipment must surface as a failed job, never success.
    await clearJobs();
    await client.query(`INSERT INTO schedule (tenant_ref, job_kind, cadence, next_due_at)
      VALUES ('fixture', 'offsite', '{"every":"day","n":1,"atTime":"05:00"}', $1)`, [due]);
    await tick(client, { now: due });
    const offsiteJob = await claimNext(client, { workerId: 'fixture-offsite' });
    assert.equal(offsiteJob.kind, 'offsite');
    const oldRoot = process.env.KEEL_OFFSITE_BACKUP_ROOT;
    const oldPath = process.env.PATH;
    try {
      process.env.KEEL_OFFSITE_BACKUP_ROOT = directory;
      process.env.PATH = env.PATH;
      await runJob(client, offsiteJob, { dbUrl: database.url, onInFlightChange: () => {} });
    } finally {
      process.env.PATH = oldPath;
      if (oldRoot === undefined) delete process.env.KEEL_OFFSITE_BACKUP_ROOT;
      else process.env.KEEL_OFFSITE_BACKUP_ROOT = oldRoot;
    }
    const flagged = (await client.query('SELECT * FROM job WHERE id = $1', [offsiteJob.id])).rows[0];
    assert.equal(flagged.status, 'failed');
    assert.match(flagged.error, /not newer/);
    await rm(shippedPath);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await exec('bash', ['ops/keel-offsite.sh', '--dry-run'], { env });
    await assert.rejects(() => readFile(shippedPath), { code: 'ENOENT' });
    const fakeEnv = env;
    await exec('bash', ['ops/keel-offsite.sh'], { env: fakeEnv });
    assert.deepEqual(JSON.parse(await readFile(shippedPath)), manifest);
    await assert.rejects(() => exec('bash', ['ops/keel-offsite.sh'], { env: fakeEnv }), (error) => /not newer/.test(error.stderr));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, timestamp: '2026-09-15T05:00:00Z', checksum: '0'.repeat(64) }));
    await assert.rejects(() => verifyFreshManifest(manifestPath, shippedPath), /checksum mismatch/);
  });

  await test('offsite re-checks the dump checksum after initial verification and refuses a dump corrupted in between', async () => {
    // Isolated from `directory`'s shared fake ssh/scp so this test's fake gzip cannot
    // leak into any other test's PATH.
    const workDir = await mkdtemp(join(tmpdir(), 'keel-offsite-toctou-'));
    try {
      const original = gzipSync(Array.from({ length: 5 }, (_, n) => `COPY public.fixture${n} (id) FROM stdin;\n\\.\n`).join(''));
      // A concurrent writer's replacement dump: still a valid gzip stream with enough
      // COPY blocks to pass every check except the checksum-against-manifest recheck.
      const corrupted = gzipSync(Array.from({ length: 5 }, (_, n) => `COPY public.other${n} (id) FROM stdin;\n\\.\n`).join(''));
      const dump = join(workDir, 'keel-db.sql.gz');
      const corruptPath = join(workDir, 'corrupted.sql.gz');
      const manifestPath = join(workDir, 'keel-db-manifest.json');
      await writeFile(dump, original);
      await writeFile(corruptPath, corrupted);
      const manifest = { path: dump, checksum: createHash('sha256').update(original).digest('hex'), timestamp: '2026-09-16T05:00:00Z' };
      await writeFile(manifestPath, JSON.stringify(manifest));
      const { stdout: realGzip } = await exec('which', ['gzip']);
      // Swap the dump for a different-but-still-valid one exactly when the script calls
      // `gzip -t`, i.e. strictly after the manifest tool's own verification already read
      // the original bytes, simulating a writer racing the script's own recheck.
      await writeFile(join(workDir, 'gzip'), `#!/bin/sh\nif [ "$1" = "-t" ]; then cp "${corruptPath}" "$2"; fi\nexec "${realGzip.trim()}" "$@"\n`, { mode: 0o700 });
      const env = { ...process.env, KEEL_OFFSITE_BACKUP_ROOT: workDir, PATH: `${workDir}:${process.env.PATH}` };
      await assert.rejects(() => exec('bash', ['ops/keel-offsite.sh', '--dry-run'], { cwd: '/opt/keel', env }), (error) => {
        assert.match(error.stderr, /dump changed after manifest verification/);
        return true;
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  await test('server rejects fast/clustered cron and invalid structured cadence; accepts UTC boundaries', async () => {
    for (const expression of ['* * * * *', '0,5 * * * *', '55 23 * * *']) {
      const candidate = { ...row, cron_override: expression };
      if (expression === '55 23 * * *') assert.doesNotThrow(() => validateSchedule(candidate));
      else {
        assert.throws(() => validateSchedule(candidate), /schedule_minimum_interval/);
        await assert.rejects(() => updateSchedule(client, principal, row.id, { cron_override: expression }), /schedule_minimum_interval/);
      }
    }
    assert.throws(() => validateSchedule({ ...row, cadence: { every: 'hour', n: 0.1 } }), /invalid structured/);
    assert.throws(() => validateSchedule({ ...row, cron_override: '0,50 0,23 * * *' }), /schedule_minimum_interval/);
    assert.throws(() => validateSchedule({ ...row, job_kind: 'offsite', tier: null, cron_override: '*/30 * * * *' }), /schedule_minimum_interval/);
    assert.throws(() => validateSchedule({ ...row, job_kind: 'backup' }), /not schedulable/);
    assert.throws(() => validateSchedule({ ...row, cron_override: '0 0 31 2 *' }), /no possible firing/);
    assert.equal(nextDueAt({ ...row, cron_override: '0 0 * * MON' }, due).toISOString(), '2026-09-21T00:00:00.000Z');
    const previousTZ = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      assert.equal(localTimeToUTC('05:00', new Date('2026-07-01T12:00Z')), '09:00');
      assert.equal(utcTimeToLocal('09:00', new Date('2026-07-01T12:00Z')), '05:00');
      assert.equal(utcTimeToLocal('09:00', new Date('2026-12-01T12:00Z')), '04:00');
      assert.equal(nextDueAt({ ...row, cadence: { every: 'day', n: 1, atTime: '09:00' } }, new Date('2026-10-31T09:00Z')).toISOString(), '2026-11-01T09:00:00.000Z');
    } finally { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; }
  });

  await test('server rejects mid-cycle cross-day cron clusters even when the cycle boundary is safe', async () => {
    // DOM=2 OR Sunday creates adjacent firing days inside the Gregorian cycle.
    // 23:50 -> 00:00 is ten minutes apart; within-day gaps are >= 50 minutes,
    // and the 2399 -> 2400 cycle wrap is multiple days, so neither catches this.
    const expression = '0,50 0,23 2 * SUN';
    assert.throws(() => validateSchedule({ ...row, cron_override: expression }), /schedule_minimum_interval/);
    const before = (await client.query('SELECT * FROM schedule WHERE id = $1', [row.id])).rows[0];
    await assert.rejects(() => updateSchedule(client, principal, row.id, { cron_override: expression }), /schedule_minimum_interval/);
    assert.deepEqual((await client.query('SELECT * FROM schedule WHERE id = $1', [row.id])).rows[0], before);
    // The same adjacent days are legal when their closest firings meet the floor.
    assert.doesNotThrow(() => validateSchedule({ ...row, cron_override: '0,45 0,23 2 * SUN' }));
  });
} finally {
  await client.end();
  await database.cleanup();
  await rm(directory, { recursive: true, force: true });
}
