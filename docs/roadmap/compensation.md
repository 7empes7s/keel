# Conflict-aware compensation for failed restores (roadmap task-70)

When a restore fails partway, or a completed restore turns out to be wrong,
KEEL can plan its **compensation**: the writes that undo what that one restore
actually did. A compensation is not a rollback button. It is planned from
evidence, reviewed as an immutable dry run, approved like any restore, and
executed through the same write path.

> Compensation is not atomic: each inverse write is a separate, verified Graph
> call, and only writes this restore actually made are undone. It never restores
> erased or disclosed content.

## The inverse-instruction journal

`engine/restore/rollbackJournal.mjs` already recorded each object's prior state
before every write. When a run executes a promoted artifact, `applyWave` now
also records, per write:

| Column | Meaning |
| --- | --- |
| `restore_ref` | The promoted dry-run artifact, so one run's writes are found exactly |
| `operation`, `resource_type`, `target_id`, `blast_radius` | What the write is |
| `intended_state` | The payload it was trying to write (`null` for a delete) |
| `post_state` | What a re-read showed afterwards |
| `outcome` | `succeeded`, `failed`, `uncertain`, or `pending` |

How the outcome is decided (`classifyWriteOutcome`):

| Outcome | When |
| --- | --- |
| `succeeded` | Graph returned success and the re-read verified it |
| `failed` | Graph answered with a definite rejection: a 4xx other than 408 or 429 |
| `uncertain` | No response (lost, timed out, thrown), a 5xx, a 408, an exhausted 429, or a write that did not verify |
| `pending` | The entry was written but the run stopped before recording an outcome |

A lost response is never treated as a failure. It may have landed.

Group membership and ownership edges (task-61) are journaled under the same
reference, so compensation lists them instead of losing them.

## Planning (`engine/restore/compensation.mjs`)

`planCompensation({ restoreRef, entries, current })` takes the run's journal
and a **fresh** read of the target. It undoes in reverse write order:

1. A `failed` write did nothing, so there is nothing to undo.
2. An `uncertain` or `pending` write is reconciled by reading
   (`reconcileUncertainWrite`). The live object is compared with what was
   intended and with what was there before. The result is `landed`,
   `not-landed` or `unknown`. `unknown` is a conflict. Compensation never
   guesses in either direction.
3. For a write that landed, the live object must still hold what this run
   wrote. If anything this run wrote has changed since, the object is a
   **conflict**, so a later legitimate change is never overwritten. If a
   different object now holds the natural key, that is a conflict too.
4. An update is undone **field by field**. Only the fields this run set out to
   change are reverted to their prior values. Every other field keeps its
   current value, so an unrelated later change is kept as it is.
5. A create or soft-delete restore is undone by deleting the object, through
   the same deletion guards as any delete.

What stays explicit in the plan:

| List | What it holds |
| --- | --- |
| `operations` | The inverse writes, in order, each naming the journal entries it compensates |
| `conflicts` | Objects changed since the restore wrote them, and writes whose outcome cannot be decided |
| `notApplied` | Writes that were rejected or did not land, so there is nothing to undo |
| `irrecoverable` | Objects the restore **deleted**, and forward content effects (task-66) whose consequences reversing the setting does not undo |
| `manual` | Relationship edges, and journal entries from before operation journaling |

A deleted object is never recreated by compensation, because a recreated
object gets a new id. Recover it with a forward restore. Task-64's native
soft-delete restore keeps the id while the object is still in deleted items.

## Approval and execution: the same path as any restore

- `keel-restore.mjs --compensate <artifactId> [--persist-artifact <id>]` plans a
  compensation **as a dry run only**. `--compensate --enforce` is refused. The
  dry run evaluates the same guards without writing: capability, recovery,
  deletion, and dependent impact (`assessDeletePlan`). Any refusal makes it
  `refused`, and a refused artifact can never be promoted.
- The compensation is persisted as an ordinary `restore_dry_run` artifact with
  a `compensation` column. Its plan digest folds in the whole inverse plan
  (`compensationDigestInput`): operations with payloads, conflicts,
  irrecoverable effects and manual items. Its fingerprint covers every
  journaled object.
- It is executed only by promoting that artifact (`--artifact <id> --enforce`).
  That goes through the same portal confirmation (`POST /api/actions/restore`)
  and approval, and the same worker path. At promotion the plan is
  **re-derived** from the journal and a fresh read. It is never trusted from
  the stored artifact. A changed journal, plan or target refuses before any
  write.
- The compensation's own content effects (an undo can shorten retention too)
  need the separate high-impact approval from task-66.
- The compensation is itself journaled, under its own artifact id, so a
  partial compensation can in turn be compensated.

## Portal

- An enforced restore job, succeeded or failed, shows an **Undo** panel.
  - **Plan undo** enqueues a compensation dry run (`POST /api/actions/restore/compensate`,
    capability `restore`). The worker runs `--compensate` for jobs whose params
    are exactly `{ compensates, artifactId }`.
  - The panel polls for the artifact and lists:
    - what will be undone;
    - what changed since and is not overwritten;
    - what cannot be undone;
    - what needs manual review;
    - what had nothing to undo.
  - **Request approval to undo** sends the compensation artifact through the
    normal restore confirmation. Nothing is written from the panel.
- A compensation dry-run job shows the plan it computed.

## Migration and legacy reads

- `rollback_entry` gains nullable columns. Callers that pass only prior state
  (`tools/rehearsal`, older paths) keep writing the exact pre-task-70 row.
- `restore_dry_run.compensation` is nullable and is `null` for every forward
  restore. Their plan digest is unchanged.
- Restores promoted before this change have no `restore_ref` on their journal
  entries. They **cannot be compensated** ("no journaled writes"). They are not
  silently planned from the old run-wide journal, which mixes runs of the same
  snapshot.

## Limitations and proof

- **Relationship edges are manual.** Edge compensation is not a qualified
  operation. Edges are listed by natural key for review.
- **No recreation.** A deleted object is listed as irrecoverable and left to a
  forward (native) restore.
- **Field-level reconciliation uses the collector's projection.** Fields
  outside the collected `$select` are neither compared nor reverted.
- **Not atomic.** A failure part-way through a compensation stops the run.
  Every write made so far is journaled, and a new compensation is planned from
  the current state.
- **Proof is fixture-based.** `engine/roadmap/compensation.test.mjs` runs
  against the isolated test database with an in-memory Graph. No live tenant
  was touched.
  - Acceptance:
    - a lost response is reconciled from actual state;
    - partial-wave compensation undoes only the matching writes;
    - a concurrent admin update is not overwritten;
    - compensation needs a reviewed, approved artifact;
    - irrecoverable effects stay explicit;
    - the full CLI path covers failed run → compensation dry run → promotion → journaled undo.
  - Required mutation checks, each confirmed by applying the mutation and
    watching the named test fail:
    - applying the inverse without a current-state comparison;
    - treating a lost response as a guaranteed failure;
    - bypassing the artifact validation for an undo.
