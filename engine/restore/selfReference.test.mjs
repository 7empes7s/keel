// Regression for the live-tenant restore failure where `roleAssignment create`
// and `authenticationFlowsPolicy update` could not be planned: the planner
// reported the resource's OWN id as a deferred reference patch on `id`, which
// no type can apply ("unsupported operation: no proven deferred reference patch").
//
// Cause: canonicalizeAll indexes the resource's lowercased id before
// extracting references, walkKnownSymbolValues then yields the id in its
// original case, and classify() compared that mixed-case id against the
// lowercased ownIdentifiers() set. Mixed-case ids (base64 roleAssignment ids,
// singleton ids such as "authenticationFlowsPolicy") were therefore not
// recognised as identity and became a resolvable reference to the resource
// itself: a one-node cycle and an unapplyable patch on `id`.
import { strict as assert } from 'node:assert';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { buildGraph } from '../graph/dependencyGraph.mjs';
import { planWaves } from './wavePlanner.mjs';

const GA_ROLE_TEMPLATE = '62e90394-69f5-4237-9190-012177145e10';
const user = { id: '5c3f1c2a-7b1e-4c0a-9d2e-0a1b2c3d4e5f', userPrincipalName: 'ana@contoso.com' };
// Real roleAssignment ids are mixed-case base64 strings.
const roleAssignment = {
  id: 'lAPpYvVpN0KRkAEhaxZ-ipPNLXCy5RJDqU-xEUmBmJ4-1',
  roleDefinitionId: GA_ROLE_TEMPLATE,
  principalId: user.id,
  directoryScopeId: '/',
};
// Graph singletons carry their type name as a mixed-case id.
const flowsPolicy = {
  id: 'authenticationFlowsPolicy',
  displayName: 'Authentication flows policy',
  selfServiceSignUp: { isEnabled: false },
};

const resources = canonicalizeAll([
  ['user', [user]],
  ['authenticationFlowsPolicy', [flowsPolicy]],
  ['roleAssignment', [roleAssignment]],
]);
const byKey = Object.fromEntries(resources.map((r) => [r.naturalKey, r]));
const raKey = `roleAssignment:global:GlobalAdministrator@user:${user.userPrincipalName}@/`;
assert.ok(byKey[raKey], `expected ${raKey}, got ${Object.keys(byKey).join(', ')}`);
assert.ok(byKey['authenticationFlowsPolicy:authenticationFlowsPolicy']);

// No resource references itself, and nothing is a reference on its own `id`.
for (const r of resources) {
  const self = r.references.filter((ref) => ref.symbol === r.naturalKey);
  assert.deepEqual(self, [], `${r.naturalKey} references itself via ${self.map((s) => s.field).join(', ')}`);
  assert.ok(!r.references.some((ref) => ref.field === 'id'), `${r.naturalKey} has a reference on its own id field`);
}

// No self-edge and no cycle in the graph.
const graph = buildGraph(resources);
for (const [key, deps] of graph.edges) assert.ok(!deps.has(key), `${key} has a self-edge`);
assert.deepEqual(graph.cycles, []);

// No deferred patch, in particular none on `id`; every resource lands in a wave.
const { waves, patches } = planWaves(resources);
assert.deepEqual(patches, []);
assert.deepEqual(new Set(waves.flat()), new Set(resources.map((r) => r.naturalKey)));

// Snapshots taken before the fix already store such a self-reference. The
// graph must not turn it into a cycle or an `id` patch either.
const stored = resources.map((r) => (r.naturalKey === raKey
  ? { ...r, references: [...r.references, { field: 'id', symbol: raKey, required: true, klass: 'resolvable' }] }
  : r));
const storedGraph = buildGraph(stored);
assert.ok(!storedGraph.edges.get(raKey).has(raKey), 'stored self-reference produced a self-edge');
assert.deepEqual(storedGraph.cycles, []);
assert.deepEqual(planWaves(stored).patches, []);

console.log('selfReference.test.mjs — all assertions passed');
