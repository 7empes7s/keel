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
  Only `closeEnforcementItem` closes it, after the policy reads back as on.

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
   - the policy is not live, is already on, or is in any state other than
     report-only (it changed after the restore).
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
   - the gates again.

### Gates, evaluated at planning and again at execution

- **Break-glass lockout gate** (`engine/safety/lockoutGate.mjs`). "This policy
  turned on" is evaluated as a proposed change
  (`withProposedConditionalAccessPolicy`). Promotion is refused when:
  - a break-glass account would be blocked;
  - readiness is `unknown`;
  - the Conditional Access inventory isn't covered;
  - the gate cannot be read (it fails closed).
- **Sign-in path gate.** The path is snapshotted before the write. Afterwards
  it must equal the expected path, which is the old one with only this policy
  on. On any other change KEEL writes report-only again and fails the step.

### The write

- The only change is `PATCH /identity/conditionalAccess/policies/{id}` with
  body `{ "state": "enabled" }`. The guard allows it through its signed
  override, with the approver as signer.
- It is journaled as an `update` with the prior and intended state, so
  compensation can undo it.
- KEEL then reads the policy back. It must be `enabled` with an unchanged body,
  or the step fails.
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
- The id is kept. The usual hash compare then PATCHes the policy back to
  report-only.
- Retention is 30 days from `deletedDateTime`. It is checked at planning and
  again by `applyWave` at execution. A missing date refuses.
- A failed deleted-items read refuses absent policies (`lookup-failed`). They
  are never recreated.
- Conditional Access left `NATIVE_RECOVERY_ROUTES`; named locations remain there
  as manual.

## Not included

- No live qualification and no live evidence (see Status).
- **Brief enabled window:** a policy deleted while `enabled` is briefly enabled
  between the restore POST and the report-only PATCH. The PATCH follows
  immediately for the same resource. If that PATCH fails, the run reports the
  policy as failed with an uncertain journal entry, and it may still be on.
- No portal button to plan the step. Planning is CLI-only; the portal shows the
  step and the existing approval.
- Turning on several policies at once: it is one policy per step.
- Named-location soft restore.
- Two existing issues are noted but not changed here:
  - the forward restore's lockout gate passes the raw tenant id where a tenant
    reference is expected (#149);
  - its sign-in path gate counts any Conditional Access change as a path change.
