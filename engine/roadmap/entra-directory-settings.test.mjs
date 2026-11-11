/**
 * Issue #1075: the last Entra directory settings and objects, driven through
 * the production applyWave path against the fixture Graph. No live tenant is
 * read or written. App certificate authority trust is reclassified (checked
 * first).
 *
 * Shapes follow the Graph reference, beta where the backup reads beta:
 * resources/signinidentifierbase (named by `name`, no id), m365capabilitybase
 * (named by `name`, inboundAccess with resourceScopes), profilecardproperty
 * (v1.0, named by directoryPropertyName), verifiedidprofile and
 * verifiedidprofileconfiguration (acceptedIssuer), identitygovernance-
 * lifecyclepolicy, devicetemplate and schemaextension (v1.0). None was taken
 * from a live capture yet; each type's live capture confirms it.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { naturalKeyFor } from '../cir/naturalKey.mjs';
import { OPERATIONS, capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { TYPE_GUIDE } from '../coverage/coverageDoc.mjs';
import { qualificationFor } from '../coverage/qualification.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { applyDirectorySettingWrite } from '../restore/directorySettingOperations.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };
const IDENTIFIERS = '/identity/signInIdentifiers';
const CAPABILITIES = '/policies/crossTenantAccessPolicy/default/m365Capabilities';
const CARDS = '/admin/people/profileCardProperties';
const PROFILES = '/identity/verifiedId/profiles';
const POLICIES = '/identityGovernance/lifecycleWorkflows/lifecyclePolicies';
const TEMPLATES = '/templates/deviceTemplates';
// Trust fields: whose credentials are accepted, who the verifier is, and which certificates devices sign in with.
const NEVER_WRITTEN = ['verifiedIdProfileConfiguration', 'acceptedIssuer', 'claimBindings', 'verifierDid', 'mobileDriversLicenseConfiguration',
  'mutualTlsOauthConfigurationId', 'mutualTlsOauthConfigurationTenantId'];

/** fakeGraph that records every write body. */
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

function keysIn(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => keysIn(item, found));
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { found.add(key); keysIn(child, found); }
  return found;
}
function assertNoTrustFields(graph) {
  const keys = keysIn(graph.bodies.map((entry) => entry.body));
  for (const field of NEVER_WRITTEN) assert.ok(!keys.has(field), `${field} is never written: ${JSON.stringify(graph.bodies)}`);
  assert.ok(!JSON.stringify(graph.bodies).includes('did:web:'), 'no issuer or verifier DID is ever written');
}

const run = (graph, resources, options = {}) => applyWave(graph, governor, resources, { targetTenant: 'fixture', mode: 'enforce', ...FAST, ...options });
const effectsOf = (resource) => classifyContentEffects([resource]).effects;
const stepsOf = (entry) => [...(entry?.completion ?? []), ...(entry?.followUp ?? [])];
const methods = (graph) => graph.bodies.map((entry) => [entry.method, entry.path]);

function resourceOf(resourceType, verb, payload, live = null, targetId = live?.id ?? null) {
  return {
    naturalKey: `${resourceType}:fixture`, resourceType, verb, references: [], blastRadius: 'access-affecting', payload,
    ...(live ? { targetId, live: { state: 'present', targetId, payload: live } } : {}),
  };
}

// ------------------------------------------------------------ the ledger

test('every type of the issue is written or reclassified; none is left "not built yet"', () => {
  const written = {
    signInIdentifier: ['update'], crossTenantM365Capability: ['update'], profileCardProperty: ['create', 'update'],
    verifiedIdProfile: ['create', 'update'], lifecyclePolicy: ['create', 'update'], deviceTemplate: ['create'], schemaExtension: ['create'],
  };
  for (const [type, verbs] of Object.entries(written)) {
    assert.equal(qualificationFor(type).decision, 'automated', type);
    assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor(type, operation).claim)), verbs, type);
    assert.equal(TYPE_GUIDE[type].decision, 'automated', type);
  }
  // The trust list is the whole configuration, and a restore never writes it.
  const cbac = qualificationFor('certificateBasedApplicationConfiguration');
  assert.equal(cbac.decision, 'manual');
  assert.match(cbac.reason, /^KEEL choice, issue #1075: .*trust field.*https:\/\/learn\.microsoft\.com\//);
  assert.equal(TYPE_GUIDE.certificateBasedApplicationConfiguration.limit, 'keel');
  assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor('certificateBasedApplicationConfiguration', operation).claim)), []);
});

