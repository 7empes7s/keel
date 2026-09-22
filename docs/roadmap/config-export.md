# Atomic redacted configuration file exports (task-56)

Date: 2026-09-22 UTC. Status: implemented, fixture-tested only.

## What was built

- `engine/export/manifest.mjs` (new) — the versioned manifest contract
  (`MANIFEST_VERSION = 1`). `filenameForKey(naturalKey)` is the only sanctioned
  derivation from natural key to filename: a bare `sha256(naturalKey).json`
  hex digest, so a slash-containing or absolute-path key can never influence
  where bytes land. `stableJson(value)` is the deterministic serializer
  (recursively sorted keys, fixed indentation, trailing newline) used for both
  resource files and the manifest itself. `buildManifest()` assembles the
  manifest: tenant_ref pin, snapshot id and volatile snapshot/export times,
  and a per-type completeness map. `verifyManifest(manifest, dir,
  { expectedTenantRef })` checks structure, the tenant pin, and sha256 +
  byte-length checksums over the actual files on disk; a manifest entry whose
  filename is not a bare hash fails closed as an unsafe filename, and any
  malformed input reads as `{ ok: false, failures }`, never a crash.
- `engine/export/configExport.mjs` (new) — `exportSnapshot(client,
  { tenantRef, snapshotId?, exportRoot, dependencies? })` publishes
  `<exportRoot>/<tenantDir>/<snapshotId>/<resourceType>/<hash>.json` plus
  `manifest.json`, with `<tenantDir>/latest` as the pointer. The sequence is:
  resolve the snapshot (tenant-scoped always — an explicit snapshot id must
  belong to the tenant and be a completed run; otherwise the tenant's latest
  completed snapshot is used), read `resource_version` rows, redact every
  payload through `exportProjection()` (task-51), stage everything into a
  private 0700 `.staging-<uuid>` directory inside the tenant dir, build the
  manifest and verify its checksums against the staged bytes, then publish
  with a single atomic `rename(2)` of the staging directory. The `latest`
  symlink advances — via a create-temp-link-then-rename swap — only after
  that rename and a second verification of the published bytes. Any failure
  removes the staging directory and leaves the previous `latest` untouched.
  Symlinked path components (export root, tenant dir, snapshot dir) are
  rejected before anything is written; `latest` is the only symlink in the
  tree and is never written through. Re-exporting an already-published
  snapshot id refuses rather than clobbering. `readLatestExport()` reads and
  verifies the export `latest` names.
- Per-type completeness comes from the snapshot's persisted
  `coverage_digest`, read through the task-45 observation contract
  (`readObservation`), so observation windows, completeness states and
  evidence levels ride the manifest with their exact prior meaning. Only a
  complete enumeration carries `absenceMeansDeletion: true` — a missing
  resource file there is a deletion. Partial types keep their observed
  resources with `enumeration: 'partial'`; failed and not-requested types
  carry `resources: null` (explicit unknown/missing), never an empty listing
  implying "no resources". A complete type whose digest `itemCount` disagrees
  with the persisted row count aborts the whole export instead of publishing
  a quietly incomplete enumeration. Volatile times (snapshot started/completed,
  per-type observation windows, the export instant) appear only in the
  manifest — resource bytes are a pure function of the redacted payload
  values.
- `cli/keel-export.mjs` (new) — `node keel-export.mjs --export-root PATH
  [--snapshot-id ID] [--tenant-ref REF] [--config /etc/keel/tenant.json]
  [--db-url $KEEL_DB_URL]`, following the keel-collect/keel-baseline-create
  conventions (arg parsing, injectable `connect`/`exportSnapshot`
  dependencies, `runCli` exit codes, tenant ref derived from the config file
  unless `--tenant-ref` wins). It reads the local database and writes local
  files only — no Graph token, no tenant access, no credentials beyond the
  database URL.
- `engine/collect/snapshot.mjs` — inspected and deliberately left unchanged.
  The export consumes exactly what collection already persists: the
  `resource_version` rows and the per-type `coverage_digest` entries (outcome,
  itemCount, per-type started/completed times). Nothing the export needs was
  missing, so no production behavior was touched and the collect test suite
  runs unmodified.

No schema or migration was needed — the export is a read path over existing
tables; legacy-read handling for older coverage digests (bare counts, entries
without windows) is inherited from `readObservation()`, which the manifest
build calls for every type.

## Implementation and proof limitations

- Everything here is fixture-tested against synthetic rows in the isolated
  test database (`engine/test/dbTestHelper.mjs`) and tmp-directory
  filesystems. No live tenant was touched; collector and restorer credentials
  were not used, and Conditional Access is never enforced.
- Local filesystem publication only. Storage layout, retention, offsite
  replication and any remote publication policy belong to WS10 and are
  deliberately out of scope.
- Atomicity rests on `rename(2)` within one filesystem: the staging directory
  and the final directory are siblings under the tenant dir, so the cutover is
  atomic only when the export root is a single local filesystem. A crash
  between the publish rename and the `latest` swap leaves a fully verified
  snapshot directory whose pointer was not advanced — safe (readers keep the
  previous export), and re-exporting the same snapshot id then refuses
  because the directory exists; removing the stranded directory is a manual
  operator action.
- There is no portal/UI surface for exports in this task; the named
  integration is the CLI. The manifest is plain JSON and `readLatestExport()`
  is the seam a future UI task can consume.
- Redaction coverage is exactly the task-51 contract: the six reviewed types
  strip their registered `sensitiveExport` fields; unreviewed types export
  their payloads unchanged (the contract has nothing registered to strip for
  them). Widening review coverage is task-51's follow-up, not this task's.

## Boundary tests

`engine/roadmap/config-export.test.mjs` exercises the production modules
against the isolated test database and tmp trees, including the three required
mutation checks:

- Advancing `latest` before the staged tree is renamed into place: the test
  injects a failure at exactly the staging→final rename of a second export and
  asserts `latest` still names the first, fully verified export — under the
  mutation the pointer would name a snapshot directory that does not exist.
- Skipping the sensitive-field exclusion: fixture payloads carry sentinel
  values for `onPremisesImmutableId`, `employeeId`, `securityIdentifier` and
  `onPremisesSamAccountName`, and every exported file (including the manifest)
  is scanned — under the mutation the sentinels appear in resource bytes.
- Constructing the filename directly from the natural key: hostile natural
  keys (`user:../../escape-marker`, `user:/absolute/evil`, `user:a/b/c`,
  backslash traversal) are exported and every entry under the export root is
  asserted to be exactly the hashed layout — under the mutation a traversal
  file appears outside the type directory.

It also covers the remaining acceptance cases: byte-identical resource files
across snapshots whose only differences are collection times (with volatile
times present in the manifest only); partial/failed/not-requested types as
explicit unknown/missing with complete-empty as a genuine empty listing;
deletion representable only within a complete enumeration (and a digest/row
count mismatch aborting the export); checksum, tenant-pin, unsafe-filename and
missing-file verification failures; symlink rejection with nothing written
through; tenant-scoped snapshot resolution refusing foreign and still-running
snapshots; and the CLI end-to-end (latest-snapshot export, foreign snapshot
refusal, required `--export-root`, client teardown).
