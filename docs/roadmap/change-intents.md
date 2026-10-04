# Time-bounded approved emergency deviations (task-93)

Date: 2026-10-03 UTC. Status: implemented, fixture-tested only, against an isolated test
database. No live tenant was read or written, no ITSM system was contacted, and no live
qualification is claimed. The restore path is unchanged; Conditional Access is never
enforced.

## What was built

- `engine/policy/changeIntent.mjs`, the change intent.
  - **The record.** `createChangeIntent` stores one immutable approval in `change_intent`:
    - one resource (natural key and type);
    - the exact field transitions approved, each `{ field, before, after }` where a side is
      `{ present, value }` so "absent" and "null" stay distinct;
    - the owner (who made or will make the change) and the approver;
    - a window `[windowStart, windowEnd)`, at most 7 days, never starting in the past;
    - the reason and an optional external change id (a ticket reference, validated, never
      a secret);
    - `decision_digest`, the canonical digest (`canonicalDigest`, the dry run's hashing) of
      everything the approval binds (`changeIntentDecision`).
  - **Two ways to approve.**
    - From an open change: `driftId` plus the field names. The transitions are taken
      exactly from that drift row's own baseline and observed payloads, so an approver
      cannot type a value that differs from what was observed.
    - Ahead of the change: `naturalKey`, `resourceType` and explicit `transitions`, for an
      emergency approved before it is made. The portal exposes the first; the API accepts
      both.
  - **Who may approve.** The approver must hold `approve` centrally at that instant
    (`can()`), the owner must be another enabled principal (`owner-is-approver` is refused,
    and the table repeats it as a CHECK), and the window is bounded.
  - **Immutable.** `change_intent` and `change_intent_event` are append-only (a trigger
    rejects UPDATE and DELETE). A revocation or settlement is a new
    `change_intent_event` row (`revoked`, `settled`), one of each per intent
    (`UNIQUE (intent_id, kind)`), so a repeated or concurrent revoke or settle acts once.
  - **What it suppresses.** `classifyDrift` decides, for one drift row and the intents in
    force at `now`:
    - `approved`: every field the drift changes matches an approved transition (same field,
      same before value, same after value);
    - `unapproved`: an intent is in force for the resource, but the drift is not wholly the
      approved change (another field changed, the same field moved to a different value,
      or the resource was added or removed);
    - `none`: no intent is in force for the resource.
  - **Clock.** An intent is in force from `windowStart` up to, not including, `windowEnd`;
    a revocation takes effect at the instant it was recorded. Every check takes `now`
    explicitly, so the boundaries are deterministic.
  - **When the window ends.** `settleChangeIntents` settles each intent that ended (window
    over or revoked) and was not settled yet. It re-reads the resource's current state with
    `currentResourceState`:
    - `matches-baseline`: the newest complete collection of that type has the resource as
      the baseline has it. Nothing is rolled back.
    - `drifted`: the newest collection differs and drift detection recorded a drift row for
      it. That newest row (not the change the approval was made from) goes through the
      normal path: `evaluateDrift`, then `executeAutoRemediation` for each automatic match.
    - `awaiting-detection`: the newest collection differs but no drift row was recorded
      for it yet. Nothing acts; the next drift detection and policy evaluation decide.
    - `unknown`: no active baseline, or no collection of this type. Nothing acts.
    The settlement and its result are evidence (`change-intent`, outcome `settled`). The
    intent's own before value is never written back.
  - **Revocation.** `revokeChangeIntent` (approver only, reason required) records the
    revocation, then settles the intent immediately, so the resource is evaluated afresh at
    once.
- `engine/policy/execute.mjs`. `executeAutoRemediation` asks `assessDrift` after its
  existing guardrails (halt file, enabled, paused, run-as, ceiling) and before the rate
  limit:
  - `approved`: refused with `change-intent-approved`, recorded as automation evidence with
    the intent ids and approved fields. No job is queued. The drift row is untouched and
    stays open.
  - `unapproved`: queued as before. The `queued` evidence carries
    `changeIntent: { applied: false, reason, approvedFields, unapprovedFields }`, so the
    record says why the approval did not apply.
- `cli/keel-remediate.mjs`. When the remediate job carries automatic executions, it calls
  `assertNoApprovedTransition` after resolving the scope and before any dry run. A roll
  back queued before an approval stops there while the approval is in force. A
  human-requested roll back has no automatic execution row and is not affected: an
  operator may still roll an approved change back on purpose.
- `cli/keel-policy-evaluate.mjs`. The policy-evaluate job settles ended intents first,
  then evaluates open drift as before.
- `engine/store/schema.sql`. Additive: `change_intent`, `change_intent_event`, an index,
  and the append-only trigger. Re-applying the schema is a no-op.
- Portal (Changes › Emergency changes, `/emergency-changes`).
  - `portal/lib/change-intents.ts`: `GET /api/change-intents` (intents with their state,
    the open changes that can be approved field by field, and the people who can own one),
    `POST /api/change-intents` (approve) and `POST /api/change-intents/<id>/revoke`. All
    three require a central `approve` grant, record the attempt, and leave every decision
    to the engine, which re-checks the approver.
  - `portal/components/change-intent.tsx`: each approval as a card. The card says what KEEL
    holds back and until when, who approved it for whom, that any other change to the
    resource is still rolled back, and, once ended, what KEEL found when it checked again.
    The form approves chosen fields of one open change for 1 hour to 7 days. Identifiers,
    the decision digest, the raw transitions and the settlement are in the record layer.
  - `portal/app/emergency-changes/page.tsx`: guarded by the approve grant before it
    connects, like the approval inbox. The page is a tab of Changes, shown to approvers.

## Preserved invariants

- The drift stays recorded and open. An intent writes no disposition, hides nothing from
  Changes, and does not silence alert policies (`evaluateDrift` records the match as
  before).
- Automatic roll back still goes only through `executeAutoRemediation`, the worker and
  `runRestore`. An intent adds a refusal; it never adds a write path.
- An approval suppresses nothing outside its exact transitions, resource, tenant and
  window.
- Expiry never applies an inverse. It re-reads and uses the normal evaluation.

## Acceptance evidence (fixture-tested, `engine/roadmap/change-intents.test.mjs`)

- **An authorized emergency field change stays visible and is not rolled back in its
  window.** The policy still matches, the automation refusal is `change-intent-approved`,
  no job exists, and the drift is still open.
- **Another field change still triggers.** On the same resource, a drift that also changes
  `displayName` is queued, and its evidence lists `displayName` as unapproved.
- **Expiry resumes evaluation.** At `windowEnd` the same drift is queued. On settlement,
  a resource already back at its baseline queues nothing, a still-drifted one queues a
  roll back of the newest drift row, and an undetected collection waits.
- **A changed transition cannot reuse the approval.** The same field moved to a different
  value is queued; the same transition on another resource is queued; the intent cannot be
  edited or deleted (the trigger rejects it).
- **Clock boundaries and revocation are deterministic.** The intent is off one instant
  before `windowStart`, on at `windowStart` and one instant before `windowEnd`, and off at
  `windowEnd`. A revocation is off at its instant; a second revocation, or one after the
  window, is refused; only an approver can revoke.
- **Execution re-check.** A roll back queued before the approval is refused by
  `runRemediate` before any dry run; a human-requested one proceeds.
- **Legacy read.** Before the tables exist, there are no intents and nothing is suppressed.
- Portal: `portal/test/change-intents.test.ts` (routes refuse non-approvers and a header
  claim the engine does not confirm; approve, list, revoke and their refusals) and the UI
  harness route `emergency-changes` (contract checks 1 to 7, axe in both themes, and an
  interaction test).

## Required mutation checks

Each was applied to `engine/policy/changeIntent.mjs`, made the named test fail, and was
reverted.

1. **Suppress whole resource instead of scoped field** (`classifyDrift` returns `approved`
   whenever an intent is in force for the resource): the scope test fails because the
   drift that also changes `displayName` is refused instead of queued.
2. **Ignore intent expiry** (`intentActiveAt` and `activeIntentsFor` drop the `windowEnd`
   bound): the clock test fails because the drift is still refused at `windowEnd`.
3. **Apply expired inverse without reread** (settlement acts on the intent's source drift
   instead of reading the current state): the expiry test fails because a resource already
   back at its baseline gets a roll back queued.

## Limits and decisions

- **Field granularity is top-level.** A transition names a top-level payload field (the
  same field set `changedFields` uses for attribution). A change inside a nested object is
  approved as a change to that whole field's value.
- **Roll back is per resource.** KEEL's restore writes whole resources. When a drift also
  changes an unapproved field, the normal roll back returns the approved field to its
  baseline value too. This is the decision the task states ("concurrent unrelated field
  changes still alert/remediate normally"): the resource is not in the approved state, so
  the approval does not apply. The evidence records it. Where that matters, a policy for
  the resource should require approval rather than roll back automatically.
- **Only modified resources** can be approved field by field. An added or removed resource
  is a whole-resource change and is never suppressed.
- **Stale open drift rows.** Drift rows accumulate per collection. An older open row whose
  transition differs from the approval (for example, from before the emergency change) is
  not covered and is handled normally. An automatic roll back of it would also revert the
  approved field.
- **Current state at expiry** is the newest complete collection that holds any resource of
  the type. If that collection did not cover the type completely, absence is read as
  removal. Settlement then waits for a drift row (`awaiting-detection`) rather than act.
- **Central approvers only.** Approving, revoking and listing require a tenant-wide
  `approve` grant. An entity-scoped approver is refused, not shown a partial list.
- **ITSM mirroring is not built.** `decision_digest` and `external_change_id` are stored
  for a future mirror (task-97). That mirror must carry the same digest, so the ticket and
  KEEL name the same decision. Nothing is sent to an external system.
- **Settlement cadence.** Settlement runs at the start of every policy-evaluate job and on
  revocation. Between jobs, an ended intent is already inactive for every check, because
  each check reads the window at `now`. Only the fresh re-read waits for the next job.
