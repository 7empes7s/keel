/**
 * Roadmap task-107 boundary tests: measured Entra operation expansion batches.
 *
 * Exercises engine/coverage/qualification.mjs's batch inventory, the
 * production applyWave() writer and verification path for the first
 * application/service-principal subset, cli/keel-restore.mjs's applied-id
 * bookkeeping and tools/qualification/operations.mjs's batch runner, against
 * fakes only. No tenant is read or written. Required mutation checks:
 *
 * - Enable all verbs for qualified type.
 * - Omit irrecoverable credential steps.
 * - Mark research-needed family fully restorable.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { fakeGraph, main as operationsMain, runExpansionBatch } from '../../tools/qualification/operations.mjs';
import { recordAppliedIds } from '../../cli/keel-restore.mjs';
import { OPERATIONS, capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import {
  EXPANSION_BATCHES, EXPANSION_INVENTORY, TYPE_DECISIONS, buildExpansionInventory, buildOperationLedger,
  qualificationFor, remappingFor, restoreScopeFor, withExplicitReferences,
} from '../coverage/qualification.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { completionItemsFor } from '../restore/completion.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const SECRET_FIELDS = ['passwordCredentials', 'keyCredentials'];

/** fakeGraph plus the body of every write, and an optional read-back override. */
function recordingGraph({ readOverride = null } = {}) {
  const graph = fakeGraph();
  const bodies = [];
  const write = graph.write.bind(graph);
  const read = graph.read.bind(graph);
  graph.write = async (version, path, request) => {
    bodies.push({ method: request.method, path, body: request.body });
    return write(version, path, request);
  };
  graph.read = async (version, path) => {
    const result = await read(version, path);
    return readOverride && result.ok ? { ...result, body: readOverride(result.body) } : result;
  };
  graph.bodies = bodies;
  return graph;
}

