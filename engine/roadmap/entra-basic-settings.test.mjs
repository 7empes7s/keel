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
import { verifiedOutcome } from '../../tools/qualification/entraLive.mjs';
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
import {
  BRANDING_WRITABLE_FIELDS, GROUP_LIFETIME_PORTAL_PATH, brandingSendable, groupLifecycleGuard, groupLifetimeCompletionItem,
} from '../restore/tenantPolicyOperations.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';

const PROOF = 'engine/roadmap/entra-basic-settings.test.mjs';
const TENANT = '11111111-1111-4111-8111-111111111111';
const TYPES = ['organizationalBranding', 'organizationalBrandingLocalization', 'groupLifecyclePolicy', 'deviceRegistrationPolicy', 'authenticationFlowsPolicy'];
const WRITABLE = ['organizationalBranding', 'organizationalBrandingLocalization', 'groupLifecyclePolicy', 'authenticationFlowsPolicy'];
const governor = { async acquire() {}, observeRetryAfter() {} };

/** fakeGraph plus the method, path and body of every write. */
function recordingGraph() {
  const graph = fakeGraph();
  const bodies = [];
  const headers = [];
  const write = graph.write.bind(graph);
  const read = graph.read.bind(graph);
  graph.write = async (version, path, request) => {
    bodies.push({ method: request.method, path, body: request.body });
    headers.push({ kind: 'write', path, headers: request.headers ?? null });
    return write(version, path, request);
  };
  graph.read = async (version, path, options) => {
    headers.push({ kind: 'read', path, headers: options?.headers ?? null });
    return read(version, path);
  };
  graph.bodies = bodies;
  graph.headers = headers;
  return graph;
}

/** Every key at any depth of a value. */
function deepKeys(value) {
  if (Array.isArray(value)) return value.flatMap(deepKeys);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [key, ...deepKeys(item)]);
  return [];
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

test('collection: branding goes under the organization id read in the run; a 404 under anything else is a failure', async () => {
  const paths = [];
  const reader = (organizations) => ({
    async collect(version, path) {
      paths.push(path);
      if (path === '/organization') return { items: organizations, pages: 1, status: 200, error: null };
      if (path.includes('/branding')) return { items: [], pages: 0, status: null, error: { status: 404, error: 'not found' } };
      return { items: [], pages: 1, status: 200, error: null };
    },
  });
  // The configured tenant is a domain name; the run reads the directory id first.
  let { coverageDigest } = await collectWithOutcomes(reader([{ id: TENANT }]), { tenantId: 'contoso.onmicrosoft.com' });
  assert.ok(paths.includes(`/organization/${TENANT}/branding`));
  assert.ok(!paths.some((path) => path.includes('contoso.onmicrosoft.com')));
  assert.equal(coverageDigest.organizationalBranding.outcome, 'complete-empty');

  // A tier-scoped run never reads the organization: a 404 under a domain name proves nothing.
  ({ coverageDigest } = await collectWithOutcomes(reader([]), { tenantId: 'contoso.onmicrosoft.com', tier: 'tier3' }));
  assert.equal(coverageDigest.organizationalBranding.outcome, 'failed');
  assert.equal(coverageDigest.organizationalBrandingLocalization.outcome, 'failed');
  ({ coverageDigest } = await collectWithOutcomes(reader([]), { tenantId: TENANT, tier: 'tier3' }));
  assert.equal(coverageDigest.organizationalBranding.outcome, 'complete-empty', 'a directory id from configuration is enough');
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
  for (const field of BRANDING_WRITABLE_FIELDS) assert.doesNotMatch(field, /RelativeUrl$|^cdnList$|^contentCustomization$|^(bannerLogo|backgroundImage|squareLogo|squareLogoDark|headerLogo|favicon|customCSS)$/);
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
  // Gap register M6: the files are uploaded back (branding-files.test.mjs); only the header logo is left by hand.
  assert.ok(expansionFor('organizationalBranding').unrecoverable.some((item) => /header logo/.test(item.name)));
  assert.match(TYPE_DECISIONS.organizationalBranding.reason, /uploaded back \(fixture-tested, not yet live\)/);
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
  // The default branding is addressed as language 0, on the PATCH and on its read-back.
  assert.deepEqual(graph.headers.map((entry) => `${entry.kind} ${entry.headers?.['Accept-Language']}`), ['write 0', 'read 0']);
});

