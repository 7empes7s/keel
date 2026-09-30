/**
 * Roadmap task-57 boundary tests: first-class group membership and owner
 * observations. Exercises the production relationships.mjs collector/store,
 * collectSnapshot wiring, diffRelationships and the coverage report against
 * the isolated test database and an injected fake Graph reader — including
 * the three required mutation checks:
 *
 * - Derive membership from parent only.
 * - Treat child failure as empty.
 * - Discard edge with unseen target.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import '../collect/entraAdapter.mjs';
import { collectSnapshot } from '../collect/snapshot.mjs';
import {
  collectRelationships, recordRelationships, loadRelationshipState, CrossTenantRelationshipError,
} from '../collect/relationships.mjs';
import { diffRelationships } from '../govern/diffSnapshots.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { createSnapshot, completeSnapshot } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const G1 = '11111111-1111-1111-1111-111111111111';
const U1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const U2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const U3 = 'aaaaaaaa-0000-0000-0000-000000000003';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

async function freshSchema(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  return client;
}

const user = (id) => ({ '@odata.type': '#microsoft.graph.user', id });

/** Fake reader: `routes` maps a path to an items array, or a function/object result. */
function fakeReader(routes, calls = []) {
  return {
    async collect(version, path) {
      calls.push(path);
      const route = routes[path];
      if (route === undefined) return { items: [], pages: 1, status: 200, capped: false, error: null };
      const value = typeof route === 'function' ? route() : route;
      if (Array.isArray(value)) return { items: value, pages: 1, status: 200, capped: false, error: null };
      return value;
    },
  };
}

const memberPath = (id) => `/groups/${id}/members?$select=id`;
const ownerPath = (id) => `/groups/${id}/owners?$select=id`;
const parent = { sourceId: G1, naturalKey: 'group:eng' };

async function snapshotWith(client, tenantRef, observations, context) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  await recordRelationships(client, { snapshotId, tenantRef, observations, context });
  return snapshotId;
}

// --------------------------------------------- collection: child reads, not the parent

test('membership comes from the child read; a members field on the parent is ignored', async () => {
  const calls = [];
  const reader = fakeReader({ [memberPath(G1)]: [user(U1)] }, calls);
  const obs = await collectRelationships(reader, {
    tenantRef: 'sha256:t', parents: [{ ...parent, members: [{ id: U2 }, { id: U3 }] }],
  });
  const member = obs.find((o) => o.family === 'member');
  assert.deepEqual(member.targets.map((t) => t.targetId), [U1], 'parent payload members never become edges');
  assert.ok(calls.includes(memberPath(G1)) && calls.includes(ownerPath(G1)), 'member and owner are separate reads');
  assert.equal(member.edgeType, 'member');
  assert.equal(obs.find((o) => o.family === 'owner').edgeType, 'owner');
});

test('multi-page and nested (transitive) edges keep every member and stay separate from direct', async () => {
  const reader = fakeReader({
    [memberPath(G1)]: { items: [user(U1), user(U2)], pages: 3, status: 200, capped: false, error: null },
    [`/groups/${G1}/transitiveMembers?$select=id`]: [user(U1), user(U2), user(U3)],
  });
  const obs = await collectRelationships(reader, { tenantRef: 'sha256:t', parents: [parent], families: ['member', 'transitiveMember'] });
  const direct = obs.find((o) => o.family === 'member');
  const transitive = obs.find((o) => o.family === 'transitiveMember');
  assert.equal(direct.outcome, 'complete');
  assert.equal(direct.pagesCompleted, 3);
  assert.equal(direct.direction, 'direct');
  assert.equal(transitive.direction, 'transitive');
  assert.deepEqual(transitive.targets.map((t) => t.targetId), [U1, U2, U3]);
  assert.deepEqual(direct.targets.map((t) => t.targetId), [U1, U2], 'transitive results never leak into direct');
});

test('an empty complete edge set differs from a failed read', async () => {
  const reader = fakeReader({
    [ownerPath(G1)]: { items: undefined, pages: 0, status: 403, capped: false, error: { status: 403, code: 'Authorization_RequestDenied', error: 'denied' } },
  });
  const obs = await collectRelationships(reader, { tenantRef: 'sha256:t', parents: [parent] });
  const member = obs.find((o) => o.family === 'member');
  const owner = obs.find((o) => o.family === 'owner');
  assert.equal(member.outcome, 'complete-empty');
  assert.equal(member.itemCount, 0);
  assert.equal(owner.outcome, 'failed');
  assert.equal(owner.itemCount, null, 'failed cardinality is unknown, never zero');
  assert.equal(owner.graphCode, 'Authorization_RequestDenied');
  assert.equal(owner.httpStatus, 403);
});

