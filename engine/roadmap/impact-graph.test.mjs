/**
 * Roadmap task-59 boundary tests: operation-specific forward and reverse
 * dependency analysis. Exercises the production engine/graph/impact.mjs, the
 * existing wave planner/closure it reuses, the real relationship store
 * (tasks 57/58) on the isolated test database, and the delete gate that
 * cli/keel-restore.mjs applies at execution — including the three required
 * mutation checks:
 *
 * - Use forward closure for delete.
 * - Drop invisible nodes from safety graph.
 * - Label stale graph exact.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  buildImpactGraph, analyzeImpact, recheckImpact, assessDeletePlan, expectedFamiliesFor, ImpactChangedError,
} from '../graph/impact.mjs';
import { collectRelationships, recordRelationships, loadRelationshipState } from '../collect/relationships.mjs';
import { createSnapshot, completeSnapshot } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const res = (naturalKey, resourceType, refs = [], extra = {}) => ({
  naturalKey, resourceType, payload: {}, references: refs.map(([symbol, field = 'ref', more = {}]) => ({ symbol, field, required: true, ...more })),
  restorePriority: 100, ...extra,
});

// A group referenced by a role assignment, which a CA policy also references.
const GROUP = res('group:Finance', 'group');
const ROLE = res('roleAssignment:Reader@group:Finance', 'roleAssignment', [['group:Finance', 'principalId']]);
const POLICY = res('conditionalAccessPolicy:Finance-MFA', 'conditionalAccessPolicy', [['group:Finance', 'conditions.users.includeGroups[0]']]);
const USER = res('user:alice', 'user');
const TREE = [GROUP, ROLE, POLICY, USER];

/** loadRelationshipState-shaped state for tests that do not need the database. */
function relState(entries, tenantRef = 'sha256:t') {
  const map = new Map();
  for (const entry of entries) {
    map.set(`${entry.parentType}:${entry.parentSourceId}|${entry.family}`, {
      parentType: 'group', parentSourceId: 'g1', parentNaturalKey: 'group:Finance', edgeType: entry.family, direction: 'direct',
      state: 'current', latestOutcome: 'complete', targets: [], failure: null, ...entry,
    });
  }
  return { tenantRef, entries: map };
}
const fullCoverage = () => relState([{ family: 'member' }, { family: 'owner' }]);

// --------------------------------------------------- restore: forward closure

test('restore follows forward edges and orders prerequisites before dependents', () => {
  const graph = buildImpactGraph({ resources: TREE });
  const result = analyzeImpact(graph, { operation: 'restore', keys: [ROLE.naturalKey] });
  assert.equal(result.direction, 'forward');
  assert.deepEqual(result.closure, ['group:Finance', 'roleAssignment:Reader@group:Finance']);
  assert.deepEqual(result.waves, [['group:Finance'], ['roleAssignment:Reader@group:Finance']], 'the prerequisite is created first');
  assert.ok(!result.closure.includes(POLICY.naturalKey), 'a sibling dependent is not a prerequisite');
});

// ---------------------------------------------------- delete: reverse closure

test('deleting a parent sees every transitive reverse dependent (not the forward closure)', () => {
  const nested = [...TREE, res('auditRule:ForRole', 'auditRule', [['roleAssignment:Reader@group:Finance']])];
  const graph = buildImpactGraph({ resources: nested });
  const result = analyzeImpact(graph, { operation: 'delete', keys: ['group:Finance'] });
  assert.equal(result.direction, 'reverse');
  assert.deepEqual(result.impacted, [
    'auditRule:ForRole', 'conditionalAccessPolicy:Finance-MFA', 'roleAssignment:Reader@group:Finance',
  ]);
  const forward = analyzeImpact(graph, { operation: 'restore', keys: ['group:Finance'] });
  assert.deepEqual(forward.impacted, [], 'forward closure of the parent is empty: it would miss every dependent');
  assert.equal(analyzeImpact(graph, { operation: 'update', keys: ['group:Finance'] }).impacted.length, 3, 'update shares delete reverse semantics');
});

test('unrelated resources are not impacted', () => {
  const result = analyzeImpact(buildImpactGraph({ resources: TREE }), { operation: 'delete', keys: ['user:alice'] });
  assert.deepEqual(result.impacted, []);
});

// ---------------------------------------------------------------------- cycles

