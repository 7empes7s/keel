# Scope Graph reads by tier without changing identity (task-49)

Date: 2026-09-28 UTC. Status: implemented, fixture-tested only.

## What was built

- `engine/collect/entraAdapter.mjs` — `collectWithOutcomes(reader, { tenantId, tier })`
  now selects each M1 type's adapter by descriptor criticality **before** any
  HTTP read. When `tier` is set and a type's `criticality` does not match it,
  the loop never calls `adapter.collectRaw` for that type at all — the digest
  entry is written directly as the explicit not-requested marker
  (`{ outcome: 'not-requested', itemCount: null }`), never a fetched-then-
  discarded `complete`/`complete-empty` outcome. An unset `tier` keeps the
  prior full-scan behavior unchanged: every M1 type is still fetched.
- `engine/collect/snapshot.mjs` — `collectSnapshot` now passes `tier` straight
  into `collectWithOutcomes` and no longer re-derives a second, post-hoc
  coverage digest or storage filter: since excluded types were never fetched,
  `result.collected` already holds only the requested tier's types (or every
  type when unscoped), and `result.coverageDigest` already carries the
  not-requested marker for everything this run did not attempt. The tenant-
  scoped historical identity context (task-48,
  `engine/store/resourceSymbols.mjs`) is unchanged and does the real work of
  cross-tier reference resolution: a tier-excluded type's outcome is never
  `complete`/`complete-empty`, so `recordSymbolContext` neither refreshes nor
  tombstones its aliases from a scoped run, and `canonicalizeAll`'s context
  fallback still resolves a same-run reference to an excluded type's object
  from whatever identity a prior (any-tier) run already recorded for it.
- `engine/roadmap/tier-scoping.test.mjs` — new boundary test file covering the
  acceptance criteria and the three required mutations below.
- `engine/roadmap/symbol-context.test.mjs` — the one pre-existing tier
  assertion (`all tiers update context; tier-excluded types stay
  not-requested in storage`) encoded the pre-task-49 behavior: it let the
  reader mock actually answer a tier2 `/users?` call under a `tier: 'tier1'`
  request and asserted the tier-filtered run still recorded that identity in
  context. That was true only because the old implementation fetched every
  type and filtered the *stored* digest afterward while feeding the *real*
  (pre-filter) digest to `recordSymbolContext`. Task 49 removes that
  post-hoc split by design, so the type is genuinely never fetched under
  scoping and its context is genuinely never touched by that run. The test is
  replaced by two tests that assert the corrected contract: a tier-scoped run
  reaches no excluded endpoint and leaves that type's existing context alone,
  and a second test proving the actual cross-tier reproduction — a tier1
  roleAssignment resolving its tier2 principal from a *prior* run's history,
  with the reader throwing if `/users` is ever called during the scoped run.
  No other existing test in the repository asserted the old fetch-then-filter
  behavior (verified: `grep -rn tier` across `engine/roadmap/*.test.mjs`,
  `engine/coverage/report.test.mjs`, `engine/collect/*.test.mjs`; every other
  tier-related assertion checks digest/storage shape only, not the reader's
  call log or the identity context, so none needed updating).
- `engine/collect/registry.mjs` and `engine/cir/canonicalize.mjs` needed no
  changes: `registry.get(type)` already exposed `descriptor.criticality` for
  the new pre-fetch selection, and `canonicalizeAll`'s persistent-context
  fallback (built in task-48) already resolved cross-type references and
  composed keys from history with correct stale provenance — task 49 only
  needed to stop shadowing that mechanism with a full, unscoped fetch.

## Implementation and proof limitations

- Everything here is fixture-tested against the isolated test database with a
  fake Graph reader seam that throws if an excluded-tier endpoint is ever
  called. No live tenant was touched; collector and restorer credentials were
  not used, and Conditional Access is never enforced.
- Cross-tier resolution is exactly as good as the tenant's persisted identity
  context: a type that was never observed by any prior run (any tier) stays
  unresolved (`unknown:<guid>`) under a scoped run, by design — there is no
  live fallback fetch of an excluded endpoint to "catch up" a reference.
