/**
 * References that can never exist in the target tenant must not block a plan.
 *
 * On the live test tenant (2026-10) three updates could not be planned because
 * the planner treated every unresolved reference as fatal:
 *  - application: createdByAppId names the app that created the object. It is
 *    read-only, never written, and the app need not exist in the target.
 *  - crossTenantAccessPolicyPartner: tenantId is the partner's OWN tenant. It is
 *    foreign by definition and must be written verbatim.
 *  - deviceCompliancePolicy: the id of a scheduled action configuration is an
 *    Intune child id, assigned by the service on every create.
 *
 * Every test drives the production code (canonicalizeAll, resolvePlan,
 * planWaves, dependencyClosure, rewriteReferences, applyWave) against an
 * in-memory fake Graph whose target holds none of those ids. No tenant is read
 * or written. Required mutation checks:
 *
 * - Treat a readOnly: or foreignTenant: symbol as a target lookup.
 * - Rewrite a foreign tenant id to a target id.
 * - Count an Intune child id as an outbound reference.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { buildGapReport, isPlanClean } from '../graph/preflight.mjs';
import { resolvePlan, resolveSymbol } from '../graph/resolver.mjs';
import { applyWave, rewriteReferences } from './applyEngine.mjs';
import { INTUNE_RECORDS } from './intuneOperations.mjs';
import { dependencyClosure } from './selection.mjs';
import { planWaves } from './wavePlanner.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };

// None of these ids exists in the target tenant.
const UNKNOWN_APP = '7d3f9a10-5c2e-4b8a-9f1d-2e6c4a8b0d13';
const FOREIGN_TENANT = '9f1c0a7e-6b3d-4b8e-9d55-1c2b3a4d5e6f';
const RULE_ID = 'c1d2e3f4-0000-4000-8000-00000000aa01';
const ACTION_ID = 'c1d2e3f4-0000-4000-8000-00000000aa02';
const APP_ID = 'a0b1c2d3-0000-4000-8000-0000000000a1';

const application = Object.freeze({
  id: 'source-app-object', appId: APP_ID, displayName: 'Payroll connector', signInAudience: 'AzureADMyOrg',
  tags: ['payroll'], createdByAppId: UNKNOWN_APP,
});
const partner = Object.freeze({ tenantId: FOREIGN_TENANT, isServiceProvider: false, inboundTrust: { isMfaAccepted: true } });
const compliance = Object.freeze({
  '@odata.type': '#microsoft.graph.windows10CompliancePolicy',
  id: 'source-compliance', version: 7, displayName: 'Windows baseline', description: 'Require BitLocker', roleScopeTagIds: ['0'],
  passwordRequired: true, passwordMinimumLength: 12, bitLockerEnabled: true,
  scheduledActionsForRule: [{
    id: RULE_ID, ruleName: 'PasswordRequired',
    scheduledActionConfigurations: [
      { id: ACTION_ID, actionType: 'block', gracePeriodHours: 24, notificationTemplateId: '00000000-0000-0000-0000-000000000000', notificationMessageCCList: [] },
    ],
  }],
});
const collected = [
  ['application', [application]],
  ['crossTenantAccessPolicyPartner', [partner]],
  ['deviceCompliancePolicy', [compliance]],
];

const emptyTarget = () => ({ targetIndex: new Map(), mappingTable: new Map(), runProvenance: new Map() });
const byType = (resources, type) => resources.find((resource) => resource.resourceType === type);

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

const run = (graph, wave) => applyWave(graph, governor, wave, { targetTenant: 'fixture', mode: 'enforce' });

test('a read-only field, a foreign tenant id and an Intune child id are never target lookups', () => {
  const resources = canonicalizeAll(collected);
  assert.equal(resources.length, 3);
  assert.deepEqual(byType(resources, 'application').references.map((ref) => [ref.field, ref.symbol]),
    [['createdByAppId', `readOnly:${UNKNOWN_APP}`]]);
  assert.deepEqual(byType(resources, 'crossTenantAccessPolicyPartner').references.map((ref) => [ref.field, ref.symbol]),
    [['tenantId', `foreignTenant:${FOREIGN_TENANT}`]]);
  // A compliance policy's rule and action ids are its own identity, not references.
  assert.deepEqual(byType(resources, 'deviceCompliancePolicy').references, []);

  assert.deepEqual(resolveSymbol(`readOnly:${UNKNOWN_APP}`, emptyTarget()),
    { resolved: true, targetId: `readOnly:${UNKNOWN_APP}`, via: 'read-only' });
  assert.deepEqual(resolveSymbol(`foreignTenant:${FOREIGN_TENANT}`, emptyTarget()),
    { resolved: true, targetId: `foreignTenant:${FOREIGN_TENANT}`, via: 'foreign-tenant' });
});

test('the plan is clean against a target that holds none of those ids, with no dependency edge or deferred patch', () => {
  const resources = canonicalizeAll(collected);
  const { unresolved } = resolvePlan(resources, emptyTarget());
  assert.deepEqual(unresolved, []);
  assert.ok(isPlanClean(buildGapReport({ resources, unresolved })));

  const { waves, patches } = planWaves(resources);
  assert.deepEqual(patches, []);
  assert.equal(waves.flat().length, 3);

  const closure = dependencyClosure(resources, resources.map((resource) => resource.naturalKey));
  assert.deepEqual(closure.unresolvedReferences, []);
  assert.deepEqual(closure.added, []);
});

test('rewriteReferences leaves a verbatim value alone and skips a server-owned field', () => {
  const resources = canonicalizeAll(collected);
  const partnerResource = byType(resources, 'crossTenantAccessPolicyPartner');
  const rewritten = rewriteReferences(partnerResource.payload, partnerResource.references, emptyTarget(), partnerResource.naturalKey, 'crossTenantAccessPolicyPartner');
  assert.equal(rewritten.tenantId, FOREIGN_TENANT, 'a foreign tenant id is written verbatim');

  // A backup taken before the child ids were classed as identity still carries
  // this reference; the field is server-owned, so it cannot block the policy.
  const childId = [{ field: 'scheduledActionsForRule[0].scheduledActionConfigurations[0].id', symbol: null, required: true }];
  assert.equal(rewriteReferences(compliance, childId, emptyTarget(), 'deviceCompliancePolicy:Windows baseline', 'deviceCompliancePolicy'), compliance);
  // Without the type, the reference is still fatal: a dangling id is never written blind.
  assert.throws(() => rewriteReferences(compliance, childId, emptyTarget(), 'deviceCompliancePolicy:Windows baseline'), /cannot resolve reference/);
});

test('application update: createdByAppId never reaches the body and the update succeeds', async () => {
  const resource = byType(canonicalizeAll(collected), 'application');
  const graph = recordingGraph();
  const live = { ...application, id: 'app-1', displayName: 'Renamed' };
  graph.objects.set('/applications/app-1', live);
  const outcome = await run(graph, [{ ...resource, verb: 'update', targetId: 'app-1', live: { targetId: 'app-1', payload: live }, blastRadius: 'access-affecting' }]);
  assert.deepEqual(outcome.failed, []);
  assert.equal(outcome.applied.length, 1);
  const [patch] = graph.bodies;
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.body.displayName, 'Payroll connector');
  assert.ok(!('createdByAppId' in patch.body), 'createdByAppId is never written');
  assert.ok(!JSON.stringify(graph.bodies).includes(UNKNOWN_APP));
});

test('application create: createdByAppId never reaches the body, which Graph refuses (Q48)', async () => {
  const resource = byType(canonicalizeAll(collected), 'application');
  const graph = recordingGraph();
  const outcome = await run(graph, [{ ...resource, verb: 'create', blastRadius: 'access-affecting' }]);
  assert.deepEqual(outcome.failed, []);
  assert.equal(outcome.applied.length, 1);
  const [post] = graph.bodies;
  assert.equal(post.method, 'POST');
  assert.equal(post.path, '/applications');
  assert.equal(post.body.displayName, 'Payroll connector');
  assert.ok(!('createdByAppId' in post.body), 'createdByAppId is never written');
  assert.ok(!JSON.stringify(graph.bodies).includes(UNKNOWN_APP));
});

test('partner create and update carry the foreign tenant id verbatim', async () => {
  const resource = byType(canonicalizeAll(collected), 'crossTenantAccessPolicyPartner');
  let graph = recordingGraph();
  let outcome = await run(graph, [{ ...resource, verb: 'create', blastRadius: 'access-affecting' }]);
  assert.deepEqual(outcome.failed, []);
  assert.equal(graph.bodies[0].method, 'POST');
  assert.equal(graph.bodies[0].body.tenantId, FOREIGN_TENANT);

  graph = recordingGraph();
  const path = `/policies/crossTenantAccessPolicy/partners/${FOREIGN_TENANT}`;
  const live = { ...partner, inboundTrust: { isMfaAccepted: false } };
  graph.objects.set(path, live);
  outcome = await run(graph, [{
    ...resource, verb: 'update', targetId: FOREIGN_TENANT, blastRadius: 'access-affecting',
    live: { state: 'present', targetId: FOREIGN_TENANT, payload: live },
  }]);
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path, body: { inboundTrust: { isMfaAccepted: true } } }]);
});

test('compliance policy update: the backup child ids are never written and the update succeeds', async () => {
  const resource = byType(canonicalizeAll(collected), 'deviceCompliancePolicy');
  const graph = recordingGraph();
  const targetId = 'target-policy';
  const live = {
    ...compliance, id: targetId,
    scheduledActionsForRule: [{
      ...compliance.scheduledActionsForRule[0], id: 'd4e5f6a7-0000-4000-8000-00000000bb01',
      scheduledActionConfigurations: [{ ...compliance.scheduledActionsForRule[0].scheduledActionConfigurations[0], id: 'd4e5f6a7-0000-4000-8000-00000000bb02', gracePeriodHours: 720 }],
    }],
  };
  graph.objects.set(`${INTUNE_RECORDS.deviceCompliancePolicy.collection}/${targetId}`, live);
  const outcome = await run(graph, [{
    ...resource, verb: 'update', targetId, blastRadius: 'access-affecting', live: { state: 'present', targetId, payload: live },
  }]);
  assert.deepEqual(outcome.failed, []);
  assert.equal(outcome.applied.length, 1);
  const actions = graph.bodies.find((write) => write.path.endsWith('/scheduleActionsForRules'));
  assert.ok(actions, 'the changed action is rewritten');
  assert.equal(actions.body.deviceComplianceScheduledActionForRules[0].scheduledActionConfigurations[0].gracePeriodHours, 24);
  const text = JSON.stringify(graph.bodies);
  assert.ok(!text.includes(RULE_ID) && !text.includes(ACTION_ID), 'a backup child id is never written');
});
