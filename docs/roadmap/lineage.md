# Stable resource lineage across rename and recovery (task-50)

Date: 2026-09-29 UTC. Status: implemented, fixture-tested only.

## What was built

- `engine/store/schema.sql` — three new additive, idempotent tables:
  - `resource_lineage`: one durable row per (`tenant_ref`, `resource_type`,
    `source_id`) — the logical resource identity. A rename never regenerates
    this row (it is the same Graph object keeping its own id); only a genuinely
    new or recreated source id starts a new one. Carries an explicit
    `tombstoned_at`, mirroring task-48's `resource_symbol` tombstone rule.
  - `resource_lineage_alias`: every natural key a lineage has ever held, each
    with an explicit `valid_from`/`valid_until` window. At most one row per
    lineage is open (`valid_until IS NULL`) at a time, enforced by a partial
    unique index. A closed row is history only.
  - `resource_lineage_recovery`: the sole mechanism allowed to unify two
    *different* lineages (hence two different source ids) into one continuous
    history — a recreation the collector cannot see as a same-id rename.
    Requires non-empty `evidence`, distinct predecessor/successor lineages, and
    a predecessor that is already tombstoned; name reuse alone is never
    sufficient.
- `engine/store/resourceLineage.mjs` — the lineage store:
  - `recordLineage` finds-or-creates the lineage row and, on a natural-key
    change, closes the currently open alias and opens a fresh one at the
    observation time — an explicit window, not an in-place rewrite. Current
    observation always overrides persisted state, including clearing a
    tombstone on re-observation (undelete), exactly like task-48.
  - `tombstoneMissingLineages` retires every live lineage of a type absent from
    a full successful enumeration; callers must never invoke it for a
    failed/partial read.
  - `currentLineageFor` / `naturalKeyAsOf` answer "what does this source id
    resolve to now" and "what did this lineage resolve to at time T" — the
    latter is how a historical snapshot resolves the identity that was current
    *when it was taken*, never today's latest name.
  - `resolveNaturalKey` resolves a bare name back to its lineage with no time
    anchor: a single live (non-tombstoned, currently-open-alias) holder
    resolves cleanly (`stale: false`); absent one, every lineage that ever held
    the name is considered — exactly one candidate resolves as a stale
    historical match, more than one is genuinely ambiguous and refuses
    (`ambiguous-alias`) rather than guessing.
  - `recordRecovery` / `recoveryChainFor` record and walk evidenced
    predecessor→successor links to an effective root identity.
  - `loadRecoveryContext` is shaped exactly like task-48's `loadSymbolContext`
    (`Map<lowercase source id, { symbol, type }>`) so `canonicalize.mjs` can
    consume it through the same resolution codepath, keyed by the tombstoned
    *predecessor's* source id and resolving to the successor's current name.
- `engine/cir/canonicalize.mjs` — `canonicalizeAll(collected, { context, lineage })`
  gains `lineage` as a second, lower-priority fallback consulted only when both
  the current batch and task-48's `context` miss: the one case `context`
  structurally cannot cover, a tombstoned id whose lineage has an evidenced
  recovery link. Resolutions through it carry the same stale provenance
  (`provenance.symbolContext`, `stale: true` on the reference) as `context`
  resolutions — never current authorization for a write. `context` still wins
  when both would resolve the same guid.
- `engine/graph/resolver.mjs` — `resolveSymbol`/`resolvePlan` gain an optional
  5th resolution tier, `lineage` (a caller-precomputed
  `Map<symbol, { targetId } | { ambiguous: true }>`), consulted only after
  exact-match, mapping-table and prior-restore all miss. A match is always
  reported `stale: true`; an `ambiguous` entry always refuses. The existing
  four-tier order and behavior are unchanged when `lineage` is omitted.
- `engine/govern/diffSnapshots.mjs` — `diffSnapshots(baselineRows, observedRows, { lineageOf })`
  gains an optional lineage-aware pass: a natural key that disappeared and a
  *different* one that appeared collapse into a single `modified` entry
  (`renamedFrom`, `lineageId`) only when both resolve to the *same* lineage id
  — same-source-id rename, or an evidenced recovery chain. Different or absent
  lineage ids are never merged. Symmetrically, when the *same* natural key is
  present on both sides but resolves to two different lineage ids (the name
  was freed and reused by an unrelated resource inside the diff window), the
  result is split into a removed+added pair instead of one misleading
  `modified` row. Both behaviors are fully inert (`lineageOf` omitted) for
  every existing caller.

## Implementation and proof limitations

- Everything here is fixture-tested against the isolated test database. No
  live tenant was touched; collector/restorer credentials were not used, and
  Conditional Access is never enforced.
