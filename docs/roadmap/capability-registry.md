# Evidence-backed operation capability registry (task-52)

Date: 2026-09-19 UTC. Status: implemented, fixture-tested only. No live
qualification is claimed.

## What was built

- `engine/coverage/capabilities.mjs` (new) — the operation capability
  registry. Every `(resourceType, operation)` pair carries an explicit claim,
  one of `declared`, `fixture-tested`, `live-qualified`, `unsupported` or
  `unknown` (spec Global Constraint #6) — never a boolean, and never derived
  from `tools/tenant-probe/catalog.mjs`'s CATALOG (which names a read `path`
  for all 52 catalogue types) or from `engine/collect/descriptors.mjs`'s
  `remappable` flag (a cross-tenant reference-resolution property, unrelated
  to whether a type's own create/update/delete/restore is implemented).
  `registerOperationCapability()` is the only way a pair moves off
  `unsupported`, starting at `declared`; `recordFixtureProof()` moves it to
  `fixture-tested` once an adversarial boundary test has actually exercised
  the production `applyWave()` code path with a fake writer;
  `qualifyLiveEvidence()` is the only path to `live-qualified`, and only
  succeeds when the supplied evidence's `tenantRef`, `resourceType`,
  `operation` and `fieldProjectionContractVersion` all match the
  qualification request, `observedAt` is fresh (within 30 days, never in the
  future) and `synthetic` is explicitly `false` — a fixture harness's
  evidence is always synthetic and is refused, never promoted.
  `capabilityFor()` is the one read path every caller uses, including
  `graphPathFor()`, which is now `engine/restore/applyEngine.mjs`'s only
  source for a resourceType's Graph write path (previously a second,
  hand-maintained map that could silently drift out of sync with what was
  actually registered). `capabilitySummaryFor()` returns every operation's
  claim for a type, consumed by the coverage report.
- `engine/restore/applyEngine.mjs` — `applyWave()` now computes the
  effective verb the same way its own branches dispatch on it (a verb
  naming none of `delete`/`restore-soft-deleted`/`update`, including an
  absent verb, is the implicit `create` path) and calls
  `verbCapability(resourceType, effectiveVerb)` immediately after the `noop`
  check, before any deletion/sync guard, rollback-journal write or writer
  call. An unsupported pair is pushed to `failed` with an explicit
  `unsupported operation` message and the resource is skipped — never an
  uncaught throw from the old inline `pathFor()` map, and never a rollback
  journal entry recorded for an operation that could never proceed.
  `applyPatches()` — the second, deferred-reference-patch phase — gets the
  same gate, treated as an `update` capability (a patch is a PATCH). The
  local `pathFor()` helper is now a thin wrapper over
  `capabilities.mjs`'s `graphPathFor()`.
- `engine/reconcile/verb.mjs` — new `verbCapability(resourceType, verb)`,
  co-located with `decideVerb()` since both define "verb" semantics but
  answer independent questions: `decideVerb()` says what the diff requires;
  `verbCapability()` says whether `applyWave()` can actually do it. A `noop`
  is always attemptable (nothing is ever written for it);
  `decideVerb()` itself is untouched — still a pure, resourceType-blind diff
  decision.
- `engine/coverage/report.mjs` — each type's report entry gains
  `writeCapability` (from `capabilitySummaryFor()`), alongside — never
  replacing — the existing bare `remappable` boolean and the read-side
  `fidelity: { declared, verifiedBy }` pair, which are both preserved
  exactly as before. `writeCapability` is populated for every catalogue
  entry, covered or not, since write capability is independent of
  read-coverage status.
- Four resourceTypes are registered, exactly matching what
  `engine/reconcile/liveState.mjs`'s `SOFT_DELETABLE` and the pre-existing
  write paths actually support — never a blanket "same four ops for the
  same four types":
  - `group`: create, update, delete, restore-soft-deleted.
  - `roleAssignment`, `namedLocation`, `conditionalAccessPolicy`: create,
    update, delete (none are soft-deletable Graph directory objects).
  - Task-152 later added `conditionalAccessPolicy` restore-soft-deleted, read
    from the Conditional Access deleted-items store and fixture-tested only
    (see `conditional-access-enforce.md`).

