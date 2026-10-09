# Turning a restored Conditional Access policy back on (roadmap task-152)

## Status

- **Fixture-tested.** Everything here is proven against the in-memory fake
  Graph and fixtures (`engine/roadmap/conditional-access-enforce.test.mjs`,
  `tools/qualification/operations.mjs`).
- **Not live-qualified.** No Microsoft endpoint was called. The deleted-items
  routes, their API version, the permission they need and the 30-day retention
  are declarations to confirm against a test tenant. `nativeRecoveryEvidence`
  refuses to record a Conditional Access restore as live-qualified, and the
  signed `native-live-acceptance.json` is unchanged.

## Why there is a pending step

`enforceReportOnly` (`engine/safety/conditionalAccessGuard.mjs`) writes every
restored Conditional Access policy as `enabledForReportingButNotEnforced`. A
policy the backup had `enabled` therefore protects no one after a restore.
The restore must not look finished when it isn't.

## The pending step

- `enforcementPendingFor(resource)`: true only for a Conditional Access policy
  whose snapshot state is `enabled` and whose verb is create, update or
  restore-soft-deleted. A policy that was report-only or off in the backup
  gets no step.
- The run result carries `results.pendingSteps` (one entry per policy, step
  `turn-on-conditional-access-policy`) on the dry run and on the enforced run.
  The CLI logs each one.
- The enforced run also opens a completion item of kind `enforcement`
  (requirement `conditionalAccessEnabled`) in `recovery_completion_item`. That
  includes `update-existing`, which normally opens no item.
- **Portal:** the restore review lists the steps under "Still to do after this
  restore". The completion checklist shows the item with a "Next:" hint and
  no evidence form.
