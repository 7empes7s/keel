# Independent storage recovery qualification (roadmap task-114)

Gate: `storage-live-acceptance`. Depends on task-68 (read-only reconstruction
from independent artifacts) and task-69 (storage qualification binding).

Scope is set by the operator decision of 2026-09-30, "task-114 (storage) —
decided: local copy, honest ceiling" (`COMPLETE-ROADMAP-PLAN.md`). Backups go
to a local copy on a separate volume. The local-disk adapter keeps
`retentionLock` and `immutability` unsupported. This gate therefore qualifies
only what a local copy can prove:

- **independent recovery read** — a separately authenticated recovery account,
  which does not write backups and cannot write to the copy, reads every
  recovery artifact back from the copy and the bytes match;
- **manifest verification** — the task-67/68 recovery manifest, read from the
  copy, verifies against the copied bytes with recovery complete.

**Retention lock, immutability and the lock deletion canary are UNQUALIFIED.**
Every record says so in `subject.unqualified`, with the reason. They are never
claimed and never left out.

## Status — 2026-10-04: recovery-set tool

**The host blocker now has a tool; the gate still waits on live evidence.**
The nightly backup set (`/opt/backups/<date>/keel-db.sql.gz`) had only the
legacy `{path, checksum, timestamp}` manifest: no task-67 recovery manifest
and no configuration export tree, and `backup.sh` lives outside this repo.
`ops/keel-recovery-set.mjs` closes that gap without touching `backup.sh`. Given
one existing, verified dump, it writes a complete task-114-ready set into a new
or empty output directory:

| Set entry | Where it comes from |
| --- | --- |
| `<dump name>` (e.g. `keel-db.sql.gz`) | a byte copy of the source dump; the copy is re-hashed and must match |
| `config-export/manifest.json` and `config-export/<type>/<sha256>.json` | `engine/export/configExport.mjs` `exportSnapshot` (the code behind `cli/keel-export.mjs`), latest completed snapshot or `--snapshot-id` |
| `recovery-manifest.json` | `engine/storage/recoveryManifest.mjs` `buildRecoveryManifest` (the code behind `keel-dump-manifest.mjs --recovery`) |
| `recovery-set.json` | a summary: tenant ref, build, schema pin, snapshot, observation ids, evidence head (`seq:hash:count`), sha256 of the manifest, dump and export manifest. No secrets |

The pins are derived the same way their verifiers expect:
- **Tenant ref:** `tenantRefFor(tenantId)` from the tenant config
  (`--tenant-config` or `KEEL_TENANT_CONFIG_PATH`).
- **Build:** `--build`, or `git rev-parse HEAD` of the deployed checkout
  (`--checkout`, default the checkout the tool runs from). An explicit
  `--build` that differs from a git checkout's HEAD is refused.
- **Schema pin:** `currentSchemaPin`, the sha256 of the checkout's
  `engine/store/schema.sql`.
- **Observation ids:** `<snapshotId>:<resourceType>` for every type in the
  snapshot's coverage digest or persisted rows. These are the ids the export
  backs.
- **Evidence head:** the tenant's `evidence_head` row.

The observation ids and evidence head are read in one
`REPEATABLE READ READ ONLY` transaction that is always rolled back.

The recovery manifest names the dump and export relative to the set, so the
set verifies wherever it is copied. Before the tool reports success it runs
`verifyRecoveryManifest` over the set. The set must verify with recovery
complete.

**Rules the tool enforces**
- **Verified dumps only.** The dump's sha256 must equal the backup job's legacy
  manifest (`--dump-manifest`, which must name this exact dump) or
  `--dump-sha256`, and the gzip stream must be intact. With neither, it
  refuses.
- **Key metadata is references only.** It comes from `--key-instructions`,
  `--key-held-by` and `--key-location`, or from a small JSON file
  (`--key-metadata`, holding `{instructions, heldBy, location}` and no other
  fields), never both. All three are required and non-empty. A value is
  refused if it looks like a secret: a PEM block, `password=`/`passphrase:`
  style assignments, a bearer token, a URL with a password, a JWT, a cloud
  access key id, a long hex run, or a long mixed-case base64 run.
- **Read-only outside the output directory.** It only reads the source dump,
  the legacy manifest and every other existing backup. The output directory
  must be new or empty, and must not be, or contain, the source backup
  directory. On any refusal it removes only what it wrote.
- **`--dry-run`** prints what it would read (dump, dump manifest, tenant
  config, build, schema file, key metadata file, and the database URL with its
  password masked) and what it would write. It reads no dump bytes, opens no
  database connection and writes nothing.

