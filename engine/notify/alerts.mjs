// engine/notify/alerts.mjs
//
// Roadmap task-82: the durable alert lifecycle over the task-20 delivery primitives.
//
// An alert is identified by its condition: (tenant, resource, control, condition). A
// condition event says that condition was observed firing or resolved at an instant.
// The rules:
//
//  - Repeated firings update the same alert; they never create another one.
//  - A resolved alert that fires again is REOPENED: same row, next occurrence, with the
//    prior occurrence kept in the append-only transition history. Reopening clears the
//    prior occurrence's acknowledgement and resolution.
//  - Acknowledging records who and when; it never resolves the condition. Only a
//    resolved observation resolves an alert.
//  - Every event carries an id. A retried or duplicated id is recognised from its
//    receipt and changes nothing (the receipt and the change commit together).
//  - Ordering is by observation time, never by arrival. An event observed before the
//    alert's latest applied observation is stale and is recorded but not applied, so a
//    late resolution from an earlier occurrence cannot close a newer one.
//  - Hysteresis: a resolution observed less than `resolveMs` after the last firing is a
//    flap. The alert stays active, the flap is counted and recorded, and a later
//    resolved observation outside the window resolves it. The comparison is strict: a
//    resolution exactly `resolveMs` after the last firing is a real resolution.
//    A firing less than `reopenMs` after a resolution reopens as a flapping reopen and is
//    not notified again; history still records it.
//  - Suppression keeps the alert, its history and the live condition state. It stops
//    notification only, and lifting it returns the alert to the state the condition is
//    in now.
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { dispatchAlert } from './notifications.mjs';

export const ALERT_STATES = Object.freeze(['open', 'acknowledged', 'resolved', 'reopened', 'suppressed']);
export const ACTIVE_STATES = Object.freeze(['open', 'acknowledged', 'reopened']);
export const CONDITION_STATUSES = Object.freeze(['firing', 'resolved']);
export const DEFAULT_HYSTERESIS = Object.freeze({ resolveMs: 0, reopenMs: 0 });

// Reading alerts and their history is a viewing right; acting on one is the
// operator's drift-response right; suppressing one is a policy decision.
export const ALERT_READ_CAPABILITY = 'read';
export const ALERT_ACKNOWLEDGE_CAPABILITY = 'dispose-accept';
export const ALERT_SUPPRESS_CAPABILITY = 'policies';

const SEVERITIES = ['notice', 'warning', 'critical'];

export class AlertAuthorizationError extends Error {
  constructor(message) { super(message); this.name = 'AlertAuthorizationError'; }
}

