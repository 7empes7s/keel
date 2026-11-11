/**
 * Issue #1071: catalog resources, access package assignments and catalog roles
 * (entitlementGrantOperations.mjs), against an in-memory entitlement management
 * Graph in the shapes Graph lists them. The applyWave tests at the end drive the
 * production path: this file is the remapping proof qualification.mjs records
 * for the three creates.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { remappingFor } from '../coverage/qualification.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';
import { applyWave } from './applyEngine.mjs';
import { APPROVAL_HELD_KINDS } from './approvalHeld.mjs';
import { applyIdentityObjectWrite } from './identityObjectOperations.mjs';
import { TRUST_FIELD_PATTERN } from './workloads/writeDeclarations.mjs';

const EM = '/identityGovernance/entitlementManagement';
const ROLES = '/roleManagement/entitlementManagement/roleAssignments';
const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 }, tenantRef: 'sha256:customer0000000' };
const DAY = 24 * 60 * 60 * 1000;

const SOURCE_CATALOG = 'aaaaaaaa-0000-4000-8000-000000000001';
const TARGET_CATALOG = 'bbbbbbbb-0000-4000-8000-000000000001';
const SOURCE_GROUP = 'aaaaaaaa-0000-4000-8000-000000000003';
const TARGET_GROUP = 'bbbbbbbb-0000-4000-8000-000000000003';
const SOURCE_USER = 'aaaaaaaa-0000-4000-8000-000000000004';
const TARGET_USER = 'bbbbbbbb-0000-4000-8000-000000000004';
const SOURCE_PACKAGE = 'aaaaaaaa-0000-4000-8000-000000000002';
const TARGET_PACKAGE = 'bbbbbbbb-0000-4000-8000-000000000002';
const SOURCE_POLICY = 'aaaaaaaa-0000-4000-8000-000000000005';
const TARGET_POLICY = 'bbbbbbbb-0000-4000-8000-000000000005';
const CATALOG_KEY = `accessPackageCatalog:${SOURCE_CATALOG}`;
const GROUP_KEY = 'group:KEEL-RT-finance';
const USER_KEY = 'user:carla@contoso.example';
const PACKAGE_KEY = `accessPackage:${SOURCE_PACKAGE}`;
const POLICY_KEY = `accessPackageAssignmentPolicy:${SOURCE_POLICY}`;
const SITE = 'https://contoso.sharepoint.com/sites/KEEL-RT-site';
const CATALOG_READER = '44272f93-9762-48e8-af59-1b5351b1d6b3';
const CATALOG_CREATOR = 'ba92d953-d8e0-4e39-a797-0cbedb0a89e8';

/**
 * Entitlement management in memory: catalogs with their resources, assignments
 * (made by an adminAdd request) and catalog role assignments. `fail` names
 * paths whose reads answer 500.
 */
