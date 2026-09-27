# Qualify independent retention-locked storage (task-69, WS10)

Date: 2026-09-25 UTC. Status: implemented, fixture-tested only; external
qualification pending (not-qualified by default).

## What was built

- `engine/storage/s3Compatible.mjs` (new) — the capability-negotiated
  S3-compatible reference storage adapter, implementing the task-67 storage
  adapter contract over an injected client (`putObject`, `getObject`,
  `headObject`, `listObjects`, `getObjectLockConfiguration`,
  `getObjectRetention`, `getBucketEncryption`; the harness additionally uses
  `deleteObject`/`putObjectRetention`). Object Lock support is NEVER inferred
  from S3 compatibility: `probeS3Capabilities()` observes the bucket's Object
  Lock configuration and encryption directly, and an endpoint that does not
  report Object Lock reads as `supported: false` with the observed reason.
  `publish()` is publish-once with a sha256 handed to the backend, and its
  result always carries `immutableProof: false` — upload success is not
  immutable proof. The adapter's `retentionLock`/`immutability` claims come
  from `retentionClaimFor()`: `'fixture-tested'`/`'live-qualified'` only with
  a qualified evaluation bound to the adapter, `'unsupported'` when the probe
  affirmatively found no Object Lock, otherwise `'unknown'`. Bucket names,
  prefixes and residency fields are validated reference text —
  credential-shaped values are refused at construction. Object names reuse the
  task-67 `assertObjectName` containment rules.
- `engine/storage/qualification.mjs` (new) —
  `evaluateStorageQualification()` binds a qualification verdict to the whole
  boundary: tenant pin (`tenant_ref`, mandatory), provider/bucket, observed
  Object Lock, canary artifact evidence (name + sha256), checksum-verified
  readback, refused deletion, retention mode (only `COMPLIANCE` qualifies;
  `GOVERNANCE` is bypassable and never does), observed retention period, a
  `retention-scoped` credential class AND an observed failure of the
  credential to alter retention, bucket encryption, residency metadata, and
  independent key recovery material references (`heldBy`/`location`/
  `instructions`). Every defect reads as a named failure; the verdict is
  frozen and includes `binding` only when qualified. Builder fixtures are
  always `synthetic` and can reach at most `evidenceLevel: 'fixture-tested'`;
  missing external qualification remains not-qualified and prevents immutable
  claims.
- `tools/qualification/storageLock.mjs` (new) — the deletion-test harness and
  CLI. `runStorageLockQualification()` probes capabilities, publishes a
  uniquely named canary with its sha256, reads it back with bounded retries
  (every returned byte sequence is checksum-verified; a corrupt read is
  disqualifying rather than retried), attempts deletion (must be refused with
  a retention error code), attempts to shorten/alter retention with the same
  credential (must fail — a credential that can alter retention is
  indistinguishable from an account admin), reads the canary's retention
  status, and records a cleanup attempt honestly (under a working compliance
  lock the canary remains until retention expires). `createFakeS3Client()` is
  the synthetic fixture client (`fixture: true`). The CLI
  (`runCli({ argv, logger, dependencies })`) requires the full binding flags
  (`--bucket --tenant-ref --out --region --boundary --credential-boundary
  --credential-class --key-held-by --key-location --key-instructions`),
  refuses credential-shaped flag values before anything runs or is written,
  writes the evidence record atomically with mode 0600, and exits 0 only when
  qualified. Without `--fixture` (and without an injected client factory) the
  CLI refuses: live qualification against a real provider is run by the
  orchestrating session with externally provisioned credentials, never by the
  builder. No provider purchase, no real deletion, no live tenant access.

No schema or data migration was needed: the qualification record is a JSON
document over adapter/harness observations, pinned to `tenant_ref`; no
existing tables changed, so no legacy-read handling was required either.
`engine/storage/adapter.mjs` and `engine/storage/local.mjs` (task-67) are
unchanged; the s3-compatible provider needs no capability ceiling entry
because a genuine Object Lock primitive may exist there — the negotiation and
qualification binding enforce honesty instead. There is no portal/UI surface
in this task; the named integrations are the engine modules and the
qualification CLI. `evaluateStorageQualification()` is the seam a future UI
or release-gate task can consume.

## Implementation and proof limitations

