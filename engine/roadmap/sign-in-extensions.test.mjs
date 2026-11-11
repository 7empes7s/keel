/**
 * Issue #1072: custom authentication extensions and authentication event
 * listeners, driven through the production applyWave path against the fixture
 * Graph. No live tenant is read or written. PIM custom extensions and PIM
 * managed groups are reclassified (checked at the end).
 *
 * Shapes follow the Graph v1.0 reference: an extension holds its endpoint
 * (endpointConfiguration.targetUrl), how Entra signs in to it
 * (authenticationConfiguration.resourceId), its client settings and, for token
 * issuance, the claims it adds (resources/ontokenissuancestartcustomextension).
 * A listener list read returns its handler with the extension expanded, name
 * and endpoint included (api/identitycontainer-list-authenticationeventlisteners).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { OPERATIONS, capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { TYPE_GUIDE } from '../coverage/coverageDoc.mjs';
import { qualificationFor } from '../coverage/qualification.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };
const EXTENSIONS = '/identity/customAuthenticationExtensions';
const LISTENERS = '/identity/authenticationEventListeners';
const TOKEN_EXTENSION = '#microsoft.graph.onTokenIssuanceStartCustomExtension';
const TOKEN_LISTENER = '#microsoft.graph.onTokenIssuanceStartListener';
const TOKEN_HANDLER = '#microsoft.graph.onTokenIssuanceStartCustomExtensionHandler';
// Every field that names the endpoint, how Entra signs in to it, or its client
// settings. None of them may ever be in a write body, at any depth.
const NEVER_WRITTEN = ['endpointConfiguration', 'targetUrl', 'authenticationConfiguration', 'resourceId', 'clientConfiguration', 'configuration',
  'timeoutInMilliseconds', 'maximumRetries', 'logicApp', 'subscriptionId', 'resourceGroupName', 'logicAppWorkflowName', 'behaviorOnError'];

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

/** The keys anywhere in a value. */
function keysIn(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => keysIn(item, found));
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { found.add(key); keysIn(child, found); }
  return found;
}

function assertNoEndpointFields(graph) {
  const keys = keysIn(graph.bodies.map((entry) => entry.body));
  for (const field of NEVER_WRITTEN) assert.ok(!keys.has(field), `${field} is never written: ${JSON.stringify(graph.bodies)}`);
  assert.ok(!JSON.stringify(graph.bodies).includes('keel-rt.invalid'), 'no endpoint address is ever written');
}

const run = (graph, resources, options = {}) => applyWave(graph, governor, resources, {
  targetTenant: 'fixture', mode: 'enforce', ...FAST, ...options,
});
const approvals = (resource) => classifyContentEffects([resource]).effects;
const stepsOf = (entry) => [...(entry?.completion ?? []), ...(entry?.followUp ?? [])];

// ------------------------------------------------------ custom authentication extensions

function extensionPayload(extra = {}) {
  return {
    '@odata.type': TOKEN_EXTENSION,
    id: 'src-extension', displayName: 'KEEL-RT-claims', description: 'Adds the cost centre claim',
    endpointConfiguration: { '@odata.type': '#microsoft.graph.httpRequestEndpoint', targetUrl: 'https://keel-rt.invalid/api/claims' },
    authenticationConfiguration: { '@odata.type': '#microsoft.graph.azureAdTokenAuthentication', resourceId: 'api://keel-rt.invalid/fixture-app' },
    clientConfiguration: { timeoutInMilliseconds: 2000, maximumRetries: 1 },
    behaviorOnError: { '@odata.type': '#microsoft.graph.fallbackToMicrosoftProviderOnError' },
    claimsForTokenConfiguration: [{ claimIdInApiResponse: 'CostCentre' }, { claimIdInApiResponse: 'Division' }],
    ...extra,
  };
}

function extensionResource(verb, extra = {}, live = null) {
  return {
    naturalKey: 'customAuthenticationExtension:src-extension', resourceType: 'customAuthenticationExtension', verb, references: [], blastRadius: 'access-affecting',
    payload: extensionPayload(extra),
    ...(live ? { targetId: live.id, live: { state: 'present', targetId: live.id, payload: live } } : {}),
  };
}

const liveExtension = (extra = {}) => ({ ...extensionPayload(), id: 'live-extension', ...extra });

test('a custom authentication extension is a fixture-tested create and update; delete stays unsupported', () => {
  assert.equal(qualificationFor('customAuthenticationExtension').decision, 'automated');
  assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor('customAuthenticationExtension', operation).claim)), ['create', 'update']);
});

