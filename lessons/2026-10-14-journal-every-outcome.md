# Journal every write's outcome (2026-10-14)

| Mistake | Rule now |
| --- | --- |
| `relationshipWriter.mjs` journalled each member/owner edge with `recordPriorState` but never called `recordWriteOutcome`, so every edge entry stayed `pending` and live capture (Q45 round A) exited 4 for edge steps 5–8. Fixture tests only checked that the journal row was written before the write, not how it ended. | A writer that calls `recordPriorState` must close the same entry with `recordWriteOutcome` on every path: `succeeded` after a verified read-back, `classifyWriteOutcome(result)` for a refused or lost write, `uncertain` when the read-back does not confirm it. |
| Journal tests used a fake client that recorded SQL and returned no rows, so a missing outcome could not show up. | Journal tests run against the isolated test database with a `restoreRef`, read the rows back with `listJournal`, and assert that no entry is left `pending`. |