test('a sign-in identifier and a default capability are keyed by their name, as Graph returns them with no id', () => {
  assert.equal(naturalKeyFor('signInIdentifier', { '@odata.type': '#microsoft.graph.emailSignInIdentifier', name: 'Email', isEnabled: true }), 'Email');
  assert.equal(naturalKeyFor('crossTenantM365Capability', { name: 'crossTenantMailTipsLimited', inboundAccess: { isAllowed: true } }), 'crossTenantMailTipsLimited');
  assert.equal(naturalKeyFor('signInIdentifier', { id: 'kept-id', name: 'Email' }), 'kept-id', 'an id Graph does return keeps the key it gave before');
});

// ------------------------------------------------------------ sign-in identifiers

const identifier = (isEnabled) => ({ '@odata.type': '#microsoft.graph.usernameSignInIdentifier', name: 'Username', isEnabled });
const identifierResource = (desired, live) => resourceOf('signInIdentifier', 'update', identifier(desired), identifier(live), 'Username');

test('a sign-in identifier turned on or off waits for its approval, then only isEnabled is written under its name', async () => {
  const resource = identifierResource(false, true);
  const effects = effectsOf(resource);
  assert.deepEqual(effects.map((effect) => [effect.effect, effect.field, effect.before, effect.after]), [['changes-sign-in', 'isEnabled', true, false]]);
  assert.match(effects[0].disclosure, /stops everyone in the tenant signing in with their Username identifier/, 'the dry run says it in plain words');

  const held = recordingGraph();
  held.objects.set(`${IDENTIFIERS}/Username`, identifier(true));
  const waiting = await run(held, [resource]);
  assert.equal(waiting.applied.length, 0);
  assert.deepEqual(waiting.skipped[0].completion.map((step) => step.requirement), ['signInApproval']);
  assert.deepEqual(held.writes, [], 'nothing is read or written without the approval');

  const dry = recordingGraph();
  const planned = await run(dry, [resource], { mode: 'dry-run' });
  assert.deepEqual(planned.applied[0].changes.fields, ['isEnabled']);
  assert.deepEqual(dry.writes, []);

  const graph = recordingGraph();
  graph.objects.set(`${IDENTIFIERS}/Username`, identifier(true));
  const result = await run(graph, [resource], { approvedContentEffects: effects });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path: `${IDENTIFIERS}/Username`, body: { '@odata.type': '#microsoft.graph.usernameSignInIdentifier', name: 'Username', isEnabled: false } }]);
  assert.equal(graph.objects.get(`${IDENTIFIERS}/Username`).isEnabled, false);
});

test('a sign-in identifier that already matches sends nothing, and on the test tenant it needs the tenant-wide option', async () => {
  const same = identifierResource(true, true);
  assert.deepEqual(effectsOf(same), []);
  const graph = recordingGraph();
  const result = await run(graph, [same]);
  assert.deepEqual(result.applied[0].changes.fields, []);
  assert.deepEqual(graph.writes, []);

  const resource = identifierResource(false, true);
  const testTenant = { tenantRef: 'sha256:keeltesttenant0', testTenantRefs: ['sha256:keeltesttenant0'], approvedContentEffects: effectsOf(resource) };
  for (const mode of ['dry-run', 'enforce']) {
    const tenant = recordingGraph();
    const refused = await applyDirectorySettingWrite(tenant, resource, 'update', { ...testTenant, mode });
    assert.match(refused.skipped?.reason ?? '', /is tenant-wide and needs a dry run made with --allow-tenant-wide-test-writes/, mode);
    assert.deepEqual(tenant.writes, [], mode);
  }
  const allowed = recordingGraph();
  allowed.objects.set(`${IDENTIFIERS}/Username`, identifier(true));
  const written = await applyDirectorySettingWrite(allowed, resource, 'update', { ...testTenant, allowTenantWide: true, mode: 'enforce' });
  assert.ok(written.applied, JSON.stringify(written));
});

