# Write right after a restore must retry a 404

Live Q43 step 3 (2026-10-12): a group restored from deleted items came back, but
Keel's follow-up PATCH got HTTP 404 a few seconds later (Graph replication lag),
so the journal recorded the write as failed although the object was back.

| Mistake | Rule now |
| --- | --- |
| The post-restore PATCH used the plain `retryOperation`, which retries only 429/503. The bounded 404 helper `writeAfterCreate` existed but was used only for Conditional Access. | Every write that follows a create or restore of the same object (PATCH, assignLicense, `$ref` member/owner adds) goes through `writeAfterCreate` or an equivalent bounded 404 retry. A 404 past the bound still fails with the existing error. |
| A fix for one type's replication lag was not applied to the sibling types. | When a Graph lag workaround lands for one resource type, grep the same engine file for the other "write after create/restore" sites and apply it to all of them in the same PR, with a fixture test per path. |
