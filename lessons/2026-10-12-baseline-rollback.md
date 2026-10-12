# 2026-10-12: a baseline change had no rollback path

Live gate #148, question 43. The delete steps activated a temporary baseline version. Afterwards
the version that was active before could not be put back: `activateBaseline` refuses a superseded
version, and `resnapshotBaseline` needs a snapshot newer than the capture, which a baseline seeded
before snapshots were recorded does not have.

| Mistake | Rule now |
| --- | --- |
| A plan step told the operator to "re-activate the baseline that was active before", but the code refused it. The step's cleanup was never run against the code. | A plan step's cleanup command is run in a fixture test before the step ships, or the step says it is untested. |
| Shipping a state change (supersede) with no inverse. Append-only history is right, but it needs an explicit way back. | Every state change that makes a row read-only ships with its rollback in the same PR (`reinstateBaseline`, exposed by the same CLI and the same approval as the change). |
| Guarding re-versioning on a source snapshot, which some rows do not have. | A rollback must not depend on data a row may lack; copy what the row holds. |
