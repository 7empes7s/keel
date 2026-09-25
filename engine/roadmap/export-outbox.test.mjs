import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defineEvent } from '../telemetry/events.mjs';
import {
  RECEIVER_DEDUP_CONTRACT,
  receiverDedupKey,
  retryDelayMs,
  registerDestination,
  revokeDestination,
  resumeDestination,
  listDestinations,
  enqueueEvent,
  drainDestination,
  drainDueDestinations,
  requestReplay,
  outboxStatus,
} from '../telemetry/outbox.mjs';
import { SIEM_ADAPTERS, drainSiemOutbox } from '../../cli/keel-worker.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const SCHEMA = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
// Envelope source times are fixed fixture instants; the drain clock must sit AFTER the
// database's real now() so freshly enqueued rows (next_attempt_at = now()) are due.
const T0 = '2026-09-15T10:00:00.000Z';
const NOW = new Date(Date.now() + 60 * 1000);

function fixtureEnvelope(tenantRef, n) {
  return defineEvent({
    tenantRef,
    eventType: 'fixture.observed',
    source: { component: 'fixture' },
    correlationId: 'fixture:1',
    sourceSequence: n,
    observedAt: new Date(new Date(T0).getTime() + n * 1000).toISOString(),
  });
}

// Recording fake sink: the production drain path drives it through the same adapter
// contract the real task-80/81 adapters will implement. Fixture-tested only.
function fakeSink(behaviour = () => 'accepted') {
  const deliveries = [];
  return {
    deliveries,
    adapter: {
      async deliver(call) {
        deliveries.push(call);
        return behaviour(call);
      },
    },
  };
}

async function setup(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  await client.query(SCHEMA);
  const { rows: [admin] } = await client.query(
    "INSERT INTO principal (email) VALUES ('outbox-admin@example.invalid') RETURNING *",
  );
  await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'admin')", [admin.id]);
  const { rows: [viewer] } = await client.query(
    "INSERT INTO principal (email) VALUES ('outbox-viewer@example.invalid') RETURNING *",
  );
  await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'viewer')", [viewer.id]);
  return { db, client, admin, viewer };
}

async function fixtureDestination(client, admin, { tenantRef = 'fixture', name = 'sink-1', kind = 'fixture-sink' } = {}) {
  return registerDestination(client, {
    tenantRef, name, kind,
    config: { endpointRef: 'vault:siem/sink-1' },
    requestedBy: admin.id,
  });
}

test('enqueue dedups by source event id; acceptance advances the checkpoint only after the ack', async (t) => {
  const { client, admin, viewer } = await setup(t);
  const destination = await fixtureDestination(client, admin);
  const envelope = fixtureEnvelope('fixture', 1);

  const first = await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope });
  assert.equal(first.inserted, true);
  const replay = await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope });
  assert.equal(replay.inserted, false);
  assert.equal(replay.event.id, first.event.id);
  assert.equal(replay.event.event_id, envelope.eventId);

  const sink = fakeSink();
  const summary = await drainDestination(client, { destinationId: destination.id, adapter: sink.adapter, now: NOW });
  assert.equal(summary.status, 'drained');
  assert.equal(summary.delivered, 1);
  assert.equal(sink.deliveries.length, 1);
  assert.equal(sink.deliveries[0].eventId, envelope.eventId);
  assert.equal(
    sink.deliveries[0].dedupKey,
    receiverDedupKey({ tenantRef: 'fixture', destinationId: destination.id, eventId: envelope.eventId }),
  );

  const { rows: [row] } = await client.query('SELECT * FROM siem_outbox_event WHERE id = $1', [first.event.id]);
  assert.equal(row.status, 'acknowledged');
  const { rows: [checkpoint] } = await client.query(
    'SELECT * FROM siem_replay_checkpoint WHERE destination_id = $1', [destination.id]);
  assert.equal(Number(checkpoint.last_acknowledged_seq), Number(first.event.outbox_seq));
  assert.equal(checkpoint.last_acknowledged_event_id, envelope.eventId);

  // Nothing due afterwards; the acked event is not redelivered.
  const again = await drainDestination(client, { destinationId: destination.id, adapter: sink.adapter, now: NOW });
  assert.equal(again.delivered, 0);
  assert.equal(sink.deliveries.length, 1);

  const status = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(status.acknowledged, 1);
  assert.equal(status.pending, 0);
  assert.equal(status.lagMs, null);
  assert.equal(status.checkpoint.lastAcknowledgedSeq, Number(first.event.outbox_seq));
});

