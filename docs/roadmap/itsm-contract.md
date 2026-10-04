# Canonical approval mirror and ITSM adapter contract (task-96)

Date: 2026-10-04 UTC. Status: implemented, fixture-tested only, against an isolated test
database with an injected fixture adapter. No ITSM system was contacted, no live tenant
was read or written, and no live qualification is claimed. The ServiceNow adapter, its
callback authentication and its qualification are task-97 and task-118.

## The rule

KEEL holds the one canonical decision. An ITSM change record is a mirror of it.

- For an action that needs approval, the decision is the `approval_request` row
  (`engine/govern/approvals.mjs`). It is decided once, under a row lock, and mints at most
  one job (idempotency key `approval:<request id>`), whether the decision came from the
  portal or from an ITSM callback.
- For an emergency change (task-93), the decision is the change intent, decided in KEEL;
  its `decision_digest` is mirrored unchanged.
- An external "approved" status is never authority on its own. It decides only when the
  callback names the record's current plan, its external user is mapped to an enabled KEEL
  principal, and that principal is an eligible approver now.

## What was built

- `engine/itsm/bridge.mjs`, the mirror.
  - **Adapter contract** (`ITSM_ADAPTER_CONTRACT`, `assertAdapter`). An adapter has a
    `name`, `deliver(event)` (at-least-once, dedup on the event id; an error with
    `permanent: true` cannot be fixed by retrying) and `fetchRecord(externalRef)` (the
    record's current state, for reconciliation). Inbound events reach `receiveCallback`
    already authenticated and normalized to `{ eventId, externalRef, status, externalUser,
    version, planDigest, reason? }`.
  - **Identity mapping** (`mapExternalIdentity`, configuration capability). An external user
    of one adapter maps explicitly to one KEEL principal. The mapping says who the person
    is. Their current KEEL grants decide what they may do.
  - **Mirroring a request** (`mirrorApprovalRequest`, configuration capability). The first
    call binds an external record to a pending request at version 1, with the plan digest
    `approvalPlanDigest(request)` (the canonical digest of its action and immutable params;
    for a restore, the dry-run artifact reference). Mirroring the same record with another
    pending request is a re-plan: the record moves to the next version, the old request is
    superseded (closed as expired, reason `superseded: <id>`), and the new binding is sent
    out. Every bound version stays in `itsm_record_version`. A record whose current version
    was already decided cannot be re-planned.
  - **Mirroring an emergency change** (`mirrorChangeIntent`). Records the intent's decision
    with `source = 'keel'` and `decision_digest` equal to the intent's `decisionDigest`, and
    sends it out. A callback on that record is `not-decidable`.
  - **The canonical decision** (`itsm_decision`, append-only, one per record version). It
    holds the outcome, the approver principal, the source (`portal`, `itsm` or `keel`), the
    external event id it came from, the plan digest, the version and `decision_digest =
    canonicalDigest(decision)`. Its row id is the decision's immutable event id, and the
    outbound event id is `keel:decision:<id>`.
  - **Callbacks** (`receiveCallback`). Each event id is handled once (`itsm_inbox`, unique per
    adapter). A redelivery returns the first outcome with `duplicate: true` and does nothing
    more. An event left `applying` (the handler stopped part-way) is resumed, and each step
    is idempotent. The checks run in this order:
    1. The record exists for this tenant, and it mirrors an approval request.
    2. The status is `approved` or `rejected`. Any other status is `ignored-status`.
    3. The callback's version equals the record's current version (`stale-version`) and
       its plan digest equals the current digest (`stale-plan`).
    4. The external user maps to an enabled principal (`unmapped-identity`).
    5. `approveRequest` or `rejectRequest` runs as that principal with `enforceScope` and
       `expectedPlanDigest`. Current grants and task-90 entity scope decide eligibility,
       self-approval is refused, and the digest is checked again under the request's row
       lock. The refusals are `refused-not-eligible`, `refused-self-approval`,
       `refused-invalidated`, `refused-expired` and `refused-promotion`.
  - **Two decisions at once.** The request row lock orders them, and the first committed
    decision stands. A later callback with the same outcome is `already-decided`. One with
    the other outcome is a `conflict`: it is recorded in the inbox with the canonical
    outcome and decision id, written as `itsm-decision-conflict` evidence and sent out as a
    `conflict` event, so the external record can show the canonical decision. `listMirror`
    shows conflicts and refused callbacks next to the decision.
  - **Lost callbacks** (`reconcileRecord`). Polls `adapter.fetchRecord` and handles the
    state as a callback under the deterministic event id
    `reconcile:<ref>:v<version>:<status>:<user>`. Polling twice acts once, and a late
    original callback finds the request already decided.
  - **Portal decisions** (`syncMirrorDecisions`, run by `runMirrorCycle` before delivery).
    Records the canonical decision of every mirrored request decided outside a callback.
    The source is `itsm` when a callback by the deciding principal was being applied to it
    (a resumed crash), and `portal` otherwise.
  - **Read** (`listMirror`, read capability, tenant-scoped). Each record with its versions,
    decisions, conflicts, refused callbacks and outbox counts.
- `engine/itsm/outbox.mjs`, the outbound side. `itsm_outbox_event` delivers at least once
  under deterministic event ids: `keel:<record>:v<n>:record`, `keel:decision:<id>` and
  `keel:conflict:<inbox id>`. Each event is claimed with a lease before delivery and
  retried with capped exponential backoff over `next_attempt_at`. An event is quarantined
  with its reason when the adapter rejects it permanently or it runs out of attempts. A
  failed delivery never changes the canonical decision.
- `engine/govern/approvals.mjs`.
  - `approvalPlanDigest(request)` gives the digest of a request's plan.
  - `approveRequest` and `rejectRequest` take an optional `expectedPlanDigest`, checked
    under the row lock. A mismatch throws `ApprovalPlanChangedError` and decides nothing.
  - `supersedeRequest` closes a pending request replaced by a re-plan, with evidence.
  - Behaviour without the new options is unchanged.
- `engine/store/schema.sql`, additive only: `itsm_record`, `itsm_record_version`,
  `itsm_identity_map`, `itsm_decision`, `itsm_inbox`, `itsm_outbox_event`, their indexes,
  and append-only triggers on `itsm_decision` and `itsm_record_version`. Every table
  carries `tenant_ref`. Nothing existed before, so there is no legacy data to migrate, and
  re-applying the schema is a no-op (the test applies it twice).

## Acceptance evidence (fixture-tested, `engine/roadmap/itsm-contract.test.mjs`)

- **Portal and external approvals yield one decision and one action.** Whichever side
  decides first, the other finds the request closed: a portal `ApprovalClosedError`, or a
  callback that is `already-decided`. There is one job, one `itsm_decision` row and one
  outbound decision. The mirrored payload equals `approvalDecision(...)` and carries its
  digest and immutable event id.
- **A delayed callback cannot approve a newer plan.** After a re-plan with identical params
  (same digest, version 2), the version-1 callback is `stale-version` and the new request
  stays pending with no job. A future version or another digest is refused. Under the row
  lock, `approveRequest` with a stale `expectedPlanDigest` is refused. The current callback
  decides. Every version stays listed, and the refused callbacks stay visible.
- **A duplicate callback is idempotent.** A redelivered event id returns the first outcome,
  with no second job, decision, outbound decision or callback evidence. A handler stopped
  after deciding resumes on redelivery and records the decision once, as `itsm`. A lost
  callback is recovered by polling, and a second poll or the late original acts no further.
- **An external user without a current grant is refused.** Each of these leaves the request
  pending with no job and no decision:
  - no user, an unmapped user, or a disabled principal;
  - a viewer, or a lapsed approver grant;
  - the requester;
  - a grant that lapses after mapping;
  - a non-decision status;
  - an unknown record, or another tenant's record.
  Reads need `read` and mirroring needs `configuration`.
- **Conflicting decisions remain visible.** A portal approval followed by an external
  rejection keeps `approved`. The conflict is in the inbox, in `itsm-decision-conflict`
  evidence, in an outbound `conflict` event carrying the canonical decision digest, and in
  `listMirror`. In a race between a portal approval and an external rejection on two
  connections, exactly one decides, the other is refused or recorded as the conflict, and
  the mirror's decision equals the request's.
- **Emergency changes.** The mirrored decision digest is the intent's `decisionDigest`, and
  a callback cannot decide it.
- **Delivery.** A transient failure is retried and then delivered. A permanent rejection is
  quarantined with its reason, and the request stays approved with its one job.
  `itsm_decision` rejects UPDATE. The evidence chain verifies.

## Required mutation checks

Each mutation was applied to `engine/itsm/bridge.mjs` in a copy of the tree. Each one made
the named test fail, and each was reverted. The restored suite passes 8 of 8.

1. **Authorize from an external "approved" string alone.** `receiveCallback` decides with
   `enforceScope: false`, so the mapped principal's current `approve` grant is not
   checked. The grant test fails: the viewer's callback is `applied` instead of
   `refused-not-eligible`.
2. **Duplicate action on callback retry.** The inbox's duplicate short-circuit is removed,
   so a redelivered event id is handled again. The idempotency test fails: the retry is not
   `duplicate`, and it is handled a second time.
3. **Approve a changed plan version.** The callback's version check is removed. The
   delayed-callback test fails: after a re-plan with identical params, the version-1
   callback is `applied` to the version-2 request instead of `stale-version`.

## Limits

- **Fixture-tested only.** No ITSM system is contacted, and nothing here proves any
  vendor's API or workflow.
- **Callback authentication is not here.** Signatures, replay windows and transport belong
  to the adapter that receives the HTTP request (task-97). `receiveCallback` trusts its
  caller to have authenticated the event. Even so, a forged event cannot widen authority:
  it still needs the current version and digest, a mapped principal, and that principal's
  current eligibility. Re-reading identity from the ITSM system is task-97's job.
- **No worker, CLI or portal surface yet.** `runMirrorCycle` and `reconcileRecord` are the
  entry points a scheduled job will call. No job kind is registered and no portal page
  shows the mirror. The integrations page and the adapter wiring are named by task-97.
  The task named no portal file, so the UI contract is not exercised here.
- **Status mirroring is limited.** An approval request that expires, by TTL or by
  supersession, is not sent out as a decision. Only approved and rejected are canonical
  decisions. A re-plan is sent out as a `record` event at the new version.
- **Conflict resolution is commit order.** The first decision committed under the request
  row lock wins. Two callbacks that arrive at the same instant are ordered by that lock,
  not by their external timestamps. Both are evidenced.
- **Delivery is at-least-once.** The receiving adapter must deduplicate on the event id.
