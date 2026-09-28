# Detect Microsoft API and catalog drift (task-62)

Date: 2026-09-22 UTC. Status: implemented, fixture-tested only. No live
qualification is claimed.

## What was built

- `tools/qualification/apiDrift.mjs` (new) — the bounded, scheduled fetcher
  and CLI entry point. `fetchMetadataSource()` performs one conditional GET
  against a configured official Microsoft Graph metadata/OpenAPI source, time-
  bounded by `AbortController` and size-bounded on both the `Content-Length`
  header and the streamed body; it never throws for a transport/HTTP failure,
  instead returning a discriminated `{ status }` of `fetched`, `not-modified`
  (a `304`), `timeout`, `oversized` or `unknown` (network failure, non-2xx or
  unparsable body). `parseCsdl()`/`parseOpenApi()` extract a minimal,
  intentionally narrow comparison model (`EntitySet`/`Singleton` names and
  `EntityType` field signatures for CSDL; endpoint paths only for OpenAPI).
  `runApiDrift()` runs one pass over the configured sources against the
  tenant's persisted pins and returns `{ results, ok }`, where `ok` is `false`
  whenever any source read as `timeout`/`oversized`/`unknown` — a job-queue
  worker fails visibly rather than recording a silent no-op run.
  `runApiDriftCli()`/`main()` follow the existing `keel-collect`/
  `keel-baseline-create` CLI conventions (injectable `connect`/`fetchImpl`
  dependencies, `runCli()` exit codes, tenant ref derived from the config
  file). This tool sends no credentials anywhere — the metadata endpoints are
  anonymous — and never touches tenant data.
