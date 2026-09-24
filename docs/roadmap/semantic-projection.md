# Versioned field projection and classification contracts (task-51)

Date: 2026-09-19 UTC. Status: implemented, fixture-tested only.

## What was built

- `engine/contracts/fieldProjection.mjs` (new) — the per-type, per-operation
  field contract. `reviewStateFor(resourceType)` returns `'reviewed-empty'`,
  `'unreviewed'` or `'has-rules'`, driven purely by whether the type was
  registered below — never inferred from whether its rules happen to be
  empty. `classifyForOperation(operation, path, resourceType)` resolves the
  base serverOwned/immutable/writable class via `serverOwned.mjs`'s
  `fieldClass()` (never redefined here) and narrows it per operation:
  `collection`/`comparison`/`verification` use the base class unchanged;
  `create` collapses writable and immutable to `'writable'` (both are
  settable at create per spec M2.3) unless the type is reviewed and the field
  is outside its known-field list, in which case it is `'unknown'`; `update`
  keeps the existing PATCH exclusion of serverOwned/immutable and adds the
  same `'unknown'` narrowing for writable fields a reviewed type doesn't
  name; `sensitiveExport` returns `'sensitive'` for any field a type's
  `sensitiveExport` set names, regardless of base class. `exportProjection()`
  strips exactly those sensitive fields from a payload, keeping everything
  else (export wants more context than a PATCH body, minus the fields named
  sensitive). The six original M1 types (`user`, `authenticationStrengthPolicy`,
  `group`, `roleAssignment`, `namedLocation`, `conditionalAccessPolicy`) are
  registered with explicit known-field lists; `user` and `group` also carry
  `sensitiveExport` entries (on-prem AD correlation identifiers, internal HR
  identifiers) and so read `'has-rules'`; the other four read
  `'reviewed-empty'` — reviewed, with nothing to exclude. Every other type in
  the catalogue reads `'unreviewed'`.
- `engine/cir/canonicalHash.mjs` — `canonicalize()` now excludes serverOwned
  fields via `classifyForOperation('comparison', ...)` instead of importing
  `fieldClass` directly, making the new contract the integration seam for
  drift comparison. `comparison` is defined to equal `fieldClass()` unchanged
  for every type, so no hash's byte value changed and `HASH_VERSION` stays 2.
  New `compareAcrossHashVersions(previous, next, resourceType)` compares two
  recorded rows that may carry different `hashVersion`s: equal versions
  compare hashes directly (existing behavior everywhere else in this
  codebase); different versions with both raw payloads available reproject
  both under the current rules and compare that instead of trusting the old
  hash string; different versions with a payload missing return
  `{ comparable: false, changed: null, method: 'unknown' }` rather than a
  guess.
- `engine/reconcile/writableProjection.mjs` — `writableProjection()`'s
  per-field inclusion check now goes through
  `classifyForOperation('update', ...)`, so a writable-classified field
  outside a reviewed type's known-field list is excluded from the PATCH body
  as `'unknown'` instead of silently passing through. New `unknownFields()`
  reports which top-level fields of a given payload were excluded that way,
  for a caller that wants to flag them — `null` for an unreviewed type
  (nothing to flag against, not an empty flag list). `immutableDrift()` is
  unchanged.
- `engine/cir/serverOwned.mjs` — header comment only, cross-referencing
  `fieldProjection.mjs` as the layer above it for sensitive-export and
  unknown-field behavior. `fieldClass()`, `SERVER_OWNED`, `IMMUTABLE` and
  `SERVER_OWNED_ALWAYS` are byte-for-byte unchanged.

No schema or migration was needed — this task adds no persisted rows, only
in-process classification.

## Implementation and proof limitations

- Everything here is fixture-tested against synthetic payloads and the
  production classification code paths. No live tenant was touched; collector
  and restorer credentials were not used, and Conditional Access is never
  enforced.
- Unknown-field detection is top-level only: a new nested property inside an
  already-known composite field (`conditions`, `grantControls`, ...) is not
  flagged. Deep schema review of nested Graph objects is out of this task's
  scope.
- `classifyForOperation('create', ...)` and `exportProjection()` are pure,
  tested functions with no production call site yet: `applyEngine.mjs`'s
  create verb currently sends `resource.payload` directly to Graph (after
  reference rewriting) without any field projection, and no export/evidence
  surface calls `exportProjection()` yet. Wiring either in is left to a task
  that owns those files; this task only had `engine/cir/serverOwned.mjs`,
  `engine/cir/canonicalHash.mjs`, `engine/reconcile/writableProjection.mjs`
  and `engine/contracts/fieldProjection.mjs` in scope.
- `compareAcrossHashVersions()` is likewise not yet wired into
  `engine/govern/diffSnapshots.mjs`, which still throws on a `hash_version`
  mismatch between two compared rows — a safe but coarser refusal than this
  contract's reprojection-or-unknown split. That file is outside this task's
  scope; the new function is ready for a future task to adopt.
- The known-field lists for the six registered types are reviewed against
  their current `$select` plus fields observed on historical unfiltered
  reads. Read-projection completeness — whether Graph could return a field no
  fixture or historical read has ever surfaced — remains unknown unless
  independently evidenced; a silent gap in a known-field list would currently
  read as `'unknown'` (safe: excluded from writes) rather than `'writable'`.

## Boundary tests

`engine/roadmap/semantic-projection.test.mjs` exercises the production
`fieldProjection.mjs`, `canonicalHash.mjs` and `writableProjection.mjs`
against adversarial fixtures, including the three required mutation checks:

- Comparing raw payloads instead of the `comparison` projection would turn a
  serverOwned-only change into manufactured drift; the projected comparison
  must not.
- Inferring review state from an empty rules map instead of registration
  would read an unregistered type as `'reviewed-empty'`; it must read
  `'unreviewed'`.
- Treating hashes from two different `hashVersion`s as directly comparable
  would manufacture a changed verdict from differing raw hash strings alone;
  `compareAcrossHashVersions()` must reproject and find them unchanged.

It also covers the other acceptance cases: sensitive fields never survive
`exportProjection()`; a synthetic new field on a reviewed type is `'unknown'`
and excluded from `writableProjection()`'s output while an unreviewed type's
behavior is untouched; immutable fields are settable at `'create'` but not
`'update'`; and an unknown resource type still throws exactly as
`fieldClass()` always has.
