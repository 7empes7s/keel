import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineEvent, envelopeForEvidence, envelopeForDrift, envelopeForJob, jobCorrelationId, sourceSequenceGaps, structuredEventLine } from '../telemetry/events.mjs';
import { appendEvidence, verifyChain } from '../govern/evidence.mjs';
import { enqueue, claimNext, resetOrphaned, emitJobEvent } from '../jobs/queue.mjs';
import { runJob } from '../../cli/keel-worker.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
const instant = '2026-09-15T10:00:00.000Z';
const base = { tenantRef: 'fixture', eventType: 'fixture.observed', source: { component: 'fixture' }, correlationId: 'fixture:1', sourceSequence: 1, observedAt: instant };

test('replay identity, distinct sequences, tenant isolation and source gaps', () => {
  const a = defineEvent(base);
  assert.equal(a.eventId, defineEvent({ ...base, emittedAt: '2026-09-16T00:00:00Z' }).eventId);
  const b = defineEvent({ ...base, sourceSequence: 3 });
  assert.notEqual(a.eventId, b.eventId);
  assert.deepEqual(sourceSequenceGaps([b, a, a]), [2]);
  assert.notEqual(a.eventId, defineEvent({ ...base, tenantRef: 'other' }).eventId);
  assert.equal(a.observedAt, instant);
  assert.equal(b.sourceSequence, 3);
  assert.throws(() => sourceSequenceGaps([a, defineEvent({ ...base, tenantRef: 'other' })]), /one tenant/);
});

test('nested secrets and cost metadata cannot leak; cap is enforced independently of identity', () => {
  const payload = { list: [{ headers: { Authorization: 'secret-canary', cookie: 'cookie-canary' } }], text: 'Bearer abcdefghijklmnop', private_key: 'private-canary', large: 'x'.repeat(2000) };
  const a = defineEvent({ ...base, payload, costMetrics: { authorization: 'cost-canary', graphRequests: 4 } });
  const line = structuredEventLine(a);
  for (const secret of ['secret-canary', 'cookie-canary', 'abcdefghijklmnop', 'private-canary', 'cost-canary']) assert.ok(!line.includes(secret));
  assert.equal(a.payload.list[0].headers.Authorization, '[redacted]');
  const capped = defineEvent({ ...base, payload, maxPayloadBytes: 128 });
  assert.ok(Buffer.byteLength(JSON.stringify(capped.payload)) <= 128);
  assert.equal(capped.eventId, a.eventId);
  assert.equal(capped.capture.truncated, true);
  assert.throws(() => defineEvent({ ...base, maxPayloadBytes: 1 }), /maxPayloadBytes/);
});

