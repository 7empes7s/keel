/**
 * Issue #992: access packages and the resource roles they grant
 * (accessPackageOperations.mjs), against an in-memory entitlement management
 * Graph. The last tests drive the production applyWave path: this file is the
 * remapping proof qualification.mjs records for both creates.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { remappingFor } from '../coverage/qualification.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';
import { applyWave, rewriteReferences } from './applyEngine.mjs';
import { APPROVAL_HELD_KINDS } from './approvalHeld.mjs';
import { applyIdentityObjectWrite } from './identityObjectOperations.mjs';
import { TRUST_FIELD_PATTERN } from './workloads/writeDeclarations.mjs';

const EM = '/identityGovernance/entitlementManagement';
const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 }, tenantRef: 'sha256:customer0000000' };

const SOURCE_CATALOG = 'aaaaaaaa-0000-4000-8000-000000000001';
const TARGET_CATALOG = 'bbbbbbbb-0000-4000-8000-000000000001';
const SOURCE_PACKAGE = 'aaaaaaaa-0000-4000-8000-000000000002';
const TARGET_PACKAGE = 'bbbbbbbb-0000-4000-8000-000000000002';
const SOURCE_GROUP = 'aaaaaaaa-0000-4000-8000-000000000003';
const TARGET_GROUP = 'bbbbbbbb-0000-4000-8000-000000000003';
const CATALOG_KEY = `accessPackageCatalog:${SOURCE_CATALOG}`;
const PACKAGE_KEY = `accessPackage:${SOURCE_PACKAGE}`;
const GROUP_KEY = 'group:KEEL-RT-finance';
const SITE = 'https://contoso.sharepoint.com/sites/KEEL-RT-site';

/**
 * Entitlement management in memory: catalogs with their resources, and
 * packages with their catalog and resource roles. `tamper(scope)` changes a
 * resource role as it is stored (a read back that does not match).
 */
function entitlementGraph({ catalogs = [], packages = [], tamper = (scope) => scope } = {}) {
  const state = {
    catalogs: new Map(catalogs.map((catalog) => [catalog.id, { resources: [], ...structuredClone(catalog) }])),
    packages: new Map(packages.map((pkg) => [pkg.id, { resourceRoleScopes: [], ...structuredClone(pkg) }])),
  };
  const calls = [];
  let next = 0;
  const ok = (status, body) => ({ ok: true, status, body: structuredClone(body) });
  const notFound = () => ({ ok: false, status: 404, body: { error: { code: 'ResourceNotFound' } } });
  const shown = (pkg, scopes) => {
    const { catalogId, resourceRoleScopes, ...rest } = pkg;
    const catalog = state.catalogs.get(catalogId);
    return { ...rest, catalog: { id: catalog.id, displayName: catalog.displayName }, ...(scopes ? { resourceRoleScopes } : {}) };
  };
  return {
    state,
    calls,
    async read(version, path) {
      calls.push({ method: 'GET', path });
      const [base, query = ''] = path.split('?');
      if (base === `${EM}/accessPackages`) return ok(200, { value: [...state.packages.values()].map((pkg) => shown(pkg, false)) });
      const pkg = /^.*\/accessPackages\/([^/]+)$/.exec(base);
      if (pkg) {
        const found = state.packages.get(decodeURIComponent(pkg[1]));
        return found ? ok(200, shown(found, query.includes('resourceRoleScopes'))) : notFound();
      }
      const resources = /^.*\/catalogs\/([^/]+)\/resources$/.exec(base);
      if (resources) {
        const catalog = state.catalogs.get(decodeURIComponent(resources[1]));
        if (!catalog) return notFound();
        const origin = /originId eq '([^']+)'/.exec(decodeURIComponent(query))?.[1];
        return ok(200, { value: catalog.resources.filter((row) => !origin || row.originId === origin) });
      }
      return notFound();
    },
    async write(version, path, { method, body }) {
      calls.push({ method, path, body: structuredClone(body) });
      if (method === 'POST' && path === `${EM}/accessPackages`) {
        if (!state.catalogs.has(body.catalog?.id)) return { ok: false, status: 400, body: { error: { code: 'CatalogNotFound' } } };
        next += 1;
        const { catalog, ...fields } = body;
        const created = { ...fields, id: `created-package-${next}`, catalogId: catalog.id, resourceRoleScopes: [] };
        state.packages.set(created.id, created);
        return ok(201, shown(created, false));
      }
      const patch = /^.*\/accessPackages\/([^/]+)$/.exec(path);
      if (method === 'PATCH' && patch) {
        const found = state.packages.get(decodeURIComponent(patch[1]));
        if (!found) return notFound();
        Object.assign(found, body);
        return ok(204, null);
      }
      if (method === 'POST' && path === `${EM}/resourceRequests`) {
        const catalog = state.catalogs.get(body.catalog?.id);
        if (!catalog || body.requestType !== 'adminAdd') return { ok: false, status: 400, body: { error: { code: 'BadRequest' } } };
        next += 1;
        catalog.resources.push({ id: `catalog-resource-${next}`, ...body.resource });
        return ok(201, { id: `request-${next}`, requestState: 'delivered' });
      }
      const scopes = /^.*\/accessPackages\/([^/]+)\/resourceRoleScopes$/.exec(path);
      if (method === 'POST' && scopes) {
        const found = state.packages.get(decodeURIComponent(scopes[1]));
        if (!found) return notFound();
        const catalog = state.catalogs.get(found.catalogId);
        if (!catalog.resources.some((row) => row.id === body.role?.resource?.id)) return { ok: false, status: 400, body: { error: { code: 'ResourceNotInCatalog' } } };
        next += 1;
        const created = { id: `role-scope-${next}`, role: { id: `role-${next}`, ...body.role }, scope: { id: `scope-${next}`, ...body.scope } };
        found.resourceRoleScopes.push(tamper(structuredClone(created)));
        return ok(201, created);
      }
      return notFound();
    },
  };
}