// ------------------------------------------------------- default cross-tenant capabilities

const capability = (isAllowed, included = []) => ({
  '@odata.type': '#microsoft.graph.crossTenantMailTipsLimited', name: 'crossTenantMailTipsLimited', lastModifiedDateTime: '2026-01-01T00:00:00Z',
  inboundAccess: { isAllowed, resourceScopes: { included, excluded: [] } },
});

test('opening a default capability to other tenants is an "externally sharing" effect; once approved only inboundAccess is written', async () => {
  const resource = resourceOf('crossTenantM365Capability', 'update', capability(true), capability(false), 'crossTenantMailTipsLimited');
  const effects = effectsOf(resource);
  assert.deepEqual(effects.map((effect) => [effect.effect, effect.field, effect.before, effect.after]), [['externally-sharing', 'inboundAccess.isAllowed', false, true]]);
  assert.match(effects[0].disclosure, /opens crossTenantMailTipsLimited to people in every other organization by default/);

  const held = recordingGraph();
  assert.equal((await run(held, [resource])).skipped[0].completion[0].requirement, 'sharingApproval');
  assert.deepEqual(held.writes, []);

  const graph = recordingGraph();
  graph.objects.set(`${CAPABILITIES}/crossTenantMailTipsLimited`, capability(false));
  // Graph documents no read of one default capability: it is read back from the list.
  const read = graph.read.bind(graph);
  graph.read = async (version, path) => (path === `${CAPABILITIES}/crossTenantMailTipsLimited` ? { ok: false, status: 405, body: null } : read(version, path));
  const result = await run(graph, [resource], { approvedContentEffects: effects });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path: `${CAPABILITIES}/crossTenantMailTipsLimited`, body: { inboundAccess: { isAllowed: true, resourceScopes: { included: [], excluded: [] } } } }]);
});

test('a capability whose group scopes differ is a step for a person: nothing is written and nothing waits for approval', async () => {
  const scoped = capability(true, [{ resourceId: 'source-group', resourceType: 'group' }]);
  const resource = resourceOf('crossTenantM365Capability', 'update', scoped, capability(false), 'crossTenantMailTipsLimited');
  assert.deepEqual(effectsOf(resource), [], 'a skipped write carries no effect');
  const graph = recordingGraph();
  const result = await run(graph, [resource], { approvedContentEffects: effectsOf(resource) });
  assert.equal(result.applied.length, 0);
  assert.deepEqual(result.skipped[0].completion.map((step) => step.requirement), ['capabilityScopes']);
  assert.deepEqual(graph.writes, []);
});

// ------------------------------------------------------------ profile card fields

const card = (displayName, localizations = [{ languageTag: 'fr-FR', displayName: 'Centre de coût' }]) => ({
  directoryPropertyName: 'CustomAttribute1', isVisible: true, annotations: [{ displayName, localizations }],
});

test('a missing profile card field is created under its directory field; one already there is updated instead', async () => {
  const graph = recordingGraph();
  const created = await run(graph, [resourceOf('profileCardProperty', 'create', card('Cost center'))]);
  assert.deepEqual(created.failed, []);
  assert.deepEqual(methods(graph), [['POST', CARDS]]);
  assert.deepEqual(graph.bodies[0].body, { ...card('Cost center') });
  assert.deepEqual(graph.objects.get(`${CARDS}/CustomAttribute1`).annotations[0].displayName, 'Cost center');

  const again = recordingGraph();
  again.objects.set(`${CARDS}/CustomAttribute1`, card('Old label'));
  const updated = await run(again, [resourceOf('profileCardProperty', 'create', card('Cost center'))]);
  assert.deepEqual(updated.failed, []);
  assert.deepEqual(methods(again), [['PATCH', `${CARDS}/CustomAttribute1`]]);
  assert.deepEqual(Object.keys(again.bodies[0].body), ['annotations']);
});