- **Production wiring is intentionally partial.** This task's file scope does
  not include `engine/collect/snapshot.mjs`, `cli/keel-plan.mjs`,
  `engine/restore/applyEngine.mjs` or `cli/keel-drift.mjs`. Concretely:
  - `collectSnapshot` does not yet call `recordLineage`/`tombstoneMissingLineages`
    automatically during collection — the store is fully functional and
    boundary-tested but not yet fed by the live pipeline.
  - `resolveSymbol`'s new `lineage` tier and `diffSnapshots`' new `lineageOf`
    parameter are additive capabilities exercised directly by
    `engine/roadmap/lineage.test.mjs`; no production caller (`cli/keel-plan.mjs`,
    `engine/restore/applyEngine.mjs`, `cli/keel-drift.mjs`) constructs and
    passes a lineage map yet, so both remain inert (`lineage`/`lineageOf`
    default to absent) in the current production paths.
  - `diffSnapshots`' rename-merge and same-key-reuse-split outputs are shaped
    to stay compatible with `cli/keel-drift.mjs`'s existing persistence (no new
    `change_type` value; `'modified'`/`'removed'`/`'added'` only), but a future
    wiring task should note that the `drift` table's
    `UNIQUE (baseline_id, observed_snapshot, natural_key)` constraint cannot
    yet hold the same-key-reuse-split's two rows sharing one `natural_key`
    without a schema change there.
  - A future wiring task should build the caller-side `lineageOf`/`lineage`
    maps from `resource_lineage_alias`/`resource_lineage_recovery` (via
    `recoveryChainFor` for the effective identity) and feed them into these
    call sites.
- `resolveNaturalKey`'s ambiguity check is name-scoped per tenant/type; it does
  not attempt to disambiguate using any other signal (time proximity, payload
  similarity) — by design, per the global constraint that elapsed time is
  never treated as evidence.
- Recovery evidence is stored opaquely (`jsonb`); this module does not validate
  its shape or provenance — only that it is present, non-empty and attached to
  a genuinely tombstoned predecessor and a distinct successor.

## Boundary tests

`engine/roadmap/lineage.test.mjs` exercises the production lineage store,
`diffSnapshots.mjs`, `resolver.mjs` and `canonicalizeAll` against the isolated
test database and adversarial fixtures: a same-source-id rename preserving the
lineage id and closing the old alias window, a historical snapshot resolving
its then-current identity via `naturalKeyAsOf`, an expired alias resolving as
explicitly stale (never current), a rename collapsing into one `diffSnapshots`
entry versus the legacy removed+added shape without lineage information, an
unrelated new source id reusing a freed name never merging into the old
lineage, the same natural key resolving to two different lineages splitting
into removed+added, an alias two distinct tombstoned lineages both held
refusing as ambiguous (in both `resourceLineage.mjs` and `resolver.mjs`),
`recordRecovery`'s evidence/distinctness/tombstoned-predecessor guards,
`canonicalizeAll` resolving a recovery-linked predecessor id through the
recovery context (with `context` still taking priority when both apply), and
`tombstoneMissingLineages`' re-observation-clears-tombstone lifecycle — plus
the three required mutation checks (merging resources solely by reused name,
resolving an expired alias as current, dropping the recovery provenance
requirement).

An independent review flagged that `recordRecovery`'s and `loadRecoveryContext`'s
existing `tenant_ref` filters had no adversarial test forcing a second tenant
into play, so removing either filter would not have failed the suite. Two
tests close that gap: `recordRecovery` refuses a predecessor or successor
lineage id that resolves under a *different* tenant (`unknown-predecessor`/
`unknown-successor`, never a silent cross-tenant link), and `loadRecoveryContext`
returns only the calling tenant's recovery-linked symbols even when two tenants
share the identical (colliding) source id — the scenario a tenant-blind query
would have let one tenant's row silently overwrite the other's in the returned
map.

A follow-up review found that `recoveryChainFor`'s existing `tenant_ref` filter
had the identical gap: the filter was present in the implementation, but no
test forced a second tenant's recovery row into the walk, so dropping the
filter would not have failed the suite. One test closes it: a forged
`resource_lineage_recovery` row is inserted directly for tenant B whose
`successor_id` happens to equal tenant A's lineage id, and `recoveryChainFor`
called as tenant A must return only `[la]`, never walking into tenant B's
predecessor.

A further review found `diffSnapshots`' `if (!beforeLineage) continue;` guard
(the check that a removed candidate's lineage is actually known before it is
even considered for a rename merge) had no adversarial test: removing that
single line left every existing test green, because `lineageOf(after) ===
beforeLineage` evaluates `undefined === undefined` to `true` and silently
matches any two rows whose lineage is unknown on both sides. One test closes
it: two genuinely unrelated rows, both with a `lineageOf` that returns
`undefined`, must stay a plain removed+added pair rather than collapsing into
a false `modified`/renamed entry.

Also re-ran (not part of this task's Validate command, but touched files'
existing consumers): `engine/graph/resolver.test.mjs`,
`engine/govern/diffSnapshots.test.mjs`, `engine/contract.test.mjs`,
`engine/contract-m2.test.mjs`, `engine/roadmap/symbol-context.test.mjs`,
`engine/roadmap/tier-scoping.test.mjs` and `engine/restore/applyEngine.test.mjs`
— all pass unmodified, confirming the new optional parameters are fully
backward compatible.
