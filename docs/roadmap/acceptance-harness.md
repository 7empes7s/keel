# Six end-to-end journeys and release qualification ledger (task-112, Release)

Date: 2026-10-04 UTC. Status: implemented and fixture-tested. **Release readiness stays
PENDING.** Every journey passes against local fakes and an isolated database. No live
acceptance record verifies today: nine are `status: "pending"` placeholders, task-123's
record does not exist, and task-119's record cannot be verified without the release
runner key. Nothing was run against the live tenant. No evidence was captured, signed or
edited.

## What was built

- **`tools/release/journeys.mjs`** (new). The six journeys, each driving the production
  modules of its owner tasks with local fakes and an isolated database:

  | Journey | Production path exercised | Terminal outcome the assessor re-reads |
  |---|---|---|
  | J1 onboarding with missing prerequisites (74-76) | `planBootstrap` → `approveBootstrapPlan` → `executeBootstrap` with the task-75 fake identity tenant. The run stops `pending-manual` with no write while the Intune RBAC step is missing, and the first-collect gate names the gaps. After the operator does the step, the first write's acknowledgement is lost (`uncertain`). A retry with a fresh journal completes with no duplicate write. | `firstCollectReadiness` = `read-access-confirmed` |
  | J2 collection → drift → compliance → investigation (47, 62, 87, 99) | Baseline from one collection, a second collection with a changed group. Detection is a `drift-detect` job run through the production worker entry (`claimNext` → `runJob` with the real `JOB_HANDLERS`, so `cli/keel-drift.mjs` runs as a child against the isolated schema, and the requester is re-authorized at execution). Then `baselineCompliance` and `answerQuestion` (structured form). | the investigation answer must name the detected drift with a `change` source |
  | J3 approved emergency deviation (93, 95) | `createChangeIntent` on the emergency drift. `executeAutoRemediation` in the window returns `change-intent-approved` and queues nothing. The owner reverts. A fresh collection is observed, then `settleChangeIntents` at window end. | settlement evidence `currentState` = `matches-baseline` |
  | J4 malicious-change recovery (71, 64, 78) | Incident, compromise interval, assessments: the newest collection is compromised, and the earlier one is cleared with the backdoor group and the defaced field excluded. The compromised point is refused. The first restore leaves the backdoor live, so its post-restore checks fail visibly. After the operator removes it, a fresh dry run and promotion through `runRestore` (fake Graph) pass. | `incident-recovery-check` evidence: non-empty, every check `passed` |
  | J5 partial restore plus human completion (65, 70) | `runRestore` dry run and promotion recreate a group. Completion items open (`configuration-restored`). A completer whose grant was revoked is refused. The current operator closes each item with a ticket reference. | `resourceCompletionState` = `verified-complete` |
  | J6 KEEL reconstruction (67, 68) | Builds an independent dump, configuration export and recovery manifest from the journey tenant's history. An anonymous identity is refused. `reconstructRecovery` then rebuilds into a disposable database. | read-only access session's `evidence_head` equals the manifest checkpoint, and the chain verifies |

  `runJourney` returns a **claim**, never a verdict. `assessJourney` decides. It reads
  the terminal object and every evidence link back from the database through
  tenant-scoped store readers. Nothing the runner reported is used as a state.
  - **Queued is not verified.** A terminal or required link whose state is in
    `UNVERIFIED_STATES` fails before any journey-specific check. That list includes
    `queued`, `running`, `pending`, `pending-manual`, `awaiting-detection`,
    `configuration-restored`, `service-validation-pending` and `unknown`.
  - **Links.** Every link the journey's definition requires must be present. It must
    resolve for the claim's tenant, and point at its parent link (ancestry). For example,
    a check's `artifactId` must equal the restore artifact, the artifact's `incidentId`
    must equal the incident, and a drift's `observed_snapshot` must equal the collection.
  - **Chain.** A link into the evidence chain must match the stored record hash, and
    `verifyChain` must pass for the tenant.

  `runAllJourneys` runs all six. A failing journey never stops the others.
  `journeyFixtureRecord` labels the results `fixture-tested` and `synthetic: true`.

  CLI: `node tools/release/journeys.mjs run --db-url <isolated test URL> [--out file]`.
  It creates and drops its own schema, and refuses `KEEL_DB_URL`.