function journalClient() {
  const queries = [];
  return { queries, async query(sql, params) { queries.push({ sql, params }); return { rows: [{ id: queries.length }] }; } };
}

const context = (targets = []) => ({ targetIndex: new Map(targets), mappingTable: new Map(), runProvenance: new Map() });
const withRefs = (resource, referenceContext, extra = {}) => ({
  ...FAST, referenceContext,
  rewriteReferences: (payload) => rewriteReferences(payload, resource.references, referenceContext, resource.naturalKey, resource.resourceType),
  ...extra,
});

const packageResource = (extra = {}) => ({
  naturalKey: PACKAGE_KEY, resourceType: 'accessPackage', blastRadius: 'access-affecting',
  payload: {
    id: SOURCE_PACKAGE, displayName: 'KEEL-RT-Package', description: 'Finance access', isHidden: false,
    createdDateTime: '2026-01-01T00:00:00Z', modifiedDateTime: '2026-01-02T00:00:00Z',
    catalog: { id: SOURCE_CATALOG, displayName: 'KEEL-RT-Catalog', catalogType: 'userManaged', state: 'published' },
  },
  references: [{ field: 'catalog.id', symbol: CATALOG_KEY, required: true }],
  ...extra,
});

const targetCatalog = (resources = []) => ({ id: TARGET_CATALOG, displayName: 'KEEL-RT-Catalog', resources });
const groupResource = (originId = TARGET_GROUP) => ({ id: 'catalog-resource-group', displayName: 'KEEL-RT-finance', originId, originSystem: 'AadGroup' });

const bodies = (graph) => graph.calls.filter((call) => call.method !== 'GET').map((call) => call.body);
const noTrust = (graph) => {
  for (const body of bodies(graph)) {
    const keys = JSON.stringify(body).match(/"([^"]+)":/g) ?? [];
    for (const key of keys) assert.equal(TRUST_FIELD_PATTERN.test(key.slice(1, -2)), false, `no trust field in a body: ${key}`);
  }
};

// ------------------------------------------------------------ access package

test('an access package is created in the catalog the target holds, matched by natural key', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()] });
  const resource = packageResource();
  const client = journalClient();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(resource, context([[CATALOG_KEY, TARGET_CATALOG]]), {
    rollbackClient: client, runId: 'run-1', restoreRef: 'restore-1',
  }));
  assert.equal(result.failed, undefined, result.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, `${EM}/accessPackages`);
  assert.deepEqual(post.body, { displayName: 'KEEL-RT-Package', description: 'Finance access', isHidden: false, catalog: { id: TARGET_CATALOG } });
  assert.equal(result.applied.targetId, 'created-package-1');
  assert.ok(client.queries.some((query) => query.params.includes('succeeded')), 'journalled and verified');
  noTrust(graph);
});