test('uncertain acknowledgement (crash after remote acceptance before checkpoint) replays the same event id', async (t) => {
  const { client, admin } = await setup(t);
  const destination = await fixtureDestination(client, admin);
  const envelope = fixtureEnvelope('fixture', 1);
  const { event } = await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope });

  // First delivery: the sink HAS accepted remotely, but the acknowledgement is lost
  // before the checkpoint commit can be trusted — modelled as an uncertain outcome.
  let calls = 0;
  const sink = fakeSink(() => { calls += 1; return calls === 1 ? { outcome: 'uncertain' } : 'accepted'; });
  const first = await drainDestination(client, { destinationId: destination.id, adapter: sink.adapter, now: NOW });
  assert.equal(first.uncertain, 1);
  assert.equal(first.delivered, 0);

  const { rows: [midRow] } = await client.query('SELECT * FROM siem_outbox_event WHERE id = $1', [event.id]);
  assert.equal(midRow.status, 'pending');
  assert.equal(midRow.attempts, 1);
  const { rows: [midCheckpoint] } = await client.query(
    'SELECT * FROM siem_replay_checkpoint WHERE destination_id = $1', [destination.id]);
  assert.equal(Number(midCheckpoint.last_acknowledged_seq), 0);

  // Backoff is durable and visible; an immediate second drain does not redeliver.
  const early = await drainDestination(client, { destinationId: destination.id, adapter: sink.adapter, now: NOW });
  assert.equal(early.delivered + early.uncertain + early.retried, 0);
  assert.equal(sink.deliveries.length, 1);

  // After the backoff expires the SAME event id is redelivered; the receiver dedups.
  const later = new Date(NOW.getTime() + retryDelayMs(1) + 1000);
  const second = await drainDestination(client, { destinationId: destination.id, adapter: sink.adapter, now: later });
  assert.equal(second.delivered, 1);
  assert.equal(sink.deliveries.length, 2);
  assert.equal(sink.deliveries[1].eventId, envelope.eventId);
  assert.equal(sink.deliveries[0].dedupKey, sink.deliveries[1].dedupKey);
  const { rows: [doneCheckpoint] } = await client.query(
    'SELECT * FROM siem_replay_checkpoint WHERE destination_id = $1', [destination.id]);
  assert.equal(Number(doneCheckpoint.last_acknowledged_seq), Number(event.outbox_seq));
});

test('malformed adapter outcomes remain uncertain without advancing the checkpoint', async (t) => {
  const { client, admin, viewer } = await setup(t);
  const malformed = [undefined, null, {}, { outcome: 'unknown' }, 'unknown', true, 42, []];
  for (const [index, outcome] of malformed.entries()) {
    const destination = await fixtureDestination(client, admin, { name: `malformed-${index}` });
    const envelope = fixtureEnvelope('fixture', index + 1);
    const { event } = await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope });
    const summary = await drainDestination(client, {
      destinationId: destination.id, adapter: fakeSink(() => outcome).adapter, now: NOW,
    });
    assert.equal(summary.uncertain, 1);
    assert.equal(summary.delivered, 0);
    const { rows: [row] } = await client.query('SELECT * FROM siem_outbox_event WHERE id = $1', [event.id]);
    assert.equal(row.status, 'pending');
    assert.equal(row.event_id, envelope.eventId);
    assert.equal(row.attempts, 1);
    assert.ok(new Date(row.next_attempt_at) > NOW);
    const status = await outboxStatus(client, {
      tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
    });
    assert.equal(status.checkpoint.lastAcknowledgedSeq, 0);
    const sink = fakeSink();
    await drainDestination(client, {
      destinationId: destination.id, adapter: sink.adapter,
      now: new Date(NOW.getTime() + retryDelayMs(1) + 1000),
    });
    assert.equal(sink.deliveries.length, 1);
    assert.equal(sink.deliveries[0].eventId, envelope.eventId);
  }
});