- **`tools/release/acceptanceLedger.mjs`** (new). It is a separate module, so the
  shared `qualification.mjs` only gains a `ledger` command.
  - **`buildReleaseLedger`** reports three sections:
    - **fixture**: the journey results, `fixture-tested` only;
    - **live**: every gate in `LIVE_ACCEPTANCE_GATES` (tasks 113-123, including 119);
    - **objectives**: D1-D10 and G1-G8.
  - **`classifyLiveRecord`** gives each live gate one status:
    - `live-qualified`: only when `verifyEvidence` passes with `requireLive` for the
      expected tenant and build;
    - `missing`: no record exists;
    - `pending`: the record is a placeholder (it has a `status` field);
    - `unverified`: no runner key, tenant or build to check the record with;
    - `failed`: the record was checked and did not verify.
  - **Readiness.** `blocked` if any journey or live gate failed, otherwise `pending` if
    anything is unknown, otherwise `ready`. Every other result stays in the report, so
    one failed gate never hides independent work.
  - **Task-117 (Sentinel).** Deferred 2026-09-30, then descoped by operator decision
    2026-10-04 12:36 UTC (task-124). It is still listed and never counted as qualified,
    but as an accepted gap it no longer holds readiness; it appears under
    `readiness.acceptedGaps`. A failed Sentinel record still blocks.
- **`tools/release/qualification.mjs`**: one new subcommand,
  `ledger --fixture <journeys result> [--tenant] [--build] [--out] [--require-ready]`. It
  exits 0 for a report, and with `--require-ready` it exits 1 unless the ledger is ready.
- **`engine/roadmap/acceptance-harness.test.mjs`** (new). 19 boundary tests, added to the
  CI engine step in `.github/workflows/portal.yml`.

## Objectives D1-D10 and G1-G8

Their definitions are in the 2026-09-15 final review
(`/root/docs/superpowers/specs/...`), which is not in git. The repository records the
meaning of only two:

- **D3**: dynamic group impact measured on real sizing. Owner task-60, test
  `dynamic-impact.test.mjs`. It is an explicit gap: no live sizing record exists.
- **D6**: ServiceNow workflow proven live. Owners tasks 96, 97 and 118, with its two
  test suites and the `servicenow-live-acceptance` gate. It is `pending`.

The other sixteen are listed as **explicit qualification gaps**
("objective definition is not in this repository"). They were not guessed. Supplying the
text lets each be mapped in `RELEASE_OBJECTIVES`.

## Tests run (2026-10-04, local PostgreSQL 16, isolated schemas)

- Exact Validate command, with `KEEL_DB_TEST_URL` and `KEEL_TENANT_CONFIG_PATH`
  exported instead of sourcing `/etc/keel/db.env`: engine 23/23 pass, portal typecheck
  clean, portal 159/159 pass.
- CI engine step (all suites in `.github/workflows/portal.yml`, serial): 454/454 pass. `portal npm run build`: success.
- `journeys.mjs run`: all six `passed`. The ledger on the checked-in records reports
  `pending`, and `--require-ready` exits 1.

## Mutation checks (each applied, observed failing, reverted)

| Mutation | Failing tests |
|---|---|
| Mark release ready with unknown qualification (`label = blocked ? 'blocked' : 'ready'`) | 14, 15 |
| Treat queued action as verified outcome (`queued` exempted from the unverified-state checks) | 10 |
| Ignore missing cross-workstream evidence link (missing link skipped silently) | 11, 12 |

## Limits

- **Fixture results only.** Fakes prove code behavior, not Microsoft support or a real
  recovery. The ledger never promotes them.
- **J2 portal and alerts.** J2 runs detection through the worker. The portal routes are
  not called from the journeys. Their route boundaries stay covered by the owner tasks'
  harness tests (`bootstrap-ui`, `grounded-query`, `baseline-compliance-ui`). Drift
  alerts (task-82) are not asserted.
- **J3 and J5 workers.** The roll back in J3 and the restore in J5 run in-process, not
  through `runJob`. `cli/keel-restore.mjs` runs as a child process and cannot receive
  the Graph fake. Worker re-authorization is proved in J2 and in the revocation test.
- **J5 partial write.** "Partial" means configuration restored with completion items
  open. A failed write followed by compensation (task-70) is covered by
  `compensation.test.mjs`, not by this journey.
- **Job tenancy.** Jobs have no tenant column. The assessor binds a job only through
  its parent link.
- **No UI.** There is no portal page. The task names no page, and task-124 owns the
  final acceptance matrix.
