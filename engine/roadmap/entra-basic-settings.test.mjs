/**
 * Issue #156 boundary tests: backup and restore of the remaining basic Entra
 * tenant settings (company branding and its languages, group expiration,
 * device registration, authentication flows).
 *
 * Collection runs through the production adapter and GraphReader with a
 * stubbed fetch; restores run through the production applyWave() path against
 * the in-memory fake Graph. No tenant is read or written. Mutation checks:
 *
 * - A restore that shortens group expiry or covers more groups is never sent.
 * - A branding image path or the CDN list is never sent.
 * - The device registration policy has no write capability for any verb.
 * - A tenant with no branding (Graph 404) is an empty backup, not a failure.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { GraphReader } from '../../tools/tenant-probe/graph.mjs';
import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { naturalKeyFor } from '../cir/naturalKey.mjs';
import { fieldClass } from '../cir/serverOwned.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { collectWithOutcomes } from '../collect/entraAdapter.mjs';
import { get } from '../collect/registry.mjs';
import { OPERATIONS, capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { TYPE_DECISIONS, buildExpansionInventory, expansionFor, qualificationFor } from '../coverage/qualification.mjs';
import { buildLiveIndex } from '../reconcile/liveState.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { BRANDING_WRITABLE_FIELDS, groupLifecycleGuard } from '../restore/tenantPolicyOperations.mjs';

const PROOF = 'engine/roadmap/entra-basic-settings.test.mjs';
const TENANT = '11111111-1111-4111-8111-111111111111';
const TYPES = ['organizationalBranding', 'organizationalBrandingLocalization', 'groupLifecyclePolicy', 'deviceRegistrationPolicy', 'authenticationFlowsPolicy'];
const WRITABLE = ['organizationalBranding', 'organizationalBrandingLocalization', 'groupLifecyclePolicy', 'authenticationFlowsPolicy'];
const governor = { async acquire() {}, observeRetryAfter() {} };

/** fakeGraph plus the method, path and body of every write. */
function recordingGraph() {
  const graph = fakeGraph();
  const bodies = [];
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => {
    bodies.push({ method: request.method, path, body: request.body });
    return write(version, path, request);
  };
  graph.bodies = bodies;
  return graph;
}

function plannedUpdate(graph, resourceType, path, desired, live) {
  graph.objects.set(path, live);
  return {
    naturalKey: `${resourceType}:${naturalKeyFor(resourceType, desired)}`, resourceType, verb: 'update', payload: desired,
    references: [], blastRadius: CATALOG.find((entry) => entry.type === resourceType).blastRadius,
    targetId: live.id ?? null, live: { state: 'present', targetId: live.id ?? null, payload: live },
  };
}

const run = (graph, wave, options = {}) => applyWave(graph, governor, wave, { targetTenant: TENANT, mode: 'enforce', ...options });

const branding = Object.freeze({
  id: '0', backgroundColor: '#1B2A4A', signInPageText: 'Welcome to Contoso', usernameHintText: 'name@contoso.example',
  customPrivacyAndCookiesUrl: 'https://contoso.example/privacy', loginPageTextVisibilitySettings: { hideForgotMyPassword: false },
  cdnList: ['cdn-one.example'], bannerLogoRelativeUrl: 'c1/banner-1.png', squareLogoRelativeUrl: null,
});

// ------------------------------------------------------------------ catalogue and collection

test('each setting is a catalogue type with a descriptor and an explicit decision', () => {
  for (const type of TYPES) {
    assert.ok(CATALOG.some((entry) => entry.type === type), `${type} is in the catalogue`);
    const descriptor = DESCRIPTORS.find((entry) => entry.type === type);
    assert.ok(descriptor, `${type} has a descriptor`);
    assert.equal(descriptor.fidelity, 'read-only');
    assert.equal(descriptor.remappable, false);
    assert.equal(get(type).descriptor.type, type, `${type} is registered for collection`);
    assert.ok(TYPE_DECISIONS[type], `${type} has an explicit decision`);
  }
  assert.deepEqual(TYPES.map((type) => DESCRIPTORS.find((entry) => entry.type === type).naturalKeyStrategy),
    ['constant', 'id', 'id', 'constant', 'constant']);
  buildExpansionInventory();
});