test('a profile card update ignores the order Graph lists the label languages in, and a failed lookup creates nothing', async () => {
  const two = [{ languageTag: 'fr-FR', displayName: 'Centre de coût' }, { languageTag: 'de-DE', displayName: 'Kostenstelle' }];
  const graph = recordingGraph();
  const live = card('Cost center', [...two].reverse());
  graph.objects.set(`${CARDS}/CustomAttribute1`, live);
  const same = await run(graph, [resourceOf('profileCardProperty', 'update', card('Cost center', two), live, 'CustomAttribute1')]);
  assert.deepEqual(same.applied[0].changes.fields, []);
  assert.deepEqual(graph.writes, []);

  const broken = recordingGraph();
  broken.read = async () => ({ ok: false, status: 403, body: { error: { code: 'Authorization_RequestDenied' } } });
  const failed = await run(broken, [resourceOf('profileCardProperty', 'create', card('Cost center'))]);
  assert.match(failed.failed[0].error, /could not read the profile card field CustomAttribute1/);
  assert.deepEqual(broken.bodies, [], 'a failed lookup is never treated as absent');
});

// --------------------------------------------------------------- Verified ID

function profile(extra = {}) {
  return {
    '@odata.type': '#microsoft.graph.verifiedIdProfile', id: 'source-profile', name: 'KEEL-RT-148-profile', description: 'Checks new hires',
    lastModifiedDateTime: '2026-01-01T00:00:00Z', state: 'enabled', priority: 1, verifierDid: 'did:web:verifier.keel-rt.invalid',
    verifiedIdProfileConfiguration: {
      methodType: 'identityVerificationPartner', type: 'VerifiedIdentity', acceptedIssuer: 'did:web:issuer.keel-rt.invalid',
      claimBindingSource: 'directory', claimBindings: [{ sourceAttribute: 'givenName', verifiedIdClaim: 'firstName' }],
    },
    faceCheckConfiguration: { isEnabled: true, sourcePhotoClaimName: 'portrait' },
    verifiedIdUsageConfigurations: [{ isEnabledForTestOnly: false, purpose: 'onboarding' }],
    ...extra,
  };
}

test('a Verified ID update never sends the accepted issuer, claims or verifier; a difference in them is a step for a person', async () => {
  const live = profile({
    id: 'live-profile', description: 'old text', priority: 2,
    verifierDid: 'did:web:other-verifier.keel-rt.invalid',
    verifiedIdProfileConfiguration: { ...profile().verifiedIdProfileConfiguration, acceptedIssuer: 'did:web:other-issuer.keel-rt.invalid' },
  });
  const resource = resourceOf('verifiedIdProfile', 'update', profile(), live);
  const effects = effectsOf(resource);
  assert.deepEqual(effects.map((effect) => [effect.effect, effect.field]), [['changes-sign-in', 'priority']]);
  const graph = recordingGraph();
  graph.objects.set(`${PROFILES}/live-profile`, live);
  const result = await run(graph, [resource], { approvedContentEffects: effects });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(methods(graph), [['PATCH', `${PROFILES}/live-profile`]]);
  assert.deepEqual(graph.bodies[0].body, { description: 'Checks new hires', priority: 1 });
  assertNoTrustFields(graph);
  const [trust] = stepsOf(result.applied[0]).filter((step) => step.requirement === 'trustFields');
  assert.deepEqual([...trust.fields].sort(), ['verifiedIdProfileConfiguration', 'verifierDid']);
  assert.equal(graph.objects.get(`${PROFILES}/live-profile`).verifiedIdProfileConfiguration.acceptedIssuer, 'did:web:other-issuer.keel-rt.invalid', 'the live issuer is unchanged');
});