- A ticket cannot close the item. `completeItem` refuses `enforcement` items.
  `closeEnforcementItem` closes it in two cases:
  - after the approved step turns the policy on and reads it back;
  - when planning finds someone turned the policy on outside KEEL, and apart
    from its state it matches the backup. Nothing is written to the tenant,
    and the evidence says "turned on outside KEEL".
  A policy that is on but differs from the backup is still refused ("already
  turned on").

## Promotion: plan, approve, execute

This follows the existing restore approval. Nothing new was invented, and the
shape is the compensation precedent from task-70.

1. **Plan (dry run only).** Run
   `keel-restore --enforce-conditional-access <restoreArtifactId> --policy <naturalKey> --persist-artifact <id>`.
   `--enforce` with it is refused. Planning rebuilds everything from the
   restore, its open item, the snapshot and a fresh read of the target. It is
   refused if:
   - the policy has no open item, or the item is already closed;
   - the backup did not have the policy `enabled`;
   - the policy is not live, is already on (and differs from the backup), or
     is in any state other than report-only (it changed after the restore).
   The plan is stored on the dry-run artifact (`conditional_access_enforcement`)
   and folded into its digest.
2. **Approve.** Use the normal restore approval for that artifact: the portal's
   restore confirmation or `requestApproval`, then `approveRequest`. The
   approver must be someone other than the requester (`SelfApprovalError`).
3. **Execute.** Run `keel-restore --artifact <id> --enforce` (or the job the
   approval minted). Before writing, it checks:
   - the digest and current-state fingerprint (a changed policy refuses);
   - that an approved request decided by someone other than the requester
     exists for this artifact;
   - the lockout gate again.

### Gates

- **Break-glass lockout gate** (`engine/safety/lockoutGate.mjs`), evaluated at
  planning and again at execution. "This policy turned on" is evaluated as a
  proposed change (`withProposedConditionalAccessPolicy`). Promotion is refused
  when:
  - a break-glass account would be blocked;
  - readiness is `unknown`;
  - the Conditional Access inventory isn't covered;
  - the gate cannot be read (it fails closed).
- **Sign-in path gate**, at execution only, because it compares the path
  before and after the write. The path is snapshotted before the write.
  Afterwards it must equal the expected path, which is the old one with only
  this policy on.

### The write

- The only change is `PATCH /identity/conditionalAccess/policies/{id}` with
  body `{ "state": "enabled" }`. The guard allows it through its signed
  override, with the approver as signer.
- It is journaled as an `update` with the prior and intended state, so
  compensation can undo it.
- The PATCH and every read go through the same bounded throttle retry as
  `applyWave` (429/503 with Retry-After, through the tenant's governor).
- A 4xx refusal changes nothing, and the step fails.
- Any other outcome means the policy may be on. The step succeeds only if the
  policy reads back as `enabled` with an unchanged body **and** the sign-in path
  matches. In every other case KEEL PATCHes it back to report-only and reads
  that back. Those cases are:
  - an unknown PATCH outcome (5xx, timeout or throw);
  - a failed or mismatched read-back;
  - a sign-in path change;
  - a sign-in path read that throws.
- The journal records the real result:
  - `failed`, with the report-only read-back, when the revert is confirmed;
  - `uncertain` when the revert is not confirmed.
  If the revert cannot be confirmed, the step fails with "Conditional Access
  policy may be ON" and adds a "confirm this policy's state" completion item
  (`service-validation`, `conditionalAccessStateConfirmed`) to the restore.
- On success the item is closed with a log reference to the artifact and
  "approved by …".

**Why the CLI:** planning is per policy and needs a fresh tenant read, which
the CLI already does for restores and compensation. Approval and execution reuse
the existing approval and job path, so the portal needed no new action route.

## Soft-delete restore

- Registered: `conditionalAccessPolicy` / `restore-soft-deleted` in
  `capabilities.mjs` and `qualification.mjs`. It is fixture-proven by this
  task's test and by the fixture harness.
- Deleted policies are read from `/identity/conditionalAccess/deletedItems/policies`
  (`DELETED_ITEM_ROUTES` in `liveState.mjs`).
- The restore is `POST …/deletedItems/policies/{id}/restore`.
- The id is kept.
- **A policy deleted while on comes back on**, because Microsoft restores it in
  the state it was deleted in. Before anything is sent, the deleted item's
  state is read (`resource.live.payload.state`):
  - report-only or off: restored without a gate;
  - `enabled` or unknown: restored only if the break-glass lockout gate passes
    for it turned on. A blocked account, unknown readiness, no gate, or a gate
    that throws skips the restore, and nothing is written (dry run included).
    The forward restore loads that gate (`lockoutGateFor`) whenever such a
    restore is planned.
- After the POST, the policy is always PATCHed to report-only (unless it
  already reads back that way). The PATCH retries throttling and the brief
  post-restore 404 through the bounded retry path.
- If report-only cannot be confirmed (the PATCH fails, the read-back fails, or
  it reads back in another state), the resource fails with "Conditional Access
  policy may be ON: …" and an `uncertain` journal entry. The CLI logs a
  `WARNING` and opens a `conditionalAccessStateConfirmed` completion item
  before stopping the run.
- Two deleted policies with the same display name are ambiguous. Neither is
  restored (`refused: ambiguous`), and nothing is recreated.
- Retention is 30 days from `deletedDateTime`. It is checked at planning and
  again by `applyWave` at execution. A missing date refuses.
- A failed deleted-items read refuses absent policies (`lookup-failed`). They
  are never recreated.
- Conditional Access left `NATIVE_RECOVERY_ROUTES`; named locations remain there
  as manual.

## Not included

- No live qualification and no live evidence (see Status).
- **Brief enabled window:** a policy deleted while `enabled` is on between the
  restore POST and the report-only PATCH. That window is allowed only after the
  lockout gate passed for the policy turned on. A failed PATCH is reported
  loudly as "may be ON" (see Soft-delete restore).
- No portal button to plan the step. Planning is CLI-only; the portal shows the
  step and the existing approval.
- Turning on several policies at once: it is one policy per step.
- Named-location soft restore.
- The forward restore's lockout gate used to be loaded with the raw tenant id;
  it now uses the derived tenant reference, where readiness is stored.
- One existing issue is noted but not changed here: the forward restore's
  sign-in path gate counts any Conditional Access change as a path change.