function entitlementGraph({ catalogs = [], assignments = [], roleAssignments = [], fail = [] } = {}) {
  const state = {
    catalogs: new Map(catalogs.map((catalog) => [catalog.id, { resources: [], ...structuredClone(catalog) }])),
    assignments: assignments.map((row) => structuredClone(row)),
    roleAssignments: roleAssignments.map((row) => structuredClone(row)),
  };
  const calls = [];
  let next = 0;
  const ok = (status, body) => ({ ok: true, status, body: structuredClone(body) });
  const notFound = () => ({ ok: false, status: 404, body: { error: { code: 'ResourceNotFound' } } });
  return {
    state,
    calls,
    async read(version, path) {
      calls.push({ method: 'GET', version, path });
      const [base, rawQuery = ''] = path.split('?');
      const query = decodeURIComponent(rawQuery);
      if (fail.some((prefix) => base.startsWith(prefix))) return { ok: false, status: 500, body: { error: { code: 'InternalServerError' } } };
      const resources = /^.*\/catalogs\/([^/]+)\/resources$/.exec(base);
      if (resources) {
        const catalog = state.catalogs.get(decodeURIComponent(resources[1]));
        if (!catalog) return notFound();
        const origin = /originId eq '([^']+)'/.exec(query)?.[1];
        return ok(200, { value: catalog.resources.filter((row) => !origin || row.originId === origin) });
      }
      if (base === `${EM}/assignments`) {
        const pkg = /accessPackage\/id eq '([^']+)'/.exec(query)?.[1];
        const target = /target\/objectId eq '([^']+)'/i.exec(query)?.[1];
        return ok(200, { value: state.assignments.filter((row) => (!pkg || row.accessPackage.id === pkg) && (!target || row.target.objectId === target)) });
      }
      if (base === ROLES) {
        const role = /roleDefinitionId eq '([^']+)'/.exec(query)?.[1];
        return ok(200, { value: state.roleAssignments.filter((row) => !role || row.roleDefinitionId === role) });
      }
      const one = /^\/roleManagement\/entitlementManagement\/roleAssignments\/([^/]+)$/.exec(base);
      if (one) {
        const row = state.roleAssignments.find((candidate) => candidate.id === decodeURIComponent(one[1]));
        return row ? ok(200, row) : notFound();
      }
      return notFound();
    },
    async write(version, path, { method, body }) {
      calls.push({ method, version, path, body: structuredClone(body) });
      if (method === 'POST' && path === `${EM}/resourceRequests`) {
        const catalog = state.catalogs.get(body.catalog?.id);
        if (!catalog || body.requestType !== 'adminAdd') return { ok: false, status: 400, body: { error: { code: 'BadRequest' } } };
        next += 1;
        catalog.resources.push({ id: `catalog-resource-${next}`, displayName: 'Added', ...body.resource });
        return ok(201, { id: `request-${next}`, requestType: 'adminAdd', requestState: 'delivered', requestStatus: 'Fulfilled' });
      }
      if (method === 'POST' && path === `${EM}/assignmentRequests`) {
        const { targetId, accessPackageId, assignmentPolicyId } = body.assignment ?? {};
        if (body.requestType !== 'adminAdd' || !targetId || !accessPackageId || !assignmentPolicyId) return { ok: false, status: 400, body: { error: { code: 'BadRequest' } } };
        next += 1;
        state.assignments.push({
          id: `assignment-${next}`, state: 'delivered', status: 'Delivered',
          schedule: { startDateTime: body.schedule?.startDateTime ?? '2026-01-01T00:00:00Z', expiration: body.schedule?.expiration ?? { type: 'noExpiration' } },
          target: { id: `subject-${next}`, objectId: targetId, subjectType: 'user' },
          accessPackage: { id: accessPackageId }, assignmentPolicy: { id: assignmentPolicyId },
        });
        // Graph answers with the request, whose id is not the assignment's.
        return ok(201, { id: `request-${next}`, requestType: 'adminAdd', requestState: 'Submitted', requestStatus: 'Accepted' });
      }
      if (method === 'POST' && path === ROLES) {
        next += 1;
        const created = { id: `role-assignment-${next}`, ...body };
        state.roleAssignments.push(created);
        return ok(201, created);
      }
      return notFound();
    },
  };
}

const context = (targets = []) => ({ targetIndex: new Map(targets), mappingTable: new Map(), runProvenance: new Map() });
const withRefs = (referenceContext, extra = {}) => ({ ...FAST, referenceContext, ...extra });
const approved = (resource) => classifyContentEffects([{ ...resource, verb: 'create' }]).effects;
const writes = (graph) => graph.calls.filter((call) => call.method !== 'GET');
const noTrust = (graph) => {
  for (const { body } of writes(graph)) {
    for (const key of JSON.stringify(body).match(/"([^"]+)":/g) ?? []) assert.equal(TRUST_FIELD_PATTERN.test(key.slice(1, -2)), false, `no trust field in a body: ${key}`);
  }
};
const RAW_ID = /[0-9a-f]{8}-[0-9a-f]{4}-/;

test('the three kinds are approval-held, and their writes are create only', () => {
  for (const kind of ['accessPackageCatalogResource', 'accessPackageAssignment', 'entitlementManagementRoleAssignment']) {
    assert.ok(APPROVAL_HELD_KINDS.includes(kind), kind);
  }
});

// ------------------------------------------------------ catalog resources

