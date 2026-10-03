# Capability matrix and linked observation views (task-54)

Date: 2026-09-29 UTC. Status: implemented, fixture-tested only.

Direction note (2026-10-03): the matrix layout this task rendered is superseded by
`docs/roadmap/portal-experience.md` and task-131. The reader fields and the boundary
tests stay; the portal moves every evidence column into a per-type technical record
behind a one-sentence protection state.

## What was built

- `engine/coverage/report.mjs` — `buildCoverageReport()` now attaches four
  additional fields to every type entry, both the descriptor-backed branch
  and the catalog-only "not-covered" branch:
  - `declaredEndpoint: { path, apiVersion } | null` — read straight from the
    `catalog` argument (the same `CATALOG` array the caller already passes
    in), present even for a type this tenant has never collected. Distinct
    from the existing `detail.endpoint`/`detail.apiVersion`, which stays
    `null` until a real observation measured it and, once measured, may
    differ from the declared path (e.g. `group`'s catalog path is `/groups`;
    its measured endpoint carries the `$select` query the adapter actually
    sent).
  - `irrecoverableFields: string[] | null` — the union of
    `engine/cir/serverOwned.mjs`'s `SERVER_OWNED_ALWAYS` and
    `SERVER_OWNED.get(resourceType)`, reused verbatim (never re-derived) so a
    future correction to that registry's classification automatically keeps
    this report accurate. `null` only when no descriptor exists for the type
    at all (the not-covered branch with no `SERVER_OWNED` entry to read).
  - `relationshipCompleteness: 'unknown'` — honestly unknown for every type,
    every branch, unconditionally. No relationship/edge collection exists in
    this codebase yet (that is roadmap task-57/58's job); this field exists
    now so the portal has a column to render and task-57/58 only need to
    change the value this function returns, not add a new field end-to-end.
  - `diagnosis` and `writeCapability` were already computed by
    `buildCoverageReport()` (roadmap task-53 and task-52 respectively) but
    were silently dropped by the portal normalizer — see below. No engine
    change was needed for those two.
- `portal/lib/types.ts` — new optional fields on `CoverageType`
  (`declaredEndpoint`, `irrecoverableFields`, `relationshipCompleteness`,
  `diagnosis`, `writeCapability`, `observation`) plus their supporting types
  (`WriteCapabilitySummary`, `CoverageDiagnosis`, `CoverageObservation`,
  etc.). They are optional, not required, specifically so the pre-existing
  fixture in `portal/test/staleness.test.ts` — which predates this task and
  is out of this task's file list — keeps typechecking unchanged; every
  consumer treats an absent field exactly like an explicit `null`.
- `portal/lib/portal-data.ts` — `normalizeCoverageType()` now maps the raw
  report entry's `declaredEndpoint`, `irrecoverableFields`,
  `relationshipCompleteness`, `diagnosis`, `writeCapability` and
  `observation` fields through defensive normalizers
  (`normalizeDeclaredEndpoint`, `normalizeWriteCapability`,
  `normalizeDiagnosis`, `normalizeObservation`) instead of dropping them.
  Every normalizer only accepts recognized enum values (capability claim,
  diagnosis state, projection review state) and falls back to an explicit
  `"unknown"`/`null` for anything else, so a malformed or future-versioned
  raw entry degrades to "unknown," never to a fabricated known value.
- `portal/components/coverage-report.tsx` — a new "Capability & evidence"
  column renders a per-row `<details>`/`<summary>` disclosure (native
  keyboard and narrow-screen support, no additional script) containing:
  declared vs. measured endpoint/version, pagination evidence (explicitly
  "Unknown" when absent, never silently dropped or defaulted to zero),
  the prerequisite diagnosis, the honestly-unknown relationship
  completeness, the irrecoverable-fields list, the full operation-by-
  operation write-capability matrix (create/update/delete/restore-soft-
  deleted, each rendered with its literal claim string — declared,
  fixture-tested, live-qualified, unsupported or unknown — never collapsed
  into a single boolean), and the linked observation (its `observationId`,
  window, and plain links to the existing `/backups` and `/drift` pages for
  cross-reference). The disclosure's `<summary>` names the irrecoverable-
  field count when any exist, so a declared-`full` fidelity badge in the row
  above is never the only thing a reader sees before expanding.
- `portal/app/globals.css` — additive CSS only, for the new badge classes
  (`.diagnosis-*`, `.claim-*`) and the capability-matrix layout, reusing the
  existing color tokens (`--protected`, `--partial`, `--readonly`,
  `--uncovered`) and the existing `.state-badge`-family selector rather than
  inventing a new visual language. Not in the task's named file list, but
  necessary: the new markup has no visual home in the existing stylesheet
  otherwise, and Global Constraint #9 requires existing portal design
  patterns for any new UI.
- `portal/app/coverage/page.tsx` retains authorization before loading and now
  correctly describes completed zero-item collections as successful.
- `engine/roadmap/coverage-ui.test.mjs` exercises both the engine and the real
  portal loader and rendered page against the isolated database. The portal
  subprocess receives only the isolated database URL and a temporary fixture
  tenant configuration. Denied requests are checked with a loader-read spy and
  an authorized positive control.

## Linked observations and evidence

The matrix renders operation proof references, projection review and credential
mode alongside each literal claim. Relationships remain visibly unknown in the
collapsed disclosure as well as in the details. Observation completeness and
proof level are displayed without promotion. Differing windows produce an
explicit non-simultaneous warning; this includes small per-type time differences
within a collection, because the report is not an atomic tenant image.

Backup and drift links carry observationId, resourceType, startedAt and endedAt.
Those existing destination pages do not yet filter by these query parameters;
the links retain comparison context, not proof of a matching destination record.
No benchmark route exists yet; the matrix explicitly states that comparison is
unavailable until a benchmark view records a matching observation. This task
adds no benchmark implementation or claim of benchmark qualification.

## Implementation and proof limitations

- `relationshipCompleteness` is a placeholder honestly fixed at `'unknown'`
  for every type. It is real, load-bearing UI wiring (the column exists,
  is typed, and is tested), not a stub left for a future task to invent from
  scratch — but the value itself carries no information yet, on purpose,
  because no relationship/edge collection exists in this codebase (roadmap
  task-57/58 introduce that).
- `irrecoverableFields` is a *declared* classification (which fields Graph
  itself owns, per `engine/cir/serverOwned.mjs`), not a live proof that a
  restore actually failed to write them — consistent with the rest of this
  report, which distinguishes declared from measured everywhere else
  (fidelity, endpoint).
- The write-capability matrix renders exactly the claim
  `engine/coverage/capabilities.mjs` already recorded (roadmap task-52); this
  task added no new registrations and made no new capability claims. `user`
  and `authenticationStrengthPolicy` (two of the six M1 types) have never had
  any operation registered, so every one of their operations renders
  `unsupported` — expected, not a defect introduced here.
- Everything was exercised against the isolated test database with fixture
  Graph readers. No live tenant was touched; collector/restorer credential
  separation is unchanged (this task touches no credential-handling code),
  and Conditional Access enforcement is untouched (still never enforced by
  any builder task).

## Boundary tests

`engine/roadmap/coverage-ui.test.mjs` exercises the production
`buildCoverageReport()` against the isolated test database and the real
`capabilitySummaryFor`/`diagnoseFailure`/`SERVER_OWNED` registries (no
mocking of those seams):

- Declared endpoint/version is present for a type that was never collected
  (`user`, tier-excluded from a tier1-only run) and differs from the measured
  endpoint on a type that was (`group`'s bare catalog path vs. its
  `$select`-qualified measured endpoint).
- `irrecoverableFields` matches `SERVER_OWNED_ALWAYS ∪ SERVER_OWNED.get(type)`
  exactly for `group` (type-specific fields present) and `namedLocation`
  (only the universal fields — no type-specific override exists for it).
- A `full`-fidelity type (`group`) still discloses a non-empty
  `irrecoverableFields` list — the acceptance criterion that a single
  full-fidelity badge never hides partial information.
- Known-zero pagination (`namedLocation`'s complete-empty read, `pagesCompleted:
  0` on `roleAssignment`'s first-page 403) stays a real, distinct number;
  unknown pagination (`user`, never collected) stays `null` — the "drop
  unknown pagination state" mutation is pinned against both directions.
- `roleAssignment`'s registered prerequisite (roadmap task-53) diagnoses a 403
  as `missing-scope` from the same run's `oauth2PermissionGrant` evidence,
  which is present through unmodified.
- `relationshipCompleteness` reads `'unknown'` for every type in the report,
  including the catalog-only not-covered branch.
- Write-capability claims pass through as exact literal strings —
  `group`'s `update`/`restore-soft-deleted` are `fixture-tested` (never
  collapsed to `live-qualified`), `user`'s `create` and
  `authenticationStrengthPolicy`'s `update` are `unsupported` (never
  registered) — the "collapse fixture-tested to verified" mutation is
  pinned by exact string comparison, not a loose truthy check.
- A catalog entry with no collecting descriptor still gets every new field
  in its honest not-covered shape (`declaredEndpoint` from the catalog,
  `irrecoverableFields: null`, `relationshipCompleteness: 'unknown'`).
- A tier1 run merged with a differently-timed tier2 run produces two
  distinct `reportObservationWindows()` groups and an explicit
  `assertSimultaneous()` mismatch — the cross-type window merge is never
  silently presented as one atomic read.

The portal integration test also verifies every catalog row renders its matrix,
unknown pagination remains visible, fixture-tested claims and their proof
references survive normalization, observation IDs survive rendering, and the
empty-success explanation is correct. This closes the two reported surviving
mutations (matrix suppression and claim promotion in portal normalization).

Mutation experiments, each restored immediately afterwards:

```text
KILLED: suppress capability matrix
KILLED: upgrade fixture-tested during normalization
KILLED: collapse fixture-tested to verified
KILLED: replace unknown pagination with zero
KILLED: fetch before authorization
```

## Validation

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/coverage-ui.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

```text
engine: 1..17 / tests 17 / pass 17 / fail 0
portal typecheck: clean (tsc --noEmit, no output)
portal test: 1..87 / tests 87 / pass 87 / fail 0
```

No live tenant access, Conditional Access enforcement, service restart or
commit occurred.