test('a cycle terminates deterministically and is reported', () => {
  const cyclic = [res('group:A', 'group', [['group:B']]), res('group:B', 'group', [['group:A']]), res('group:C', 'group', [['group:A']])];
  const a = analyzeImpact(buildImpactGraph({ resources: cyclic }), { operation: 'delete', keys: ['group:A'] });
  const b = analyzeImpact(buildImpactGraph({ resources: [...cyclic].reverse() }), { operation: 'delete', keys: ['group:A'] });
  assert.deepEqual(a.impacted, ['group:B', 'group:C']);
  assert.deepEqual(a, { ...b, fingerprint: a.fingerprint, hidden: b.hidden, completeness: b.completeness }, 'input order does not change the analysis');
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.cycles.length, 1);
  const restore = analyzeImpact(buildImpactGraph({ resources: cyclic }), { operation: 'restore', keys: ['group:A'] });
  assert.deepEqual(restore.closure, ['group:A', 'group:B']);
  assert.equal(restore.patches.length, 1, 'the existing planner defers one edge of the cycle');
});

// ------------------------------------------- hidden nodes stay in the graph

test('an unresolved reference stays in the graph as a hidden node and blocks an exact claim', () => {
  const resources = [GROUP, res('roleAssignment:Orphan', 'roleAssignment', [['group:Missing', 'principalId']])];
  const graph = buildImpactGraph({ resources });
  assert.ok(graph.hidden.has('group:Missing'), 'the invisible node is kept, not dropped');
  const result = analyzeImpact(graph, { operation: 'restore', keys: ['roleAssignment:Orphan'] });
  assert.deepEqual(result.hidden.map((node) => node.key), ['group:Missing']);
  assert.equal(result.hidden[0].referencedBy[0].required, true);
  assert.equal(result.completeness.exact, false);
  assert.equal(result.completeness.status, 'incomplete');
  assert.ok(result.completeness.reasons.some((r) => r.reason === 'hidden-dependency' && r.key === 'group:Missing'));
});

test('an edge to an unresolved target is kept as a hidden node', () => {
  const state = relState([{ family: 'member', targets: [{ edgeKey: 'u9', targetId: 'u9', targetType: 'user', targetNaturalKey: null }] }, { family: 'owner' }]);
  const graph = buildImpactGraph({ resources: TREE, relationships: state });
  assert.ok(graph.hidden.has('unresolved:user:u9'));
  const result = analyzeImpact(graph, { operation: 'delete', keys: ['group:Finance'] });
  assert.ok(result.hidden.some((node) => node.key === 'unresolved:user:u9'));
  assert.equal(result.completeness.exact, false);
  assert.ok(result.edgeEffects.some((e) => e.to === 'unresolved:user:u9'), 'the membership effect is disclosed');
});

// ------------------------------------------- edge coverage gates exactness

test('without relationship coverage a delete of a group is never an exact claim', () => {
  const none = analyzeImpact(buildImpactGraph({ resources: TREE }), { operation: 'delete', keys: ['group:Finance'] });
  assert.equal(none.completeness.exact, false);
  assert.deepEqual(none.completeness.reasons.filter((r) => r.reason === 'relationship-coverage-missing').map((r) => r.family).sort(), expectedFamiliesFor('group'));
  const partial = analyzeImpact(buildImpactGraph({ resources: TREE, relationships: relState([{ family: 'member' }]) }), { operation: 'delete', keys: ['group:Finance'] });
  assert.deepEqual(partial.completeness.reasons.map((r) => r.family), ['owner']);
});