test('a Verified ID change to its state, Face Check or purposes waits for its approval; a partial approval still holds it', async () => {
  const live = profile({ id: 'live-profile', state: 'disabled', faceCheckConfiguration: { isEnabled: false, sourcePhotoClaimName: 'portrait' } });
  const resource = resourceOf('verifiedIdProfile', 'update', profile(), live);
  const effects = effectsOf(resource);
  assert.deepEqual(effects.map((effect) => effect.field).sort(), ['faceCheckConfiguration', 'state']);
  const graph = recordingGraph();
  graph.objects.set(`${PROFILES}/live-profile`, live);
  const partly = await run(graph, [resource], { approvedContentEffects: effects.filter((effect) => effect.field === 'state') });
  assert.equal(partly.applied.length, 0);
  assert.deepEqual(partly.skipped[0].completion[0].fields, ['faceCheckConfiguration']);
  assert.deepEqual(graph.writes, []);
  const approved = await run(graph, [resource], { approvedContentEffects: effects });
  assert.deepEqual(approved.failed, []);
  assert.deepEqual(Object.keys(graph.bodies[0].body).sort(), ['faceCheckConfiguration', 'state']);
});

test('a Verified ID create never POSTs: it updates the live profile with the same name, or names the issuer to set up', async () => {
  const missing = recordingGraph();
  const resource = resourceOf('verifiedIdProfile', 'create', profile());
  const step = await run(missing, [resource], { approvedContentEffects: effectsOf(resource) });
  assert.equal(step.applied.length, 0);
  assert.equal(step.skipped[0].completion[0].requirement, 'recreateProfile');
  assert.match(step.skipped[0].completion[0].description, /accepting credentials from did:web:issuer\.keel-rt\.invalid/);
  assert.deepEqual(missing.bodies, []);

  const graph = recordingGraph();
  graph.objects.set(`${PROFILES}/hand-made`, profile({ id: 'hand-made', description: 'made by hand' }));
  const result = await run(graph, [resource], { approvedContentEffects: effectsOf(resource) });
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied[0].targetId, 'hand-made');
  assert.deepEqual(graph.bodies.map((entry) => [entry.method, entry.path, entry.body]), [['PATCH', `${PROFILES}/hand-made`, { description: 'Checks new hires' }]]);
  assertNoTrustFields(graph);
});

// ------------------------------------------------------------ lifecycle policies

function policy(extra = {}) {
  return {
    '@odata.type': '#microsoft.graph.identityGovernance.agentIdentityLifecyclePolicy', id: 'source-policy', displayName: 'KEEL-RT-148-policy',
    description: 'Disable agents without a sponsor', isEnabled: true, policySource: 'userCreated', versionNumber: 3, gracePeriodInDays: 14,
    createdDateTime: '2026-01-01T00:00:00Z', lastModifiedDateTime: '2026-01-02T00:00:00Z', scope: null,
    enforcementAction: { '@odata.type': '#microsoft.graph.identityGovernance.disableOnlyEnforcementAction' },
    notificationSchedule: { offsetsAfterNonComplianceInDays: [14, 7, 1] },
    ...extra,
  };
}

