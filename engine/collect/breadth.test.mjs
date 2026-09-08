import { strict as assert } from 'node:assert';
import { GraphReader } from '../../tools/tenant-probe/graph.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { get } from './registry.mjs';
import { collectM1, collectWithOutcomes } from './entraAdapter.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { naturalKeyFor } from '../cir/naturalKey.mjs';

const tenantId = '11111111-1111-4111-8111-111111111111';
// Independent measured endpoint and recovery metadata fixtures: do not derive
// expectations from descriptors or CATALOG, which are the code under test.
const cases = [
  ['certificateBasedAuthConfiguration', `/v1.0/organization/${tenantId}/certificateBasedAuthConfiguration`, 'tier1', 'tenant-lockout'],
  ['homeRealmDiscoveryPolicy', '/v1.0/policies/homeRealmDiscoveryPolicies', 'tier1', 'tenant-lockout'],
  ['roleEligibilitySchedule', '/v1.0/roleManagement/directory/roleEligibilitySchedules', 'tier1', 'tenant-lockout'],
  ['oauth2PermissionGrant', '/v1.0/oauth2PermissionGrants', 'tier1', 'access-affecting'],
  ['directoryRoleTemplate', '/v1.0/directoryRoleTemplates', 'tier3', 'cosmetic'],
  ['directorySettingTemplate', '/v1.0/groupSettingTemplates', 'tier3', 'cosmetic'],
  ['authenticationContextClassReference', '/v1.0/identity/conditionalAccess/authenticationContextClassReferences', 'tier2', 'access-affecting'],
  ['activityBasedTimeoutPolicy', '/v1.0/policies/activityBasedTimeoutPolicies', 'tier2', 'access-affecting'],
  ['claimsMappingPolicy', '/v1.0/policies/claimsMappingPolicies', 'tier2', 'access-affecting'],
  ['tokenIssuancePolicy', '/v1.0/policies/tokenIssuancePolicies', 'tier2', 'access-affecting'],
  ['tokenLifetimePolicy', '/v1.0/policies/tokenLifetimePolicies', 'tier2', 'access-affecting'],
  ['featureRolloutPolicy', '/v1.0/policies/featureRolloutPolicies', 'tier3', 'cosmetic'],
  ['accessPackage', '/v1.0/identityGovernance/entitlementManagement/accessPackages', 'tier2', 'access-affecting'],
  ['connectedOrganization', '/v1.0/identityGovernance/entitlementManagement/connectedOrganizations', 'tier2', 'access-affecting'],
  ['deviceEnrollmentConfiguration', '/v1.0/deviceManagement/deviceEnrollmentConfigurations', 'tier2', 'access-affecting'],
  ['deviceCategory', '/v1.0/deviceManagement/deviceCategories', 'tier3', 'cosmetic'],
  ['managedAppPolicy', '/v1.0/deviceAppManagement/managedAppPolicies', 'tier2', 'access-affecting'],
  ['targetedManagedAppConfiguration', '/v1.0/deviceAppManagement/targetedManagedAppConfigurations', 'tier2', 'access-affecting'],
  ['mobileAppConfiguration', '/v1.0/deviceAppManagement/mobileAppConfigurations', 'tier2', 'access-affecting'],
  ['termsAndConditions', '/beta/deviceManagement/termsAndConditions', 'tier3', 'cosmetic'],
  ['windowsAutopilotDeploymentProfile', '/beta/deviceManagement/windowsAutopilotDeploymentProfiles', 'tier2', 'access-affecting'],
  ['deviceManagementIntent', '/beta/deviceManagement/intents', 'tier2', 'access-affecting'],
  ['managedDevice', '/v1.0/deviceManagement/managedDevices', 'tier3', 'cosmetic'],
  ['contact', '/v1.0/contacts', 'tier3', 'cosmetic'],
];
assert.equal(cases.length, 24);
const respond = (body, status = 200) => ({
  ok: status === 200, status, headers: { get: () => null }, json: async () => body,
});
const originalFetch = globalThis.fetch;
try {
  for (const [type, endpoint, criticality, blastRadius] of cases) {
    const { descriptor, adapter } = get(type);
    const singleton = type === 'certificateBasedAuthConfiguration';
    assert.equal(descriptor.fidelity, 'read-only', type);
    assert.equal(descriptor.remappable, false, type);
    assert.equal(descriptor.criticality, criticality, type);
    assert.equal(descriptor.blastRadius, blastRadius, type);
    assert.equal(descriptor.naturalKeyStrategy, singleton ? 'constant' : 'id', type);
    assert.equal(descriptor.adapter, `graph-native/${type}`);
    if (singleton) assert.equal(CATALOG.find((entry) => entry.type === type).singleton, true);

    const object = singleton ? { certificateAuthorities: [] } : { id: `${type}-1`, displayName: 'Shared name' };
    let calls = 0;
    globalThis.fetch = async (url, opts) => {
      calls++;
      assert.equal(opts.method, 'GET');
      assert.equal(opts.headers['Accept-Language'], 'en-US');
      assert.equal(url, `https://graph.microsoft.com${endpoint}`, `${type}: measured endpoint, no unsolicited $top`);
      return respond(singleton ? object : { value: [object] });
    };
    const reader = new GraphReader(async () => 'fixture-token');
    const objects = await adapter.collect(reader, { tenantId });
    assert.equal(calls, 1);
    assert.deepEqual(objects, [object], `${type}: singleton/collection decoded without dropping payload`);
    const resources = canonicalizeAll([[type, objects]]);
    assert.equal(resources.length, 1);
    assert.equal(resources[0].naturalKey, `${type}:${singleton ? type : object.id}`);
    assert.equal(resources[0].provenance.fidelity, 'read-only');
    assert.deepEqual(resources[0].payload, object);

    if (!singleton) {
      // Same name, different ids: names are not silently claimed to be unique.
      const duplicateName = { ...object, id: `${type}-2` };
      assert.deepEqual(canonicalizeAll([[type, [object, duplicateName]]]).map((r) => r.naturalKey), [
        `${type}:${type}-1`, `${type}:${type}-2`,
      ]);
      assert.throws(() => naturalKeyFor(type, { displayName: 'Missing id' }), /missing id/);
    }
    globalThis.fetch = async () => respond(singleton ? null : { value: [] });
    assert.deepEqual(await adapter.collect(reader, { tenantId }), [], `${type}: successful empty response`);
    globalThis.fetch = async () => respond({ error: { message: 'fixture denied' } }, 403);
    await assert.rejects(() => adapter.collect(reader, { tenantId }), /fixture denied/, type);
  }

  // $top regression exercises both the actual adapter and GraphReader. The
  // simulated endpoint rejects $top exactly as Graph does, including page 2.
  const urls = [];
  globalThis.fetch = async (url) => {
    const request = new URL(url);
    urls.push(url);
    if (request.searchParams.has('$top')) return respond({ error: { code: 'Request_UnsupportedQuery', message: '$top is unsupported' } }, 400);
    if (request.searchParams.has('$skiptoken')) return respond({ value: [{ id: 'template-2' }] });
    return respond({ value: [{ id: 'template-1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/directoryRoleTemplates?$skiptoken=next' });
  };
  const templates = await get('directoryRoleTemplate').adapter.collect(new GraphReader(async () => 'fixture-token'));
  assert.deepEqual(templates, [{ id: 'template-1' }, { id: 'template-2' }]);
  assert.deepEqual(urls, [
    'https://graph.microsoft.com/v1.0/directoryRoleTemplates',
    'https://graph.microsoft.com/v1.0/directoryRoleTemplates?$skiptoken=next',
  ]);

  // Older collectM1 callers can obtain the tenant id from organization; the
  // snapshot CLI also supplies it explicitly so an org read failure need not
  // prevent an independently successful certificate configuration read.
  const paths = [];
  const reader = { async collect(version, path) {
    paths.push(path);
    return { items: path === '/organization' ? [{ id: tenantId, displayName: 'Fixture' }] : [] };
  } };
  const all = await collectM1(reader);
  assert.equal(all.length, 52);
  assert.ok(paths.includes(`/organization/${tenantId}/certificateBasedAuthConfiguration`));
  const before = paths.length;
  await assert.rejects(() => get('certificateBasedAuthConfiguration').adapter.collect(reader), /tenantId required/);
  assert.equal(paths.length, before, 'never send an unresolved organization placeholder');
  const empty = await collectWithOutcomes({ collect: async () => ({ items: [] }) }, { tenantId });
  assert.equal(Object.keys(empty.coverageDigest).length, 52);
  for (const entry of Object.values(empty.coverageDigest)) assert.deepEqual(entry, { outcome: 'complete', itemCount: 0 });
} finally {
  globalThis.fetch = originalFetch;
}

// Newly collected global role templates must not rename existing assignments,
// with or without an active roleDefinition that shares the template id.
const roleId = '62e90394-69f5-4237-9190-012177145e10';
const base = [
  ['user', [{ id: 'u1', userPrincipalName: 'admin@example.test' }]],
  ['roleAssignment', [{ id: 'ra1', roleDefinitionId: roleId, principalId: 'u1', directoryScopeId: '/' }]],
];
for (const definitions of [[], [['roleDefinition', [{ id: roleId, templateId: roleId }]]]]) {
  const before = canonicalizeAll([...base, ...definitions]);
  const after = canonicalizeAll([...base, ...definitions, ['directoryRoleTemplate', [{ id: roleId, displayName: 'Global Administrator' }]]]);
  assert.equal(after.find((r) => r.resourceType === 'roleAssignment').naturalKey,
    before.find((r) => r.resourceType === 'roleAssignment').naturalKey);
}

// References to inventory keyed by id must resolve to the emitted CIR key,
// even when the probe's name-based index can also resolve the same GUID.
const connectedId = '22222222-2222-4222-8222-222222222222';
const resources = canonicalizeAll([
  ['connectedOrganization', [{ id: connectedId, displayName: 'Partner' }]],
  ['accessPackage', [{ id: 'package-1', displayName: 'Access', connectedOrganizationId: connectedId }]],
]);
assert.equal(resources.find((r) => r.resourceType === 'accessPackage').references[0].symbol, `connectedOrganization:${connectedId}`);
console.log('breadth.test.mjs — all 24 types passed endpoint, outcome, key and fidelity assertions');
