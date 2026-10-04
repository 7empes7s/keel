# Verified outcome and executive value reporting (task-100, WS6)

Date: 2026-10-04 UTC. Status: implemented, fixture-tested only. No live tenant data
was read and no tenant was written. Nothing in this report is a statement of
compliance with any regulation or framework.

## What was built

- `engine/reports/value.mjs` (new): the tenant-scoped reader
  `loadValueReport(client, { tenantRef, from, to, scope, estimate, now })`, the pure
  classifiers behind it, and `valueReportCsv(report)`. It reports one period (at most
  366 days, never past "now") in three parts.
  - **Remediation outcomes.** One outcome is one thing KEEL was asked to put back:
    - a forward restore plan promoted by enforced `restore` jobs (identity
      `restore-plan:<plan id>`). Dry-run jobs and undo (compensation) runs are not
      outcomes; undo runs are counted separately as "not counted".
    - a detected change remediated by `remediate` jobs (identity
      `change:<drift id>`). One job naming several changes is several outcomes.

    Each job is one **attempt**, named by its task-77 correlation id `job:<id>`. That
    id survives an orphan re-claim, so a re-claimed job is still one attempt. Further
    jobs for the same plan or change are **retries**: they add attempts, never
    outcomes. Every outcome sits in exactly one state, so the states always add up to
    the total, and `retries = attempts − outcomes`:
    - `verified`: a job succeeded **and** the result was checked independently of the
      job.
      - A restore plan needs the write journal's newest entry for every resource it
        wrote to be `succeeded` (written and read back; a retry's newer entry replaces
        an earlier failed one) and every completion item (task-65) to be verified.
        It is verified at the latest of the job's finish, the journal outcomes and the
        item closures.
      - A remediated change needs a complete collection, finished after the first
        successful attempt, to show the resource back at its baseline hash (same hash
        version), or absent for an added resource while its type was read completely.
    - `reopened`: it was verified by a collection, then a newer collection showed it
      different again.
    - `unconfirmed`: a job succeeded but nothing has verified it. The reasons are:
      no journal record, a write that did not confirm, open completion items, no
      later collection, the collection still differs, or a hash-version change.
    - `queued`: an attempt is waiting or running and none has succeeded.
    - `failed`: every attempt failed or was cancelled.

    A queued, running, failed or cancelled job is never verified. A job that finished
    after the period ended counts as still running at its end. A verified outcome
    belongs to the period it was verified in, so two adjacent periods never both
    count it. Any other outcome belongs to a period in which something happened to it,
    and a queued one stays visible until it resolves.
  - **Control findings** (task-85 evaluations, task-87 compliance).
    - Evaluations are grouped by framework, edition, profile, control and evaluator
      version, so an edition change is never read as a fix.
    - A control that never failed is not a finding.
    - A finding is `resolved` when its newest evaluation passes after a failure. It
      counts in the period of the first pass after the last failure. Repeated passes
      do not count again; the identity is the resolving evaluation id and its
      evidence sequence.
    - Fail, pass, then fail again is `open` and flagged reopened. It is not resolved.
    - `unknown` or `not-applicable` after a fail is `unchecked`.
    - An exception never resolves a finding.
  - **Measured recovery** comes straight from task-73's `loadRecoveryMetrics`:
    recovery-time samples in the period (median, slowest, not-counted tries) and the
    freshness and recoverable point at the period's end. Nothing configured stands in
    for a measurement.
- **Hours saved** appear only from a configured estimate:
  - The estimate is `{ minutesPerVerifiedOutcome: { restore?, remediation?, finding? },
    assumptions: [...], owner, setAt? }`.
  - It needs at least one valid minutes value (more than 0, at most 2400), at least
    one non-empty written assumption, and an owner. Anything else is `invalid` and is
    listed with its problems.
  - Hours multiply verified outcomes and resolved findings only, never attempts.
  - Without a valid estimate `hoursSaved` is `null`, the CSV has no hours line and
    the page says no estimate is set.
  - The report carries the assumptions, owner and date next to the figure.