- Everything here is fixture-tested against `createFakeS3Client()`, an
  in-memory synthetic client. A fake proves code behavior, not provider
  behavior (Global Constraint #6): no real S3-compatible service was
  provisioned or purchased, no real object was locked or deleted, and no
  storage credentials were used. External (live) qualification remains
  outstanding and the default state of every target is not-qualified.
- A `fixture-tested` verdict qualifies the CODE PATH only. Promoting a real
  bucket to `live-qualified` requires the orchestrating session to run the
  same harness with an externally provisioned non-fixture client
  (`synthetic: false`) against the real provider, bound to that
  provider/bucket/mode/retention/credential boundary at that time —
  qualification never generalizes across buckets, modes, credentials or
  builds.
- The bypass test proves the qualification credential could not alter
  retention at observation time. It does not enumerate every other credential
  the provider account may hold; that remains an operational/attestation
  concern recorded via the credential-boundary reference.
- Under a genuine compliance lock the canary object cannot be removed until
  its retention expires; the harness reports the remaining canary rather than
  hiding it, and live runs must use the shortest acceptable retention for
  qualification canaries.
- Key recovery material references are checked for presence and shape only;
  custody of the actual material is an operational fact no code here proves.

## Boundary tests

`engine/roadmap/immutable-storage.test.mjs` exercises the production modules
against injected fake clients, including the three required mutation checks:

- Infer Object Lock from S3 compatibility: an S3-speaking client without
  Object Lock probes `supported: false`, the harness publishes nothing, the
  verdict stays not-qualified with `S3 compatibility alone does not establish
  Object Lock`, and the adapter claims `retentionLock: 'unsupported'`.
- Mark upload success as immutable proof: `publish()` returns
  `immutableProof: false`, a probe-without-harness evaluation fails with
  `a successful upload is not proof of immutability`, a harness record with
  the deletion test omitted fails, and an unqualified adapter claims only
  `'unknown'`.
- Skip retention-mode check: a GOVERNANCE-mode fixture whose deletions are
  refused still fails with `not COMPLIANCE`.

It also pins the two evidence-integrity checks a forged harness record must
never pass: a blank, non-hex, wrong-length or missing canary sha256 fails
with `canary evidence lacks a sha256 checksum`, and a missing, null or empty
observed `retainUntilDate` fails with `no retention period was observed` —
both verdicts stay not-qualified with no binding and no evidence level.

It also covers the remaining acceptance cases: the fake locked provider
refusing deletion and reporting COMPLIANCE retention with a future retain
date; the unsupported backend staying not-qualified; account-admin and unknown
credential classes refused even when every behavioral test passed, and a
declared retention-scoped credential that is OBSERVED able to alter retention
disqualified (the two classes cannot be confused by labeling); readback
retries verifying the checksum per attempt (a corrupted read disqualifies,
transient `SlowDown` errors retry to a verified read); encryption, residency
and key recovery references required, with credential-shaped metadata refused
at evaluation and at adapter construction; qualification binding pinned to
provider/bucket/mode/credential boundary and canary evidence with mismatched
bindings refused and the tenant pin mandatory; the adapter roundtrip
(publish-once, list prefixing, verify checksum/absence handling, hostile
names, fresh `retentionStatus()` observation); and the CLI end-to-end —
fixture qualification exit 0 with an atomically written 0600 evidence record
containing references only, unsupported fixture exit 1 with the negative
verdict recorded, refusal to run without `--fixture` (live qualification
belongs to the orchestrating session), hollow invocations refused, and
`--help`.

## Requeued verification (2026-09-26)

The existing evaluator already enforced the three reviewer-identified checks;
the missing coverage was isolated adversarial evidence. New boundary tests
start with a qualified synthetic harness and change only one condition:
omit or invalidate `residency.region`, omit or invalidate `harness.publish.ok`,
or request `expectedBinding.mode: 'GOVERNANCE'` while the observed canary
retention remains `COMPLIANCE`. Each case requires exactly the corresponding
failure, `qualified: false`, no binding, no evidence level, and an `unknown`
retention claim. This prevents another failed check from masking the bypass.

All three reviewer mutations now fail their corresponding new test. The
three original required mutations also fail the boundary suite. Each mutation
was applied independently and the production source restored byte-for-byte
afterward. No production behavior, schema, credential separation, or external
qualification status changed; live qualification remains pending.

The subsequent deletion-refusal review gap is now covered by an injected
client that reports COMPLIANCE metadata while its in-memory storage actually
deletes the canary. The boundary test verifies the object is absent, both
delete calls target the canary, and deletion is the sole qualification
failure. The verdict has no binding or evidence level, and the adapter keeps
both immutability and retention-lock claims at `unknown`.

Hardcoding the harness's successful-delete result to `refused: true` now
fails this test (14 pass, 1 fail). The three plan-required mutations were
also rerun and killed independently; production files were restored
byte-for-byte after each mutation. Existing production behavior is preserved;
this addition tests only synthetic clients and makes no live qualification
claim.
