/**
 * Task 59: one typed impact graph over versioned resource references and
 * relationship (edge) observations, with operation-specific traversal.
 *
 * Direction convention. An edge `from -> to` means "`from` depends on `to`":
 * a resource that REFERENCES another depends on it; for relationship edges the
 * parent depends on the target it lists (group -> member, application ->
 * owner). Forward edges are prerequisites; reverse edges are dependents.
 *
 * Operation semantics (analyzeImpact):
 *  - restore     follows FORWARD reference edges: everything a restored
 *                resource needs to exist first. Orders the closure with the
 *                existing wave planner. Relationship edges are reported, not
 *                followed (relationship restore is task-61).
 *  - update      follows REVERSE reference edges: whatever depends on a
 *  - delete      resource being changed or removed. A forward closure answers
 *                the wrong question for these and is never used for them.
 *  - disposition is a LOCAL governance operation (it changes drift/baseline
 *                state, never a Microsoft object): no graph traversal, no
 *                Microsoft impact, its own key check. It is never modelled as
 *                a synthetic restore.
 * Relationship edges incident to the analysed resources are disclosed as
 * one-hop `edgeEffects` for update/delete (nested-group expansion is not
 * attempted).
 *
 * Exactness is never assumed. An impact claim is `exact` only when nothing
 * the traversal touched is hidden, stale, uncovered or truncated:
 *  - hidden: a dependency the graph cannot see (a reference no collected
 *    resource provides, an edge to an unresolved target) is KEPT in the graph
 *    and reported in `hidden` — never dropped from the safety view;
 *  - relationship coverage: every touched node of a type with registered edge
 *    families needs a CURRENT observation for each; missing, stale, never-
 *    complete and unsupported reads each name themselves;
 *  - stale: stale-provenance references, or a graph older than `staleAfterMs`;
 *  - bounds: traversal is node/depth bounded; reaching a bound lists the
 *    unexpanded frontier and is never silent.
 * Traversal is cycle-safe (visited set, sorted frontier -> deterministic).
 */
import { createHash } from 'node:crypto';
import { buildGraph } from './dependencyGraph.mjs';
import { dependencyClosure } from '../restore/selection.mjs';
import { planWaves } from '../restore/wavePlanner.mjs';
import { RELATIONSHIP_FAMILIES, ASSIGNMENT_PARENT_TYPES } from '../collect/relationships.mjs';

export const IMPACT_OPERATIONS = Object.freeze(['restore', 'update', 'delete', 'disposition']);
export const DEFAULT_IMPACT_BOUNDS = Object.freeze({ maxNodes: 5000, maxDepth: 50 });
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const byString = (a, b) => String(a).localeCompare(String(b));

/**
 * Direct relationship families a node of this type is expected to have
 * observed. Derived (transitive) families are an opt-in expansion of direct
 * edges, not separate evidence a safety claim must have, so they are excluded.
 */
export function expectedFamiliesFor(resourceType) {
  const families = Object.values(RELATIONSHIP_FAMILIES)
    .filter((spec) => spec.parentType === resourceType && spec.direction === 'direct')
    .map((spec) => spec.family);
  if (ASSIGNMENT_PARENT_TYPES.includes(resourceType)) families.push('assignment');
  return families.sort(byString);
}

const unresolvedKey = (type, id) => `unresolved:${type ?? 'object'}:${id}`;

/**
 * @param resources    wave-planner shaped resources ({ naturalKey, resourceType, references })
 * @param relationships optional loadRelationshipState() result (tasks 57/58)
 * @param observedAt   when the resource observation was made (staleness)
 */
