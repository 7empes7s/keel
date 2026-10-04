# Keel read-only recovery runbook (task-68, WS10)

How to reconstruct a **read-only, writers-disabled** keel instance from the
independent recovery artifacts after losing the production database. This
procedure never touches the production services or a live tenant; it rebuilds
into a **disposable** database for verification and operator read access.

Fixture-tested only. A fake proves code behavior, not Microsoft support or a
real recovery; this procedure has not been exercised against a live disaster.

## Prerequisites (gather BEFORE you start — the tool names any you miss)

| Prerequisite (reported name) | What it is | Where it lives |
| --- | --- | --- |
| `recovery-key-material` | The separately-held recovery key material | Per the manifest's `keyRecovery` block: `heldBy` / `location` / `instructions` (e.g. sealed envelope in the offline safe) |
| `artifact-storage-read` | Read access to the artifact storage holding the dump and the configuration export | The backup service account referenced in the manifest's residency metadata — a reference, never the credential |
| `tenant-recovery-authorization` | A change record / signed authorization to perform recovery for this tenant | Your change-management system |

You also need:

- An **independently authenticated recovery identity**: a named principal plus
  the separately-held credential that proves it (break-glass token, hardware
  key ceremony). The reconstruction authenticates through an independent
  channel, never through the keel database being rebuilt. **There is no
  anonymous emergency bypass.**
- The task-67 recovery manifest (`keel-dump-manifest.mjs --recovery …`), the
  SQL dump it checksums, and the configuration export directory it references.
- The current build revision and schema pin of the environment doing the
  recovery (`git rev-parse HEAD`; `sha256` of `engine/store/schema.sql` — the
  CLI prints what it was given, the verifier compares, it never trusts).
- The current evidence chain head (`evidence_head`: `SEQ:HASH:COUNT`) if you
  have an external anchor for it; without it the manifest checkpoint is still
  enforced against the reconstructed chain, but the "is this head current?"
  gap is reported as `evidence-checkpoint-unverified` and recovery is
  INCOMPLETE.
- A **disposable** PostgreSQL database or schema to reconstruct into. Never
  the production database: the default target factory refuses `KEEL_DB_URL`.

## Procedure

1. **Fetch the artifacts** with the `artifact-storage-read` credential:
   the recovery manifest, the dump it names, the configuration export tree.
2. **Authenticate** your recovery identity through the independent channel:
   on the offline machine holding your enrolled Ed25519 key, sign a
   single-use assertion bound to the tenant
   (`node tools/recovery/recovery-assertion.mjs sign … --out assertion.json`)
   and copy only `assertion.json` to the recovery host. Enrollment, trust
   store and replay ledger setup are in
   [keel-recovery.md › Operator steps](../docs/roadmap/keel-recovery.md#operator-steps).
   The CLI refuses to run without `--authenticator signed-assertion`; no
   other authenticator, fixture included, is selectable.
3. **Run the reconstruction** (from the repository root, DB env sourced):

   ```bash
   node tools/recovery/reconstruct.mjs \
     --manifest /secure/artifacts/recovery.json \
     --tenant-ref sha256:… \
     --build-revision "$(git rev-parse HEAD)" \
     --schema-pin "$(sha256sum engine/store/schema.sql | cut -d' ' -f1)" \
     --config-export-dir /secure/artifacts/export \
     --evidence-head SEQ:HASH:COUNT \
     --target-url postgres://localhost/keel_scratch \
     --identity-principal recovery-officer@example.com \
     --credential-ref assertion.json \
     --authenticator signed-assertion \
     --recovery-trust-store /etc/keel/recovery-authenticators.json \
     --recovery-replay-ledger /var/lib/keel/recovery-replay \
     --recovery-key-ref 'sealed envelope #7, offline safe' \
     --storage-read-ref 'backup service account reference' \
     --tenant-authz-ref 'change record CR-YYYY-NNNN' \
     --result-out reconstruction.json
   ```

   The trust store and replay ledger must lie outside the backup set (the
   manifest, dump and export directories); the assertion is refused once
   expired (15 minutes at most) or already used.

   The workflow refuses, in order, with a named stage: `identity` (anonymous
   or unauthenticated), `prerequisites` (missing credentials, listed by
   name), `manifest` (any tampering — dump checksum, tenant pin, build or
   schema pin, export bytes, evidence head), `schema` (the schema about to be
   applied is not the pinned one — stops before import), `import`, `history`
   (the reconstructed evidence chain or head does not match the manifest
   checkpoint). `--result-out` writes the result record (verdicts, counts,
   evidence checkpoint, tenant, build, completion time; no row contents) that
   gate `drill-live-acceptance` takes as `reconstruction.json`.
4. **On success** the instance is read-only: the access session has
   `default_transaction_read_only = on` at the database level plus a
   statement guard, so no write path exists during or after reconstruction.
   The guard also refuses writable CTEs, DML after a WITH clause,
   `SELECT INTO`, `EXPLAIN ANALYZE`, multi-statement batches and
   session-mode resets (`SET`/`RESET`/`set_config()`), so it cannot be
   talked into re-enabling writes.
   The CLI prints counts (schedules, approvals, principals, grants, evidence)
   and exits; the disposable target schema remains for inspection and is the
   operator's to drop.

## What this does NOT do

- It does not restore or modify any Microsoft 365 tenant object. Recovery of
  tenant configuration remains the artifact-only restore promotion path
  (task-8 dry-run artifact, approval, re-execution guards) against the live
  target — a separate, deliberate step after the instance is verified.
- It does not re-enable writers, schedules, the worker, or notifications. The
  reconstructed instance is evidence and a planning surface, nothing more.
- Local-disk storage has no retention lock or immutability (task-67); treat
  artifact integrity as proven by checksums and the evidence chain, not by
  filesystem permissions.

## Failure handling

- Any refusal exits 1 and prints the stage and the failures. Fix the named
  cause; do not retry past a tamper refusal without re-fetching the artifacts
  and re-checking custody.
- A failed import discards the half-built disposable schema; a `history`
  refusal leaves it in place for inspection — drop it when done.
