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

## Status — 2026-10-04: production recovery authenticator

Gate 116 (`drill-live-acceptance`, operator step 3) needs a reconstruction run
"with the deployment's real recovery authenticator". Until now none existed:
`reconstruct.mjs` correctly refused to run without an injected independent
authenticator, and the only non-test authenticator was the release-journey
fixture `async () => true` (`tools/release/journeys.mjs`).

### What "independent" means here

Task 68 requires an "explicit independently authenticated recovery identity",
and `engine/authz/recoveryMode.mjs` says the channel must be separate (a
break-glass token or a hardware-key ceremony), never this process's say-so.
Recovery runs because the keel database may be lost, so the authenticator
must not read the keel database or portal being recovered, and nothing it
trusts may be part of the backup set: whoever can tamper with the artifacts
must not be able to enroll themselves. The plan names no specific mechanism.

### What was built

- `engine/authz/recoveryAuthenticator.mjs` (new): the `signed-assertion`
  authenticator.
  - **Trust store** (for example `/etc/keel/recovery-authenticators.json`):
    the Ed25519 **public** keys of the enrolled recovery principals,
    `{ "version": 1, "principals": [{ "principalId", "keyId", "publicKey" }] }`.
    It holds no secret. It is refused when it carries private key material, a
    non-Ed25519 key, a duplicate or empty enrollment, or is group- or
    world-writable.
  - **Signed recovery assertion**: the operator signs
    `{ v, purpose: "keel-recovery-reconstruct", principalId, keyId, tenantRef,
    issuedAt, expiresAt, nonce }` with the private key, which never leaves the
    operator's offline machine or token host. The identity's `credentialRef`
    is the path to the assertion file: a reference, never the key.
  - **Replay ledger** (for example `/var/lib/keel/recovery-replay/`): each
    accepted nonce is claimed with an exclusive file create, so one assertion
    authorizes exactly one reconstruction, also under concurrent runs.
  - Refused with a named reason at the `identity` stage: anonymous or missing
    principal; unreadable or malformed assertion; unsigned extra fields;
    another purpose; an assertion issued to another principal; a principal not
    enrolled; another key id; another tenant; a signature that does not verify
    against the enrolled key; expired; issued more than 60 s in the future;
    lifetime over 15 minutes (a deployment may lower it, never raise it); a
    used nonce.
  - The trust store and replay ledger are refused when they lie inside the
    backup set (the manifest's directory, the dump's directory or the
    configuration export directory).
  - `selectRecoveryAuthenticator({ kind })` accepts only `signed-assertion`.
    The fixture has no name, carries no production mark
    (`productionAuthenticatorKind()` returns `null`) and cannot be selected.
- `tools/recovery/reconstruct.mjs`: new flags `--authenticator
  signed-assertion --recovery-trust-store FILE --recovery-replay-ledger DIR`,
  and `--result-out FILE`. With `--authenticator`, an injected
  `dependencies.authenticator` is refused rather than silently used. Without
  the flag the command line still refuses: it never injects an authenticator
  itself. `--result-out` writes the reconstruction result for gate 116 (see
  below) and never overwrites an existing file.
- `tools/recovery/recovery-assertion.mjs` (new): operator tooling.
  `keygen` (Ed25519 pair, private key mode 600), `enroll` (adds the public key
  to a trust store and refuses a private key), `sign` (single-use assertion,
  default 10 minutes, at most 15).

### Operator steps

1. **Once, on the operator's offline machine or token host** (not the
   recovery host):

   ```bash
   node tools/recovery/recovery-assertion.mjs keygen \
     --private-out officer.pem --public-out officer.pub.pem
   ```

   Keep `officer.pem` offline (it is the break-glass credential; it never goes
   into git, a backup, the evidence or the recovery host).
2. **Once, on the recovery host**, enroll the public key in a trust store
   outside the backup set, owned by root, mode 644:

   ```bash
   node tools/recovery/recovery-assertion.mjs enroll \
     --principal recovery-officer@<org> --key-id officer-2026-10 \
     --public-key officer.pub.pem --trust-store /etc/keel/recovery-authenticators.json
   install -d -m 700 /var/lib/keel/recovery-replay
   ```

3. **Per reconstruction**, on the offline machine, sign an assertion bound to
   the tenant, then copy only the assertion file to the recovery host:

   ```bash
   node tools/recovery/recovery-assertion.mjs sign --key officer.pem \
     --principal recovery-officer@<org> --key-id officer-2026-10 \
     --tenant-ref "$KEEL_QUALIFICATION_TENANT_REF" --lifetime-minutes 10 \
     --out assertion.json
   ```

