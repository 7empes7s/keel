// engine/itsm/outbox.mjs
//
// Roadmap task-96 (WS8): the durable outbound side of the ITSM mirror. The bridge
// (bridge.mjs) enqueues one event per mirror change (a record bound to a plan version,
// a canonical decision, a conflict); a worker drains due events through the adapter and
// records each outcome durably before moving on.
//
// Delivery semantics, the same as the SIEM outbox (telemetry/outbox.mjs):
//
// 1. AT-LEAST-ONCE. An event can be delivered more than once (retry after an uncertain
//    acknowledgement, crash after remote acceptance). The event id is deterministic and
//    stable across retries; the receiving adapter deduplicates on (adapter, event id).
// 2. A failed delivery is retried with capped exponential backoff over the durable
//    next_attempt_at column. A delivery the adapter marks permanent, or one that ran out
//    of attempts, is QUARANTINED with its reason; it is never dropped silently and does
//    not block the events behind it.
// 3. A failed delivery never changes the canonical decision. KEEL's approval_request is
//    the decision; the external record is a mirror of it.
// 4. Every read and write is qualified by tenant_ref. Payloads carry ids, digests and
//    principal ids only, never credentials.

export const ITSM_OUTBOX_RETRY_BASE_MS = 5 * 1000;
export const ITSM_OUTBOX_RETRY_MAX_MS = 15 * 60 * 1000;
export const ITSM_OUTBOX_LEASE_MS = 60 * 1000;
export const DEFAULT_ITSM_DRAIN_BATCH = 50;

export function itsmRetryDelayMs(attempt) {
  return Math.min(ITSM_OUTBOX_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)), ITSM_OUTBOX_RETRY_MAX_MS);
}

/** Enqueues one outbound event; a second enqueue of the same event id is a no-op that
 * returns the stored row, so a retried caller never mints a second event. */
export async function enqueueItsmEvent(client, { tenantRef, adapter, recordId, eventId, kind, payload }) {
  const { rows: [inserted] } = await client.query(
    `INSERT INTO itsm_outbox_event (tenant_ref, adapter, record_id, event_id, kind, payload)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_ref, adapter, event_id) DO NOTHING
     RETURNING *`,
    [tenantRef, adapter, recordId, eventId, kind, JSON.stringify(payload)],
  );
  if (inserted) return inserted;
  const { rows: [existing] } = await client.query(
    'SELECT * FROM itsm_outbox_event WHERE tenant_ref = $1 AND adapter = $2 AND event_id = $3',
    [tenantRef, adapter, eventId],
  );
  return existing;
}

function errorText(error) {
  return String(error?.message ?? error).slice(0, 500);
}

/**
 * Drains due events of one tenant for one adapter. `adapter.deliver({ eventId, kind,
 * externalRef, payload })` resolves on acceptance and throws on failure; an error with
 * `permanent: true` quarantines the event at once. Each event is claimed with a lease
 * (next_attempt_at moved forward) before delivery, so two drainers do not send it at the
 * same time. Returns { delivered, retried, quarantined }.
 */
export async function drainItsmOutbox(client, {
  tenantRef, adapter, now = new Date(), batchSize = DEFAULT_ITSM_DRAIN_BATCH,
}) {
  const result = { delivered: 0, retried: 0, quarantined: 0 };
  for (let index = 0; index < batchSize; index += 1) {
    const { rows: [event] } = await client.query(
      `UPDATE itsm_outbox_event e
          SET next_attempt_at = $3::timestamptz + ($4 * interval '1 millisecond'),
              attempts = e.attempts + 1
        WHERE e.id = (
          SELECT id FROM itsm_outbox_event
           WHERE tenant_ref = $1 AND adapter = $2 AND status = 'pending' AND next_attempt_at <= $3
           ORDER BY created_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING e.*, (SELECT external_ref FROM itsm_record r WHERE r.id = e.record_id) AS external_ref`,
      [tenantRef, adapter.name, now, ITSM_OUTBOX_LEASE_MS],
    );
    if (!event) break;
    try {
      await adapter.deliver({ eventId: event.event_id, kind: event.kind, externalRef: event.external_ref, payload: event.payload });
      await client.query(
        `UPDATE itsm_outbox_event SET status = 'delivered', delivered_at = $2, last_error = NULL WHERE id = $1`,
        [event.id, now],
      );
      result.delivered += 1;
    } catch (error) {
      if (error?.permanent === true || event.attempts >= event.max_attempts) {
        await client.query(
          `UPDATE itsm_outbox_event SET status = 'quarantined', last_error = $2, quarantine_reason = $3 WHERE id = $1`,
          [event.id, errorText(error), error?.permanent === true ? 'rejected by adapter' : 'retries exhausted'],
        );
        result.quarantined += 1;
      } else {
        await client.query(
          `UPDATE itsm_outbox_event
              SET last_error = $2, next_attempt_at = $3::timestamptz + ($4 * interval '1 millisecond')
            WHERE id = $1`,
          [event.id, errorText(error), now, itsmRetryDelayMs(event.attempts)],
        );
        result.retried += 1;
      }
    }
  }
  return result;
}

/** Outbound events of one record, oldest first. */
export async function listItsmOutbox(client, { tenantRef, recordId }) {
  const { rows } = await client.query(
    `SELECT id, event_id, kind, payload, status, attempts, next_attempt_at, last_error, delivered_at,
            quarantine_reason, created_at
       FROM itsm_outbox_event WHERE tenant_ref = $1 AND record_id = $2 ORDER BY created_at, id`,
    [tenantRef, recordId],
  );
  return rows;
}