const snapshotApp = Object.freeze({
  displayName: 'Payroll connector',
  signInAudience: 'AzureADMyOrg',
  appId: 'source-appid',
  publisherDomain: 'source.example',
  tags: ['payroll'],
  requiredResourceAccess: [{ resourceAppId: '00000003-0000-0000-c000-000000000000', resourceAccess: [{ id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', type: 'Scope' }] }],
  passwordCredentials: [{ keyId: 'k1', displayName: 'prod secret', hint: 'Abc', secretText: null }],
  keyCredentials: [{ keyId: 'k2', type: 'AsymmetricX509Cert', usage: 'Verify', key: null }],
});

function appResource(verb, extra = {}) {
  return {
    naturalKey: 'application:source-appid', resourceType: 'application', verb, payload: snapshotApp,
    references: [], blastRadius: 'access-affecting', ...extra,
  };
}

const run = (graph, wave, options = {}) => applyWave(graph, governor, wave, {
  targetTenant: 'fixture', mode: 'enforce', ...options,
});

// ------------------------------------------------- inventory: every catalogue type

test('every catalogue type sits in exactly one expansion batch with an explicit status and reason', () => {
  const inventory = buildExpansionInventory();
  const seen = new Map();
  for (const batch of inventory.batches) {
    for (const entry of batch.types) {
      assert.ok(!seen.has(entry.resourceType), `${entry.resourceType} is in two batches`);
      seen.set(entry.resourceType, entry);
      assert.ok(entry.reason.length > 0 && entry.permission.length > 0, entry.resourceType);
    }
  }
  assert.equal(seen.size, CATALOG.length);
  for (const { type } of CATALOG) assert.ok(seen.has(type), `${type} is accounted for`);
  assert.deepEqual(inventory.batches.map((batch) => batch.id).slice(0, 3), ['identity-application', 'policy', 'administrative-configuration']);

  // The status follows the registry, never the other way round.
  for (const entry of seen.values()) {
    const registered = OPERATIONS.some((operation) => isSupportedClaim(capabilityFor(entry.resourceType, operation).claim));
    assert.equal(entry.status === 'qualified-subset', registered, entry.resourceType);
    if (entry.status === 'research-needed') {
      assert.equal(entry.restoreScope, 'none', `${entry.resourceType} is research-needed and restores nothing`);
      assert.ok(entry.api, `${entry.resourceType} names the route to investigate`);
    }
  }
  assert.equal(seen.get('application').batch, 'identity-application');
  // Roadmap task-109: the administrative unit is now a registered subset.
  assert.equal(seen.get('administrativeUnit').status, 'qualified-subset');
  // Roadmap task-151: the eligibility schedule is now a registered subset; the
  // active time-bound assignment schedule stays research-needed.
  assert.equal(seen.get('roleEligibilitySchedule').status, 'qualified-subset');
  assert.equal(seen.get('roleAssignmentSchedule').status, 'research-needed');
  assert.equal(seen.get('oauth2PermissionGrant').status, 'research-needed');
});

test('scopes are derived from registered operations only; no new family is fully restorable', () => {
  // group is the only type with every object operation registered (before task-107).
  assert.deepEqual(CATALOG.map(({ type }) => type).filter((type) => restoreScopeFor(type) === 'full'), ['group']);
  assert.equal(restoreScopeFor('application'), 'partial');
  assert.equal(restoreScopeFor('servicePrincipal'), 'partial');
  assert.equal(restoreScopeFor('administrativeUnit'), 'partial', 'task-109: update only');
  assert.equal(restoreScopeFor('roleEligibilitySchedule'), 'partial', 'task-151: create only');
  assert.equal(restoreScopeFor('roleAssignmentSchedule'), 'none');
  const unit = qualificationFor('roleAssignmentSchedule');
  assert.equal(unit.decision, 'unknown');
  assert.deepEqual({ status: unit.expansion.status, restoreScope: unit.expansion.restoreScope }, { status: 'research-needed', restoreScope: 'none' });
  assert.equal(qualificationFor('application').expansion.restoreScope, 'partial');
});

test('adversarial inventory edits are refused: a research-needed family cannot be marked restorable', () => {
  // Roadmap task-109 registered administrativeUnit and groupSetting, and
  // task-151 roleEligibilitySchedule; the research-needed examples are now
  // roleAssignmentSchedule and oauth2PermissionGrant.
  const asQualified = { ...EXPANSION_INVENTORY, roleAssignmentSchedule: { ...EXPANSION_INVENTORY.roleAssignmentSchedule, status: 'qualified-subset' } };
  assert.throws(() => buildExpansionInventory({ inventory: asQualified }), /roleAssignmentSchedule is marked qualified-subset but has no registered write capability/);
  const flagged = { ...EXPANSION_INVENTORY, oauth2PermissionGrant: { ...EXPANSION_INVENTORY.oauth2PermissionGrant, fullyRestorable: true } };
  assert.throws(() => buildExpansionInventory({ inventory: flagged }), /unrecognised fields fullyRestorable/);
  const { accessPackage: _omitted, ...missing } = EXPANSION_INVENTORY;
  assert.throws(() => buildExpansionInventory({ inventory: missing }), /no expansion batch entry for: accessPackage/);
  const demoted = { ...EXPANSION_INVENTORY, application: { ...EXPANSION_INVENTORY.application, status: 'research-needed' } };
  assert.throws(() => buildExpansionInventory({ inventory: demoted }), /application has a registered write capability but is marked research-needed/);
  const noRoute = { ...EXPANSION_INVENTORY, oauth2PermissionGrant: { ...EXPANSION_INVENTORY.oauth2PermissionGrant, api: null } };
  assert.throws(() => buildExpansionInventory({ inventory: noRoute }), /must name the API route/);
  const manualMismatch = { ...EXPANSION_INVENTORY, oauth2PermissionGrant: { ...EXPANSION_INVENTORY.oauth2PermissionGrant, status: 'manual' } };
  assert.throws(() => buildExpansionInventory({ inventory: manualMismatch }), /oauth2PermissionGrant is manual in its batch but unknown/);
  assert.throws(() => buildOperationLedger({ decisions: { ...TYPE_DECISIONS, roleAssignmentSchedule: { decision: 'automated', reason: 'x' } } }),
    /roleAssignmentSchedule is marked automated but has no registered write capability/);
});

// ------------------------------------------------- the qualified subset, through applyWave

test('only the qualified subset is enabled; every sibling verb stays refused before any write', async () => {
  assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor('application', operation).claim)),
    ['create', 'update', 'restore-soft-deleted']);
  assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor('servicePrincipal', operation).claim)), ['create']);
  for (const operation of ['create', 'update', 'restore-soft-deleted']) {
    const capability = capabilityFor('application', operation);
    assert.equal(capability.claim, 'fixture-tested');
    assert.equal(capability.proofRef, 'engine/roadmap/fidelity-expansion.test.mjs');
    assert.equal(capability.credentialMode, 'restorer');
  }

  const graph = recordingGraph();
  graph.objects.set('/applications/app-1', { ...snapshotApp, id: 'app-1' });
  const deleted = await run(graph, [appResource('delete', { targetId: 'app-1', live: { targetId: 'app-1', payload: { ...snapshotApp, id: 'app-1' } } })], {
    simulationPassed: true, deletionGuardOptions: { breakGlassUserIds: [], breakGlassGroupIds: [], keelAppIds: [], caPolicies: [] },
  });
  assert.match(deleted.failed[0]?.error ?? '', /unsupported operation: application delete/);
  for (const verb of ['update', 'delete', 'restore-soft-deleted']) {
    const refused = await run(graph, [{
      naturalKey: 'servicePrincipal:source-appid', resourceType: 'servicePrincipal', verb, targetId: 'sp-1', deletedItemId: 'sp-1',
      payload: { appId: 'source-appid', accountEnabled: false }, references: [], blastRadius: 'access-affecting',
    }]);
    assert.match(refused.failed[0]?.error ?? '', new RegExp(`unsupported operation: servicePrincipal ${verb}`));
  }
  assert.equal(graph.bodies.length, 0, 'a refused verb never reaches the writer');
  assert.ok(graph.objects.has('/applications/app-1'));
});