const catalogResource = (system = 'AadGroup', extra = {}) => {
  const group = system === 'AadGroup';
  return {
    naturalKey: 'accessPackageCatalogResource:source-resource', resourceType: 'accessPackageCatalogResource', blastRadius: 'access-affecting',
    // As Graph lists it (catalogs/{id}/resources?$expand=roles,scopes), with the parent catalog kept as catalogId.
    payload: {
      id: 'aaaaaaaa-0000-4000-8000-0000000000aa', displayName: group ? 'KEEL-RT-finance' : 'KEEL-RT-site', description: group ? 'Finance group' : null,
      originId: group ? SOURCE_GROUP : SITE, originSystem: system, url: group ? null : SITE, attributes: [], createdDateTime: '2026-01-01T00:00:00Z',
      roles: [{ id: 'source-role', displayName: group ? 'Member' : 'Visitors', originId: group ? `Member_${SOURCE_GROUP}` : '4', originSystem: system }],
      scopes: [{ id: 'source-scope', displayName: 'Root', originId: group ? SOURCE_GROUP : SITE, originSystem: system, isRootScope: true }],
      catalogId: SOURCE_CATALOG,
    },
    references: [
      { field: 'catalogId', symbol: CATALOG_KEY, required: true },
      ...(group ? [{ field: 'originId', symbol: GROUP_KEY, required: true }, { field: 'scopes[0].originId', symbol: GROUP_KEY, required: true }] : []),
      { field: 'id', symbol: null, required: true },
    ],
    ...extra,
  };
};
const CATALOG_TARGETS = [[CATALOG_KEY, TARGET_CATALOG], [GROUP_KEY, TARGET_GROUP]];
const targetCatalog = (resources = []) => ({ id: TARGET_CATALOG, displayName: 'KEEL-RT-Catalog', resources });

test('a backed-up group is added to the target\'s catalog (adminAdd) with the target\'s ids', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()] });
  const resource = catalogResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(CATALOG_TARGETS), { approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(result.skipped, undefined, result.skipped?.reason);
  assert.deepEqual(writes(graph).map(({ method, path, body }) => ({ method, path, body })), [{
    method: 'POST', path: `${EM}/resourceRequests`,
    body: { requestType: 'adminAdd', resource: { originId: TARGET_GROUP, originSystem: 'AadGroup' }, catalog: { id: TARGET_CATALOG } },
  }]);
  assert.equal(JSON.stringify(writes(graph)).includes(SOURCE_GROUP), false, 'never an id from the backup\'s tenant');
  assert.equal(result.applied.targetId, graph.state.catalogs.get(TARGET_CATALOG).resources[0].id, 'the id is the catalog resource\'s, not the request\'s');
  noTrust(graph);
});

test('a SharePoint site is added to the catalog by its address', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()] });
  const resource = catalogResource('SharePointOnline');
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(CATALOG_TARGETS), { approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(writes(graph)[0].body, { requestType: 'adminAdd', resource: { originId: SITE, originSystem: 'SharePointOnline' }, catalog: { id: TARGET_CATALOG } });
});

test('a resource already in the catalog is not added again', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog([{ id: 'live-resource', originId: TARGET_GROUP, originSystem: 'AadGroup' }])] });
  const resource = catalogResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(CATALOG_TARGETS), { approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', /the catalog already holds the group "KEEL-RT-finance"/);
  assert.equal(writes(graph).length, 0);
});

test('a catalog whose resources cannot be read is never treated as empty', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()], fail: [`${EM}/catalogs`] });
  const resource = catalogResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(CATALOG_TARGETS), { approvedContentEffects: approved(resource) }));
  assert.match(result.failed?.error ?? '', /^dependency: the catalog's resources could not be read/);
  assert.equal(writes(graph).length, 0);
});

test('a group that does not exist in the target is a manual step that names it, and nothing is written', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()] });
  const resource = catalogResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context([[CATALOG_KEY, TARGET_CATALOG]]), { approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', /^manual: The backup's catalog holds the group "KEEL-RT-finance", which does not exist in the target/);
  assert.equal(RAW_ID.test(result.skipped.completion[0].description), false, 'no raw ids in the step');
  assert.equal(graph.calls.length, 0);
});