test('job, evidence and drift projections keep replay identity and never collapse distinct sequences', () => {
  const jobRow = {
    id: 'job-1', tenant_ref: 'fixture', kind: 'collect', status: 'running',
    worker_id: 'fixture-worker', requested_by: 'missing', idempotency_key: 'once',
    params: { tenantRef: 'fixture' }, created_at: '2026-09-15T09:00:00.000Z',
    started_at: '2026-09-15T09:00:01.000Z',
    event_started_at: '2026-09-15 09:00:01.000000+00',
  };
  // Replay stability: projecting the SAME row twice yields the SAME event id,
  // even though each projection stamps its own emittedAt.
  const replayA = envelopeForJob(jobRow, { eventType: 'job.running' });
  const replayB = envelopeForJob(jobRow, { eventType: 'job.running' });
  assert.notEqual(replayA.emittedAt, undefined);
  assert.equal(replayA.eventId, replayB.eventId);
  // Distinct source sequences never collapse into one event id.
  const attempt1 = envelopeForJob({ ...jobRow, attempt_count: 1 }, { eventType: 'job.running' });
  const attempt2 = envelopeForJob({ ...jobRow, attempt_count: 2 }, { eventType: 'job.running' });
  assert.equal(attempt1.sourceSequence, 1);
  assert.equal(attempt2.sourceSequence, 2);
  assert.notEqual(attempt1.eventId, attempt2.eventId);
  // Distinct per-attempt source starts never collapse either: these two rows
  // differ ONLY in event_started_at, so only the source event identity can
  // keep their event ids apart.
  const started1 = envelopeForJob({ ...jobRow, event_started_at: '2026-09-15 09:00:01.000000+00' }, { eventType: 'job.running' });
  const started2 = envelopeForJob({ ...jobRow, event_started_at: '2026-09-15 09:00:02.000000+00' }, { eventType: 'job.running' });
  assert.equal(started1.observedAt, started2.observedAt);
  assert.notEqual(started1.eventId, started2.eventId);
  // The emission path replays identically too: two emits of the same row
  // through a capture sink carry the same deterministic id, and a throwing
  // sink cannot break the caller.
  const emitted = [];
  emitJobEvent(jobRow, 'job.running', (e) => emitted.push(e));
  emitJobEvent(jobRow, 'job.running', (e) => emitted.push(e));
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].eventId, emitted[1].eventId);
  assert.equal(emitted[0].eventId, replayA.eventId);
  assert.doesNotThrow(() => emitJobEvent(jobRow, 'job.running', () => { throw new Error('sink boom'); }));
  // Evidence replay stability and distinct chain sequences.
  const evidenceRow = { tenant_ref: 'fixture', kind: 'change', seq: '7', occurred_at: instant, subject: {}, record_hash: 'hash' };
  assert.equal(envelopeForEvidence(evidenceRow).eventId, envelopeForEvidence(evidenceRow).eventId);
  assert.notEqual(envelopeForEvidence(evidenceRow).eventId,
    envelopeForEvidence({ ...evidenceRow, seq: '8' }).eventId);
  // Drift replay stability.
  const drift = { id: 'drift-1', tenant_ref: 'fixture', detected_at: instant };
  assert.equal(envelopeForDrift(drift).eventId, envelopeForDrift(drift).eventId);
});

test('legacy evidence and drift preserve identity and source times', () => {
  const row = { tenant_ref: 'fixture', kind: 'change', seq: '7', occurred_at: instant, subject: {}, record_hash: 'hash' };
  assert.equal(envelopeForEvidence(row).sourceSequence, 7);
  assert.equal(envelopeForEvidence(row).observedAt, instant);
  const drift = { id: 'drift-1', tenant_ref: 'fixture', detected_at: instant };
  assert.notEqual(envelopeForDrift(drift).eventId, envelopeForDrift({ ...drift, id: 'drift-2' }).eventId);
  assert.equal(envelopeForDrift(drift).sourceSequence, null);
});

