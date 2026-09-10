// engine/restore/selection.mjs
//
// Portal-design §4.1: free-form selection reproduces by hand the reference-rot
// problem the coverage design exists to prevent. Deselect a group while keeping a
// Conditional Access policy that excludes it, and the restore writes a dangling
// reference; deselect a break-glass account named in a policy's excludeUsers and
// breakGlassInvariant is silently defeated. Selection is therefore dependency-CLOSED:
// choosing a resource pulls in everything it references, and the closure — with the
// reason for every addition — is computed here, shown to the operator, and recomputed
// server-side at execution. The client-supplied closure is never trusted.
//
// The edge rule is exactly dependencyGraph.mjs's: a reference is a dependency iff it
// has a tenant-specific symbol (global: constants always resolve and never gate) AND
// that symbol names another resource in the candidate set. References pointing outside
// the candidate set are cross-snapshot/external; they are reported so the operator
// sees them, never silently dropped.
import { refuseIfSynced } from '../safety/syncedObjectGuard.mjs';

function sortedKeys(keys) {
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/**
 * Compute the reference closure of `selectedKeys` within `resources` (the candidate
 * set, in the wave-planner resource shape). Returns:
 *  - keys: every natural key in the closure, sorted;
 *  - selected: the explicitly selected keys, sorted;
 *  - added: resources pulled in transitively, each with `reasons` naming every
 *    including resource and field path ("required by X at conditions…[0]") — this is
 *    what the UI shows, because a hidden addition is an unexplained restore;
 *  - resources: the closure's resource objects (the originals, never mutated or
 *    copied), sorted by natural key, ready for planWaves;
 *  - unresolvedReferences: in-scope references whose symbol no candidate provides.
 * Throws on a selected key absent from the candidate set: restoring "something the
 * operator did not choose" silently is worse than failing loudly.
 */
export function dependencyClosure(resources, selectedKeys) {
  const nodes = new Map(resources.map((r) => [r.naturalKey, r]));
  const selected = sortedKeys(new Set(selectedKeys));
  for (const key of selected) {
    if (!nodes.has(key)) {
      throw new Error(`selected key is not present in the candidate set: ${key}`);
    }
  }

  const included = new Set(selected);
  // target -> [{ requiredBy, field }] — every reason an unselected resource entered
  // the closure. Recorded for ALL in-set references of included resources so a
  // resource required by two selections carries both requirers.
  const reasons = new Map();
  const unresolved = [];
  const queue = [...selected];
  while (queue.length) {
    const key = queue.shift();
    const resource = nodes.get(key);
    for (const ref of resource.references ?? []) {
      if (!ref.symbol || ref.symbol.startsWith('global:')) continue;
      if (!nodes.has(ref.symbol)) {
        unresolved.push({ from: key, field: ref.field, symbol: ref.symbol });
        continue;
      }
      if (!selected.includes(ref.symbol)) {
        if (!reasons.has(ref.symbol)) reasons.set(ref.symbol, []);
        const entries = reasons.get(ref.symbol);
        if (!entries.some((e) => e.requiredBy === key && e.field === ref.field)) {
          entries.push({ requiredBy: key, field: ref.field });
        }
      }
      if (!included.has(ref.symbol)) {
        included.add(ref.symbol);
        queue.push(ref.symbol);
      }
    }
  }

  const added = sortedKeys([...included].filter((key) => !selected.includes(key)))
    .map((key) => ({
      naturalKey: key,
      resourceType: nodes.get(key).resourceType,
      reasons: (reasons.get(key) ?? []).sort(
        (a, b) => a.requiredBy.localeCompare(b.requiredBy) || String(a.field).localeCompare(String(b.field)),
      ),
    }));

  return {
    keys: sortedKeys(included),
    selected,
    added,
    resources: sortedKeys(included).map((key) => nodes.get(key)),
    unresolvedReferences: unresolved.sort(
      (a, b) => a.from.localeCompare(b.from) || String(a.field).localeCompare(String(b.field)),
    ),
  };
}

/**
 * The deselect-refusal rule, §4.1: removing a resource another selection requires is
 * refused with a reason, never silently allowed. Returns the resources the selection
 * requires but does not include — empty iff the selection is already closed. Each
 * entry carries the requiring resource(s) and field path(s) as the refusal reason.
 */
export function assertSelectionClosed(resources, selectedKeys) {
  return dependencyClosure(resources, selectedKeys).added;
}

/**
 * Guard refusals at selection time, §4.1 — not at apply time. Runs the synced-object
 * guard (spec §10.6) over the closed selection so an AD-synced resource is refused
 * while the operator is still choosing, with the guard's own reason. Conditional
 * Access is never enforced anywhere; report-only enforcement stays an apply-time
 * concern inside applyWave and is deliberately not duplicated here.
 */
export function selectionGuardRefusals(resources) {
  return resources
    .map((resource) => ({ naturalKey: resource.naturalKey, result: refuseIfSynced(resource) }))
    .filter((entry) => entry.result.refused)
    .map((entry) => ({ naturalKey: entry.naturalKey, reason: entry.result.reason }))
    .sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));
}