- A tier-scoped run never refreshes or tombstones the identity context for
  types it did not fetch; only a run that actually observes a type (any tier
  selection that includes it, or an unscoped run) can update or retire its
  aliases. This matches the acceptance criterion that a later weekly
  (broader) update becomes available to the next scoped hourly run, and that
  a scoped run introduces no spurious add/delete drift purely from context
  metadata, since a stable historical resolution yields a stable composed
  natural key across consecutive scoped runs.
- The `certificateBasedAuthConfiguration` type is the only descriptor with
  `needsOrgId: true`; its `tenantId` bootstrap comes from the caller-supplied
  config value (`collectSnapshot`'s `tenantId` argument), not from an
  in-run `organization` fetch, so it is unaffected by `organization` being
  excluded under a tier that does not include it.

## Boundary tests

`engine/roadmap/tier-scoping.test.mjs` exercises the production adapter
registry, entra adapter and snapshot persistence: M1 types span all three
tiers (a sanity precondition for the rest of the suite), an excluded type is
never fetched and its digest is the explicit not-requested marker, an unset
tier retains the full scan, not-requested is distinct in shape from a genuine
complete-empty read, tier1 storage keeps only tier1 resources, the real
user/roleDefinition/roleAssignment cross-tier reproduction (a tier1
roleAssignment resolving its tier2 principal from persisted history with zero
calls to the tier2 endpoint), a cross-tier reference with no prior history
stays explicitly unresolved rather than inventing a fallback fetch, a later
weekly update becomes available to the next hourly run without rewriting the
earlier historical snapshot's key, and zero spurious add/delete drift between
two consecutive tier1 runs resolving the same historical context — plus the
three required mutation checks below.

## Mutation verification — 2026-09-28

All three required mutations were applied individually to the production
source, exercised against `engine/roadmap/tier-scoping.test.mjs` (plus
`engine/roadmap/symbol-context.test.mjs`, and for mutation 3 also
`engine/roadmap/outcomes.test.mjs` and `engine/coverage/report.test.mjs`), and
restored byte-for-byte from a backup copy immediately afterward:

| Mutation | Result |
| --- | --- |
| Filter after collection instead of before (tier check short-circuited to always fetch every type) | 7 failures in tier-scoping.test.mjs/symbol-context.test.mjs |
| Remove cross-tier fallback (`canonicalizeAll` called with `context: undefined`) | 9 failures in the same files |
| Label unrequested type complete-empty (`{ outcome: 'not-requested', itemCount: null }` → `{ outcome: 'complete-empty', itemCount: 0 }`) | 9 failures across tier-scoping.test.mjs, symbol-context.test.mjs, outcomes.test.mjs, report.test.mjs |

Each mutation failed with real assertion mismatches (resolved natural keys
degrading to `unknown:<guid>`, reader call counts/logs including excluded
endpoints, digest shape mismatches), not setup or import errors. Mutation 3
additionally demonstrated a real cascading defect beyond digest shape: because
`recordSymbolContext`/`canonicalizeAll`'s same-run exclusion both key off
`outcome === 'complete-empty'`, mislabeling a not-requested type as
complete-empty makes a scoped run treat it as a successful full (empty)
enumeration — tombstoning that type's previously-live aliases and stripping
its historical context from the same-run resolution, breaking cross-tier
reference resolution entirely rather than merely mislabeling a digest field.

A prior independent review (2026-09-28, requeue) flagged one derived mutation
as surviving: `organization` silently exempted from the tier check (fetched
under tier2/tier3 despite being `criticality: 'tier1'`). This was closed by
adding the dedicated test `derived mutation "organization exempted from the
tier check"` in `engine/roadmap/tier-scoping.test.mjs`. Re-verified 2026-09-29:
injecting `type !== 'organization' &&` into the tier-check guard in
`collectWithOutcomes` (`engine/collect/entraAdapter.mjs`) made that test fail
(`organization` fetched under tier2/tier3 instead of staying not-requested);
the file was restored byte-for-byte afterward and the full validation command
below confirmed clean (24/24).

After restoring both files, the exact validation command from the plan ran
clean with no preloads, skipped tests or exemptions:

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/tier-scoping.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

```text
1..23
# tests 23
# suites 0
# pass 23
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1439.336151
```

No live tenant access, Conditional Access enforcement, service restart or
commit occurred. Collector/restorer credential separation is unchanged — this
task touches no credential-handling code.
