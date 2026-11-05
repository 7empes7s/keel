/**
 * Issue #1008: idle sign-out (activity-based timeout) policies and user flow API
 * connectors, driven through the production applyWave path against the fixture
 * Graph. No live tenant is read or written.
 *
 * Shapes follow the Graph v1.0 reference: an idle sign-out policy's definition is
 * a list holding one JSON string (resources/activitybasedtimeoutpolicy), and an API
 * connector reads back with its basic authentication password masked as "******"
 * (api/identityapiconnector-create).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { OPERATIONS, capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { qualificationFor } from '../coverage/qualification.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };
const POLICIES = '/policies/activityBasedTimeoutPolicies';
const CONNECTORS = '/identity/apiConnectors';

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

/** A rollback journal that keeps every row it is given, as the database would. */
function journal() {
  const rows = [];
  return { rows, async query(_sql, params) { rows.push(params); return { rows: [{ id: `entry-${rows.length}` }] }; } };
}

const run = (graph, resources, options = {}) => applyWave(graph, governor, resources, {
  targetTenant: 'fixture', mode: 'enforce', ...FAST, ...options,
});

// ------------------------------------------------------------ idle sign-out policies

const idleDefinition = (timeout, spacing = '') => [
  `{"ActivityBasedTimeoutPolicy":{"Version":1,${spacing}"ApplicationPolicies":[{"ApplicationId":"default","WebSessionIdleTimeout":"${timeout}"}]}}`,
];

function idleResource(verb, payload = {}, live = null) {
  return {
    naturalKey: 'activityBasedTimeoutPolicy:src-idle', resourceType: 'activityBasedTimeoutPolicy', verb, references: [], blastRadius: 'access-affecting',
    payload: { id: 'src-idle', displayName: 'KEEL-RT-idle', definition: idleDefinition('01:00:00'), isOrganizationDefault: false, ...payload },
    ...(live ? { targetId: live.id, live: { state: 'present', targetId: live.id, payload: live } } : {}),
  };
}

const defaultsIn = (graph) => [...graph.objects.entries()]
  .filter(([key, object]) => key.startsWith(`${POLICIES}/`) && object.isOrganizationDefault === true);

test('an idle sign-out policy is a fixture-tested create and update; delete stays unsupported', () => {
  assert.equal(qualificationFor('activityBasedTimeoutPolicy').decision, 'automated');
  assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor('activityBasedTimeoutPolicy', operation).claim)), ['create', 'update']);
});

test('a definition entry that does not parse refuses the write before any Graph call', async () => {
  for (const definition of [['{"ActivityBasedTimeoutPolicy":{"Version":1'], [], 'not a list']) {
    const graph = recordingGraph();
    const result = await run(graph, [idleResource('create', { definition })]);
    assert.equal(result.applied.length, 0);
    assert.match(result.failed[0].error, /activityBasedTimeoutPolicy: the backed-up definition/);
    assert.deepEqual(graph.writes, [], JSON.stringify(definition));
  }
});

test('a backed-up organization default updates the live default in place and never creates a second one', async () => {
  const graph = recordingGraph();
  const liveDefault = { id: 'live-default', displayName: 'Contoso idle sign-out', definition: idleDefinition('04:00:00'), isOrganizationDefault: true };
  graph.objects.set(`${POLICIES}/live-default`, liveDefault);
  const result = await run(graph, [idleResource('create', { isOrganizationDefault: true })]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((entry) => [entry.method, entry.path]), [['PATCH', `${POLICIES}/live-default`]]);
  assert.deepEqual(graph.bodies[0].body, { displayName: 'KEEL-RT-idle', definition: idleDefinition('01:00:00') }, 'the flag is never sent');
  assert.equal(result.applied[0].targetId, 'live-default');
  assert.deepEqual(defaultsIn(graph).map(([key]) => key), [`${POLICIES}/live-default`]);
  assert.ok(!result.applied[0].followUp.some((step) => step.requirement === 'followUp:organization-default'), 'it is the default again: no step');

  // A second run finds it and writes nothing.
  const again = await run(graph, [idleResource('create', { isOrganizationDefault: true })]);
  assert.deepEqual(again.failed, []);
  assert.equal(graph.bodies.length, 1);
});