test('an update sends only the type, name, description and token claims, never the endpoint, its sign-in or client settings', async () => {
  const graph = recordingGraph();
  const live = liveExtension({
    displayName: 'KEEL-RT-claims', description: 'old text', claimsForTokenConfiguration: [{ claimIdInApiResponse: 'CostCentre' }],
    endpointConfiguration: { '@odata.type': '#microsoft.graph.httpRequestEndpoint', targetUrl: 'https://keel-rt.invalid/api/other' },
    authenticationConfiguration: { '@odata.type': '#microsoft.graph.azureAdTokenAuthentication', resourceId: 'api://keel-rt.invalid/other-app' },
    clientConfiguration: { timeoutInMilliseconds: 1000, maximumRetries: 0 },
  });
  graph.objects.set(`${EXTENSIONS}/live-extension`, live);
  const resource = extensionResource('update', {}, live);
  const result = await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((entry) => [entry.method, entry.path]), [['PATCH', `${EXTENSIONS}/live-extension`]]);
  assert.deepEqual(Object.keys(graph.bodies[0].body).sort(), ['@odata.type', 'claimsForTokenConfiguration', 'description']);
  assertNoEndpointFields(graph);
  // The endpoint, its sign-in and client settings differ: each is a step for a person.
  const [trust] = stepsOf(result.applied[0]).filter((step) => step.requirement === 'trustFields');
  assert.ok(trust, JSON.stringify(result.applied[0]));
  assert.deepEqual([...trust.fields].sort(), ['authenticationConfiguration', 'clientConfiguration', 'endpointConfiguration']);
  assert.deepEqual(graph.objects.get(`${EXTENSIONS}/live-extension`).endpointConfiguration, live.endpointConfiguration, 'the live endpoint is unchanged');
});

test('a change to the token claims waits for the "changes sign-in" approval; a name or description change does not', async () => {
  const live = liveExtension({ claimsForTokenConfiguration: [{ claimIdInApiResponse: 'CostCentre' }] });
  const resource = extensionResource('update', {}, live);
  const effects = approvals(resource);
  assert.deepEqual(effects.map((effect) => [effect.effect, effect.field]), [['changes-sign-in', 'claimsForTokenConfiguration']]);
  const graph = recordingGraph();
  graph.objects.set(`${EXTENSIONS}/live-extension`, live);
  const held = await run(graph, [resource]);
  assert.equal(held.applied.length, 0);
  assert.deepEqual(held.skipped[0].completion.map((step) => step.requirement), ['signInApproval']);
  assert.deepEqual(graph.writes, []);

  const named = liveExtension({ description: 'old text' });
  const plain = extensionResource('update', {}, named);
  assert.deepEqual(approvals(plain), []);
  const other = recordingGraph();
  other.objects.set(`${EXTENSIONS}/live-extension`, named);
  const written = await run(other, [plain]);
  assert.deepEqual(written.failed, []);
  assert.deepEqual(other.bodies.map((entry) => entry.body), [{ '@odata.type': TOKEN_EXTENSION, description: 'Adds the cost centre claim' }]);
});

test('a missing extension found live by its name is updated in place, never created', async () => {
  const graph = recordingGraph();
  graph.objects.set(`${EXTENSIONS}/live-extension`, liveExtension({ displayName: 'keel-rt-CLAIMS', description: 'old text' }));
  graph.objects.set(`${EXTENSIONS}/other`, liveExtension({ id: 'other', displayName: 'KEEL-RT-other' }));
  const resource = extensionResource('create');
  const result = await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((entry) => [entry.method, entry.path]), [['PATCH', `${EXTENSIONS}/live-extension`]]);
  assert.deepEqual(graph.bodies[0].body, { '@odata.type': TOKEN_EXTENSION, displayName: 'KEEL-RT-claims', description: 'Adds the cost centre claim' });
  assert.equal(result.applied[0].targetId, 'live-extension');
  assertNoEndpointFields(graph);

  // A second run finds nothing to change.
  const again = await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.deepEqual(again.failed, []);
  assert.equal(graph.bodies.length, 1);
});

test('an extension missing live is a step naming the endpoint to set up; nothing is written', async () => {
  const graph = recordingGraph();
  const resource = extensionResource('create');
  for (const options of [{ mode: 'dry-run' }, { approvedContentEffects: approvals(resource) }]) {
    const result = await run(graph, [resource], options);
    assert.equal(result.applied.length, 0, JSON.stringify(result));
    const [step] = stepsOf(result.skipped[0]);
    assert.equal(step.requirement, 'recreateExtension');
    assert.match(step.description, /"KEEL-RT-claims"/);
    assert.match(step.description, /https:\/\/keel-rt\.invalid\/api\/claims/);
    assert.match(step.description, /api:\/\/keel-rt\.invalid\/fixture-app/);
  }
  assert.deepEqual(graph.writes, []);
});