test('a resource whose catalog is not in the target fails as a dependency', async () => {
  const graph = entitlementGraph();
  const resource = catalogResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context([[GROUP_KEY, TARGET_GROUP]])));
  assert.match(result.failed?.error ?? '', /^dependency: the catalog this resource belongs to is not in the target/);
  assert.equal(graph.calls.length, 0);
});

test('without the approval a catalog resource is held, and nothing is read or written', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()] });
  const resource = catalogResource();
  const effects = approved(resource);
  assert.deepEqual(effects.map((effect) => effect.field).sort(), ['originId', 'originSystem']);
  assert.equal(effects.find((effect) => effect.field === 'originId').after, GROUP_KEY, 'the group is shown by name');
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(CATALOG_TARGETS), { mode: 'enforce' }));
  assert.match(result.skipped?.reason ?? '', /changes admin access/);
  assert.equal(graph.calls.length, 0);
});

test('the dry run of a catalog resource writes nothing', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()] });
  const result = await applyIdentityObjectWrite(graph, catalogResource(), 'create', withRefs(context(CATALOG_TARGETS), { mode: 'dry-run' }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(result.applied.changes.fields.sort(), ['catalogId', 'originId', 'originSystem']);
  assert.equal(writes(graph).length, 0);
});

// ------------------------------------------------------------ assignments

/** An assignment as Graph lists it with $expand=target,accessPackage,assignmentPolicy. */
const assignment = (extra = {}, payload = {}) => ({
  naturalKey: 'accessPackageAssignment:source-assignment', resourceType: 'accessPackageAssignment', blastRadius: 'access-affecting',
  payload: {
    id: 'aaaaaaaa-0000-4000-8000-0000000000bb', state: 'delivered', status: 'Delivered', expiredDateTime: null,
    schedule: { startDateTime: new Date(Date.now() - 30 * DAY).toISOString(), recurrence: null, expiration: { endDateTime: null, duration: null, type: 'noExpiration' } },
    customExtensionCalloutInstances: [],
    target: { id: 'aaaaaaaa-0000-4000-8000-0000000000cc', objectId: SOURCE_USER, subjectType: 'user', displayName: 'Carla', principalName: 'carla@contoso.example', email: 'carla@contoso.example', connectedOrganization: null },
    accessPackage: { id: SOURCE_PACKAGE, displayName: 'KEEL-RT-Package', description: 'Finance access', isHidden: true },
    assignmentPolicy: { id: SOURCE_POLICY, displayName: 'KEEL-RT-Policy', allowedTargetScope: 'specificDirectoryUsers' },
    ...payload,
  },
  references: [
    { field: 'target.objectId', symbol: USER_KEY, required: true },
    { field: 'accessPackage.id', symbol: PACKAGE_KEY, required: true },
    { field: 'assignmentPolicy.id', symbol: POLICY_KEY, required: true },
    // The subject's own id: never sent, never blocks the grant.
    { field: 'target.id', symbol: null, required: true },
  ],
  ...extra,
});
const ASSIGNMENT_TARGETS = [[USER_KEY, TARGET_USER], [PACKAGE_KEY, TARGET_PACKAGE], [POLICY_KEY, TARGET_POLICY]];

