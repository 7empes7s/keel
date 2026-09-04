import { strict as assert } from 'node:assert';
import { buildGraph, topoWaves } from './dependencyGraph.mjs';

function res(naturalKey, refs, restorePriority = 100) {
  return { naturalKey, resourceType: naturalKey.split(':')[0], restorePriority,
    references: refs.map((symbol) => ({ field: 'x', symbol, required: true, klass: 'resolvable' })) };
}

const group = res('group:FIN-Admins', []);
const namedLoc = res('namedLocation:Corp-IPs', []);
const roleAssign = res('roleAssignment:global:GA@group:FIN-Admins@/', ['group:FIN-Admins'], 200);
const ca = res('conditionalAccessPolicy:Require-MFA', ['group:FIN-Admins', 'namedLocation:Corp-IPs'], 150);
// A global-constant reference must NOT create a graph edge — it always resolves,
// regardless of collection order, so it must never gate a wave.
const caGlobalOnly = res('conditionalAccessPolicy:Global-Only', ['global:GlobalAdministrator']);

const graph = buildGraph([group, namedLoc, roleAssign, ca, caGlobalOnly]);
assert.equal(graph.nodes.size, 5);
assert.deepEqual([...graph.edges.get('roleAssignment:global:GA@group:FIN-Admins@/')], ['group:FIN-Admins']);
assert.deepEqual([...graph.edges.get('conditionalAccessPolicy:Global-Only')], []);

const waves = topoWaves(graph);
const waveOf = (key) => waves.findIndex((w) => w.includes(key));
assert.ok(waveOf('group:FIN-Admins') < waveOf('roleAssignment:global:GA@group:FIN-Admins@/'));
assert.ok(waveOf('group:FIN-Admins') < waveOf('conditionalAccessPolicy:Require-MFA'));
assert.ok(waveOf('namedLocation:Corp-IPs') < waveOf('conditionalAccessPolicy:Require-MFA'));
// A resource with only global-constant references has no dependency edges at
// all, so it lands in the first wave alongside the true leaves.
assert.equal(waveOf('conditionalAccessPolicy:Global-Only'), 0);

// Cycle handling (§8.4): two synthetic resources referencing each other. No
// real M1 Entra type pair naturally cycles — this proves the mechanism works
// generically, since a later milestone (application + servicePrincipal + role)
// will hit real cycles.
const a = res('testResourceA:1', ['testResourceB:1']);
const b = res('testResourceB:1', ['testResourceA:1']);
const cyclicGraph = buildGraph([a, b]);
assert.equal(cyclicGraph.cycles.length, 1);
assert.deepEqual(new Set(cyclicGraph.cycles[0]), new Set(['testResourceA:1', 'testResourceB:1']));
// A cyclic pair still appears in topoWaves — two-phase apply (create without
// the cyclic ref, patch later) is the restore engine's job (Task 13), not the
// graph builder's; the builder's contract is only to report the cycle and
// still produce a total ordering by breaking it deterministically.
const cyclicWaves = topoWaves(cyclicGraph);
assert.ok(cyclicWaves.flat().includes('testResourceA:1'));
assert.ok(cyclicWaves.flat().includes('testResourceB:1'));

console.log('dependencyGraph.test.mjs — all assertions passed');
