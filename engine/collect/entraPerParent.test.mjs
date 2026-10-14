/**
 * Entra types read per parent object: each partner's cross-tenant sync
 * settings, each service principal's sync jobs and each access package's
 * resource roles. Collected from fixtures through the real adapter and
 * GraphReader, GET only. Endpoints are written out here, not derived from the
 * catalogue under test.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GraphReader } from '../../tools/tenant-probe/graph.mjs';
import entraPerParent from '../../tools/tenant-probe/catalog.d/entra-per-parent.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { get } from './registry.mjs';
import { collectWithOutcomes } from './entraAdapter.mjs';

const G = 'https://graph.microsoft.com/v1.0';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const SP = '33333333-3333-4333-8333-333333333333';
const MS_SP = '44444444-4444-4444-8444-444444444444';
const PACKAGE = '55555555-5555-4555-8555-555555555555';
const JOB = 'Azure2Azure.33333333333343338333333333333333.66666666-6666-4666-8666-666666666666';
const SCOPE = '77777777-7777-4777-8777-777777777777';

const respond = (body, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body });
const denied = () => respond({ error: { code: 'Authorization_RequestDenied', message: 'fixture denied' } }, 403);
const notFound = () => respond({ error: { code: 'ResourceNotFound', message: 'fixture absent' } }, 404);

// One Graph fixture tenant: one partner with sync settings and one without,
// one cross-tenant sync service principal and one Microsoft one (no
// template), and one access package with one resource role.
const ROUTES = {
  [`${G}/policies/crossTenantAccessPolicy/partners`]: () => respond({ value: [{ tenantId: PARTNER }, { tenantId: 'absent-partner' }] }),
  [`${G}/policies/crossTenantAccessPolicy/partners/${PARTNER}/identitySynchronization`]: () => respond({ tenantId: PARTNER, displayName: 'KEEL-RT-partner', userSyncInbound: { isSyncAllowed: true } }),
  [`${G}/policies/crossTenantAccessPolicy/partners/absent-partner/identitySynchronization`]: notFound,
  [`${G}/servicePrincipals?$select=id,applicationTemplateId&$top=999`]: () => respond({ value: [
    { id: SP, applicationTemplateId: '518e5f48-1fc8-4c48-9387-9fdf28b0dfe7' }, { id: MS_SP, applicationTemplateId: null },
  ] }),
  [`${G}/servicePrincipals/${SP}/synchronization/jobs`]: () => respond({ value: [{ id: JOB, templateId: 'Azure2Azure', schedule: { state: 'Active' } }] }),
  [`${G}/identityGovernance/entitlementManagement/accessPackages?$select=id`]: () => respond({ value: [{ id: PACKAGE }] }),
  [`${G}/identityGovernance/entitlementManagement/accessPackages/${PACKAGE}?$expand=resourceRoleScopes($expand=role,scope)`]: () => respond({
    id: PACKAGE, displayName: 'KEEL-RT-package',
    resourceRoleScopes: [{ id: SCOPE, role: { originId: 'Member', displayName: 'Member' }, scope: { originId: 'KEEL-RT-group' } }],
  }),
};

async function withRoutes(routes, fn) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, opts) => {
    assert.equal(opts.method, 'GET', 'reads only');
    urls.push(url);
    const route = routes[url];
    assert.ok(route, `unexpected request ${url}`);
    return route();
  };
  try { return { result: await fn(), urls }; } finally { globalThis.fetch = original; }
}

const reader = () => new GraphReader(async () => 'fixture-token');

test('each partner\'s sync settings are read under it; a partner without them is absent', async () => {
  const { result, urls } = await withRoutes(ROUTES, () => get('crossTenantIdentitySyncPolicyPartner').adapter.collect(reader()));
  assert.deepEqual(urls, [
    `${G}/policies/crossTenantAccessPolicy/partners`,
    `${G}/policies/crossTenantAccessPolicy/partners/${PARTNER}/identitySynchronization`,
    `${G}/policies/crossTenantAccessPolicy/partners/absent-partner/identitySynchronization`,
  ]);
  assert.deepEqual(result, [{ tenantId: PARTNER, displayName: 'KEEL-RT-partner', userSyncInbound: { isSyncAllowed: true } }]);
  const [resource] = canonicalizeAll([['crossTenantIdentitySyncPolicyPartner', result]]);
  assert.equal(resource.naturalKey, `crossTenantIdentitySyncPolicyPartner:${PARTNER}`);
});

test('sync jobs are read only for service principals made from an app template, tagged with their service principal', async () => {
  const { result, urls } = await withRoutes(ROUTES, () => get('synchronizationJob').adapter.collect(reader()));
  assert.deepEqual(urls, [`${G}/servicePrincipals?$select=id,applicationTemplateId&$top=999`, `${G}/servicePrincipals/${SP}/synchronization/jobs`]);
  assert.deepEqual(result, [{ id: JOB, templateId: 'Azure2Azure', schedule: { state: 'Active' }, servicePrincipalId: SP }]);
  const [resource] = canonicalizeAll([['synchronizationJob', result]]);
  assert.equal(resource.naturalKey, `synchronizationJob:${JOB}`);
});

test('an access package\'s resource roles are taken from its expanded read, tagged with the package', async () => {
  const { result } = await withRoutes(ROUTES, () => get('accessPackageResourceRoleScope').adapter.collect(reader()));
  assert.deepEqual(result, [{
    id: SCOPE, role: { originId: 'Member', displayName: 'Member' }, scope: { originId: 'KEEL-RT-group' }, accessPackageId: PACKAGE,
  }]);
  const [resource] = canonicalizeAll([['accessPackageResourceRoleScope', result]]);
  assert.equal(resource.naturalKey, `accessPackageResourceRoleScope:${SCOPE}`);
});

test('the family lists exactly these types', () => {
  assert.deepEqual(entraPerParent.map((entry) => entry.type), ['crossTenantIdentitySyncPolicyPartner', 'synchronizationJob', 'accessPackageResourceRoleScope']);
});

test('every per-parent type is read-only and keyed as documented', () => {
  for (const [type, strategy] of [['crossTenantIdentitySyncPolicyPartner', 'tenantId'], ['synchronizationJob', 'id'], ['accessPackageResourceRoleScope', 'id']]) {
    const { descriptor } = get(type);
    assert.equal(descriptor.fidelity, 'read-only', type);
    assert.equal(descriptor.remappable, false, type);
    assert.equal(descriptor.naturalKeyStrategy, strategy, type);
  }
});

test('a denied read of the parents or of any child fails the type, never an empty success', async () => {
  const cases = [
    ['crossTenantIdentitySyncPolicyPartner', `${G}/policies/crossTenantAccessPolicy/partners`],
    ['crossTenantIdentitySyncPolicyPartner', `${G}/policies/crossTenantAccessPolicy/partners/${PARTNER}/identitySynchronization`],
    ['synchronizationJob', `${G}/servicePrincipals?$select=id,applicationTemplateId&$top=999`],
    ['synchronizationJob', `${G}/servicePrincipals/${SP}/synchronization/jobs`],
    ['accessPackageResourceRoleScope', `${G}/identityGovernance/entitlementManagement/accessPackages?$select=id`],
    ['accessPackageResourceRoleScope', `${G}/identityGovernance/entitlementManagement/accessPackages/${PACKAGE}?$expand=resourceRoleScopes($expand=role,scope)`],
  ];
  for (const [type, deniedUrl] of cases) {
    const routes = { ...ROUTES, [deniedUrl]: denied };
    const { adapter } = get(type);
    await withRoutes(routes, () => assert.rejects(adapter.collect(reader()), /fixture denied/, deniedUrl));
    const { result: raw } = await withRoutes(routes, () => adapter.collectRaw(reader()));
    assert.equal(raw.error.status, 403, deniedUrl);
    assert.equal(raw.pages, 0, `${deniedUrl}: nothing under a parent was read, so the outcome is failed`);
  }
});

test('a 404 on a child is an absence only where the type allows it', async () => {
  const routes = {
    ...ROUTES,
    [`${G}/identityGovernance/entitlementManagement/accessPackages/${PACKAGE}?$expand=resourceRoleScopes($expand=role,scope)`]: notFound,
  };
  await withRoutes(routes, () => assert.rejects(get('accessPackageResourceRoleScope').adapter.collect(reader()), /fixture absent/));
});

test('a package read without the expanded roles fails rather than reading as no roles', async () => {
  const routes = {
    ...ROUTES,
    [`${G}/identityGovernance/entitlementManagement/accessPackages/${PACKAGE}?$expand=resourceRoleScopes($expand=role,scope)`]: () => respond({ id: PACKAGE }),
  };
  await withRoutes(routes, () => assert.rejects(get('accessPackageResourceRoleScope').adapter.collect(reader()), /returned no resourceRoleScopes/));
});

test('the coverage digest reports a denied child as failed and an empty tenant as complete-empty', async () => {
  const deniedChild = { collect: async (version, path) => (path.endsWith('/synchronization/jobs')
    ? { items: [], pages: 0, status: 403, capped: false, error: { ok: false, status: 403, code: 'Authorization_RequestDenied', error: 'fixture denied' } }
    : { items: path.startsWith('/servicePrincipals') ? [{ id: SP, applicationTemplateId: 'template' }] : [], pages: 1, status: 200, capped: false, error: null }) };
  const { coverageDigest, collected } = await collectWithOutcomes(deniedChild, { tenantId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(coverageDigest.synchronizationJob.outcome, 'failed');
  assert.equal(coverageDigest.synchronizationJob.httpStatus, 403);
  assert.equal(coverageDigest.synchronizationJob.endpoint, '/servicePrincipals/{parent}/synchronization/jobs');
  assert.ok(!collected.some(([type]) => type === 'synchronizationJob'));
  assert.equal(coverageDigest.crossTenantIdentitySyncPolicyPartner.outcome, 'complete-empty');
  assert.equal(coverageDigest.accessPackageResourceRoleScope.outcome, 'complete-empty');
});