**Tests.** `engine/roadmap/recovery-set.test.mjs` (added to the CI engine step
in `.github/workflows/portal.yml`) builds a set from fixtures: a gzip dump with
a legacy manifest, plus a completed snapshot and a two-record evidence chain in
the isolated test database. It then proves:
- `ops/keel-dump-manifest.mjs --verify` (run as a process) accepts the set
  with recovery complete;
- the capture tool's `--live` path accepts the set copied to a second
  directory (host facts injected, as in `storage-live-acceptance.test.mjs`),
  and its signed record passes `qualification.mjs` verification with
  `requireLive`.

It also proves these are rejected:
- missing or empty key instructions, by flag or file;
- secret-looking key metadata, and unknown key-file fields;
- a tampered export resource or export manifest, by `--verify` and by the
  capture;
- a wrong build, by the tool against a git checkout, by `--verify` and by the
  capture;
- an unverified dump;
- a non-empty or overlapping output directory.

It also checks that the source backup tree, the dump bytes and mtime and the
evidence table are unchanged, and that `--dry-run` writes nothing.

**Limits**
- **The evidence head is the database's head when the set is made, not when the
  dump was taken.** Make the set right after the nightly dump. If governed
  actions ran in between, the head is newer than the dump's contents; it still
  verifies against the set, but a reconstruction from the dump would end at an
  earlier head.
- **The export is of the current database's snapshot, not extracted from the
  dump.** Likewise, it should be made from the same night's state.
- **The checkout must be the deployed build.** The schema pin comes from that
  checkout's schema file. A non-git checkout takes `--build` on the operator's
  word.
- **Secret detection is a pattern check.** A secret written as plain words
  ("the key is apple banana …") is not detected. The tool states its rule;
  the operator keeps key material out.
- **It does not copy the set to the separate volume, run the capture or
  produce evidence.** Those stay operator steps (below). The committed
  placeholder `docs/release/qualifications/storage-live-acceptance.json` is
  unchanged and still pending.
- **The tests use fixtures.** They prove the tool and its consumers, not the
  host's backup directory, volumes or accounts.

## Status — 2026-10-03

**Code half shipped; the gate stays pending live evidence.** The verifier, the
evidence contract, the capture tool and the boundary tests are in place. No
independently captured record exists yet, so
`docs/release/qualifications/storage-live-acceptance.json` is a
`status: "pending"` placeholder. It fails `verify` with or without
`--require-live`. Nothing in this change marks a storage capability
qualified: `engine/storage/local.mjs` still declares `retentionLock` and
`immutability` unsupported, and task-69's `evaluateStorageQualification` is
unchanged.

### What was built

| Piece | File |
| --- | --- |
| Evidence contract and validator | `engine/storage/storageLiveEvidence.mjs` |
| Gate registration (additive, one entry) | `tools/release/qualification.mjs` (`GATE_VALIDATORS['storage-live-acceptance']`) |
| Capture tool (offline by default, read-only) | `tools/qualification/storageLiveAcceptance.mjs` |
| Pending placeholder | `docs/release/qualifications/storage-live-acceptance.json` |
| Boundary tests | `engine/roadmap/storage-live-acceptance.test.mjs` (added to CI in `.github/workflows/portal.yml`) |

`qualification.mjs verify` now also reads the tenant from
`KEEL_TENANT_CONFIG_PATH` for this gate when `--tenant` is not given, as it
already did for `deployed-acceptance`.

### The evidence record

A qualification evidence record (contract version 1) with
`operation: "storage.local-copy-recovery"`, `credentialMode: "recovery-reader"`
and a `subject` holding:

- `prerequisite` — task-68's recovery manifest version and the names of its
  credential prerequisites, and task-69's qualification version with the
  local adapter's `retentionLock` / `immutability` (`unsupported`). The
  verifier compares these with the production modules, so a record captured
  against different code, or one that says the local adapter has a lock,
  fails.
- `storage` — provider `local-disk` (any other provider is refused: a
  lock-capable target is outside the decided scope), `retentionLock` and
  `immutability` `unsupported`, a reference to the copy root, and the volume
  (device) ids of the primary backup and of the copy, which must differ.
- `identity` — the recovery principal and its credential **reference**,
  authenticated through task-68 `authenticateRecoveryIdentity` (anonymous is
  refused); the reader's OS account; the accounts owning the backup and copy
  files (the reader must not be one of them); `readerCanWrite` (must be
  `false`); and task-68 `listMissingPrerequisites` (must be empty).
- `recovery` — digests of the manifest, dump and export manifest as read back
  from the copy, each against its expected digest (the dump and export digests
  come from the manifest; the manifest digest from the primary backup or
  `--manifest-sha256`); the `verifyRecoveryManifest` result (must be `ok` and
  `recoveryComplete`); the manifest's `generatedAt` (not after the
  observation, at most 7 days before it); and the copy listing (count and
  digest of names) before and after the run, which must be identical.