test('a lifecycle policy is created switched off even when the backup was on; turning it on and its rules are steps', async () => {
  const resource = resourceOf('lifecyclePolicy', 'create', policy());
  assert.deepEqual(effectsOf(resource), [], 'a policy created off acts on nobody');
  const graph = recordingGraph();
  const result = await run(graph, [resource]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(methods(graph), [['POST', POLICIES]]);
  const { body } = graph.bodies[0];
  assert.equal(body.isEnabled, false);
  assert.equal(body['@odata.type'], '#microsoft.graph.identityGovernance.agentIdentityLifecyclePolicy');
  assert.deepEqual(Object.keys(body).sort(), ['@odata.type', 'description', 'displayName', 'enforcementAction', 'gracePeriodInDays', 'isEnabled', 'notificationSchedule', 'scope']);
  assert.deepEqual(stepsOf(result.applied[0]).map((step) => step.requirement), ['policyRules']);
});

test('a lifecycle policy create finds one made before, never twins it, and Microsoft\'s default is never created', async () => {
  const graph = recordingGraph();
  graph.objects.set(`${POLICIES}/earlier`, policy({ id: 'earlier', isEnabled: false, gracePeriodInDays: 30 }));
  const result = await run(graph, [resourceOf('lifecyclePolicy', 'create', policy())]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(methods(graph), [['PATCH', `${POLICIES}/earlier`]]);
  assert.deepEqual(graph.bodies[0].body, { '@odata.type': '#microsoft.graph.identityGovernance.agentIdentityLifecyclePolicy', gracePeriodInDays: 14 });
  assert.deepEqual(stepsOf(result.applied[0]).map((step) => step.requirement), ['turnOn'], 'the policy is left off');

  const on = recordingGraph();
  on.objects.set(`${POLICIES}/earlier`, policy({ id: 'earlier', isEnabled: true, gracePeriodInDays: 30 }));
  const held = await run(on, [resourceOf('lifecyclePolicy', 'create', policy())]);
  assert.equal(held.skipped[0].completion[0].requirement, 'policyOn');
  assert.deepEqual(on.bodies, []);

  const microsoft = recordingGraph();
  const builtIn = await run(microsoft, [resourceOf('lifecyclePolicy', 'create', policy({ policySource: 'systemDefault' }))]);
  assert.equal(builtIn.skipped[0].completion[0].requirement, 'microsoftDefault');
  assert.deepEqual(microsoft.writes, []);
});

test('on a lifecycle policy that is on, a change to who it covers or what it does waits for its approval', async () => {
  const live = policy({ id: 'live-policy', gracePeriodInDays: 30, enforcementAction: { '@odata.type': '#microsoft.graph.identityGovernance.disableThenDeleteEnforcementAction' } });
  const resource = resourceOf('lifecyclePolicy', 'update', policy(), live);
  const effects = effectsOf(resource);
  assert.deepEqual(effects.map((effect) => [effect.effect, effect.field]), [['acts-on-accounts', 'enforcementAction'], ['acts-on-accounts', 'gracePeriodInDays']]);
  const graph = recordingGraph();
  graph.objects.set(`${POLICIES}/live-policy`, live);
  const partly = await run(graph, [resource], { approvedContentEffects: effects.slice(1) });
  assert.equal(partly.applied.length, 0);
  assert.deepEqual(partly.skipped[0].completion[0].fields, ['enforcementAction']);
  assert.deepEqual(graph.writes, []);
  const approved = await run(graph, [resource], { approvedContentEffects: effects });
  assert.deepEqual(approved.failed, []);
  assert.deepEqual(Object.keys(graph.bodies[0].body).sort(), ['@odata.type', 'enforcementAction', 'gracePeriodInDays']);
  assert.ok(!('isEnabled' in graph.bodies[0].body));

  // The same change on a policy that is off needs no approval, and an update never turns it on.
  const offLive = { ...live, isEnabled: false };
  const off = resourceOf('lifecyclePolicy', 'update', policy(), offLive);
  assert.deepEqual(effectsOf(off), []);
  const other = recordingGraph();
  other.objects.set(`${POLICIES}/live-policy`, offLive);
  const written = await run(other, [off]);
  assert.deepEqual(written.failed, []);
  assert.equal(other.objects.get(`${POLICIES}/live-policy`).isEnabled, false);
  assert.deepEqual(stepsOf(written.applied[0]).map((step) => step.requirement), ['turnOn']);
});

// ------------------------------------------------------------ device templates

const template = (extra = {}) => ({
  '@odata.type': '#microsoft.graph.deviceTemplate', id: 'source-template', deletedDateTime: null, deviceAuthority: 'KEEL-RT-148 Retail',
  manufacturer: 'KEEL-RT-148-maker', model: 'KEEL-RT-148-model', operatingSystem: 'Linux',
  mutualTlsOauthConfigurationId: null, mutualTlsOauthConfigurationTenantId: null, ...extra,
});

test('a device template is created with its maker, model, system and authority; its owners are a step', async () => {
  const graph = recordingGraph();
  const result = await run(graph, [resourceOf('deviceTemplate', 'create', template())]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'POST', path: TEMPLATES, body: { deviceAuthority: 'KEEL-RT-148 Retail', manufacturer: 'KEEL-RT-148-maker', model: 'KEEL-RT-148-model', operatingSystem: 'Linux' } }]);
  assert.deepEqual(stepsOf(result.applied[0]).map((step) => step.requirement), ['templateOwners']);

  const again = recordingGraph();
  again.objects.set(`${TEMPLATES}/earlier`, { ...template(), id: 'earlier' });
  const twin = await run(again, [resourceOf('deviceTemplate', 'create', template())]);
  assert.equal(twin.applied[0].targetId, 'earlier');
  assert.deepEqual(again.bodies, [], 'a template made before is never twinned');
});

