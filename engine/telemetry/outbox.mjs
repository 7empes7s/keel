// engine/telemetry/outbox.mjs
//
// Roadmap task-79 (WS12): a durable per-destination SIEM export outbox on top of the
// task-77 event envelopes. Producers enqueue envelopes keyed by (destination, source
// event id); a worker drains due events through a destination-kind adapter and records
// the outcome durably before moving on.
//
// Non-negotiable delivery semantics:
//
// 1. AT-LEAST-ONCE, never claimed as exactly-once. The physical transport can deliver
//    an event more than once (retry after an uncertain acknowledgement, crash after
//    remote acceptance but before the checkpoint commit, operator-requested replay).
//    Receivers MUST deduplicate; RECEIVER_DEDUP_CONTRACT is the binding statement.
// 2. The replay checkpoint advances only inside the SAME transaction that marks an
//    event acknowledged — never before acceptance, never on a retry. A crash between
//    remote acceptance and the commit leaves the event pending, so it is redelivered
//    under its ORIGINAL event id. Retries never mint a new event id.
// 3. A poison event (adapter-rejected, or retries exhausted) is QUARANTINED with a
//    durable reason; it is never silently dropped and it does not block or erase the
//    events behind it.
// 4. A revoked/disabled destination pauses delivery; buffered events stay pending.
// 5. Tenant scope is enforced on every path: destination lookup, enqueue, status and
//    replay are all qualified by tenant_ref. Mutations require the 'configuration'
//    capability, reads the 'read' capability, checked server-side per Global
//    Constraint 4. The drain path runs as the worker service against durable,
//    already-authorized destination configuration — the same model the job queue uses.
// 6. Destination config carries credential REFERENCES only. Values that look like
//    secrets (bearer tokens, JWTs, private keys, credentialed DSNs) are refused at
//    registration; secrets never enter the outbox, logs or evidence.
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';

export const OUTBOX_RETRY_BASE_MS = 5 * 1000;
export const OUTBOX_RETRY_MAX_MS = 15 * 60 * 1000;
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 8;
export const DEFAULT_DRAIN_BATCH_SIZE = 50;

// The receiver-side contract every SIEM sink adapter must publish: delivery is
// at-least-once, and the receiver deduplicates on (tenantRef, destinationId, eventId).
// The event id is the deterministic task-77 envelope id, stable across retries and
// replays; request ids or HTTP 2xx are diagnostic only, never idempotency guarantees.
export const RECEIVER_DEDUP_CONTRACT = Object.freeze({
  deliverySemantics: 'at-least-once',
  dedupKeyFields: Object.freeze(['tenantRef', 'destinationId', 'eventId']),
  description:
    'The outbox delivers each event at least once and may redeliver it under the '
    + 'same event id (retry, uncertain acknowledgement, crash before checkpoint '
    + 'commit, operator replay). The receiver must deduplicate on the dedup key and '
    + 'must not treat a redelivery as a new event. Exactly-once physical ingestion '
    + 'is never claimed.',
});

export function receiverDedupKey({ tenantRef, destinationId, eventId }) {
  return JSON.stringify([
    requireNonEmptyString(tenantRef, 'tenantRef'),
    requireNonEmptyString(destinationId, 'destinationId'),
    requireNonEmptyString(eventId, 'eventId'),
  ]);
}

// Exponential backoff over the durable next_attempt_at column, capped; the wait is
// visible in the database instead of hidden in a worker sleep (same rule as the queue).
export function retryDelayMs(attempt) {
  return Math.min(
    OUTBOX_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)),
    OUTBOX_RETRY_MAX_MS,
  );
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

async function requireCapability(client, principalId, capability) {
  const principal = await findPrincipalById(client, principalId);
  if (!principal || !(await can(client, principal, capability, new Date()))) {
    throw new Error(`not authorized: requires ${capability} capability`);
  }
  return principal;
}

async function findDestination(client, { destinationId, tenantRef }) {
  requireNonEmptyString(destinationId, 'destinationId');
  const { rows } = await client.query(
    `SELECT * FROM siem_destination
      WHERE id::text = $1 AND ($2::text IS NULL OR tenant_ref = $2)`,
    [destinationId, tenantRef ?? null],
  );
  return rows[0] ?? null;
}

