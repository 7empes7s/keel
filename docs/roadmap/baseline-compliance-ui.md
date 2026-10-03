# Baseline age, compliance views and linked findings (task 87)

Date: 2026-10-03 UTC. Status: implemented, fixture-tested only. No live tenant
evidence, regulatory certification or storage qualification is claimed.

## What was built

### Baseline capture and versions (`engine/govern/baseline.mjs`, `engine/store/schema.sql`)

- **Capture recorded at seed.** `seedFromSnapshot` now stores the source snapshot
  (`source_snapshot_id`), the time it finished (`captured_at`) and what it covered
  (`observation_scope`: the collection window and the types read completely).
- **Age comes from the capture.** A baseline's age is `now − captured_at`. It never
  comes from `set_at` or the time the page was read.
- **Re-snapshot is a new version.** `resnapshotBaseline` creates a new baseline row:
  `version + 1`, with `supersedes_id` naming the old row. It takes the old version's
  active flag and label (`Golden state` → `Golden state (v2)`).
- **The old version is preserved.** Its row and every `baseline_resource` row it holds
  are untouched. It only gains `superseded_at`, and loses `active` if it was active.
- **Superseded versions are read-only history.** `acceptDrift` refuses a change into a
  superseded version, and `activateBaseline` refuses to activate one.
- **Refused re-snapshots:**
  - a version that has already been re-snapshotted;
  - the same source collection;
  - a collection that is not newer than the capture it would replace;
  - any snapshot that is not an eligible whole-estate source (the existing rule).
- **Audit record.** Each re-snapshot appends a `baseline-resnapshot` evidence record
  with the new and old IDs, the version, the source snapshot and the preserved resource
  count.
- **Authorization at the write.** `replaceBaseline` checks that the requester holds
  `baseline-create` at the moment of the write, then re-snapshots. It runs through the
  existing `baseline-create` job kind: the portal route and the worker check the same
  capability (`engine/authz/jobCapabilities.mjs`), so a read-only viewer is refused at
  all three points. The CLI is `keel-baseline-create.mjs --snapshot-id ID --supersedes
  BASELINE_ID --set-by PRINCIPAL`. The worker passes `params.supersedesBaselineId`
  through, and `POST /api/actions/baseline` accepts `{ snapshotId, supersedesBaselineId }`.

### Compliance reader (`engine/govern/baselineCompliance.mjs`)

- **`baselineCompliance` returns, for every baseline:**
  - its capture: basis, captured at, age, source snapshot, window and types;
  - its version chain;
  - its changes since capture.
- **How changes are counted.** The baseline's resources are compared with the newest
  whole-estate collection through `diffSnapshots`, the same canonical-hash diff drift
  detection uses.
  - A cosmetic-only change hashes the same and counts as zero. That covers fields
    Microsoft sets itself, and key order.
  - When the two sides were hashed under different versions, the result is "not
    comparable" rather than a guess.
- **`complianceFindings` reads the newest evaluation of each control** (task-85
  `benchmark_evaluation`). The finding's evidence is the snapshot whose observation of
  each required type covers exactly the evaluation's recorded window. Records rest on
  "the same collection" only when they sit on such a snapshot. Against that evidence:
  - **Backup.** It is linked when every window matches a stored collection, and shown
    as a mismatch otherwise.
  - **Changes.** Open drift on the same types is linked only when it was observed in
    the evidence snapshot. Drift from any other collection is listed as mismatched, and
    is never joined.
  - **Pending restore plans.** A plan counts when it has a pending, unexpired `restore`
    approval request whose dry run touches the same types. Its snapshot decides linked
    or mismatched in the same way.
- **Exceptions.** An exception is authorized only with an owner, a reason and an expiry
  that has not passed.
  - Expired → the finding is exposed, and the exception (owner, expiry) is still shown.
  - No owner or no expiry, which covers every exception recorded before task-87 →
    "incomplete", and the finding stays exposed.
  - The stored verdict is never changed.
- **`grantComplianceException` writes new exceptions.** It requires `configuration`, an
  owner, a reason and a future expiry. It writes through `recordException`, which now
  takes an optional `owner`.