test('real queue retry, worker authorization and durable evidence correlation', async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    const queued = await enqueue(client, { kind: 'collect', params: { tenantRef: 'fixture' }, requestedBy: 'missing', idempotencyKey: 'once' });
    assert.equal((await enqueue(client, { kind: 'collect', requestedBy: 'missing', idempotencyKey: 'once' })).id, queued.id);
    const first = await claimNext(client, { workerId: 'fixture-worker' });
    await client.query('UPDATE job SET heartbeat_at = NULL WHERE id = $1', [first.id]);
    await resetOrphaned(client);
    const retry = await claimNext(client, { workerId: 'fixture-worker' });
    const a = envelopeForJob(first, { eventType: 'job.running' });
    const b = envelopeForJob(retry, { eventType: 'job.running' });
    assert.equal(a.correlationId, b.correlationId);
    assert.notEqual(a.eventId, b.eventId);
    const emitted = [];
    await appendEvidence(client, { tenantRef: 'fixture', kind: 'fixture', subject: { headers: { authorization: 'db-canary' } }, actor: 'fixture', correlationId: b.correlationId, eventSink: e => emitted.push(e) });
    const { rows: [row] } = await client.query('SELECT * FROM evidence WHERE tenant_ref = $1', ['fixture']);
    assert.ok(!JSON.stringify(row).includes('db-canary'));
    assert.equal(envelopeForEvidence(row).correlationId, b.correlationId);
    assert.equal(envelopeForEvidence(row).eventId, emitted[0].eventId);
    assert.deepEqual(await verifyChain(client, { tenantRef: 'fixture' }), { ok: true });
    const events = [];
    await runJob(client, retry, { dbUrl: db.url, onInFlightChange() {}, eventSink: e => events.push(e) });
    assert.equal(events.at(-1).eventType, 'job.failed');
    assert.equal(events.at(-1).correlationId, b.correlationId);
    assert.equal((await client.query('SELECT status FROM job WHERE id = $1', [retry.id])).rows[0].status, 'failed');
    const { rows: [admin] } = await client.query("INSERT INTO principal (email) VALUES ('fixture@example.invalid') RETURNING *");
    await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'operator')", [admin.id]);
    await enqueue(client, { kind: 'collect', params: { tenantRef: 'fixture' }, requestedBy: admin.id });
    const authorized = await claimNext(client, { workerId: 'fixture-worker', eventSink: e => events.push(e) });
    const directory = mkdtempSync(join(tmpdir(), 'keel-event-fixture-'));
    try {
      const script = join(directory, 'child.mjs');
      writeFileSync(script, `import { connect } from ${JSON.stringify(new URL('../store/db.mjs', import.meta.url).href)};
        import { appendEvidence } from ${JSON.stringify(new URL('../govern/evidence.mjs', import.meta.url).href)};
        const db = await connect(process.argv[process.argv.indexOf('--db-url') + 1]);
        try { await appendEvidence(db, { tenantRef: 'fixture', kind: 'child', subject: {}, actor: 'fixture' }); }
        finally { await db.end(); }`);
      await runJob(client, authorized, { dbUrl: db.url, onInFlightChange() {}, eventSink: e => events.push(e), handlers: { collect: { script, argsFor: () => [] } } });
      assert.equal(events.at(-1).eventType, 'job.succeeded');
      const { rows: [childEvidence] } = await client.query("SELECT * FROM evidence WHERE kind = 'child'");
      assert.equal(envelopeForEvidence(childEvidence).correlationId, events.at(-1).correlationId);
      assert.deepEqual(await verifyChain(client, { tenantRef: 'fixture' }), { ok: true });
    } finally { rmSync(directory, { recursive: true, force: true }); }

  } finally { await client.end(); await db.cleanup(); }
});

test('claimNext emits job.claimed through the sink, and only when it actually claims a job', async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    const emptyQueueEvents = [];
    assert.equal(
      await claimNext(client, { workerId: 'fixture-worker', eventSink: e => emptyQueueEvents.push(e) }),
      null,
    );
    assert.deepEqual(emptyQueueEvents, []);

    const queued = await enqueue(client, { kind: 'collect', params: { tenantRef: 'fixture' }, requestedBy: 'missing' });
    const claimedEvents = [];
    const claimed = await claimNext(client, { workerId: 'fixture-worker', eventSink: e => claimedEvents.push(e) });
    assert.equal(claimedEvents.length, 1);
    assert.equal(claimedEvents[0].eventType, 'job.claimed');
    assert.equal(claimedEvents[0].correlationId, jobCorrelationId(claimed));
    assert.equal(claimedEvents[0].payload.jobId, queued.id);
  } finally { await client.end(); await db.cleanup(); }
});

test('runJob emits job.running through the sink, and only once execution actually starts', async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    // A job that fails before dispatch — here its requester resolves to no
    // principal — must not claim to be running: only job.failed is emitted.
    await enqueue(client, { kind: 'collect', params: { tenantRef: 'fixture' }, requestedBy: 'missing' });
    const unrun = await claimNext(client, { workerId: 'fixture-worker' });
    const unrunEvents = [];
    await runJob(client, unrun, { dbUrl: db.url, onInFlightChange() {}, eventSink: (e) => unrunEvents.push(e) });
    assert.ok(!unrunEvents.some((e) => e.eventType === 'job.running'));
    assert.equal(unrunEvents.at(-1).eventType, 'job.failed');

    // An authorized job that dispatches emits exactly one job.running, before
    // its terminal event, correlated to the job and carrying its identity.
    const { rows: [admin] } = await client.query("INSERT INTO principal (email) VALUES ('running-event@example.invalid') RETURNING *");
    await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'operator')", [admin.id]);
    const queued = await enqueue(client, { kind: 'collect', params: { tenantRef: 'fixture' }, requestedBy: admin.id });
    const job = await claimNext(client, { workerId: 'fixture-worker' });
    const directory = mkdtempSync(join(tmpdir(), 'keel-event-running-'));
    try {
      const script = join(directory, 'ok-child.mjs');
      writeFileSync(script, 'process.exit(0);\n');
      const events = [];
      await runJob(client, job, {
        dbUrl: db.url,
        onInFlightChange() {},
        eventSink: (e) => events.push(e),
        handlers: { collect: { script, argsFor: () => [] } },
      });
      const runningEvents = events.filter((e) => e.eventType === 'job.running');
      assert.equal(runningEvents.length, 1);
      assert.equal(runningEvents[0].correlationId, jobCorrelationId(job));
      assert.equal(runningEvents[0].payload.jobId, queued.id);
      assert.equal(events.at(-1).eventType, 'job.succeeded');
      assert.ok(events.indexOf(runningEvents[0]) < events.length - 1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  } finally { await client.end(); await db.cleanup(); }
});