test('a failed extension lookup is never read as "absent", and the dry run writes nothing', async () => {
  const graph = recordingGraph();
  graph.read = async () => ({ ok: false, status: 503, body: null });
  const missing = extensionResource('create');
  const failed = await run(graph, [missing], { approvedContentEffects: approvals(missing) });
  assert.equal(failed.skipped.length + failed.applied.length, 0);
  assert.match(failed.failed[0].error, /could not list/);
  assert.deepEqual(graph.writes, []);

  const live = liveExtension({ description: 'old text' });
  const dry = recordingGraph();
  dry.objects.set(`${EXTENSIONS}/live-extension`, live);
  const planned = await run(dry, [extensionResource('update', {}, live)], { mode: 'dry-run' });
  assert.deepEqual(planned.failed, []);
  assert.deepEqual(dry.writes, []);
});

test('a live extension of another kind with the backup\'s name is left for a person', async () => {
  const graph = recordingGraph();
  graph.objects.set(`${EXTENSIONS}/live-extension`, liveExtension({ '@odata.type': '#microsoft.graph.onAttributeCollectionSubmitCustomExtension' }));
  const resource = extensionResource('create');
  const result = await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.equal(result.applied.length, 0);
  assert.equal(stepsOf(result.skipped[0])[0].requirement, 'recreateExtension');
  assert.deepEqual(graph.writes, []);
});

// ------------------------------------------------------------ authentication event listeners

function listenerPayload(extra = {}) {
  return {
    '@odata.type': TOKEN_LISTENER, id: 'src-listener', authenticationEventsFlowId: null, priority: 500,
    conditions: { applications: {
      'includeApplications@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#identity/authenticationEventListeners(\'src-listener\')/microsoft.graph.onTokenIssuanceStartListener/conditions/applications/includeApplications',
      includeApplications: [{ appId: 'fixture-app-1' }, { appId: 'fixture-app-2' }],
    } },
    // The list read expands the extension, endpoint and sign-in included.
    handler: {
      '@odata.type': TOKEN_HANDLER, configuration: { clientConfiguration: { timeoutInMilliseconds: 2000, maximumRetries: 1 } },
      customExtension: extensionPayload(),
    },
    ...extra,
  };
}

function listenerResource(verb, extra = {}, live = null) {
  return {
    naturalKey: 'authenticationEventListener:src-listener', resourceType: 'authenticationEventListener', verb, references: [], blastRadius: 'access-affecting',
    payload: listenerPayload(extra),
    ...(live ? { targetId: live.id, live: { state: 'present', targetId: live.id, payload: live } } : {}),
  };
}

function graphWithExtension() {
  const graph = recordingGraph();
  graph.objects.set(`${EXTENSIONS}/live-extension`, liveExtension());
  return graph;
}

test('a listener is a fixture-tested create and update behind the "changes sign-in" approval; delete stays unsupported', () => {
  assert.equal(qualificationFor('authenticationEventListener').decision, 'automated');
  assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor('authenticationEventListener', operation).claim)), ['create', 'update']);
  const effects = approvals(listenerResource('create'));
  assert.deepEqual(effects.map((effect) => [effect.effect, effect.field]), [
    ['changes-sign-in', 'conditions'], ['changes-sign-in', 'handler'], ['changes-sign-in', 'priority'],
  ]);
  assert.deepEqual(effects.find((effect) => effect.field === 'handler').after, 'KEEL-RT-claims', 'the approval names the extension');
});

test('without an approval, or with only part of it, a listener is not written', async () => {
  const resource = listenerResource('create');
  for (const approved of [[], approvals(resource).slice(0, 2)]) {
    const graph = graphWithExtension();
    const result = await run(graph, [resource], { approvedContentEffects: approved });
    assert.equal(result.applied.length, 0);
    assert.deepEqual(result.skipped[0].completion.map((step) => step.requirement), ['signInApproval']);
    assert.deepEqual(graph.writes, []);
  }
});

