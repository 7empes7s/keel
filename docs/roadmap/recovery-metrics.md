# Measured freshness, recovery time and the Resilience page (task-73, WS10)

Date: 2026-10-03 UTC. Status: implemented, fixture-tested only. No live tenant
data was read, no off-site copy was recorded on the VPS and no drill was run.
Until the operator records verified off-site copies and runs a drill (task-72),
the managed tenant's recovery point and recovery time read "Not measured".

## What was built

- `engine/coverage/recoveryMetrics.mjs` (new): the tenant-scoped reader
  `loadRecoveryMetrics(client, { tenantRef, requiredTypes, now })` and the pure
  functions behind it. It returns four measurements, kept apart:
  - **Freshness (achieved RPO).**
    - Required dependencies are every collected configuration type (the collector
      descriptors) plus every relationship family KEEL has read for this tenant. A
      family seen only as `unsupported` is not required.
    - A type's observation succeeds by the coverage report's own rule
      (`readCoverageOutcome`), in a completed snapshot. A `not-requested` entry is
      not an observation.
    - A relationship family's observation in one snapshot succeeds only when every
      non-unsupported edge-set read of that family completed.
    - Age is measured from the start of the observation window (the conservative
      end), and the oldest required dependency decides it.
    - A failed or partial latest collection never moves the age forward: the last
      success stands, and the failure is listed with it (`latestFailures`).
    - A dependency with no success at all is a gap. While any gap exists the
      achieved RPO is `null` (state `gaps`), not the age of the others.
  - **Recoverable point.**
    - Read from `offsite-copy` evidence. A copy counts only when its recovery
      manifest verified, its remote checksum equals the dump checksum, it carries a
      shipped instant and it lists observations.
    - The copy's point is the oldest window start among the successful
      observations it holds for each required dependency. Types come from the
      manifest's observation IDs. Relationship families come from the edge sets of
      the snapshots those IDs name.
    - A copy missing any required dependency does not count, however new it is, and
      it is listed with what it lacks. The recoverable point is the newest point
      among counted copies.
  - **Recovery time (achieved RTO).** Samples come only from verified history:
    - recovery drills that task-72's `classifyDrillRecord` counts (live, bounded,
      passed, cleanup complete, observed timing);
    - enforced restore jobs (`mode: 'enforce'` or the legacy artifact-only
      promotion) that `succeeded`, belong to this tenant through their dry-run
      plan's `tenant_ref`, are not undo plans, and whose recovery completion items
      (task-65) are all verified. Duration runs from the job's start to the later
      of its finish and the last item's verification.

    Failed, cancelled, offline, exceeded and unverified attempts are listed with
    their reason and never become samples. The reader reports latest, slowest and
    median, and no samples is `unmeasured`.
  - **Configured.** The collect, backup and off-site schedules, labelled as
    configuration. They are never used as a measured value. KEEL stores no
    recovery objective, so `objectives` is `null` and the page says no target is
    set.

  The reader also returns task-72's recovery readiness unchanged.
- `engine/coverage/offsiteCopy.mjs` (new): `recordOffsiteCopy()`.
  - It verifies the recovery manifest itself with task-67's
    `verifyRecoveryManifest`, pinned to the tenant, and never trusts a caller's
    verdict.
  - It appends `offsite-copy` evidence in both cases, so a failed copy is visible
    rather than missing.
  - It is a separate module because the portal must not bundle the manifest
    verifier, which reads files and git.
- `cli/keel-recovery-metrics.mjs` (new):
  - `report` prints the metrics as JSON.
  - `record-offsite` verifies and records one off-site copy. It takes the manifest,
    the remote checksum, the shipped time, the actor and the verification inputs,
    and exits 1 when the copy does not count.
- **Portal.**
  - The `/resilience` page is a tab of Restore (`NAV_MAP`; read-gated) and is
    guarded by `DATA_SURFACES.resiliencePage` before any loader runs.
  - `getResilienceData()` in `portal/lib/portal-data.ts` calls the engine reader,
    lists open incidents with their recommended (investigator-cleared) snapshot
    and active retention pins (task-71), and reads storage immutability through
    the existing `storageResidency` (task-69/87).
  - The words come from `portal/lib/resilience-view.ts` and the cards from
    `portal/components/resilience-view.tsx`.
  - The page has one verdict sentence and six cards: how recent the backups are,
    the recovery point, how long a recovery takes, recovery drills, incidents, and
    where backups are kept. Each card carries a state pill and a "Technical
    details" record. The record holds achieved values in milliseconds, dependency
    keys, evidence sequences, job IDs (with `GET /api/jobs/<id>`), dump checksums,
    schedule IDs, incident and snapshot IDs, the recovery manifest path, the tenant
    reference and the CLI to reproduce the numbers.
  - The page links to failed restores' job pages, the incident page and Activity.
  - The new `offsite-copy` evidence kind is in the display map and the Activity
    sentences.