test('mutation: a nested uploaded-file path (contentCustomization) is never sent, at any depth', async () => {
  const graph = recordingGraph();
  const path = `/organization/${TENANT}/branding`;
  const desired = {
    ...branding,
    contentCustomization: { attributeCollection: [{ key: 'title', value: 'Sign up' }], attributeCollectionRelativeUrl: 'c1/attributes-1.json' },
  };
  const live = {
    ...desired, signInPageText: 'Defaced',
    contentCustomization: { attributeCollection: [{ key: 'title', value: 'Changed' }], attributeCollectionRelativeUrl: 'c1/attributes-2.json' },
  };
  const result = await run(graph, [plannedUpdate(graph, 'organizationalBranding', path, desired, live)]);
  assert.deepEqual(result.failed, []);
  assert.equal(graph.bodies.length, 1);
  const keys = deepKeys(graph.bodies[0].body);
  assert.deepEqual(keys, ['signInPageText']);
  assert.ok(keys.every((key) => !/Url$/.test(key) && key !== 'contentCustomization'));
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

// ------------------------------------------------------------------ gap B9: valid branding PATCH bodies

/** Every value at any depth of a value. */
function deepValues(value) {
  if (Array.isArray(value)) return value.flatMap(deepValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepValues);
  return [value];
}

test('B9: brandingSendable drops empty values, unlisted nested members and objects where text is expected', () => {
  assert.equal(brandingSendable('signInPageText', null), undefined);
  assert.equal(brandingSendable('signInPageText', ''), undefined);
  assert.equal(brandingSendable('signInPageText', undefined), undefined);
  assert.equal(brandingSendable('signInPageText', 'Welcome'), 'Welcome');
  assert.equal(brandingSendable('signInPageText', { text: 'Welcome' }), undefined);
  assert.equal(brandingSendable('backgroundColor', ['#000000']), undefined);
  assert.deepEqual(brandingSendable('loginPageLayoutConfiguration', {
    '@odata.type': '#microsoft.graph.loginPageLayoutConfiguration', layoutTemplateType: 'twoColumn', isHeaderShown: false, isFooterShown: null,
    headerLogoRelativeUrl: 'c1/header.png',
  }), { isHeaderShown: false, layoutTemplateType: 'twoColumn' });
  assert.equal(brandingSendable('loginPageTextVisibilitySettings', { hideTermsOfUse: null, hideResetItNow: '' }), undefined);
  assert.equal(brandingSendable('loginPageTextVisibilitySettings', 'yes'), undefined);
});

test('B9: a branding PATCH never carries null, "" or a nested read-only field; "" and null are the same value', async () => {
  const graph = recordingGraph();
  const path = `/organization/${TENANT}/branding`;
  const desired = {
    ...branding,
    usernameHintText: null, customTermsOfUseText: '', backgroundColor: null, headerBackgroundColor: '',
    customCannotAccessYourAccountText: { text: 'not text' },
    loginPageLayoutConfiguration: {
      '@odata.type': '#microsoft.graph.loginPageLayoutConfiguration', layoutTemplateType: 'twoColumn', isHeaderShown: true, isFooterShown: null,
      backgroundImageRelativeUrl: 'c1/background-1.png',
    },
    loginPageTextVisibilitySettings: { hideForgotMyPassword: true, hideTermsOfUse: null },
  };
  const live = {
    ...branding,
    signInPageText: 'Defaced', usernameHintText: '', customTermsOfUseText: null, backgroundColor: '#000000', headerBackgroundColor: '#FFFFFF',
    loginPageLayoutConfiguration: { layoutTemplateType: 'default', isHeaderShown: true, isFooterShown: true },
    loginPageTextVisibilitySettings: { hideForgotMyPassword: false, hideTermsOfUse: true },
  };
  const result = await run(graph, [plannedUpdate(graph, 'organizationalBranding', path, desired, live)]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(graph.bodies, [{
    method: 'PATCH', path, body: {
      loginPageLayoutConfiguration: { isHeaderShown: true, layoutTemplateType: 'twoColumn' },
      loginPageTextVisibilitySettings: { hideForgotMyPassword: true },
      signInPageText: 'Welcome to Contoso',
    },
  }]);
  const values = deepValues(graph.bodies[0].body);
  assert.ok(values.every((value) => value !== null && value !== ''), 'no null or empty value is sent');
  assert.ok(deepKeys(graph.bodies[0].body).every((key) => !key.includes('@odata.') && !/Url$/.test(key)), 'no annotation or file path is sent');
  // An empty snapshot value is never written over a live one.
  assert.equal(graph.objects.get(path).backgroundColor, '#000000');
});

test('B9: a branding whose only differences are empty values is not written at all', async () => {
  const graph = recordingGraph();
  const path = `/organization/${TENANT}/branding`;
  const desired = { ...branding, usernameHintText: '', customTermsOfUseText: null, loginPageTextVisibilitySettings: { hideForgotMyPassword: false, hideTermsOfUse: null } };
  const live = { ...branding, usernameHintText: 'name@contoso.example', customTermsOfUseText: '', loginPageTextVisibilitySettings: { hideForgotMyPassword: false, hideTermsOfUse: true, hideResetItNow: true } };
  const result = await run(graph, [plannedUpdate(graph, 'organizationalBranding', path, desired, live)]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(graph.bodies, []);
});

test('B9: a branding language PATCH omits null-valued fields too', async () => {
  const graph = recordingGraph();
  const path = `/organization/${TENANT}/branding/localizations/fr-FR`;
  const desired = { id: 'fr-FR', signInPageText: 'Bienvenue', usernameHintText: null, backgroundColor: null, customPrivacyAndCookiesText: '' };
  const live = { id: 'fr-FR', signInPageText: 'Defaced', usernameHintText: 'nom@contoso.example', backgroundColor: '#000000', customPrivacyAndCookiesText: null };
  const result = await run(graph, [plannedUpdate(graph, 'organizationalBrandingLocalization', path, desired, live)]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path, body: { signInPageText: 'Bienvenue' } }]);
});

test('B9: a refused branding write records the Graph error body in the journal', async () => {
  const graph = recordingGraph();
  const path = `/organization/${TENANT}/branding`;
  const graphError = { code: 'Request_BadRequest', message: 'Invalid value specified for property backgroundColor.', innerError: { 'request-id': 'fixture-request-1' } };
  graph.write = async (version, requested, request) => {
    graph.bodies.push({ method: request.method, path: requested, body: request.body });
    return { ok: false, status: 400, body: { error: graphError } };
  };
  const outcomes = [];
  const journal = {
    async query(text, values) {
      if (text.includes('INSERT INTO rollback_entry')) return { rows: [{ id: 'entry-1' }] };
      if (text.includes('SET outcome')) outcomes.push({ outcome: values[1], detail: values[4] });
      return { rows: [] };
    },
  };
  const live = { ...branding, signInPageText: 'Defaced' };
  const result = await run(graph, [plannedUpdate(graph, 'organizationalBranding', path, branding, live)], {
    rollbackClient: journal, runId: 'run-b9', restoreRef: 'restore-b9',
  });
  assert.equal(result.applied.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, 'failed');
  assert.ok(outcomes[0].detail.startsWith('status 400: '), outcomes[0].detail);
  assert.deepEqual(JSON.parse(outcomes[0].detail.slice('status 400: '.length)), graphError);
});

/** A rollback journal that keeps every entry and outcome (rollbackJournal.mjs SQL). */
function recordingJournal() {
  const entries = [];
  return {
    entries,
    async query(text, values) {
      if (text.includes('INSERT INTO rollback_entry')) {
        const id = `entry-${entries.length + 1}`;
        entries.push({
          id, naturalKey: values[1], priorState: values[2], restoreRef: values[3], resourceType: values[4],
          operation: values[5], intendedState: values[8] === null ? null : JSON.parse(values[8]), outcome: values[9],
        });
        return { rows: [{ id }] };
      }
      if (text.includes('SET outcome')) {
        const entry = entries.find((row) => row.id === values[0]);
        Object.assign(entry, { outcome: values[1], postState: values[2] === null ? null : JSON.parse(values[2]), detail: values[4] });
      }
      return { rows: [] };
    },
  };
}

test('Q45 step 29: a default branding PATCH journals its prior state and a verified outcome', async () => {
  const graph = recordingGraph();
  const journal = recordingJournal();
  const path = `/organization/${TENANT}/branding`;
  const live = { ...branding, signInPageText: 'Defaced' };
  const result = await run(graph, [plannedUpdate(graph, 'organizationalBranding', path, branding, live)], {
    rollbackClient: journal, runId: 'run-29', restoreRef: 'restore-29',
  });
  assert.deepEqual(result.failed, []);
  assert.equal(journal.entries.length, 1);
  const [entry] = journal.entries;
  assert.equal(entry.resourceType, 'organizationalBranding');
  assert.equal(entry.operation, 'update');
  assert.equal(entry.restoreRef, 'restore-29');
  assert.equal(entry.priorState.signInPageText, 'Defaced');
  assert.equal(entry.outcome, 'succeeded');
  assert.equal(entry.detail, null);
  assert.equal(entry.postState.signInPageText, 'Welcome to Contoso');
});

test('Q45 step 29: a default branding update with nothing to send is still journaled, and never as a verified write', async () => {
  // Live: the wave reported the default branding applied but left no journal
  // entry, so the capture tool could not tell what happened (exit 4).
  const graph = recordingGraph();
  const journal = recordingJournal();
  const path = `/organization/${TENANT}/branding`;
  const desired = { ...branding, signInPageText: '' };
  const live = { ...branding, signInPageText: 'Defaced' };
  const result = await run(graph, [plannedUpdate(graph, 'organizationalBranding', path, desired, live)], {
    rollbackClient: journal, runId: 'run-29b', restoreRef: 'restore-29b',
  });
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(graph.bodies, [], 'nothing is PATCHed');
  assert.equal(journal.entries.length, 1);
  const [entry] = journal.entries;
  assert.equal(entry.resourceType, 'organizationalBranding');
  assert.equal(entry.operation, 'update');
  assert.equal(entry.priorState.signInPageText, 'Defaced');
  assert.equal(entry.outcome, 'succeeded');
  assert.match(entry.detail, /^not written: /);
  assert.equal(verifiedOutcome(entry.outcome, entry.detail), false, 'the capture tool must not count it as a verified write');
});

test('mutation: a dry run of a branding update with nothing to send journals nothing', async () => {
  const graph = recordingGraph();
  const journal = recordingJournal();
  const path = `/organization/${TENANT}/branding`;
  const result = await run(graph, [plannedUpdate(graph, 'organizationalBranding', path, { ...branding, signInPageText: '' }, { ...branding, signInPageText: 'Defaced' })], {
    mode: 'dry-run', rollbackClient: journal, runId: 'run-29c', restoreRef: 'restore-29c',
  });
  assert.equal(result.applied.length, 1);
  assert.deepEqual(journal.entries, []);
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
  assert.equal(groupLifecycleGuard({ alternateNotificationEmails: 'x@contoso.example' }, base), null, 'adding an address to an empty list is safe');
});

// Gap D3: a shorter lifetime is refused by default, written only with its
// separate high-impact approval, and otherwise left as a guided step.
const expiryLive = Object.freeze({ id: 'policy-1', groupLifetimeInDays: 180, managedGroupTypes: 'Selected', alternateNotificationEmails: '' });

test('D3: a shorter group lifetime is refused by default and leaves a completion item; nothing is sent', async () => {
  const graph = recordingGraph();
  const resource = plannedUpdate(graph, 'groupLifecyclePolicy', '/groupLifecyclePolicies/policy-1', { ...expiryLive, groupLifetimeInDays: 90 }, expiryLive);
  const result = await run(graph, [resource]);
  assert.equal(graph.bodies.length, 0);
  assert.deepEqual(result.applied, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /^manual: a group lifetime of 90 days is shorter than the live 180 days/);
  assert.match(result.skipped[0].reason, /separate high-impact approval/);
  assert.deepEqual(result.skipped[0].completion, groupLifetimeCompletionItem({ from: 180, to: 90 }));

  // Approved effects of a different value, or an approval with nothing in it, do not unlock it.
  for (const approvedContentEffects of [
    [],
    classifyContentEffects([{ ...resource, payload: { ...expiryLive, groupLifetimeInDays: 30 } }]).effects,
    classifyContentEffects([{ ...resource, naturalKey: 'groupLifecyclePolicy:other' }]).effects,
  ]) {
    const again = await run(graph, [resource], { approvedContentEffects });
    assert.equal(graph.bodies.length, 0, JSON.stringify(approvedContentEffects));
    assert.equal(again.skipped.length, 1);
  }
});

test('D3: the completion item names the target value and where to set it in the Entra portal', () => {
  const item = groupLifetimeCompletionItem({ from: 180, to: 90 });
  assert.equal(item.requirement, 'groupLifetimeInDays');
  assert.equal(item.targetValue, 90);
  assert.equal(item.portalPath, 'Microsoft Entra admin center > Groups > All groups > Expiration > Group lifetime (in days)');
  assert.equal(item.description,
    `Set the group lifetime to 90 days (it is 180 days now) in the ${GROUP_LIFETIME_PORTAL_PATH}, choosing Custom. `
    + 'Groups not renewed within 90 days then expire and are deleted. Or have a second person approve the shorter lifetime '
    + 'as a high-impact change and promote the restore again.');
});

test('D3: a shorter group lifetime is a content effect needing the separate approval, and is written with it', async () => {
  const graph = recordingGraph();
  const resource = plannedUpdate(graph, 'groupLifecyclePolicy', '/groupLifecyclePolicies/policy-1', { ...expiryLive, groupLifetimeInDays: 90 }, expiryLive);
  const { effects, refusals } = classifyContentEffects([resource]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(effects.map(({ naturalKey, field, effect, before, after }) => ({ naturalKey, field, effect, before, after })), [
    { naturalKey: resource.naturalKey, field: 'groupLifetimeInDays', effect: 'retention-reducing', before: 180, after: 90 },
  ]);
  // A longer lifetime, or a change to the other fields, is not a content effect.
  assert.deepEqual(classifyContentEffects([{ ...resource, payload: { ...expiryLive, groupLifetimeInDays: 365, managedGroupTypes: 'All' } }]).effects, []);

  // A dry run simulates the write and reports the pending approval, so it stays promotable.
  const dry = await run(graph, [resource], { mode: 'dry-run' });
  assert.deepEqual(dry.skipped, []);
  assert.deepEqual(dry.failed, []);
  assert.equal(dry.applied.length, 1);
  assert.deepEqual(dry.applied[0].pendingApproval, groupLifetimeCompletionItem({ from: 180, to: 90 }));
  assert.equal(graph.bodies.length, 0);

  // The promotion passes the effects whose approval it checked: the PATCH is sent.
  const result = await run(graph, [resource], { approvedContentEffects: effects });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path: '/groupLifecyclePolicies/policy-1', body: { groupLifetimeInDays: 90 } }]);
});

