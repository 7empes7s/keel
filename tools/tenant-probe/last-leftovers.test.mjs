import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import lastLeftovers from './catalog.d/last-leftovers.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';
import { catalogedGraphPaths, skippedGraphPaths } from '../../engine/discovery/catalogue.mjs';
import { ALIAS_PATHS, SKIPPED_PATHS } from '../../engine/discovery/notGaps.mjs';
import { perParentReadPath } from '../../engine/collect/entraAdapter.mjs';

// Independent expectations: the documented Graph route for each type, written
// out here rather than derived from the catalogue under test.
const HARDWARE_SELECT = 'id,createdDateTime,description,displayName,fileName,hardwareConfigurationFormat,lastModifiedDateTime,perDevicePasswordDisabled,roleScopeTagIds,version';
const EXTENSION_SELECT = 'id,displayName,description,authenticationConfiguration,clientConfiguration,customAttributes,resourceType,type';
const EXPECTED = [
  ['hardwareConfiguration', `/beta/deviceManagement/hardwareConfigurations?$select=${HARDWARE_SELECT}`],
  ['certificateBasedApplicationConfiguration', '/beta/directory/certificateAuthorities/certificateBasedApplicationConfigurations'],
  ['signInIdentifier', '/beta/identity/signInIdentifiers'],
  ['verifiedIdProfile', '/beta/identity/verifiedId/profiles'],
  ['externalOriginResourceConnector', '/beta/identityGovernance/entitlementManagement/externalOriginResourceConnectors'],
  ['lifecyclePolicy', '/beta/identityGovernance/lifecycleWorkflows/lifecyclePolicies'],
  ['roleManagementCustomExtension', `/v1.0/identityGovernance/privilegedAccess/customExtensions?$select=${EXTENSION_SELECT}`],
  ['privilegedAccessGroupResource', '/beta/identityGovernance/privilegedAccess/group/resources'],
  ['crossTenantM365Capability', '/beta/policies/crossTenantAccessPolicy/default/m365Capabilities'],
  ['entitlementManagementRoleAssignment', 'per-parent'],
  ['deviceTemplate', '/beta/templates/deviceTemplates'],
  ['securityZone', '/beta/security/zones'],
  ['sharedEmailDomain', '/beta/directory/sharedEmailDomains'],
  ['schemaExtension', 'per-parent'],
];

test('the last leftovers family holds exactly the planned types, all in CATALOG', () => {
  assert.deepEqual(lastLeftovers.map((entry) => entry.type), EXPECTED.map(([type]) => type));
  for (const [type] of EXPECTED) {
    const entry = catalogEntryFor(type);
    assert.ok(entry, `${type} is in CATALOG`);
    assert.ok(['tier1', 'tier2', 'tier3'].includes(entry.criticality), type);
    assert.ok(['tenant-lockout', 'access-affecting', 'cosmetic'].includes(entry.blastRadius), type);
    assert.ok(!entry.singleton && !entry.needsOrgId, `${type} is a list`);
    // A page cap would leave the backup incomplete; these types are read in full.
    assert.equal(entry.pageCap, undefined, type);
  }
});

test('secret fields are left out of the read', () => {
  const hardware = catalogEntryFor('hardwareConfiguration').select.split(',');
  assert.ok(!hardware.includes('configurationFileContent'), 'the BIOS settings file can hold the BIOS password');
  for (const needed of ['displayName', 'hardwareConfigurationFormat', 'perDevicePasswordDisabled']) assert.ok(hardware.includes(needed), needed);
  const extension = catalogEntryFor('roleManagementCustomExtension').select.split(',');
  assert.ok(!extension.includes('endpointConfiguration'), 'a Logic App callback address can carry its signature');
  // No read reaches a field that holds a secret, or a path whose payload is one.
  for (const entry of lastLeftovers) {
    assert.ok(!/configurationFileContent|endpointConfiguration|activationCodes|customXml|secret|token/i.test(`${entry.path} ${entry.select ?? ''}`), entry.type);
    assert.ok(!/groupPolicyObjectFiles|embeddedSIMActivationCodePools|resourceAccessProfiles/i.test(entry.path), entry.type);
  }
});

test('no type duplicates an existing catalogue path or type', () => {
  const ours = new Set(lastLeftovers.map((entry) => entry.type));
  const others = CATALOG.filter((entry) => !ours.has(entry.type));
  assert.equal(CATALOG.length, others.length + ours.size, 'each type appears once');
  const otherPaths = new Set(others.map((entry) => `${entry.version}${entry.path}`.toLowerCase()));
  for (const entry of lastLeftovers) assert.ok(!otherPaths.has(`${entry.version}${entry.path}`.toLowerCase()), entry.type);
});

