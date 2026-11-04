# An index test that switches off seq scans proves nothing about live (2026-11-01)

PR #885 added object id indexes for the name lookup, and its test asked the planner for a plan
with `enable_seqscan = off`. The test passed, but on live (800k saved versions, about 500 ids
per Changes feed call) the planner still read the whole `resource_version` table twice, because
the query asked for every saved version of each id. The Changes feed lookup still took 11.5 s
(operator queue Q305).

| Mistake | Rule now |
| --- | --- |
| An index was added for a query that, by its shape, must read every row an id has ever had. | Fix the shape first: read the one row you need (newest backup first, `LIMIT 1` per id), so the index read stays small however many backups exist. |
| The test forced the plan, so it could not see the planner's real choice. | Measure the query on a local copy at live size (row counts and ids per call from the operator's sizes) before and after, with `EXPLAIN (ANALYZE, BUFFERS)`, and put both numbers in the PR. A test can still force the plan, but it should also check how many rows the query reads (see `engine/insights/names.test.mjs`, "an object kept in many backups"). |
| `EXISTS` probes in an `OR` were turned into one hashed read of every row they could match. | Probe with a scalar `(SELECT 1 ... LIMIT 1) IS NOT NULL` when each probe must stay one index lookup. |