test('an access package whose catalog is not in the target is refused with a clear reason, and nothing is written', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()] });
  const resource = packageResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(resource, context()));
  assert.match(result.failed?.error ?? '', /its catalog "KEEL-RT-Catalog" is not in the target.*restore the catalog first/);
  assert.equal(graph.calls.length, 0);
});

test('a backup that does not name the package\'s catalog cannot create it', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()] });
  const { catalog: _catalog, ...payload } = packageResource().payload;
  const resource = packageResource({ payload, references: [] });
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(resource, context()));
  assert.match(result.failed?.error ?? '', /does not say which catalog/);
  assert.equal(graph.calls.length, 0);
});

test('an access package update sends only the changed fields, never the catalog', async () => {
  const live = { id: TARGET_PACKAGE, displayName: 'KEEL-RT-Package', description: 'Changed by hand', isHidden: false, catalogId: TARGET_CATALOG };
  const graph = entitlementGraph({ catalogs: [targetCatalog()], packages: [live] });
  const resource = packageResource({
    live: { state: 'present', targetId: TARGET_PACKAGE, payload: { ...live, catalog: { id: TARGET_CATALOG } } },
  });
  const result = await applyIdentityObjectWrite(graph, resource, 'update', withRefs(resource, context([[CATALOG_KEY, TARGET_CATALOG]])));
  assert.equal(result.failed, undefined, result.failed?.error);
  const writes = graph.calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(writes, [{ method: 'PATCH', path: `${EM}/accessPackages/${TARGET_PACKAGE}`, body: { description: 'Finance access' } }]);
  assert.deepEqual(result.applied.changes.fields, ['description']);
});

test('a second restore after the create finds the package it made and does not create it twice', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()] });
  const resource = packageResource();
  const ctx = withRefs(resource, context([[CATALOG_KEY, TARGET_CATALOG]]));
  assert.equal((await applyIdentityObjectWrite(graph, resource, 'create', ctx)).failed, undefined);
  const again = await applyIdentityObjectWrite(graph, resource, 'create', ctx);
  assert.match(again.skipped?.reason ?? '', /already there/);
  assert.equal(graph.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(graph.state.packages.size, 1);
});

test('an access package is never deleted by a restore', async () => {
  const resource = packageResource({ live: { state: 'present', targetId: TARGET_PACKAGE, payload: packageResource().payload } });
  const graph = entitlementGraph();
  const result = await applyIdentityObjectWrite(graph, resource, 'delete', FAST);
  assert.match(result.failed?.error ?? '', /unsupported operation/);
  assert.equal(graph.calls.length, 0);
});

// --------------------------------------------------- resource role scopes

const roleScope = (system = 'AadGroup', extra = {}) => {
  const group = system === 'AadGroup';
  const origin = group ? SOURCE_GROUP : SITE;
  return {
    naturalKey: 'accessPackageResourceRoleScope:source-scope', resourceType: 'accessPackageResourceRoleScope', blastRadius: 'access-affecting',
    payload: {
      id: 'source-scope', createdDateTime: '2026-01-01T00:00:00Z',
      role: { id: 'source-role', displayName: group ? 'Member' : 'Visitors', originId: group ? `Member_${SOURCE_GROUP}` : '4', originSystem: system },
      scope: { id: 'source-root', displayName: 'Root', description: 'Root Scope', originId: origin, originSystem: system, isRootScope: true },
      accessPackageId: SOURCE_PACKAGE,
    },
    references: [
      { field: 'accessPackageId', symbol: PACKAGE_KEY, required: true },
      ...(group ? [{ field: 'scope.originId', symbol: GROUP_KEY, required: true }] : []),
      // Child ids the backup cannot name: never sent, never block the write.
      { field: 'role.id', symbol: null, required: true },
    ],
    ...extra,
  };
};
const TARGETS = [[PACKAGE_KEY, TARGET_PACKAGE], [GROUP_KEY, TARGET_GROUP]];
const targetPackage = (scopes = []) => ({ id: TARGET_PACKAGE, displayName: 'KEEL-RT-Package', catalogId: TARGET_CATALOG, resourceRoleScopes: scopes });
const approved = (resource) => classifyContentEffects([{ ...resource, verb: 'create' }]).effects;

test('resource roles are approval-held: each one is a "changes admin access" effect that names the group', () => {
  assert.ok(APPROVAL_HELD_KINDS.includes('accessPackageResourceRoleScope'));
  const effects = approved(roleScope());
  assert.deepEqual(effects.map((effect) => effect.field).sort(), ['role', 'scope']);
  assert.ok(effects.every((effect) => effect.effect === 'access-changing'));
  assert.match(effects.find((effect) => effect.field === 'scope').after, /group:KEEL-RT-finance/);
});

