# Acknowledgement deadlines, escalation and the alerts inbox (task 83)

Date: 2026-10-03 UTC. Status: implemented, fixture-tested only. No notification was
sent to a real endpoint.

## What was built

### Escalation rules (`alert_escalation_rule`)
- Each rule is per tenant and names:
  - an optional `control`, where null means any control;
  - a `min_severity`;
  - an acknowledgement window, `ack_within_ms`;
  - an optional owner principal;
  - an optional escalation channel.
- `createEscalationRule` requires `configuration`.
- When an alert has several matching rules, the one that names its control wins over a
  catch-all. After that, the shortest window wins.

### Persisted deadlines (`engine/notify/escalation.mjs`, `planDeadline`)
- When an occurrence opens or reopens, the task-82 lifecycle calls `planDeadline` in
  the same transaction. It writes these columns on the alert row:
  - `ack_deadline_at`, which is the occurrence start plus the window;
  - `owner_principal_id`;
  - `owner_source`, which is `rule` or `unassigned`;
  - `escalation_rule_id`.
- Assignment never falls back silently. An alert with no rule, or with a rule that has
  no owner, is recorded as `unassigned` and shown as such.
- A deadline exists only in the database, so a restarted worker finds every overdue
  alert again.

### Escalation (`escalateOverdue`)
- Each sweep locks every overdue alert (`FOR UPDATE`) and checks it again: it must
  still be `open` or `reopened`, still active, past its deadline, and not yet escalated
  for this occurrence.
- In that same transaction the sweep claims the occurrence. It sets
  `escalated_occurrence = occurrence`, queues a delivery of `alert.escalated` to the
  rule's channel, and appends an `escalated-ack-deadline-missed` transition.
- The delivery is queued with `queueDelivery`, which this task factored out of
  `dispatchAlert`. Concurrent sweeps therefore escalate an occurrence once. A
  recurrence is a new occurrence with its own deadline and its own single escalation.
- The sender must hold `configuration`, the same rule `dispatchAlert` applies. The
  worker sweeps between job polls as the scheduler system principal
  (`sweepAlertEscalations` in `cli/keel-worker.mjs`). Without a scheduler principal,
  it skips the sweep and logs why.

### Re-check before sending
- `attemptDelivery` checks an escalation delivery against its alert immediately before
  the transport runs. Escalations are marked `requiresUnacknowledged`.
- If the alert was acknowledged, resolved, or reopened as a newer occurrence in the
  meantime, the delivery is cancelled with the reason. The transport is never called.
- This covers an acknowledgement that lands after the escalation was queued. The
  sweep's own re-check under the row lock covers one that lands before it.

### Missing recipient
- When the rule has no channel, or its channel is disabled or gone, the sweep records
  an actionable `escalation_error` on the alert, telling the operator to add an
  enabled channel to the escalation rule.
- It also appends one `escalation-failed-no-recipient` transition. The transition is
  not repeated on every sweep.
- The occurrence stays unclaimed, so it escalates as soon as a channel is set.

### Manual resolve (`resolveAlert` in `alerts.mjs`)
- An operator can close an active alert by hand. This needs `dispose-accept`, the same
  right as acknowledging and never the viewing right.
- It records the actor and reason, and marks the condition cleared from that moment,
  so the next firing reopens the alert as a new occurrence.

### Portal
- **Changes › Alerts** is at `/alerts`. It needs `read`
  (`DATA_SURFACES.alertsPage`).
  - It has one verdict sentence: how many alerts wait for acknowledgement and how many
    are past the deadline.
  - Each alert shows its owner (or the explicit unassigned state), its deadline or
    missed deadline, its state and current cause, and its full history. The record
    layer holds the alert id, the resource, the condition, the occurrence, the latest
    event and the snapshot.
- `GET /api/alerts` needs `read` and returns the alerts with their owner names and
  histories.
- `POST /api/actions/alerts` accepts `{ alertId, action: "acknowledge" | "resolve" }`.
  - The guard requires `dispose-accept` and records each attempt, refused ones
    included.
  - The engine checks the grant again in the database, so a forged header is still
    refused (403).
  - A state conflict returns 409.
- The Acknowledge and Resolve controls render only for people who may use them.

## Migration and legacy reads

The changes are additive:
- one new table;
- new `alert` columns with defaults: `owner_source` defaults to `unassigned` and
  `escalated_occurrence` to 0;
- one partial index.

Alerts created before this change have no deadline and are never escalated. They
appear as unassigned until they reopen.

## Limitations

- Fixture-tested only. An escalation goes to whatever channel the rule names; since
  task-84 that can also be Teams, Slack, PagerDuty or SMS
  (`docs/roadmap/notification-adapters.md`).
- There is no portal form for escalation rules yet. Rules are created with
  `createEscalationRule` (or SQL) by an operator who holds `configuration`.
- One escalation per occurrence. There is no repeated re-notification ladder.
- The sweep runs in the worker's idle loop, so a long-running job delays it until the
  job ends. The deadline itself is unaffected.
- A manual resolve can be followed by an observation from before the resolve. That
  observation reopens the alert, because manual resolution does not move the
  observation clock.

## Boundary tests

`engine/roadmap/alert-escalation.test.mjs` has 5 tests. They use an isolated schema.
- One test runs the worker sweep in a fresh process.
- One runs the real portal routes and the inbox component through tsx.

Required mutations were each applied alone and then restored (2026-10-03):

| Mutation | Pass | Fail |
| --- | --- | --- |
| Use process memory for deadline (Map instead of `ack_deadline_at`) | 0 | 5 |
| Skip ack re-check before send | 4 | 1 |
| Allow read-only resolve (portal guard `read`) | 4 | 1 |
| Allow read-only resolve (engine `resolveAlert` with `read`) | 4 | 1 |

The task-82 suite still passes (11 of 11). The UI harness gained an `alerts` route,
which gets axe checks in both themes and the contract checks with its record ids. All
91 harness checks pass.
