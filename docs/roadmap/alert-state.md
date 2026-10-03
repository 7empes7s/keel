# Durable alert lifecycle and flapping behavior (task 82)

Date: 2026-10-03 UTC. Status: implemented, fixture-tested only. No external
notification was sent and no tenant was read or changed.

## What was built

- **Schema** (`engine/store/schema.sql`, additive and re-appliable):
  - `alert` holds one row per condition identity: tenant, resource key, control and
    condition. This is enforced by the unique index `alert_condition_identity_idx`.
    A recurrence reopens the same row as the next `occurrence`.
  - `alert_transition` is the append-only history. A trigger refuses `UPDATE` and
    `DELETE`.
  - `alert_event_receipt` holds one row per applied event id. It records what that
    event did: opened, updated, resolved, reopened, flap-held, stale,
    already-resolved or no-alert.
- **Engine** (`engine/notify/alerts.mjs`):
  - `applyConditionEvent` takes a firing or resolved observation with a stable event
    id and the instant it was observed.
  - `acknowledgeAlert`, `suppressAlert` and `unsuppressAlert` are operator actions.
  - `listAlerts` and `listAlertTransitions` are the read paths.
  - `syncDriftAlerts` is the drift integration.
  - `decideTransition` is the pure decision used by `applyConditionEvent`.
- **Drift integration** (`cli/keel-drift.mjs detect`): after recording drift rows,
  detection applies a `baseline / drift` condition for each natural key.
  - Every drift item is a firing.
  - Every active drift alert whose resource type this detection covered and which no
    longer drifts gets a resolution.
  - Both are observed at the snapshot's `completed_at`.
  - Event ids are `drift:<snapshot>:<key>` and `drift-clear:<snapshot>:<key>`, so
    replaying a detection is a duplicate.
- **Notifications** use the task-20 primitives unchanged. When `notify.requestedBy`
  is given, an opened or reopened occurrence is dispatched through `dispatchAlert` as
  `alert.opened` or `alert.reopened`. That requester must hold `configuration`, as
  before. `notified_occurrence` makes this at most once per occurrence. A retry of
  the same event repairs a notification lost between the state commit and the
  dispatch.

## Lifecycle rules

| Current | Observation | Result |
| --- | --- | --- |
| none | firing | `open`, occurrence 1 |
| none | resolved | nothing; receipt `no-alert` |
| active (`open`, `acknowledged`, `reopened`) | firing | same alert; `firing_count`, `last_firing_at` and severity updated; no transition |
| active | resolved at or after `last_firing_at + resolveMs` | `resolved` |
| active | resolved before `last_firing_at + resolveMs` | still active; `flap_count + 1`; `resolution-held-flapping` transition |
| `resolved` | firing | `reopened`, occurrence + 1; acknowledgement and resolution cleared; prior values kept in the transition evidence |
| `resolved` | firing before `resolved_at + reopenMs` | as above, marked flapping and not notified again |
| any | observed before `last_observed_at` | nothing; receipt `stale` |
| any | event id already received | nothing; `duplicate: true` |

- **Acknowledging** (`dispose-accept`) records the actor and time on `open` or
  `reopened` alerts only. It never changes `condition_active` and never resolves.
- **Suppressing** (`policies`, with a required reason) keeps the row and keeps
  tracking the condition. While suppressed, firings and resolutions still update
  `condition_active` and the occurrence, and nothing is notified. Lifting
  suppression returns the alert to `open`, `acknowledged` or `resolved`, depending on
  the condition as it is now.
- **Reading** alerts and transitions both require `read`, through the same
  `authorize` call. They always filter by the caller's tenant: an alert id from
  another tenant reads as empty and cannot be acted on.
- **Grants** are checked at the current instant. The `at` of an operator action is
  only the evidence time recorded with it.
- **Concurrency:**
  - Concurrent first firings for one identity converge on one row. The first firing
    inserts with `ON CONFLICT DO NOTHING` on the identity index. The loser waits on
    the index, then locks and updates the committed row with `SELECT ... FOR UPDATE`.
  - Concurrent deliveries of the same event id serialise on the receipt's primary
    key.
- **Ordering is by observation time.** An equal timestamp is not stale. A resolution
  arriving late from an earlier occurrence therefore cannot close a newer one.

## Default hysteresis

`resolveMs` and `reopenMs` both default to 0, so there is no holding by default. The
comparison is strict (`<`): with `resolveMs: 0`, a resolution at the same instant as
the last firing resolves the alert. A held resolution is never applied later on its
own. The next resolved observation outside the window resolves the alert, which
drift detection supplies on its next clean run.

## Migration and legacy reads

The change is additive DDL only: new tables, an index, and a trigger function. Apply
`engine/store/schema.sql` before deploying the new `keel-drift.mjs`; detection fails
if the alert tables are missing. Existing drift rows are not back-filled into
alerts. The first detection after deployment opens alerts for whatever is drifting
then.

## Limitations

- Fixture-tested only. Drift detection does not yet pass a requester, so it creates
  and resolves alerts without sending notifications. Wiring a notify requester and
  the hysteresis configuration into the scheduler is left to task-83, along with
  deadlines, escalation and the inbox UI.
- Drift is the only producer. Other conditions can call `applyConditionEvent` with
  their own control and condition names.
- Ignored-drift dispositions are still recorded as firing alerts. Suppress the alert
  to silence it.
- The capabilities chosen here (`read`, `dispose-accept`, `policies`) are the
  current role matrix's closest fits. Task-83 owns the separate ack and resolve
  authorization.

## Boundary tests

`engine/roadmap/alert-state.test.mjs` has 11 tests. They use an isolated schema,
and one of them runs the real drift CLI. Mutations were each applied alone and then
restored (2026-10-03):

| Mutation | Pass | Fail |
| --- | --- | --- |
| Acknowledge also resolves the condition | 9 | 2 |
| Create new alert on every retry (receipt dedup skipped) | 7 | 4 |
| Apply stale resolution to newer occurrence (stale check removed) | 9 | 2 |
| Plain INSERT on first firing (addendum 1, concurrency) | 1 | 10 |
| Reopen keeps `resolved_event_id` (addendum 2) | 9 | 2 |
| Inclusive `<=` hysteresis boundary (addendum 4) | 10 | 1 |

Validation: `node --test engine/roadmap/alert-state.test.mjs engine/authz/*.test.mjs
engine/jobs/*.test.mjs` gives 16 pass, 0 fail. The suite is also added to the CI
engine test step.
