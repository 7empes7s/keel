# A create sent back what Graph derives itself (2026-11-06)

Live proof batch 1b (#1031, build f1521256, restore 46a7c604) found that recreating an access review series fails with 400 "Tenant is not authorized for Custom Scoping Conditions Feature" (#1033). The backup holds the series as Graph reads it back: an `instanceEnumerationScope` naming the reviewed group and `/microsoft.graph.user` on the scope query. Graph adds both itself to a `/groups/{id}/transitiveMembers` query, and refuses them in a create. The fixture fake stored the body as sent, so the tests never saw the read-back shape, and the read-after-write check would also have failed on the added cast.

| Mistake | Rule now |
| --- | --- |
| The create body sent fields Graph derives from other fields, because they were in the backup. | A writer leaves derived parts out of a create body when the backup's other fields imply them (`withoutDerivedScope` in `engine/restore/accessReviewOperations.mjs`), and compares them with the derived part taken off both sides, never by ignoring the field. |
| The fixture fake stored the body as sent, so the backup shape and the read-back shape were never the same in a test. | A writer's fake Graph adds what live Graph adds on store, and refuses what live refuses, and one test restores a backup in the read-back shape (`reviewsGraph` in `engine/restore/accessReviewOperations.test.mjs`). |
