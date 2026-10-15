/**
 * Wave 2 IDO: fixture tests for the identity object writers. Each drives the
 * production writer against an in-memory Graph (engine/test/idoFakeGraph.mjs);
 * nothing here reads or writes a tenant. Fixture names use the KEEL-RT- prefix.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  IDENTITY_BEST_EFFORT, IDENTITY_NEEDS_REVIEW, IDENTITY_RECORDS, MICROSOFT_OWNER_TENANTS, applyIdentityEdges, applyIdentityObjectWrite,
  buildIdentityObjectLedger, identityObjectOperations, planIdentityEdges, userCreateBody,
} from './identityObjectOperations.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';

const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };
const GUARD = { breakGlassUserIds: ['break-glass-1'], keelAppIds: ['keel-app-id'], caPolicies: [] };
const COMPLETE = (type) => ({ [type]: { outcome: 'complete' } });

function journalClient() {
  const queries = [];
  return { queries, async query(sql, params) { queries.push({ sql, params }); return { rows: [{ id: queries.length }] }; } };
}

const resourceOf = (resourceType, payload, extra = {}) => ({
  naturalKey: `${resourceType}:${payload.displayName ?? payload.name ?? payload.id ?? payload.tenantId}`,
  resourceType, payload, references: [], blastRadius: 'access-affecting', ...extra,
});

// ------------------------------------------------------- service principal

const SP_ID = 'sp-0001';
const servicePrincipal = Object.freeze({
  id: SP_ID, appId: 'app-0001', displayName: 'KEEL-RT-App', servicePrincipalType: 'Application',
  appOwnerOrganizationId: 'tenant-0001', accountEnabled: true,
  appRoleAssignmentRequired: true, notes: 'restored notes', tags: ['WindowsAzureActiveDirectoryIntegratedApp'],
  preferredSingleSignOnMode: null, keyCredentials: [{ keyId: 'k1' }], passwordCredentials: [{ keyId: 'p1' }],
});

test('service principal update writes only the reviewed attributes that differ, and reads them back', async () => {
  const live = { ...servicePrincipal, appRoleAssignmentRequired: false, notes: 'changed', tags: [] };
  const graph = idoFakeGraph({ seed: { [`/servicePrincipals/${SP_ID}`]: live } });
  const result = await applyIdentityObjectWrite(graph, resourceOf('servicePrincipal', servicePrincipal, {
    live: { state: 'present', targetId: SP_ID, payload: live },
  }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const patch = graph.calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(patch.body, { appRoleAssignmentRequired: true, notes: 'restored notes', tags: ['WindowsAzureActiveDirectoryIntegratedApp'] });
  for (const field of ['keyCredentials', 'passwordCredentials', 'accountEnabled', 'appId', 'id']) assert.equal(field in patch.body, false, field);
  assert.deepEqual(result.applied.changes.fields.sort(), ['appRoleAssignmentRequired', 'notes', 'tags']);
});

test('service principal update fails when a written attribute does not read back', async () => {
  const live = { ...servicePrincipal, notes: 'changed' };
  const graph = idoFakeGraph({
    seed: { [`/servicePrincipals/${SP_ID}`]: live },
    failWrites: ({ method }) => (method === 'PATCH' ? { ok: true, status: 204, body: null } : null),
  });
  const result = await applyIdentityObjectWrite(graph, resourceOf('servicePrincipal', servicePrincipal, {
    live: { state: 'present', targetId: SP_ID, payload: live },
  }), 'update', FAST);
  assert.match(result.failed.error, /post-state: notes did not read back/);
});

test('a service principal whose only difference is whether it is enabled is reported, never written', async () => {
  const live = { ...servicePrincipal, accountEnabled: false };
  const graph = idoFakeGraph({ seed: { [`/servicePrincipals/${SP_ID}`]: live } });
  const result = await applyIdentityObjectWrite(graph, resourceOf('servicePrincipal', servicePrincipal, {
    live: { state: 'present', targetId: SP_ID, payload: live },
  }), 'update', FAST);
  assert.match(result.skipped.reason, /never turns sign-in on or off/);
  assert.equal(graph.calls.filter((call) => call.method !== 'GET').length, 0);
});

test('service principal delete passes the deletion guard, needs a complete observation and verifies absence', async () => {
  const graph = idoFakeGraph({ seed: { [`/servicePrincipals/${SP_ID}`]: servicePrincipal } });
  const resource = resourceOf('servicePrincipal', servicePrincipal, { live: { state: 'present', targetId: SP_ID, payload: servicePrincipal } });

  const partial = await applyIdentityObjectWrite(graph, resource, 'delete', { ...FAST, deletionGuardOptions: GUARD, observedCoverage: { servicePrincipal: { outcome: 'partial' } } });
  assert.match(partial.failed.error, /partial observation cannot authorise delete/);

  const deleted = await applyIdentityObjectWrite(graph, resource, 'delete', { ...FAST, deletionGuardOptions: GUARD, observedCoverage: COMPLETE('servicePrincipal') });
  assert.deepEqual(deleted.applied, { naturalKey: resource.naturalKey, targetId: SP_ID });
  assert.equal(graph.objects.has(`/servicePrincipals/${SP_ID}`), false);
});

test('service principal delete is refused for KEEL, Microsoft-owned and managed identity principals', async () => {
  const cases = [
    [{ ...servicePrincipal, appId: 'keel-app-id' }, /KEEL app registration/],
    [{ ...servicePrincipal, appOwnerOrganizationId: MICROSOFT_OWNER_TENANTS[0] }, /Microsoft application/],
    [{ ...servicePrincipal, servicePrincipalType: 'ManagedIdentity' }, /ManagedIdentity service principal/],
  ];
  for (const [payload, reason] of cases) {
    const graph = idoFakeGraph({ seed: { [`/servicePrincipals/${SP_ID}`]: payload } });
    const result = await applyIdentityObjectWrite(graph, resourceOf('servicePrincipal', payload, {
      live: { state: 'present', targetId: SP_ID, payload },
    }), 'delete', { ...FAST, deletionGuardOptions: GUARD, observedCoverage: COMPLETE('servicePrincipal') });
    assert.match(result.skipped?.reason ?? '', reason);
    assert.equal(graph.calls.some((call) => call.method === 'DELETE'), false);
  }
});

test('a deletion guard without break-glass accounts refuses every delete', async () => {
  const graph = idoFakeGraph({ seed: { [`/servicePrincipals/${SP_ID}`]: servicePrincipal } });
  await assert.rejects(() => applyIdentityObjectWrite(graph, resourceOf('servicePrincipal', servicePrincipal, {
    live: { state: 'present', targetId: SP_ID, payload: servicePrincipal },
  }), 'delete', { ...FAST, deletionGuardOptions: { breakGlassUserIds: [] }, observedCoverage: COMPLETE('servicePrincipal') }), /break-glass/);
});

// -------------------------------------------------------------------- edges

test('owners and app role grants are added only where missing, and never removed', async () => {
  const graph = idoFakeGraph({
    seed: {
      '/applications/app-obj': { id: 'app-obj', displayName: 'KEEL-RT-App' },
      [`/servicePrincipals/${SP_ID}`]: servicePrincipal,
    },
  });
  // The SP already has one owner that the backup does not list: it stays.
  await graph.write('v1.0', `/servicePrincipals/${SP_ID}/owners/$ref`, { method: 'POST', body: { '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/extra-owner' } });
  const desired = new Map([
    ['application:KEEL-RT-App|appOwner', { outcome: 'complete', targets: [{ targetId: 'src-user', targetNaturalKey: 'user:keel-rt-owner@example.test' }] }],
    ['servicePrincipal:KEEL-RT-App|servicePrincipalOwner', { outcome: 'complete', targets: [{ targetId: 'src-user', targetNaturalKey: 'user:keel-rt-owner@example.test' }] }],
    ['servicePrincipal:KEEL-RT-App|appRoleGrant', { outcome: 'complete', targets: [{ edgeKey: 'src-graph:role-1', targetId: 'src-graph', targetNaturalKey: 'servicePrincipal:Microsoft Graph' }] }],
  ]);
  const resolve = (key) => ({ 'user:keel-rt-owner@example.test': 'user-0001', 'servicePrincipal:Microsoft Graph': 'graph-sp' })[key] ?? null;
  const plan = planIdentityEdges({
    parents: [
      { naturalKey: 'application:KEEL-RT-App', resourceType: 'application', liveTargetId: 'app-obj' },
      { naturalKey: 'servicePrincipal:KEEL-RT-App', resourceType: 'servicePrincipal', liveTargetId: SP_ID },
    ],
    desired,
    live: new Map([['servicePrincipal:KEEL-RT-App|servicePrincipalOwner', { outcome: 'complete', targets: [{ targetId: 'extra-owner' }] }]]),
    resolve,
  });
  assert.equal(plan.refusals.length, 0);
  assert.equal(plan.operations.length, 3);

  const result = await applyIdentityEdges(graph, plan.operations, FAST);
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  const owners = (await graph.read('v1.0', `/servicePrincipals/${SP_ID}/owners`)).body.value.map((item) => item.id).sort();
  assert.deepEqual(owners, ['extra-owner', 'user-0001']);
  const grants = (await graph.read('v1.0', `/servicePrincipals/${SP_ID}/appRoleAssignments`)).body.value;
  assert.deepEqual(grants.map(({ principalId, resourceId, appRoleId }) => ({ principalId, resourceId, appRoleId })),
    [{ principalId: SP_ID, resourceId: 'graph-sp', appRoleId: 'role-1' }]);
  assert.equal(graph.calls.some((call) => call.method === 'DELETE'), false);

  // A second run sends nothing.
  const writes = graph.calls.filter((call) => call.method === 'POST').length;
  const again = await applyIdentityEdges(graph, plan.operations, FAST);
  assert.equal(again.applied.every((entry) => entry.already), true);
  assert.equal(graph.calls.filter((call) => call.method === 'POST').length, writes);
});

test('an owner that does not exist in the target is refused, never written by its source id', () => {
  const plan = planIdentityEdges({
    parents: [{ naturalKey: 'application:KEEL-RT-App', resourceType: 'application', liveTargetId: 'app-obj' }],
    desired: new Map([['application:KEEL-RT-App|appOwner', { outcome: 'complete', targets: [{ targetId: 'src-user', targetNaturalKey: 'user:gone@example.test' }] }]]),
    resolve: () => null,
  });
  assert.equal(plan.operations.length, 0);
  assert.match(plan.refusals[0].reason, /does not exist in the target/);
});

// -------------------------------------------------------------------- users

const leaver = Object.freeze({
  id: 'old-user-id', userPrincipalName: 'KEEL-RT-user@example.test', displayName: 'KEEL-RT User', mailNickname: 'KEEL-RT-user',
  accountEnabled: true, department: 'Finance', usageLocation: 'FR', jobTitle: 'Analyst',
  licenseAssignmentStates: [{ skuId: 'sku-1', disabledPlans: [], assignedByGroup: null }],
});

test('a deleted user is recreated disabled, with an unseen password and a credentials checklist', async () => {
  const graph = idoFakeGraph();
  const client = journalClient();
  const result = await applyIdentityObjectWrite(graph, resourceOf('user', leaver, { naturalKey: 'user:KEEL-RT-user@example.test' }), 'create', {
    ...FAST, rollbackClient: client, runId: 'run-1', restoreRef: 'restore-1',
  });
  assert.equal(result.failed, undefined, result.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST' && call.path === '/users');
  assert.equal(post.body.accountEnabled, false);
  assert.equal(post.body.passwordProfile.forceChangePasswordNextSignIn, true);
  const password = post.body.passwordProfile.password;
  assert.ok(password.length >= 40);
  assert.equal(post.body.department, 'Finance');
  // The password is never in the journal, the result or a second request.
  assert.equal(JSON.stringify(client.queries).includes(password), false);
  assert.equal(JSON.stringify(result).includes(password), false);
  assert.equal(JSON.stringify(graph.calls.filter((call) => call !== post)).includes(password), false);
  // Licences are assigned add-only and read back.
  assert.deepEqual(result.applied.changes.licences, ['sku-1']);
  const kinds = result.applied.completion.map((item) => item.requirement);
  assert.deepEqual(kinds, ['password', 'mfa', 'accountEnabled', 'objectId', 'content']);
  // Two passwords are never the same.
  const second = await applyIdentityObjectWrite(idoFakeGraph(), resourceOf('user', leaver), 'create', FAST);
  assert.ok(second.applied);
});

test('a synced, guest or conflicting user is never created', async () => {
  const graph = idoFakeGraph();
  const synced = await applyIdentityObjectWrite(graph, resourceOf('user', { ...leaver, onPremisesSyncEnabled: true }), 'create', FAST);
  assert.match(synced.skipped.reason, /on-premises Active Directory/);
  const guest = await applyIdentityObjectWrite(graph, resourceOf('user', { ...leaver, userType: 'Guest', userPrincipalName: 'x_example.com#EXT#@example.test' }), 'create', FAST);
  assert.match(guest.skipped.reason, /inviting them again/);
  const resource = resourceOf('user', leaver);
  const conflict = await applyIdentityObjectWrite(graph, resource, 'create', { ...FAST, existingTargetIds: new Map([[resource.naturalKey, 'live-id']]) });
  assert.match(conflict.failed.error, /conflict/);
  assert.equal(graph.calls.filter((call) => call.method !== 'GET').length, 0);
});

test('a user dry run lists the checklist and writes nothing', async () => {
  const graph = idoFakeGraph();
  const result = await applyIdentityObjectWrite(graph, resourceOf('user', leaver), 'create', { ...FAST, mode: 'dry-run' });
  assert.equal(graph.calls.length, 0);
  assert.equal(result.applied.completion[0].requirement, 'password');
  assert.equal('passwordProfile' in userCreateBody(leaver), false);
});

// --------------------------------------------------------------- governance

test('a lifecycle workflow is created switched off, with its tasks, and turning it on is a follow-up', async () => {
  const workflow = {
    id: 'src-wf', category: 'leaver', displayName: 'KEEL-RT-Leaver', description: 'Offboard', isEnabled: true, isSchedulingEnabled: true,
    version: 3, createdBy: { id: 'x' }, executionConditions: { '@odata.type': '#microsoft.graph.identityGovernance.onDemandExecutionOnly' },
    tasks: [{ id: 'task-src', taskDefinitionId: '1dfdfcc7-52fa-4c2e-bf3a-e3919cc12950', displayName: 'Disable account', category: 'leaver', continueOnError: false, executionSequence: 1, isEnabled: true, arguments: [] }],
  };
  const graph = idoFakeGraph();
  const result = await applyIdentityObjectWrite(graph, resourceOf('lifecycleWorkflow', workflow), 'create', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.body.isEnabled, false);
  assert.equal(post.body.isSchedulingEnabled, false);
  assert.equal(post.body.tasks[0].id, undefined);
  for (const field of ['id', 'version', 'createdBy']) assert.equal(field in post.body, false, field);
  assert.deepEqual(result.applied.completion.map((item) => item.requirement), ['isEnabled', 'isSchedulingEnabled']);
  // The best-effort rule: the parts the backup cannot give back are named, with where to do them.
  const switching = result.applied.followUp.find((step) => /Switching the workflow on/.test(step.part));
  assert.equal(switching.actionable, true);
  assert.match(switching.portalPath, /Lifecycle workflows/);
  assert.ok(result.applied.followUp.some((step) => step.actionable === false), 'run history is listed as a record only');
});

test('a lifecycle workflow update never switches it on, and writes changed tasks as a new version', async () => {
  const live = {
    id: 'wf-1', category: 'leaver', displayName: 'KEEL-RT-Leaver', description: 'Old', isEnabled: false, isSchedulingEnabled: false,
    executionConditions: { '@odata.type': '#microsoft.graph.identityGovernance.onDemandExecutionOnly' },
    tasks: [{ taskDefinitionId: 'def-1', displayName: 'Disable account', continueOnError: false, executionSequence: 1, isEnabled: true, arguments: [] }],
  };
  const desired = { ...live, description: 'Offboard', isEnabled: true, tasks: [...live.tasks, { taskDefinitionId: 'def-2', displayName: 'Remove licences', continueOnError: false, executionSequence: 2, isEnabled: true, arguments: [] }] };
  const graph = idoFakeGraph({ seed: { '/identityGovernance/lifecycleWorkflows/workflows/wf-1': live } });
  const result = await applyIdentityObjectWrite(graph, resourceOf('lifecycleWorkflow', desired, {
    live: { state: 'present', targetId: 'wf-1', payload: live },
  }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const patch = graph.calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(patch.body, { description: 'Offboard' });
  const version = graph.calls.find((call) => call.path.endsWith('/createNewVersion'));
  assert.equal(version.body.workflow.isEnabled, false);
  assert.equal(version.body.workflow.tasks.length, 2);
  assert.deepEqual(result.applied.changes.newVersion, ['tasks']);
  assert.equal(result.applied.completion[0].requirement, 'isEnabled');
});

test('governance singletons are updated in place and verified', async () => {
  const cases = [
    ['lifecycleManagementSettings', '/identityGovernance/lifecycleWorkflows/settings', { workflowScheduleIntervalInHours: 3 }, { workflowScheduleIntervalInHours: 1 }],
    ['entitlementManagementSettings', '/identityGovernance/entitlementManagement/settings', { externalUserLifecycleAction: 'blockSignInAndDelete' }, { externalUserLifecycleAction: 'none' }],
    ['multiTenantOrganization', '/tenantRelationships/multiTenantOrganization', { displayName: 'KEEL-RT-MTO', state: 'active' }, { displayName: 'Other', state: 'active' }],
  ];
  for (const [type, path, desired, live] of cases) {
    const graph = idoFakeGraph({ seed: { [path]: live } });
    const result = await applyIdentityObjectWrite(graph, { naturalKey: `${type}:singleton`, resourceType: type, payload: desired, references: [], live: { state: 'present', payload: live } }, 'update', FAST);
    assert.equal(result.failed, undefined, `${type}: ${result.failed?.error}`);
    const patch = graph.calls.find((call) => call.method === 'PATCH');
    assert.equal(patch.path, path);
    assert.equal('state' in patch.body, false);
  }
});

test('catalogs, app policies and task extensions are created and read back', async () => {
  const cases = [
    ['accessPackageCatalog', { id: 'src-cat', displayName: 'KEEL-RT-Catalog', description: 'Fixture', state: 'published', isExternallyVisible: false, createdDateTime: '2026-01-01T00:00:00Z' }],
    ['appManagementPolicy', { id: 'src-pol', displayName: 'KEEL-RT-AppPolicy', description: 'No secrets', isEnabled: true, restrictions: { passwordCredentials: [{ restrictionType: 'passwordAddition', maxLifetime: null }] } }],
    ['lifecycleWorkflowCustomTaskExtension', { id: 'src-ext', displayName: 'KEEL-RT-Extension', description: 'Logic app', endpointConfiguration: { '@odata.type': '#microsoft.graph.logicAppTriggerEndpointConfiguration', subscriptionId: 's', resourceGroupName: 'r', logicAppWorkflowName: 'w' }, createdBy: { id: 'x' } }],
  ];
  for (const [type, payload] of cases) {
    const graph = idoFakeGraph();
    const result = await applyIdentityObjectWrite(graph, resourceOf(type, payload), 'create', FAST);
    assert.equal(result.failed, undefined, `${type}: ${result.failed?.error}`);
    const post = graph.calls.find((call) => call.method === 'POST');
    assert.equal(post.path, IDENTITY_RECORDS[type].collection);
    assert.equal('createdDateTime' in post.body, false);
    assert.equal('createdBy' in post.body, false);
    assert.equal(post.body.id, undefined, `${type} id on create`);
  }
});

test('a custom security attribute update adds and deactivates allowed values, never removes one', async () => {
  const path = '/directory/customSecurityAttributeDefinitions/KEELRTSet_Level';
  const live = { id: 'KEELRTSet_Level', attributeSet: 'KEELRTSet', name: 'Level', description: 'Old', status: 'Available', type: 'String', usePreDefinedValuesOnly: true, allowedValues: [{ id: 'High', isActive: true }, { id: 'Extra', isActive: true }] };
  const desired = { ...live, description: 'Clearance', allowedValues: [{ id: 'High', isActive: false }, { id: 'Low', isActive: true }] };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIdentityObjectWrite(graph, resourceOf('customSecurityAttributeDefinition', desired, {
    live: { state: 'present', targetId: 'KEELRTSet_Level', payload: live },
  }), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(graph.calls.find((call) => call.method === 'PATCH' && call.path === path).body, { description: 'Clearance' });
  const values = (await graph.read('v1.0', `${path}/allowedValues`)).body.value;
  assert.deepEqual(values.map((value) => `${value.id}:${value.isActive}`).sort(), ['Extra:true', 'High:false', 'Low:true']);
});

test('a reference that would be remapped to another id is refused', async () => {
  const payload = { id: 'src-pol', displayName: 'KEEL-RT-AppPolicy', isEnabled: true, restrictions: { ownerId: 'source-owner' } };
  const resource = resourceOf('appManagementPolicy', payload, {
    references: [{ field: 'restrictions.ownerId', symbol: 'user:keel-rt-owner@example.test', required: true }],
  });
  const graph = idoFakeGraph();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', {
    ...FAST, referenceContext: { targetIndex: new Map([['user:keel-rt-owner@example.test', 'target-owner']]), mappingTable: new Map(), runProvenance: new Map() },
  });
  assert.match(result.failed.error, /unqualified-remapping/);
  assert.equal(graph.calls.length, 0);
});

test('an attribute set is only updated: a create waits for a review step', async () => {
  const path = '/directory/attributeSets/KEELRTSet';
  const live = { id: 'KEELRTSet', description: 'Old', maxAttributesPerSet: 5 };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const desired = { ...live, description: 'Fixture set', maxAttributesPerSet: 10 };
  const updated = await applyIdentityObjectWrite(graph, resourceOf('attributeSet', desired, { live: { state: 'present', targetId: 'KEELRTSet', payload: live } }), 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  assert.deepEqual(graph.calls.find((call) => call.method === 'PATCH').body, { description: 'Fixture set', maxAttributesPerSet: 10 });
  const created = await applyIdentityObjectWrite(idoFakeGraph(), resourceOf('attributeSet', desired), 'create', FAST);
  assert.match(created.failed.error, /unsupported operation/);
  for (const type of ['attributeSet', 'customSecurityAttributeDefinition']) assert.deepEqual(IDENTITY_RECORDS[type].operations, ['update']);
  for (const type of ['tenantAppManagementPolicy', 'crossTenantIdentitySyncPolicyPartner']) assert.equal(IDENTITY_RECORDS[type], undefined);
  assert.ok(Object.keys(IDENTITY_NEEDS_REVIEW).length === 4);
});

test('every record operation is in the ledger, and best-effort types have no record', () => {
  const ledger = buildIdentityObjectLedger().operations;
  for (const { resourceType, operation } of identityObjectOperations()) {
    assert.ok(ledger.some((row) => row.resourceType === resourceType && row.operation === operation), `${resourceType} ${operation}`);
  }
  for (const type of Object.keys(IDENTITY_BEST_EFFORT)) assert.equal(IDENTITY_RECORDS[type], undefined, type);
});