test('a resource role is added when its group is in the catalog, with the target\'s package, group and catalog resource', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog([groupResource()])], packages: [targetPackage()] });
  const resource = roleScope();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(resource, context(TARGETS), { approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(result.skipped, undefined, result.skipped?.reason);
  const writes = graph.calls.filter((call) => call.method !== 'GET');
  assert.equal(writes.length, 1, 'no catalog request: the group is there');
  assert.equal(writes[0].path, `${EM}/accessPackages/${TARGET_PACKAGE}/resourceRoleScopes`);
  assert.deepEqual(writes[0].body, {
    role: { displayName: 'Member', originId: `Member_${TARGET_GROUP}`, originSystem: 'AadGroup', resource: { originId: TARGET_GROUP, originSystem: 'AadGroup', id: 'catalog-resource-group' } },
    scope: { displayName: 'Root', description: 'Root Scope', originId: TARGET_GROUP, originSystem: 'AadGroup', isRootScope: true },
  });
  assert.equal(JSON.stringify(writes).includes(SOURCE_GROUP), false, 'never an id from the backup\'s tenant');
  assert.equal(result.applied.targetId, 'role-scope-1');
  noTrust(graph);
});

test('a group that exists live but is not in the catalog is added to it first (adminAdd)', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()], packages: [targetPackage()] });
  const resource = roleScope();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(resource, context(TARGETS), { approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  const writes = graph.calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(writes.map((call) => call.path), [`${EM}/resourceRequests`, `${EM}/accessPackages/${TARGET_PACKAGE}/resourceRoleScopes`]);
  assert.deepEqual(writes[0].body, { requestType: 'adminAdd', resource: { originId: TARGET_GROUP, originSystem: 'AadGroup' }, catalog: { id: TARGET_CATALOG } });
  assert.equal(writes[1].body.role.resource.id, graph.state.catalogs.get(TARGET_CATALOG).resources[0].id);
  noTrust(graph);
});

test('the dry run plans the catalog request and writes nothing', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()], packages: [targetPackage()] });
  const resource = roleScope();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(resource, context(TARGETS), { mode: 'dry-run' }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(result.applied.changes, { fields: ['role', 'scope'], addedToCatalog: ['AadGroup'] });
  assert.equal(graph.calls.filter((call) => call.method !== 'GET').length, 0);
});

test('a group that does not exist in the target is a manual step that names it, and nothing is written', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()], packages: [targetPackage()] });
  const resource = roleScope();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(resource, context([[PACKAGE_KEY, TARGET_PACKAGE]]), { approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', /^manual: The group this role grants does not exist in the target/);
  assert.match(result.skipped.completion[0].description, /the Member role of the group "KEEL-RT-finance"/);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/.test(result.skipped.completion[0].description), false, 'no raw ids in the step');
  assert.equal(graph.calls.length, 0);
});

test('a SharePoint site that is not in the catalog is a manual step; a restore never adds a site to a catalog', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()], packages: [targetPackage()] });
  const resource = roleScope('SharePointOnline');
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(resource, context(TARGETS), { approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', /^manual: The SharePoint site is not in the access package's catalog/);
  assert.match(result.skipped.completion[0].description, /the SharePoint site "https:\/\/contoso.sharepoint.com\/sites\/KEEL-RT-site"/);
  assert.equal(graph.calls.filter((call) => call.method !== 'GET').length, 0);
});

test('a SharePoint site already in the catalog gets its role added', async () => {
  const site = { id: 'catalog-resource-site', displayName: 'KEEL-RT-site', originId: SITE, originSystem: 'SharePointOnline' };
  const graph = entitlementGraph({ catalogs: [targetCatalog([site])], packages: [targetPackage()] });
  const resource = roleScope('SharePointOnline');
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(resource, context(TARGETS), { approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  const [write] = graph.calls.filter((call) => call.method !== 'GET');
  assert.equal(write.body.role.originId, '4');
  assert.equal(write.body.role.resource.id, 'catalog-resource-site');
});

test('without the approval a resource role is held as a manual step, and nothing is written', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog([groupResource()])], packages: [targetPackage()] });
  const resource = roleScope();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(resource, context(TARGETS), { mode: 'enforce' }));
  assert.match(result.skipped?.reason ?? '', /changes admin access/);
  assert.deepEqual([...result.skipped.completion[0].fields].sort(), ['role', 'scope']);
  assert.equal(graph.calls.length, 0);
});

