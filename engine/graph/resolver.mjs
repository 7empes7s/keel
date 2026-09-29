/** Resolution order per spec §8.2 — order is load-bearing, tested explicitly.
 * Task 50 adds an optional 5th tier, `lineage` (engine/store/resourceLineage.mjs's
 * resolveNaturalKey / recovery chain, precomputed by the caller into a
 * Map<symbol, { targetId } | { ambiguous: true }>), consulted only after every
 * higher-priority source misses. A lineage match is always reported
 * `stale: true` — it resolves the target, but never as fresh current
 * authorization the way exact-match/mapping-table/prior-restore are. An
 * `ambiguous` entry (the "unrelated name reuse" case: more than one distinct
 * lineage ever held this name) always refuses rather than guessing. */
export function resolveSymbol(symbol, { targetIndex, mappingTable, runProvenance, lineage }) {
  if (symbol === null) return { resolved: false, reason: 'unresolvable-at-collection' };
  if (symbol.startsWith('global:')) return { resolved: true, targetId: symbol, via: 'global-constant' };
  if (targetIndex.has(symbol)) return { resolved: true, targetId: targetIndex.get(symbol), via: 'exact-match' };
  if (mappingTable.has(symbol)) {
    const mapped = mappingTable.get(symbol);
    if (targetIndex.has(mapped)) return { resolved: true, targetId: targetIndex.get(mapped), via: 'mapping-table' };
    return { resolved: false, reason: `mapping-table points at ${mapped}, not found in target` };
  }
  if (runProvenance.has(symbol)) return { resolved: true, targetId: runProvenance.get(symbol), via: 'prior-restore' };
  if (lineage?.has(symbol)) {
    const entry = lineage.get(symbol);
    if (entry.ambiguous) return { resolved: false, reason: 'ambiguous-alias' };
    return { resolved: true, targetId: entry.targetId, via: 'lineage-recovery', stale: true };
  }
  return { resolved: false, reason: 'not-found-in-target' };
}

export function resolvePlan(resources, ctx) {
  const resolved = [];
  const unresolved = [];
  for (const resource of resources) {
    const resolvedReferences = [];
    for (const ref of resource.references) {
      const result = resolveSymbol(ref.symbol, ctx);
      if (result.resolved) {
        resolvedReferences.push({ ...ref, targetId: result.targetId, via: result.via });
      } else {
        unresolved.push({ naturalKey: resource.naturalKey, field: ref.field, symbol: ref.symbol, required: ref.required, reason: result.reason });
      }
    }
    resolved.push({ ...resource, resolvedReferences });
  }
  return { resolved, unresolved };
}
