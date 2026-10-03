# Measured schedule load warnings (roadmap task-110)

Workstream WS1. Depends on task-49 (tier scoping), task-77 (event envelope),
task-43 (scheduler) and task-44 (schedule editor).

## Status

### 2026-10-03: shipped (fixture-tested; no live tenant measurements yet)

**What is measured.**

- The Graph reader (`tools/tenant-probe/graph.mjs`) already counted every HTTP
  request it sent and every 429/503 back-off it was given. The collector
  (`engine/collect/entraAdapter.mjs`, `collectWithOutcomes`) now records the
  per-type difference in each coverage-digest entry as `requests` and
  `throttles`, beside `itemCount` and `pagesCompleted`.
- A reader without counters (test fakes, and every snapshot written before this
  change) leaves the fields out. That type is **unmeasured**, never "zero
  requests".
- `engine/telemetry/events.mjs` adds two helpers:
  - `graphRequestObservation(entry)` reads one type's measured cost and rejects
    missing or malformed counts (negative, or more throttles than requests).
    `itemCount` is a resource count and is never used as a request count.
  - `collectionCostMetrics(digest)` gives the run totals as `graphRequests` and
    `graphThrottles`, the capture-cost names the task-77 envelope already
    allows. If any requested type is unmeasured, the totals are `null`.

**How the forecast is built** (`engine/schedules/forecast.mjs`).

- Observations come from terminal `collect` and `backup` jobs (both run the same
  collector), finished within the sample window (14 days).
- **Finding the snapshot.** A job's snapshot is read from `result.snapshotId` or
  the CLI's `snapshot <id> complete` line, as `completions.mjs` does. It is never
  "the latest snapshot".
- **Tenant scope.** A snapshot counts only if it belongs to this tenant. A job
  that names another tenant is ignored. A job that names no tenant counts only
  through a snapshot of this tenant.
- **One query each.** Jobs are read in one query and snapshots in one more.
- **Grouping.** Runs are grouped by kind and tier (`collect:tier1`, …). Each group
  has a breakdown by workload, taken from the endpoint root: `intune` for
  `/deviceManagement` and `/deviceAppManagement`, `identity-governance`, and
  `directory`. Graph throttles each service separately.
- **Per group:**
  - measured and unmeasured run counts;
  - the sample window and the first and last sample;
  - requests per run (median, 90th percentile, max);
  - the share of requests that were throttled, and how many runs were throttled;
  - duration (median, 90th percentile, from `started_at`/`finished_at`).
- **Per collect schedule** (`forecastSchedule`): runs a day and the shortest gap,
  from the schedule's own cadence or cron, and then:
  - **Fewer than 3 measured runs** → `status: "unknown"` (`no-samples` or
    `insufficient-samples`). There is then no estimate, no confidence, no
    warning and no proposal.
  - **Otherwise** → the projected requests a day (90th-percentile requests per
    run × runs a day), with confidence low (3–9 runs), medium (10–29) or high
    (30 or more).
  - **`throttle-heavy`** when at least 2% of requests were throttled, or at least
    half the runs saw throttling.
  - **`overlap`** when the 90th-percentile duration reaches 80% of the gap
    between runs (the collection lock would then defer the next run).
  - **Proposal** (`proposeCadence`): a slower structured cadence, rounded up to
    whole hours, days or weeks.
    - It is never faster than the current cadence, never below the job kind's
      floor (`MINIMUM_INTERVAL_MS`) and never slower than one week.
    - It passes through `validateSchedule()`, like any save.
    - `cappedAtMaximum` and `unchanged` say when even a weekly cadence would
      not clear the warning.
- **Every forecast is labelled.** It carries `advisory: true` and
  `guarantee: false`. Prune, off-site copy and Microsoft API check schedules do
  not call Graph and get no forecast.
- **Business hours (display only).** `businessHoursPresentation` converts the
  next five UTC runs to a time zone with `Intl`. Business hours are Monday to
  Friday, 08:00–18:00. The time zone comes from `KEEL_BUSINESS_TIME_ZONE`
  (default UTC), and an unknown zone falls back to UTC and says so. Scheduling
  stays UTC: nothing here writes `next_due_at`, and the result is labelled
  `scheduling: "UTC"`.

**Acknowledging a warning (the advisory override).**

- **What it does.** `acknowledgeForecastWarning` records who accepted which
  warning codes, when, and for which cadence, in the new nullable
  `schedule.forecast_acknowledgement` column.