test('a device template with a mutual TLS configuration is never created: certificate trust is a step for a person', async () => {
  const graph = recordingGraph();
  const result = await run(graph, [resourceOf('deviceTemplate', 'create', template({ mutualTlsOauthConfigurationId: 'mtls-config', mutualTlsOauthConfigurationTenantId: 'maker-tenant' }))]);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].completion[0].requirement, 'trustFields');
  assert.deepEqual(graph.writes, []);
});

// ------------------------------------------------------------ schema extensions

const OWNER = "/applications(appId='owner-app')";
const extension = (extra = {}) => ({
  id: 'keelrt_courses', description: 'Training courses', owner: 'owner-app', status: 'Available', targetTypes: ['Group'],
  properties: [{ name: 'courseId', type: 'Integer' }, { name: 'courseName', type: 'String' }], ...extra,
});

test('a schema extension is created with its id and owner app only when the owner app is here; its values are a step', async () => {
  const none = recordingGraph();
  const waiting = await run(none, [resourceOf('schemaExtension', 'create', extension())]);
  assert.equal(waiting.skipped[0].completion[0].requirement, 'ownerAppFirst');
  assert.deepEqual(none.bodies, []);

  const graph = recordingGraph();
  graph.objects.set(OWNER, { id: 'owner-object', appId: 'owner-app' });
  const result = await run(graph, [resourceOf('schemaExtension', 'create', extension())]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'POST', path: '/schemaExtensions', body: { id: 'keelrt_courses', description: 'Training courses', owner: 'owner-app', targetTypes: ['Group'], properties: extension().properties } }]);
  assert.equal(result.applied[0].targetId, 'keelrt_courses');
  assert.deepEqual(stepsOf(result.applied[0]).map((step) => step.requirement), ['extensionValues', 'extensionStatus']);

  const again = await run(graph, [resourceOf('schemaExtension', 'create', extension())]);
  assert.equal(again.applied[0].targetId, 'keelrt_courses');
  assert.equal(graph.bodies.length, 1, 'an extension already there is left as it is');
});

test('a schema extension Graph gives another id is reported, so the owner app can be pointed at it', async () => {
  const graph = recordingGraph();
  graph.objects.set(OWNER, { id: 'owner-object', appId: 'owner-app' });
  const write = graph.write;
  graph.write = async (version, path, request) => {
    if (request.method !== 'POST') return write(version, path, request);
    graph.bodies.push({ method: request.method, path, body: request.body });
    const created = { ...request.body, id: 'extk9eruy7c_courses', status: 'InDevelopment' };
    graph.objects.set('/schemaExtensions/extk9eruy7c_courses', created);
    return { ok: true, status: 201, body: created };
  };
  const result = await run(graph, [resourceOf('schemaExtension', 'create', extension({ id: 'courses', status: 'InDevelopment' }))]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied[0].targetId, 'extk9eruy7c_courses');
  assert.match(stepsOf(result.applied[0]).find((step) => step.requirement === 'extensionId').description, /extk9eruy7c_courses, not courses/);
});