test('a second-page error and a thrown read are partial/failed, never complete', async () => {
  const reader = fakeReader({
    [memberPath(G1)]: { items: [user(U1)], pages: 1, status: 200, capped: false, error: { status: 500, code: 'x', error: 'boom' } },
    [ownerPath(G1)]: () => { throw new Error('socket hang up'); },
  });
  const obs = await collectRelationships(reader, { tenantRef: 'sha256:t', parents: [parent] });
  const member = obs.find((o) => o.family === 'member');
  assert.equal(member.outcome, 'partial');
  assert.equal(member.itemCount, 1);
  assert.equal(obs.find((o) => o.family === 'owner').outcome, 'failed');
});

test('an item without an id makes the enumeration partial', async () => {
  const reader = fakeReader({ [memberPath(G1)]: [user(U1), { '@odata.type': '#microsoft.graph.user' }] });
  const obs = await collectRelationships(reader, { tenantRef: 'sha256:t', parents: [parent] });
  assert.equal(obs.find((o) => o.family === 'member').outcome, 'partial');
});

// ------------------------------------------------------------------ persistence

test('an edge whose target was never collected is kept, with unresolved identity', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:unseen';
  const obs = await collectRelationships(fakeReader({ [memberPath(G1)]: [user(U1), user(U2)] }), { tenantRef, parents: [parent] });
  const context = new Map([[U1, { symbol: 'user:alice', type: 'user' }]]); // U2 unseen
  await snapshotWith(client, tenantRef, obs, context);
  const state = await loadRelationshipState(client, { tenantRef });
  const entry = state.entries.get(`group:${G1}|member`);
  assert.deepEqual(entry.targets.map((x) => x.targetId), [U1, U2], 'edge to unseen target survives');
  assert.equal(entry.targets.find((x) => x.targetId === U1).targetNaturalKey, 'user:alice');
  assert.equal(entry.targets.find((x) => x.targetId === U2).targetNaturalKey, null);
});

test('wrong-tenant observation and wrong-tenant snapshot are rejected before any write', async (t) => {
  const client = await freshSchema(t);
  const obs = await collectRelationships(fakeReader({ [memberPath(G1)]: [user(U1)] }), { tenantRef: 'sha256:other', parents: [parent] });
  const snapshotId = await createSnapshot(client, { tenantRef: 'sha256:mine' });
  await assert.rejects(
    () => recordRelationships(client, { snapshotId, tenantRef: 'sha256:mine', observations: obs }),
    CrossTenantRelationshipError,
  );
  await assert.rejects(
    () => recordRelationships(client, { snapshotId, tenantRef: 'sha256:other', observations: obs }),
    CrossTenantRelationshipError,
  );
  const { rows } = await client.query('SELECT count(*)::int AS n FROM relationship_edge_set WHERE snapshot_id = $1', [snapshotId]);
  assert.equal(rows[0].n, 0);
});

test('state is tenant-scoped: another tenant never sees these edges, and diffs across tenants are refused', async (t) => {
  const client = await freshSchema(t);
  const obs = await collectRelationships(fakeReader({ [memberPath(G1)]: [user(U1)] }), { tenantRef: 'sha256:a', parents: [parent] });
  await snapshotWith(client, 'sha256:a', obs);
  const a = await loadRelationshipState(client, { tenantRef: 'sha256:a' });
  const b = await loadRelationshipState(client, { tenantRef: 'sha256:b' });
  assert.equal(a.entries.size, 2);
  assert.equal(b.entries.size, 0);
  assert.throws(() => diffRelationships(a, b), /across tenants/);
});

// -------------------------------------------------------------------------- drift

async function stateAfter(client, tenantRef, routes) {
  const obs = await collectRelationships(fakeReader(routes), { tenantRef, parents: [parent] });
  await snapshotWith(client, tenantRef, obs);
  return loadRelationshipState(client, { tenantRef });
}

test('unchanged parent with a removed member creates edge drift', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:drift';
  const baseline = await stateAfter(client, tenantRef, { [memberPath(G1)]: [user(U1), user(U2)] });
  await new Promise((r) => setTimeout(r, 5));
  const observed = await stateAfter(client, tenantRef, { [memberPath(G1)]: [user(U1), user(U3)] });
  const { drift } = diffRelationships(baseline, observed);
  const summary = drift.map((d) => `${d.changeType}:${d.targetId}`).sort();
  assert.deepEqual(summary, [`added:${U3}`, `removed:${U2}`]);
  assert.ok(drift.every((d) => d.resourceType === 'groupMembership' && d.derived === false));
  assert.ok(drift.every((d) => d.parentSourceId === G1), 'no parent payload change is involved');
});