test('application create writes no credential or Entra-assigned field, verifies by read-back and reports the new appId', async () => {
  const graph = recordingGraph();
  const result = await run(graph, [appResource('create')]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  const [post] = graph.bodies;
  assert.equal(post.method, 'POST');
  assert.equal(post.path, '/applications');
  for (const field of [...SECRET_FIELDS, 'appId', 'publisherDomain']) assert.ok(!(field in post.body), `${field} is never sent on create`);
  assert.equal(post.body.displayName, 'Payroll connector');
  assert.deepEqual(post.body.requiredResourceAccess, snapshotApp.requiredResourceAccess);
  const { targetId, identifiers } = result.applied[0];
  assert.equal(graph.objects.get(`/applications/${targetId}`).appId, identifiers.appId);
  assert.notEqual(identifiers.appId, 'source-appid');
});

test('application create that does not verify is failed, never applied', async () => {
  const drifted = recordingGraph({ readOverride: (body) => ({ ...body, signInAudience: 'AzureADMultipleOrgs' }) });
  const result = await run(drifted, [appResource('create')]);
  assert.equal(result.applied.length, 0);
  assert.match(result.failed[0]?.error ?? '', /verification hash mismatch/);

  const otherAppId = recordingGraph({ readOverride: (body) => ({ ...body, appId: 'something-else' }) });
  const mismatch = await run(otherAppId, [appResource('create')]);
  assert.equal(mismatch.applied.length, 0);
  assert.match(mismatch.failed[0]?.error ?? '', /did not read back the identifiers/);
});

test('application update PATCHes configuration only and verifies; drifted credentials remain not remediable', async () => {
  const graph = recordingGraph();
  const live = { ...snapshotApp, id: 'app-1', appId: 'source-appid', displayName: 'Renamed', passwordCredentials: [] };
  graph.objects.set('/applications/app-1', live);
  const result = await run(graph, [appResource('update', { targetId: 'app-1', live: { targetId: 'app-1', payload: live } })]);
  const [patch] = graph.bodies;
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.path, '/applications/app-1');
  assert.equal(patch.body.displayName, 'Payroll connector');
  for (const field of [...SECRET_FIELDS, 'appId', 'publisherDomain']) assert.ok(!(field in patch.body), `${field} is never PATCHed`);
  // The deleted secret cannot be written back: the update verifies everything
  // else and reports the credential residual instead of claiming success.
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.notRemediable.map((entry) => entry.immutable), [['passwordCredentials']]);

  const clean = recordingGraph();
  clean.objects.set('/applications/app-2', { ...snapshotApp, id: 'app-2', displayName: 'Renamed' });
  const ok = await run(clean, [appResource('update', { targetId: 'app-2' })]);
  assert.deepEqual(ok.failed, []);
  assert.deepEqual(ok.applied, [{ naturalKey: 'application:source-appid', targetId: 'app-2' }]);
  assert.equal(clean.objects.get('/applications/app-2').displayName, 'Payroll connector');

  const residual = recordingGraph({ readOverride: (body) => ({ ...body, tags: ['tampered'] }) });
  residual.objects.set('/applications/app-3', { ...snapshotApp, id: 'app-3', displayName: 'Renamed' });
  const failed = await run(residual, [appResource('update', { targetId: 'app-3' })]);
  assert.match(failed.failed[0]?.error ?? '', /residual drift after update/);
});

