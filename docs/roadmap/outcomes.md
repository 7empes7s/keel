# Structured per-type collection outcomes (task-47)

Date: 2026-09-18 UTC; consumer coverage pins added 2026-09-19 UTC. Status: implemented, fixture-tested only.

## What was built

- `tools/tenant-probe/graph.mjs` — `redactSecrets()` strips bearer tokens,
  JWT-shaped strings and long token-shaped runs from error messages at the
  read boundary; `GraphReader.get` redacts every error message it returns, and
  `GraphReader.collect` now also reports the last successful page status while
  continuing to return the accumulated `items`/`pages` when a walk fails
  mid-pagination, so a second-page failure keeps its first-page evidence.
- `engine/collect/entraAdapter.mjs` — the graph-native adapter exposes
  `collectRaw` (structured result, throws only on precondition violations)
  alongside the fail-fast `collect` used by planning/restore.
  `collectWithOutcomes` now writes a structured digest entry per attempted
  type: `outcome` ∈ `complete | complete-empty | partial | failed` plus, where
  evidenced, `httpStatus`, `graphCode`, redacted `error`, `endpoint`,
  `apiVersion`, `startedAt`/`completedAt` and `pagesCompleted`. A second-page
  failure records `partial` with the first-page count preserved; a first-page
  failure records `failed` with unknown cardinality (never an invented zero);
  a successful empty read records `complete-empty` and remains a strict
  coverage success. Unobserved fields are null — nothing is invented.
- `engine/collect/snapshot.mjs` — tier-filtered snapshots now record excluded
  types explicitly as `{ outcome: 'not-requested', itemCount: null }` instead
  of silently omitting them.
- `engine/coverage/snapshots.mjs` — `latest_type_coverage` skips not-requested
  mentions (they are not observations and must never shadow an older genuine
  one); `readCoverageOutcome` treats `complete-empty` exactly like `complete`
  (strict success) and never covers `partial`/`not-requested`; new
  `readOutcome`/`readOutcomeDetail` normalize the outcome vocabulary and the
  structured evidence for report consumers, redacting messages again at the
  read boundary so even hand-written or pre-redaction rows cannot leak
  token-shaped values. Legacy entries (bare counts, message-only objects)
  keep their exact prior meaning with null detail — no invented evidence.
- `engine/contracts/observation.mjs` — legacy reads additionally normalize the
  extended outcome vocabulary (`complete-empty` → complete, `partial` →
  partial, `not-requested` → unknown) and prefer an entry's own
  `startedAt`/`completedAt` window over the snapshot run bounds when present.
- `engine/coverage/report.mjs` — each type entry now carries `outcome`
  (normalized vocabulary or null for pre-vocabulary digests) and `detail`
  (structured evidence or null), sourced from the newest observation or, for
  types with no observation, from the latest run's explicit not-requested
  marker. Statuses, summary counts and staleness semantics are unchanged.
- Consumers: `engine/govern/baseline.mjs` accepts `complete-empty` as the
  strict success it is (baseline eligibility unchanged in meaning);
  `cli/keel-collect.mjs` exits nonzero on `partial` as it already did on
  `failed` (its exit-code decision is now an exported, fixture-tested seam:
  `runCollect`/`main` take injected dependencies like `keel-plan.mjs`, and the
  direct CLI invocation is unchanged); the portal coverage surface
  (`portal/lib/types.ts`, `portal/lib/portal-data.ts`,
  `portal/components/coverage-report.tsx`) passes `outcome`/`detail` through
  and annotates partial reads and not-requested types.

No schema migration was needed: `snapshot.coverage_digest` is jsonb and the
new fields are additive. Legacy-read handling lives in the readers above, so
preexisting rows (bare counts, message-only entries, contract-v1 entries)
read exactly as before.

## Implementation and proof limitations

- Everything here is fixture-tested against the isolated test database and
  fake reader/fetch seams. No live tenant was touched; collector and restorer
  credentials were not used, and Conditional Access is never enforced.
  Live-qualified evidence for these outcomes remains absent.
- `partial` preserves the count of items actually read before the failure; it
  is a partial count, never a cardinality claim. A capped enumeration records
  `partial` with the sampled count and `pagination incomplete`.
- Observation timestamps on digest entries are collector clock readings at the
  adapter; transport failures that throw before/around the read record only
  the attempt window.
- Redaction is pattern-based (JWT shape, `Bearer <token>`, long token-shaped
  runs). It is applied at the reader, the adapter and again at the report read
  boundary, but a secret that matches none of these shapes in a third-party
  message would survive — messages are evidence, not a secret channel.
- Old digests are normalized, not rewritten: historical rows keep their
  original content and read with `unknown` evidence level and null detail
  where they carry no structured fields.

## Boundary tests

`engine/roadmap/outcomes.test.mjs` exercises the production reader, adapter,
snapshot persistence and report against adversarial fixtures: second-page
failure with a bearer token in the Graph message, first-page denial, empty
success, capped pagination, tier exclusion over an older full run, and legacy
bare-count/message-only digests — plus the three mutation checks (discarded
Graph code, second-page failure marked complete, unavailable outcome rewritten
to complete-empty). It also pins the consumer behavior the mutations targeted:
the thrown-exception path redacts bearer/JWT material from both `Error` and
non-`Error` rejections before a digest entry exists; baseline eligibility
accepts `complete-empty` and rejects `partial`/`failed`/`not-requested`/missing
types; and the `keel-collect` exit code fails on `partial` and `failed` while
`complete`, `complete-empty` and `not-requested` keep a zero exit.
