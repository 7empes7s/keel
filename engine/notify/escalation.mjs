// engine/notify/escalation.mjs
//
// Roadmap task-83: acknowledgement deadlines and escalation over the task-82 alert
// lifecycle and the task-20 delivery primitives.
//
//  - A deadline is computed when an occurrence opens or reopens, from the most specific
//    enabled escalation rule matching the alert, and PERSISTED on the alert row
//    (ack_deadline_at). Nothing about a deadline lives in process memory, so a worker
//    restart finds every overdue alert again.
//  - The owner comes from that rule. With no rule, or a rule without an owner, the alert
//    is explicitly unassigned (owner_source = 'unassigned'); nothing guesses an owner.
//  - escalateOverdue claims an occurrence atomically under the alert's row lock
//    (escalated_occurrence < occurrence, then set to occurrence), re-checking that it is
//    still unacknowledged, active and overdue, so concurrent sweeps escalate it once.
//  - The escalation is a normal delivery to the rule's channel, queued in the same
//    transaction as the claim. attemptDelivery re-checks the acknowledgement immediately
//    before the transport (notifications.mjs), so an acknowledgement that races the
//    deadline still suppresses the send.
//  - A rule with no usable channel is an actionable error recorded on the alert and in
//    its history; the occurrence stays unclaimed so it escalates once a channel exists.
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { queueDelivery } from './notifications.mjs';

export const ESCALATION_CAPABILITY = 'configuration';
const SEVERITY_RANK = Object.freeze({ notice: 0, warning: 1, critical: 2 });

export const MISSING_RECIPIENT = 'No escalation channel is set for this alert. Add an enabled channel to its escalation rule in Settings, Notifications.';

export class EscalationAuthorizationError extends Error {
  constructor(message) { super(message); this.name = 'EscalationAuthorizationError'; }
}

async function authorize(client, actor, capability) {
  const principal = await findPrincipalById(client, actor);
  if (!principal || !(await can(client, principal, capability, new Date()))) {
    throw new EscalationAuthorizationError(`escalation: ${capability} capability required`);
  }
}