test('with no live default, a backed-up default is recreated as an ordinary policy with a step to make it the default', async () => {
  const graph = recordingGraph();
  graph.objects.set(`${POLICIES}/other`, { id: 'other', displayName: 'KEEL-RT-other', definition: idleDefinition('02:00:00'), isOrganizationDefault: false });
  const result = await run(graph, [idleResource('create', { isOrganizationDefault: true })]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((entry) => entry.method), ['POST']);
  assert.equal(graph.bodies[0].body.isOrganizationDefault, false);
  assert.deepEqual(defaultsIn(graph), []);
  assert.ok(result.applied[0].followUp.some((step) => step.requirement === 'followUp:organization-default'));
});

test('drift compares the parsed idle timeouts, not the text: spacing alone writes nothing, a new timeout is written', async () => {
  const graph = recordingGraph();
  const live = { id: 'live-1', displayName: 'KEEL-RT-idle', definition: idleDefinition('01:00:00', ' '), isOrganizationDefault: false };
  graph.objects.set(`${POLICIES}/live-1`, live);
  const same = await run(graph, [idleResource('update', {}, live)]);
  assert.deepEqual(same.failed, []);
  assert.deepEqual(graph.bodies, [], 'the same timeouts written with other spacing are not drift');

  const changed = await run(graph, [idleResource('update', { definition: idleDefinition('00:30:00') }, live)]);
  assert.deepEqual(changed.failed, []);
  assert.deepEqual(graph.bodies.map((entry) => [entry.method, entry.body]), [['PATCH', { definition: idleDefinition('00:30:00') }]]);
});

// ------------------------------------------------------------------ API connectors

const BACKED_UP_SECRETS = ['fixture-backed-up-password', 'fixture-pkcs12-value', 'fixture-certificate-password'];

function connectorResource(verb, payload = {}, live = null) {
  return {
    naturalKey: 'identityApiConnector:src-connector', resourceType: 'identityApiConnector', verb, references: [], blastRadius: 'access-affecting',
    payload: {
      id: 'src-connector', displayName: 'KEEL-RT-connector', targetUrl: 'https://keel-rt.invalid/api/signup',
      // More than Graph returns, to show none of it is ever sent.
      authenticationConfiguration: {
        '@odata.type': '#microsoft.graph.basicAuthentication', username: 'fixture-user', password: BACKED_UP_SECRETS[0],
        pkcs12Value: BACKED_UP_SECRETS[1], certificatePassword: BACKED_UP_SECRETS[2],
      },
      ...payload,
    },
    ...(live ? { targetId: live.id, live: { state: 'present', targetId: live.id, payload: live } } : {}),
  };
}

const approvals = (resource) => classifyContentEffects([resource]).effects;
const credentialSteps = (entry) => [...(entry.followUp ?? []), ...(entry.completion ?? [])]
  .filter((step) => step.kind === 'credential' && step.requirement === 'connectorCredential');

test('an API connector is a fixture-tested create and update behind the approval; delete stays unsupported', () => {
  assert.equal(qualificationFor('identityApiConnector').decision, 'automated');
  assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor('identityApiConnector', operation).claim)), ['create', 'update']);
  const effects = approvals(connectorResource('create'));
  assert.deepEqual(effects.map((effect) => [effect.effect, effect.field]).sort(), [['access-changing', 'displayName'], ['access-changing', 'targetUrl']]);
});

test('without an approval, or with only part of it, nothing is written and the approval is the step', async () => {
  const resource = connectorResource('create');
  for (const approved of [[], approvals(resource).slice(0, 1)]) {
    const graph = recordingGraph();
    const result = await run(graph, [resource], { approvedContentEffects: approved });
    assert.equal(result.applied.length, 0);
    assert.deepEqual(result.skipped[0].completion.map((step) => step.requirement), ['accessApproval']);
    assert.deepEqual(graph.writes, []);
  }
});

test('the dry run writes nothing and lists setting the real password or certificate', async () => {
  const graph = recordingGraph();
  const result = await run(graph, [connectorResource('create')], { mode: 'dry-run' });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.writes, []);
  const [step] = credentialSteps(result.applied[0]);
  assert.ok(step, 'the dry run lists the password or certificate');
  assert.notEqual(step.actionable, false);
});

