# Versioned benchmark and custom-control evaluation (task-85)

Date: 2026-09-25 UTC. Status: implemented, fixture-tested only. No live
qualification is claimed.

## What was built

- `engine/benchmarks/registry.mjs` (new) — the versioned control registry.
  A control names a `framework`/`edition`/`profile` identity, an
  `evaluatorVersion`, the observations it requires (`resourceType` +
  `maxAgeMs`), an allowlisted predicate reference, an optional
  `frameworkRefs` mapping to external benchmark reference codes, and a
  `provenance` record. Three rules are enforced, non-negotiably:
  1. A predicate is a plain function registered ahead of time through
     `registerPredicate()`; `registerControl()` refuses any control whose
     `predicate.name` is not already allowlisted. There is no dynamic code
     construction — a control can only reference behavior this module's
     author shipped.
  2. `semanticFacts()` is the only sanctioned way to build predicate input:
     it reprojects a raw resource through
     `engine/contracts/fieldProjection.mjs`'s `exportProjection()` (task-51
     field-projection machinery), which excludes every field a type's review
     named `sensitiveExport` (on-prem AD correlation identifiers, internal
     HR ids, ...) before a predicate ever runs. `evaluate.mjs` never hands a
     predicate the raw collected payload. This deliberately differs from
     `canonicalHash.mjs`'s comparison-oriented `canonicalize()`, which
     excludes *server-owned* fields instead — the wrong cut here, since
     server-managed configuration state (`onPremisesSyncEnabled`,
     `isAssignableToRole`, ...) is exactly what a benchmark predicate needs
     to read; `canonicalize()` would silently blind every predicate to it.
  3. A control whose `provenance.source` is `'licensed'` must cite a
     `rightsEvidence` string or registration is refused. The three controls
     this module ships are all `provenance.source: 'original'` with empty
     `frameworkRefs` — no CIS (or other licensed benchmark) text or section
     numbering appears anywhere in this repository. The multi-framework-
     reference mapping capability is real and tested, but only against
     synthetic example framework names.
- `engine/benchmarks/evaluate.mjs` (new) — `evaluateControl()` is a pure
  function: given a control id, a tenant ref and per-resource-type
  observation evidence, it returns one evaluation result
  (`pass`/`fail`/`unknown`/`not-applicable`), never touching the database.
  Every one of a control's required observations must be usable — present,
  tenant-matched, non-future, within its `maxAgeMs` freshness window, and a
  `complete` read (a completed read that happened to find zero resources is
  still `complete`, per `engine/contracts/observation.mjs`) — before the
  predicate is even invoked; any gap degrades the whole control to
  `unknown`, never a guessed pass. `recordEvaluation()`/`recordException()` persist results and
  append evidence; `compareEvaluationsAcrossEditions()` refuses to compare
  (`comparable: false`) whenever the edition or evaluator version differs
  between two evaluations of the same control, mirroring
  `canonicalHash.mjs`'s `compareAcrossHashVersions()` for hash versions.
  `effectiveVerdict()` computes the exception overlay at read time without
  ever mutating a stored evaluation row.
- `engine/store/schema.sql` — new `benchmark_evaluation` and
  `benchmark_exception` tables (additive; no existing table changed).
  `benchmark_evaluation.verdict`'s CHECK constraint deliberately excludes
  `'exception'` — an exception can only ever be a `benchmark_exception` row
  referencing an evaluation, never the evaluation's own stored verdict.

## Result states and their meaning

- `pass` / `fail` — the control's predicate ran against usable, fresh,
  tenant-scoped observation evidence and reached a semantic verdict.
- `unknown` — a required observation was missing, stale, future-dated,
  cross-tenant, or not a completed read. The predicate never runs in this
  case.
- `not-applicable` — the predicate itself determined there was nothing to
  evaluate (for example, zero named locations exist, so "no named location
  marks unknown-country traffic as trusted" has nothing to check).
- `exception` — never a stored verdict. It is the read-time overlay
  `effectiveVerdict()` reports when an active (unexpired)
  `benchmark_exception` references a stored `fail` evaluation. The
  underlying evaluation row, its `reason`, its `evidence_refs` and its
  `benchmark-evaluation` evidence record are all untouched; the exception
  adds a second, separate `benchmark-exception` evidence record instead of
  replacing anything.

## Edition versioning is not tenant drift

`framework`/`edition`/`profile`/`evaluatorVersion` are recorded on every
stored `benchmark_evaluation` row, never inferred from the current registry
state — a later registry edit can never rewrite the meaning of a historical
result. Comparing two evaluations of the same control across a different
edition or evaluator version is refused by
`compareEvaluationsAcrossEditions()` (`comparable: false`) rather than
reported as a changed verdict: a benchmark content bump is not something the
tenant did, and this module never writes to the `drift`/`baseline` tables at
all — a benchmark result is never fed into drift detection.

## Shipped fixture controls (original, no external framework mapping)

- `keel-custom.role-assignment.admin-count-at-most` — fails when more than a
  configured number of active `roleAssignment` records name the Global
  Administrator role template id (default limit 5).
- `keel-custom.named-location.no-untrusted-all-countries` — fails when any
  `namedLocation` is simultaneously `isTrusted` and
  `includeUnknownCountriesAndRegions`; `not-applicable` when the tenant
  defines no named locations.
- `keel-custom.group.role-assignable-not-synced` — fails when any `group` is
  both `isAssignableToRole` and `onPremisesSyncEnabled`; `not-applicable`
  when the tenant has no groups.

All three are original, hand-written checks scoped to fields
`engine/contracts/fieldProjection.mjs` already reviewed for the six M1
types. None claims to implement or number-match any licensed benchmark.

## Implementation and proof limitations

- Everything here is fixture-tested against synthetic payloads and the
  isolated test database. No live tenant was touched; collector and
  restorer credentials remain separate and were not used; Conditional
  Access is never enforced by this task (no code path here creates,
  activates, or writes any Conditional Access object — evaluation is
  read-only, and the shipped fixture controls do not read
  `conditionalAccessPolicy` at all).
- `evaluateControl()` takes its observation evidence as an argument; this
  task does not wire a collector or scheduler to build that evidence from
  live snapshots, and does not add any CLI/portal surface — the task's own
  file list is engine-only (`registry.mjs`, `evaluate.mjs`, `schema.sql`,
  and this doc). Wiring evaluation runs to real collected snapshots, adding
  authorization-gated read/write API routes, and rendering results in the
  portal are later, out-of-scope lanes.
- A control's `requiredObservations` currently accepts a single resource
  type cleanly (all three shipped controls); a multi-type control receives
  a `{ resourceType: facts[] }` map instead of a plain array — implemented
  and exercised by the pure evaluation path, but no shipped control uses it
  yet.
- `frameworkRefs` records reference codes (`framework`/`edition`/`profile`/
  `ref`) only, never descriptive or normative text, and nothing in this
  module's result shape asserts legal compliance with any named framework.