test('collection: branding is read with Accept-Language 0 under the tenant id; the others at their measured routes', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const respond = (body, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body });
  const cases = [
    ['organizationalBranding', `/v1.0/organization/${TENANT}/branding`, '0', branding],
    ['organizationalBrandingLocalization', `/v1.0/organization/${TENANT}/branding/localizations`, 'en-US', { value: [{ id: 'fr-FR', signInPageText: 'Bienvenue' }] }],
    ['groupLifecyclePolicy', '/v1.0/groupLifecyclePolicies', 'en-US', { value: [{ id: 'policy-1', groupLifetimeInDays: 180, managedGroupTypes: 'All' }] }],
    ['deviceRegistrationPolicy', '/v1.0/policies/deviceRegistrationPolicy', 'en-US', { id: 'deviceRegistrationPolicy', userDeviceQuota: 50, multiFactorAuthConfiguration: 'required' }],
    ['authenticationFlowsPolicy', '/v1.0/policies/authenticationFlowsPolicy', 'en-US', { id: 'authenticationFlowsPolicy', selfServiceSignUp: { isEnabled: false } }],
  ];
  for (const [type, endpoint, language, body] of cases) {
    const seen = [];
    globalThis.fetch = async (url, options) => {
      seen.push({ url, language: options.headers['Accept-Language'] });
      return respond(body);
    };
    const items = await get(type).adapter.collect(new GraphReader(async () => 'fixture-token'), { tenantId: TENANT });
    assert.deepEqual(seen, [{ url: `https://graph.microsoft.com${endpoint}`, language }], type);
    assert.deepEqual(items, Array.isArray(body.value) ? body.value : [body], type);
    const resources = canonicalizeAll([[type, items]]);
    // The reconciliation plan keys a live object `${type}:${naturalKeyFor(...)}`.
    assert.equal(resources[0].naturalKey, `${type}:${naturalKeyFor(type, items[0])}`, type);
  }
  await assert.rejects(() => get('organizationalBranding').adapter.collect(new GraphReader(async () => 'fixture-token')), /tenantId required/);
});

test('mutation: no branding (404) or no expiry policy is a complete empty backup; other errors still fail', async () => {
  const reader = (failures) => ({
    async collect(version, path) {
      for (const [fragment, status] of failures) {
        if (path.includes(fragment)) return { items: [], pages: 0, status: null, error: { status, error: `fixture ${status}` } };
      }
      return { items: [], pages: 1, status: 200, error: null };
    },
  });
  let { coverageDigest } = await collectWithOutcomes(reader([['/branding', 404]]), { tenantId: TENANT });
  for (const type of TYPES) assert.equal(coverageDigest[type].outcome, 'complete-empty', type);
  assert.equal(coverageDigest.organizationalBranding.itemCount, 0);

  ({ coverageDigest } = await collectWithOutcomes(reader([['/branding', 403]]), { tenantId: TENANT }));
  assert.equal(coverageDigest.organizationalBranding.outcome, 'failed', 'a denied read is never an empty backup');
  assert.equal(coverageDigest.organizationalBrandingLocalization.outcome, 'failed');

  ({ coverageDigest } = await collectWithOutcomes(reader([['/policies/deviceRegistrationPolicy', 404], ['/policies/authenticationFlowsPolicy', 404]]), { tenantId: TENANT }));
  assert.equal(coverageDigest.deviceRegistrationPolicy.outcome, 'failed', 'only branding treats 404 as absent');
  assert.equal(coverageDigest.authenticationFlowsPolicy.outcome, 'failed');
});

test('the live plan resolves the organization id, reads branding in language 0 and treats 404 as absent', async () => {
  const calls = [];
  const reader = {
    async collect(version, path, options) {
      calls.push({ path, acceptLanguage: options?.acceptLanguage ?? null });
      if (path === '/organization') return { items: [{ id: TENANT }], error: null };
      if (path.endsWith('/branding')) return { items: [branding], error: null };
      if (path.endsWith('/localizations')) return { items: [], error: { status: 404, error: 'not found' } };
      return { items: [], error: null };
    },
  };
  const index = await buildLiveIndex(reader, {
    resourceTypes: ['organizationalBranding', 'organizationalBrandingLocalization', 'groupLifecyclePolicy'],
    naturalKeyFor: (type, object) => `${type}:${naturalKeyFor(type, object)}`,
  });
  assert.deepEqual(calls, [
    { path: '/organization', acceptLanguage: null },
    { path: `/organization/${TENANT}/branding`, acceptLanguage: '0' },
    { path: `/organization/${TENANT}/branding/localizations`, acceptLanguage: null },
    { path: '/groupLifecyclePolicies', acceptLanguage: null },
  ], 'the organization is read once');
  assert.equal(index.get('organizationalBranding:organizationalBranding').state, 'present');
  assert.equal(index.size, 1);
});