4. **Run the reconstruction** within the assertion's lifetime, with the
   task-114 recovery set (`ops/recovery-runbook.md` has the full flag list):

   ```bash
   node tools/recovery/reconstruct.mjs \
     --manifest <set>/recovery.json --dump <set>/dump.sql.gz \
     --config-export-dir <set>/export \
     --tenant-ref "$KEEL_QUALIFICATION_TENANT_REF" \
     --build-revision "$(git rev-parse HEAD)" \
     --schema-pin "$(sha256sum engine/store/schema.sql | cut -d' ' -f1)" \
     --evidence-head SEQ:HASH:COUNT --target-url <disposable database URL> \
     --identity-principal recovery-officer@<org> --credential-ref assertion.json \
     --authenticator signed-assertion \
     --recovery-trust-store /etc/keel/recovery-authenticators.json \
     --recovery-replay-ledger /var/lib/keel/recovery-replay \
     --recovery-key-ref '<reference>' --storage-read-ref '<reference>' \
     --tenant-authz-ref '<change record>' \
     --result-out reconstruction.json
   ```

5. **Gate 116's `reconstruction.json`** is the `--result-out` file. It holds
   exactly what `capture-drill` reads (`ok`, `stage`, `readOnly`,
   `writersDisabled`, `recoveryComplete`, `incomplete`,
   `recovered.evidence`) plus `tenantRef`, `buildRevision` (from
   `--build-revision`, so run it at the deployed build) and `completedAt`,
   counts, and the authenticated identity reference (principal, assertion
   path, `authenticator: "signed-assertion"`). No row contents and no access
   handle. Pass it to `qualification.mjs capture-drill --reconstruction
   reconstruction.json` as in
   [drill-live-acceptance.md › Operator steps](drill-live-acceptance.md#operator-steps).

### Boundary tests

- `engine/roadmap/recovery-authenticator.test.mjs` (new, no database): a
  valid assertion authenticates through `authenticateRecoveryIdentity()`;
  anonymous, wrong (unenrolled key, other principal, other tenant, other key
  id, tampered, unsigned or extra fields, bad nonce), expired, not-yet-valid,
  overlong and replayed assertions are refused, including a replay across
  authenticator instances and two concurrent presentations (exactly one
  wins); the trust-root checks above; `fixture`, `always-true`, empty and
  missing kinds are not selectable and the fixture shape has no production
  mark; through the CLI, `--authenticator fixture`, an injected authenticator
  alongside `--authenticator`, no authenticator, a wrong, expired, anonymous
  or replayed identity and a trust store inside the backup set all exit 1 at
  the `identity` stage before any target database is created; the operator
  tooling round-trips keygen, enroll and sign.
- `engine/roadmap/keel-recovery.test.mjs` (added test): the full CLI
  reconstruction with the production authenticator recovers the fixture
  history, writes `reconstruction.json` with the gate fields bound to tenant
  and build, and refuses the same assertion a second time.
- Mutations checked by hand, each restored: skipping the nonce claim,
  skipping the expiry check, accepting any authenticator kind, skipping the
  tenant binding and skipping the backup-set check each fail the new suite.
- Both suites run in CI (`.github/workflows/portal.yml`, restore engine tests).
  `keel-recovery.test.mjs` was not in CI before; it passes there unchanged.

### Limits and the decision this leaves to the operator

- **Design decision (open).** The plan does not name the authentication
  mechanism; this implements one candidate: an operator-held Ed25519 key with
  short-lived, tenant-bound, single-use signed assertions, verified against a
  public-key trust store outside the backup set. The operator should confirm
  it, or name another channel (for example a FIDO2/hardware-key ceremony or an
  identity provider that does not depend on keel), and decide:
  - key custody: who holds the private key, where (offline laptop, hardware
    token with an Ed25519 PKCS#11 key, sealed envelope), and how many
    principals are enrolled (one or two-person);
  - the trust store and replay ledger locations (examples above) and that
    both are excluded from the backup set;
  - the maximum assertion lifetime (15 minutes ceiling, 10 by default);
  - rotation and revocation: removing a principal from the trust store revokes
    it; there is no expiry on enrollment itself.
- The authenticator proves possession of the enrolled private key at signing
  time. It does not prove which human used it, and the trust store's
  integrity rests on host file permissions (root-owned, not group- or
  world-writable). A host administrator can enroll a key.
- The replay ledger is a local directory. Two recovery hosts with separate
  ledgers would each accept the same assertion once; the tenant binding and
  15-minute ceiling bound that window.
- Assertions bind the tenant, not a specific manifest. A stolen assertion is
  usable for one reconstruction of that tenant within its lifetime, and it
  still needs the artifacts, the credential references and a disposable
  database.
- Fixture-tested only. No real key was generated or enrolled on the host, no
  live reconstruction ran, and no evidence under `docs/release/qualifications/`
  changed.