test('retry backoff is durable and exhausted attempts quarantine without dropping the event', async (t) => {
  const { client, admin } = await setup(t);
  const destination = await fixtureDestination(client, admin);
  const envelope = fixtureEnvelope('fixture', 1);
  const { event } = await enqueueEvent(client, {
    tenantRef: 'fixture', destinationId: destination.id, envelope, maxAttempts: 3,
  });

  const sink = fakeSink(() => ({ outcome: 'retry', error: 'fixture throttled' }));
  let now = NOW;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const summary = await drainDestination(client, { destinationId: destination.id, adapter: sink.adapter, now });
    if (attempt < 3) {
      assert.equal(summary.retried, 1);
      const { rows: [row] } = await client.query('SELECT * FROM siem_outbox_event WHERE id = $1', [event.id]);
      assert.equal(row.status, 'pending');
      assert.equal(row.attempts, attempt);
      assert.ok(new Date(row.next_attempt_at) > now);
      assert.equal(row.event_id, envelope.eventId);
    } else {
      assert.equal(summary.quarantined, 1);
    }
    now = new Date(now.getTime() + retryDelayMs(attempt) + 1000);
  }
  const { rows: [final] } = await client.query('SELECT * FROM siem_outbox_event WHERE id = $1', [event.id]);
  assert.equal(final.status, 'quarantined');
  assert.match(final.quarantine_reason, /max-attempts-exceeded: fixture throttled/);
  assert.equal(final.event_id, envelope.eventId);
});

test('one poison event is quarantined with a reason and does not erase following events', async (t) => {
  const { client, admin, viewer } = await setup(t);
  const destination = await fixtureDestination(client, admin);
  const envelopes = [1, 2, 3].map((n) => fixtureEnvelope('fixture', n));
  for (const envelope of envelopes) {
    await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope });
  }

  const sink = fakeSink(({ eventId }) => (
    eventId === envelopes[1].eventId ? { outcome: 'poison', reason: 'schema rejected by fixture sink' } : 'accepted'
  ));
  const summary = await drainDestination(client, { destinationId: destination.id, adapter: sink.adapter, now: NOW });
  assert.equal(summary.delivered, 2);
  assert.equal(summary.quarantined, 1);
  assert.equal(sink.deliveries.length, 3);

  const { rows } = await client.query(
    'SELECT event_id, status, quarantine_reason FROM siem_outbox_event WHERE destination_id = $1 ORDER BY outbox_seq',
    [destination.id],
  );
  assert.deepEqual(rows.map((row) => row.status), ['acknowledged', 'quarantined', 'acknowledged']);
  assert.equal(rows[1].event_id, envelopes[1].eventId);
  assert.equal(rows[1].quarantine_reason, 'schema rejected by fixture sink');

  // The checkpoint advances past the poisoned event because its successors were
  // genuinely acknowledged; the poisoned row itself remains durably quarantined.
  const status = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(status.quarantined, 1);
  assert.equal(status.acknowledged, 2);
  const { rows: [third] } = await client.query(
    'SELECT outbox_seq FROM siem_outbox_event WHERE event_id = $1', [envelopes[2].eventId]);
  assert.equal(status.checkpoint.lastAcknowledgedSeq, Number(third.outbox_seq));
});

