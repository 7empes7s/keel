# Storage retention residency and recovery manifest (task-67, WS10)

Date: 2026-09-22 UTC. Status: implemented, fixture-tested only.

## What was built

- `engine/storage/adapter.mjs` (new) — the storage adapter contract. An
  adapter exposes exactly five operations — `publish`, `read`, `list`,
  `verify`, `retention-status` — plus a frozen capabilities descriptor built
  by `defineStorageCapabilities()`. Capability claims use the closed Global
  Constraint #5 vocabulary (`declared`, `fixture-tested`, `live-qualified`,
  `unsupported`, `unknown`); anything else is a `TypeError`. A provider
  ceiling table makes it a construction error for a `local-disk` provider to
  claim `retentionLock` or `immutability` above `unsupported`/`unknown` —
  filesystem permissions are revocable access control, never immutable
  storage. `assertNoEmbeddedCredential()` rejects metadata values that look
  like credential material (private-key blocks, bearer tokens,
  `password=…`/`token: …` assignments) so residency and credential-boundary
  fields can carry references only, never secrets. `assertStorageAdapter()`
  validates the descriptor and the presence of all five operations.
- `engine/storage/local.mjs` (new) — the local-disk reference adapter.
  `publish(name, bytes)` is atomic (private `wx` temp file + one `rename(2)`)
  and publish-once (an existing object name is refused, never clobbered).
  Object names are bare relative names — traversal, absolute paths, empty
  segments and dot-segments are rejected, and symlinked path components are
  refused before anything is written. `verify()` checks the sha256 (and
  optional byte count) over the actual bytes and refuses to run without a
  checksum. `retentionStatus()` honestly reports
  `retentionLock: 'unsupported'`, `immutability: 'unsupported'` with an
  explicit note that filesystem permissions do not constitute a retention
  lock; tightening mode bits does not change the answer.