No schema migration was needed: off-site copies use the existing `evidence`
table (`tenant_ref` scoped), and every other input is an existing table. There
is no legacy off-site record to read: `ops/keel-offsite.sh` keeps only a local
`keel-db-shipped-manifest.json` and job stdout, and neither is read as a
verified copy.

## Implementation and proof limitations

- **Nothing records off-site copies on the VPS yet.** `ops/keel-offsite.sh` ships
  the nightly dump and checks its remote checksum, but it does not build a task-67
  recovery manifest (that needs the configuration export and observation IDs).
  It was not changed here because it is deployed operations. Until the operator
  adds a `keel-recovery-metrics.mjs record-offsite` step after a verified ship,
  the recovery point stays "Not measured". This is reported, not worked around.
- **Fixture-tested only.** Tests use the isolated test database, real snapshots,
  edge sets, restore plans, jobs and completion items, and one real recovery
  manifest verified against its export and dump bytes. No live tenant object,
  credential or off-site host was touched.
- **The recovery point is not a tenant-wide atomic image.** It is the oldest
  per-type window start in the copy. Types were collected at different times
  (Global Constraint 6).
- **A restore's recovery time covers KEEL's part only.** It runs from job start to
  the last completion item's verification. It does not include the time before
  someone requested the restore, and it is not an RTO for a whole-tenant incident.
  Drills measure one disposable group (task-72).
- **No recovery objective store.** No objective is invented. Comparing against a
  target needs an operator decision on where objectives live.
- **The success test is a little strict for older rows.** The newest-success query
  keeps entries whose stored shape is a success with a numeric `itemCount`, or a
  legacy positive count. A rare malformed newer "success" makes that type read as
  having no success, rather than falling back to an older one. This errs towards
  "older" and never "fresher".

## Boundary tests and mutation checks

`engine/roadmap/recovery-metrics.test.mjs` (8 tests, in the CI engine step):

- A failed or partial latest collection, a not-requested entry and an unfinished
  run never improve the RPO.
- The oldest relationship family decides the age; a partial newer read does not
  refresh it; a never-read type is a gap and nulls the RPO.
- Schedules are reported but never become the achieved RPO.
- A newer copy lacking a required type and relationship does not advance the
  recoverable point. Checksum-mismatch, failed-verification and foreign-tenant
  copies do not count.
- A real manifest is verified against its bytes through the CLI, a tampered dump
  is recorded and not counted, and a manifest pinned to another tenant is refused.
- Failed, offline and dirty drills, failed, cancelled and unverified restores,
  undo dry runs and another tenant's restore never become recovery time samples;
  a restore counts once its items are verified.
- An empty tenant reads unmeasured everywhere through the CLI.
- Foreign rows never count and raw tenant IDs are refused.

`portal/test/resilience-view.test.ts` drives the view with the engine's own
computations. `portal/test/read-page-auth.test.ts` covers `/resilience`
refusals. The UI harness adds the `resilience` and `resilience-unmeasured` routes
to the contract, axe and interaction checks (the allowlist stays empty).

Required mutation checks, each confirmed to fail a test and reverted
(2026-10-03):

| Mutation | Where | Result |
| --- | --- | --- |
| Use configured schedule as achieved RPO | the reader's freshness capped or replaced by an hourly collect schedule | `configured cadence …` fails |
| Count failed restore as successful timing | `classifyRestoreJob` status check removed | `a failed drill or failed restore …` fails |
| Hide unmeasured state | engine: recovery time always `measured`; view: verdict ignores unmeasured time; card pill always "Measured" | engine `no samples …`, portal `a measured point with no timed recovery …`, and the harness `resilience shows …` each fail |

## Validation notes (2026-10-03)

- The Validate command (with `KEEL_DB_TEST_URL` and `KEEL_TENANT_CONFIG_PATH`
  exported, since this container has no `/etc/keel/db.env`) passed, as did
  `portal` typecheck, `npm test`, `npm run build`, `npm run test:ui` and the CI
  engine suites.
- One run hit the known `engine/authz/administration.test.mjs` millisecond flake
  recorded in `drill-harness.md` (authz scope, unchanged). Six further runs were
  clean.