test('a throwing event sink cannot roll back or hide already-committed evidence', async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    const throwingSink = () => { throw new Error('sink boom'); };
    const record = await appendEvidence(client, {
      tenantRef: 'fixture', kind: 'fixture', subject: {}, actor: 'fixture', eventSink: throwingSink,
    });
    assert.ok(record);
    const { rows: [row] } = await client.query('SELECT * FROM evidence WHERE tenant_ref = $1', ['fixture']);
    assert.equal(row.seq, record.seq);
    assert.equal(row.record_hash, record.record_hash);
    assert.deepEqual(await verifyChain(client, { tenantRef: 'fixture' }), { ok: true });
  } finally { await client.end(); await db.cleanup(); }
});

// A failed child process can put credentials in its stderr (a Postgres connection
// string, an Authorization header, a bearer token from a failed Graph call). The
// worker must never persist or print that raw text: job.error and the console
// line are redacted through redactPayload before they leave the process.
test('secret-bearing job failure is redacted in the stored error, console output and event stream', async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    const { rows: [admin] } = await client.query("INSERT INTO principal (email) VALUES ('fail-redact@example.invalid') RETURNING *");
    await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'operator')", [admin.id]);
    await enqueue(client, { kind: 'collect', params: { tenantRef: 'fixture' }, requestedBy: admin.id });
    const job = await claimNext(client, { workerId: 'fixture-worker', eventSink: () => {} });
    const directory = mkdtempSync(join(tmpdir(), 'keel-event-redact-'));
    try {
      const bearer = 'zq9mw8e7x2cvbn3asdfg1234';
      const dsnPassword = 'PgS3cr3tCanary';
      const dsnHost = 'db.internal.example';
      const script = join(directory, 'leaky-child.mjs');
      writeFileSync(script, `console.error(${JSON.stringify(
        `Graph request failed: Authorization: Bearer ${bearer} via postgres://keel-collector:${dsnPassword}@${dsnHost}:5432/keel`,
      )}); process.exit(1);`);
      const consoleErrors = [];
      const originalError = console.error;
      console.error = (...args) => { consoleErrors.push(args.join(' ')); };
      const events = [];
      try {
        await runJob(client, job, {
          dbUrl: db.url,
          onInFlightChange() {},
          eventSink: (e) => events.push(e),
          handlers: { collect: { script, argsFor: () => [] } },
        });
      } finally { console.error = originalError; }
      const { rows: [failed] } = await client.query('SELECT status, error FROM job WHERE id = $1', [job.id]);
      assert.equal(failed.status, 'failed');
      assert.ok(failed.error.includes('[redacted]'), `job.error was not redacted: ${failed.error}`);
      assert.equal(events.at(-1).eventType, 'job.failed');
      const eventStream = JSON.stringify(events);
      for (const canary of [bearer, dsnPassword, dsnHost]) {
        assert.ok(!failed.error.includes(canary), `job.error leaked: ${canary}`);
        assert.ok(!consoleErrors.some((line) => line.includes(canary)), `console.error leaked: ${canary}`);
        assert.ok(!eventStream.includes(canary), `event stream leaked: ${canary}`);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  } finally { await client.end(); await db.cleanup(); }
});
