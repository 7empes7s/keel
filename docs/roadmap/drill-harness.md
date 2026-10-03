# Offline and bounded same-tenant recovery drills (task-72, WS10)

Date: 2026-10-03 UTC. Status: implemented, fixture-tested only. No live drill
has been run; Keel recovery readiness for the managed tenant is unmeasured.

## What was built

- `tools/rehearsal/qualification.mjs` (new) — the drill harness. Two modes:
  - **offline** (the default, and the CLI default) — `validateDrillPlan()`
    checks a drill manifest against the loaded Collector and Restorer
    configuration and the rehearsal database URL. It reads the two
    configuration files and nothing else: no token, no database connection,
    no Graph read or write, no evidence row. Its result always carries
    `countsAsRecoveryDrill: false` and `writes: 0`.
  - **live** — `runBoundedDrill({ mode: 'live', confirm: true, ... })` runs the
    existing uniquely named disposable-object round trip
    (`tools/rehearsal/roundTrip.mjs`, `runRoundTrip`) behind a bounded write
    boundary. `confirm` must be exactly `true` (CLI:
    `--confirm-bounded-drill`); without it the harness, and the CLI before it
    obtains any credential, refuses. Every manifest check must pass before the
    first write.
- **The drill manifest** (`buildDrillManifest()`, `validateDrillManifest()`):
  `{ version: 1, kind: 'bounded-same-tenant-drill', tenantRef, startAt,
  objects, bounds }`. Every refusal is a named finding:
  | Finding | Meaning |
  | --- | --- |
  | `foreign-tenant` | The manifest's tenant pin is not the configured Collector tenant, or the Restorer is registered in another tenant |
  | `tenant-pin-missing`, `tenant-config-missing` | No tenant pin, or no Collector tenant to compare it with |
  | `non-disposable-target` | An allowlisted object is not a `group:keel-rehearsal-*` disposable object |
  | `object-not-planned` | The allowlisted object is not the one this drill creates from its own `startAt` |
  | `unsupported-resource-type` | Anything but the round trip's disposable group (no tenant-wide policy rehearsal) |
  | `unknown-field` | A field outside the manifest shape, e.g. `cloneTenant` (no cloned tenant) |
  | `no-objects`, `too-many-objects` | One allowlisted object per drill |
  | `bounds-missing`, `bounds-exceeded` | `maxElapsedMs` (ceiling 30 min) and `maxWrites` (ceiling 40) are required and capped |
  | `production-db`, `test-db-missing` | The existing round-trip test-DB guard (`assertRehearsalDatabase`) |
  | `shared-credentials`, `restorer-config-missing` | The existing Collector/Restorer separation check |
- **The write boundary** (`boundedWriter()`): the only POST allowed creates the
  allowlisted disposable natural key; every later write must target an object
  created through that POST; a `mailNickname` change must stay disposable; no
  non-cleanup write after the time bound or beyond the write bound. Cleanup
  DELETEs of created objects keep a small reserve past both bounds, so a
  bounded drill can still remove what it made.
- **Elapsed time** is the injected clock's reading after the run (and cleanup
  verification) minus its reading before; it is recorded with
  `elapsedSource: 'observed-clock'` and its start/finish instants. A drill
  over its time bound is `exceeded-bound` or is stopped by the write boundary.
- **Cleanup evidence** (`verifyCleanup()`): after the round trip, every object
  the drill created is read back on both `/groups/{id}` and
  `/directory/deletedItems/{id}`. Only a 404 on both is "absent". A readable
  object is a `present` residual; a failed read is an `unknown` residual. Any
  residual makes `cleanup.status = 'failed'`, which the drill record, the log
  and the readiness summary all show.
- **Drill record** — every live drill that started is appended as evidence of
  kind `recovery-drill` (tamper-evident chain, `engine/govern/evidence.mjs`)
  in the rehearsal database, with outcome `passed`, `failed`,
  `exceeded-bound` or `cleanup-failed`, the observed timing, the bounds, the
  write count, the created objects and the cleanup result. A run that fails
  is still recorded, not thrown away.
- `engine/coverage/recoveryReadiness.mjs` (new) — `classifyDrillRecord()`,
  `summarizeRecoveryReadiness()` and the tenant-scoped
  `loadRecoveryReadiness(client, { tenantRef })`. A record counts as a
  recovery drill only if it is live, bounded same-tenant, pinned to the asked
  tenant, `passed`, cleanup `complete`, and its `elapsedMs` equals its own
  recorded finish minus start within its time bound. States: `unmeasured` (no
  counted drill), `drilled`, `attention` (any drill left a residual). Records
  of another tenant are never read. This is the reader task-73 renders.