test('branding: the CDN list never reads as drift; a changed image path does, and is never writable', () => {
  assert.equal(canonicalHash(branding, 'organizationalBranding'), canonicalHash({ ...branding, cdnList: ['cdn-two.example'] }, 'organizationalBranding'));
  assert.notEqual(canonicalHash(branding, 'organizationalBranding'), canonicalHash({ ...branding, bannerLogoRelativeUrl: 'c1/banner-2.png' }, 'organizationalBranding'));
  for (const type of ['organizationalBranding', 'organizationalBrandingLocalization']) {
    assert.equal(fieldClass('cdnList', type), 'serverOwned');
    assert.equal(fieldClass('bannerLogoRelativeUrl', type), 'immutable');
    assert.equal(fieldClass('signInPageText', type), 'writable');
  }
  for (const field of BRANDING_WRITABLE_FIELDS) assert.doesNotMatch(field, /RelativeUrl$|^cdnList$|^(bannerLogo|backgroundImage|squareLogo|squareLogoDark|headerLogo|favicon|customCSS)$/);
});

// ------------------------------------------------------------------ decisions and capabilities

test('update is registered and fixture-tested for four settings; device registration is manual with no write', () => {
  for (const type of WRITABLE) {
    assert.equal(qualificationFor(type).decision, 'automated', type);
    const capability = capabilityFor(type, 'update');
    assert.equal(capability.claim, 'fixture-tested', type);
    assert.equal(capability.proofRef, PROOF, type);
    assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor(type, operation).claim)), ['update'], type);
  }
  assert.equal(qualificationFor('deviceRegistrationPolicy').decision, 'manual');
  assert.match(TYPE_DECISIONS.deviceRegistrationPolicy.reason, /MFA/);
  for (const operation of OPERATIONS) assert.equal(capabilityFor('deviceRegistrationPolicy', operation).claim, 'unsupported', operation);
  assert.equal(expansionFor('deviceRegistrationPolicy').status, 'manual');
  assert.ok(expansionFor('organizationalBranding').unrecoverable.some((item) => /logos/.test(item.name)));
  assert.match(TYPE_DECISIONS.organizationalBranding.reason, /never written/);
});

test('mutation: the device registration policy is refused by applyWave for every verb', async () => {
  const live = { id: 'deviceRegistrationPolicy', multiFactorAuthConfiguration: 'notRequired' };
  for (const verb of ['update', 'create', 'delete']) {
    const graph = recordingGraph();
    const resource = { ...plannedUpdate(graph, 'deviceRegistrationPolicy', '/policies/deviceRegistrationPolicy', { ...live, multiFactorAuthConfiguration: 'required' }, live), verb };
    const result = await run(graph, [resource]);
    assert.equal(graph.bodies.length, 0, verb);
    assert.equal(result.applied.length, 0, verb);
    assert.match(result.failed[0].error, /not a registered write capability/, verb);
  }
});

// ------------------------------------------------------------------ writes

test('branding: only changed text, colour and layout fields are PATCHed under the target tenant', async () => {
  const graph = recordingGraph();
  const path = `/organization/${TENANT}/branding`;
  const live = { ...branding, signInPageText: 'Defaced', backgroundColor: '#000000', cdnList: ['cdn-two.example'], bannerLogoRelativeUrl: 'c1/banner-2.png' };
  const result = await run(graph, [plannedUpdate(graph, 'organizationalBranding', path, branding, live)]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path, body: { backgroundColor: '#1B2A4A', signInPageText: 'Welcome to Contoso' } }]);
  assert.equal(graph.objects.get(path).bannerLogoRelativeUrl, 'c1/banner-2.png', 'images are never written');
});