test('a revoked destination pauses delivery; resume restarts it', async (t) => {
  const { client, admin } = await setup(t);
  const destination = await fixtureDestination(client, admin);
  await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope: fixtureEnvelope('fixture', 1) });

  await revokeDestination(client, { tenantRef: 'fixture', destinationId: destination.id, requestedBy: admin.id });
  const sink = fakeSink();
  const paused = await drainDestination(client, { destinationId: destination.id, adapter: sink.adapter, now: NOW });
  assert.equal(paused.status, 'paused');
  assert.equal(sink.deliveries.length, 0);
  const { rows: [row] } = await client.query(
    'SELECT status, attempts FROM siem_outbox_event WHERE destination_id = $1', [destination.id]);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);

  await resumeDestination(client, { tenantRef: 'fixture', destinationId: destination.id, requestedBy: admin.id });
  const resumed = await drainDestination(client, { destinationId: destination.id, adapter: sink.adapter, now: NOW });
  assert.equal(resumed.delivered, 1);
  assert.equal(sink.deliveries.length, 1);
});

test('restart preserves the cursor and the delivery lag (fresh connection, durable tables only)', async (t) => {
  const { db, client, admin, viewer } = await setup(t);
  const destination = await fixtureDestination(client, admin);
  const envelopes = [1, 2].map((n) => fixtureEnvelope('fixture', n));
  for (const envelope of envelopes) {
    await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope });
  }
  const sink = fakeSink(({ eventId }) => (
    eventId === envelopes[0].eventId ? 'accepted' : { outcome: 'uncertain' }));
  await drainDestination(client, { destinationId: destination.id, adapter: sink.adapter, now: NOW });

  // "Restart": a brand-new connection sees the exact durable state — one acked, one
  // pending with its original id, checkpoint at the first event's sequence, and the
  // lag measured from the pending event's observed instant.
  const restarted = await db.connect();
  t.after(() => restarted.end());
  const status = await outboxStatus(restarted, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(status.acknowledged, 1);
  assert.equal(status.pending, 1);
  const { rows: [first] } = await client.query(
    'SELECT outbox_seq FROM siem_outbox_event WHERE event_id = $1', [envelopes[0].eventId]);
  assert.equal(status.checkpoint.lastAcknowledgedSeq, Number(first.outbox_seq));
  assert.equal(status.checkpoint.lastAcknowledgedEventId, envelopes[0].eventId);
  assert.equal(status.oldestPendingObservedAt, envelopes[1].observedAt);
  assert.equal(status.lagMs, NOW.getTime() - Date.parse(envelopes[1].observedAt));

  const later = new Date(NOW.getTime() + retryDelayMs(1) + 1000);
  const results = await drainDueDestinations(restarted, {
    adapters: { 'fixture-sink': fakeSink().adapter }, now: later,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].delivered, 1);
});

test('operator-requested replay rewinds the checkpoint and redelivers acknowledged events under the same ids', async (t) => {
  const { client, admin, viewer } = await setup(t);
  const destination = await fixtureDestination(client, admin);
  const envelopes = [1, 2].map((n) => fixtureEnvelope('fixture', n));
  for (const envelope of envelopes) {
    await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope });
  }
  const firstSink = fakeSink();
  await drainDestination(client, { destinationId: destination.id, adapter: firstSink.adapter, now: NOW });

  const { rows: [firstRow] } = await client.query(
    'SELECT outbox_seq FROM siem_outbox_event WHERE event_id = $1', [envelopes[0].eventId]);
  await requestReplay(client, {
    tenantRef: 'fixture', destinationId: destination.id,
    fromSeq: Number(firstRow.outbox_seq), requestedBy: admin.id,
  });
  const pendingStatus = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(pendingStatus.checkpoint.replayFromSeq, Number(firstRow.outbox_seq));
  assert.equal(pendingStatus.checkpoint.replayRequestedBy, admin.id);

  const replaySink = fakeSink();
  const summary = await drainDestination(client, { destinationId: destination.id, adapter: replaySink.adapter, now: NOW });
  assert.equal(summary.replayed, 2);
  assert.equal(summary.delivered, 2);
  assert.deepEqual(replaySink.deliveries.map((call) => call.eventId), envelopes.map((e) => e.eventId));

  const finalStatus = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(finalStatus.acknowledged, 2);
  assert.equal(finalStatus.checkpoint.replayFromSeq, null);
  const { rows: [second] } = await client.query(
    'SELECT outbox_seq FROM siem_outbox_event WHERE event_id = $1', [envelopes[1].eventId]);
  assert.equal(finalStatus.checkpoint.lastAcknowledgedSeq, Number(second.outbox_seq));
});