export function buildImpactGraph({
  resources, relationships = null, observedAt = null, now = new Date(), staleAfterMs = DEFAULT_STALE_AFTER_MS,
}) {
  const nodes = new Map(resources.map((resource) => [resource.naturalKey, resource]));
  const hidden = new Map();
  const forward = new Map();
  const reverse = new Map();
  const edges = [];
  const relationshipEdges = [];
  const relationshipCoverage = new Map(); // node key -> Map<family, entry-state info>

  const touchHidden = (key, info) => {
    if (!hidden.has(key)) hidden.set(key, { key, reasons: [], referencedBy: [] });
    const node = hidden.get(key);
    node.reasons.push(info.reason);
    node.referencedBy.push(info.by);
  };
  const addEdge = (edge) => {
    edges.push(edge);
    if (!forward.has(edge.from)) forward.set(edge.from, new Set());
    forward.get(edge.from).add(edge.to);
    if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
    reverse.get(edge.to).add(edge.from);
  };

  for (const resource of resources) {
    for (const ref of resource.references ?? []) {
      if (!ref.symbol || ref.symbol.startsWith('global:')) continue; // globals always resolve
      if (!nodes.has(ref.symbol)) {
        touchHidden(ref.symbol, { reason: 'unresolved-reference', by: { from: resource.naturalKey, field: ref.field, required: ref.required === true } });
      }
      addEdge({ from: resource.naturalKey, to: ref.symbol, kind: 'reference', field: ref.field, required: ref.required === true, stale: ref.stale === true });
    }
  }

  if (relationships) {
    for (const entry of relationships.entries.values()) {
      const parentKey = entry.parentNaturalKey ?? unresolvedKey(entry.parentType, entry.parentSourceId);
      if (!nodes.has(parentKey)) touchHidden(parentKey, { reason: 'unresolved-relationship-parent', by: { from: parentKey, family: entry.family } });
      if (!relationshipCoverage.has(parentKey)) relationshipCoverage.set(parentKey, new Map());
      relationshipCoverage.get(parentKey).set(entry.family, {
        state: entry.state,
        outcome: entry.failure?.outcome ?? entry.latestOutcome ?? null,
        graphCode: entry.failure?.graphCode ?? null,
      });
      for (const target of entry.targets ?? []) {
        const targetKey = target.targetNaturalKey ?? unresolvedKey(target.targetType, target.targetId);
        if (!nodes.has(targetKey)) touchHidden(targetKey, { reason: 'unresolved-relationship-target', by: { from: parentKey, family: entry.family } });
        const edge = {
          from: parentKey, to: targetKey, kind: 'relationship', family: entry.family, edgeType: entry.edgeType,
          direction: entry.direction, stale: entry.state !== 'current', attributes: target.attributes ?? null,
        };
        relationshipEdges.push(edge);
      }
    }
  }

  const cycles = buildGraph(resources.map((r) => ({ ...r, references: r.references ?? [] }))).cycles
    .map((cycle) => [...cycle])
    .sort((a, b) => byString(a.join('>'), b.join('>')));

  const reasons = [];
  if (observedAt && now - new Date(observedAt) > staleAfterMs) reasons.push('stale-graph');
  return {
    nodes, hidden, forward, reverse, edges, relationshipEdges, relationshipCoverage, cycles,
    relationshipsLoaded: relationships !== null,
    graphStaleReasons: reasons,
  };
}

function traverse(adjacency, starts, { maxNodes, maxDepth }) {
  const visited = new Set(starts);
  const depthOf = new Map(starts.map((key) => [key, 0]));
  let frontier = [...starts].sort(byString);
  const truncated = [];
  while (frontier.length > 0) {
    const next = [];
    for (const key of frontier) {
      const depth = depthOf.get(key);
      const neighbours = [...(adjacency.get(key) ?? [])].sort(byString);
      const unvisited = neighbours.filter((n) => !visited.has(n));
      if (unvisited.length > 0 && depth >= maxDepth) { truncated.push(key); continue; }
      for (const neighbour of unvisited) {
        if (visited.size >= maxNodes) { truncated.push(key); break; }
        visited.add(neighbour);
        depthOf.set(neighbour, depth + 1);
        next.push(neighbour);
      }
    }
    frontier = next.sort(byString);
  }
  return { visited, depthOf, truncated: [...new Set(truncated)].sort(byString) };
}