export async function createEscalationRule(client, {
  tenantRef, control = null, minSeverity = 'notice', ackWithinMs, ownerPrincipalId = null,
  escalateChannelId = null, createdBy,
}) {
  await authorize(client, createdBy, ESCALATION_CAPABILITY);
  if (typeof tenantRef !== 'string' || !tenantRef) throw new Error('tenantRef is required');
  if (!(minSeverity in SEVERITY_RANK)) throw new Error('minSeverity must be notice, warning or critical');
  if (!Number.isInteger(ackWithinMs) || ackWithinMs <= 0) throw new Error('ackWithinMs must be a positive integer');
  const { rows: [rule] } = await client.query(
    `INSERT INTO alert_escalation_rule
       (tenant_ref, control, min_severity, ack_within_ms, owner_principal_id, escalate_channel_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tenantRef, control, minSeverity, ackWithinMs, ownerPrincipalId, escalateChannelId, createdBy],
  );
  return rule;
}

/** The most specific enabled rule for an alert: a control match beats a catch-all, then the shortest window. */
export async function ruleForAlert(client, alert) {
  const { rows } = await client.query(
    `SELECT * FROM alert_escalation_rule
      WHERE tenant_ref = $1 AND enabled AND (control IS NULL OR control = $2)
      ORDER BY (control IS NULL), ack_within_ms, created_at, id`,
    [alert.tenant_ref, alert.control],
  );
  return rows.find((rule) => SEVERITY_RANK[alert.severity] >= SEVERITY_RANK[rule.min_severity]) ?? null;
}

/**
 * Called inside the alert lifecycle's transaction whenever an occurrence opens or
 * reopens: persists that occurrence's deadline and owner on the alert row.
 */
export async function planDeadline(client, alert) {
  const rule = await ruleForAlert(client, alert);
  const deadline = rule ? new Date(new Date(alert.occurrence_started_at).getTime() + rule.ack_within_ms) : null;
  const { rows: [updated] } = await client.query(
    `UPDATE alert SET ack_deadline_at = $2, owner_principal_id = $3, owner_source = $4, escalation_rule_id = $5,
            escalation_error = NULL
      WHERE id = $1 RETURNING *`,
    [alert.id, deadline, rule?.owner_principal_id ?? null, rule?.owner_principal_id ? 'rule' : 'unassigned', rule?.id ?? null],
  );
  return updated;
}

async function transition(client, alert, { reason, actor, at, evidence }) {
  await client.query(
    `INSERT INTO alert_transition
       (alert_id, tenant_ref, occurrence, from_state, to_state, reason, actor, occurred_at, evidence)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8)`,
    [alert.id, alert.tenant_ref, alert.occurrence, alert.state, reason, actor, at, evidence],
  );
}

const overdue = (alert, now) => ['open', 'reopened'].includes(alert.state) && alert.condition_active
  && alert.ack_deadline_at && new Date(alert.ack_deadline_at).getTime() <= now.getTime()
  && alert.escalated_occurrence < alert.occurrence;

async function escalateOne(client, alertId, { now, requestedBy }) {
  await client.query('BEGIN');
  try {
    const { rows: [alert] } = await client.query('SELECT * FROM alert WHERE id = $1 FOR UPDATE', [alertId]);
    // Re-evaluate under the lock: an acknowledgement, resolution or another sweep that
    // committed first wins.
    if (!alert || !overdue(alert, now)) {
      await client.query('COMMIT');
      return { alertId, outcome: 'not-due' };
    }
    const rule = alert.escalation_rule_id
      ? (await client.query('SELECT * FROM alert_escalation_rule WHERE id = $1', [alert.escalation_rule_id])).rows[0]
      : null;
    const channel = rule?.escalate_channel_id
      ? (await client.query('SELECT * FROM channel WHERE id = $1 AND enabled', [rule.escalate_channel_id])).rows[0]
      : null;
    if (!channel) {
      if (alert.escalation_error !== MISSING_RECIPIENT) {
        await client.query('UPDATE alert SET escalation_error = $2, updated_at = now() WHERE id = $1', [alert.id, MISSING_RECIPIENT]);
        await transition(client, alert, {
          reason: 'escalation-failed-no-recipient', actor: 'keel-escalation', at: now,
          evidence: { ruleId: rule?.id ?? null, channelId: rule?.escalate_channel_id ?? null },
        });
      }
      await client.query('COMMIT');
      return { alertId, outcome: 'missing-recipient', error: MISSING_RECIPIENT };
    }
    const { delivery } = await queueDelivery(client, {
      channelId: channel.id,
      requestedBy,
      event: {
        kind: 'alert.escalated',
        severity: alert.severity,
        alertId: alert.id,
        occurrence: alert.occurrence,
        tenantRef: alert.tenant_ref,
        resourceKey: alert.resource_key,
        control: alert.control,
        condition: alert.condition,
        ownerPrincipalId: alert.owner_principal_id,
        ackDeadlineAt: new Date(alert.ack_deadline_at).toISOString(),
        requiresUnacknowledged: true,
      },
    });
    await client.query(
      'UPDATE alert SET escalated_occurrence = occurrence, escalation_error = NULL, updated_at = now() WHERE id = $1',
      [alert.id],
    );
    await transition(client, alert, {
      reason: 'escalated-ack-deadline-missed', actor: 'keel-escalation', at: now,
      evidence: { deliveryId: delivery.id, channelId: channel.id, ackDeadlineAt: alert.ack_deadline_at },
    });
    await client.query('COMMIT');
    return { alertId, outcome: 'escalated', deliveryId: delivery.id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** One sweep over overdue alerts, oldest deadline first. Safe to run from several workers. */
export async function escalateOverdue(client, { requestedBy, now = new Date(), limit = 50 } = {}) {
  await authorize(client, requestedBy, ESCALATION_CAPABILITY);
  const { rows } = await client.query(
    `SELECT id FROM alert
      WHERE state IN ('open','reopened') AND condition_active
        AND ack_deadline_at <= $1 AND escalated_occurrence < occurrence
      ORDER BY ack_deadline_at, id LIMIT $2`,
    [now, limit],
  );
  const results = [];
  for (const { id } of rows) results.push(await escalateOne(client, id, { now, requestedBy }));
  return results;
}

/**
 * The worker's sweep identity is the scheduler system principal (it holds
 * `configuration`); without one, escalation is skipped and says so.
 */
export async function sweepEscalations(client, { now = new Date(), log = console.error } = {}) {
  const { rows: [scheduler] } = await client.query(
    "SELECT id FROM principal WHERE system_kind = 'scheduler' AND disabled_at IS NULL",
  );
  if (!scheduler) {
    log('alert escalation skipped: no enabled scheduler principal to send escalations as');
    return null;
  }
  return escalateOverdue(client, { requestedBy: scheduler.id, now });
}