test('application soft-delete restore keeps the object id and verifies the restored object', async () => {
  const graph = recordingGraph();
  graph.deleted.set('app-9', { path: '/applications/app-9', body: { ...snapshotApp, id: 'app-9' } });
  const result = await run(graph, [appResource('restore-soft-deleted', { targetId: 'app-9', deletedItemId: 'app-9' })]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [{ naturalKey: 'application:source-appid', targetId: 'app-9' }]);
  assert.deepEqual(graph.bodies.map((write) => `${write.method} ${write.path}`), ['POST /directory/deletedItems/app-9/restore']);
  assert.ok(graph.objects.has('/applications/app-9'));
});

// ------------------------------------------------- new ids remap explicit references

test('a service principal created after its application was recreated carries the new appId', async () => {
  const graph = recordingGraph();
  const appliedIds = new Map();
  const first = await run(graph, [appResource('create')], { appliedIds });
  assert.deepEqual(first.failed, []);
  recordAppliedIds(appliedIds, first.applied);
  const newAppId = first.applied[0].identifiers.appId;
  assert.equal(appliedIds.get('application:source-appid#appId'), newAppId);

  const sp = {
    naturalKey: 'servicePrincipal:source-appid', resourceType: 'servicePrincipal', verb: 'create',
    payload: { appId: 'source-appid', accountEnabled: true, appRoleAssignmentRequired: true, tags: [], servicePrincipalType: 'Application', appRoles: [] },
    references: [], blastRadius: 'access-affecting',
  };
  // The explicit reference is derived from the payload (the snapshot's GUID walk cannot see an appId).
  assert.deepEqual(withExplicitReferences(sp), [{ field: 'appId', symbol: 'application:source-appid', required: true, identifier: 'appId' }]);
  assert.equal(remappingFor('servicePrincipal', 'create').qualified, true);
  const second = await run(graph, [sp], { appliedIds });
  assert.deepEqual(second.failed, []);
  const post = graph.bodies.at(-1);
  assert.equal(post.path, '/servicePrincipals');
  assert.equal(post.body.appId, newAppId);
  for (const field of ['servicePrincipalType', 'appRoles']) assert.ok(!(field in post.body), `${field} is published by the application`);
});

test('an appId reference is never rewritten to an object id, and an unknown application refuses', async () => {
  const sp = (appId) => ({
    naturalKey: `servicePrincipal:${appId}`, resourceType: 'servicePrincipal', verb: 'create',
    payload: { appId, accountEnabled: true }, references: [], blastRadius: 'access-affecting',
  });
  // Same tenant: the application exists under the same natural key, so its appId is unchanged.
  const same = recordingGraph();
  const kept = await run(same, [sp('kept-appid')], { existingTargetIds: new Map([['application:kept-appid', 'app-object-id']]) });
  assert.deepEqual(kept.failed, []);
  assert.equal(same.bodies[0].body.appId, 'kept-appid');

  // Only an object id is known for the recreated application: refused, nothing written.
  const objectOnly = recordingGraph();
  const refused = await run(objectOnly, [sp('lost-appid')], { appliedIds: new Map([['application:lost-appid', 'new-object-id']]) });
  assert.match(refused.failed[0]?.error ?? '', /no appId known for application:lost-appid/);
  assert.equal(objectOnly.bodies.length, 0);
});

// ------------------------------------------------- credential completion and the batch runner

test('a recreated application always leaves its irrecoverable credential steps', () => {
  const steps = completionItemsFor({ resourceType: 'application', mechanism: 'recreate' });
  const requirements = steps.map((step) => `${step.kind}:${step.requirement}`);
  for (const required of ['credential:passwordCredentials', 'certificate:keyCredentials', 'consent:adminConsent', 'integration:newObjectId', 'service-validation:signIn']) {
    assert.ok(requirements.includes(required), `recreate must open ${required}`);
  }
  // A soft restore keeps the stored credentials; an update never removes them.
  assert.deepEqual(completionItemsFor({ resourceType: 'application', mechanism: 'soft-delete-restore' }).map((step) => step.kind), ['service-validation']);
  assert.deepEqual(completionItemsFor({ resourceType: 'application', mechanism: 'update-existing' }), []);
});