test('access is granted again through an adminAdd request against the target\'s policy, never copied', async () => {
  const graph = entitlementGraph();
  const resource = assignment();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(ASSIGNMENT_TARGETS), { approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(result.skipped, undefined, result.skipped?.reason);
  assert.deepEqual(writes(graph).map(({ method, path, body }) => ({ method, path, body })), [{
    method: 'POST', path: `${EM}/assignmentRequests`,
    body: { requestType: 'adminAdd', assignment: { targetId: TARGET_USER, assignmentPolicyId: TARGET_POLICY, accessPackageId: TARGET_PACKAGE } },
  }]);
  assert.equal(result.applied.targetId, graph.state.assignments[0].id, 'the id is the assignment\'s, not the request\'s');
  assert.equal(JSON.stringify(writes(graph)).match(/aaaaaaaa-/), null, 'never an id from the backup\'s tenant');
  noTrust(graph);
});

test('access ends no later than the backup\'s end date', async () => {
  const end = new Date(Date.now() + 10 * DAY).toISOString();
  const graph = entitlementGraph();
  const resource = assignment({}, { schedule: { startDateTime: new Date(Date.now() - DAY).toISOString(), expiration: { endDateTime: end, type: 'afterDateTime' } } });
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(ASSIGNMENT_TARGETS), { approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(writes(graph)[0].body.schedule.expiration, { type: 'afterDateTime', endDateTime: end });
});

test('an assignment past its end date, or no longer delivered, is skipped and carries no effect', async () => {
  const ended = assignment({}, { schedule: { startDateTime: new Date(Date.now() - 20 * DAY).toISOString(), expiration: { endDateTime: new Date(Date.now() - DAY).toISOString(), type: 'afterDateTime' } } });
  const expired = assignment({}, { state: 'expired', status: 'Expired' });
  for (const resource of [ended, expired]) {
    const graph = entitlementGraph();
    assert.deepEqual(approved(resource), [], 'nobody is asked to approve a grant that never happens');
    const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(ASSIGNMENT_TARGETS)));
    assert.match(result.skipped?.reason ?? '', /^the assignment was not in effect/);
    assert.equal(graph.calls.length, 0);
  }
});

test('a person who already holds the package live is not granted it twice (a re-run after the grant)', async () => {
  const graph = entitlementGraph();
  const resource = assignment();
  const ctx = withRefs(context(ASSIGNMENT_TARGETS), { approvedContentEffects: approved(resource) });
  assert.equal((await applyIdentityObjectWrite(graph, resource, 'create', ctx)).failed, undefined);
  const again = await applyIdentityObjectWrite(graph, resource, 'create', ctx);
  assert.match(again.skipped?.reason ?? '', /the target already gives the user carla@contoso.example the access package "KEEL-RT-Package"/);
  assert.equal(writes(graph).length, 1);
  assert.equal(graph.state.assignments.length, 1);
});

test('assignments that cannot be read are never treated as absent', async () => {
  const graph = entitlementGraph({ fail: [`${EM}/assignments`] });
  const resource = assignment();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(ASSIGNMENT_TARGETS), { approvedContentEffects: approved(resource) }));
  assert.match(result.failed?.error ?? '', /^dependency: the access package's assignments could not be read/);
  assert.equal(writes(graph).length, 0);
});

test('a backup that does not name the policy (taken before KEEL read it) is a manual step', async () => {
  const graph = entitlementGraph();
  const { assignmentPolicy: _policy, ...payload } = assignment().payload;
  const resource = assignment({ payload, references: assignment().references.filter((ref) => ref.field !== 'assignmentPolicy.id') });
  assert.deepEqual(approved(resource), []);
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(ASSIGNMENT_TARGETS)));
  assert.match(result.skipped?.reason ?? '', /^manual: The backup does not say which policy gave the user carla@contoso.example the access package "KEEL-RT-Package"/);
  assert.equal(graph.calls.length, 0);
});

test('a person who does not exist in the target is a manual step that names them', async () => {
  const graph = entitlementGraph();
  const resource = assignment();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context([[PACKAGE_KEY, TARGET_PACKAGE], [POLICY_KEY, TARGET_POLICY]]), { approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', /^manual: The backup gives the user carla@contoso.example the access package "KEEL-RT-Package" through the policy "KEEL-RT-Policy", but that person does not exist/);
  assert.equal(RAW_ID.test(result.skipped.completion[0].description), false);
  assert.equal(graph.calls.length, 0);
});

test('a policy that is not in the target fails as a dependency', async () => {
  const graph = entitlementGraph();
  const result = await applyIdentityObjectWrite(graph, assignment(), 'create', withRefs(context([[USER_KEY, TARGET_USER], [PACKAGE_KEY, TARGET_PACKAGE]])));
  assert.match(result.failed?.error ?? '', /^dependency: the policy that granted this assignment is not in the target/);
  assert.equal(graph.calls.length, 0);
});

test('a grant is held without its approval, and held when only part of it was approved', async () => {
  const resource = assignment();
  const effects = approved(resource);
  assert.deepEqual(effects.map((effect) => [effect.field, effect.after]).sort(), [
    ['accessPackage', 'the access package "KEEL-RT-Package"'], ['assignmentPolicy', 'the policy "KEEL-RT-Policy"'], ['target', 'the user carla@contoso.example'],
  ]);
  assert.ok(effects.every((effect) => effect.effect === 'access-changing'));
  for (const approvals of [[], effects.filter((effect) => effect.field === 'target')]) {
    const graph = entitlementGraph();
    const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(ASSIGNMENT_TARGETS), { mode: 'enforce', approvedContentEffects: approvals }));
    assert.match(result.skipped?.reason ?? '', /changes admin access/);
    assert.equal(graph.calls.length, 0);
  }
});

