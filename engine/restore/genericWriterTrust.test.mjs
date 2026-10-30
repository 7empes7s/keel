/**
 * The trust-field rule (CLAUDE.md restore writers) for the generic Entra writer:
 * applyEngine.mjs's built-in create, update and restore paths, whose bodies come
 * from reconcile/writableProjection.mjs. A trust, certificate or sign-in field
 * (an application's signInAudience, a named location's isTrusted, a token
 * signing key) is never sent, a write is verified only on what it sent, and a
 * difference in one becomes a step for a person. Everything runs against the
 * in-memory Graph of tools/qualification/operations.mjs; no tenant is touched.
 * Fixture names use the KEEL-RT- prefix.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import {
  createBodyProjection, createProjection, trustFieldsOf, verificationView, writableProjection,
} from '../reconcile/writableProjection.mjs';
import { applyWave } from './applyEngine.mjs';
import { recreateBody } from './bestEffortRecreate.mjs';
import { isTrustField } from './workloads/writeDeclarations.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };

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

const app = Object.freeze({
  displayName: 'KEEL-RT-Trust app',
  signInAudience: 'AzureADMultipleOrgs',
  tags: ['keel-rt'],
});

const appResource = (verb, extra = {}) => ({
  naturalKey: 'application:KEEL-RT-Trust app', resourceType: 'application', verb, payload: app,
  references: [], blastRadius: 'access-affecting', ...extra,
});

const run = (graph, wave, options = {}) => applyWave(graph, governor, wave, { targetTenant: 'fixture', mode: 'enforce', ...options });

const trustSteps = (entry) => (entry?.completion ?? []).filter((step) => step.requirement === 'trustFields');
const sentTrust = (body, resourceType) => Object.keys(body ?? {}).filter((field) => isTrustField(resourceType, field));

test('every generic write body leaves out top-level trust fields', () => {
  const payload = {
    ...app, preferredTokenSigningKeyThumbprint: 'ABC123', '@odata.type': '#microsoft.graph.application',
  };
  assert.deepEqual(trustFieldsOf(payload, 'application').sort(), ['preferredTokenSigningKeyThumbprint', 'signInAudience']);
  assert.deepEqual(sentTrust(writableProjection(payload, 'application'), 'application'), []);
  assert.deepEqual(sentTrust(createBodyProjection(payload, 'application'), 'application'), []);
  assert.deepEqual(sentTrust(verificationView(payload, 'application'), 'application'), []);
  assert.equal(writableProjection(payload, 'application').displayName, 'KEEL-RT-Trust app');
  assert.equal(createBodyProjection(payload, 'application')['@odata.type'], '#microsoft.graph.application');

  const location = { displayName: 'KEEL-RT-Office', isTrusted: true, ipRanges: [] };
  assert.equal('isTrusted' in writableProjection(location, 'namedLocation'), false);
  assert.equal('isTrusted' in createBodyProjection(location, 'namedLocation'), false);
  // An approved compliance fix names the one setting it may change.
  assert.equal(writableProjection(location, 'namedLocation', { keepTrust: ['isTrusted'] }).isTrusted, true);
  assert.equal(verificationView(location, 'namedLocation', { keepTrust: ['isTrusted'] }).isTrusted, true);

  const { body } = createProjection(payload, 'application');
  assert.deepEqual(sentTrust(body, 'application'), []);
  assert.equal(body.displayName, 'KEEL-RT-Trust app');
});

test('an application create never sends signInAudience and lists it for a person', async () => {
  const graph = recordingGraph();
  const result = await run(graph, [appResource('create')]);
  assert.deepEqual(result.failed, []);
  const [post] = graph.bodies;
  assert.equal(post.method, 'POST');
  assert.deepEqual(sentTrust(post.body, 'application'), []);
  assert.equal(post.body.displayName, 'KEEL-RT-Trust app');
  assert.deepEqual(trustSteps(result.applied[0]).map((step) => step.fields), [['signInAudience']]);
  assert.equal(trustSteps(result.applied[0])[0].kind, 'manual-setting');

  const preview = await run(recordingGraph(), [appResource('create')], { mode: 'dry-run' });
  assert.deepEqual(trustSteps(preview.applied[0]).map((step) => step.fields), [['signInAudience']]);
});

test('a created object that already holds the backup value needs no step', async () => {
  const graph = recordingGraph();
  const write = graph.write;
  // Graph sets the audience on its own (here: to the backup's value).
  graph.write = async (version, path, request) => {
    const result = await write(version, path, request);
    if (request.method === 'POST' && result.ok) graph.objects.set(`${path}/${result.body.id}`, { ...graph.objects.get(`${path}/${result.body.id}`), signInAudience: app.signInAudience });
    return result;
  };
  const result = await run(graph, [appResource('create')]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(trustSteps(result.applied[0]), []);
});

test('an application update never PATCHes signInAudience, verifies the rest and lists it for a person', async () => {
  const graph = recordingGraph();
  const live = { ...app, id: 'app-1', displayName: 'KEEL-RT-Renamed', signInAudience: 'AzureADMyOrg' };
  graph.objects.set('/applications/app-1', live);
  const result = await run(graph, [appResource('update', { targetId: 'app-1', live: { targetId: 'app-1', payload: live } })]);
  assert.deepEqual(result.failed, []);
  const [patch] = graph.bodies;
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.body.displayName, 'KEEL-RT-Trust app');
  assert.deepEqual(sentTrust(patch.body, 'application'), []);
  assert.equal(graph.objects.get('/applications/app-1').signInAudience, 'AzureADMyOrg', 'the live audience is kept');
  assert.equal(result.applied.length, 1);
  assert.deepEqual(trustSteps(result.applied[0]).map((step) => step.fields), [['signInAudience']]);

  const preview = await run(recordingGraph(), [appResource('update', { targetId: 'app-1', live: { targetId: 'app-1', payload: live } })], { mode: 'dry-run' });
  assert.deepEqual(trustSteps(preview.applied[0]).map((step) => step.fields), [['signInAudience']]);
});

test('an update that differs only in a trust field writes nothing and lists it', async () => {
  const graph = recordingGraph();
  const live = { ...app, id: 'app-2', signInAudience: 'AzureADMyOrg' };
  graph.objects.set('/applications/app-2', live);
  const result = await run(graph, [appResource('update', { targetId: 'app-2', live: { targetId: 'app-2', payload: live } })]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, []);
  assert.equal(result.applied[0].unchanged, true);
  assert.deepEqual(trustSteps(result.applied[0]).map((step) => step.fields), [['signInAudience']]);

  const same = recordingGraph();
  same.objects.set('/applications/app-3', { ...app, id: 'app-3' });
  const equal = await run(same, [appResource('update', { targetId: 'app-3', live: { targetId: 'app-3', payload: { ...app, id: 'app-3' } } })]);
  assert.deepEqual(trustSteps(equal.applied[0]), [], 'no step when live already holds the backup value');
});

test('a soft-deleted application restore never PATCHes signInAudience and lists a difference', async () => {
  const graph = recordingGraph();
  graph.deleted.set('app-9', { path: '/applications/app-9', body: { ...app, id: 'app-9', tags: [], signInAudience: 'AzureADMyOrg' } });
  const result = await run(graph, [appResource('restore-soft-deleted', { targetId: 'app-9', deletedItemId: 'app-9' })]);
  assert.deepEqual(result.failed, []);
  const patch = graph.bodies.find((write) => write.method === 'PATCH');
  assert.ok(patch, 'the follow-up PATCH puts the tags back');
  assert.deepEqual(patch.body.tags, ['keel-rt']);
  assert.deepEqual(sentTrust(patch.body, 'application'), []);
  assert.equal(graph.objects.get('/applications/app-9').signInAudience, 'AzureADMyOrg');
  assert.deepEqual(trustSteps(result.applied[0]).map((step) => step.fields), [['signInAudience']]);
});

test('a recreate-by-hand step still shows the backed-up trust values to a person', () => {
  const values = recreateBody('crossTenantAccessPolicyPartner', {
    id: 'partner-1', tenantId: '00000000-0000-0000-0000-00000000aaaa', inboundTrust: { isMfaAccepted: true },
  });
  assert.deepEqual(values.inboundTrust, { isMfaAccepted: true });
  assert.equal('id' in values, false);
  const location = recreateBody('namedLocation', { displayName: 'KEEL-RT-Office', isTrusted: true });
  assert.equal(location.isTrusted, true);
});
