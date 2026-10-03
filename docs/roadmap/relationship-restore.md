# Relationship restore (roadmap task-61)

A restore can now put a group's **members** and **owners** back the way the
source snapshot recorded them. The edges come from the task-57 relationship
observations. Every other relationship family is still observed only and never
written: transitive members, application and service principal owners, app role
grants, and Intune assignments.

## How an edge is written

| Change | Graph request |
| --- | --- |
| Add | `POST /groups/{group}/{members\|owners}/$ref` with `{"@odata.id": "https://graph.microsoft.com/v1.0/directoryObjects/{object}"}` |
| Remove | `DELETE /groups/{group}/{members\|owners}/{object}/$ref` |

These two requests are the only edge writes. A group create or update whose
payload carries any of the following is refused by `applyWave` before any write
(`relationship-via-parent refused`):

- `members` or `owners`
- `members@odata.bind` or `owners@odata.bind`
- `@delta` forms of these properties

The capability registry holds `group#member` and `group#owner` with the
`edge-add` and `edge-remove` operations. These are kept separate from the
object operations of `group`, so neither implies the other.

## Planning (dry run and preview)

Edges are planned only for the **selection scope**, which is an operator-reviewed
restore and its promotion. Remediation and legacy `--plan` restores leave edges
alone, as before.

For each restored group that is not being deleted, and each family:

| Situation | Outcome |
| --- | --- |
| The snapshot never observed the family (legacy snapshot, or collected without `relationships`) | Nothing is planned. A missing observation is never treated as an empty set. |
| The snapshot read failed | Nothing is planned. This is logged as a note. |
| The live read of an existing group is not complete (failed, partial or capped) | `blocked-edge-read` refusal. Nothing is added or removed. |
| A desired target can't be resolved to a target-tenant object by natural key | `unresolved-edge-target` refusal. Removals for that set also become unprovable (`removal-unproven`). Source-tenant ids are never written. |
| The snapshot set is `partial` | Adds are planned. Every removal is refused (`partial-edge-inventory`). |
| A removal targets a protected (break-glass) principal | `protected-principal` refusal. |
| The target is created by this same run | The add is planned with `targetId: null` and resolved from run provenance when it executes. |

Any refusal is a guard refusal. A dry run that carries one is `refused` and can
never be promoted.

Operations are ordered by group, then family, then adds before removes. They
are:

- folded into the **plan digest**;
- stored in the artifact's new `relationship_operations` column, which is what
  approvers review in the wizard under "Membership changes".

The live edge sets the plan was computed from are folded into the
**current-state fingerprint**. If membership changes between review and
promotion, even legitimately, the promotion is refused and a new dry run is
required.

## Execution

Edges are written after every object wave and deferred patch, and before any
delete wave. For each group and family:

1. **Precondition read.** A read that is not complete skips the whole set
   (`blocked-edge-read`).
2. **Already in the desired state.** If the edge is already present (for an
   add) or absent (for a remove), it is reconciled without a write.
3. **Journal, then write.** The rollback journal entry is written first, with
   `kind: relationship-edge` and the prior presence. If the journal write
   fails, the edge is not written.
4. **Write.**
   - A `429` is re-sent, because it provably did nothing.
   - Any other failure is reconciled by **re-reading the set**: a thrown
     request, a lost response, a `5xx`, or a conflict. If the edge is now in
     the desired state, it is recorded as `lost-response`; otherwise it fails.
   - An add is never sent a second time on an ambiguous outcome.
5. **Post-write verification.** The set is re-read, with a bounded retry for
   read-after-write lag, until every expectation holds. If it never holds, or
   the read never completes, the run fails.

## Compatibility and migration

- `ALTER TABLE restore_dry_run ADD COLUMN IF NOT EXISTS relationship_operations jsonb`
  is additive and safe to re-run. Artifacts persisted before this change read
  as having no edge operations.
- A plan with no edge operations keeps its earlier digest and fingerprint, so
  existing artifacts stay promotable.
- An artifact persisted **before** this change cannot be promoted if the
  snapshot carries edge observations for its groups: the recomputed digest now
  includes edge operations. The fix is a new dry run, which is the fail-closed
  outcome.

## Known limitations

- Only direct group members and owners are restored. Nested (transitive)
  membership follows from restoring each group's direct members.
- Dynamic-membership groups are not special-cased. Graph rejects `$ref` writes
  to a dynamic group, so the edge fails and the run stops. Restoring the group's
  `membershipRule` is how its membership comes back.
- Writes to role-assignable groups need the restorer to hold the matching
  directory role. A refusal surfaces as a failed edge, not a silent skip.
- Every edge claim is fixture-tested against fake readers and writers
  (`engine/roadmap/relationship-restore.test.mjs`). None is live-qualified.
