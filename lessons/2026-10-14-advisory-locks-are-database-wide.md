# Advisory locks are database-wide; a per-file schema does not isolate them (2026-10-14)

Found when master's "Portal tests (Postgres)" job failed with exactly one engine test on some runs
(a298b6d, PR #222) and passed on others (09288ed). CI runs the engine files four at a time, each in
its own schema of one `keel_test` database.

| Mistake | Rule now |
| --- | --- |
| The worker's collection lock was keyed on `current_database()` only. `cli/keel-scheduler.test.mjs` holds it while a fixture collection runs; when `roadmap/event-envelope.test.mjs` ran a collect job at that moment, its job was requeued and "runJob emits job.running" saw no `job.running` (failed 4 of 6 paired runs locally). | An advisory-lock key names the store it protects: include `current_schema()`. Production has one schema, so it still means one collection at a time; parallel test schemas never contend. `keel-scheduler.test.mjs` holds the lock in one schema and proves a collection in another schema still runs. |
| The bootstrap journal (`bootstrap:<tenantRef>`) and audit ingestion locks had the same database-wide key. Two runs of `setup-host.test.mjs` against one Postgres (several sessions share the local one) made each other's runs fail with "bootstrap execution already running". | Same rule; both keys now include `current_schema()`. |
| A test file's schema was taken as full isolation. | Isolation per schema covers tables only. Advisory locks, `LISTEN/NOTIFY` channels, roles, extensions and files under a fixed `tmpdir()` path are shared by every file in the run: key them by schema, or give them a random suffix. |
