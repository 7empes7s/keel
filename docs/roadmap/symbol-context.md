# Tenant-scoped historical identity context for collection (task-48)

Date: 2026-09-27 UTC. Status: implemented, fixture-tested only.

## What was built

- `engine/store/schema.sql` — new additive, idempotent `resource_symbol` table:
  one row per (`tenant_ref`, `resource_type`, `source_id`) carrying the natural
  key the Graph source id resolved to, the observation window
  (`first_seen_at`/`last_seen_at`), the evidencing `source_snapshot` and a
  `tombstoned_at` state (null while live). Every row is tenant-qualified; no
  read or write path can observe or mutate another tenant's aliases.
- `engine/store/resourceSymbols.mjs` — the context store:
  - `loadSymbolContext` returns the tenant's live (non-tombstoned) aliases as
    the fallback map the canonicalizer consumes.
  - `recordSymbolContext` persists aliases from successful type outcomes
    (`complete` / `complete-empty`) only; the current batch always overrides
    persistent context (rename updates the key, re-observation clears a
    tombstone). Only a successful full per-type enumeration may tombstone the
    ids it did not observe — `failed`, `partial` and `not-requested` outcomes
    never tombstone and never write. The tombstone pass iterates the adapter's
    real per-type outcomes (not just the types a resource was built for), so a
    `complete-empty` enumeration — zero live ids, still a success — correctly
    tombstones every previously live alias of that type instead of leaving
    them live forever.
  - Source ids are normalized to lowercase at both write paths
    (`recordSymbolContext`, `seedSymbolContext`) because every lookup site in
    `canonicalize.mjs` queries the context with `guid.toLowerCase()`. Real
    Graph responses do not guarantee consistent letter casing for the same
    GUID across endpoints or runs; storing anything but the lowercase form
    would desync from those lookups and degrade a resolvable historical id to
    `unknown:<guid>`.
  - `seedSymbolContext` bootstraps the context from preexisting successful
    snapshots (newest first; legacy bare-count digests count as success only
    when nonzero). It only INSERTs missing aliases — historical
    `resource_version` keys are never rewritten — and is retry-safe.
- `engine/cir/canonicalize.mjs` — `canonicalizeAll(collected, { context })`
  accepts the optional persistent context as a strict fallback for reference
  classification and roleAssignment composed keys: the current batch and
  global constants always win. Resolutions served from history are recorded
  as stale provenance on the resource's `provenance.symbolContext`
  (`staleReferences`, `staleKeyParts`) and as `stale: true` on the reference —
  in the provenance jsonb, separate from the payload the semantic hash covers,
  so hash semantics are unchanged. Ids absent from both batch and context stay
  `unknown:<guid>` exactly as before. Global template types stay excluded from
  the context (exported `CONTEXT_EXCLUDED_TYPES`, shared with `idKey`).
- `engine/collect/snapshot.mjs` — `collectSnapshot` loads (and, when empty,
  lazily seeds) the tenant's context before canonicalizing, and records the
  context after the snapshot completes. Recording uses the full
  canonicalization (every successfully read type, before the tier storage
  filter) and the adapter's real per-type outcomes, so collections at any tier
  update the context while the stored digest keeps its not-requested markers.
  Before canonicalizing, types this run fully enumerated — `complete` **or**
  `complete-empty` — are filtered out of the in-memory context so a genuinely
  re-enumerated absence within the same run degrades to `unknown:<guid>`
  rather than resolving a since-deleted id from stale history; the matching DB
  tombstones are written afterward by `recordSymbolContext`.

Missing bootstrap context stays unresolved and can never authorize anything:
the context is a read-side identity lookup only, and the staleness provenance
lets any writer distinguish a current observation from a historical one.

## Implementation and proof limitations

- Everything here is fixture-tested against the isolated test database with a
  fake Graph reader seam. No live tenant was touched; collector and restorer
  credentials were not used, and Conditional Access is never enforced.
  Live-qualified evidence remains absent.
- Aliases resolve by source id alone within a tenant; Graph ids are
  tenant-unique in practice, and cross-tenant resolution is blocked by the
  mandatory `tenant_ref` qualification on every query.
- A tombstone means "absent from the latest successful full enumeration of
  that type", not "deleted in the tenant" — it only retires the alias from
  resolution. Historical snapshots keep their original stored keys either way.
- Context-resolved identity is as fresh as its last successful observation;
  consumers must read `symbolContext` staleness provenance rather than
  treating historical resolution as current state.
- Seeding trusts the stored `natural_key` of successful historical snapshots
  as-is; it recomputes nothing and therefore cannot repair preexisting key
  defects.

## Boundary tests

