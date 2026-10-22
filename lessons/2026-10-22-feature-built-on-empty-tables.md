# "Who made this change" was built on tables nothing filled (2026-10-22)

Task 91 shipped a full classifier for who made each change, with tests. On live it
could never name anyone: no code read Microsoft's audit logs (only a fixture adapter
existed), the audit tables were created only by a manual command, and changes were
matched to audit records through `resource_lineage`, which no collection writes.
Every test passed because each test filled those tables by hand.

| Mistake | Rule now |
| --- | --- |
| A reader was tested only against rows the test inserted itself. | Before building on a table, find the production code that writes it. If there is none, the feature includes that writer and a test that runs it. |
| The tables came from a runtime migration nobody ran on deploy. | New tables go in `engine/store/schema.d/`, which every deploy applies. |
| Changes were matched to audit records only through lineage. | Match on the Microsoft object id the change itself carries (`changeObjectIds`); lineage is a fallback. |
