import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import entraTenantSettings from './catalog.d/entra-tenant-settings.mjs';
import { CATALOG, catalogEntryFor, catalogReadPath } from './catalog.mjs';
import { GraphReader } from './graph.mjs';

// Independent expectations: the documented Graph route for each type, written
// out here rather than derived from the catalogue under test.
const MTO = '/v1.0/policies/crossTenantAccessPolicy/templates';
const EXPECTED = [
  ['externalIdentitiesPolicy', '/beta/policies/externalIdentitiesPolicy', 'tier2', 'singleton'],
  ['b2bManagementPolicy', '/beta/policies/b2bManagementPolicies', 'tier2', 'list'],
  ['servicePrincipalCreationPolicy', '/beta/policies/servicePrincipalCreationPolicies', 'tier2', 'list'],
  ['permissionGrantPreApprovalPolicy', '/beta/policies/permissionGrantPreApprovalPolicies', 'tier2', 'list'],
  ['accessReviewPolicy', '/beta/policies/accessReviewPolicy', 'tier3', 'singleton'],
  ['directoryRoleAccessReviewPolicy', '/beta/policies/directoryRoleAccessReviewPolicy', 'tier3', 'singleton'],
  ['multiTenantOrganizationIdentitySyncPolicyTemplate', `${MTO}/multiTenantOrganizationIdentitySynchronization`, 'tier3', 'singleton'],
  ['multiTenantOrganizationPartnerConfigurationTemplate', `${MTO}/multiTenantOrganizationPartnerConfiguration`, 'tier3', 'singleton'],
  ['identityUserFlowAttribute', '/v1.0/identity/userFlowAttributes', 'tier3', 'list'],
  ['authenticationEventListener', '/v1.0/identity/authenticationEventListeners', 'tier2', 'list'],
  // Issue #640: the base federationConfigurations collection answers only id and
  // displayName; the derived-type collection answers every sign-in field.
  ['externalDomainFederation', '/v1.0/directory/federationConfigurations/graph.samlOrWsFedExternalDomainFederation?$expand=domains', 'tier2', 'list'],
];

test('the Entra ID tenant settings family holds exactly the planned types, all in CATALOG', () => {
  assert.deepEqual(entraTenantSettings.map((entry) => entry.type), EXPECTED.map(([type]) => type));
  for (const [type, , criticality, shape] of EXPECTED) {
    const entry = catalogEntryFor(type);
    assert.ok(entry, `${type} is in CATALOG`);
    assert.equal(entry.criticality, criticality, type);
    assert.ok(['tenant-lockout', 'access-affecting', 'cosmetic'].includes(entry.blastRadius), type);
    assert.equal(entry.singleton === true, shape === 'singleton', `${type} is a ${shape}`);
    // A singleton never set up may answer 404; a list read never hides one.
    assert.equal(entry.absentWhenNotFound === true, shape === 'singleton', type);
    assert.ok(!entry.needsOrgId && !entry.parent, `${type} is read at a fixed path`);
    // A page cap would leave the backup incomplete; these types are read in full.
    assert.equal(entry.pageCap, undefined, type);
    // None holds a secret, so each object is read whole.
    assert.equal(entry.select, undefined, type);
  }
});

test('no Entra ID tenant settings type duplicates an existing catalogue path or type', () => {
  const ours = new Set(entraTenantSettings.map((entry) => entry.type));
  const others = CATALOG.filter((entry) => !ours.has(entry.type));
  assert.equal(CATALOG.length, others.length + ours.size, 'each type appears once');
  const otherPaths = new Set(others.map((entry) => `${entry.version}${entry.path}`.toLowerCase()));
  for (const entry of entraTenantSettings) assert.ok(!otherPaths.has(`${entry.version}${entry.path}`.toLowerCase()), entry.type);
  // The access review settings are one object under two paths; only one is read.
  assert.equal(CATALOG.filter((entry) => entry.path === '/identityGovernance/accessReviews/policy').length, 0);
});

test('each Entra ID tenant settings type reads a KEEL-RT- fixture with GET only, across pages or as one object', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [type, endpoint, , shape] of EXPECTED) {
      const entry = catalogEntryFor(type);
      const first = { id: `${type}-1`, displayName: `KEEL-RT-${type}-1` };
      const second = { id: `${type}-2`, displayName: `KEEL-RT-${type}-2` };
      const nextLink = `https://graph.microsoft.com${endpoint}${endpoint.includes('?') ? '&' : '?'}$skiptoken=page2`;
      const urls = [];
      globalThis.fetch = async (url, opts) => {
        assert.equal(opts.method, 'GET', `${type}: read-only`);
        urls.push(url);
        const body = shape === 'singleton' ? first : urls.length === 1 ? { value: [first], '@odata.nextLink': nextLink } : { value: [second] };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
      };
      const reader = new GraphReader(async () => 'fixture-token');
      const result = await reader.collect(entry.version, catalogReadPath(entry), { pageCap: entry.pageCap ?? Infinity });
      assert.equal(result.error, null, type);
      assert.equal(result.capped, false, type);
      if (shape === 'singleton') {
        assert.deepEqual(urls, [`https://graph.microsoft.com${endpoint}`], `${type}: documented route`);
        assert.deepEqual(result.items, [first], `${type}: the one object kept`);
      } else {
        assert.deepEqual(urls, [`https://graph.microsoft.com${endpoint}`, nextLink], `${type}: documented route, nextLink followed verbatim`);
        assert.deepEqual(result.items, [first, second], `${type}: every page kept`);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a guest federation is backed up with its sign-in fields and domains, not just its name (issue #640)', async () => {
  const entry = catalogEntryFor('externalDomainFederation');
  const full = {
    '@odata.type': '#microsoft.graph.samlOrWsFedExternalDomainFederation',
    id: 'fed-1', displayName: 'KEEL-RT-148-fed',
    issuerUri: 'https://keel-rt-fed.example/issuer',
    metadataExchangeUri: 'https://keel-rt-fed.example/mex',
    passiveSignInUri: 'https://keel-rt-fed.example/sso',
    preferredAuthenticationProtocol: 'saml',
    signingCertificate: 'MIIFixture',
    domains: [{ id: 'keel-rt-fed.example', displayName: 'keel-rt-fed.example' }],
  };
  const originalFetch = globalThis.fetch;
  const urls = [];
  try {
    globalThis.fetch = async (url) => {
      urls.push(url);
      // The base collection only answers the identityProviderBase fields.
      const body = new URL(url).pathname.endsWith('/directory/federationConfigurations')
        ? { value: [{ id: full.id, displayName: full.displayName }] }
        : { value: [full] };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
    };
    const reader = new GraphReader(async () => 'fixture-token');
    const result = await reader.collect(entry.version, catalogReadPath(entry), { pageCap: Infinity });
    assert.equal(result.error, null);
    assert.equal(urls.length, 1);
    const url = new URL(urls[0]);
    assert.equal(url.pathname, '/v1.0/directory/federationConfigurations/graph.samlOrWsFedExternalDomainFederation');
    assert.equal(url.searchParams.get('$expand'), 'domains');
    const [item] = result.items;
    for (const field of ['issuerUri', 'metadataExchangeUri', 'passiveSignInUri', 'signingCertificate', 'preferredAuthenticationProtocol', 'domains']) {
      assert.deepEqual(item[field], full[field], `${field} is backed up`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
