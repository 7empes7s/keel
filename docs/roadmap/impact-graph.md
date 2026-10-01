# Operation-specific forward and reverse dependency analysis (task-59)

Date: 2026-10-01 UTC. Status: implemented, fixture-tested only. No live
qualification is claimed; nothing here writes to a tenant.

## What was built

- `engine/graph/impact.mjs` (new) — one typed graph over resource references
  and relationship (edge) observations (tasks 57/58). Convention: `A -> B`
  means "A depends on B"; forward edges are prerequisites, reverse edges are
  dependents.
  - **restore** follows FORWARD reference edges and orders the closure with the
    existing `dependencyClosure` + `planWaves` (no second ordering
    implementation). Relationship edges are not followed (relationship restore
    is task-61).
  - **update / delete** follow REVERSE reference edges. A forward closure
    answers the wrong question for these and is never used for them. Edges
    incident to the analysed resources are disclosed as one-hop `edgeEffects`
    (nested-group expansion is not attempted).
  - **disposition** is a local governance operation: no traversal, no
    Microsoft impact (`microsoftWrites: 0`), its own key check. It is never
    modelled as a synthetic restore.
  - Traversal is cycle-safe, node/depth bounded (defaults 5000 / 50) and
    deterministic (sorted frontier). Reaching a bound lists the unexpanded
    frontier.
- **Exactness is never assumed.** `completeness.exact` is true only when
  nothing touched is hidden, stale, uncovered or truncated:
  - *hidden*: a reference no collected resource provides, or an edge to an
    unresolved target, stays in the graph (`graph.hidden`) and is reported with
    who referenced it — never dropped from the safety view;
  - *relationship coverage* (update/delete only): every touched node of a type
    with registered direct families needs a CURRENT observation for each;
    missing, stale, never-complete (with the original Graph code) and
    unsupported reads each name themselves. Derived (transitive) families are
    not required;
  - *stale*: stale-provenance references, stale relationship reads, or a graph
    older than `staleAfterMs` (24 h default) is status `stale`;
  - *bounds*: status `bounded`.
- `recheckImpact()` / `impactFingerprint()` — a stable digest of what an
  analysis claims; a mismatch at execution throws `ImpactChangedError`.
- `assessDeletePlan()` and `cli/keel-restore.mjs` — **the explicit stricter
  rule for delete operations.** Before this task, `dependencyClosure` only
  LOGGED unresolved references and a delete ran regardless of live dependents.
  Now, at execution and against the CURRENT live state just collected, a
  resource still referencing one being deleted — and neither deleted nor
  rewritten (its planned references no longer name it) by the same plan —
  refuses the run with `blocked-dependent-impact` before any write. The
  unresolved-reference LOGGING for restore/selection is unchanged.

## Implementation and proof limitations

- Fixture-tested through the production code, the existing wave planner and
  closure, and the real relationship store on the isolated test database.
- The CLI delete gate evaluates reference dependents only. Relationship-edge
  coverage is NOT evaluated there (the restore CLI does not load edge state)
  and the assessment says `relationshipCoverage: 'not-evaluated'`; absent edge
  coverage therefore does not refuse a delete today. Callers that load edge
  state (`buildImpactGraph({ relationships })`) get the full exactness rules.
  Making edge collection default-on and gating deletes on it is a product
  decision for a later task.
- Edge state is keyed by natural keys from observed snapshots; across tenants
  the caller must supply the target tenant's own state.
- `engine/restore/selection.mjs` and `engine/restore/wavePlanner.mjs` were
  reused unchanged; no ordering or closure logic was duplicated.
- Dynamic-group membership prediction is task-60; relationship restore is
  task-61.

## Boundary tests

`engine/roadmap/impact-graph.test.mjs` (15 tests) plus a CLI refusal case in
`cli/keel-restore.test.mjs`. The three required mutations were each applied
and killed:

- Use forward closure for delete.
- Drop invisible nodes from the safety graph.
- Label a stale graph exact.
