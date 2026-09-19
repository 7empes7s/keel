# Portal parity: M4 portal source reconciled with current engine contracts (task-46)

Date: 2026-09-18 UTC. Status: implemented, fixture-tested only.

## What was built

- Ported the M4 surface families — jobs, policies, notifications, principals,
  evidence and the collection-history binding (job history surfaces), plus the
  reconciliation preview binding — from the `m4-portal-design` branch into
  master without switching branches, merging histories, or touching deployed
  files. Original commit provenance and the full per-family parity records are
  in `docs/release/source-parity.md`.
- `engine/contracts/release.mjs` — the release source-parity contract. A
  parity record binds one closed-inventory surface family to the real engine
  reader it renders from, with original commit provenance and a status
  (`source-tested`, `deployed`, `diverged`, `unknown`). `deployed` requires an
  explicit evidence reference, so source tests can never assert deployment;
  legacy or absent records read as `unknown` and are never promoted;
  `missingSurfaceFamilies` names any omitted family;
  `summarizeParity` keeps source tests and deployment status in separate
  buckets.
- `engine/authz/administration.mjs`, `engine/authz/principals.mjs`
  (`listPrincipals`), `engine/policy/evaluate.mjs` (`listPolicies`,
  `clearPolicyPause`), `engine/reconcile/previewApplyPlan.mjs` — the engine
  readers and guards behind the ported portal surfaces, taken from their
  original M4 commits. `disablePrincipal` now carries the same self-lockout
  guard as `revokeRole`: disabling the principal that holds the only live
  admin grant is refused regardless of actor, so administration can never be
  zeroed out with no recovery path.
- `cli/keel-restore.mjs`, `cli/keel-remediate.mjs` — the `previewOnly` binding
  resolved against task-08: a preview shares scope, current-state verb
  resolution and wave ordering with enforcement but returns before acquiring
  Restorer credentials or a writer, and never persists or promotes an
  artifact. The enforce path remains artifact-only and unchanged.
- Portal read inventory (`portal/lib/read.ts`) extended additively; every
  ported page and GET route declares its capability in the one closed
  `DATA_SURFACES` registry. Task-07 read authorization and task-08 immutable
  artifact-only restore promotion are preserved.

## Implementation and proof limitations

- Everything here is fixture-tested against the isolated test database and
  injected fake Graph readers/writers. No live tenant was touched; collector
  and restorer credentials were not used, no notification was sent, and
  Conditional Access is never enforced.
- A preview proves what the real apply guards would refuse at plan time; it is
  not Microsoft support evidence and does not qualify any live restore.
- `portal/test/remediation-preview.test.ts` was reconciled with task-08: a
  direct-API promotion whose dry run refused resources now fails closed at the
  artifact gate. The branch's original expectation (promotion succeeds with
  skips reproduced) is superseded by task-08's immutable-promotion rule; the
  guard-equivalence and zero-write assertions are preserved.
- The collection-history binding is the jobs history surface family (every
  collection run is a job). Later tasks extend these surfaces; this task adds
  no new collection schema.
- Source parity is recorded per family in `docs/release/source-parity.md`;
  deployment status is explicitly out of scope for source tests and remains
  with the readiness recorder and external qualification evidence.

## Boundary tests

`engine/roadmap/portal-parity.test.mjs` exercises the production parity
contract, the real portal source tree against the closed read inventory, the
task-08 artifact-only enforce gate, and the preview binding through the real
`runRestore` — including the three required mutation checks: omitting a ported
surface from the read inventory, submitting a restore by raw selection instead
of artifact, and treating a zero-item successful collection as a failure. The
zero-item check covers both `readCoverageOutcome` branches directly: the legacy
`{ outcome, itemCount }` digest entry and the contract v1 versioned envelope.
`portal/test/remediation-control.test.ts` proves a refused preview cannot be
submitted through the DriftTable handler even with a populated justification,
so the guard-refusal check — not the empty-reason gate — is what blocks it.
The `disablePrincipal` self-lockout guard is exercised in
`engine/authz/administration.test.mjs` and at the portal route in
`portal/test/principals.test.ts` (403 while it is the last live admin, 200
once a second live admin exists).