`engine/roadmap/symbol-context.test.mjs` exercises the production
canonicalizer, snapshot persistence and context store against adversarial
fixtures: the tier1 roleAssignment → tier2 user reproduction keeping its
resolved key across a failed user read, stale provenance on composed keys and
references, unknown ids staying unknown, current-batch-over-context override,
rename and UPN-reuse identity preservation, partial-read and complete-empty
tombstone rules (including a complete-empty enumeration tombstoning
previously live aliases with no new observations of that type), a
complete-empty read in the *current* run excluding that type's stale context
before canonicalizing (so a genuinely-deleted roleDefinition degrades to
unknown instead of resolving through history in the same run), mixed-case
Graph GUID resolution through history, tier-filtered runs updating context
while storing not-requested, cross-tenant isolation with a shared source id,
and lazy seeding from legacy bare-count and structured digests — plus the
three required mutation checks (persistent context skipped in composed keys,
tombstoning after a partial read, dropped tenant qualification).

## Requeue verification — 2026-09-27

The task implementation and 15 boundary tests were already present in the
working tree. Inspection against the plan and parked patch found no missing
production implementation. The remaining verification gap was the existing
`engine/collect/entraAdapter.test.mjs`: it authenticated to the live tenant,
so previous offline verification stopped it and exited 1.

That test now injects a fixture reader into the same production `collectM1`
entry point. Its type-presence, nonempty policy/assignment and canonicalization
assertions remain enabled. Additional assertions check organization-scoped
requests and resolved role-assignment keys and policy references. It accesses
no tenant configuration or credentials and performs no network requests.
This is fixture evidence only; live rehearsal belongs to the orchestrator.

The existing CLI imports `collectSnapshot`, integrating historical context
through the shared collection entry point. Existing authorization and credential
selection remain at their entry points; the identity store grants no write
authority. Apply the existing schema migration mechanism before using the new
collector. `CREATE TABLE/INDEX IF NOT EXISTS` is retry-safe; lazy seeding handles
legacy successful snapshots without changing their stored keys.

All three required mutations were applied individually, exercised against the
15 task tests, and restored byte for byte in a `finally` block:

| Mutation | Exit | Pass | Fail |
| --- | --- | --- | --- |
| Skip persistent context in composed keys | 1 | 8 | 7 |
| Tombstone after partial read | 1 | 14 | 1 |
| Remove tenant qualification from context loading | 1 | 11 | 4 |

Each mutation failed with assertions, not setup or import errors. The complete
roadmap validation command ran without preloads, skipped tests or exemptions:

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/symbol-context.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

The first run passed all collection and task tests but failed the existing
`engine/authz/administration.test.mjs:21` assertion (`false == true`). Inspection
shows that this immediate grant/resolve comparison mixes database microsecond
and JavaScript millisecond timestamps, a possible timing-sensitive boundary.
No authorization code or assertion was changed. After mutation restoration,
the exact full command exited 0 with this output:

```text
1..29
# tests 29
# suites 0
# pass 29
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3574.479733
```

Full TAP output and mutation logs are temporary session artifacts in
`/tmp/keel-task48-requeue/`. No live tenant access, Conditional Access enforcement,
service restart or commit occurred. Collector/restorer separation is unchanged.

## Requeue verification — 2026-09-28

An independent review found a fourth, derived defect surviving mutation: the
tombstone `UPDATE` in `recordSymbolContext` (`engine/store/resourceSymbols.mjs`)
already carries a `tenant_ref = $1` qualifier in production source, but no
existing test exercised a cross-tenant scenario capable of catching its
removal. With two tenants sharing a source id but one holding an additional
tenant-only id, dropping the `tenant_ref` qualifier from the `UPDATE` (while
keeping the query otherwise valid — parameter `$1` was replaced with a
tautology, not removed, to isolate the tenant-scoping defect from a bind-count
error) let tenant B's complete-empty-immune, same-type full enumeration
tombstone tenant A's unrelated alias. All 15 existing tests still passed
under this mutation — the gap was real and PoC-confirmed.

Closed by extending the existing `tenant qualification: aliases never cross
tenants (mutation pin 3)` test in `engine/roadmap/symbol-context.test.mjs`
with mutation pin (3b): after tenant B's complete user enumeration (which
observes only the shared id), the test now reads tenant A's tenant-only alias
row directly via `symbolRow` (bypassing `loadSymbolContext`'s own tenant
filter, so this pins the `UPDATE`'s qualifier specifically) and asserts
`tombstoned_at` is still `null`. Verified against the mutated source: the
extended test fails (`actual: <timestamp>` vs `expected: null`) with the
qualifier dropped, and passes with it restored. No production code changed —
the `tenant_ref` qualifier was already correct; only the missing regression
coverage was added. Full validation command re-run after restoring the
mutated file byte-for-byte:

```text
1..29
# tests 29
# suites 0
# pass 29
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

No live tenant access, Conditional Access enforcement, service restart or
commit occurred.