test('a role the package already grants is not added twice (a re-run after the create)', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog([groupResource()])], packages: [targetPackage()] });
  const resource = roleScope();
  const ctx = withRefs(resource, context(TARGETS), { approvedContentEffects: approved(resource) });
  assert.equal((await applyIdentityObjectWrite(graph, resource, 'create', ctx)).failed, undefined);
  const again = await applyIdentityObjectWrite(graph, resource, 'create', ctx);
  assert.match(again.skipped?.reason ?? '', /already grants the Member role of the group "KEEL-RT-finance"/);
  assert.equal(graph.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(graph.state.packages.get(TARGET_PACKAGE).resourceRoleScopes.length, 1);
});

test('a resource role that reads back different is journalled uncertain and fails', async () => {
  const graph = entitlementGraph({
    catalogs: [targetCatalog([groupResource()])], packages: [targetPackage()],
    tamper: (scope) => ({ ...scope, role: { ...scope.role, originId: `Owner_${TARGET_GROUP}` } }),
  });
  const resource = roleScope();
  const client = journalClient();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(resource, context(TARGETS), {
    approvedContentEffects: approved(resource), rollbackClient: client, runId: 'run-1', restoreRef: 'restore-1',
  }));
  assert.match(result.failed?.error ?? '', /post-state: role did not read back as written/);
  assert.ok(client.queries.some((query) => query.params.includes('uncertain')), 'the journal records the write as uncertain');
});

test('a resource role whose package is not in the target fails as a dependency', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog([groupResource()])] });
  const resource = roleScope();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(resource, context([[GROUP_KEY, TARGET_GROUP]])));
  assert.match(result.failed?.error ?? '', /^dependency: the access package this role belongs to is not in the target/);
  assert.equal(graph.calls.length, 0);
});

// ------------------------------------------------- production applyWave path

const governor = { async acquire() {}, observeRetryAfter() {} };

test('remapping proof: both creates are qualified by this file', () => {
  for (const kind of ['accessPackage', 'accessPackageResourceRoleScope']) {
    assert.equal(remappingFor(kind, 'create').qualified, true, kind);
    assert.equal(remappingFor(kind, 'create').proofRef, 'engine/restore/accessPackageOperations.test.mjs', kind);
  }
});

test('applyWave: the package lands in the target\'s catalog, then its role on the target\'s group', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog()] });
  const pkg = { ...packageResource(), verb: 'create' };
  const first = await applyWave(graph, governor, [pkg], {
    targetTenant: 'fixture-tenant', mode: 'enforce', existingTargetIds: new Map([[CATALOG_KEY, TARGET_CATALOG]]),
  });
  assert.deepEqual(first.failed, [], JSON.stringify(first.failed));
  assert.equal(first.applied.length, 1);
  const created = [...graph.state.packages.values()][0];
  assert.equal(created.catalogId, TARGET_CATALOG);

  const role = { ...roleScope(), verb: 'create' };
  const second = await applyWave(graph, governor, [role], {
    targetTenant: 'fixture-tenant', mode: 'enforce',
    existingTargetIds: new Map([[PACKAGE_KEY, created.id], [GROUP_KEY, TARGET_GROUP]]),
    approvedContentEffects: classifyContentEffects([role]).effects,
  });
  assert.deepEqual(second.failed, [], JSON.stringify(second.failed));
  assert.deepEqual(second.skipped, [], JSON.stringify(second.skipped));
  const [granted] = graph.state.packages.get(created.id).resourceRoleScopes;
  assert.equal(granted.scope.originId, TARGET_GROUP);
  assert.equal(granted.role.originId, `Member_${TARGET_GROUP}`);
  noTrust(graph);
});

test('applyWave: an unapproved resource role is held and writes nothing', async () => {
  const graph = entitlementGraph({ catalogs: [targetCatalog([groupResource()])], packages: [targetPackage()] });
  const role = { ...roleScope(), verb: 'create' };
  const result = await applyWave(graph, governor, [role], {
    targetTenant: 'fixture-tenant', mode: 'enforce', existingTargetIds: new Map(TARGETS), approvedContentEffects: [],
  });
  assert.equal(result.applied.length, 0);
  assert.equal(graph.calls.filter((call) => call.method !== 'GET').length, 0);
});
