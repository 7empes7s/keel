# Native or reconstructed recovery (roadmap task-64)

`decideVerb()` says what the diff requires: create, update, restore, delete or
no-op. `selectRecoveryMechanism()` in `engine/restore/recoveryMechanism.mjs`
says how that verb may be carried out. The choice is made once, during
reconciliation, and each resource carries it as `resource.recovery`.

| Mechanism | When | What happens to the object id |
| --- | --- | --- |
| `update-existing` | The object is live and differs | Retained |
| `soft-delete-restore` | The object is in deleted items, within retention, and soft restore is qualified | Retained |
| `recreate` | Every lookup **succeeded** and found nothing, and create is qualified | New |
| `delete` | Desired absent, live present | Removed |
| `manual` | No qualified capability, or the object is recoverable only through an unqualified native route | None (handoff with reason) |
| `refused` | A lookup failed, or the recovery point expired or can't be proven | None |

## Rules

**A failed lookup is not "not found."**
- A failed deleted-items read (403, 5xx, a timeout or a thrown request) is
  recorded per type by `buildLiveIndex(..., { onDeletedLookupFailure })`.
- An absent object of that type is then `refused` (`lookup-failed`), never
  recreated. A recreated twin would orphan the original's id and every
  reference to it.
- A failed **live** listing still fails the whole plan, because presence itself
  is unknown.
- Callers that don't pass the callback keep the old behaviour of throwing.

**Retention deadline.**
- Entra keeps deleted users, groups and applications for
  `SOFT_DELETE_RETENTION_DAYS = 30`. The deadline is `deletedDateTime + 30 days`.
- A missing or unparseable `deletedDateTime` makes the deadline unprovable,
  which refuses the restore.
- The deadline is checked at planning time, and **again by `applyWave` at
  execution**. A dry run that was in time but promoted after the deadline is
  skipped before any write.

**Native recovery routes.**
- `NATIVE_RECOVERY_ROUTES` names routes such as recovering deleted Conditional
  Access policies and named locations.
- None is credential-qualified, so a resource a native lookup reports as
  recoverable becomes a `manual` handoff, and a failed native lookup refuses.
- Today no code path queries a native store. The selector accepts injected
  native lookup results, so a route can be wired and qualified later without
  changing the rules.

**Execution gate.**
- `applyWave` runs `recoveryGate()` right after the capability gate:
  - `manual` and `refused` are skipped;
  - a mechanism that doesn't match the verb fails;
  - an expired deadline is skipped.
- Resources without `recovery` (callers that predate task-64) behave exactly
  as before.

## Plan binding and approval

Each mechanism (`naturalKey`, mechanism, verb, id outcome, retained id,
deadline, credential mode, proof, reason) is:

- returned by preview, dry run and enforce;
- persisted in the new nullable column
  `restore_dry_run.recovery_mechanisms`;
- folded into the **plan digest**.

If the mechanism changes between review and promotion, the recomputed digest no
longer matches and promotion is refused. For example, the deleted original is
purged, so the same diff would now recreate. This holds even though the target
fingerprint is unchanged.

The restore wizard's review step shows a **Recovery mechanism** table:
mechanism, whether the id is kept, the deadline, and the reason for any refusal.
It is built by `portal/components/recovery-mechanism.tsx`.

## Migration and legacy reads

- The migration is `ALTER TABLE restore_dry_run ADD COLUMN IF NOT EXISTS recovery_mechanisms jsonb`.
  It is additive and safe to re-run.
- An artifact persisted before this change reads as `recoveryMechanisms: null`.
  Its promotion digest is recomputed **without** mechanisms, so it stays
  promotable, and `applyWave` still applies the execution gate to the freshly
  selected mechanism.

## Limitations

- learn.microsoft.com was not reachable from the build environment, so the
  native routes' Graph endpoints, API versions, retention and permissions are
  **not** recorded or verified here (`docs: null`). They stay manual until that
  check and a credential qualification are done.
- The 30-day retention is the documented Entra default for users, groups and
  applications. A tenant-specific setting isn't read.
- Soft restore is a registered capability only for `group`. `user` and
  `application` are soft-restore candidates (see the task-63 ledger) and
  resolve to `manual`.