- **Scope** (task-90).
  - A central reader sees the whole tenant.
  - An entity-scoped reader, or a central reader who picks one entity, sees:
    - a restore plan only when every resource it covers resolves through lineage and
      current ownership evidence to one of their entities;
    - a remediated change when its resource does.

    Anything unattributable is central-only. Control findings and recovery cover the
    whole tenant, so they are withheld (`{ withheld: true }`) from a scoped report
    rather than shown partly. An entity outside a scoped reader's scope gives an empty
    report, never a wider one.
- **Export provenance.** Every report carries:
  - its version, the period and the scope;
  - the counting rules;
  - the rows read per source and whether every source fitted the read bound
    (`complete`; 20,000 rows per source);
  - the tenant's evidence-chain head (sequence, hash, count) at generation;
  - a SHA-256 digest of the report's canonical JSON, without the generation time;
  - `complianceClaim: null`.

  Tables are capped at 50 rows. Totals always count every row, and the page says how
  many are shown.
- `cli/keel-value-report.mjs` (new): `--from/--to/--days`, `--format json|csv`,
  `--entity CODE` (repeatable), and `--estimate PATH` (or
  `KEEL_VALUE_ESTIMATE_PATH`). It is read-only.
- **Portal.**
  - `/reports` ("Value report") is a tab of Activity in `NAV_MAP`, read-gated, and
    guarded by `DATA_SURFACES.reportsPage` before any loader. It is `entityScoped`:
    the engine applies the scope before counting.
  - `GET /api/reports/value?period=30d|90d|365d&format=csv|json[&entity=CODE]`
    (`DATA_SURFACES.valueReportApi`) downloads the same report as a file.
  - The words are in `portal/lib/value-report-view.ts`, the server loader in
    `portal/lib/value-report.ts`, and the cards in
    `portal/components/value-report-view.tsx`. The styles are scoped to that
    component; `globals.css` is unchanged.
  - The page has one verdict and five cards:
    - settings put back: a state by family table that adds up, with a capped
      per-request table;
    - control findings;
    - recovery measured;
    - time saved, or why there is none;
    - how this was counted, with the no-compliance statement.
  - Ids, event ids, evaluation ids, the digest, the evidence head, the estimate path
    and the tenant reference are under "Technical details".
  - Adding the tab gives Activity a tab bar, so the `job-failed` and
    `job-restore-completion` screenshot baselines were updated (tab bar only).

No schema migration was needed: every input is an existing table (`job`,
`restore_dry_run`, `rollback_entry`, `recovery_completion_item`, `drift`,
`baseline_resource`, `resource_version`, `snapshot`, `benchmark_evaluation`,
`evidence_head`, the task-89/90 ownership tables). Legacy rows read conservatively:

- a restore whose journal rows predate task-70 (no `restore_ref`) is `unconfirmed`
  (no journal record), never verified;
- jobs without an attempt counter are still one attempt per row;
- evaluations without an evidence sequence keep their evaluation id as the identity.

## Implementation and proof limitations

- **Fixture-tested only.** No live tenant, credential or Microsoft endpoint was
  touched. Verification depends on later collections and the write journal that
  real runs produce.
- **A remediated change needs a later collection.** Until the next complete
  collection reads the resource's type, a successful remediation stays
  "unconfirmed". This is deliberate: success of the job is not proof.
- **A restore with no journal entries** is unconfirmed. This includes one that
  succeeded with nothing to write. It is not counted as value.
- **The job queue's current status is used for a past period.** A job that finished
  after `to` reads as running, but a job cancelled after `to` while queued cannot be
  told apart and reads as cancelled. This affects only the "queued" and "failed"
  states, never verified.