export class AlertStateError extends Error {
  constructor(message) { super(message); this.name = 'AlertStateError'; }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireInstant(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${label} must be an observed instant`);
  return date;
}

function requireHysteresis(hysteresis = DEFAULT_HYSTERESIS) {
  const resolved = { ...DEFAULT_HYSTERESIS, ...hysteresis };
  for (const key of ['resolveMs', 'reopenMs']) {
    if (!Number.isInteger(resolved[key]) || resolved[key] < 0) throw new Error(`hysteresis.${key} must be a non-negative integer`);
  }
  return resolved;
}

// Grants are always checked at the current instant; the `at` an operator action
// records is its evidence time, never the time its authority is judged at.
async function authorize(client, { tenantRef, actor, capability, at }) {
  requireString(tenantRef, 'tenantRef');
  const principal = await findPrincipalById(client, actor);
  if (!principal || !(await can(client, principal, capability, at))) {
    throw new AlertAuthorizationError(`alerts: ${capability} capability required`);
  }
  return principal;
}

async function transaction(client, work) {
  await client.query('BEGIN');
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function recordTransition(client, alert, {
  fromState, toState, reason, eventId = null, actor, occurredAt, evidence = {},
}) {
  await client.query(
    `INSERT INTO alert_transition
       (alert_id, tenant_ref, occurrence, from_state, to_state, reason, event_id, actor, occurred_at, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [alert.id, alert.tenant_ref, alert.occurrence, fromState, toState, reason, eventId, actor, occurredAt, evidence],
  );
}

async function receipt(client, { tenantRef, eventId, alertId, outcome }) {
  await client.query(
    `UPDATE alert_event_receipt SET alert_id = $3, outcome = $4 WHERE tenant_ref = $1 AND event_id = $2`,
    [tenantRef, eventId, alertId, outcome],
  );
}

/** Pure decision for one observation against the current alert row (or none). */
export function decideTransition(alert, { status, occurredAt, hysteresis = DEFAULT_HYSTERESIS }) {
  const at = occurredAt.getTime();
  if (!alert) return status === 'firing' ? { action: 'open' } : { action: 'ignore', outcome: 'no-alert' };
  if (at < new Date(alert.last_observed_at).getTime()) return { action: 'ignore', outcome: 'stale' };

  const active = alert.condition_active;
  if (status === 'firing') {
    if (active) return { action: 'refire' };
    const sinceResolution = alert.resolved_at ? at - new Date(alert.resolved_at).getTime() : Infinity;
    return { action: 'reopen', flapping: sinceResolution < hysteresis.reopenMs };
  }
  if (!active) return { action: 'ignore', outcome: 'already-resolved' };
  // Strict: a resolution exactly resolveMs after the last firing is real.
  if (at < new Date(alert.last_firing_at).getTime() + hysteresis.resolveMs) return { action: 'flap' };
  return { action: 'resolve' };
}

async function notifyOccurrence(client, alert, { requestedBy }) {
  if (!requestedBy || alert.state === 'suppressed' || alert.notified_occurrence >= alert.occurrence) return null;
  const deliveries = await dispatchAlert(client, {
    requestedBy,
    event: {
      kind: `alert.${alert.occurrence > 1 ? 'reopened' : 'opened'}`,
      severity: alert.severity,
      alertId: alert.id,
      tenantRef: alert.tenant_ref,
      resourceKey: alert.resource_key,
      control: alert.control,
      condition: alert.condition,
      occurrence: alert.occurrence,
    },
  });
  await client.query(
    'UPDATE alert SET notified_occurrence = GREATEST(notified_occurrence, $2) WHERE id = $1',
    [alert.id, alert.occurrence],
  );
  return deliveries;
}

/**
 * Applies one condition observation. `eventId` must be stable across retries of the
 * same observation (for drift: the snapshot and resource). Returns
 * `{ alert, outcome, duplicate, deliveries }`; `outcome` is what happened.
 *
 * Notification (`notify.requestedBy`) goes through dispatchAlert after the state
 * change commits, once per occurrence; a crash between the two is repaired by the
 * next delivery of the same event, which sees the occurrence not yet notified.
 */
export async function applyConditionEvent(client, {
  tenantRef, resourceKey, control, condition, status, eventId, occurredAt,
  severity = 'warning', detail = {}, source = 'keel', hysteresis, notify = null,
}) {
  requireString(tenantRef, 'tenantRef');
  requireString(resourceKey, 'resourceKey');
  requireString(control, 'control');
  requireString(condition, 'condition');
  requireString(eventId, 'eventId');
  requireString(source, 'source');
  if (!CONDITION_STATUSES.includes(status)) throw new Error('status must be firing or resolved');
  if (!SEVERITIES.includes(severity)) throw new Error('severity must be notice, warning or critical');
  const at = requireInstant(occurredAt, 'occurredAt');
  const window = requireHysteresis(hysteresis);
  const actor = `condition:${source}`;
  const flapping = { value: false };

  const result = await transaction(client, async () => {
    const { rows: fresh } = await client.query(
      `INSERT INTO alert_event_receipt (tenant_ref, event_id, outcome)
       VALUES ($1,$2,'pending') ON CONFLICT DO NOTHING RETURNING event_id`,
      [tenantRef, eventId],
    );
    if (!fresh.length) {
      const { rows: [prior] } = await client.query(
        `SELECT r.outcome, a.* FROM alert_event_receipt r LEFT JOIN alert a ON a.id = r.alert_id
          WHERE r.tenant_ref = $1 AND r.event_id = $2`,
        [tenantRef, eventId],
      );
      return { duplicate: true, outcome: prior.outcome, alert: prior.id ? prior : null };
    }

    // A first firing inserts the identity row; a concurrent first firing for the same
    // identity waits on the unique index and then finds the committed row below.
    let created = null;
    if (status === 'firing') {
      const { rows } = await client.query(
        `INSERT INTO alert
           (tenant_ref, resource_key, control, condition, state, condition_active, severity, detail,
            first_opened_at, occurrence_started_at, last_firing_at, last_observed_at, last_event_id)
         VALUES ($1,$2,$3,$4,'open',true,$5,$6,$7,$7,$7,$7,$8)
         ON CONFLICT (tenant_ref, resource_key, control, condition) DO NOTHING
         RETURNING *`,
        [tenantRef, resourceKey, control, condition, severity, detail, at, eventId],
      );
      created = rows[0] ?? null;
    }
    if (created) {
      await recordTransition(client, created, {
        fromState: null, toState: 'open', reason: 'condition-firing', eventId, actor, occurredAt: at, evidence: { detail },
      });
      await receipt(client, { tenantRef, eventId, alertId: created.id, outcome: 'opened' });
      return { duplicate: false, outcome: 'opened', alert: created };
    }

    const { rows: [alert] } = await client.query(
      `SELECT * FROM alert WHERE tenant_ref = $1 AND resource_key = $2 AND control = $3 AND condition = $4 FOR UPDATE`,
      [tenantRef, resourceKey, control, condition],
    );
    const decision = decideTransition(alert ?? null, { status, occurredAt: at, hysteresis: window });

    if (decision.action === 'ignore') {
      await receipt(client, { tenantRef, eventId, alertId: alert?.id ?? null, outcome: decision.outcome });
      return { duplicate: false, outcome: decision.outcome, alert: alert ?? null };
    }

    if (decision.action === 'refire') {
      const { rows: [updated] } = await client.query(
        `UPDATE alert SET firing_count = firing_count + 1, last_firing_at = $2, last_observed_at = $2,
                last_event_id = $3, severity = $4, detail = $5, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [alert.id, at, eventId, severity, detail],
      );
      await receipt(client, { tenantRef, eventId, alertId: alert.id, outcome: 'updated' });
      return { duplicate: false, outcome: 'updated', alert: updated };
    }

    if (decision.action === 'flap') {
      const { rows: [updated] } = await client.query(
        `UPDATE alert SET flap_count = flap_count + 1, last_observed_at = $2, last_event_id = $3, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [alert.id, at, eventId],
      );
      await recordTransition(client, updated, {
        fromState: alert.state, toState: alert.state, reason: 'resolution-held-flapping', eventId, actor, occurredAt: at,
        evidence: { lastFiringAt: alert.last_firing_at, resolveMs: window.resolveMs },
      });
      await receipt(client, { tenantRef, eventId, alertId: alert.id, outcome: 'flap-held' });
      return { duplicate: false, outcome: 'flap-held', alert: updated };
    }

    if (decision.action === 'resolve') {
      const toState = alert.state === 'suppressed' ? 'suppressed' : 'resolved';
      const { rows: [updated] } = await client.query(
        `UPDATE alert SET state = $2, condition_active = false, resolved_at = $3, resolved_event_id = $4,
                last_observed_at = $3, last_event_id = $4, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [alert.id, toState, at, eventId],
      );
      await recordTransition(client, updated, {
        fromState: alert.state, toState, reason: 'condition-resolved', eventId, actor, occurredAt: at,
      });
      await receipt(client, { tenantRef, eventId, alertId: alert.id, outcome: 'resolved' });
      return { duplicate: false, outcome: 'resolved', alert: updated };
    }

    // reopen: same alert, next occurrence; the prior occurrence's acknowledgement and
    // resolution belong to that occurrence's history, not to this one.
    flapping.value = decision.flapping;
    const toState = alert.state === 'suppressed' ? 'suppressed' : 'reopened';
    const { rows: [updated] } = await client.query(
      `UPDATE alert SET state = $2, condition_active = true, occurrence = occurrence + 1,
              occurrence_started_at = $3, last_firing_at = $3, last_observed_at = $3, last_event_id = $4,
              firing_count = firing_count + 1, flap_count = flap_count + $5::int, severity = $6, detail = $7,
              acknowledged_by = NULL, acknowledged_at = NULL, resolved_at = NULL, resolved_event_id = NULL,
              notified_occurrence = CASE WHEN $8::boolean THEN occurrence + 1 ELSE notified_occurrence END,
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [alert.id, toState, at, eventId, decision.flapping ? 1 : 0, severity, detail, decision.flapping],
    );
    await recordTransition(client, updated, {
      fromState: alert.state, toState, reason: decision.flapping ? 'condition-recurred-flapping' : 'condition-recurred',
      eventId, actor, occurredAt: at,
      evidence: { priorOccurrence: alert.occurrence, priorResolvedAt: alert.resolved_at, priorResolvedEventId: alert.resolved_event_id },
    });
    await receipt(client, { tenantRef, eventId, alertId: alert.id, outcome: 'reopened' });
    return { duplicate: false, outcome: 'reopened', alert: updated };
  });

  // Any delivery of an event (including a duplicate retry) re-checks whether the
  // current occurrence still owes its notification; notifyOccurrence sends at most once.
  let deliveries = null;
  if (notify?.requestedBy && result.alert) {
    const { rows: [current] } = await client.query('SELECT * FROM alert WHERE id = $1', [result.alert.id]);
    if (current?.condition_active) deliveries = await notifyOccurrence(client, current, notify);
  }
  return { ...result, flapping: flapping.value, deliveries };
}

async function loadForUpdate(client, { tenantRef, alertId }) {
  requireString(alertId, 'alertId');
  const { rows: [alert] } = await client.query(
    'SELECT * FROM alert WHERE id::text = $1 AND tenant_ref = $2 FOR UPDATE',
    [alertId, tenantRef],
  );
  if (!alert) throw new AlertStateError('alert not found in this tenant');
  return alert;
}

/**
 * Records that `actor` has seen the alert. The condition stays exactly as observed:
 * an acknowledged alert is still active and only a resolved observation resolves it.
 */
export async function acknowledgeAlert(client, { tenantRef, alertId, actor, at = new Date(), note = null }) {
  const when = requireInstant(at, 'at');
  await authorize(client, { tenantRef, actor, capability: ALERT_ACKNOWLEDGE_CAPABILITY, at: new Date() });
  return transaction(client, async () => {
    const alert = await loadForUpdate(client, { tenantRef, alertId });
    if (!['open', 'reopened'].includes(alert.state)) {
      throw new AlertStateError(`an ${alert.state} alert cannot be acknowledged`);
    }
    const { rows: [updated] } = await client.query(
      `UPDATE alert SET state = 'acknowledged', acknowledged_by = $2, acknowledged_at = $3, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [alert.id, actor, when],
    );
    await recordTransition(client, updated, {
      fromState: alert.state, toState: 'acknowledged', reason: 'acknowledged', actor, occurredAt: when,
      evidence: note ? { note: String(note) } : {},
    });
    return updated;
  });
}

/** Suppression stops notification only; the alert and its condition stay recorded. */
export async function suppressAlert(client, { tenantRef, alertId, actor, reason, at = new Date() }) {
  const when = requireInstant(at, 'at');
  requireString(reason, 'reason');
  await authorize(client, { tenantRef, actor, capability: ALERT_SUPPRESS_CAPABILITY, at: new Date() });
  return transaction(client, async () => {
    const alert = await loadForUpdate(client, { tenantRef, alertId });
    if (alert.state === 'suppressed') throw new AlertStateError('alert is already suppressed');
    const { rows: [updated] } = await client.query(
      `UPDATE alert SET state = 'suppressed', suppressed_by = $2, suppressed_at = $3, suppression_reason = $4, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [alert.id, actor, when, reason],
    );
    await recordTransition(client, updated, {
      fromState: alert.state, toState: 'suppressed', reason: 'suppressed', actor, occurredAt: when, evidence: { reason },
    });
    return updated;
  });
}

/** Lifting suppression returns the alert to what its condition is now. */
export async function unsuppressAlert(client, { tenantRef, alertId, actor, at = new Date() }) {
  const when = requireInstant(at, 'at');
  await authorize(client, { tenantRef, actor, capability: ALERT_SUPPRESS_CAPABILITY, at: new Date() });
  return transaction(client, async () => {
    const alert = await loadForUpdate(client, { tenantRef, alertId });
    if (alert.state !== 'suppressed') throw new AlertStateError('alert is not suppressed');
    const toState = alert.condition_active ? (alert.acknowledged_at ? 'acknowledged' : 'open') : 'resolved';
    const { rows: [updated] } = await client.query(
      `UPDATE alert SET state = $2, suppressed_by = NULL, suppressed_at = NULL, suppression_reason = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [alert.id, toState],
    );
    await recordTransition(client, updated, {
      fromState: 'suppressed', toState, reason: 'unsuppressed', actor, occurredAt: when,
      evidence: { suppressedBy: alert.suppressed_by, suppressionReason: alert.suppression_reason },
    });
    return updated;
  });
}

/** Alerts of one tenant, newest change first. Same gate as listAlertTransitions. */
export async function listAlerts(client, { tenantRef, actor, states = null, limit = 100, at = new Date() }) {
  await authorize(client, { tenantRef, actor, capability: ALERT_READ_CAPABILITY, at });
  if (states && states.some((state) => !ALERT_STATES.includes(state))) throw new Error('unknown alert state');
  const { rows } = await client.query(
    `SELECT * FROM alert WHERE tenant_ref = $1 AND ($2::text[] IS NULL OR state = ANY($2))
      ORDER BY updated_at DESC, id LIMIT $3`,
    [tenantRef, states, limit],
  );
  return rows;
}

/** The immutable history of one alert, oldest first, only within the caller's tenant. */
export async function listAlertTransitions(client, { tenantRef, actor, alertId, at = new Date() }) {
  await authorize(client, { tenantRef, actor, capability: ALERT_READ_CAPABILITY, at });
  requireString(alertId, 'alertId');
  const { rows } = await client.query(
    `SELECT t.* FROM alert_transition t JOIN alert a ON a.id = t.alert_id
      WHERE a.id::text = $1 AND a.tenant_ref = $2 AND t.tenant_ref = $2
      ORDER BY t.id`,
    [alertId, tenantRef],
  );
  return rows;
}

const BLAST_SEVERITY = Object.freeze({ cosmetic: 'notice', 'access-affecting': 'warning', 'tenant-lockout': 'critical' });

/**
 * Drift integration: one `baseline / drift` condition per natural key. Every drift row
 * of a detection is a firing observation; every active drift alert whose resource type
 * this detection covered and which no longer drifts is a resolved observation. Both are
 * observed at the snapshot's completion instant, so re-detecting an older snapshot
 * produces stale events that cannot close a newer occurrence. Event ids derive from
 * the snapshot and key, so re-running a detection is idempotent.
 */
export async function syncDriftAlerts(client, {
  tenantRef, snapshotId, observedAt, drift, coveredTypes, hysteresis, notify = null,
}) {
  requireString(snapshotId, 'snapshotId');
  const at = requireInstant(observedAt, 'observedAt');
  const covered = new Set(coveredTypes);
  const drifting = new Set();
  const results = [];
  for (const item of drift) {
    drifting.add(item.naturalKey);
    results.push(await applyConditionEvent(client, {
      tenantRef,
      resourceKey: item.naturalKey,
      control: 'baseline',
      condition: 'drift',
      status: 'firing',
      eventId: `drift:${snapshotId}:${item.naturalKey}`,
      occurredAt: at,
      severity: BLAST_SEVERITY[item.blastRadius] ?? 'warning',
      detail: { resourceType: item.resourceType, changeType: item.changeType, snapshotId },
      source: 'drift-detect',
      hysteresis,
      notify,
    }));
  }
  const { rows: active } = await client.query(
    `SELECT resource_key, detail FROM alert
      WHERE tenant_ref = $1 AND control = 'baseline' AND condition = 'drift' AND condition_active`,
    [tenantRef],
  );
  for (const alert of active) {
    if (drifting.has(alert.resource_key) || !covered.has(alert.detail?.resourceType)) continue;
    results.push(await applyConditionEvent(client, {
      tenantRef,
      resourceKey: alert.resource_key,
      control: 'baseline',
      condition: 'drift',
      status: 'resolved',
      eventId: `drift-clear:${snapshotId}:${alert.resource_key}`,
      occurredAt: at,
      detail: { snapshotId },
      source: 'drift-detect',
      hysteresis,
    }));
  }
  return results;
}
