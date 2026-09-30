# First-class group membership and owner observations (task-57)

Date: 2026-09-30 UTC. Status: implemented, fixture-tested only. No live
qualification is claimed; nothing here mutates a tenant, and no write
capability is implied by observing an edge.

## What was built

- `engine/collect/relationships.mjs` (new) — the child-read collector and
  store. Group **members**, **owners** and (opt-in) **transitive members** are
  read as separate paginated child collections
  (`/groups/{id}/members|owners|transitiveMembers?$select=id`, v1.0). A parent
  payload never proves its edges: a `members` field on the parent is ignored.
  Each parent x family read is one observation with tenant, parent lineage
  (`parentSourceId`, `parentNaturalKey`), edge type, direction
  (`direct`/`transitive`), endpoint/API version, start/end window, pages
  completed, HTTP status, Graph code, redacted error and targets. Outcomes use
  the type digest's vocabulary: `complete`, `complete-empty`, `partial`,
  `failed`. A second-page error, a page-cap cut, or an item with no id is
  `partial`; a thrown or empty-error read is `failed` with unknown cardinality.
- `engine/store/schema.sql` — additive `relationship_edge_set` (one row per
  child read per snapshot) and `relationship_edge`, both `tenant_ref`-qualified
  (`CREATE TABLE IF NOT EXISTS`, retry-safe; no legacy data to migrate).
- `loadRelationshipState()` — per (parent, family) state from completed
  snapshots of one tenant: `current` (newest read complete), `stale` (newest
  read failed/partial; the LAST complete read stays visible with its failure),
  `unknown` (never read completely; targets is null).
- `engine/govern/diffSnapshots.mjs` — `diffRelationships()` emits
  `added`/`removed` edge drift (`groupMembership`, `groupOwnership`,
  `groupTransitiveMembership`, the last flagged `derived: true`). A
  membership-only change is drift even when the parent hash is unchanged. Only
  a `current` observed set is authority for a change; stale/unknown sets and
  baselines without targets are reported in `unverified` and never as
  removals. States from two tenants are refused.
- `engine/collect/snapshot.mjs` — `collectSnapshot(..., { relationships })`
  opt-in (`true` or `{ families }`); edge reads are recorded beside, never
  inside, the type digest, so an edge failure cannot change a type outcome.
- `engine/coverage/report.mjs` — the group entry reports
  `relationshipCompleteness: 'partial'` plus per-family current/stale/unknown
  counts once edges exist. It is never `complete`: app grants, assignments and
  other child families are not collected. Every other type stays `unknown`.

## Implementation and proof limitations

- Everything is fixture-tested through the production code with an injected
  Graph reader and the isolated test database. Endpoint paths follow the
  Graph v1.0 group relationship collections; they were not re-verified against
  live Graph, and no tenant was read.
- Edges are opt-in per snapshot run; the schedule/worker does not enable them
  yet. Dynamic-group membership is observed as ordinary members; predicting
  it is task-60.
- Target natural keys resolve only from the task-48 symbol context (targets
  of types outside the M1 catalog stay unresolved but are kept).
- No portal surface beyond widening the `relationshipCompleteness` type.
- Membership restore is task-61; nothing here can write.

## Boundary tests

`engine/roadmap/relationship-observations.test.mjs` (14 tests) covers the
three required mutations, each independently applied and killed:

- Derive membership from parent only (parent `members` becoming edges).
- Treat child failure as empty.
- Discard an edge whose target was never collected.

Further pinned boundaries: multi-page and transitive edges stay separate and
complete; a second-page error and a thrown read are partial/failed; an empty
complete set differs from a failed read; wrong-tenant observations and
snapshots are rejected before any write; states are tenant-scoped; a failed
read leaves last-known members stale and produces no removal; a genuinely
emptied group is removal drift; a failed edge read does not alter the type
digest; the report never says `complete`.