test('the dry run says who gets which package and writes nothing', async () => {
  const graph = entitlementGraph();
  const result = await applyIdentityObjectWrite(graph, assignment(), 'create', withRefs(context(ASSIGNMENT_TARGETS), { mode: 'dry-run' }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(result.applied.changes.grants, 'gives the user carla@contoso.example the access package "KEEL-RT-Package" through the policy "KEEL-RT-Policy"');
  assert.equal(writes(graph).length, 0);
});

test('an assignment is never changed or removed by a restore', async () => {
  for (const verb of ['update', 'delete']) {
    const graph = entitlementGraph();
    const resource = assignment({ live: { state: 'present', targetId: 'live', payload: assignment().payload } });
    const result = await applyIdentityObjectWrite(graph, resource, verb, FAST);
    assert.match(result.failed?.error ?? '', /unsupported operation/, verb);
    assert.equal(graph.calls.length, 0);
  }
});

// ------------------------------------------- entitlement management roles

/** A catalog role assignment as Graph beta lists it (filtered by roleDefinitionId). */
const roleAssignment = (payload = {}, extra = {}) => ({
  naturalKey: 'entitlementManagementRoleAssignment:source-role-assignment', resourceType: 'entitlementManagementRoleAssignment', blastRadius: 'access-affecting',
  payload: { id: 'aaaaaaaa-0000-4000-8000-0000000000dd', principalId: SOURCE_USER, roleDefinitionId: CATALOG_READER, appScopeId: `/AccessPackageCatalog/${SOURCE_CATALOG}`, ...payload },
  references: [
    { field: 'principalId', symbol: USER_KEY, required: true },
    // The built-in role's id: the same in every tenant, never a collected object.
    { field: 'roleDefinitionId', symbol: null, required: true },
  ],
  ...extra,
});
const ROLE_TARGETS = [[USER_KEY, TARGET_USER], [CATALOG_KEY, TARGET_CATALOG]];

test('a catalog reader is given back on the target\'s catalog, to the target\'s person', async () => {
  const graph = entitlementGraph();
  const resource = roleAssignment();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(ROLE_TARGETS), { approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(result.skipped, undefined, result.skipped?.reason);
  assert.deepEqual(writes(graph).map(({ method, version, path, body }) => ({ method, version, path, body })), [{
    method: 'POST', version: 'beta', path: ROLES,
    body: { principalId: TARGET_USER, roleDefinitionId: CATALOG_READER, appScopeId: `/AccessPackageCatalog/${TARGET_CATALOG}` },
  }]);
  assert.equal(result.applied.targetId, graph.state.roleAssignments[0].id);
  noTrust(graph);
});

test('a catalog role is shown by its name and the person\'s in the approval', () => {
  const effects = approved(roleAssignment());
  const after = Object.fromEntries(effects.map((effect) => [effect.field, effect.after]));
  assert.equal(after.roleDefinitionId, 'Catalog reader');
  assert.equal(after.principalId, USER_KEY);
});

test('a role a restore does not give back (catalog creator) is a manual step with no effect', async () => {
  const graph = entitlementGraph();
  const resource = roleAssignment({ roleDefinitionId: CATALOG_CREATOR, appScopeId: '/' });
  assert.deepEqual(approved(resource), []);
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(ROLE_TARGETS)));
  assert.match(result.skipped?.reason ?? '', /^manual: A restore puts back only catalog owners, catalog readers and access package managers/);
  assert.equal(graph.calls.length, 0);
});

test('a person who does not exist in the target holds the role assignment as a manual step', async () => {
  const graph = entitlementGraph();
  const resource = roleAssignment();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context([[CATALOG_KEY, TARGET_CATALOG]]), { approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', /^manual: The Catalog reader "carla@contoso.example" does not exist in the target/);
  assert.equal(graph.calls.length, 0);
});

test('a catalog that is not in the target holds the role assignment as a dependency', async () => {
  const graph = entitlementGraph();
  const result = await applyIdentityObjectWrite(graph, roleAssignment(), 'create', withRefs(context([[USER_KEY, TARGET_USER]])));
  assert.match(result.failed?.error ?? '', /^dependency: the catalog this Catalog reader role covers is not in the target/);
  assert.equal(graph.calls.length, 0);
});

test('a role the person already holds on the catalog is not given twice', async () => {
  const live = { id: 'live-role', principalId: TARGET_USER, roleDefinitionId: CATALOG_READER, appScopeId: `/AccessPackageCatalog/${TARGET_CATALOG}` };
  const graph = entitlementGraph({ roleAssignments: [live] });
  const resource = roleAssignment();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(ROLE_TARGETS), { approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', /already holds the Catalog reader role/);
  assert.equal(writes(graph).length, 0);
});

test('without the approval a catalog role is held, and nothing is read or written', async () => {
  const graph = entitlementGraph();
  const result = await applyIdentityObjectWrite(graph, roleAssignment(), 'create', withRefs(context(ROLE_TARGETS), { mode: 'enforce' }));
  assert.match(result.skipped?.reason ?? '', /changes admin access/);
  assert.equal(graph.calls.length, 0);
});

// ------------------------------------------------- production applyWave path

const governor = { async acquire() {}, observeRetryAfter() {} };

test('remapping proof: the three creates are qualified by this file', () => {
  for (const kind of ['accessPackageCatalogResource', 'accessPackageAssignment', 'entitlementManagementRoleAssignment']) {
    assert.equal(remappingFor(kind, 'create').qualified, true, kind);
    assert.equal(remappingFor(kind, 'create').proofRef, 'engine/restore/entitlementGrantOperations.test.mjs', kind);
  }
});

test('applyWave: the group lands in the catalog, the person gets the package and the catalog role, each in the target', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()] });
  const wave = [catalogResource(), assignment(), roleAssignment()].map((resource) => ({ ...resource, verb: 'create' }));
  const result = await applyWave(graph, governor, wave, {
    targetTenant: 'fixture-tenant', mode: 'enforce',
    existingTargetIds: new Map([...CATALOG_TARGETS, ...ASSIGNMENT_TARGETS, ...ROLE_TARGETS]),
    approvedContentEffects: classifyContentEffects(wave).effects,
  });
  assert.deepEqual(result.failed, [], JSON.stringify(result.failed));
  assert.deepEqual(result.skipped, [], JSON.stringify(result.skipped));
  assert.equal(result.applied.length, 3);
  assert.equal(graph.state.catalogs.get(TARGET_CATALOG).resources[0].originId, TARGET_GROUP);
  assert.deepEqual([graph.state.assignments[0].target.objectId, graph.state.assignments[0].accessPackage.id], [TARGET_USER, TARGET_PACKAGE]);
  assert.equal(graph.state.roleAssignments[0].appScopeId, `/AccessPackageCatalog/${TARGET_CATALOG}`);
  noTrust(graph);
});

test('applyWave: unapproved grants are held and nothing is written', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()] });
  const wave = [catalogResource(), assignment(), roleAssignment()].map((resource) => ({ ...resource, verb: 'create' }));
  const result = await applyWave(graph, governor, wave, {
    targetTenant: 'fixture-tenant', mode: 'enforce', existingTargetIds: new Map([...CATALOG_TARGETS, ...ASSIGNMENT_TARGETS, ...ROLE_TARGETS]), approvedContentEffects: [],
  });
  assert.equal(result.applied.length, 0);
  assert.equal(writes(graph).length, 0);
});
