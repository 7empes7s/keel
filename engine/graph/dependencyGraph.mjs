/**
 * Nodes are natural keys. Edges are tenant-specific symbol references only —
 * global constants (spec §6.1's "always resolves") never gate a wave, since
 * they need no target-tenant object to exist first.
 */
export function buildGraph(resources) {
  const nodes = new Map(resources.map((r) => [r.naturalKey, r]));
  const edges = new Map();
  for (const r of resources) {
    const deps = new Set(
      r.references
        .filter((ref) => ref.symbol && !ref.symbol.startsWith('global:') && nodes.has(ref.symbol))
        .map((ref) => ref.symbol),
    );
    edges.set(r.naturalKey, deps);
  }
  const cycles = findCycles(nodes, edges);
  return { nodes, edges, cycles };
}

function findCycles(nodes, edges) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...nodes.keys()].map((k) => [k, WHITE]));
  const cycles = [];

  function visit(key, stack) {
    color.set(key, GRAY);
    stack.push(key);
    for (const dep of edges.get(key) ?? []) {
      if (color.get(dep) === GRAY) {
        const cycleStart = stack.indexOf(dep);
        cycles.push(stack.slice(cycleStart));
      } else if (color.get(dep) === WHITE) {
        visit(dep, stack);
      }
    }
    stack.pop();
    color.set(key, BLACK);
  }

  for (const key of nodes.keys()) if (color.get(key) === WHITE) visit(key, []);
  return cycles;
}

/**
 * Kahn's algorithm, breaking cycles by dropping one edge per detected cycle
 * (deterministic: the edge from the lexicographically-first node in the
 * cycle). This guarantees every node appears in some wave; it does NOT decide
 * how a cyclic write is split — that is applyEngine's two-phase-apply job
 * (Task 17), which reads `graph.cycles` directly to know which edges to defer.
 */
export function topoWaves(graph) {
  const inDegree = new Map([...graph.nodes.keys()].map((k) => [k, 0]));
  const forward = new Map([...graph.nodes.keys()].map((k) => [k, new Set()]));
  const brokenEdges = new Set(
    graph.cycles.map((cycle) => `${[...cycle].sort()[0]}->${cycle[(cycle.indexOf([...cycle].sort()[0]) + 1) % cycle.length]}`),
  );

  for (const [key, deps] of graph.edges) {
    for (const dep of deps) {
      const edgeId = `${key}->${dep}`;
      if (brokenEdges.has(edgeId)) continue;
      forward.get(dep).add(key);
      inDegree.set(key, inDegree.get(key) + 1);
    }
  }

  const waves = [];
  const remaining = new Set(graph.nodes.keys());
  while (remaining.size) {
    const wave = [...remaining].filter((k) => inDegree.get(k) === 0);
    if (!wave.length) throw new Error('topoWaves: no progress — unbroken cycle remains');
    wave.sort((a, b) => (graph.nodes.get(b).restorePriority - graph.nodes.get(a).restorePriority) || a.localeCompare(b));
    for (const key of wave) {
      remaining.delete(key);
      for (const dependent of forward.get(key)) inDegree.set(dependent, inDegree.get(dependent) - 1);
    }
    waves.push(wave);
  }
  return waves;
}