test('current coverage of every expected family allows an exact claim; a stale, failed or unsupported read does not', () => {
  const exact = analyzeImpact(buildImpactGraph({ resources: TREE, relationships: fullCoverage() }), { operation: 'delete', keys: ['group:Finance'] });
  assert.equal(exact.completeness.status, 'exact');
  assert.equal(exact.completeness.exact, true);

  const stale = analyzeImpact(buildImpactGraph({
    resources: TREE, relationships: relState([{ family: 'member', state: 'stale' }, { family: 'owner' }]),
  }), { operation: 'delete', keys: ['group:Finance'] });
  assert.equal(stale.completeness.status, 'stale');
  assert.equal(stale.completeness.exact, false);

  const failed = analyzeImpact(buildImpactGraph({
    resources: TREE,
    relationships: relState([{ family: 'member', state: 'unknown', targets: null, failure: { outcome: 'failed', graphCode: 'Authorization_RequestDenied' } }, { family: 'owner' }]),
  }), { operation: 'delete', keys: ['group:Finance'] });
  assert.equal(failed.completeness.status, 'incomplete');
  assert.equal(failed.completeness.reasons[0].graphCode, 'Authorization_RequestDenied');

  const unsupported = analyzeImpact(buildImpactGraph({
    resources: [res('deviceConfiguration:Baseline', 'deviceConfiguration')],
    relationships: relState([{ parentType: 'deviceConfiguration', parentSourceId: 'd1', parentNaturalKey: 'deviceConfiguration:Baseline', family: 'assignment', state: 'unknown', targets: null, failure: { outcome: 'unsupported' } }]),
  }), { operation: 'delete', keys: ['deviceConfiguration:Baseline'] });
  assert.ok(unsupported.completeness.reasons.some((r) => r.reason === 'relationship-unsupported'));
  assert.equal(unsupported.completeness.exact, false);
});

test('a restore does not need relationship coverage for its prerequisite closure', () => {
  const result = analyzeImpact(buildImpactGraph({ resources: TREE }), { operation: 'restore', keys: [ROLE.naturalKey] });
  assert.equal(result.completeness.exact, true);
});

// ------------------------------------------------------------------- staleness

test('a stale graph is labeled stale, never exact', () => {
  const observedAt = new Date('2026-09-01T00:00:00Z');
  const now = new Date('2026-09-30T00:00:00Z');
  const old = analyzeImpact(buildImpactGraph({ resources: TREE, relationships: fullCoverage(), observedAt, now }), { operation: 'delete', keys: ['group:Finance'] });
  assert.equal(old.completeness.status, 'stale');
  assert.equal(old.completeness.exact, false);
  assert.ok(old.completeness.reasons.some((r) => r.reason === 'stale-graph'));
  const fresh = analyzeImpact(buildImpactGraph({ resources: TREE, relationships: fullCoverage(), observedAt: new Date('2026-09-29T23:00:00Z'), now }), { operation: 'delete', keys: ['group:Finance'] });
  assert.equal(fresh.completeness.exact, true);

  const staleRef = [GROUP, res('roleAssignment:HistoricRef', 'roleAssignment', [['group:Finance', 'principalId', { stale: true }]])];
  const viaRef = analyzeImpact(buildImpactGraph({ resources: staleRef, relationships: fullCoverage() }), { operation: 'delete', keys: ['group:Finance'] });
  assert.equal(viaRef.completeness.status, 'stale', 'a reference resolved from history is stale evidence');
});

// ---------------------------------------------------------------------- bounds

test('node and depth bounds are reported with the unexpanded frontier, never silent', () => {
  const chain = [res('n:0', 'x'), ...Array.from({ length: 6 }, (_, i) => res(`n:${i + 1}`, 'x', [[`n:${i}`]]))];
  const graph = buildImpactGraph({ resources: chain });
  const depth = analyzeImpact(graph, { operation: 'delete', keys: ['n:0'], bounds: { maxDepth: 2 } });
  assert.deepEqual(depth.impacted, ['n:1', 'n:2']);
  assert.equal(depth.completeness.status, 'bounded');
  assert.deepEqual(depth.truncated, ['n:2']);
  const nodes = analyzeImpact(graph, { operation: 'delete', keys: ['n:0'], bounds: { maxNodes: 3 } });
  assert.equal(nodes.completeness.status, 'bounded');
  assert.equal(nodes.completeness.exact, false);
  assert.ok(nodes.impacted.length < 6);
  const unbounded = analyzeImpact(graph, { operation: 'delete', keys: ['n:0'] });
  assert.equal(unbounded.impacted.length, 6);
  assert.deepEqual(unbounded.truncated, []);
});

// ----------------------------------------------------------------- disposition

test('disposition is a local governance operation with no Microsoft impact and its own key check', () => {
  const graph = buildImpactGraph({ resources: TREE });
  const result = analyzeImpact(graph, { operation: 'disposition', keys: ['group:Finance'] });
  assert.equal(result.localGovernance, true);
  assert.equal(result.microsoftWrites, 0);
  assert.deepEqual(result.impacted, [], 'dependents are not touched by a disposition');
  assert.equal(result.completeness.scope, 'local-governance');
  assert.throws(() => analyzeImpact(graph, { operation: 'disposition', keys: ['group:Nope'] }), /not present in the graph/);
  assert.throws(() => analyzeImpact(graph, { operation: 'restore-everything', keys: [] }), /unknown impact operation/);
});