test('an approved create points the listener at the live extension with the same name and sends no endpoint, sign-in or client field', async () => {
  const graph = graphWithExtension();
  const resource = listenerResource('create');
  const result = await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((entry) => [entry.method, entry.path]), [['POST', LISTENERS]]);
  const [{ body }] = graph.bodies;
  assert.deepEqual(Object.keys(body).sort(), ['@odata.type', 'conditions', 'handler', 'priority']);
  assert.deepEqual(body.handler, { '@odata.type': TOKEN_HANDLER, customExtension: { id: 'live-extension' } });
  assert.deepEqual(body.conditions, { applications: { includeApplications: [{ appId: 'fixture-app-1' }, { appId: 'fixture-app-2' }] } });
  assertNoEndpointFields(graph);

  // A second run from the same backup finds it and writes nothing.
  const again = await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.deepEqual(again.failed, []);
  assert.equal(graph.bodies.length, 1);
});

test('a listener whose extension is missing live is held with "recreate the extension first", even when approved', async () => {
  const resource = listenerResource('create');
  for (const options of [{ mode: 'dry-run' }, { approvedContentEffects: approvals(resource) }]) {
    const graph = recordingGraph();
    graph.objects.set(`${EXTENSIONS}/other`, liveExtension({ id: 'other', displayName: 'KEEL-RT-other' }));
    const result = await run(graph, [resource], options);
    assert.equal(result.applied.length, 0, JSON.stringify(result));
    const [step] = stepsOf(result.skipped[0]);
    assert.equal(step.requirement, 'extensionFirst');
    assert.match(step.description, /Recreate the custom authentication extension "KEEL-RT-claims" first/);
    assert.deepEqual(graph.writes, []);
  }
});

test('a listener whose backup does not name its extension is held too', async () => {
  const graph = graphWithExtension();
  const resource = listenerResource('create', { handler: { '@odata.type': TOKEN_HANDLER, customExtension: { id: 'src-extension' } } });
  const result = await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.equal(result.applied.length, 0);
  assert.equal(stepsOf(result.skipped[0])[0].requirement, 'extensionFirst');
  assert.deepEqual(graph.writes, []);
});

test('an approved update sends the type and the changed fields only', async () => {
  const graph = graphWithExtension();
  const live = {
    ...listenerPayload(), id: 'live-listener', priority: 500,
    conditions: { applications: { includeApplications: [{ appId: 'fixture-app-1' }] } },
    handler: { '@odata.type': TOKEN_HANDLER, customExtension: liveExtension() },
  };
  graph.objects.set(`${LISTENERS}/live-listener`, live);
  const resource = listenerResource('update', {}, live);
  assert.deepEqual(approvals(resource).map((effect) => effect.field), ['conditions']);
  const held = await run(graph, [resource]);
  assert.equal(held.applied.length, 0);
  assert.deepEqual(graph.writes, []);

  const result = await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((entry) => [entry.method, entry.path, entry.body]), [
    ['PATCH', `${LISTENERS}/live-listener`, { '@odata.type': TOKEN_LISTENER, conditions: { applications: { includeApplications: [{ appId: 'fixture-app-1' }, { appId: 'fixture-app-2' }] } } }],
  ]);
  assertNoEndpointFields(graph);
});

test('a listener that does not call a custom authentication extension is a step for a person', async () => {
  const graph = graphWithExtension();
  const resource = listenerResource('create', {
    '@odata.type': '#microsoft.graph.onAttributeCollectionListener',
    handler: { '@odata.type': '#microsoft.graph.onAttributeCollectionExternalUsersSelfServiceSignUp', attributes: [] },
  });
  const result = await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.equal(result.applied.length, 0);
  assert.equal(stepsOf(result.skipped[0])[0].requirement, 'userFlowListener');
  assert.deepEqual(graph.writes, []);
});

// ------------------------------------------------------------------ reclassified

test('PIM custom extensions are a KEEL choice and PIM managed groups a Microsoft limit, each with its reason', () => {
  const pim = qualificationFor('roleManagementCustomExtension');
  assert.equal(pim.decision, 'manual');
  assert.match(pim.reason, /^KEEL choice, issue #1072:/);
  assert.equal(TYPE_GUIDE.roleManagementCustomExtension.limit, 'keel');
  const groups = qualificationFor('privilegedAccessGroupResource');
  assert.equal(groups.decision, 'manual');
  assert.match(groups.reason, /^Microsoft limit, issue #1072:/);
  assert.equal(TYPE_GUIDE.privilegedAccessGroupResource.limit, 'microsoft');
  for (const type of ['customAuthenticationExtension', 'authenticationEventListener', 'roleManagementCustomExtension', 'privilegedAccessGroupResource']) {
    assert.notEqual(TYPE_GUIDE[type].limit, 'not-built', `${type} is no longer "not built yet"`);
  }
});