- **Migration.** The column is added by `ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
  is additive and is safe to re-apply. On existing rows it is NULL, which reads
  as "not acknowledged". A malformed stored value also reads as none
  (`readAcknowledgement`).
- **Grant.** It needs the `configuration` grant, checked at the wall clock at the
  moment of the call. A caller-supplied instant cannot revive a revoked grant.
  Reading forecasts likewise re-checks `read` in the engine.
- **Current warnings only.** It accepts only codes the forecast raises right now
  (`forecast_warning_not_current` otherwise), and only for a schedule of this
  tenant.
- **What it never changes.** It does not touch `cadence`, `cron_override`,
  `enabled` or `next_due_at`. An acknowledged warning stays listed (marked
  accepted) and only stops driving the page verdict.
- **Voiding.** The acknowledgement is void as soon as the cadence or cron
  changes, because it stores the cadence key.
- **The floor is untouched.** `validateSchedule()` still runs on every save
  (`updateSchedule`, the portal route). The scheduler's runtime check still runs
  on every tick: `validateSchedule` in `tick`, and again inside `nextDueAt`.
  Neither reads the acknowledgement.

**Portal.**

- `GET /api/schedules` returns `forecasts` beside the schedules.
- `POST /api/schedules` with exactly `{ id, acknowledgeForecast: [codes] }`
  records an acknowledgement. It goes through the existing
  `schedules:update` / `configuration` guard and its audit-attempt record, so
  the closed route inventory is unchanged.
- **Schedules page, "Load on Microsoft" column** (it stays a Protect tab):
  - "About 1,464 Microsoft requests a day, from runs in the last 14 days."
  - Warnings as sentences, e.g. "Microsoft slowed down 6.4% of its requests …"
    or "A slow run takes 20 hours, close to the 24 hours between runs."
  - The suggestion, e.g. "Suggested: every 2 hours."
  - Who accepted a warning, by email.
  - The business-hours sentence.
  - The caveat "An estimate from past runs, not a promise that Microsoft will
    not slow KEEL down."
  - "Accept warning" for configuration principals.
- **Verdict.** "Backup of Tier 1 puts heavy load on Microsoft; a slower schedule
  is suggested." It is used when an enabled schedule has an open warning and no
  schedule failed its last run.
- **Record layer.** Status and reason codes, sample counts and window,
  confidence, requests per run, projection arithmetic, throttle share, duration
  in milliseconds, per-workload JSON, warning codes, the proposed cadence JSON
  with its interval and floor, the acknowledging principal ID, and every
  upcoming run as UTC with its local time.
- **Harness.** The UI-harness route `schedules` shows an open throttle warning,
  an accepted overlap warning and an unknown tier. Its record-ID list now
  includes the acknowledging principal and the warning codes, and the allowlist
  stays empty.

**Tests.**

- `engine/roadmap/schedule-forecast.test.mjs` (8 tests) runs against:
  - the real collector, with a counting reader;
  - an isolated database (real `job`, `snapshot`, `schedule` and `role_grant`
    rows);
  - the real `can()`, `updateSchedule()` and scheduler `tick()`.

  It covers:
  - tier-scoped counts, with other tiers and another tenant excluded (by job
    and by snapshot);
  - no samples, legacy unmeasured runs and too few runs → unknown;
  - throttle-heavy and overlap warnings, the weekly cap, a calm history with no
    warning;
  - acknowledgement authorization, current-only codes, other-tenant refusal,
    cadence untouched, floor on save, floor on tick, voiding on cadence change,
    revoked grant;
  - legacy-read of a malformed acknowledgement.

  The suite is added to the CI engine step in `.github/workflows/portal.yml`.
- `portal/test/schedules.test.ts` gains an end-to-end API test: forecasts in
  `GET`, the 403/400/404/200 acknowledgement paths, unchanged cadence,
  verdict precedence, and the floor after acceptance.

**Required mutation checks** (each applied, run against the new suite, then
reverted):

| Mutation | Result |
| --- | --- |
| Use resource count as request count (`graphRequestObservation` reads `itemCount`) | 3 tests fail |
| Invent estimate without samples: unmeasured counters read as zero-cost runs | 2 tests fail |
| Invent estimate without samples: minimum sample count lowered to 1 | 1 test fails |
| Disable runtime floor after accepting warning: `validateSchedule` returns early for acknowledged rows | 1 test fails |
| Disable runtime floor after accepting warning: scheduler `tick` skips both of its floor checks for acknowledged rows | 1 test fails |
| Scheduler `tick` skips only its first `validateSchedule` call | survives, by design: `nextDueAt()` re-validates the floor, so the tick still refuses and enqueues nothing. The floor is not actually disabled. |

**Limits and decisions:**

- **No live measurements yet.** Snapshots collected before this change carry no
  counters, so every forecast reads "unknown" until three measured runs of a
  tier exist on the real tenant. The thresholds (2% throttled, half the runs
  throttled, 80% overlap, 3 / 10 / 30 runs) are engineering defaults chosen
  without live data. They are constants in `forecast.mjs`.
- **Microsoft documentation not retrieved.** Global Constraint 8 asks for the
  current official throttling documentation
  (https://learn.microsoft.com/en-us/graph/throttling and
  https://learn.microsoft.com/en-us/graph/throttling-limits). In the build
  container on 2026-10-03, `learn.microsoft.com` was blocked by the egress
  proxy. KEEL therefore publishes no per-service request budget and does not
  claim one. Warnings come only from observed throttling and duration. The
  workload split follows Graph's per-service throttling as documented
  previously, and must be re-checked against the current page before any
  budget-based warning is added.
- **503 counts as a throttle.** The reader counts both 429 and 503 as throttled,
  because both carry Retry-After back-off. The share therefore includes
  service-unavailable responses.
- **Duration is the whole job.** It includes waiting for Retry-After, process
  start-up and database writes, not only Graph time.
- **Full runs are kept apart.** An untiered `collect` job (full collection)
  is grouped as `collect:all` and never feeds a tier's forecast. `backup` jobs
  without a tier default to Tier 1, as the worker does.
- **No automatic cadence change.** A proposal is shown, not applied. Changing
  the cadence is the existing "Change schedule" editor, under the floor.