test('branding: a language is PATCHed at its own route; a missing branding or tenant id is refused', async () => {
  let graph = recordingGraph();
  const desired = { id: 'fr-FR', signInPageText: 'Bienvenue', usernameHintText: 'nom@contoso.example' };
  const path = `/organization/${TENANT}/branding/localizations/fr-FR`;
  let result = await run(graph, [plannedUpdate(graph, 'organizationalBrandingLocalization', path, desired, { ...desired, signInPageText: 'Defaced' })]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path, body: { signInPageText: 'Bienvenue' } }]);

  graph = recordingGraph();
  result = await run(graph, [plannedUpdate(graph, 'organizationalBranding', `/organization/${TENANT}/branding`, branding, { ...branding, signInPageText: 'Defaced' })], { targetTenant: undefined });
  assert.match(result.failed[0].error, /needs the target tenant id/);
  assert.equal(graph.bodies.length, 0);

  // A tenant with no branding: the snapshot's branding would be a create, which is not registered.
  graph = recordingGraph();
  result = await run(graph, [{ naturalKey: 'organizationalBranding:organizationalBranding', resourceType: 'organizationalBranding', verb: 'create', payload: branding, references: [], blastRadius: 'cosmetic' }]);
  assert.match(result.failed[0].error, /not a registered write capability/);
  assert.equal(graph.bodies.length, 0);
});

test('group expiry: a longer lifetime or narrower scope is restored', async () => {
  const graph = recordingGraph();
  const desired = { id: 'policy-1', groupLifetimeInDays: 365, managedGroupTypes: 'Selected', alternateNotificationEmails: 'admins@contoso.example' };
  const live = { ...desired, groupLifetimeInDays: 180, managedGroupTypes: 'All', alternateNotificationEmails: '' };
  const result = await run(graph, [plannedUpdate(graph, 'groupLifecyclePolicy', '/groupLifecyclePolicies/policy-1', desired, live)]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{
    method: 'PATCH', path: '/groupLifecyclePolicies/policy-1',
    body: { alternateNotificationEmails: 'admins@contoso.example', groupLifetimeInDays: 365, managedGroupTypes: 'Selected' },
  }]);
});

test('mutation: group expiry that could delete groups is left to a person and nothing is sent', async () => {
  const base = { id: 'policy-1', groupLifetimeInDays: 180, managedGroupTypes: 'Selected', alternateNotificationEmails: '' };
  for (const [change, pattern] of [
    [{ groupLifetimeInDays: 30 }, /shorter than the live 180 days/],
    [{ managedGroupTypes: 'All' }, /cover more groups \(All instead of Selected\)/],
    [{ managedGroupTypes: 'Everything' }, /not a known value/],
  ]) {
    const graph = recordingGraph();
    const result = await run(graph, [plannedUpdate(graph, 'groupLifecyclePolicy', '/groupLifecyclePolicies/policy-1', { ...base, ...change }, base)]);
    assert.equal(graph.bodies.length, 0, JSON.stringify(change));
    assert.equal(result.applied.length, 0);
    assert.match(result.skipped[0].reason, /^manual: /);
    assert.match(result.skipped[0].reason, pattern);
  }
  assert.equal(groupLifecycleGuard({ groupLifetimeInDays: 180, managedGroupTypes: 'None' }, { groupLifetimeInDays: 180, managedGroupTypes: 'All' }), null);
  assert.equal(groupLifecycleGuard({ alternateNotificationEmails: 'x@contoso.example' }, base), null, 'a field the snapshot lacks is not compared');
});

test('authentication flows: self-service sign-up is PATCHed and read back', async () => {
  const graph = recordingGraph();
  const desired = { id: 'authenticationFlowsPolicy', displayName: 'Authentication flows policy', selfServiceSignUp: { isEnabled: false } };
  const result = await run(graph, [plannedUpdate(graph, 'authenticationFlowsPolicy', '/policies/authenticationFlowsPolicy', desired, { ...desired, selfServiceSignUp: { isEnabled: true } })]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path: '/policies/authenticationFlowsPolicy', body: { selfServiceSignUp: { isEnabled: false } } }]);
  assert.deepEqual(graph.objects.get('/policies/authenticationFlowsPolicy').selfServiceSignUp, { isEnabled: false });
});

test('dry run sends nothing', async () => {
  const graph = recordingGraph();
  const desired = { id: 'authenticationFlowsPolicy', selfServiceSignUp: { isEnabled: false } };
  const result = await run(graph, [plannedUpdate(graph, 'authenticationFlowsPolicy', '/policies/authenticationFlowsPolicy', desired, { ...desired, selfServiceSignUp: { isEnabled: true } })], { mode: 'dry-run' });
  assert.equal(result.applied.length, 1);
  assert.equal(graph.bodies.length, 0);
});
