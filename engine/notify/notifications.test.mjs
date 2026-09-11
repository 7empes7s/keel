import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  DeliveryAttemptError,
  attemptDelivery,
  createChannel,
  createSubscription,
  dispatchAlert,
  eventMatches,
  retryDelayMs,
} from './notifications.mjs';
import { claimNext } from '../jobs/queue.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

// The matching rule is deliberately pure so subscription semantics cannot depend on
// a particular database or transport.
assert.equal(
  eventMatches(
    { event_glob: 'drift.*', min_severity: 'warning' },
    { kind: 'drift.detected', severity: 'warning' },
  ),
  true,
);
assert.equal(
  eventMatches(
    { event_glob: 'drift.*', min_severity: 'critical' },
    { kind: 'drift.detected', severity: 'warning' },
  ),
  false,
);
assert.equal(
  eventMatches(
    { event_glob: 'drift.?etected', min_severity: 'notice' },
    { kind: 'drift.detected', severity: 'notice' },
  ),
  true,
);
assert.equal(retryDelayMs(1), 30_000);
assert.equal(retryDelayMs(2), 60_000);

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
try {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));

  const requester = '11111111-1111-1111-1111-111111111111';
  await client.query(
    `INSERT INTO principal (id, email) VALUES ($1, 'alerts-admin@example.com')`,
    [requester],
  );
  await client.query(
    `INSERT INTO role_grant (principal_id, role, granted_by) VALUES ($1, 'admin', $2)`,
    [requester, requester],
  );

  const webhook = await createChannel(client, {
    kind: 'webhook', config: { url: 'https://hooks.example.test/keel' },
  });
  const email = await createChannel(client, {
    kind: 'email', config: { to: 'ops@example.test', from: 'keel@example.test' },
  });
  const disabled = await createChannel(client, {
    kind: 'webhook', config: { url: 'https://disabled.example.test/keel' }, enabled: false,
  });
  await createSubscription(client, {
    channelId: webhook.id, eventGlob: 'drift.*', minSeverity: 'warning',
  });
  // Two matching subscriptions still make one channel delivery for one event.
  await createSubscription(client, {
    channelId: webhook.id, eventGlob: 'drift.detected', minSeverity: 'notice',
  });
  await createSubscription(client, {
    channelId: email.id, eventGlob: '*', minSeverity: 'notice',
  });
  await createSubscription(client, {
    channelId: disabled.id, eventGlob: '*', minSeverity: 'notice',
  });

  await assert.rejects(
    () => dispatchAlert(client, {
      event: { kind: 'drift.detected', severity: 'critical' }, requestedBy: 'principal-not-registered',
    }),
    /requester is not authorized to dispatch notifications/,
    'notification enqueue is server-side authorized before it writes a delivery or job',
  );

  const event = {
    kind: 'drift.detected', severity: 'warning', driftId: 'fixture-drift-1',
  };
  const dispatched = await dispatchAlert(client, { event, requestedBy: requester });
  assert.equal(dispatched.length, 2, 'enabled matching channels each get one delivery');
  for (const { delivery, job } of dispatched) {
    assert.equal(delivery.status, 'queued');
    assert.equal(delivery.attempts, 0);
    assert.deepEqual(delivery.event, event);
    assert.equal(job.kind, 'notify', 'a delivery is represented by a notify job');
    assert.deepEqual(job.params, { deliveryId: delivery.id });
    assert.equal(job.requested_by, requester);
  }

  const webhookDelivery = dispatched.find(({ delivery }) => delivery.channel_id === webhook.id).delivery;
  const emailDelivery = dispatched.find(({ delivery }) => delivery.channel_id === email.id).delivery;
  const sent = [];
  const webhookResult = await attemptDelivery(client, {
    deliveryId: webhookDelivery.id,
    transports: {
      webhook: async ({ channel, event: deliveredEvent }) => {
        sent.push({ kind: channel.kind, event: deliveredEvent });
      },
    },
  });
  assert.equal(webhookResult.delivery.status, 'delivered');
  assert.equal(webhookResult.delivery.attempts, 1);
  assert.equal(webhookResult.delivery.last_error, null);
  assert.deepEqual(sent, [{ kind: 'webhook', event }]);

  const emailResult = await attemptDelivery(client, {
    deliveryId: emailDelivery.id,
    transports: {
      email: async ({ channel, event: deliveredEvent }) => {
        sent.push({ kind: channel.kind, event: deliveredEvent });
      },
    },
  });
  assert.equal(emailResult.delivery.status, 'delivered');
  assert.deepEqual(sent.at(-1), { kind: 'email', event });

  // A failed transport leaves a visible retrying delivery with the error and a future
  // notify job. This is the Task 20 mutation target: changing this failure path to
  // `delivered` must fail the status assertions below.
  const retryEvent = {
    kind: 'drift.detected', severity: 'critical', driftId: 'fixture-drift-retry',
  };
  const retryDispatched = await dispatchAlert(client, { event: retryEvent, requestedBy: requester });
  const retryDelivery = retryDispatched.find(({ delivery }) => delivery.channel_id === webhook.id).delivery;
  const beforeFailure = new Date();
  await assert.rejects(
    () => attemptDelivery(client, {
      deliveryId: retryDelivery.id,
      transports: { webhook: async () => { throw new Error('fixture webhook unavailable'); } },
    }),
    DeliveryAttemptError,
  );
  const { rows: retryRows } = await client.query('SELECT * FROM delivery WHERE id = $1', [retryDelivery.id]);
  const retried = retryRows[0];
  assert.equal(retried.status, 'retrying', 'a failed delivery must never mark itself delivered');
  assert.equal(retried.attempts, 1);
  assert.equal(retried.last_error, 'fixture webhook unavailable');
  assert.equal(retried.delivered_at, null);
  assert.ok(new Date(retried.next_attempt_at) >= new Date(beforeFailure.getTime() + retryDelayMs(1)));
  const { rows: retryJobs } = await client.query(
    `SELECT * FROM job
      WHERE kind = 'notify' AND idempotency_key = $1`,
    [`delivery:${retryDelivery.id}:attempt:2`],
  );
  assert.equal(retryJobs.length, 1, 'a failed delivery schedules its retry as another notify job');
  assert.equal(retryJobs[0].status, 'queued');
  assert.ok(new Date(retryJobs[0].not_before) >= new Date(beforeFailure.getTime() + retryDelayMs(1)));

  // Delayed-job claim eligibility (task-20): the scheduled retry must NOT be claimable
  // before its backoff elapses. Draining every currently-claimable job must never return
  // it; a claim query that ignores not_before would claim it here and fail this section.
  const drainedIds = [];
  let drainedJob;
  while ((drainedJob = await claimNext(client, { workerId: 'notify-test-drain' }))) {
    drainedIds.push(drainedJob.id);
  }
  assert.ok(
    !drainedIds.includes(retryJobs[0].id),
    'a retry job must not be claimable before its not_before backoff elapses',
  );
  const { rows: retryStillQueued } = await client.query(
    'SELECT status FROM job WHERE id = $1', [retryJobs[0].id],
  );
  assert.equal(retryStillQueued[0].status, 'queued', 'the unclaimed retry stays queued');

  // Exhausting the retry budget is terminally failed, still never delivered, and
  // records the final transport error for operators to inspect.
  const terminalEvent = {
    kind: 'drift.detected', severity: 'critical', driftId: 'fixture-drift-terminal',
  };
  const terminalDispatched = await dispatchAlert(client, {
    event: terminalEvent, requestedBy: requester, maxAttempts: 1,
  });
  const terminalDelivery = terminalDispatched.find(({ delivery }) => delivery.channel_id === webhook.id).delivery;
  await assert.rejects(
    () => attemptDelivery(client, {
      deliveryId: terminalDelivery.id,
      transports: { webhook: async () => { throw new Error('fixture terminal failure'); } },
    }),
    DeliveryAttemptError,
  );
  const { rows: terminalRows } = await client.query('SELECT * FROM delivery WHERE id = $1', [terminalDelivery.id]);
  assert.equal(terminalRows[0].status, 'failed', 'a terminal delivery failure remains visible as failed');
  assert.equal(terminalRows[0].last_error, 'fixture terminal failure');
  assert.equal(terminalRows[0].delivered_at, null);
  const { rows: terminalRetryJobs } = await client.query(
    `SELECT id FROM job WHERE idempotency_key = $1`,
    [`delivery:${terminalDelivery.id}:attempt:2`],
  );
  assert.equal(terminalRetryJobs.length, 0, 'a terminal failure does not enqueue a sixth attempt');

  // Disabled-channel guard (task-20): a channel disabled after dispatch but before
  // the attempt must not be delivered to. attemptDelivery must cancel the delivery
  // without calling the transport; removing that guard would send to a channel the
  // operator has explicitly turned off and mark the delivery delivered.
  const disabledEvent = {
    kind: 'drift.detected', severity: 'critical', driftId: 'fixture-drift-disabled',
  };
  const disabledDispatched = await dispatchAlert(client, { event: disabledEvent, requestedBy: requester });
  const disabledDelivery = disabledDispatched.find(({ delivery }) => delivery.channel_id === webhook.id).delivery;
  await client.query('UPDATE channel SET enabled = false WHERE id = $1', [webhook.id]);
  let disabledTransportCalls = 0;
  const disabledResult = await attemptDelivery(client, {
    deliveryId: disabledDelivery.id,
    transports: { webhook: async () => { disabledTransportCalls += 1; } },
  });
  assert.equal(disabledTransportCalls, 0, 'a disabled channel must never receive a delivery attempt');
  assert.equal(disabledResult.delivery.status, 'cancelled');
  assert.equal(disabledResult.delivery.last_error, 'channel disabled before delivery');
  const { rows: disabledRows } = await client.query('SELECT * FROM delivery WHERE id = $1', [disabledDelivery.id]);
  assert.equal(disabledRows[0].status, 'cancelled', 'a delivery to a disabled channel is cancelled, never delivered');
  assert.equal(disabledRows[0].delivered_at, null);
  await client.query('UPDATE channel SET enabled = true WHERE id = $1', [webhook.id]);
} finally {
  await client?.end();
  await database.cleanup();
}
console.log('notifications.test.mjs — all assertions passed');
