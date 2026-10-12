# Identity checks must normalise case the same way on both sides (2026-10-12)

## What happened

On the live test tenant, `roleAssignment create` and `authenticationFlowsPolicy update`
could not be planned. The restore planner reported each resource's own id as a required
deferred reference patch on `id`, and no type can apply such a patch
(`engine/restore/applyEngine.mjs`: "unsupported operation: no proven deferred reference patch").

## Cause

A self-reference created by a one-sided lowercase:

- `ownIdentifiers()` (`tools/tenant-probe/references.mjs`) lowercases the resource's own ids.
- `walkGuids` lowercases every GUID it yields, so GUID ids matched.
- `walkKnownSymbolValues` (`engine/cir/canonicalize.mjs`) yields ids in their original case,
  because `canonicalizeAll` indexes the lowercased id in `idToSymbol` before the resource is built.
- `classify()` did `ownIds.has(guid)` with the original-case value.

Mixed-case ids (base64 roleAssignment ids, singleton ids such as `authenticationFlowsPolicy`,
branding localisation ids) were therefore not recognised as identity. The id resolved to the
resource's own symbol, `buildGraph` reported a one-node cycle, and `planWaves` emitted a patch
on `id`.

## Rule

When a lookup set is built with a normalisation (lowercase, trim, NFC), every probe into it
must apply the same normalisation at the point of comparison, not rely on the caller having
done it. Put the normalisation inside the function that owns the set (`classify` now does
`ownIds.has(guid.toLowerCase())`), and add a fixture with a mixed-case id whenever a new
id-shaped value enters a lookup.

Also: a dependency graph must never carry a self-edge. `buildGraph` now drops a reference whose
symbol is the resource's own key, so snapshots stored before this fix plan cleanly too.

## A test had encoded the bug

`engine/roadmap/closure-ceiling.test.mjs` expected a second `PATCH /groups/target-Privileged`
and described it as "the wave planner's deferred reference patch for the Finance<->Privileged
edge". The fixture has no such edge: the patch was the self-cycle on `group:Privileged` (its
mixed-case target id `target-Privileged` classified as a reference to itself) patching `id`,
and the fake Graph accepted it. When a test asserts a write it cannot explain from the fixture,
treat that write as a bug, not as a contract.

## Fixture

`engine/restore/selfReference.test.mjs` runs a mixed-case roleAssignment and an
`authenticationFlowsPolicy` singleton through canonicalize, graph and wave planning and asserts
no self-reference, no self-edge, no cycle and no patch on `id`.