function evaluateCompleteness(graph, touched, { truncated, edgesTouched, checkRelationshipCoverage }) {
  const reasons = [...graph.graphStaleReasons.map((reason) => ({ reason }))];
  const hiddenTouched = [...graph.hidden.values()]
    .filter((node) => touched.has(node.key) || node.referencedBy.some((by) => touched.has(by.from)))
    .map((node) => ({ key: node.key, reasons: [...new Set(node.reasons)].sort(byString), referencedBy: node.referencedBy }))
    .sort((a, b) => byString(a.key, b.key));
  for (const node of hiddenTouched) reasons.push({ reason: 'hidden-dependency', key: node.key });
  if (edgesTouched.some((edge) => edge.stale)) reasons.push({ reason: 'stale-reference' });

  for (const key of checkRelationshipCoverage ? [...touched].sort(byString) : []) {
    const resource = graph.nodes.get(key);
    if (!resource) continue;
    for (const family of expectedFamiliesFor(resource.resourceType)) {
      const coverage = graph.relationshipCoverage.get(key)?.get(family);
      if (!coverage) reasons.push({ reason: 'relationship-coverage-missing', key, family });
      else if (coverage.outcome === 'unsupported') reasons.push({ reason: 'relationship-unsupported', key, family });
      else if (coverage.state === 'stale') reasons.push({ reason: 'relationship-stale', key, family });
      else if (coverage.state === 'unknown') reasons.push({ reason: 'relationship-never-complete', key, family, graphCode: coverage.graphCode });
    }
  }
  if (truncated.length > 0) reasons.push({ reason: 'bounds-exceeded', frontier: truncated });

  const staleReasons = new Set(['stale-graph', 'stale-reference', 'relationship-stale']);
  let status = 'exact';
  if (reasons.length > 0) {
    if (reasons.some((r) => staleReasons.has(r.reason))) status = 'stale';
    else if (reasons.every((r) => r.reason === 'bounds-exceeded')) status = 'bounded';
    else status = 'incomplete';
  }
  return { status, exact: status === 'exact', reasons, hidden: hiddenTouched };
}

/**
 * @returns { operation, keys, impacted, closure, waves, edgeEffects, cycles,
 *            completeness: { status, exact, reasons }, hidden, truncated, fingerprint }
 */
export function analyzeImpact(graph, { operation, keys, bounds = {} }) {
  if (!IMPACT_OPERATIONS.includes(operation)) throw new Error(`unknown impact operation ${operation}`);
  const limits = { ...DEFAULT_IMPACT_BOUNDS, ...bounds };
  const selected = [...new Set(keys)].sort(byString);
  for (const key of selected) {
    if (!graph.nodes.has(key)) throw new Error(`impact key is not present in the graph: ${key}`);
  }

  if (operation === 'disposition') {
    // Local governance state only: nothing in the Microsoft graph is written,
    // so there is nothing to traverse and nothing hidden to disclose.
    const result = {
      operation, keys: selected, localGovernance: true, microsoftWrites: 0, impacted: [], closure: selected, waves: [], patches: [],
      edgeEffects: [], cycles: [], hidden: [], truncated: [],
      completeness: { status: 'exact', exact: true, reasons: [], scope: 'local-governance' },
    };
    return { ...result, fingerprint: impactFingerprint(result) };
  }

  const useForward = operation === 'restore';
  const adjacency = useForward ? graph.forward : graph.reverse;
  const { visited, truncated } = traverse(adjacency, selected, limits);
  const closureKeys = [...visited].sort(byString);
  const visibleClosure = closureKeys.filter((key) => graph.nodes.has(key));
  const impacted = closureKeys.filter((key) => !selected.includes(key)).sort(byString);

  const edgesTouched = graph.edges.filter((edge) => visited.has(edge.from) && visited.has(edge.to));
  const edgeEffects = graph.relationshipEdges
    .filter((edge) => selected.includes(edge.from) || selected.includes(edge.to) || (!useForward && (visited.has(edge.from) || visited.has(edge.to))))
    .map((edge) => ({ ...edge }))
    .sort((a, b) => byString(`${a.from}>${a.to}>${a.family}`, `${b.from}>${b.to}>${b.family}`));
  // A restore's prerequisite closure depends only on reference edges, so its
  // exactness does not need relationship coverage; update/delete impact does.
  const touched = new Set(useForward ? visited : [...visited, ...edgeEffects.flatMap((edge) => [edge.from, edge.to])]);

  const completeness = evaluateCompleteness(graph, touched, {
    truncated,
    edgesTouched: useForward ? edgesTouched : [...edgesTouched, ...edgeEffects],
    checkRelationshipCoverage: !useForward,
  });

  let waves = [];
  let patches = [];
  if (useForward) {
    // Reuse the existing closure + wave planner so ordering stays the
    // restore engine's own, never a second ordering implementation.
    const candidates = [...graph.nodes.values()];
    const closure = dependencyClosure(candidates, selected);
    ({ waves, patches } = planWaves(closure.resources));
  }

  const result = {
    operation, keys: selected, direction: useForward ? 'forward' : 'reverse', impacted, closure: closureKeys,
    visibleClosure, waves, patches, edgeEffects, cycles: graph.cycles.filter((cycle) => cycle.some((key) => visited.has(key))),
    hidden: completeness.hidden, truncated, completeness: { status: completeness.status, exact: completeness.exact, reasons: completeness.reasons },
  };
  return { ...result, fingerprint: impactFingerprint(result) };
}