- `qualified` — exactly `independent-recovery-read` and
  `manifest-verification`.
- `unqualified` — `retentionLock`, `immutability` and `lockCanary`, each
  `status: "UNQUALIFIED"` with a reason.
- `captureSha256` — the digest of the raw capture, inside the signed body.

Proof: `proof.runner` is an HMAC signature by `keel-release-runner`
(`KEEL_QUALIFICATION_HMAC_KEY`, never in git), and `proof.artifact` is the raw
capture. **Both are required for this gate.** The verifier recomputes the
artifact digest, checks it equals the signed `captureSha256`, and checks that
the artifact's tenant, build, operation, storage, identity and recovery parts
equal the record's.

**What fails:**
- an altered signature, an edited signed record, altered artifact bytes or a
  swapped artifact;
- a wrong or missing tenant, build or operation, a wrong credential mode or
  gate, and a backup pinned to another tenant;
- a stale observation (default 30 days), a backup older than 7 days or newer
  than the observation;
- a missing or different task-68 / task-69 prerequisite, and a missing task-68
  credential prerequisite (named);
- a missing artifact or signature, and the pending placeholder;
- a claim of retention lock or immutability, a missing `UNQUALIFIED` entry, or
  a provider other than `local-disk`;
- the copy on the same volume as the primary, a reader that also writes
  backups or can write to the copy, an unauthenticated or anonymous identity;
- a missing read, a read whose digest does not match, a manifest that does
  not verify or recovery that is incomplete;
- a copy listing that changed during the run;
- credential material anywhere in the record.

**Fixture evidence is never live.** A `live-qualified` record fails, even
without `--require-live`, when it is not `synthetic: false` or was signed by
the synthetic `keel-fixture-runner`. The capture tool's offline mode always
writes `fixture-tested`, `synthetic: true`, and signs only as
`keel-fixture-runner`.

### Capture tool safety

- **Offline by default.** It writes a small fixture backup to a temp
  directory, captures from it and removes it.
- **Read-only.** The live mode stats, lists and reads. It never deletes,
  writes or renames anything in the primary backup or the copy, and never runs
  a deletion canary. The before/after listing is recorded so this is
  checkable.
- **The identity is checked before anything is read.** `--recovery-principal`
  must be `os-user:<the account the tool runs as>`; otherwise the task-68
  authenticator refuses and nothing is written.
- **A failed verification is recorded as failed** (exit 1) and never verifies.

### Limits

- **No retention lock, no immutability.** A local copy cannot prove either; an
  administrator on that host can still change or delete the copy. This gate
  says that, and task-124 must report storage immutability as unqualified.
  This change does not edit task-124's dependency list or the queue holds
  (out of scope; the operator decision notes they need a matching edit).
- **Identity separation is at OS-account level.** The independent channel is
  the operating system login of a separate recovery account. The verifier
  checks the recorded account ids and write access; it cannot prove the
  accounts are controlled by different people, or that root on the host could
  not act as both.
- **Volume separation is by device id.** Two device ids prove two mounted
  filesystems, not two physical disks or two failure domains.
- **Manifest verification, not a full reconstruction.** The capture runs
  task-67/68 `verifyRecoveryManifest` against the copy (dump bytes, export
  tree, tenant/build/schema pins, evidence checkpoint). It does not import the
  dump into a disposable database; that is task-68's `reconstruct.mjs`, which
  the operator can run from the same copy (`ops/recovery-runbook.md`).
- **Build binding.** The manifest records the build that made the backup, and
  verification requires it to equal the capture's build. Capture against the
  commit the backup was made with.
- **The tests use generated backups and injected host facts.** They drive the
  capture tool's `--live` path against a real backup written to two temp
  directories, with volume ids, account ids and write access injected. They
  prove the verifier and the tool, not the real host.
- **No server or UI surface was added.** The integration for this gate is the
  CLI (capture and `qualification.mjs verify`).
- **Not all of the Validate command was run as a qualification.** Its
  `node --test` part passes in the build container. The final
  `qualification.mjs verify --require-live …` step was run against the pending
  placeholder and fails with
  `storage-live-acceptance external runner evidence pending`, as it should.

## Operator steps

**Make the recovery set (new, 2026-10-04).** Run on the host after the nightly
backup has written and verified the newest dump. Use the deployed checkout
(`/opt/keel`) so the build and schema pin are the deployed ones. It only reads
the backup and the database. It writes only into `--out`.