- **Reopening is detected for remediated changes only.** A verified restore plan is
  not compared against later collections (the plan names natural keys, not baseline
  hashes); a later drift on the same resource shows up as a new change.
- **Recovery-time samples are measurements, not outcomes.** They come unchanged from
  task-73, which counts each verified restore job, including a second successful run
  of the same plan.
- **Hours are an operator estimate.** KEEL measures no time saved; the figure is only
  as good as the assumptions shown beside it.
- **Read bounds.** Each source reads at most 20,000 rows and at most 500 collections
  for verification. Beyond that the report says it is incomplete rather than
  extrapolating.
- **Entity scope for restore plans** requires every resource of the plan to be
  attributable. A plan whose resources cannot all be resolved is central-only.

## Boundary tests and mutation checks

`engine/roadmap/value-reports.test.mjs` (7 tests, in the CI engine step):

- A retried restore (failed, then succeeded and verified) and a retried remediation
  each count once. A re-claimed job is one attempt. One job covering two changes is
  two outcomes.
- Queued, running, failed, cancelled, unconfirmed (uncertain write, no journal, open
  completion item), dry-run and undo jobs never become verified. Neither does a
  remediation with no later collection, a still-different collection, a hash-version
  change, a partly read type, or a collection taken before the job finished. A job
  that finished after the period counts as still running at its end.
- A remediated change that comes back is reopened. A report that ended before it came
  back still shows it verified. Fail, pass, fail is open and reopened; an
  undecided evaluation after a fail is unchecked; an edition change is not a fix; repeated passes resolve
  once.
- No estimate gives no hours anywhere (JSON or CSV). Six kinds of incomplete estimate
  give no hours. A configured estimate multiplies verified outcomes only and shows
  its assumptions.
- States add up to totals, families add up to the whole, percentages are verified
  over total, and adjacent periods count each verified outcome once. Foreign-tenant
  rows never join. The CSV matches the JSON. Provenance includes the evidence head
  and digest. Periods are validated, and a raw tenant id is refused.
- An entity-scoped reader sees only the plan wholly inside their entity; findings and
  recovery are withheld; an empty scope sees nothing.
- Recovery samples come from task-73's metrics, and the CLI prints JSON and CSV.

`portal/test/value-report-view.test.ts` drives the view with the engine's own
classifiers and counters: words, rendered totals, no hours without an estimate,
assumptions next to hours, withheld sections, no ids or codes in visible text, and
scope narrowing. `portal/test/read-page-auth.test.ts` covers `/reports` refusals. The
UI harness adds the `reports` and `reports-scoped` routes to the contract, axe and an
interaction check (the totals add up, hours appear only with an estimate, and nothing
scrolls sideways at phone width). The contract allowlist stays empty.

Required mutation checks, each applied, confirmed to fail a test, and reverted
(2026-10-04):

| Mutation | Where | Result |
| --- | --- | --- |
| Count enqueue as verified repair | `lifecycle()` treats queued or running attempts as succeeded | `queued, running, failed and unconfirmed jobs never inflate …` and `totals, percentages and periods …` fail |
| Count retry as new outcome | restore outcomes grouped per job instead of per plan | `a retried restore and a retried remediation each count once` fails |
| Invent fixed hours per event | `estimateHours()` falls back to 60 minutes per verified result when no estimate is configured | `without a configured estimate there are no hours …` and the CLI test fail |

## Validation (2026-10-04)

- The Validate command was run with the environment from `/etc/keel/db.env`:
  - `node --test engine/roadmap/value-reports.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs`: 12 tests, all passed.
  - `portal`: `npm run typecheck` was clean, and `npm test` passed 156 of 156 after merging master.
    Without the DB environment, the two database-backed portal tests (evidence and
    principals) cannot connect.
- The UI harness was built and `npx playwright test -c ui-harness/playwright.config.ts`
  passed all tests, with the two Activity-tab screenshot pairs updated.