- `engine/coverage/catalogDrift.mjs` (new) — everything after the bytes
  arrive. `buildComparisonModel()` builds the compact per-source model
  (document version, full endpoint-name list, and field signatures of
  catalog-mapped types only — bounded by the catalog's size, not the
  metadata's). `diffCatalog()` diffs that model against the explicit
  mappings in `tools/tenant-probe/catalog.mjs`, emitting three finding kinds:
  `added-endpoint` (a metadata endpoint no catalog entry maps, `resourceType:
  null`), `removed-endpoint` (a catalog mapping whose endpoint vanished) and
  `changed-field` (`removed`/`type`/`nullable` on a mapped type, requiring a
  previously pinned model — the first observed fetch establishes the
  baseline only). A purely additive field is deliberately never a finding.
  `recordSourceState()` persists the outcome of one source check: only a
  `fetched` outcome moves the pin (etag/digest/date/version/model); a `304`
  proves the pin current without moving it; every failure status updates only
  `last_status`/`last_error`/`last_checked_at`, so a network failure can never
  be read as "no changes". `persistCandidates()` inserts findings as review
  candidates keyed by `(tenant, source, kind, path, field)` with `ON CONFLICT
  DO NOTHING`, so a repeat fetch of unchanged metadata never duplicates a
  finding; every row carries the source `proof` (digest, ETag, source date,
  metadata version, fetch instant, URL) it was observed under. This module
  never registers a type, adds a descriptor, grants a permission or calls
  `engine/coverage/capabilities.mjs` — the only status a candidate can hold
  is `review`, enforced by the table `CHECK`.
- `engine/store/schema.sql` — two new tables. `api_drift_source` pins the
  last successfully fetched metadata per `(tenant_ref, source_key)`.
  `api_drift_candidate` holds review candidates only, with a `status text
  CHECK (status IN ('review'))` closed inventory and the dedupe unique index
  described above. `job_kind_check` and the `schedule.job_kind` comment gain
  the new `api-drift` kind, following the exact pattern of the pre-existing
  kinds — additive, idempotent (`ADD CONSTRAINT`/`ADD COLUMN IF NOT EXISTS`),
  and safe to re-run against a database that already has these tables.
- `engine/jobs/queue.mjs` — `apiDriftIdempotencyKey(tenantRef, periodKey)`
  and `enqueueApiDriftRun()` fold tenant and cadence period into one
  idempotency key (`api-drift:<tenantRef>:<periodKey>`), so a scheduler (or
  an operator) firing the same period twice gets the existing job back
  instead of a duplicate comparison run — reusing the existing `enqueue()`/
  idempotency-key machinery rather than a parallel dedupe mechanism.
- `cli/keel-worker.mjs` — a new `api-drift` entry in `JOB_HANDLERS`,
  dispatching to `tools/qualification/apiDrift.mjs` with a whitelisted
  `--config`/`--sources` argument surface, following the exact shape of every
  other handler in this table.
- `engine/authz/jobCapabilities.mjs` — `api-drift` is mapped to the existing
  `collect` capability (a read-only, anonymous metadata comparison run on the
  same operator cadence as collection); no new capability was invented.
- `engine/store/scheduleSeed.mjs` — a sixth default schedule row,
  `{ jobKind: 'api-drift', tier: null, cadence: weekly, atTime: '03:00' }`:
  official Graph metadata drifts slowly, so weekly is the default cadence,
  operator-tunable through the `schedule` row exactly like every other kind.

## Implementation and proof limitations

- Everything here is fixture-tested: `fetchImpl` is always injected in tests,
  `globalThis.fetch` is used only by the real worker/CLI invocation, and no
  network call is ever made during validation. No live tenant is touched;
  the fetched documents are anonymous Microsoft-published metadata, no
  collector or restorer credential is used by this task, and Conditional
  Access is never enforced.
- `parseCsdl()` is intentionally not a general XML/CSDL parser: it reads the
  flat, well-known shapes of a Graph `$metadata` document (`EntitySet`,
  `Singleton`, `EntityType` with `Property`/`NavigationProperty` children).
  `BaseType` inheritance, complex types and function/action imports are out
  of scope — an unrecognized shape fails the whole parse (the source then
  reads `unknown`) rather than silently diffing a half-read model.
  `parseOpenApi()` contributes endpoint paths only; it carries no field
  signatures, so OpenAPI sources participate in added/removed-endpoint
  findings but never changed-field findings.
- Findings are REVIEW CANDIDATES ONLY. Nothing in this task extends
  `tools/tenant-probe/catalog.mjs`, adds a descriptor, grants a permission or
  changes any `engine/coverage/capabilities.mjs` claim — an added endpoint or
  a changed field can never become writable through this path. Promoting a
  candidate into an actual catalog/capability change is a distinct, deliberate
  operator/engineering action outside this task's scope.
- `catalogEndpointName()` matches a catalog entry to a metadata endpoint by
  the last literal (non-parameter) path segment — a heuristic. A mismatch
  costs an operator a confusing review row, never an automatic change, since
  every emitted row is `status = 'review'` by construction.
- The default source list (`DEFAULT_SOURCES`) covers the Graph v1.0 and beta
  CSDL `$metadata` documents only; other Microsoft 365 workload metadata
  (SharePoint, Teams, Exchange, etc. — out of this task's scope per the
  September 15 review's workstream boundaries) is not fetched.
- No portal/UI surface exists for reviewing candidates in this task; the
  named integration is the scheduled job plus the CLI. `listCandidates()` is
  the read seam a future UI/report task can consume, matching the same
  "CLI/engine first, UI later" boundary already used by task-56.
- Size and time bounds (`DEFAULT_TIMEOUT_MS = 30s`, `DEFAULT_MAX_BYTES = 32
  MiB`) are enforced on both the declared `Content-Length` header and the
  actual streamed body, independently — a source that lies about its length
  is still bounded by the stream check.

## Boundary tests

`engine/roadmap/api-drift.test.mjs` exercises the production
`tools/qualification/apiDrift.mjs` and `engine/coverage/catalogDrift.mjs`
modules against adversarial fixtures and the isolated test database
(`engine/test/dbTestHelper.mjs`), including the three required mutation
checks:

- Auto-enable discovered endpoint: after a full drift pass that discovers a
  genuinely new endpoint (`newThings`), every capability claim for the
  discovered type stays `unsupported`, and the catalog, descriptor registry
  and an existing type's capability summary are asserted byte-identical
  before and after the pass — under the mutation, a discovered endpoint
  would register a claim or extend the catalog.
- Equate fetch failure with no changes: a thrown network error and an
  unparsable body are both asserted `status: 'unknown'`, `ok: false`, and to
  leave the pin (digest/etag/model) and the candidate list exactly as they
  were before the failed run — under the mutation, a failure would either
  move the pin or be recorded as `not-modified`.
- Ignore source size limit: an oversized document (bounded to 128 bytes) is
  asserted to leave `last_status: 'oversized'`, `digest: null` and zero
  inserted candidates — under the mutation, an unbounded body would be
  digested and diffed.

It also covers the remaining acceptance cases: a full drift pass producing an
added-endpoint and a removed-endpoint candidate with full source proof; a
changed field (type change and field removal) becoming a `changed-field`
candidate while a purely additive field is not a finding; a duplicate fetch
(identical bytes, and a `304`) inserting zero duplicate candidates; a timed-
out fetch bounded by `timeoutMs` and never minting a pin; tenant scoping and
legacy-empty reads; `persistCandidates` refusing a raw/unhashed `tenantRef`
before any row is written; the closed `CANDIDATE_KINDS` inventory and mandatory
`proof`; `enqueueApiDriftRun` idempotency across tenant and cadence period;
worker/capability wiring (`api-drift` rides the `collect` capability, never a
parallel gate); and a CLI end-to-end run whose exit code reflects source
health (`0` for a healthy pass across all default sources, `1` when any
source is unknown/timeout/oversized), with the resulting candidate count
verified against the same production `buildComparisonModel`/`diffCatalog`
functions run directly against the real `CATALOG` — never a hand-picked
number disconnected from the actual catalog contents.