test('worker replay preserves poison quarantine and only redelivers acknowledged events', async (t) => {
  const { client, admin } = await setup(t);
  const destination = await fixtureDestination(client, admin);
  const envelopes = [1, 2, 3].map((n) => fixtureEnvelope('fixture', n));
  for (const envelope of envelopes) {
    await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope });
  }
  await drainDestination(client, {
    destinationId: destination.id, now: NOW,
    adapter: fakeSink(({ eventId }) => eventId === envelopes[1].eventId
      ? { outcome: 'poison', reason: 'fixture schema rejection' } : 'accepted').adapter,
  });
  const { rows: [before] } = await client.query(
    'SELECT * FROM siem_outbox_event WHERE destination_id = $1 AND event_id = $2',
    [destination.id, envelopes[1].eventId],
  );
  await requestReplay(client, {
    tenantRef: 'fixture', destinationId: destination.id, fromSeq: 0, requestedBy: admin.id,
  });
  const sink = fakeSink();
  const results = await drainSiemOutbox(client, {
    workerId: 'fixture-worker', adapters: { 'fixture-sink': sink.adapter }, now: NOW,
  });
  assert.equal(results[0].replayed, 2);
  assert.equal(results[0].delivered, 2);
  assert.deepEqual(sink.deliveries.map((call) => call.eventId), [envelopes[0].eventId, envelopes[2].eventId]);
  const { rows: [after] } = await client.query('SELECT * FROM siem_outbox_event WHERE id = $1', [before.id]);
  assert.equal(after.status, 'quarantined');
  assert.deepEqual(after, before);
});

test('worker drain applies a requested replay even when the queue is fully acknowledged', async (t) => {
  const { client, admin, viewer } = await setup(t);
  const destination = await fixtureDestination(client, admin);
  const envelopes = [1, 2].map((n) => fixtureEnvelope('fixture', n));
  for (const envelope of envelopes) {
    await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope });
  }
  const firstSink = fakeSink();
  await drainSiemOutbox(client, { workerId: 'fixture-worker', adapters: { 'fixture-sink': firstSink.adapter }, now: NOW });
  const status = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(status.pending, 0);
  assert.equal(status.acknowledged, 2);

  // Operator requests a replay over the fully drained queue. Nothing is due, so this
  // only works if the production drain path (drainSiemOutbox -> drainDueDestinations)
  // still selects the destination and applies the pending replay request.
  const { rows: [firstRow] } = await client.query(
    'SELECT outbox_seq FROM siem_outbox_event WHERE event_id = $1', [envelopes[0].eventId]);
  await requestReplay(client, {
    tenantRef: 'fixture', destinationId: destination.id,
    fromSeq: Number(firstRow.outbox_seq), requestedBy: admin.id,
  });

  const replaySink = fakeSink();
  const results = await drainSiemOutbox(client, {
    workerId: 'fixture-worker', adapters: { 'fixture-sink': replaySink.adapter }, now: NOW,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].replayed, 2);
  assert.equal(results[0].delivered, 2);
  assert.deepEqual(replaySink.deliveries.map((call) => call.eventId), envelopes.map((e) => e.eventId));

  const finalStatus = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(finalStatus.acknowledged, 2);
  assert.equal(finalStatus.checkpoint.replayFromSeq, null);
});