- `engine/storage/recoveryManifest.mjs` (new) —
  `buildRecoveryManifest()`/`verifyRecoveryManifest()` for the versioned
  recovery manifest (`RECOVERY_MANIFEST_VERSION = 1`). The manifest links: the
  tenant pin (`tenant_ref`, mandatory — build throws without it); the build
  revision and the schema pin (`currentSchemaPin()` = sha256 of
  `engine/store/schema.sql`; `currentBuildRevision()` = `git rev-parse HEAD`,
  injectable); the SQL dump path and sha256 over the actual compressed bytes;
  the included observation IDs (`<snapshotId>:<resourceType>`, the task-45
  observation identity); the configuration export manifest by path and sha256
  (a reference to the task-56 manifest, never a copy); the evidence chain
  checkpoint (`evidence_head` seq/hash/record count — a reference to the
  task-45 anchor); residency/provider/credential-boundary metadata; and
  separately-held key recovery instructions (`heldBy`, `location`,
  `instructions` — reference text, credential-shaped values refused at build).
  `verifyRecoveryManifest()` reads the real artifact bytes: it re-hashes the
  dump file, reads and re-hashes the referenced export manifest, runs the
  task-56 `verifyManifest()` over the whole export tree (every resource
  file's bytes, tenant-pinned), and checks every listed observation id is
  backed by an observation in that export. Dump checksum mismatch, missing or
  foreign tenant pin, build revision or schema pin mismatch, unbacked
  observation ids, checkpoint mismatch and credential-shaped metadata are hard
  failures. Two conditions are reported as *incomplete recovery* rather than
  byte failures: missing key recovery instructions, and an evidence checkpoint
  the verifier could not check against a current head. Verifying without the
  verifier's own build/schema pins is a failure — the link can never silently
  pass. Returns `{ ok, failures, recoveryComplete, incomplete }`; malformed
  input reads as `{ ok: false, … }`, never a crash.
- `ops/keel-dump-manifest.mjs` (extended) — the existing
  `writeDumpManifest(dumpPath, manifestPath)` export and the
  `{ path, checksum, timestamp }` manifest shape are unchanged, as is the
  single-argument invocation from `backup.sh`. Added: `writeRecoveryManifest()`
  (hashes the dump, builds the recovery manifest, writes it atomically with
  0600 temp-then-rename) and an injectable `runCli({ argv, logger,
  dependencies })` with three modes: legacy dump-manifest write
  (`DUMP [--manifest PATH]`), recovery-manifest write (`DUMP --recovery OUT`
  with `--tenant-ref`, `--build-revision`, `--schema-pin`,
  `--config-export-dir`, repeatable `--observation`, `--evidence-head
  SEQ:HASH:COUNT`, key-instruction and residency flags), and verification
  (`--verify RECOVERY …`, exit 0/1). Nothing prints or stores credentials.

No schema or data migration was needed: the manifest is a JSON document over
existing artifacts, and the evidence checkpoint reads the existing
`evidence_head` row. Legacy-read handling is inherited: the dump manifest
shape predating this task is untouched, and the observation IDs derive from
the task-56 export manifest, whose own legacy handling (contractVersion 0
digests read as `unknown` evidence) is unchanged.

## Implementation and proof limitations

- Everything here is fixture-tested against synthetic rows in the isolated
  test database (`engine/test/dbTestHelper.mjs`), gzip fixture dumps and
  tmp-directory trees. No live tenant was touched, no cloud storage was
  provisioned, and collector/restorer credentials were not used.
- The only storage adapter is the local disk reference. It proves the
  contract and the code behavior — it does NOT prove real recovery, real
  retention, or offsite durability. `retentionLock` and `immutability` are
  genuinely `unsupported` on this medium; a provider-native locked adapter
  (object-lock S3, immutable blob) is future WS10 work and must carry its own
  live-qualified evidence.
- Key recovery instructions are references to separately-held material. Their
  presence is checked; their correctness, and the actual custody of key
  material, are operational facts no code here can prove.
- The evidence checkpoint is a reference to the in-database chain head. As
  noted in `engine/govern/evidence.mjs`, an actor with write access to both
  evidence tables can rewrite a consistent chain; genuine non-repudiation
  needs external anchoring, which remains out of scope.
- There is no portal/UI surface in this task; the named integration is the
  ops CLI. `verifyRecoveryManifest()` is the seam a future UI task can
  consume.

## Boundary tests

`engine/roadmap/storage-contract.test.mjs` exercises the production modules
against the isolated test database and tmp trees, including the three required
mutation checks:

- Accept mismatched dump checksum: the dump file is appended-to under a
  recorded checksum, and a forged manifest checksum is verified against intact
  bytes — both fail with `dump checksum mismatch` (plus `dump length
  mismatch`); an unreadable dump fails as well.
- Label local permissions immutable: the local adapter's descriptor and
  `retentionStatus()` assert exactly `unsupported` even after `chmod 0500`,
  and `defineStorageCapabilities()` throws for a `local-disk` provider
  claiming `retentionLock`/`immutability` as `declared`, `fixture-tested` or
  `live-qualified`.
- Omit tenant pin: `buildRecoveryManifest()` throws without a `tenant_ref`
  (and rejects a raw unhashed id), a manifest with the pin deleted fails
  verification with `lacks a tenant pin`, and a foreign `expectedTenantRef`
  fails with `tenant pin mismatch`.

It also covers the remaining acceptance cases: the full happy path verifying
against real artifact bytes, observation IDs and the evidence checkpoint;
missing key recovery instructions yielding `ok: true` but
`recoveryComplete: false`; build revision and schema pin mismatches refused
(and verification without the verifier's own pins failing rather than
passing); observation IDs not backed by the export refused; a forged export
manifest checksum and corrupted export resource bytes folded in through the
task-56 `verifyManifest` seam; evidence checkpoint mismatch refused and an
unverifiable anchor reported as incomplete; credential-shaped metadata refused
at build and at verify; the local adapter roundtrip (atomic publish-once,
corruption/absence detection, traversal and symlink refusal, injected rename
failure leaving nothing); and the ops CLI end-to-end — legacy manifest shape
preserved, recovery manifest written and verified (exit 0), tampered dump and
foreign tenant refused (exit 1), hollow invocations rejected.