test('the identity batch runner drives every qualified operation through applyWave and reports what remains', async () => {
  const before = OPERATIONS.map((operation) => capabilityFor('application', operation).claim);
  const report = await runExpansionBatch('identity-application', { now: () => new Date('2026-10-03T00:00:00Z') });
  assert.deepEqual(OPERATIONS.map((operation) => capabilityFor('application', operation).claim), before);
  assert.equal(report.synthetic, true);
  assert.equal(report.claimsChanged, false);
  assert.equal(report.batch.task, 'task-107');
  assert.ok(report.operations.length > 0);
  for (const op of report.operations) assert.equal(op.result, 'passed', `${op.resourceType} ${op.operation}: ${op.detail}`);

  const create = report.operations.find((op) => op.resourceType === 'application' && op.operation === 'create');
  assert.deepEqual(create.writes, ['POST /applications']);
  const kinds = create.completionSteps.map((step) => step.kind);
  assert.ok(kinds.includes('credential') && kinds.includes('certificate'), 'the report lists the irrecoverable credential steps');
  const spCreate = report.operations.find((op) => op.resourceType === 'servicePrincipal' && op.operation === 'create');
  assert.deepEqual(spCreate.writes, ['POST /servicePrincipals']);
  // Roadmap task-150: a user is restored in place; create stays refused.
  assert.ok(report.operations.some((op) => op.resourceType === 'user' && op.operation === 'update' && op.result === 'passed'));
  assert.ok(report.refused.some((entry) => entry.resourceType === 'user' && entry.operation === 'create'));
  // Roadmap task-151: custom roles, eligibility create and PIM settings pass;
  // role delete and eligibility removal stay refused.
  for (const [type, operation, write] of [
    ['roleDefinition', 'create', 'POST /roleManagement/directory/roleDefinitions'],
    ['roleEligibilitySchedule', 'create', 'POST /roleManagement/directory/roleEligibilityScheduleRequests'],
    ['unifiedRoleManagementPolicy', 'update', 'PATCH /policies/roleManagementPolicies/fixture-existing/rules/Enablement_EndUser_Assignment'],
  ]) {
    const op = report.operations.find((entry) => entry.resourceType === type && entry.operation === operation);
    assert.equal(op?.result, 'passed', `${type} ${operation}`);
    assert.deepEqual(op.writes, [write]);
  }
  assert.ok(report.refused.some((entry) => entry.resourceType === 'roleDefinition' && entry.operation === 'delete'));
  assert.ok(report.refused.some((entry) => entry.resourceType === 'roleEligibilitySchedule' && entry.operation === 'delete'));

  assert.ok(report.refused.some((entry) => entry.resourceType === 'application' && entry.operation === 'delete' && entry.claim === 'unsupported'));
  const remaining = new Map(report.remaining.map((entry) => [entry.resourceType, entry]));
  for (const type of ['oauth2PermissionGrant', 'roleAssignmentSchedule', 'accessPackage']) {
    assert.ok(remaining.has(type), `${type} stays listed`);
    assert.equal(remaining.get(type).restoreScope, 'none');
    assert.ok(remaining.get(type).permission);
  }

  const policy = await runExpansionBatch('policy');
  assert.ok(policy.remaining.some((entry) => entry.resourceType === 'permissionGrantPolicy' && entry.status === 'research-needed'));
  await assert.rejects(() => runExpansionBatch('everything'), /unknown expansion batch/);
  assert.equal(EXPANSION_BATCHES.length, 4);
});

test('the CLI prints a batch report and its --check validates the inventory', async () => {
  const lines = [];
  const out = { log: (line) => lines.push(line), error: (line) => lines.push(`ERR ${line}`) };
  assert.equal(await operationsMain({ argv: ['--batch', 'identity-application'], out }), 0);
  const text = lines.join('\n');
  assert.match(text, /application create: passed/);
  assert.match(text, /then by hand: credential \(passwordCredentials\)/);
  assert.match(text, /application delete: refused \(unsupported\)/);
  lines.length = 0;
  assert.equal(await operationsMain({ argv: ['--check'], out }), 0);
  assert.match(lines.join('\n'), /each with an explicit decision and an expansion batch/);
  lines.length = 0;
  assert.equal(await operationsMain({ argv: ['--batch', 'nope'], out }), 1);
});