test('tenant isolation and server-side authorization on every outbox path', async (t) => {
  const { client, admin, viewer } = await setup(t);
  const destination = await fixtureDestination(client, admin);
  const other = await fixtureDestination(client, admin, { tenantRef: 'other-tenant', name: 'sink-9' });

  // An envelope can never be buffered into another tenant's destination or under a
  // mismatched tenant scope.
  await assert.rejects(
    enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope: fixtureEnvelope('other-tenant', 1) }),
    /does not match/,
  );
  await assert.rejects(
    enqueueEvent(client, { tenantRef: 'fixture', destinationId: other.id, envelope: fixtureEnvelope('fixture', 1) }),
    /destination not found/,
  );
  await assert.rejects(
    drainDestination(client, { destinationId: destination.id, tenantRef: 'other-tenant', adapter: fakeSink().adapter, now: NOW }),
    /destination not found/,
  );
  await assert.rejects(
    outboxStatus(client, { tenantRef: 'other-tenant', destinationId: destination.id, principalId: viewer.id }),
    /destination not found/,
  );

  // Reads stay within the caller's tenant.
  assert.deepEqual(
    (await listDestinations(client, { tenantRef: 'fixture', principalId: viewer.id })).map((d) => d.id),
    [destination.id],
  );

  // Mutations require the configuration capability; reads require at least read;
  // an unknown principal gets nothing.
  await assert.rejects(
    registerDestination(client, { tenantRef: 'fixture', name: 'sink-2', kind: 'fixture-sink', requestedBy: viewer.id }),
    /not authorized/,
  );
  await assert.rejects(
    revokeDestination(client, { tenantRef: 'fixture', destinationId: destination.id, requestedBy: viewer.id }),
    /not authorized/,
  );
  await assert.rejects(
    requestReplay(client, { tenantRef: 'fixture', destinationId: destination.id, fromSeq: 0, requestedBy: viewer.id }),
    /not authorized/,
  );
  await assert.rejects(
    outboxStatus(client, { tenantRef: 'fixture', destinationId: destination.id, principalId: 'no-such-principal' }),
    /not authorized/,
  );
  await assert.rejects(
    listDestinations(client, { tenantRef: 'fixture', principalId: 'no-such-principal' }),
    /not authorized/,
  );
});

test('worker main() drain-failure isolation: a failed drain is logged redacted and the poll loop survives', async (t) => {
  const { client, admin } = await setup(t);
  const destination = await fixtureDestination(client, admin);
  await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope: fixtureEnvelope('fixture', 1) });

  // A client whose every query rejects models a drain failure mid-poll (dropped
  // connection, schema drift, ...). main() must survive it: the exact seam it calls
  // resolves instead of throwing, and logs the failure with secrets redacted.
  const brokenClient = {
    query: async () => {
      throw new Error('connection lost: postgres://siem:supersecretpass@db.invalid:5432/keel');
    },
  };
  const logs = [];
  const failed = await drainSiemOutbox(brokenClient, {
    workerId: 'fixture-worker', log: (message) => logs.push(message),
  });
  assert.equal(failed, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /worker fixture-worker: SIEM outbox drain failed/);
  assert.match(logs[0], /\[redacted\]/);
  assert.doesNotMatch(logs[0], /supersecretpass/);

  // The next poll retries against the same durable outbox: a healthy client drains
  // the still-pending event through the injected adapter.
  const sink = fakeSink();
  const retried = await drainSiemOutbox(client, {
    workerId: 'fixture-worker', adapters: { 'fixture-sink': sink.adapter },
    log: (message) => logs.push(message),
  });
  assert.equal(retried.length, 1);
  assert.equal(retried[0].delivered, 1);
  assert.equal(logs.length, 1);
  const { rows: [row] } = await client.query(
    'SELECT status FROM siem_outbox_event WHERE destination_id = $1', [destination.id]);
  assert.equal(row.status, 'acknowledged');
});

