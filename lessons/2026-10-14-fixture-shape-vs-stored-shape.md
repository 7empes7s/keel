# Fixture tests passed an in-memory shape the database never stores

Live Q46 part D (2026-10-14): an eligibility scoped to an administrative unit was
captured, removed, then the restore dry run refused it as "an administrative unit
the snapshot cannot name". The fixture tests for gap D2 had passed, because they
handed restore the references straight from canonicalization, including a
`prefix` field. The `resource_reference` table has no such column, so every
reference read back from Postgres had lost it.

| Mistake | Rule now |
| --- | --- |
| A new field was added to the in-memory reference shape, and restore depended on it, but the store never wrote or read it. | When restore or planning depends on a field of a collected record, a test must store the record through `engine/store/db.mjs`, read it back, and run the same restore path. A fixture test with the in-memory shape alone is not proof. |
| Live failure was the first time the stored shape and the in-memory shape were compared. | When adding a field to `resource.references` or any persisted record, check `engine/store/schema.sql` in the same PR: either persist it (additive column) or rebuild it on read, and say which in the PR. |