test('every Q104 gap left after batch 7 is now backed up, an alias, or skipped with a reason', () => {
  const catalogued = catalogedGraphPaths();
  const skipped = skippedGraphPaths();
  const backedUp = {
    '/certificateAuthorities/certificateBasedApplicationConfigurations': 'certificateBasedApplicationConfiguration',
    '/deviceManagement/hardwareConfigurations': 'hardwareConfiguration',
    '/directory/certificateAuthorities/certificateBasedApplicationConfigurations': 'certificateBasedApplicationConfiguration',
    '/directory/sharedEmailDomains': 'sharedEmailDomain',
    '/directory/templates/deviceTemplates': 'deviceTemplate',
    '/identity/signInIdentifiers': 'signInIdentifier',
    '/identity/verifiedId/profiles': 'verifiedIdProfile',
    '/identityGovernance/accessReviews/unified/definitions': 'accessReviewScheduleDefinition',
    '/identityGovernance/entitlementManagement/externalOriginResourceConnectors': 'externalOriginResourceConnector',
    '/identityGovernance/lifecycleWorkflows/lifecyclePolicies': 'lifecyclePolicy',
    '/identityGovernance/privilegedAccess/customExtensions': 'roleManagementCustomExtension',
    '/identityGovernance/privilegedAccess/group/resources': 'privilegedAccessGroupResource',
    '/policies/crossTenantAccessPolicy/default/m365Capabilities': 'crossTenantM365Capability',
    '/roleManagement/entitlementManagement/roleAssignments': 'entitlementManagementRoleAssignment',
    '/schemaExtensions': 'schemaExtension',
    '/security/zones': 'securityZone',
    '/templates/deviceTemplates': 'deviceTemplate',
  };
  for (const [path, type] of Object.entries(backedUp)) {
    assert.equal(catalogued.get(path.toLowerCase())?.[0]?.type, type, path);
    assert.ok(!skipped.has(path.toLowerCase()), `${path} is backed up, not skipped`);
  }
  const skips = {
    '/compliance': 'not-configuration',
    '/deviceManagement/embeddedSIMActivationCodePools': 'holds-secrets',
    '/deviceManagement/groupPolicyObjectFiles': 'holds-secrets',
    '/deviceManagement/resourceAccessProfiles': 'retired',
    '/devices': 'not-configuration',
    '/identityGovernance/accessReviews/historyDefinitions': 'not-configuration',
    '/network': 'not-configuration',
    '/tenantRelationships/delegatedAdminRelationships': 'other-tenant',
    '/tenantRelationships/multiTenantOrganization/joinRequest': 'other-tenant',
    '/tenantRelationships/multiTenantOrganization/tenants': 'other-tenant',
  };
  for (const [path, reason] of Object.entries(skips)) {
    assert.equal(SKIPPED_PATHS[path], reason, path);
    assert.ok(!catalogued.has(path.toLowerCase()), `${path} is skipped, not catalogued`);
  }
  for (const path of ['/certificateAuthorities/certificateBasedApplicationConfigurations', '/directory/templates/deviceTemplates',
    '/identityGovernance/accessReviews/unified/definitions']) assert.ok(ALIAS_PATHS[path], path);
});

test('per-parent reads fill {parent} in a filter as an OData string, and in a path encoded', () => {
  const assignments = catalogEntryFor('entitlementManagementRoleAssignment');
  assert.equal(perParentReadPath(assignments, 'ae79f266-94d4-4dab-b730-feca7e132178'),
    "/roleManagement/entitlementManagement/roleAssignments?$filter=roleDefinitionId eq 'ae79f266-94d4-4dab-b730-feca7e132178'");
  assert.equal(perParentReadPath(assignments, "o'brien"), "/roleManagement/entitlementManagement/roleAssignments?$filter=roleDefinitionId eq 'o''brien'");
  const extensions = catalogEntryFor('schemaExtension');
  assert.equal(perParentReadPath(extensions, 'app-1'), "/schemaExtensions?$filter=owner eq 'app-1'");
  assert.equal(catalogReadPath(extensions.parent), '/applications?$select=id,appId&$top=999');
  assert.equal(catalogReadPath(assignments.parent), '/roleManagement/entitlementManagement/roleDefinitions?$select=id');
  // Path-shaped parents are unchanged.
  const sync = catalogEntryFor('crossTenantIdentitySyncPolicyPartner');
  assert.equal(perParentReadPath(sync, 't/1'), '/policies/crossTenantAccessPolicy/partners/t%2F1/identitySynchronization');
});

test('each list type reads a KEEL-RT- fixture with GET only, across pages', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [type, endpoint] of EXPECTED) {
      if (endpoint === 'per-parent') continue;
      const entry = catalogEntryFor(type);
      const first = { id: `${type}-1`, displayName: `KEEL-RT-${type}-1` };
      const second = { id: `${type}-2`, displayName: `KEEL-RT-${type}-2` };
      const nextLink = `https://graph.microsoft.com${endpoint}${endpoint.includes('?') ? '&' : '?'}$skiptoken=page2`;
      const urls = [];
      globalThis.fetch = async (url, opts) => {
        assert.equal(opts.method, 'GET', `${type}: read-only`);
        urls.push(url);
        const body = urls.length === 1 ? { value: [first], '@odata.nextLink': nextLink } : { value: [second] };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
      };
      const reader = new GraphReader(async () => 'fixture-token');
      const result = await reader.collect(entry.version, catalogReadPath(entry), { pageCap: Infinity });
      assert.equal(result.error, null, type);
      assert.deepEqual(urls, [`https://graph.microsoft.com${endpoint}`, nextLink], `${type}: documented route, nextLink followed verbatim`);
      assert.deepEqual(result.items, [first, second], `${type}: every page kept`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
