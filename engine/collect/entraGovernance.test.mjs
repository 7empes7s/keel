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

test('the family lists exactly these types', () => {
  assert.deepEqual(entraGovernance.map((entry) => entry.type), CASES.map(([type]) => type));
  for (const [type, , singleton] of CASES) {
    assert.equal(entraGovernance.find((entry) => entry.type === type).singleton === true, singleton, `${type} singleton`);
  }
});

test('each type collects a KEEL-RT- fixture with one GET and canonicalizes it read-only', async () => {
  for (const [type, endpoint, singleton] of CASES) {
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