test('an approved create sends a placeholder password nobody knows, never a backed-up secret, and logs neither', async () => {
  const graph = recordingGraph();
  const rollback = journal();
  const resource = connectorResource('create');
  const result = await run(graph, [resource], {
    approvedContentEffects: approvals(resource), rollbackClient: rollback, restoreRef: 'restore-1008', runId: 'run-1008',
  });
  assert.deepEqual(result.failed, []);
  const [post] = graph.bodies;
  assert.deepEqual([post.method, post.path], ['POST', CONNECTORS]);
  assert.deepEqual(Object.keys(post.body).sort(), ['authenticationConfiguration', 'displayName', 'targetUrl']);
  const placeholder = post.body.authenticationConfiguration;
  assert.equal(placeholder['@odata.type'], '#microsoft.graph.basicAuthentication');
  assert.match(placeholder.username, /^keel-placeholder-[0-9a-f]{12}$/);
  assert.ok(placeholder.password.length >= 40);

  const sent = JSON.stringify(graph.bodies);
  for (const secret of [...BACKED_UP_SECRETS, 'fixture-user']) assert.ok(!sent.includes(secret), `${secret} is never sent`);
  const logged = JSON.stringify([rollback.rows, result]);
  assert.ok(rollback.rows.length > 0, 'the write is journaled');
  for (const secret of [...BACKED_UP_SECRETS, placeholder.password]) assert.ok(!logged.includes(secret), 'no password in the journal or the result');

  assert.equal(credentialSteps(result.applied[0]).length, 1, 'setting the real password is a step');
  // A second run from the same backup finds it and creates nothing.
  const again = await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.equal(again.skipped.length + again.applied.length, 1);
  assert.equal(graph.bodies.filter((entry) => entry.method === 'POST').length, 1);
});

test('an approved update sends only the changed name or URL, never authentication, and still lists the credential step', async () => {
  const graph = recordingGraph();
  const live = {
    id: 'live-connector', displayName: 'KEEL-RT-connector', targetUrl: 'https://keel-rt.invalid/api/other',
    authenticationConfiguration: { '@odata.type': '#microsoft.graph.basicAuthentication', username: 'someone', password: '******' },
  };
  graph.objects.set(`${CONNECTORS}/live-connector`, live);
  const resource = connectorResource('update', {}, live);
  const held = await run(graph, [resource]);
  assert.deepEqual(graph.writes, [], 'held without the approval');
  assert.equal(held.applied.length, 0);

  const result = await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((entry) => [entry.method, entry.path, entry.body]), [
    ['PATCH', `${CONNECTORS}/live-connector`, { targetUrl: 'https://keel-rt.invalid/api/signup' }],
  ]);
  assert.equal(credentialSteps(result.applied[0]).length, 1);
});

test('a connector with the backup\'s name and another URL is left for a person, never duplicated', async () => {
  const graph = recordingGraph();
  graph.objects.set(`${CONNECTORS}/other`, { id: 'other', displayName: 'KEEL-RT-connector', targetUrl: 'https://keel-rt.invalid/api/other' });
  const resource = connectorResource('create');
  const result = await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.equal(result.applied.length, 0);
  assert.match(result.failed[0].error, /already exists with other access/);
  assert.deepEqual(graph.writes, []);
});

test('the connector writer never touches a user flow and never deletes a connector', async () => {
  const graph = recordingGraph();
  const resource = connectorResource('create');
  await run(graph, [resource], { approvedContentEffects: approvals(resource) });
  assert.ok(graph.bodies.every((entry) => entry.path.startsWith(CONNECTORS)), JSON.stringify(graph.bodies.map((entry) => entry.path)));

  const live = { id: 'live-connector', displayName: 'KEEL-RT-connector', targetUrl: 'https://keel-rt.invalid/api/signup' };
  graph.objects.set(`${CONNECTORS}/live-connector`, live);
  const writes = graph.writes.length;
  const deleted = await run(graph, [{ ...connectorResource('delete', {}, live) }]);
  assert.match(deleted.failed[0].error, /unsupported operation: identityApiConnector delete/);
  assert.equal(graph.writes.length, writes);
});
