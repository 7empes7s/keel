import { buildGraph, topoWaves } from '../graph/dependencyGraph.mjs';

/** Spec §9.1–§9.2, §8.4. Cyclic references are excluded from wave ordering
 * (dependencyGraph.mjs already breaks them deterministically) and instead
 * returned as `patches` — resources created without that one field in their
 * own wave, patched once every node they depend on exists. */
export function planWaves(resources) {
  const graph = buildGraph(resources);
  const waves = topoWaves(graph);

  const patches = [];
  for (const cycle of graph.cycles) {
    const sorted = [...cycle].sort();
    const from = sorted[0];
    const to = cycle[(cycle.indexOf(from) + 1) % cycle.length];
    const resource = graph.nodes.get(from);
    const ref = resource.references.find((r) => r.symbol === to);
    if (ref) patches.push({ naturalKey: from, field: ref.field, symbol: to });
  }

  return { waves, patches };
}