// Credential-shaped values refused in destination config. Config names a secret held
// elsewhere (vault path, secret name); the value itself must never be stored here.
const SECRET_VALUE_PATTERNS = [
  /Bearer\s+\S{8,}/i,
  /postgres(?:ql)?:\/\/[^\s/]*:[^\s/]*@/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function assertConfigHasNoSecrets(value, path = 'config') {
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`${path} must hold a credential reference, not a secret value`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertConfigHasNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      assertConfigHasNoSecrets(value[key], `${path}.${key}`);
    }
  }
}

/** Register a destination and its replay checkpoint atomically (configuration capability). */
export async function registerDestination(client, {
  tenantRef, name, kind, config = {}, requestedBy,
}) {
  requireNonEmptyString(tenantRef, 'tenantRef');
  requireNonEmptyString(name, 'name');
  requireNonEmptyString(kind, 'kind');
  requireNonEmptyString(requestedBy, 'requestedBy');
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('config must be an object');
  }
  assertConfigHasNoSecrets(config);
  await requireCapability(client, requestedBy, 'configuration');

  await client.query('BEGIN');
  let committed = false;
  try {
    const { rows } = await client.query(
      `INSERT INTO siem_destination (tenant_ref, name, kind, config, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [tenantRef, name, kind, config, requestedBy],
    );
    const destination = rows[0];
    await client.query(
      `INSERT INTO siem_replay_checkpoint (destination_id, tenant_ref)
       VALUES ($1, $2)`,
      [destination.id, tenantRef],
    );
    await client.query('COMMIT');
    committed = true;
    return destination;
  } finally {
    if (!committed) await client.query('ROLLBACK');
  }
}

/** Revoking pauses delivery durably; buffered events stay pending (configuration capability). */
export async function revokeDestination(client, { tenantRef, destinationId, requestedBy }) {
  requireNonEmptyString(tenantRef, 'tenantRef');
  requireNonEmptyString(requestedBy, 'requestedBy');
  await requireCapability(client, requestedBy, 'configuration');
  const { rows } = await client.query(
    `UPDATE siem_destination
        SET revoked_at = now(), enabled = false
      WHERE id::text = $1 AND tenant_ref = $2
      RETURNING *`,
    [destinationId, tenantRef],
  );
  if (!rows[0]) throw new Error(`destination not found: ${destinationId}`);
  return rows[0];
}

export async function resumeDestination(client, { tenantRef, destinationId, requestedBy }) {
  requireNonEmptyString(tenantRef, 'tenantRef');
  requireNonEmptyString(requestedBy, 'requestedBy');
  await requireCapability(client, requestedBy, 'configuration');
  const { rows } = await client.query(
    `UPDATE siem_destination
        SET revoked_at = NULL, enabled = true
      WHERE id::text = $1 AND tenant_ref = $2
      RETURNING *`,
    [destinationId, tenantRef],
  );
  if (!rows[0]) throw new Error(`destination not found: ${destinationId}`);
  return rows[0];
}

export async function listDestinations(client, { tenantRef, principalId }) {
  requireNonEmptyString(tenantRef, 'tenantRef');
  await requireCapability(client, principalId, 'read');
  const { rows } = await client.query(
    `SELECT * FROM siem_destination WHERE tenant_ref = $1 ORDER BY created_at, id`,
    [tenantRef],
  );
  return rows;
}

/**
 * Durably buffer an envelope for a destination. Keyed by (destination, event id):
 * enqueueing the same event twice returns the existing row, so a producer retry can
 * never create a duplicate delivery. The destination must belong to the envelope's
 * tenant; a foreign-tenant event is refused rather than routed.
 */
export async function enqueueEvent(client, {
  tenantRef, destinationId, envelope, maxAttempts = DEFAULT_OUTBOX_MAX_ATTEMPTS,
}) {
  requireNonEmptyString(tenantRef, 'tenantRef');
  requireNonEmptyString(destinationId, 'destinationId');
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('envelope must be a task-77 event envelope object');
  }
  requireNonEmptyString(envelope.eventId, 'envelope.eventId');
  if (envelope.tenantRef !== tenantRef) {
    throw new Error('envelope tenantRef does not match the outbox tenant');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('maxAttempts must be a positive integer');
  }
  const destination = await findDestination(client, { destinationId, tenantRef });
  if (!destination) throw new Error(`destination not found: ${destinationId}`);

  const { rows } = await client.query(
    `INSERT INTO siem_outbox_event (tenant_ref, destination_id, event_id, envelope, max_attempts)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (destination_id, event_id) DO NOTHING
     RETURNING *`,
    [tenantRef, destination.id, envelope.eventId, envelope, maxAttempts],
  );
  if (rows[0]) return { event: rows[0], inserted: true };
  const { rows: existing } = await client.query(
    `SELECT * FROM siem_outbox_event WHERE destination_id = $1 AND event_id = $2`,
    [destination.id, envelope.eventId],
  );
  return { event: existing[0], inserted: false };
}

function normalizeOutcome(result) {
  const outcome = typeof result === 'string' ? { outcome: result } : (result ?? {});
  if (['accepted', 'retry', 'uncertain', 'poison'].includes(outcome.outcome)) {
    return outcome;
  }
  // An adapter that returns garbage has told us nothing about acceptance: the safe
  // reading is uncertain, which keeps the event pending under its original id.
  return { outcome: 'uncertain', error: `unrecognized adapter outcome: ${JSON.stringify(outcome.outcome ?? null)}` };
}

// Acknowledgement and checkpoint advance commit together or not at all. This is what
// makes a crash after remote acceptance replay the same event id: the acceptance was
// never recorded, so the event stays pending and is delivered again.
async function acknowledge(client, { row }) {
  await client.query('BEGIN');
  let committed = false;
  try {
    await client.query(
      `UPDATE siem_outbox_event
          SET status = 'acknowledged', acknowledged_at = now(), last_error = NULL
        WHERE id = $1`,
      [row.id],
    );
    await client.query(
      `INSERT INTO siem_replay_checkpoint
         (destination_id, tenant_ref, last_acknowledged_seq, last_acknowledged_event_id, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (destination_id) DO UPDATE
         SET last_acknowledged_seq = GREATEST(siem_replay_checkpoint.last_acknowledged_seq,
                                              EXCLUDED.last_acknowledged_seq),
             last_acknowledged_event_id = EXCLUDED.last_acknowledged_event_id,
             updated_at = now()`,
      [row.destination_id, row.tenant_ref, row.outbox_seq, row.event_id],
    );
    await client.query('COMMIT');
    committed = true;
  } finally {
    if (!committed) await client.query('ROLLBACK');
  }
}

async function quarantine(client, { row, reason }) {
  await client.query(
    `UPDATE siem_outbox_event
        SET status = 'quarantined', quarantined_at = now(), quarantine_reason = $2, last_error = $2
      WHERE id = $1`,
    [row.id, reason],
  );
  return 'quarantined';
}

async function reschedule(client, { row, now, error, retryAfterMs }) {
  if (row.attempts >= row.max_attempts) {
    return quarantine(client, { row, reason: `max-attempts-exceeded: ${error}` });
  }
  const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? Math.min(retryAfterMs, OUTBOX_RETRY_MAX_MS)
    : retryDelayMs(row.attempts);
  const nextAttemptAt = new Date(now.getTime() + delayMs);
  await client.query(
    `UPDATE siem_outbox_event
        SET status = 'pending', next_attempt_at = $2, last_error = $3
      WHERE id = $1`,
    [row.id, nextAttemptAt, error],
  );
  return 'pending';
}

// Apply a pending replay request: acknowledged events at or after replay_from_seq go
// back to pending under their ORIGINAL event ids, and the durable cursor rewinds so
// the redeliveries re-advance it. Quarantined events stay quarantined and visible;
// replay is not a backdoor that un-quarantines poison.
async function applyReplay(client, { destination }) {
  const { rows: [checkpoint] } = await client.query(
    `SELECT * FROM siem_replay_checkpoint WHERE destination_id = $1`,
    [destination.id],
  );
  const fromSeq = checkpoint?.replay_from_seq;
  if (fromSeq === null || fromSeq === undefined) return 0;
  await client.query('BEGIN');
  let committed = false;
  try {
    const { rowCount } = await client.query(
      `UPDATE siem_outbox_event
          SET status = 'pending', attempts = 0, acknowledged_at = NULL,
              next_attempt_at = now(), last_error = NULL
        WHERE destination_id = $1 AND status = 'acknowledged' AND outbox_seq >= $2`,
      [destination.id, fromSeq],
    );
    await client.query(
      `UPDATE siem_replay_checkpoint
          SET replay_from_seq = NULL,
              last_acknowledged_seq = LEAST(last_acknowledged_seq, GREATEST(0, $2 - 1)),
              last_acknowledged_event_id = (
                SELECT event_id FROM siem_outbox_event
                 WHERE destination_id = $1
                   AND outbox_seq = LEAST(last_acknowledged_seq, GREATEST(0, $2 - 1))
              ),
              updated_at = now()
        WHERE destination_id = $1`,
      [destination.id, fromSeq],
    );
    await client.query('COMMIT');
    committed = true;
    return rowCount ?? 0;
  } finally {
    if (!committed) await client.query('ROLLBACK');
  }
}

/**
 * Drain due events for one destination through its adapter. The adapter contract:
 *
 *   deliver({ destination, envelope, eventId, dedupKey, attempt })
 *     -> 'accepted'                        remote side confirmed acceptance
 *     -> { outcome:'retry', retryAfterMs? } transient failure; backoff and redeliver
 *     -> { outcome:'uncertain' }           outcome unknown (timeout, lost response);
 *                                          redeliver under the SAME event id
 *     -> { outcome:'poison', reason }      event can never be accepted; quarantine it
 *
 * A thrown error is treated as retry. The checkpoint moves only on 'accepted'.
 */
export async function drainDestination(client, {
  destinationId, tenantRef, adapter, now = new Date(), batchSize = DEFAULT_DRAIN_BATCH_SIZE,
}) {
  requireNonEmptyString(destinationId, 'destinationId');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError('batchSize must be a positive integer');
  }
  const destination = await findDestination(client, { destinationId, tenantRef });
  if (!destination) throw new Error(`destination not found: ${destinationId}`);
  const summary = {
    destinationId: destination.id, tenantRef: destination.tenant_ref,
    delivered: 0, retried: 0, uncertain: 0, quarantined: 0, replayed: 0,
  };
  if (!destination.enabled || destination.revoked_at !== null) {
    return { ...summary, status: 'paused' };
  }
  if (typeof adapter?.deliver !== 'function') {
    // No adapter registered for this kind yet (the real sinks land in tasks 80/81):
    // report it and leave every event pending rather than dropping or fake-acking.
    return { ...summary, status: 'no-adapter' };
  }

  summary.replayed = await applyReplay(client, { destination });

  const { rows: due } = await client.query(
    `SELECT * FROM siem_outbox_event
      WHERE destination_id = $1 AND status IN ('pending','delivering') AND next_attempt_at <= $2
      ORDER BY outbox_seq
      LIMIT $3`,
    [destination.id, now, batchSize],
  );

  for (const dueRow of due) {
    // Claim by flipping to 'delivering' and counting the attempt. next_attempt_at is
    // deliberately left unchanged: a crash mid-delivery leaves the row immediately
    // due, so the next drain redelivers it under the same event id.
    const { rows: [claimed] } = await client.query(
      `UPDATE siem_outbox_event
          SET status = 'delivering', attempts = attempts + 1
        WHERE id = $1 AND status IN ('pending','delivering') AND next_attempt_at <= $2
        RETURNING *`,
      [dueRow.id, now],
    );
    if (!claimed) continue;

    let outcome;
    try {
      outcome = normalizeOutcome(await adapter.deliver({
        destination,
        envelope: claimed.envelope,
        eventId: claimed.event_id,
        dedupKey: receiverDedupKey({
          tenantRef: claimed.tenant_ref,
          destinationId: destination.id,
          eventId: claimed.event_id,
        }),
        attempt: claimed.attempts,
      }));
    } catch (cause) {
      outcome = { outcome: 'retry', error: cause instanceof Error ? cause.message : String(cause) };
    }

    if (outcome.outcome === 'accepted') {
      await acknowledge(client, { row: claimed });
      summary.delivered += 1;
    } else if (outcome.outcome === 'poison') {
      await quarantine(client, {
        row: claimed,
        reason: requireNonEmptyString(outcome.reason, 'poison reason'),
      });
      summary.quarantined += 1;
    } else if (outcome.outcome === 'uncertain') {
      const result = await reschedule(client, {
        row: claimed, now,
        error: outcome.error ?? 'acknowledgement uncertain; event retained for replay under the same event id',
      });
      summary[result === 'quarantined' ? 'quarantined' : 'uncertain'] += 1;
    } else {
      const result = await reschedule(client, {
        row: claimed, now,
        error: outcome.error ?? 'destination requested retry',
        retryAfterMs: outcome.retryAfterMs,
      });
      summary[result === 'quarantined' ? 'quarantined' : 'retried'] += 1;
    }
  }
  return { ...summary, status: 'drained' };
}

/**
 * Drain every destination that has due events OR a pending operator replay request;
 * adapters are keyed by destination kind. A replay request applies only here (via
 * drainDestination -> applyReplay): a fully acknowledged queue has no due rows, so
 * without the replay arm the requested rewind would never be picked up by the
 * periodic worker loop.
 */
export async function drainDueDestinations(client, {
  adapters = {}, now = new Date(), batchSize = DEFAULT_DRAIN_BATCH_SIZE,
} = {}) {
  const { rows: destinations } = await client.query(
    `SELECT d.*
       FROM siem_destination d
      WHERE EXISTS (
              SELECT 1 FROM siem_outbox_event e
               WHERE e.destination_id = d.id
                 AND e.status IN ('pending','delivering') AND e.next_attempt_at <= $1
            )
         OR EXISTS (
              SELECT 1 FROM siem_replay_checkpoint c
               WHERE c.destination_id = d.id AND c.replay_from_seq IS NOT NULL
            )
      ORDER BY d.created_at, d.id`,
    [now],
  );
  const results = [];
  for (const destination of destinations) {
    results.push(await drainDestination(client, {
      destinationId: destination.id,
      adapter: adapters[destination.kind],
      now,
      batchSize,
    }));
  }
  return results;
}

/** Schedule a replay of acknowledged events at or after fromSeq (configuration capability). */
export async function requestReplay(client, { tenantRef, destinationId, fromSeq, requestedBy }) {
  requireNonEmptyString(tenantRef, 'tenantRef');
  requireNonEmptyString(requestedBy, 'requestedBy');
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
    throw new TypeError('fromSeq must be a non-negative integer');
  }
  await requireCapability(client, requestedBy, 'configuration');
  const destination = await findDestination(client, { destinationId, tenantRef });
  if (!destination) throw new Error(`destination not found: ${destinationId}`);
  const { rows } = await client.query(
    `UPDATE siem_replay_checkpoint
        SET replay_from_seq = $2, replay_requested_by = $3, replay_requested_at = now(),
            updated_at = now()
      WHERE destination_id = $1
      RETURNING *`,
    [destination.id, fromSeq, requestedBy],
  );
  return rows[0];
}

/**
 * Destination status including delivery lag: how far the sink trails the source event
 * stream, measured from the oldest unacknowledged event's observedAt. All durable —
 * a worker restart loses none of it (read capability).
 */
export async function outboxStatus(client, {
  tenantRef, destinationId, principalId, now = new Date(),
}) {
  requireNonEmptyString(tenantRef, 'tenantRef');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  await requireCapability(client, principalId, 'read');
  const destination = await findDestination(client, { destinationId, tenantRef });
  if (!destination) throw new Error(`destination not found: ${destinationId}`);
  const { rows: [counts] } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'delivering')::int AS delivering,
            COUNT(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
            COUNT(*) FILTER (WHERE status = 'quarantined')::int AS quarantined,
            MIN(envelope->>'observedAt') FILTER (WHERE status IN ('pending','delivering'))
              AS oldest_pending_observed_at
       FROM siem_outbox_event
      WHERE destination_id = $1`,
    [destination.id],
  );
  const { rows: [checkpoint] } = await client.query(
    `SELECT * FROM siem_replay_checkpoint WHERE destination_id = $1`,
    [destination.id],
  );
  const oldest = counts.oldest_pending_observed_at ? new Date(counts.oldest_pending_observed_at) : null;
  return {
    destinationId: destination.id,
    tenantRef: destination.tenant_ref,
    kind: destination.kind,
    paused: !destination.enabled || destination.revoked_at !== null,
    pending: counts.pending,
    delivering: counts.delivering,
    acknowledged: counts.acknowledged,
    quarantined: counts.quarantined,
    oldestPendingObservedAt: oldest && !Number.isNaN(oldest.getTime()) ? oldest.toISOString() : null,
    lagMs: oldest && !Number.isNaN(oldest.getTime())
      ? Math.max(0, now.getTime() - oldest.getTime())
      : null,
    checkpoint: checkpoint ? {
      lastAcknowledgedSeq: Number(checkpoint.last_acknowledged_seq),
      lastAcknowledgedEventId: checkpoint.last_acknowledged_event_id,
      replayFromSeq: checkpoint.replay_from_seq === null ? null : Number(checkpoint.replay_from_seq),
      replayRequestedBy: checkpoint.replay_requested_by,
      replayRequestedAt: checkpoint.replay_requested_at,
    } : null,
  };
}