test('a destination kind with no registered adapter reports no-adapter and leaves events pending', async (t) => {
  const { client, admin, viewer } = await setup(t);
  assert.equal(typeof SIEM_ADAPTERS, 'object');
  const destination = await fixtureDestination(client, admin);
  await enqueueEvent(client, { tenantRef: 'fixture', destinationId: destination.id, envelope: fixtureEnvelope('fixture', 1) });

  const summary = await drainDestination(client, { destinationId: destination.id, now: NOW });
  assert.equal(summary.status, 'no-adapter');
  const { rows: [row] } = await client.query(
    'SELECT status, attempts FROM siem_outbox_event WHERE destination_id = $1', [destination.id]);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);

  const results = await drainDueDestinations(client, { adapters: SIEM_ADAPTERS, now: NOW });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'no-adapter');
  const status = await outboxStatus(client, {
    tenantRef: 'fixture', destinationId: destination.id, principalId: viewer.id, now: NOW,
  });
  assert.equal(status.pending, 1);
  assert.equal(status.checkpoint.lastAcknowledgedSeq, 0);
});

test('destination config holds credential references only; secret-shaped values are refused', async (t) => {
  const { client, admin } = await setup(t);
  await assert.rejects(
    registerDestination(client, {
      tenantRef: 'fixture', name: 'leaky', kind: 'fixture-sink', requestedBy: admin.id,
      config: { endpointRef: 'vault:siem/leaky', headers: { authorization: 'Bearer abcdefghijklmnop' } },
    }),
    /credential reference/,
  );
  await assert.rejects(
    registerDestination(client, {
      tenantRef: 'fixture', name: 'leaky2', kind: 'fixture-sink', requestedBy: admin.id,
      config: { dsn: 'postgres://keel:secretpass@db.internal.example:5432/keel' },
    }),
    /credential reference/,
  );
});

test('JWT and PEM private-key shapes are rejected before destination config is stored', async (t) => {
  const { client, admin, viewer } = await setup(t);
  // Synthetic, nonfunctional secret shapes; no real credentials are used.
  const shapes = [
    'eyJmaXh0dXJlIjp0cnVlfQ.eyJmaXh0dXJlIjp0cnVlfQ.fixture_signature',
    ...['', 'RSA ', 'EC ', 'ENCRYPTED '].map((prefix) =>
      `-----BEGIN ${prefix}PRIVATE KEY-----\nfixture-only\n-----END ${prefix}PRIVATE KEY-----`),
  ];
  for (const [index, value] of shapes.entries()) {
    await assert.rejects(registerDestination(client, {
      tenantRef: 'fixture', name: `secret-shape-${index}`, kind: 'fixture-sink', requestedBy: admin.id,
      config: { nested: [{ value }] },
    }), /credential reference/);
  }
  assert.deepEqual(await listDestinations(client, { tenantRef: 'fixture', principalId: viewer.id }), []);
  const { rows: [counts] } = await client.query('SELECT COUNT(*)::int AS count FROM siem_replay_checkpoint');
  assert.equal(counts.count, 0);
  const destination = await fixtureDestination(client, admin);
  assert.deepEqual(destination.config, { endpointRef: 'vault:siem/sink-1' });
});

test('the receiver deduplication contract is explicit and at-least-once', () => {
  assert.equal(RECEIVER_DEDUP_CONTRACT.deliverySemantics, 'at-least-once');
  assert.deepEqual([...RECEIVER_DEDUP_CONTRACT.dedupKeyFields], ['tenantRef', 'destinationId', 'eventId']);
  assert.match(RECEIVER_DEDUP_CONTRACT.description, /at least once/);
  const key = receiverDedupKey({ tenantRef: 'fixture', destinationId: 'dest-1', eventId: 'evt_1' });
  assert.equal(key, JSON.stringify(['fixture', 'dest-1', 'evt_1']));
  assert.throws(() => receiverDedupKey({ tenantRef: '', destinationId: 'd', eventId: 'e' }), /tenantRef/);
});