test('D3: an approved shorter lifetime never unlocks a wider scope or a dropped notice address', async () => {
  for (const change of [{ managedGroupTypes: 'All' }, { alternateNotificationEmails: '' }]) {
    const live = { ...expiryLive, alternateNotificationEmails: 'it@contoso.example' };
    const graph = recordingGraph();
    const resource = plannedUpdate(graph, 'groupLifecyclePolicy', '/groupLifecyclePolicies/policy-1', { ...live, groupLifetimeInDays: 90, ...change }, live);
    const { effects } = classifyContentEffects([resource]);
    for (const mode of ['enforce', 'dry-run']) {
      const result = await run(graph, [resource], { mode, approvedContentEffects: effects });
      assert.equal(graph.bodies.length, 0, JSON.stringify(change));
      assert.equal(result.skipped.length, 1, `${mode} ${JSON.stringify(change)}`);
      assert.equal(result.skipped[0].completion, undefined);
    }
  }
});

test('mutation: group expiry that would drop a renewal notice address is left to a person', async () => {
  const live = { id: 'policy-1', groupLifetimeInDays: 180, managedGroupTypes: 'All', alternateNotificationEmails: 'Admins@Contoso.example;it@contoso.example' };
  for (const emails of ['', 'old-mailbox@contoso.example', 'admins@contoso.example']) {
    const graph = recordingGraph();
    const result = await run(graph, [plannedUpdate(graph, 'groupLifecyclePolicy', '/groupLifecyclePolicies/policy-1', { ...live, alternateNotificationEmails: emails }, live)]);
    assert.equal(graph.bodies.length, 0, emails);
    assert.match(result.skipped[0].reason, /^manual: the restore would stop renewal notices to /, emails);
    assert.match(result.skipped[0].reason, /it@contoso\.example/);
  }
  // The other direction: keeping every live address (any case or order) and adding one is restored.
  const graph = recordingGraph();
  const desired = { ...live, alternateNotificationEmails: 'IT@contoso.example; admins@contoso.example;new@contoso.example' };
  const result = await run(graph, [plannedUpdate(graph, 'groupLifecyclePolicy', '/groupLifecyclePolicies/policy-1', desired, live)]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(graph.bodies[0].body, { alternateNotificationEmails: desired.alternateNotificationEmails });
});

test('mutation: a group lifetime that cannot be compared is left to a person', () => {
  const base = { groupLifetimeInDays: 180, managedGroupTypes: 'All', alternateNotificationEmails: '' };
  for (const [desired, live] of [
    [{ groupLifetimeInDays: 30 }, { ...base, groupLifetimeInDays: null }],
    [{ groupLifetimeInDays: 30 }, { managedGroupTypes: 'All' }],
    [{ groupLifetimeInDays: '30' }, base],
    [{ groupLifetimeInDays: null }, base],
    [{ groupLifetimeInDays: 0 }, base],
    [{ groupLifetimeInDays: 365 }, { ...base, groupLifetimeInDays: -1 }],
  ]) {
    assert.match(groupLifecycleGuard(desired, live) ?? '', /cannot be compared/, JSON.stringify([desired, live]));
  }
  assert.equal(groupLifecycleGuard({ groupLifetimeInDays: 365 }, base), null);
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