/** Stable digest of what an impact analysis claims, for execution-time rechecks. */
export function impactFingerprint(result) {
  const material = {
    operation: result.operation, keys: result.keys, impacted: result.impacted, closure: result.closure,
    hidden: (result.hidden ?? []).map((node) => node.key), status: result.completeness.status,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export class ImpactChangedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImpactChangedError';
  }
}

/** Recheck at execution: the impact recorded at planning must still hold on the current graph. */
export function recheckImpact(recorded, currentGraph, { operation, keys, bounds } = {}) {
  const current = analyzeImpact(currentGraph, { operation: operation ?? recorded.operation, keys: keys ?? recorded.keys, bounds });
  if (current.fingerprint !== recorded.fingerprint) {
    throw new ImpactChangedError(`impact of ${current.operation} changed since planning (${recorded.completeness.status} -> ${current.completeness.status})`);
  }
  return current;
}

/**
 * Delete-plan gate used at execution (cli/keel-restore.mjs). Against the
 * CURRENT live resources, every resource that still references a resource
 * being deleted must itself be deleted in this plan, or be rewritten by the
 * plan so it no longer references it. Anything else would be left dangling.
 *
 * This is the explicit stricter rule introduced for delete operations: before
 * task 59, dependencyClosure only LOGGED unresolved references and a delete
 * ran regardless of live dependents. Relationship-edge coverage is not
 * evaluated here (the CLI has no loaded edge state); the returned
 * `relationshipCoverage: 'not-evaluated'` says so rather than implying it.
 */
export function assessDeletePlan({ liveResources, plannedResources }) {
  const deletes = plannedResources.filter((resource) => resource.verb === 'delete');
  if (deletes.length === 0) return { refusals: [], relationshipCoverage: 'not-evaluated', analysis: null };
  const graph = buildImpactGraph({ resources: liveResources });
  const deleteKeys = new Set(deletes.map((resource) => resource.naturalKey));
  const plannedByKey = new Map(plannedResources.map((resource) => [resource.naturalKey, resource]));
  const present = deletes.map((resource) => resource.naturalKey).filter((key) => graph.nodes.has(key));
  if (present.length === 0) return { refusals: [], relationshipCoverage: 'not-evaluated', analysis: null };
  const analysis = analyzeImpact(graph, { operation: 'delete', keys: present });

  const refusals = [];
  for (const edge of graph.edges) {
    if (edge.kind !== 'reference' || !deleteKeys.has(edge.to) || deleteKeys.has(edge.from)) continue;
    const planned = plannedByKey.get(edge.from);
    const stillReferences = !planned || planned.verb === 'delete' || (planned.references ?? []).some((ref) => ref.symbol === edge.to);
    if (stillReferences) refusals.push({ dependent: edge.from, field: edge.field, deleting: edge.to });
  }
  refusals.sort((a, b) => byString(a.deleting + a.dependent, b.deleting + b.dependent));
  return { refusals, relationshipCoverage: 'not-evaluated', analysis };
}