test('a failed child read is stale last-known state and never authorizes removal', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:stale';
  const baseline = await stateAfter(client, tenantRef, { [memberPath(G1)]: [user(U1), user(U2)] });
  await new Promise((r) => setTimeout(r, 5));
  const failed = { items: undefined, pages: 0, status: 503, capped: false, error: { status: 503, code: 'ServiceUnavailable', error: 'try later' } };
  const observed = await stateAfter(client, tenantRef, { [memberPath(G1)]: failed });
  const entry = observed.entries.get(`group:${G1}|member`);
  assert.equal(entry.state, 'stale');
  assert.deepEqual(entry.targets.map((x) => x.targetId), [U1, U2], 'last-known members stay visible');
  assert.equal(entry.failure.graphCode, 'ServiceUnavailable');
  const { drift, unverified } = diffRelationships(baseline, observed);
  assert.equal(drift.filter((d) => d.changeType === 'removed').length, 0, 'failure is not an emptied group');
  assert.ok(unverified.some((u) => u.reason === 'stale-child-read'));
});

test('a never-completed child read has unknown state with null targets', async (t) => {
  const client = await freshSchema(t);
  const failed = { items: undefined, pages: 0, status: 403, capped: false, error: { status: 403, code: 'Forbidden', error: 'no' } };
  const state = await stateAfter(client, 'sha256:unk', { [memberPath(G1)]: failed });
  const entry = state.entries.get(`group:${G1}|member`);
  assert.equal(entry.state, 'unknown');
  assert.equal(entry.targets, null);
});

test('a genuinely emptied group under a complete read is removal drift', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:emptied';
  const baseline = await stateAfter(client, tenantRef, { [memberPath(G1)]: [user(U1)] });
  await new Promise((r) => setTimeout(r, 5));
  const observed = await stateAfter(client, tenantRef, { [memberPath(G1)]: [] });
  const { drift } = diffRelationships(baseline, observed);
  assert.deepEqual(drift.map((d) => `${d.changeType}:${d.targetId}`), [`removed:${U1}`]);
});

// ---------------------------------------------------- snapshot + report integration

function tenantReader(groupRoutes) {
  const base = {
    async collect(version, path) {
      if (path.startsWith('/groups?')) return { items: [{ id: G1, displayName: 'Eng', groupTypes: [], securityEnabled: true, mailEnabled: false, mailNickname: 'eng' }], pages: 1, status: 200, capped: false, error: null };
      if (groupRoutes[path] !== undefined) {
        const route = groupRoutes[path];
        return Array.isArray(route) ? { items: route, pages: 1, status: 200, capped: false, error: null } : route;
      }
      return { items: [], pages: 1, status: 200, capped: false, error: null };
    },
  };
  return base;
}

test('collectSnapshot records edges when opted in, and the type digest is unaffected by a failed edge read', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:snap';
  const failed = { items: undefined, pages: 0, status: 500, capped: false, error: { status: 500, code: 'x', error: 'e' } };
  const withEdges = await collectSnapshot(client, {
    reader: tenantReader({ [ownerPath(G1)]: failed, [memberPath(G1)]: [user(U1)] }), tenantRef, tenantId: 'tid', relationships: true,
  });
  assert.equal(withEdges.coverageDigest.group.outcome, 'complete', 'edge failure never changes the type outcome');
  assert.deepEqual(withEdges.relationships, { complete: 1, failed: 1 });
  const plain = await collectSnapshot(client, { reader: tenantReader({}), tenantRef, tenantId: 'tid' });
  assert.equal(plain.relationships, undefined, 'edge collection is opt-in');
  const { rows } = await client.query('SELECT count(*)::int AS n FROM relationship_edge_set WHERE snapshot_id = $1', [plain.snapshotId]);
  assert.equal(rows[0].n, 0);
});

test('coverage report marks group relationships partial, never complete, and other types stay unknown', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:report';
  const empty = await buildCoverageReport(client, { tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS });
  assert.equal(empty.types.find((x) => x.type === 'group').relationshipCompleteness, 'unknown');
  await collectSnapshot(client, { reader: tenantReader({ [memberPath(G1)]: [user(U1)] }), tenantRef, tenantId: 'tid', relationships: true });
  const report = await buildCoverageReport(client, { tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS });
  const group = report.types.find((x) => x.type === 'group');
  assert.equal(group.relationshipCompleteness, 'partial');
  assert.deepEqual(group.relationships.families.member, { current: 1, stale: 0, unknown: 0 });
  assert.equal(group.relationships.parents, 1);
  for (const other of report.types.filter((x) => x.type !== 'group')) {
    assert.equal(other.relationshipCompleteness, 'unknown', `${other.type} is not fabricated`);
  }
});