- `tools/rehearsal/roundTrip.mjs` — exports the pieces the harness reuses
  (`rehearsalGroup`, `tenantRefFor`, `assertSeparateRestorer`,
  `DISPOSABLE_PREFIX`, `INTENDED_SEQUENCE`). Its orphan cleanup no longer logs
  "removed" when a DELETE is refused: a non-OK, non-404 response is reported
  as `cleanup FAILED` and returned as a failure.
- Portal closed registries (`portal/lib/presentation.ts`,
  `portal/lib/sentences.ts`) map the new `recovery-drill` evidence kind to
  "Recovery drills" and a plain sentence, so the stored code never reaches the
  screen unmapped.

CLI:

```bash
# Offline (default): validate a manifest; exit 0 only for a valid plan.
node tools/rehearsal/qualification.mjs --build-manifest --config /etc/keel/tenant.json --out drill.json
node tools/rehearsal/qualification.mjs --manifest drill.json --config /etc/keel/tenant.json \
  --restorer-config /etc/keel/restorer.json --db-url "$KEEL_DB_TEST_URL"
# Live (operator only, never run by a builder): exit 0 only for a counted drill.
node tools/rehearsal/qualification.mjs --live --confirm-bounded-drill --manifest drill.json ...
```

No schema migration was needed: drill records use the existing `evidence`
table (`tenant_ref` scoped). There is no legacy drill data; the existing
`fidelity-drill` evidence read by `engine/coverage/report.mjs` is untouched
and is not counted as recovery readiness.

## Implementation and proof limitations

- Fixture-tested only. The boundary tests drive the real `runRoundTrip`
  against fake Graph reader/writer objects and the isolated test database
  (`engine/test/dbTestHelper.mjs`). No live tenant object was touched, no
  credential was used, and no live drill was run. A passing fake drill proves
  harness behavior, not Microsoft recovery.
- Live drill evidence is written to the rehearsal database the round trip
  uses, never to production (the test-DB guard refuses it). Carrying a
  counted drill into the production evidence chain, and rendering readiness
  in the portal, is task-73's work; until then the portal has nothing to show
  and readiness is unmeasured.
- A bounded drill proves one disposable group's create, drift, rollback and
  hard-delete on the same tenant within the recorded time. It is not a
  tenant-wide recovery, does not exercise other resource types, and does not
  measure an RTO for real incidents.
- The time bound is checked at every write and at the end. A single Graph
  call that hangs is not interrupted mid-flight; the run is marked
  `exceeded-bound` or `failed` when it returns.
- Cleanup verification reads with the Collector reader once per surface after
  the round trip's own retried deletes; replication lag can make a removed
  object read as `present`, which is reported as a residual rather than
  assumed gone.
- `tools/rehearsal/roundTrip.test.mjs` still needs `/etc/keel/tenant.json` for
  its failure-path case; it is not in CI and was not changed here.

## Boundary tests and mutation checks

`engine/roadmap/drill-harness.test.mjs` (9 tests, in the CI engine step):
offline default makes zero writes, reads and DB calls and never counts;
live needs exact opt-in and the CLI refuses before credentials; a
non-disposable target is refused by validation and at the write boundary
(with tenant-wide, cloned-tenant, empty and over-bound manifests); the
production database is refused; a foreign tenant pin or Restorer is refused
and readiness ignores foreign records; a live fake drill passes with elapsed
time equal to the observed clock and verified cleanup, and readiness reads
`drilled`; the time bound stops a run while cleanup still completes; a refused
purge leaves a visible `deleted-items` residual and readiness `attention`; a
forged offline "pass" stored as evidence is not counted, nor is a claimed
elapsed time that disagrees with the recorded instants.

Required mutation checks, each confirmed to fail a test and reverted
(2026-10-03):

| Mutation | Where | Result |
| --- | --- | --- |
| Allow non-disposable target | `assertDisposable` made a no-op; separately, validation's disposable check removed | 1 test fails each |
| Count offline pass as live recovery | `classifyDrillRecord` mode check removed; separately, offline `countsAsRecoveryDrill` set from validity | 1 and 2 tests fail |
| Suppress failed cleanup | `verifyCleanup` always `complete`; separately, readiness drops `cleanupFailures` | 1 test fails each |

## Validation notes (2026-10-03)

- Validate command: 14/14 pass on repeated runs. Roughly one run in six,
  `engine/authz/administration.test.mjs` fails at its "grant is live at once"
  assertion. That flake predates this task: `grantRole` stamps `active_from`
  with Postgres `now()` (microseconds), but `resolvePrincipal` checks against
  JS `new Date()` (milliseconds), so a grant and a check in the same
  millisecond can read as not yet active. It is authz scope (not this task)
  and is not in the CI suite list. It is reported here and was left
  unchanged.
