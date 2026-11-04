/**
 * Wave 1 CAT-ENTRA: each Entra governance type collects from a fixture through
 * the real adapter and GraphReader, read-only, and canonicalizes. Endpoints are
 * written out here, not derived from the catalogue under test.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GraphReader } from '../../tools/tenant-probe/graph.mjs';
import entraGovernance from '../../tools/tenant-probe/catalog.d/entra-governance.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { get } from './registry.mjs';
import { collectWithOutcomes } from './entraAdapter.mjs';

const G = 'https://graph.microsoft.com/v1.0';
// [type, endpoint, singleton]
const CASES = [
  ['lifecycleWorkflow', '/identityGovernance/lifecycleWorkflows/workflows?$expand=tasks', false],
  ['lifecycleWorkflowCustomTaskExtension', '/identityGovernance/lifecycleWorkflows/customTaskExtensions', false],
  ['lifecycleManagementSettings', '/identityGovernance/lifecycleWorkflows/settings', true],
  ['attributeSet', '/directory/attributeSets', false],
  ['customSecurityAttributeDefinition', '/directory/customSecurityAttributeDefinitions?$expand=allowedValues', false],
  ['accessPackageCatalog', '/identityGovernance/entitlementManagement/catalogs', false],
  ['accessPackageAssignmentPolicy', '/identityGovernance/entitlementManagement/assignmentPolicies?$expand=accessPackage', false],
  ['accessPackageAssignment', '/identityGovernance/entitlementManagement/assignments?$expand=target,accessPackage', false],
  ['entitlementManagementSettings', '/identityGovernance/entitlementManagement/settings', true],
  ['agreement', '/identityGovernance/termsOfUse/agreements', false],
  ['appManagementPolicy', '/policies/appManagementPolicies', false],
  ['tenantAppManagementPolicy', '/policies/defaultAppManagementPolicy', true],
  ['multiTenantOrganization', '/tenantRelationships/multiTenantOrganization', true],
  ['b2xIdentityUserFlow', '/identity/b2xUserFlows', false],
  ['identityApiConnector', '/identity/apiConnectors', false],
];

const respond = (body, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body });

async function withFetch(fetch, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

// Issue #992: read once per catalog, so it has its own tests below.
const PER_CATALOG = 'accessPackageCatalogResource';

test('the family lists exactly these types', () => {
  assert.deepEqual(entraGovernance.map((entry) => entry.type).filter((type) => type !== PER_CATALOG), CASES.map(([type]) => type));
  assert.equal(entraGovernance.findIndex((entry) => entry.type === PER_CATALOG), entraGovernance.findIndex((entry) => entry.type === 'accessPackageCatalog') + 1,
    'the catalog resources sit next to the catalogs');
  for (const [type, , singleton] of CASES) {
    assert.equal(entraGovernance.find((entry) => entry.type === type).singleton === true, singleton, `${type} singleton`);
  }
});

// Issue #995: a user flow's parts are read per flow (its own test below).
const PER_OBJECT_READS = new Set(['b2xIdentityUserFlow']);

test('each type collects a KEEL-RT- fixture with one GET and canonicalizes it read-only', async () => {
  for (const [type, endpoint, singleton] of CASES) {
    if (PER_OBJECT_READS.has(type)) continue;
    const { descriptor, adapter } = get(type);
    assert.equal(descriptor.fidelity, 'read-only', type);
    assert.equal(descriptor.remappable, false, type);
    assert.equal(descriptor.naturalKeyStrategy, singleton ? 'constant' : 'id', type);
    const object = singleton
      ? { id: `${type}-singleton`, displayName: `KEEL-RT-${type}` }
      : { id: `KEEL-RT-${type}-1`, displayName: `KEEL-RT-${type}` };
    const urls = [];
    const objects = await withFetch(async (url, opts) => {
      assert.equal(opts.method, 'GET', `${type} reads only`);
      urls.push(url);
      return respond(singleton ? object : { value: [object] });
    }, () => adapter.collect(new GraphReader(async () => 'fixture-token')));
    assert.deepEqual(urls, [`${G}${endpoint}`], type);
    assert.deepEqual(objects, [object], type);
    const [resource, ...rest] = canonicalizeAll([[type, objects]]);
    assert.equal(rest.length, 0, type);
    assert.equal(resource.naturalKey, `${type}:${singleton ? type : object.id}`);
    assert.deepEqual(resource.payload, object);
  }
});

test('a user flow is collected with its identity providers, attributes in order, languages and API connector steps (#995)', async () => {
  const { adapter } = get('b2xIdentityUserFlow');
  const flow = { id: 'B2X_1_KEEL-RT-flow', userFlowType: 'signUpOrSignIn', userFlowTypeVersion: 1 };
  const base = `${G}/identity/b2xUserFlows/B2X_1_KEEL-RT-flow`;
  const answers = new Map([
    [`${G}/identity/b2xUserFlows`, { value: [flow] }],
    [`${base}/identityProviders`, { value: [{ id: 'Google-OAUTH', name: 'Google', type: 'Google', clientId: 'fixture-id', clientSecret: '******' }] }],
    [`${base}/userAttributeAssignments?$expand=userAttribute`, { value: [{ id: 'city', displayName: 'City' }, { id: 'extension_1_Size', displayName: 'Size' }] }],
    [`${base}/languages`, { value: [{ id: 'fr', isEnabled: false, displayName: 'French' }, { id: 'en', isEnabled: true, displayName: 'English' }] }],
    [`${base}?$expand=apiConnectorConfiguration/postFederationSignup,apiConnectorConfiguration/postAttributeCollection`,
      { ...flow, apiConnectorConfiguration: { postAttributeCollection: { id: 'conn-1', displayName: 'KEEL-RT-check', targetUrl: 'https://keel-rt.example', authenticationConfiguration: { password: '******' } } } }],
  ]);
  const urls = [];
  const objects = await withFetch(async (url, opts) => {
    assert.equal(opts.method, 'GET');
    urls.push(url);
    assert.ok(answers.has(url), url);
    return respond(answers.get(url));
  }, () => adapter.collect(new GraphReader(async () => 'fixture-token')));
  assert.deepEqual(urls, [...answers.keys()]);
  assert.deepEqual(objects, [{
    ...flow,
    identityProviders: [{ id: 'Google-OAUTH', name: 'Google', type: 'Google' }],
    userAttributeAssignments: [{ id: 'city', displayName: 'City' }, { id: 'extension_1_Size', displayName: 'Size' }],
    languages: [{ id: 'en', isEnabled: true, displayName: 'English' }, { id: 'fr', isEnabled: false, displayName: 'French' }],
    apiConnectorConfiguration: { postAttributeCollection: { id: 'conn-1', displayName: 'KEEL-RT-check' } },
  }]);
});

test('a denied or empty read is reported, never a silent success', async () => {
  for (const [type, , singleton] of CASES) {
    const { adapter } = get(type);
    const reader = new GraphReader(async () => 'fixture-token');
    assert.deepEqual(await withFetch(async () => respond(singleton ? null : { value: [] }), () => adapter.collect(reader)), [], type);
    await assert.rejects(
      withFetch(async () => respond({ error: { code: 'Authorization_RequestDenied', message: 'fixture denied' } }, 403), () => adapter.collect(reader)),
      /fixture denied/, type);
  }
  const digest = await collectWithOutcomes({ collect: async () => ({ items: [] }) }, { tenantId: '11111111-1111-4111-8111-111111111111' });
  for (const [type] of CASES) assert.equal(digest.coverageDigest[type]?.outcome, 'complete-empty', type);
});

test('a plain-word id is never read as a reference from another payload', () => {
  const resources = canonicalizeAll([
    ['attributeSet', [{ id: 'Engineering', description: 'KEEL-RT-set' }]],
    ['customSecurityAttributeDefinition', [{ id: 'Engineering_Project', attributeSet: 'Engineering', name: 'Project' }]],
    ['b2xIdentityUserFlow', [{ id: 'B2X_1_KEEL-RT-flow' }]],
    ['user', [{ id: '11111111-1111-4111-8111-111111111111', userPrincipalName: 'keel-rt-user@example.test', department: 'Engineering', jobTitle: 'B2X_1_KEEL-RT-flow' }]],
  ]);
  const user = resources.find((resource) => resource.resourceType === 'user');
  assert.deepEqual(user.references.map((ref) => ref.symbol).filter((symbol) => /attributeSet|b2xIdentityUserFlow/.test(symbol)), []);
});

// Issue #992: a catalog's groups, apps and sites, read under each catalog with
// their roles and scopes and tagged with the catalog.
const CATALOG_ID = '88888888-8888-4888-8888-888888888888';
const GROUP_ID = '99999999-9999-4999-8999-999999999999';
const CATALOG_RESOURCE = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'KEEL-RT-group', originId: GROUP_ID, originSystem: 'AadGroup',
  roles: [{ id: 'r1', displayName: 'Member', originId: `Member_${GROUP_ID}`, originSystem: 'AadGroup' }],
  scopes: [{ id: 's1', displayName: 'Root', originId: GROUP_ID, originSystem: 'AadGroup', isRootScope: true }],
};

test('catalog resources are read under each catalog with their roles and scopes, tagged with the catalog', async () => {
  const { descriptor, adapter } = get(PER_CATALOG);
  assert.equal(descriptor.fidelity, 'read-only');
  assert.equal(descriptor.naturalKeyStrategy, 'id');
  const urls = [];
  const objects = await withFetch(async (url, opts) => {
    assert.equal(opts.method, 'GET', 'reads only');
    urls.push(url);
    if (url === `${G}/identityGovernance/entitlementManagement/catalogs?$select=id`) return respond({ value: [{ id: CATALOG_ID }] });
    if (url === `${G}/identityGovernance/entitlementManagement/catalogs/${CATALOG_ID}/resources?$expand=roles,scopes`) return respond({ value: [CATALOG_RESOURCE] });
    throw new Error(`unexpected request ${url}`);
  }, () => adapter.collect(new GraphReader(async () => 'fixture-token')));
  assert.equal(urls.length, 2);
  assert.deepEqual(objects, [{ ...CATALOG_RESOURCE, catalogId: CATALOG_ID }]);
  const [resource] = canonicalizeAll([[PER_CATALOG, objects]]);
  assert.equal(resource.naturalKey, `${PER_CATALOG}:${CATALOG_RESOURCE.id}`);
});

test('a denied read of a catalog\'s resources fails the type, never an empty success', async () => {
  const { adapter } = get(PER_CATALOG);
  await assert.rejects(withFetch(async (url) => (url.endsWith('catalogs?$select=id')
    ? respond({ value: [{ id: CATALOG_ID }] })
    : respond({ error: { code: 'Authorization_RequestDenied', message: 'fixture denied' } }, 403)), () => adapter.collect(new GraphReader(async () => 'fixture-token'))), /fixture denied/);
});