## Real evidence gaps this task closed

Auditing the pre-existing test suite against every `(resourceType,
operation)` pair before writing the registry found that several operations
already reachable through `applyWave()` had **zero** boundary-test coverage,
despite `namedLocation` already being declared `fidelity: 'full'`:

- `namedLocation` create/update/delete: no test anywhere exercised any of
  these through `applyWave()`.
- `roleAssignment` update: never exercised (every real field is
  `immutable` per `engine/cir/serverOwned.mjs`, so the honest, evidence-true
  boundary test proves the PATCH body is always empty and the outcome is
  `not-remediable` — never a silent success and never a corrupted write).
- `roleAssignment` delete: only the pre-write guard-skip path (tenant-lockout
  without a passed simulation) was tested; the real DELETE-and-verify path
  was never exercised.
- `conditionalAccessPolicy` delete: never exercised at all.

`engine/roadmap/capability-registry.test.mjs` adds adversarial boundary
fixtures for every one of these, using the same fake-writer pattern as the
pre-existing `engine/restore/*.test.mjs` files, so every claim this
registry's `recordFixtureProof()` calls make is now genuinely backed by a
passing test against the production code path.

## Implementation and proof limitations

- Everything here is fixture-tested against synthetic payloads and the
  production `applyWave()`/`applyPatches()`/`verbCapability()`/
  `capabilityFor()` code paths. No live tenant was touched; collector and
  restorer credentials were not used, and Conditional Access is never
  enforced by this task.
- `credentialMode` on every registered record is declarative metadata
  (`'restorer'` for every write operation here) — it documents which
  credential a write operation requires, matching the separate
  `restorer.json`/`collector.json` configuration already loaded by
  `cli/keel-restore.mjs`/`cli/keel-remediate.mjs`. This task adds no new
  runtime enforcement that threads an actual credential identity into
  `applyWave()` to check against it; credential separation remains enforced
  structurally by the CLI's separate config loading, unchanged by this task.
- `qualifyLiveEvidence()` is a pure, tested function with no production call
  site yet: no CLI or worker in this repository calls it. It exists so a
  future live-rehearsal task (run by the orchestrating session, never by a
  fixture-only builder) has a single, already-hardened place to submit
  qualification evidence, rather than inventing a new ad hoc promotion path.
- `subtype` is named on every capability record for forward compatibility
  (e.g. a future per-subtype claim for distinct Intune configurationPolicy
  templates) but is always `null` today — no currently-registered type has
  subtype-specific write behavior, and no subtype-keyed lookup machinery was
  built ahead of an actual need for it.
- No schema or migration was needed — like `engine/contracts/
  fieldProjection.mjs` (task-51), this registry adds no persisted rows, only
  in-process, per-build classification. A `live-qualified` promotion lives
  only in the running process's memory; nothing here persists a promoted
  claim across a restart, since no task has yet wired a durable evidence
  store to `qualifyLiveEvidence()`.
- `report.mjs`'s new `writeCapability` field is additive; the pre-existing
  `remappable` and `fidelity` fields are unchanged, and
  `engine/coverage/report.test.mjs` (not part of this task's Validate
  command, but exercising the same file) continues to pass unmodified.

## Boundary tests

`engine/roadmap/capability-registry.test.mjs` exercises the production
`capabilities.mjs`, `applyEngine.mjs`, `verb.mjs` and `report.mjs` against
adversarial fixtures, including the three required mutation checks:

- Qualify operation from pathFor alone: every one of CATALOG's 52 types has
  a real Graph read `path`; every type outside the four explicitly
  registered above must still read `unsupported` for all four operations.
- Promote fixture proof to live-qualified: a synthetic (fixture-harness)
  proof, a cross-tenant proof, a wrong-operation proof, a stale
  field-projection-contract proof, a stale-by-age proof, a future-dated
  proof and a proof with no `proofRef` are each individually refused before
  a fully matching non-synthetic proof is shown to succeed.
- Bypass unsupported-operation check: `applyWave()` and `applyPatches()` are
  each shown to refuse an unsupported operation with zero writer calls and
  zero rollback-journal writes, for every verb — never an uncaught throw
  from the old inline path map.