```bash
cd /opt/keel
latest=$(ls -1d /opt/backups/*/ | sort | tail -n 1); latest=${latest%/}
set -a; . /etc/keel/db.env; set +a          # KEEL_DB_URL (read-only use)
# References only, never key material:
cat > /root/keel-key-metadata.json <<'JSON'
{"instructions": "<runbook reference>", "heldBy": "<role or person>", "location": "<where the key is held>"}
JSON
node ops/keel-recovery-set.mjs --dry-run \
  --dump "$latest/keel-db.sql.gz" --dump-manifest /opt/backups/keel-db-manifest.json \
  --out "$latest/recovery-set" --tenant-config /etc/keel/tenant.json \
  --key-metadata /root/keel-key-metadata.json
# Review the plan, then run the same command without --dry-run.
```

The last lines it prints are the build, schema pin, evidence head and a
ready-to-run `keel-dump-manifest.mjs --verify` command. All of them are also
in `recovery-set.json`. If `/opt/backups/keel-db-manifest.json` already names
a newer dump, pass `--dump-sha256 <checksum from that night's backup log>`
instead.

**Copy it to the separate volume.** The copy is a plain recursive copy. It
must not remove or prune anything already on either side:

```bash
date=$(basename "$latest")
install -d -m 0755 /mnt/keel-copy/$date
cp -a --no-clobber "$latest/recovery-set/." /mnt/keel-copy/$date/
stat -c '%d %n' "$latest/recovery-set" /mnt/keel-copy/$date   # device ids must differ
chmod -R a-w /mnt/keel-copy/$date                              # the recovery account reads only
```

Then capture with `--primary-root "$latest/recovery-set"`, `--copy-root
/mnt/keel-copy/<date>`, `--manifest recovery-manifest.json`, `--dump
keel-db.sql.gz` and `--export config-export`. Take the `--checkpoint-*` values
from `recovery-set.json` `evidenceHead` (`seq:hash:count`), and run from a
checkout at `recovery-set.json` `build.revision`.

**What is needed**
- A backup set made by the deployed build: the dump, the configuration export
  tree, and a task-67 recovery manifest. `ops/keel-recovery-set.mjs` (above)
  makes all three. By hand, use `cli/keel-export.mjs` and
  `ops/keel-dump-manifest.mjs DUMP --recovery OUT … --evidence-head SEQ:HASH:COUNT
  --key-instructions … --key-held-by … --key-location …`. Key instructions and
  the evidence head are required: without them recovery is incomplete and the
  gate fails.
- A copy of that set on a **separate volume** (a different mount from the
  primary backup directory), laid out as `<manifest>`, `<dump>` and
  `<export>/manifest.json` plus the export's resource files. Names must be
  plain relative names (no leading dot, no `..`). Copying must not remove or
  prune any existing backup.
- A separate OS account for recovery, e.g. `keel-recovery`, that owns none of
  the backup files and has read-only access to the copy (no write permission
  on the copy root or any file in it).
- References (not secrets) for the three task-68 prerequisites:
  recovery key material, artifact storage read, tenant recovery authorization.
- The evidence head (`seq`, `hash`, `record count`) the manifest was built
  with, and `KEEL_QUALIFICATION_HMAC_KEY` for the release runner, kept outside
  git.

**Capture.** Run as the recovery account, from a checkout at the commit the
backup was made with. It only reads.

```bash
sudo -u keel-recovery env KEEL_QUALIFICATION_HMAC_KEY=... \
  KEEL_TENANT_CONFIG_PATH=/etc/keel/tenant.json \
  node tools/qualification/storageLiveAcceptance.mjs capture --live \
  --primary-root /opt/backups/<date> --copy-root /mnt/keel-copy/<date> \
  --manifest recovery-manifest.json --dump keel-db.sql.gz --export config-export \
  --recovery-principal os-user:keel-recovery \
  --recovery-credential-ref <reference to the recovery login> \
  --recovery-key-ref <reference> --storage-read-ref <reference> \
  --tenant-authorization-ref <reference> \
  --checkpoint-seq <N> --checkpoint-hash <HEX> --checkpoint-count <N> \
  --out <dir writable by keel-recovery>
```

If the recovery account cannot read the primary backup's manifest, pass its
digest with `--manifest-sha256 <HEX>` (from the backup job's output).
Copy `storage-live-acceptance.json` and `storage-live-acceptance.artifact.json`
from `--out` into `docs/release/qualifications/`, replacing the placeholder.

**Verify.** This is the task's final Validate step:

```bash
KEEL_TENANT_CONFIG_PATH=/etc/keel/tenant.json \
node tools/release/qualification.mjs verify --require-live \
  --gate storage-live-acceptance \
  --evidence docs/release/qualifications/storage-live-acceptance.json \
  --build <commit the capture ran on>
```

A pass qualifies independent recovery read and manifest verification from the
local copy only. Retention lock, immutability and the lock canary stay
UNQUALIFIED whatever the result.