- **`storageResidency` reports where backups are configured to be stored.** It reads
  this from the recovery manifest's `residency`, written by `ops/keel-dump-manifest.mjs
  --recovery`.
  - Local disk reports "cannot lock against deletion" (its capability ceiling).
  - Any other provider is "not yet proven" without a qualification verdict.
  - `certifies` is always `null`: this is a configuration statement, not a
    certification of regulatory compliance.

### Portal

- **Compliance** (`/benchmarks`, a tab under Changes, read access).
  - Verdict, for example: "1 control fails, including one whose exception expired."
  - The active baseline with its capture age and changes since.
  - One card per control, failing first. Each card has the exception in words ("The
    exception owned by … expired 2 days ago, so this finding is open again."), the
    backup it was checked against, linked and mismatched changes and pending restores in
    words, and links to Changes and Approvals.
  - The storage location, with "This states where backups are kept. It is not a
    certification of compliance with any regulation."
  - Evaluation, control, exception, drift, dry-run, approval and snapshot IDs, windows,
    codes and the manifest path are in each card's Technical details.
- **Baselines.**
  - The verdict and the "Captured" column use the capture age. The scope reads "From one
    complete backup, covering 6 configuration types." Changes since capture are in
    words, and the state reads "Active", "Not active" or "Replaced by a newer version".
  - Each current version offers "Capture new version" from the newest eligible backup.
    The control is disabled without `baseline-create`, and when no newer backup exists.
  - The version chain, source snapshot, window, types and comparison are in the record.
- **Configuration.** `KEEL_RECOVERY_MANIFEST_PATH` names the recovery manifest. When it
  is unset or unreadable, the page says the location is not configured.
- **UI harness.**
  - `benchmarks` is a new route covering every finding state: expired exception,
    current exception, could not be checked, and pass with an unmatched collection.
  - The baselines fixtures add a superseded legacy version.
  - Both routes pass the contract's checks 1 to 7 and axe in both themes. The
    allowlist stays empty.

## Migration and legacy reads

- **All schema changes are additive and retry-safe** (`ADD COLUMN IF NOT EXISTS`):
  - on `baseline`: `source_snapshot_id`, `captured_at`, `observation_scope`, `version`
    (default 1), `supersedes_id`, `superseded_at`;
  - a partial unique index so that a version is superseded at most once;
  - `benchmark_exception.owner`.
- **Legacy baselines** have no capture columns. Their capture is read from the
  snapshots their resources came from: the window between the first and the last, with
  the age from the last (basis `legacy-resource-versions`, shown as "read from the
  backups its resources came from"). A legacy baseline with no resources has an unknown
  age, never one filled in from the time of reading.
- **Legacy exceptions** have no owner, and may have no expiry. They read as
  "incomplete" and never hide a finding. Task-85's `effectiveVerdict` is unchanged for
  its own callers.

## Validation

- **Boundary tests.** `engine/roadmap/baseline-compliance-ui.test.mjs` runs against an
  isolated test database and the portal runtime, and covers:
  - re-snapshot preservation and refusals;
  - viewer refusal at the engine and at the action route (403, no job queued);
  - capture-based age for seeded, legacy and empty baselines;
  - cosmetic-only zero drift against a real change;
  - linked and mismatched changes and restore plans, and an unmatched evidence window;
  - authorized, expired and incomplete exceptions;
  - storage residency;
  - the rendered Compliance and Baselines pages, kept to plain words outside the record.
- The test is added to the CI engine step in `.github/workflows/portal.yml`.

Required mutation checks, each run and reverted:

| Mutation | Fails |
|---|---|
| Re-snapshot overwrites the previous baseline's resources in place | "re-snapshot preserves the old version and its evidence" |
| Expired exception hidden (state `none`, no exception shown) | "an expired exception exposes the finding …" and the portal render |
| Every same-type change and plan linked regardless of collection | "findings link only to records resting on the same collection" and the portal render |

## Limits and decisions

- **No live evidence.** Everything is fixture-tested. No tenant was read or written.
  Control evaluations still come only from callers of `evaluateControl` (task-85); no
  scheduled evaluation job is added here.
- **Matching is by exact observation window.** Evaluations record each observation's
  window, not a snapshot ID, so a finding's evidence is matched to the snapshot whose
  observation of that type has exactly that window. An evaluation built from evidence
  no stored snapshot reproduces is shown as a mismatch, never approximated.
- **Changes since capture use the newest whole-estate collection.** A newer partial or
  tier-scoped collection is not used, so the count is never built from partial
  coverage.
- **The exception grant has no portal form.** `grantComplianceException` is the server
  seam, and the page shows exceptions but does not create them. Adding a form and an
  API route is a separate decision, because it changes who may hide a finding.
- **Storage residency is read from one manifest file.** It is what the operator
  configured, not something observed. A qualification verdict
  (`engine/storage/qualification.mjs`) is not persisted anywhere today, so non-local
  providers read "not yet proven". This matches the 2026-09-30 decision that storage
  immutability stays unqualified for the nucleus release.
- **The page sits under Changes** (route `/benchmarks`, labelled "Compliance"), because
  findings are measured against the baseline. The navigation stays at seven entries.
