# Keel read-only reconstruction from independent artifacts (task-68, WS10)

Date: 2026-09-22 UTC. Status: implemented, fixture-tested only.

## What was built

- `engine/authz/recoveryMode.mjs` (new) — the recovery-mode authorization
  boundary. `authenticateRecoveryIdentity({ identity, authenticator })`
  refuses an anonymous identity outright (`anonymous: true` or no
  `principalId` — there is no emergency bypass), refuses to run without an
  injected independent authenticator (this process cannot authenticate anyone
  by itself), and refuses when the authenticator answers anything but `true`.
  `credentialRef` is a reference string; values shaped like credential
  material are rejected (Global Constraint #6). On success it returns a
  frozen identity token. `listMissingPrerequisites({ credentials })` is a
  pure function returning the named gaps in stable order:
  `recovery-key-material`, `artifact-storage-read`,
  `tenant-recovery-authorization` — a "reference" that embeds credential
  material counts as missing. `openRecoveryReadOnlySession(client)` pins the
  connection with `default_transaction_read_only = on` plus
  `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` (any write fails
  with SQLSTATE 25006) and wraps `query()` with a statement guard
  (`RecoveryReadOnlyError`). The guard permits only a single read-only
  statement (SELECT/WITH/VALUES/TABLE/SHOW/EXPLAIN) and is evasion-tested:
  it refuses writable CTEs and DML after a WITH clause, `SELECT INTO`,
  `EXPLAIN ANALYZE` (which executes), multi-statement batches, and
  `set_config()`/`nextval`/`setval` — checking text with string literals,
  dollar quotes, quoted identifiers and comments blanked out so smuggled
  keywords cannot hide and data containing those words cannot
  false-positive. Two independent layers, both pinned by tests.
- `tools/recovery/reconstruct.mjs` (new) — `reconstructRecovery()`, the
  offline recovery verifier and disposable-database reconstruction workflow,
  with refusal-ordered stages:
  1. `identity` — independently authenticated recovery identity (above).
  2. `prerequisites` — named credential prerequisites, listed before any
     artifact is trusted.
  3. `manifest` — the task-67 `verifyRecoveryManifest()` over the actual
     artifact bytes: tenant pin, build revision, schema pin, dump sha256,
     the whole configuration export tree, observation IDs, evidence
     checkpoint. Any tampering stops here, before a database exists.
  4. `schema` — the schema about to be applied is hashed and compared to the
     manifest pin; an incompatible schema stops BEFORE import.
  5. `import` — the current `engine/store/schema.sql` plus the gunzipped
     dump are loaded into a disposable database supplied by the caller's
     `createTargetDatabase`. The writable import connection is ended before
     any access session exists; a failed import discards the half-built
     target. The default target factory (`createDisposableTarget`) creates a
     fresh schema on an explicit URL and refuses `KEEL_DB_URL` outright —
     production is never a reconstruction target.
  6. `history` — through a fresh read-only session, `verifyChain()` must
     pass and the reconstructed `evidence_head` must equal the manifest
     checkpoint (seq, hash, record count) before access is handed back.

  On success: `{ ok, stage: 'recovered', identity, readOnly: true,
  writersDisabled: true, recovered, recoveryComplete, incomplete, access,
  target }` where `recovered` carries the tenant-scoped history (schedules,
  approval requests, principals, role grants, job count, evidence summary)
  read through the read-only session, and `incomplete` propagates the
  task-67 completeness gaps (missing key instructions, unverified
  checkpoint) unchanged. `runCli({ argv, logger, dependencies })` mirrors
  the ops CLI conventions: exit 0/1, verdicts and counts only, and it
  refuses to run without an injected `dependencies.authenticator` — there is
  no anonymous path through the command line.
- `ops/recovery-runbook.md` (new) — the operator procedure: prerequisites
  table (matching the reported prerequisite names), the exact command, the
  refusal stages, and an explicit "what this does NOT do" section (no tenant
  writes, no writer re-enablement, no schedule/worker restart).

No schema or data migration was needed: reconstruction applies the existing
`engine/store/schema.sql` verbatim into a disposable schema and imports the
dump; no table changed shape. Legacy-read handling is therefore the task-67
behavior inherited unchanged — a manifest with an unsupported
`recoveryVersion` or a foreign schema pin is refused, never migrated, and
the pre-existing dump-manifest and export-manifest readers are untouched.
There is no portal/UI surface named by this task; the CLI plus runbook are
the whole integration.

## Implementation and proof limitations

- Everything is fixture-tested against synthetic rows in isolated test
  databases (`engine/test/dbTestHelper.mjs`): a populated source tenant
  (schedules, approvals, grants, evidence chain, snapshot + configuration
  export) is dumped to gzip SQL and reconstructed into empty disposable
  databases. No live tenant was touched, no service was restarted, and the
  production database was never a target.
- Fixture dumps are generated INSERT statements; real disaster artifacts come
  from `pg_dump` via the tiered backup timers. The importer executes whatever
  SQL the dump carries after the manifest has pinned its checksum — dump
  provenance and custody are operational facts, verified by checksum and
  evidence chain, not by this code trusting the format.
- The independent authenticator is an injected seam. The tests inject fakes;
  a real deployment must wire it to the actual break-glass channel. No
  authenticator, no recovery — the code cannot authenticate anyone itself.
- Read-only enforcement is database-level (`default_transaction_read_only`)
  plus a statement guard on the access session. The short-lived import
  connection is necessarily writable; it is ended before any access session
  opens and is never exposed to callers.
- The evidence checkpoint is a reference to the in-database chain head; as
  noted in `engine/govern/evidence.mjs`, genuine non-repudiation needs
  external anchoring, which remains out of scope. Recovery without an
  externally anchored head verifies the chain but reports
  `evidence-checkpoint-unverified` and the reconstruction still requires the
  reconstructed head to equal the manifest checkpoint.
- Nothing here restores Microsoft 365 tenant objects; tenant recovery remains
  the artifact-only restore promotion path. This instance is evidence and a
  planning surface, read-only by construction.

## Boundary tests

`engine/roadmap/keel-recovery.test.mjs` exercises the production workflow and
authz module against the isolated test database, covering every acceptance
bullet and the three required mutation checks:

- Enable writes during reconstruction: after a successful recovery, an INSERT
  on the RAW access connection fails with SQLSTATE 25006 (database-level
  read-only), and the statement guard refuses DELETE/UPDATE/INSERT/DROP/
  TRUNCATE with `RecoveryReadOnlyError`. Evasion pins (2026-09-25 hardening,
  closes the review finding "read-only guard permits resetting transaction
  mode and executing a writable CTE"): writable CTEs
  (`WITH d AS (DELETE … RETURNING *) SELECT …`), DML after a WITH clause,
  `SELECT … INTO`, `EXPLAIN ANALYZE`, multi-statement batches
  (`SELECT 1; SET default_transaction_read_only = off`), `SET`/`RESET`,
  `set_config()`, and `nextval`/`setval` are all refused, while the same
  words inside string literals, dollar quotes, quoted identifiers and
  comments still pass as data — and the session provably remains
  `transaction_read_only = on` after every refused attempt.
- Accept tampered manifest: a forged dump checksum, a moved evidence head,
  and tampered dump bytes are each refused at the `manifest` stage with the
  tamper named — and a spy proves no disposable database was ever created. A
  manifest whose checkpoint lies about the imported history is refused at the
  `history` stage; a corrupted evidence record inside the dump fails
  `verifyChain` in the reconstructed database.
- Allow anonymous emergency identity: `{ anonymous: true }`, a missing
  principal id, a missing authenticator, and an authenticator returning
  `false` are all refused at the `identity` stage, with the authenticator
  never consulted for anonymous identities and no database ever created.
- Missing credentials: empty, partial, and credential-shaped references each
  produce the named prerequisites in stable order, before any verification or
  import.
- Incompatible schema: a foreign schema pin is refused at the `manifest`
  stage; bending `expectedBuild` to match still fails at the `schema` stage
  because the schema about to be applied is hashed — both stop before import.
- Empty disposable instance recovers fixture history: schedules (6),
  approvals (approved + rejected), principals, grants, the minted job and the
  evidence chain round-trip row-for-row equal to the source, with the
  evidence head equal to the manifest checkpoint.
- CLI: happy path prints recovered counts and exits 0; no authenticator exits
  1; missing credential flags name the prerequisites; a tampered manifest
  exits 1. The default target factory refuses the production database URL.

Two reviewer-derived mutations closed 2026-09-26 (neither is in the plan's
required list; both were flagged as surviving because no fixture exercised
them):

- Remove tenant_ref filter from reconstructed schedule query: the source
  fixture now seeds a second tenant's six schedules into the same table and
  dump. The recovered-history read for the requested tenant still returns
  exactly six rows, all belonging to that tenant, while a direct read-only
  query proves the other tenant's six rows are physically present in the
  same disposable database — so the assertion exercises the `WHERE
  tenant_ref = $1` filter itself, not merely the absence of other-tenant data.
- Remove top-level assertTenantRef guard in reconstructRecovery: an undefined
  tenantRef would otherwise flow into `verifyRecoveryManifest` as
  `expectedTenantRef`, where `expectedTenantRef !== undefined && …` skips the
  manifest's own tenant-pin check entirely. A new test calls
  `reconstructRecovery` with an undefined and with a raw (unhashed) tenantRef
  and confirms both are refused by `assertTenantRef` before the manifest is
  read and before any disposable database is created.

Verified dump-path consistency coverage added 2026-09-26:

- A CLI fixture supplies `--dump` pointing to a different artifact than
  `manifest.dump.path`. Both contain valid evidence history, but the verified
  override has zero requested-tenant schedules and the original has six.
  Reconstruction must report zero schedules while preserving approvals and
  grants. This catches importing the original after verifying the override,
  even though the original's evidence chain would still pass.
- A tampered override is refused before target creation, and omitting the
  override still recovers the six schedules from the manifest path.
- The existing production implementation already honors the override during
  both verification and import and was preserved. Temporarily replacing only
  the import read with `readFile(manifest.dump.path)` makes the new boundary
  test fail (six schedules instead of zero); the source was restored exactly.
  These checks use generated artifacts and isolated test databases only.

Requeue verification (2026-09-27): restored the manifest refusal guard to
`if (!verification.ok)` and removed the leftover disabled-guard mutation.
The existing forged-checksum test failed at its `result.ok === false`
assertion before that fix, proving it exercises this guard. Schedule assertions
now include the existing `api-drift` schedule at current HEAD (six per tenant);
no scheduler production code changed.
The required write-enablement and anonymous-identity mutations also fail
at their respective rejection assertions; the verified dump override mutation
fails with six schedules instead of zero. All temporary mutations were restored.
