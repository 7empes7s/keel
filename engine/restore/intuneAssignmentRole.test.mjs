/**
 * Q271: Graph has no route for an Intune role assignment's own role.
 * `GET /beta/deviceManagement/roleAssignments/{id}/roleDefinition` answers 400
 * "No OData route exists", which left the live backup with no Intune role
 * assignments. The backup and the restore now read the role from the side that
 * lists it: each role's `roleAssignments`.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { get } from '../collect/registry.mjs';
import { withLinkedFromForTest } from '../collect/entraAdapter.mjs';
import { applyWave } from './applyEngine.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';

const ROLE_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const ROLE_B = 'aaaaaaaa-0000-0000-0000-00000000000b';
const NO_ROUTE = /^\/deviceManagement\/roleAssignments\/[^/?]+\/roleDefinition/;
const governor = { async acquire() {}, observeRetryAfter() {} };

const entry = CATALOG.find((candidate) => candidate.type === 'deviceManagementRoleAssignment');

// A reader shaped like Graph beta: the per-assignment role route has no route.
function graphLikeReader({ roles, assignmentsOf, failRoles = null }) {
  const reads = [];
  return {
    reads,
    async collect(_version, path) {
      reads.push(path);
      const bare = path.split('?')[0];
      if (NO_ROUTE.test(bare)) return { error: { status: 400, error: 'No OData route exists that match template ~/singleton/navigation/key/navigation' }, pages: 0 };
      if (bare === '/deviceManagement/roleAssignments') return { items: Object.values(assignmentsOf).flat().map((id) => ({ id, displayName: `KEEL-RT-${id}`, members: [] })), pages: 1 };
      if (bare === '/deviceManagement/roleDefinitions') return failRoles ?? { items: roles, pages: 1 };
      const match = /^\/deviceManagement\/roleDefinitions\/([^/]+)\/roleAssignments$/.exec(bare);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (!(id in assignmentsOf)) return { error: { status: 404, error: 'gone' }, pages: 0 };
        return { items: assignmentsOf[id].map((assignment) => ({ id: assignment })), pages: 1 };
      }
      return { error: { status: 404, error: 'unexpected path' }, pages: 0 };
    },
  };
}

test('Q271: the backup never reads the per-assignment role route', () => {
  assert.equal(entry.itemReads, undefined);
  assert.deepEqual(entry.linkedFrom, {
    as: 'roleDefinition', parents: '/deviceManagement/roleDefinitions',
    children: '/deviceManagement/roleDefinitions/{parent}/roleAssignments', fields: ['id', 'displayName', 'isBuiltIn'],
  });
});

test('Q271: the backup keeps each Intune assignment with its role read from the role list', async () => {
  const reader = graphLikeReader({
    roles: [
      { id: ROLE_A, displayName: 'Read Only Operator', isBuiltIn: true, rolePermissions: [{ resourceActions: [] }] },
      { id: ROLE_B, displayName: 'KEEL-RT-role', isBuiltIn: false },
    ],
    assignmentsOf: { [ROLE_A]: ['a1'], [ROLE_B]: ['a2'] },
  });
  const items = await get('deviceManagementRoleAssignment').adapter.collect(reader, { tenantId: 'fixture-tenant' });
  assert.equal(items.length, 2, 'the assignments are in the backup');
  assert.deepEqual(items.find((item) => item.id === 'a1').roleDefinition, { id: ROLE_A, displayName: 'Read Only Operator', isBuiltIn: true });
  assert.deepEqual(items.find((item) => item.id === 'a2').roleDefinition, { id: ROLE_B, displayName: 'KEEL-RT-role', isBuiltIn: false });
  assert.ok(!reader.reads.some((path) => NO_ROUTE.test(path)), 'no per-assignment role read');
});

test('Q271: an assignment no role lists is kept without a role, and a role that went is skipped', async () => {
  const reader = graphLikeReader({ roles: [{ id: ROLE_A, displayName: 'A' }, { id: 'gone-role', displayName: 'Gone' }], assignmentsOf: { [ROLE_A]: [] } });
  const items = [{ id: 'orphan' }];
  assert.equal((await withLinkedFromForTest(reader, entry, items)).error, null);
  assert.equal('roleDefinition' in items[0], false);
});

test('Q271: an assignment listed under two roles, or a failed role list, fails the kind', async () => {
  const twice = graphLikeReader({ roles: [{ id: ROLE_A }, { id: ROLE_B }], assignmentsOf: { [ROLE_A]: ['a1'], [ROLE_B]: ['a1'] } });
  assert.match((await withLinkedFromForTest(twice, entry, [{ id: 'a1' }])).error.error, /more than one object/);
  const denied = graphLikeReader({ roles: [], assignmentsOf: { [ROLE_A]: ['a1'] }, failRoles: { error: { status: 403, error: 'Forbidden' }, pages: 0 } });
  const reply = await get('deviceManagementRoleAssignment').adapter.collectRaw(denied, { tenantId: 'fixture-tenant' });
  assert.equal(reply.status, 403);
  assert.equal(reply.path, '/deviceManagement/roleDefinitions');
  assert.deepEqual(reply.items, []);
});

function resource(verb = 'create') {
  const payload = {
    '@odata.type': '#microsoft.graph.deviceAndAppManagementRoleAssignment', id: 'source-assignment', displayName: 'KEEL-RT-271-intune-assignment',
    members: ['group-1'], scopeMembers: [], resourceScopes: ['group-1'], scopeType: 'resourceScope', roleScopeTagIds: ['0'],
    roleDefinition: { id: ROLE_A, displayName: 'Read Only Operator', isBuiltIn: true },
  };
  return {
    resourceType: 'deviceManagementRoleAssignment', naturalKey: 'deviceManagementRoleAssignment:KEEL-RT-271-intune-assignment', verb,
    payload, references: [], provenance: { fidelity: 'full' }, live: verb === 'create' ? { state: 'absent' } : undefined,
  };
}

function recording(graph) {
  const reads = [];
  const read = graph.read.bind(graph);
  graph.read = async (version, path) => { reads.push(path); return read(version, path); };
  return reads;
}

test('Q271: a restored Intune assignment reads its role back from the role, never the missing route', async () => {
  const graph = fakeGraph();
  const reads = recording(graph);
  const wave = [resource()];
  const result = await applyWave(graph, governor, wave, {
    targetTenant: 'fixture-tenant', mode: 'enforce', existingTargetIds: new Map(), approvedContentEffects: classifyContentEffects(wave).effects,
  });
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.ok(reads.some((path) => path.startsWith(`/deviceManagement/roleDefinitions/${ROLE_A}/roleAssignments`)), 'read back from the role');
  assert.ok(!reads.some((path) => NO_ROUTE.test(path)), 'no per-assignment role read');
});

test('Q271: an update finds the assignment\'s current role from the role list, and names it', async () => {
  const graph = fakeGraph();
  const live = { ...resource().payload, id: 'live-1', displayName: 'Drifted', roleDefinition: { id: ROLE_B, displayName: 'KEEL-RT-other role' } };
  graph.objects.set('/deviceManagement/roleAssignments/live-1', live);
  const reads = recording(graph);
  const update = { ...resource('update'), live: { state: 'present', targetId: 'live-1', payload: { ...live, roleDefinition: undefined } } };
  const result = await applyWave(graph, governor, [update], {
    targetTenant: 'fixture-tenant', mode: 'enforce', existingTargetIds: new Map([[update.naturalKey, 'live-1']]),
    approvedContentEffects: classifyContentEffects([update]).effects,
  });
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /different role \(KEEL-RT-other role\)/);
  assert.ok(!reads.some((path) => NO_ROUTE.test(path)), 'no per-assignment role read');
  assert.equal(graph.objects.get('/deviceManagement/roleAssignments/live-1').displayName, 'Drifted', 'nothing written');
});
