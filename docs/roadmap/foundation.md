# Foundation: versioned observation and release evidence contracts (task-45)

Date: 2026-09-15 UTC. Status: implemented, fixture-tested only.

## What was built

- `engine/contracts/observation.mjs` — the versioned observation contract.
  Every observation carries `tenant_ref`, an observation ID, a per-type
  start/end window, the source build, a completeness state and an evidence
  level (`fixture-tested`, `live-qualified`, `unknown`). `readObservation`
  preserves legacy digest reads (bare counts and `{ outcome, itemCount }`):
  legacy rows fall back to the enclosing snapshot run bounds as their window
  and always read with evidence level `unknown` — nothing is promoted.
  `assertSimultaneous` refuses to label different or unknown windows
  simultaneous, and `joinObservations` throws `CrossTenantObservationError`
  on any tenant mismatch; there is no partial cross-tenant merge.
- `engine/coverage/snapshots.mjs` — the per-type coverage CTE now carries
  `started_at` so each type keeps its own observation window;
  `readCoverageOutcome` additionally understands contract-v1 entries
  (completeness + valid count), with legacy meaning unchanged;
  `readTypeObservation` composes a digest entry and its snapshot row into a
  contract observation.
- `engine/coverage/report.mjs` — each type entry now carries its `observation`
  (or `null` when never collected), and the report declares
  `observationContract: { version: 1, atomicTenantImage: false }`.
  `reportObservationWindows` exposes the distinct windows a report spans; a
  tiered or mixed-time report is never an atomic tenant-wide image. A stored
  digest entry naming a different tenant rejects the whole report.
- `tools/release/readiness.mjs` — read-only readiness CLI. Records source and
  deployed git revisions, portal health and authenticated feature-probe
  outcomes into `docs/release/readiness.json` without changing deployment.
  The session assertion comes from an environment variable and is never
  printed or persisted. A missing session yields probe outcome `unknown`,
  never `pass`; health 200 with an unauthorized probe yields `not-ready`,
  never feature parity.
- `tools/release/qualification.mjs` — common qualification verifier CLI:
  `verify --gate <gate> --evidence <file> [--tenant <ref>] [--require-live]`.
  Validates schema, gate and tenant binding, build/operation/credential-mode
  fields and observation freshness, and requires proof: a trusted runner
  identity with an HMAC signature (key via `KEEL_QUALIFICATION_HMAC_KEY`,
  never in git) or an independently verifiable artifact digest recomputed
  from the artifact bytes. Missing proof exits nonzero. `--require-live`
  rejects synthetic fixtures, fixture-tested levels and synthetic runner
  identities. Gate-specific validators register additively in
  `GATE_VALIDATORS`; the `release-readiness` gate is registered now, and an
  unregistered gate fails closed.

## Implementation and proof limitations

- Everything here is fixture-tested against the isolated test database and
  fake fetch/exec seams. No live tenant was touched; collector and restorer
  credentials were not used, and Conditional Access is never enforced.
- Legacy digest entries cannot prove a per-type window or an evidence level;
  they read with the snapshot run bounds and `unknown` level. Historical
  rows are not rewritten.
- The readiness CLI is a recorder, not a deployment gate: it exits 0 when the
  record is written and the verdict lives in the JSON. `docs/release/
  readiness.json` reflects whatever was observable at record time (an
  unreachable portal records `not-ready`, a missing session records
  `unknown`).
- The readiness probes are HTTP status probes. A 200 proves the authenticated
  route answered, not feature parity with the source tree; revision equality
  is recorded separately (`revisionMatch`).
- The HMAC signer/verifier pair proves integrity and trusted-runner
  membership for evidence produced in this repository. The trusted runner
  list is static code; adding a production runner identity requires a code
  change and real key management, which no task has qualified yet. Live
  qualification evidence remains absent until an authentic runner produces
  it — `--require-live` currently passes only records signed by the
  non-synthetic trusted runner with a live-qualified level, and no such
  authentic record exists.
- The qualification freshness window defaults to 30 days
  (`--max-age-hours`); it is a staleness guard, not proof of current tenant
  state.

## Boundary tests

`engine/roadmap/foundation.test.mjs` exercises the production contract,
report, and both CLIs against adversarial fixtures: legacy and mixed-tier
reads, window-mismatch refusal, unknown-probe handling, cross-tenant join
rejection (in-process and through the report), missing/forged/tampered proof,
fabricated live qualification, and stale/future observations.