// ------------------------------------------------------------ execution recheck

test('impact is rechecked at execution: a new dependent invalidates the planned impact', () => {
  const planned = analyzeImpact(buildImpactGraph({ resources: TREE, relationships: fullCoverage() }), { operation: 'delete', keys: ['group:Finance'] });
  assert.doesNotThrow(() => recheckImpact(planned, buildImpactGraph({ resources: TREE, relationships: fullCoverage() })));
  const grown = [...TREE, res('roleAssignment:NewlyGranted', 'roleAssignment', [['group:Finance', 'principalId']])];
  assert.throws(() => recheckImpact(planned, buildImpactGraph({ resources: grown, relationships: fullCoverage() })), ImpactChangedError);
});

// ------------------------------------------------------ delete gate (execution)

test('assessDeletePlan refuses a live dependent the plan neither deletes nor rewrites', () => {
  const planned = [{ ...GROUP, verb: 'delete' }];
  const refusals = assessDeletePlan({ liveResources: TREE, plannedResources: planned }).refusals;
  assert.deepEqual(refusals.map((r) => r.dependent).sort(), [POLICY.naturalKey, ROLE.naturalKey].sort());
  assert.equal(refusals[0].deleting, 'group:Finance');

  const allDeleted = [{ ...GROUP, verb: 'delete' }, { ...ROLE, verb: 'delete' }, { ...POLICY, verb: 'delete' }];
  assert.deepEqual(assessDeletePlan({ liveResources: TREE, plannedResources: allDeleted }).refusals, []);

  const rewritten = [
    { ...GROUP, verb: 'delete' }, { ...ROLE, verb: 'delete' },
    { ...POLICY, verb: 'update', references: [] }, // the plan removes the reference
  ];
  assert.deepEqual(assessDeletePlan({ liveResources: TREE, plannedResources: rewritten }).refusals, []);

  const stillReferencing = [{ ...GROUP, verb: 'delete' }, { ...ROLE, verb: 'delete' }, { ...POLICY, verb: 'update' }];
  assert.deepEqual(assessDeletePlan({ liveResources: TREE, plannedResources: stillReferencing }).refusals.map((r) => r.dependent), [POLICY.naturalKey]);

  const none = assessDeletePlan({ liveResources: TREE, plannedResources: [{ ...USER, verb: 'update' }] });
  assert.deepEqual(none.refusals, []);
  assert.equal(none.relationshipCoverage, 'not-evaluated');
});

// ------------------------------------------- real relationship store integration

test('edges recorded by the relationship store feed the impact graph', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = 'sha256:impact-int';
  const GID = '11111111-1111-1111-1111-111111111111';
  const UID = 'aaaaaaaa-0000-0000-0000-000000000001';
  const reader = {
    async collect(version, path) {
      if (path.includes('/members')) return { items: [{ id: UID, '@odata.type': '#microsoft.graph.user' }], pages: 1, status: 200, capped: false, error: null };
      return { items: [], pages: 1, status: 200, capped: false, error: null };
    },
  };
  const observations = await collectRelationships(reader, { tenantRef, parents: [{ type: 'group', sourceId: GID, naturalKey: 'group:Finance' }] });
  const snapshotId = await createSnapshot(client, { tenantRef });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  await recordRelationships(client, { snapshotId, tenantRef, observations, context: new Map([[UID, { symbol: 'user:alice', type: 'user' }]]) });
  const relationships = await loadRelationshipState(client, { tenantRef });

  const graph = buildImpactGraph({ resources: TREE, relationships });
  const result = analyzeImpact(graph, { operation: 'delete', keys: ['group:Finance'] });
  assert.deepEqual(result.edgeEffects.map((e) => `${e.family}:${e.from}>${e.to}`), ['member:group:Finance>user:alice']);
  assert.equal(result.completeness.exact, true, 'member and owner reads are both current and complete');
  // Deleting the member user also discloses the membership edge it participates in.
  const userDelete = analyzeImpact(graph, { operation: 'delete', keys: ['user:alice'] });
  assert.equal(userDelete.edgeEffects.length, 1);
});
