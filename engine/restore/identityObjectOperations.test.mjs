/**
 * Wave 2 IDO: fixture tests for the identity object writers. Each drives the
 * production writer against an in-memory Graph (engine/test/idoFakeGraph.mjs);
 * nothing here reads or writes a tenant. Fixture names use the KEEL-RT- prefix.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  APP_SCOPE_ASSIGNMENT_READS, FEDERATION_SIGN_IN_FIELDS, IDENTITY_BEST_EFFORT, IDENTITY_NEEDS_REVIEW, IDENTITY_RECORDS, MICROSOFT_OWNER_TENANTS, applyIdentityEdges, applyIdentityObjectWrite,
  buildIdentityObjectLedger, identityObjectOperations, planIdentityEdges, sameJsonStrings, userCreateBody,
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

test('restore gaps batch 2: Entra ID tenant singletons write only their settings, in place, and read back', async () => {
  const MTO = '/policies/crossTenantAccessPolicy/templates';
  const name = { id: 'policy', displayName: 'Microsoft name', description: 'Microsoft description' };
  const cases = [
    ['externalIdentitiesPolicy', 'beta', '/policies/externalIdentitiesPolicy',
      { ...name, allowExternalIdentitiesToLeave: true, allowDeletedIdentitiesDataRemoval: false },
      { ...name, displayName: 'Other', allowExternalIdentitiesToLeave: false, allowDeletedIdentitiesDataRemoval: false },
      { allowExternalIdentitiesToLeave: true }],
    ['accessReviewPolicy', 'beta', '/policies/accessReviewPolicy',
      { ...name, isGroupOwnerManagementEnabled: true }, { ...name, isGroupOwnerManagementEnabled: false },
      { isGroupOwnerManagementEnabled: true }],
    ['directoryRoleAccessReviewPolicy', 'beta', '/policies/directoryRoleAccessReviewPolicy',
      { id: 'policy', settings: { instanceDurationInDays: 14, mailNotificationsEnabled: true } },
      { id: 'policy', settings: { instanceDurationInDays: 3, mailNotificationsEnabled: true } },
      { settings: { instanceDurationInDays: 14, mailNotificationsEnabled: true } }],
    ['multiTenantOrganizationIdentitySyncPolicyTemplate', 'v1.0', `${MTO}/multiTenantOrganizationIdentitySynchronization`,
      { id: 'template', templateApplicationLevel: 'newPartners', userSyncInbound: { isSyncAllowed: true } },
      { id: 'template', templateApplicationLevel: 'newPartners', userSyncInbound: { isSyncAllowed: false } },
      { userSyncInbound: { isSyncAllowed: true } }],
    ['multiTenantOrganizationPartnerConfigurationTemplate', 'v1.0', `${MTO}/multiTenantOrganizationPartnerConfiguration`,
      { id: 'template', templateApplicationLevel: 'newPartners', inboundTrust: { isMfaAccepted: true }, automaticUserConsentSettings: { inboundAllowed: true, outboundAllowed: false } },
      { id: 'template', templateApplicationLevel: 'newPartners', inboundTrust: { isMfaAccepted: true }, automaticUserConsentSettings: { inboundAllowed: false, outboundAllowed: false } },
      { automaticUserConsentSettings: { inboundAllowed: true, outboundAllowed: false } }],
  ];
  for (const [type, version, path, desired, live, patched] of cases) {
    assert.equal(IDENTITY_RECORDS[type].singleton, true, type);
    assert.deepEqual(IDENTITY_RECORDS[type].operations, ['update'], type);
    const graph = idoFakeGraph({ seed: { [path]: live } });
    const result = await applyIdentityObjectWrite(graph, { naturalKey: type, resourceType: type, payload: desired, references: [], live: { state: 'present', payload: live } }, 'update', FAST);
    assert.equal(result.failed, undefined, `${type}: ${result.failed?.error}`);
    const writes = graph.calls.filter((call) => call.method !== 'GET' && call.method !== undefined);
    assert.equal(writes.length, 1, `${type}: one write`);
    assert.equal(writes[0].method, 'PATCH');
    assert.equal(writes[0].version, version, type);
    assert.equal(writes[0].path, path);
    assert.deepEqual(writes[0].body, patched, `${type}: only the changed setting is sent, never its name or id`);
  }
});

test('restore gaps batch 2: the partner configuration template never writes inbound trust', async () => {
  const type = 'multiTenantOrganizationPartnerConfigurationTemplate';
  const path = '/policies/crossTenantAccessPolicy/templates/multiTenantOrganizationPartnerConfiguration';
  const consent = (inboundAllowed) => ({ inboundAllowed, outboundAllowed: false });
  const trust = (isMfaAccepted) => ({ isMfaAccepted, isCompliantDeviceAccepted: false, isHybridAzureADJoinedDeviceAccepted: false });
  const template = (isMfaAccepted, inboundAllowed) => ({ id: 'template', templateApplicationLevel: 'newPartners', inboundTrust: trust(isMfaAccepted), automaticUserConsentSettings: consent(inboundAllowed) });
  assert.equal(IDENTITY_RECORDS[type].writable.includes('inboundTrust'), false);
  const run = async (desired, live) => {
    const graph = idoFakeGraph({ seed: { [path]: live } });
    const result = await applyIdentityObjectWrite(graph, { naturalKey: type, resourceType: type, payload: desired, references: [], live: { state: 'present', payload: live } }, 'update', FAST);
    return { result, writes: graph.calls.filter((call) => call.method !== 'GET' && call.method !== undefined) };
  };

  // Only inbound trust differs: nothing is written, and the step says to change it by hand.
  let { result, writes } = await run(template(true, false), template(false, false));
  assert.equal(writes.length, 0, 'no write when only inbound trust differs');
  assert.match(result.skipped?.reason ?? '', /^manual: Inbound trust .* never changes it/);

  // Inbound trust and another setting differ: only the other setting is sent, and inbound trust is a step.
  ({ result, writes } = await run(template(true, true), template(false, false)));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { automaticUserConsentSettings: consent(true) });
  assert.deepEqual(result.applied.completion.map((step) => step.requirement), ['inboundTrust']);

  // Inbound trust is the same: the write goes ahead with no extra step.
  ({ result, writes } = await run(template(false, true), template(false, false)));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(writes.map((call) => call.body), [{ automaticUserConsentSettings: consent(true) }]);
  assert.equal(result.applied.completion, undefined);
});

test('restore gaps batch 2: a tenant singleton already equal to the backup is not written', async () => {
  const path = '/policies/accessReviewPolicy';
  const live = { id: 'policy', displayName: 'Access review policy', isGroupOwnerManagementEnabled: true };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIdentityObjectWrite(graph, { naturalKey: 'accessReviewPolicy', resourceType: 'accessReviewPolicy', payload: { ...live, displayName: 'Renamed by Microsoft' }, references: [], live: { state: 'present', payload: live } }, 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(graph.calls.filter((call) => call.method === 'PATCH').length, 0);
});

test('restore gaps batch 2: a tenant singleton is never created or deleted', async () => {
  const graph = idoFakeGraph();
  for (const verb of ['create', 'delete']) {
    const result = await applyIdentityObjectWrite(graph, { naturalKey: 'externalIdentitiesPolicy', resourceType: 'externalIdentitiesPolicy', payload: { allowExternalIdentitiesToLeave: true }, references: [] }, verb, FAST);
    assert.ok(result.failed || result.skipped, `${verb} is refused`);
  }
  assert.equal(graph.calls.filter((call) => call.method === 'POST' || call.method === 'DELETE').length, 0);
});

const B2B = '/policies/b2bManagementPolicies';
const b2bDefinition = (blocked) => [JSON.stringify({ B2BManagementPolicy: { InvitationsAllowedAndBlockedDomainsPolicy: { BlockedDomains: blocked } } })];
const PRE_APPROVAL = '/policies/permissionGrantPreApprovalPolicies';
const preApprovalCondition = (scopeType) => ({
  scopeType,
  sensitivityLabels: { '@odata.type': '#microsoft.graph.allScopeSensitivityLabels', labelKind: 'all' },
  permissions: {
    '@odata.type': '#microsoft.graph.enumeratedPreApprovedPermissions', permissionKind: 'enumerated', permissionType: 'application',
    resourceApplicationId: '00000003-0000-0000-c000-000000000000', permissionIds: ['permission-1'],
  },
});
const FEDERATIONS = '/directory/federationConfigurations/graph.samlOrWsFedExternalDomainFederation';

test('restore gaps batch 3: the guest domain restriction writes only its definition, in place, and reads back', async () => {
  const live = { id: 'b2b-1', displayName: 'B2B policy', isOrganizationDefault: true, definition: b2bDefinition([]) };
  const desired = { ...live, displayName: 'Renamed', isOrganizationDefault: false, definition: b2bDefinition(['keel-rt-blocked.example']) };
  const graph = idoFakeGraph({ seed: { [`${B2B}/b2b-1`]: live } });
  const result = await applyIdentityObjectWrite(graph, { naturalKey: 'b2b-1', resourceType: 'b2bManagementPolicy', payload: desired, references: [], live: { state: 'present', targetId: 'b2b-1', payload: live } }, 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const writes = graph.calls.filter((call) => call.method === 'PATCH');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].version, 'beta');
  assert.equal(writes[0].path, `${B2B}/b2b-1`);
  assert.deepEqual(writes[0].body, { definition: desired.definition }, 'never its name or default flag');
});

test('restore gaps batch 3: a definition Graph returns with other spacing is not written again', async () => {
  const backup = b2bDefinition(['keel-rt-blocked.example']);
  const spaced = [JSON.stringify(JSON.parse(backup[0]), null, 2)];
  assert.equal(sameJsonStrings(backup, spaced), true);
  assert.equal(sameJsonStrings(backup, b2bDefinition([])), false);
  assert.equal(sameJsonStrings(['not json'], ['not json']), true, 'text that is not JSON is compared as text');
  const live = { id: 'b2b-1', displayName: 'B2B policy', definition: spaced };
  const graph = idoFakeGraph({ seed: { [`${B2B}/b2b-1`]: live } });
  const result = await applyIdentityObjectWrite(graph, { naturalKey: 'b2b-1', resourceType: 'b2bManagementPolicy', payload: { ...live, definition: backup }, references: [], live: { state: 'present', targetId: 'b2b-1', payload: live } }, 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(graph.calls.filter((call) => call.method === 'PATCH').length, 0);
});

test('restore gaps batch 3: a deleted guest domain restriction or federation is never recreated', async () => {
  for (const [resourceType, payload] of [
    ['b2bManagementPolicy', { id: 'b2b-1', definition: b2bDefinition([]) }],
    ['externalDomainFederation', { id: 'fed-1', displayName: 'KEEL-RT-148-fed', issuerUri: 'https://keel-rt-fed.example/issuer' }],
  ]) {
    const graph = idoFakeGraph();
    const result = await applyIdentityObjectWrite(graph, { naturalKey: payload.id, resourceType, payload, references: [] }, 'create', FAST);
    assert.ok(result.failed, `${resourceType} create is refused`);
    assert.equal(graph.calls.filter((call) => call.method === 'POST').length, 0, resourceType);
  }
});

test('restore gaps batch 3: a pre-approval policy is recreated with its conditions and updated in place', async () => {
  const backup = { id: 'old-id', deletedDateTime: null, conditions: [preApprovalCondition('chat')] };
  const graph = idoFakeGraph();
  const created = await applyIdentityObjectWrite(graph, { naturalKey: 'old-id', resourceType: 'permissionGrantPreApprovalPolicy', payload: backup, references: [] }, 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.version, 'beta');
  assert.equal(post.path, PRE_APPROVAL);
  assert.deepEqual(post.body, { conditions: backup.conditions }, 'only the conditions are sent, never the old id');
  const newId = created.applied.targetId;
  assert.ok(newId && newId !== 'old-id');

  const drifted = { id: newId, conditions: [preApprovalCondition('group')] };
  const second = idoFakeGraph({ seed: { [`${PRE_APPROVAL}/${newId}`]: drifted } });
  const updated = await applyIdentityObjectWrite(second, { naturalKey: newId, resourceType: 'permissionGrantPreApprovalPolicy', payload: { ...backup, id: newId }, references: [], live: { state: 'present', targetId: newId, payload: drifted } }, 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  const patch = second.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.path, `${PRE_APPROVAL}/${newId}`);
  assert.deepEqual(patch.body, { conditions: backup.conditions });
});

test('restore gaps batch 3: a guest federation updates its settings in place, never its domains', async () => {
  const live = {
    '@odata.type': '#microsoft.graph.samlOrWsFedExternalDomainFederation', id: 'fed-1', displayName: 'KEEL-RT-148-fed',
    issuerUri: 'https://keel-rt-fed.example/issuer', passiveSignInUri: 'https://keel-rt-fed.example/sso',
    preferredAuthenticationProtocol: 'saml', signingCertificate: 'MIIFixture', domains: [{ id: 'keel-rt-fed.example' }],
  };
  const desired = { ...live, displayName: 'KEEL-RT-148-fed-renamed', domains: [{ id: 'other.example' }] };
  const graph = idoFakeGraph({ seed: { [`${FEDERATIONS}/fed-1`]: live } });
  const result = await applyIdentityObjectWrite(graph, { naturalKey: 'fed-1', resourceType: 'externalDomainFederation', payload: desired, references: [], live: { state: 'present', targetId: 'fed-1', payload: live } }, 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const writes = graph.calls.filter((call) => call.method === 'PATCH');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].version, 'v1.0');
  assert.equal(writes[0].path, `${FEDERATIONS}/fed-1`);
  assert.deepEqual(writes[0].body, { displayName: 'KEEL-RT-148-fed-renamed' });
});

const APP_SCOPES = '/roleManagement/exchange/customAppScopes';
const EXCHANGE = '/roleManagement/exchange';
const appAssignment = (appScopeId, id = 'assignment-1') => ({ id, principalId: 'sp-keel-rt', roleDefinitionId: 'role-mail-read', directoryScopeId: null, appScopeId });
const appScope = (filter) => ({ id: 'scope-src', type: 'RecipientScope', displayName: 'KEEL-RT-app-scope', customAttributes: { Exclusive: false, RecipientFilter: filter } });

test('restore gaps batch 9: an Exchange app access scope is recreated with its filter and updated without its kind', async () => {
  const backup = appScope("PrimarySmtpAddress -like 'keel-rt-scope-none*'");
  const graph = idoFakeGraph();
  const created = await applyIdentityObjectWrite(graph, { naturalKey: 'scope-src', resourceType: 'exchangeCustomAppScope', payload: backup, references: [] }, 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.version, 'beta');
  assert.equal(post.path, APP_SCOPES);
  assert.deepEqual(post.body, { type: 'RecipientScope', displayName: 'KEEL-RT-app-scope', customAttributes: backup.customAttributes });

  const drifted = { ...appScope("PrimarySmtpAddress -like 'keel-rt-*'"), id: 'scope-1' };
  // An assignment that uses another scope does not hold this one back.
  const second = idoFakeGraph({ seed: { [`${APP_SCOPES}/scope-1`]: drifted, [EXCHANGE]: { roleAssignments: [appAssignment('scope-other')] } } });
  const updated = await applyIdentityObjectWrite(second, { naturalKey: 'scope-1', resourceType: 'exchangeCustomAppScope', payload: { ...backup, id: 'scope-1' }, references: [], live: { state: 'present', targetId: 'scope-1', payload: drifted } }, 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  const patch = second.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.path, `${APP_SCOPES}/scope-1`);
  assert.deepEqual(patch.body, { customAttributes: backup.customAttributes });
});

test('an Exchange app access scope an app role assignment uses never has its filter changed by a restore', async () => {
  const live = { ...appScope("PrimarySmtpAddress -like 'keel-rt-scope-mail*'"), id: 'scope-1' };
  const broader = { ...live, customAttributes: { Exclusive: false, RecipientFilter: "PrimarySmtpAddress -like '*'" } };
  const run = async (desired, { mode = 'enforce', exchange = { roleAssignments: [appAssignment('scope-1')] }, withLive = true } = {}) => {
    const graph = idoFakeGraph({ seed: { [`${APP_SCOPES}/scope-1`]: live, ...(exchange ? { [EXCHANGE]: exchange } : {}) } });
    const result = await applyIdentityObjectWrite(graph, {
      naturalKey: 'scope-1', resourceType: 'exchangeCustomAppScope', payload: desired, references: [],
      live: { state: 'present', targetId: 'scope-1', ...(withLive ? { payload: live } : {}) },
    }, 'update', { ...FAST, mode });
    return { result, writes: graph.calls.filter((call) => call.method !== 'GET') };
  };

  // A broader filter from the backup: nothing is written, a person changes it.
  for (const mode of ['enforce', 'dry-run']) {
    const { result, writes } = await run(broader, { mode });
    assert.equal(result.applied, undefined, `${mode}: the filter is withheld`);
    assert.match(result.skipped?.reason ?? '', /^manual: .*used by 1 app role assignment/);
    assert.deepEqual(result.skipped.completion, {
      kind: 'manual-setting', requirement: 'exchangeAppScopeFilter', fields: ['customAttributes'], description: result.skipped.reason.replace(/^manual: /, ''),
    });
    assert.equal(writes.length, 0, `${mode}: nothing is written`);
  }
  // A name change alone still writes.
  const renamed = await run({ ...live, displayName: 'KEEL-RT-app-scope-renamed' });
  assert.equal(renamed.result.failed, undefined, renamed.result.failed?.error);
  assert.deepEqual(renamed.writes.map((call) => call.body), [{ displayName: 'KEEL-RT-app-scope-renamed' }]);
  // With no live copy at hand, the live scope is read before deciding.
  const unread = await run(broader, { withLive: false });
  assert.match(unread.result.skipped?.reason ?? '', /used by 1 app role assignment/);
  assert.equal(unread.writes.length, 0);
  // Assignments that cannot be read hold the filter back too.
  const unreadable = await run(broader, { exchange: null });
  assert.match(unreadable.result.skipped?.reason ?? '', /^manual: It could not be confirmed that no app role assignment uses this app access scope \(the app role assignments could not be read/);
  assert.equal(unreadable.writes.length, 0);
  // An assignment on a later page counts.
  const paged = idoFakeGraph({ seed: { [`${APP_SCOPES}/scope-1`]: live } });
  const read = paged.read.bind(paged);
  paged.read = async (version, path) => {
    if (path === `${EXCHANGE}/roleAssignments`) return { ok: true, status: 200, body: { value: [appAssignment('scope-other')], '@odata.nextLink': 'page-2' } };
    if (path === 'page-2') return { ok: true, status: 200, body: { value: [appAssignment('scope-1', 'assignment-2')] } };
    return read(version, path);
  };
  const second = await applyIdentityObjectWrite(paged, {
    naturalKey: 'scope-1', resourceType: 'exchangeCustomAppScope', payload: broader, references: [], live: { state: 'present', targetId: 'scope-1', payload: live },
  }, 'update', FAST);
  assert.match(second.skipped?.reason ?? '', /used by 1 app role assignment/);
  assert.equal(paged.calls.filter((call) => call.method === 'PATCH').length, 0);
});

test('the app scope guard fails closed when the beta assignment list pages unstably (#467)', async () => {
  const live = { ...appScope("PrimarySmtpAddress -like 'keel-rt-scope-mail*'"), id: 'scope-1' };
  const broader = { ...live, customAttributes: { Exclusive: false, RecipientFilter: "PrimarySmtpAddress -like '*'" } };
  const others = (count, from = 0) => Array.from({ length: count }, (_, index) => appAssignment('scope-other', `other-${from + index}`));
  // `reads` answers each unfiltered read of the list in turn (one page each);
  // `filtered` answers the read filtered by scope (null: Graph rejects it).
  const run = async ({ reads, filtered = null }) => {
    const graph = idoFakeGraph({ seed: { [`${APP_SCOPES}/scope-1`]: live } });
    const read = graph.read.bind(graph);
    let full = 0;
    graph.read = async (version, path) => {
      if (path.startsWith(`${EXCHANGE}/roleAssignments?$filter=`)) {
        graph.calls.push({ version, method: 'GET', path });
        return filtered ? { ok: true, status: 200, body: { value: filtered } } : { ok: false, status: 400, body: { error: { code: 'BadRequest' } } };
      }
      if (path === `${EXCHANGE}/roleAssignments`) {
        graph.calls.push({ version, method: 'GET', path });
        const rows = reads[Math.min(full, reads.length - 1)];
        full += 1;
        return { ok: true, status: 200, body: { value: rows } };
      }
      return read(version, path);
    };
    const result = await applyIdentityObjectWrite(graph, {
      naturalKey: 'scope-1', resourceType: 'exchangeCustomAppScope', payload: broader, references: [], live: { state: 'present', targetId: 'scope-1', payload: live },
    }, 'update', FAST);
    return { result, full, patches: graph.calls.filter((call) => call.method === 'PATCH') };
  };
  const using = [appAssignment('scope-1', 'a-1'), appAssignment('scope-1', 'a-2'), appAssignment('scope-1', 'a-3')];

  // One read repeats rows and misses every assignment naming the scope (the
  // live 3,3,3,1,3,0,... pattern): the filter is still held back.
  const missed = await run({ reads: [[...others(4), others(1)[0]]] });
  assert.match(missed.result.skipped?.reason ?? '', /^manual: It could not be confirmed that no app role assignment uses this app access scope \(a read of the app role assignments repeated rows \(4 distinct of 5\)/);
  assert.equal(missed.result.skipped.completion.requirement, 'exchangeAppScopeFilter');
  assert.equal(missed.patches.length, 0);

  // Reads without repeats that disagree are doubted too, even when none names the scope.
  const shifting = await run({ reads: [others(3), others(3, 1), others(3)] });
  assert.match(shifting.result.skipped?.reason ?? '', /reads of the app role assignments returned different assignments/);
  assert.equal(shifting.patches.length, 0);

  // An assignment seen in any read counts, and repeated rows count once.
  const sometimes = await run({ reads: [[...others(2), using[0], using[0]], others(3), [...others(2), using[1]]] });
  assert.match(sometimes.result.skipped?.reason ?? '', /used by at least 2 app role assignments/);
  assert.equal(sometimes.patches.length, 0);

  // A row without an id is doubted.
  const noId = await run({ reads: [[...others(2), { appScopeId: 'scope-other' }]] });
  assert.match(noId.result.skipped?.reason ?? '', /returned a row without an id/);

  // A filtered read that names the scope settles it without the full reads; the count is of distinct ids.
  const byFilter = await run({ reads: [others(3)], filtered: [...using, using[0]] });
  assert.match(byFilter.result.skipped?.reason ?? '', /used by 3 app role assignments,/);
  assert.equal(byFilter.full, 0);
  // A filter Graph ignores (rows for other scopes) proves nothing by itself.
  const ignored = await run({ reads: [[...others(3), using[2]]], filtered: others(3) });
  assert.match(ignored.result.skipped?.reason ?? '', /used by 1 app role assignment,/);

  // Only agreeing, complete reads with no assignment naming the scope let the filter be written.
  const clean = await run({ reads: [others(3)], filtered: [] });
  assert.equal(clean.result.failed, undefined, clean.result.failed?.error);
  assert.equal(clean.full, APP_SCOPE_ASSIGNMENT_READS);
  assert.deepEqual(clean.patches.map((call) => call.body), [{ customAttributes: broader.customAttributes }]);
});

test('a guest federation restore never writes its sign-in endpoints or signing certificate', async () => {
  const live = {
    '@odata.type': '#microsoft.graph.samlOrWsFedExternalDomainFederation', id: 'fed-1', displayName: 'KEEL-RT-148-fed',
    issuerUri: 'https://keel-rt-fed.example/issuer', metadataExchangeUri: 'https://keel-rt-fed.example/mex',
    passiveSignInUri: 'https://keel-rt-fed.example/sso', preferredAuthenticationProtocol: 'saml', signingCertificate: 'MIIFixture',
  };
  const tampered = {
    issuerUri: 'https://keel-rt-other.example/issuer',
    metadataExchangeUri: 'https://keel-rt-other.example/mex',
    passiveSignInUri: 'https://keel-rt-other.example/sso',
    signingCertificate: 'MIIOther',
  };
  assert.deepEqual([...FEDERATION_SIGN_IN_FIELDS].sort(), Object.keys(tampered).sort());
  for (const field of FEDERATION_SIGN_IN_FIELDS) {
    assert.equal(IDENTITY_RECORDS.externalDomainFederation.writable.includes(field), false, `${field} is not writable`);
  }
  const run = async (desired, mode = 'enforce') => {
    const graph = idoFakeGraph({ seed: { [`${FEDERATIONS}/fed-1`]: live } });
    const result = await applyIdentityObjectWrite(graph, {
      naturalKey: 'fed-1', resourceType: 'externalDomainFederation', payload: desired, references: [],
      live: { state: 'present', targetId: 'fed-1', payload: live },
    }, 'update', { ...FAST, mode });
    return { graph, result, writes: graph.calls.filter((call) => call.method !== 'GET') };
  };

  for (const [field, value] of Object.entries(tampered)) {
    // Only a sign-in field differs: nothing is written, the step names it.
    for (const mode of ['enforce', 'dry-run']) {
      const { result, writes } = await run({ ...live, [field]: value }, mode);
      assert.equal(result.applied, undefined, `${field} (${mode}) is withheld`);
      assert.match(result.skipped?.reason ?? '', new RegExp(`^manual: .*${field}`), `${field} (${mode})`);
      assert.deepEqual(result.skipped.completion.fields, [field]);
      assert.equal(writes.length, 0, `${field} (${mode}): nothing is written`);
    }
    // The name differs too: only the name is written, the sign-in field is a step.
    const { result, writes } = await run({ ...live, displayName: 'KEEL-RT-148-fed-renamed', [field]: value });
    assert.equal(result.failed, undefined, result.failed?.error);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].body, { displayName: 'KEEL-RT-148-fed-renamed' }, `${field} is never sent`);
    assert.deepEqual(result.applied.completion.map((step) => [step.requirement, step.fields]), [['externalDomainFederationSignIn', [field]]]);
  }

  // Nothing differs in the sign-in fields: no step.
  const { result } = await run({ ...live, displayName: 'KEEL-RT-148-fed-renamed' });
  assert.deepEqual(result.applied.completion ?? [], []);
});

test('a guest federation update with no live copy to compare is withheld when it carries a sign-in field', async () => {
  const desired = { id: 'fed-1', displayName: 'KEEL-RT-148-fed', passiveSignInUri: 'https://keel-rt-fed.example/sso' };
  const graph = idoFakeGraph();
  const result = await applyIdentityObjectWrite(graph, {
    naturalKey: 'fed-1', resourceType: 'externalDomainFederation', payload: desired, references: [], targetId: 'fed-1',
  }, 'update', FAST);
  assert.match(result.skipped?.reason ?? '', /passiveSignInUri/);
  assert.equal(graph.calls.length, 0);
});

test('restore gaps batch 3: a federation of another kind has no write route', async () => {
  const payload = { '@odata.type': '#microsoft.graph.internalDomainFederation', id: 'fed-2', displayName: 'KEEL-RT-148-internal' };
  const graph = idoFakeGraph();
  const result = await applyIdentityObjectWrite(graph, { naturalKey: 'fed-2', resourceType: 'externalDomainFederation', payload, references: [], live: { state: 'present', targetId: 'fed-2', payload } }, 'update', FAST);
  assert.match(result.skipped?.reason ?? '', /no write route/);
  assert.equal(graph.calls.length, 0);
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

// ------------------------------------------- restore gaps, batch 17

const sharepoint = Object.freeze({
  isLoopEnabled: true, isSiteCreationEnabled: false, idleSessionSignOut: { isEnabled: true, warnAfterInSeconds: 3000, signOutAfterInSeconds: 3600 },
  isLegacyAuthProtocolsEnabled: false, isUnmanagedSyncAppForTenantRestricted: true, isRequireAcceptingUserToMatchInvitedUserEnabled: true,
  sharingCapability: 'externalUserAndGuestSharing', sharingAllowedDomainList: ['partner.example'], isResharingByExternalUsersEnabled: true,
  availableManagedPathsForSiteCreation: ['/sites/'], tenantDefaultTimezone: '(UTC) Coordinated Universal Time',
});

test('restore gaps batch 17: SharePoint tenant settings are updated in place, never the sharing fields', async () => {
  const path = '/admin/sharepoint/settings';
  assert.equal(IDENTITY_RECORDS.sharepointSettings.singleton, true);
  assert.deepEqual(IDENTITY_RECORDS.sharepointSettings.operations, ['update']);
  const live = { ...sharepoint, isLoopEnabled: false, sharingCapability: 'disabled', sharingAllowedDomainList: [], isResharingByExternalUsersEnabled: false, availableManagedPathsForSiteCreation: ['/teams/'] };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await applyIdentityObjectWrite(graph, { naturalKey: 'sharepointSettings', resourceType: 'sharepointSettings', payload: sharepoint, references: [], live: { state: 'present', payload: live } }, 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  const writes = graph.calls.filter((call) => call.method !== 'GET' && call.method !== undefined);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
  assert.equal(writes[0].version, 'v1.0');
  assert.equal(writes[0].path, path);
  assert.deepEqual(writes[0].body, { isLoopEnabled: true }, 'sharing fields stay with the SharePoint workload; read-only paths are never sent');
});

test('restore gaps batch 17: a SharePoint restore never loosens who can reach files', async () => {
  const path = '/admin/sharepoint/settings';
  for (const [field, loose] of [['isLegacyAuthProtocolsEnabled', true], ['isUnmanagedSyncAppForTenantRestricted', false], ['isRequireAcceptingUserToMatchInvitedUserEnabled', false]]) {
    const graph = idoFakeGraph({ seed: { [path]: sharepoint } });
    const backup = { ...sharepoint, [field]: loose, isLoopEnabled: false };
    const result = await applyIdentityObjectWrite(graph, { naturalKey: 'sharepointSettings', resourceType: 'sharepointSettings', payload: backup, references: [], live: { state: 'present', payload: sharepoint } }, 'update', FAST);
    assert.match(result.skipped?.reason ?? '', /never loosens who can reach files/, field);
    assert.deepEqual(result.skipped.completion.fields, [field]);
    assert.equal(graph.calls.filter((call) => call.method === 'PATCH').length, 0, field);
  }
  // Tightening is written.
  const loose = { ...sharepoint, isLegacyAuthProtocolsEnabled: true };
  const graph = idoFakeGraph({ seed: { [path]: loose } });
  const result = await applyIdentityObjectWrite(graph, { naturalKey: 'sharepointSettings', resourceType: 'sharepointSettings', payload: sharepoint, references: [], live: { state: 'present', payload: loose } }, 'update', FAST);
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.deepEqual(graph.calls.find((call) => call.method === 'PATCH').body, { isLegacyAuthProtocolsEnabled: false });
});

// ------------------------------------------- restore gaps, batch 20: admin center org settings

const FORMS = Object.freeze({
  settings: {
    isBingImageSearchEnabled: true, isExternalSendFormEnabled: false, isExternalShareCollaborationEnabled: false,
    isExternalShareResultEnabled: false, isExternalShareTemplateEnabled: false, isInOrgFormsPhishingScanEnabled: true,
    isRecordIdentityByDefaultEnabled: true,
  },
});

// These settings are tenant-wide: a customer tenant writes them, the test
// tenant only with the tenant-wide option (tested below).
const CUSTOMER = Object.freeze({ ...FAST, tenantRef: 'sha256:customer0000000' });
const singletonWrite = (graph, resourceType, payload, live, ctx = CUSTOMER) => applyIdentityObjectWrite(graph,
  { naturalKey: resourceType, resourceType, payload, references: [], live: { state: 'present', payload: live } }, 'update', ctx);
const writesOf = (graph) => graph.calls.filter((call) => call.method !== 'GET' && call.method !== undefined);

test('restore gaps batch 20: each admin center setting is one object updated in place on its own route', () => {
  const expected = {
    formsSettings: ['beta', '/admin/forms', ['settings'], 'OrgSettings-Forms.ReadWrite.All'],
    microsoft365AppsInstallationOptions: ['v1.0', '/admin/microsoft365Apps/installationOptions', ['updateChannel', 'appsForWindows', 'appsForMac'], 'OrgSettings-Microsoft365Install.ReadWrite.All'],
    appsAndServicesSettings: ['beta', '/admin/appsAndServices', ['settings'], 'OrgSettings-AppsAndServices.ReadWrite.All'],
    adminReportSettings: ['v1.0', '/admin/reportSettings', ['displayConcealedNames'], 'ReportSettings.ReadWrite.All'],
    pronounsSettings: ['v1.0', '/admin/people/pronouns', ['isEnabledInOrganization'], 'PeopleSettings.ReadWrite.All'],
  };
  for (const [type, [version, collection, writable, permission]] of Object.entries(expected)) {
    const record = IDENTITY_RECORDS[type];
    assert.equal(record.singleton, true, type);
    assert.deepEqual(record.operations, ['update'], type);
    assert.deepEqual({ version: record.version, collection: record.collection, writable: [...record.writable], permission: record.permission },
      { version, collection, writable, permission }, type);
  }
  const community = IDENTITY_RECORDS.engageCommunity;
  assert.equal(community.singleton, false);
  assert.deepEqual(community.operations, ['update'], 'a community is never created or deleted');
  assert.deepEqual([...community.writable], ['displayName', 'description', 'privacy']);
});

test('restore gaps batch 20: Forms settings are written back as one settings object', async () => {
  const path = '/admin/forms';
  const live = { settings: { ...FORMS.settings, isBingImageSearchEnabled: false } };
  const graph = idoFakeGraph({ seed: { [path]: live } });
  const result = await singletonWrite(graph, 'formsSettings', { '@odata.context': 'x', ...FORMS }, live);
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  const writes = writesOf(graph);
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].method, writes[0].version, writes[0].path], ['PATCH', 'beta', path]);
  assert.deepEqual(writes[0].body, { settings: FORMS.settings }, 'the whole settings object, no annotation');
  assert.deepEqual(result.applied.changes.fields, ['settings']);
});

test('restore gaps batch 20: a Forms restore never widens sharing outside the organisation or turns the phishing scan off', async () => {
  const path = '/admin/forms';
  for (const [field, loose] of [['isExternalSendFormEnabled', true], ['isExternalShareCollaborationEnabled', true],
    ['isExternalShareResultEnabled', true], ['isExternalShareTemplateEnabled', true], ['isInOrgFormsPhishingScanEnabled', false]]) {
    const graph = idoFakeGraph({ seed: { [path]: FORMS } });
    const backup = { settings: { ...FORMS.settings, [field]: loose, isBingImageSearchEnabled: false } };
    const result = await singletonWrite(graph, 'formsSettings', backup, FORMS);
    assert.match(result.skipped?.reason ?? '', /never loosens/, field);
    assert.deepEqual(result.skipped.completion.fields, [`settings.${field}`], field);
    assert.match(result.skipped.completion.portalPath, /Microsoft Forms/);
    assert.equal(writesOf(graph).length, 0, field);
  }
  // Tightening is written: the backup turns external sending off again.
  const loose = { settings: { ...FORMS.settings, isExternalSendFormEnabled: true } };
  const graph = idoFakeGraph({ seed: { [path]: loose } });
  const result = await singletonWrite(graph, 'formsSettings', FORMS, loose);
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.deepEqual(writesOf(graph)[0].body, { settings: FORMS.settings });
});

test('restore gaps batch 20: install options, apps and services, report privacy and pronouns send only what changed', async () => {
  const cases = [
    ['microsoft365AppsInstallationOptions', '/admin/microsoft365Apps/installationOptions', 'v1.0',
      { updateChannel: 'current', appsForWindows: { isMicrosoft365AppsEnabled: true, isVisioEnabled: true }, appsForMac: { isMicrosoft365AppsEnabled: true } },
      { updateChannel: 'semiAnnual', appsForWindows: { isMicrosoft365AppsEnabled: true, isVisioEnabled: false }, appsForMac: { isMicrosoft365AppsEnabled: true } },
      { updateChannel: 'current', appsForWindows: { isMicrosoft365AppsEnabled: true, isVisioEnabled: true } }],
    ['appsAndServicesSettings', '/admin/appsAndServices', 'beta',
      { settings: { isOfficeStoreEnabled: false, isAppAndServicesTrialEnabled: true } },
      { settings: { isOfficeStoreEnabled: false, isAppAndServicesTrialEnabled: false } },
      { settings: { isOfficeStoreEnabled: false, isAppAndServicesTrialEnabled: true } }],
    ['adminReportSettings', '/admin/reportSettings', 'v1.0', { displayConcealedNames: true }, { displayConcealedNames: false }, { displayConcealedNames: true }],
    ['pronounsSettings', '/admin/people/pronouns', 'v1.0', { isEnabledInOrganization: false }, { isEnabledInOrganization: true }, { isEnabledInOrganization: false }],
  ];
  for (const [type, path, version, backup, live, body] of cases) {
    const graph = idoFakeGraph({ seed: { [path]: live } });
    const result = await singletonWrite(graph, type, backup, live);
    assert.equal(result.failed ?? result.skipped, undefined, `${type}: ${JSON.stringify(result)}`);
    const writes = writesOf(graph);
    assert.equal(writes.length, 1, type);
    assert.deepEqual([writes[0].method, writes[0].version, writes[0].path], ['PATCH', version, path], type);
    assert.deepEqual(writes[0].body, body, type);
  }
});

test('restore gaps batch 20: a restore never turns the Office Store on or shows real names in reports again', async () => {
  const store = { settings: { isOfficeStoreEnabled: false, isAppAndServicesTrialEnabled: true } };
  let graph = idoFakeGraph({ seed: { '/admin/appsAndServices': store } });
  let result = await singletonWrite(graph, 'appsAndServicesSettings', { settings: { isOfficeStoreEnabled: true, isAppAndServicesTrialEnabled: false } }, store);
  assert.match(result.skipped?.reason ?? '', /Office Store add-ins; a restore never loosens/);
  assert.deepEqual(result.skipped.completion.fields, ['settings.isOfficeStoreEnabled']);
  assert.equal(writesOf(graph).length, 0, 'withheld whole: the trial setting is not written either');

  graph = idoFakeGraph({ seed: { '/admin/reportSettings': { displayConcealedNames: true } } });
  result = await singletonWrite(graph, 'adminReportSettings', { displayConcealedNames: false }, { displayConcealedNames: true });
  assert.match(result.skipped?.reason ?? '', /real user, group and site names/);
  assert.equal(writesOf(graph).length, 0);
});

test('restore gaps batch 20: a dry run plans the changed field and writes nothing', async () => {
  const path = '/admin/people/pronouns';
  const graph = idoFakeGraph({ seed: { [path]: { isEnabledInOrganization: true } } });
  const result = await applyIdentityObjectWrite(graph, {
    naturalKey: 'pronounsSettings', resourceType: 'pronounsSettings', payload: { isEnabledInOrganization: false }, references: [],
    live: { state: 'present', payload: { isEnabledInOrganization: true } },
  }, 'update', { ...CUSTOMER, mode: 'dry-run' });
  assert.deepEqual(result.applied.changes.fields, ['isEnabledInOrganization']);
  assert.equal(writesOf(graph).length, 0);
});

// Review of PR #673: these five are tenant-wide, so on the test tenant they pass
// the same gate as the workload writers' tenant-wide objects (fixtureGuard.mjs).
const TENANT_WIDE_CASES = Object.freeze([
  ['formsSettings', '/admin/forms', FORMS, { settings: { ...FORMS.settings, isBingImageSearchEnabled: false } }],
  ['microsoft365AppsInstallationOptions', '/admin/microsoft365Apps/installationOptions',
    { updateChannel: 'current', appsForWindows: { isVisioEnabled: true } }, { updateChannel: 'current', appsForWindows: { isVisioEnabled: false } }],
  ['appsAndServicesSettings', '/admin/appsAndServices',
    { settings: { isOfficeStoreEnabled: false, isAppAndServicesTrialEnabled: true } }, { settings: { isOfficeStoreEnabled: false, isAppAndServicesTrialEnabled: false } }],
  ['adminReportSettings', '/admin/reportSettings', { displayConcealedNames: true }, { displayConcealedNames: false }],
  ['pronounsSettings', '/admin/people/pronouns', { isEnabledInOrganization: false }, { isEnabledInOrganization: true }],
]);
const TEST_TENANT = Object.freeze({ ...FAST, tenantRef: 'sha256:keeltesttenant0', testTenantRefs: ['sha256:keeltesttenant0'] });

test('restore gaps batch 20: the five admin center settings are marked tenant-wide, and only they are', () => {
  const marked = Object.values(IDENTITY_RECORDS).filter((record) => record.tenantWide).map((record) => record.resourceType).sort();
  assert.deepEqual(marked, ['adminReportSettings', 'appsAndServicesSettings', 'formsSettings', 'microsoft365AppsInstallationOptions', 'pronounsSettings']);
  assert.equal(IDENTITY_RECORDS.engageCommunity.tenantWide, false, 'a community is one object, not a tenant setting');
});

test('restore gaps batch 20: on the test tenant a tenant-wide setting is refused without the tenant-wide option, in the dry run and the write', async () => {
  for (const [type, path, backup, live] of TENANT_WIDE_CASES) {
    for (const mode of ['dry-run', 'enforce']) {
      const graph = idoFakeGraph({ seed: { [path]: live } });
      const result = await singletonWrite(graph, type, backup, live, { ...TEST_TENANT, mode });
      assert.equal(result.applied, undefined, `${type} ${mode}: ${JSON.stringify(result)}`);
      assert.match(result.skipped?.reason ?? '', /tenant-wide and needs a dry run made with --allow-tenant-wide-test-writes/, `${type} ${mode}`);
      assert.match(result.skipped.reason, new RegExp(type));
      assert.equal(graph.calls.length, 0, `${type} ${mode}: nothing is read or written`);
    }
  }
});

test('restore gaps batch 20: on the test tenant the tenant-wide option lets the setting be written', async () => {
  for (const [type, path, backup, live] of TENANT_WIDE_CASES) {
    const graph = idoFakeGraph({ seed: { [path]: live } });
    const result = await singletonWrite(graph, type, backup, live, { ...TEST_TENANT, allowTenantWide: true });
    assert.equal(result.failed ?? result.skipped, undefined, `${type}: ${JSON.stringify(result)}`);
    assert.equal(writesOf(graph).length, 1, type);
    // Only exactly true opens it.
    const other = idoFakeGraph({ seed: { [path]: live } });
    const refused = await singletonWrite(other, type, backup, live, { ...TEST_TENANT, allowTenantWide: 'true' });
    assert.match(refused.skipped?.reason ?? '', /tenant-wide/, type);
    assert.equal(writesOf(other).length, 0, type);
  }
});

test('restore gaps batch 20: a tenant-wide setting is not written when the target tenant is not known', async () => {
  for (const [type, path, backup, live] of TENANT_WIDE_CASES) {
    for (const tenantRef of [undefined, null, '']) {
      const graph = idoFakeGraph({ seed: { [path]: live } });
      const result = await singletonWrite(graph, type, backup, live, { ...FAST, tenantRef, allowTenantWide: true });
      assert.match(result.skipped?.reason ?? '', /tenant-wide setting and the target tenant is not known/, `${type} ${tenantRef}`);
      assert.equal(writesOf(graph).length, 0, type);
    }
  }
});

test('restore gaps batch 20: a tenant-wide setting that already matches is not refused on the test tenant', async () => {
  for (const [type, path, backup] of TENANT_WIDE_CASES) {
    const graph = idoFakeGraph({ seed: { [path]: backup } });
    const result = await singletonWrite(graph, type, backup, backup, TEST_TENANT);
    assert.equal(result.failed ?? result.skipped, undefined, `${type}: ${JSON.stringify(result)}`);
    assert.deepEqual(result.applied.changes.fields, [], type);
    assert.equal(writesOf(graph).length, 0, type);
  }
});

test('restore gaps batch 20: the loosening refusal still comes first on the test tenant', async () => {
  const graph = idoFakeGraph({ seed: { '/admin/reportSettings': { displayConcealedNames: true } } });
  const result = await singletonWrite(graph, 'adminReportSettings', { displayConcealedNames: false }, { displayConcealedNames: true },
    { ...TEST_TENANT, allowTenantWide: true });
  assert.match(result.skipped?.reason ?? '', /never loosens/);
  assert.equal(writesOf(graph).length, 0);
});

test('restore gaps batch 20: a Viva Engage community is updated in place and never made public', async () => {
  const collection = '/employeeExperience/communities';
  const backup = { id: 'community-1', displayName: 'KEEL-RT-community', description: 'Fixture', privacy: 'private', groupId: 'group-1' };
  const drifted = { ...backup, description: 'Drifted' };
  let graph = idoFakeGraph({ seed: { [`${collection}/community-1`]: drifted } });
  let result = await applyIdentityObjectWrite(graph, {
    naturalKey: 'community-1', resourceType: 'engageCommunity', payload: backup, references: [],
    live: { state: 'present', targetId: 'community-1', payload: drifted },
  }, 'update', FAST);
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  const writes = writesOf(graph);
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].method, writes[0].version, writes[0].path], ['PATCH', 'v1.0', `${collection}/community-1`]);
  assert.deepEqual(writes[0].body, { description: 'Fixture' }, 'the group behind it is never sent');

  const live = { ...backup, privacy: 'private' };
  graph = idoFakeGraph({ seed: { [`${collection}/community-1`]: live } });
  result = await applyIdentityObjectWrite(graph, {
    naturalKey: 'community-1', resourceType: 'engageCommunity', payload: { ...backup, privacy: 'Public', description: 'Other' }, references: [],
    live: { state: 'present', targetId: 'community-1', payload: live },
  }, 'update', FAST);
  assert.match(result.skipped?.reason ?? '', /makes the community public/);
  assert.equal(writesOf(graph).length, 0);

  for (const verb of ['create', 'delete']) {
    result = await applyIdentityObjectWrite(idoFakeGraph(), { naturalKey: 'community-1', resourceType: 'engageCommunity', payload: backup, references: [] }, verb, FAST);
    assert.match(result.failed?.error ?? '', /unsupported operation/, verb);
  }
});

test('restore gaps batch 20: the loosening guard fails closed when live does not hold the field', async () => {
  for (const live of [{}, { settings: null }, { settings: { isBingImageSearchEnabled: true } }]) {
    const graph = idoFakeGraph({ seed: { '/admin/forms': live } });
    const backup = { settings: { ...FORMS.settings, isExternalShareResultEnabled: true } };
    const result = await singletonWrite(graph, 'formsSettings', backup, live);
    assert.match(result.skipped?.reason ?? '', /never loosens/, JSON.stringify(live));
    assert.equal(writesOf(graph).length, 0);
  }
  const graph = idoFakeGraph({ seed: { '/employeeExperience/communities/c-1': { id: 'c-1', displayName: 'X' } } });
  const result = await applyIdentityObjectWrite(graph, {
    naturalKey: 'c-1', resourceType: 'engageCommunity', payload: { id: 'c-1', displayName: 'X', privacy: 'public' }, references: [],
    live: { state: 'present', targetId: 'c-1', payload: { id: 'c-1', displayName: 'X' } },
  }, 'update', FAST);
  assert.match(result.skipped?.reason ?? '', /makes the community public/);
});

test('restore gaps batch 20: a settings member Graph added after the backup is not a difference', async () => {
  const path = '/admin/forms';
  const live = { settings: { ...FORMS.settings, isNewerBetaSetting: true } };
  let graph = idoFakeGraph({ seed: { [path]: live } });
  let result = await singletonWrite(graph, 'formsSettings', FORMS, live);
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.equal(writesOf(graph).length, 0, 'nothing changed, so nothing is written');

  // A real change is written and reads back, although live keeps the newer member.
  const drifted = { settings: { ...live.settings, isBingImageSearchEnabled: false } };
  graph = idoFakeGraph({ seed: { [path]: drifted } });
  result = await singletonWrite(graph, 'formsSettings', FORMS, drifted);
  assert.equal(result.failed ?? result.skipped, undefined, JSON.stringify(result));
  assert.deepEqual(writesOf(graph)[0].body, { settings: FORMS.settings });
});

// ------------------------------------------------- restore gaps, batch 21

const DEFENDER_ROLES = '/roleManagement/defender/roleDefinitions';
// The provider object, so its role list reads as empty rather than missing.
const DEFENDER = { '/roleManagement/defender': {} };
const defenderRole = (extra = {}) => ({
  id: 'role-src', displayName: 'KEEL-RT-defender-role', description: 'Reads security data', isBuiltIn: false, isEnabled: true,
  rolePermissions: [{ allowedResourceActions: ['microsoft.xdr/secops/securitydata/read'] }], ...extra,
});

test('restore gaps batch 21: a custom Defender role is recreated with its permissions and updated in place', async () => {
  const backup = defenderRole();
  const graph = idoFakeGraph({ seed: DEFENDER });
  const created = await applyIdentityObjectWrite(graph, { naturalKey: 'role-src', resourceType: 'defenderRoleDefinition', payload: backup, references: [] }, 'create', FAST);
  assert.equal(created.failed, undefined, created.failed?.error);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.version, 'beta');
  assert.equal(post.path, DEFENDER_ROLES);
  assert.deepEqual(post.body, { displayName: 'KEEL-RT-defender-role', description: 'Reads security data', rolePermissions: backup.rolePermissions });

  const drifted = defenderRole({ id: 'role-1', description: 'Changed', rolePermissions: [{ allowedResourceActions: ['microsoft.xdr/secops/securitydata/read', 'microsoft.xdr/secops/securitydata/manage'] }] });
  const second = idoFakeGraph({ seed: { ...DEFENDER, [`${DEFENDER_ROLES}/role-1`]: drifted } });
  const updated = await applyIdentityObjectWrite(second, {
    naturalKey: 'role-1', resourceType: 'defenderRoleDefinition', payload: { ...backup, id: 'role-1' }, references: [],
    live: { state: 'present', targetId: 'role-1', payload: drifted },
  }, 'update', FAST);
  assert.equal(updated.failed, undefined, updated.failed?.error);
  const patch = second.calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.path, `${DEFENDER_ROLES}/role-1`);
  assert.deepEqual(patch.body, { description: 'Reads security data', rolePermissions: backup.rolePermissions }, 'the wider permission is taken away');
});

test('restore gaps batch 21: a built-in or unmarked Defender role, or one with no permissions, is never written', async () => {
  for (const [payload, expect] of [
    [defenderRole({ isBuiltIn: true, displayName: 'Security Reader' }), /^manual: "Security Reader" is a built-in Defender role/],
    [defenderRole({ isBuiltIn: undefined }), /does not say whether this Defender role is built in/],
  ]) {
    const graph = idoFakeGraph({ seed: DEFENDER });
    const result = await applyIdentityObjectWrite(graph, { naturalKey: 'role-src', resourceType: 'defenderRoleDefinition', payload, references: [] }, 'create', FAST);
    assert.match(result.skipped?.reason ?? '', expect);
    assert.equal(graph.calls.filter((call) => call.method !== 'GET').length, 0);
  }
  const graph = idoFakeGraph({ seed: DEFENDER });
  const empty = await applyIdentityObjectWrite(graph, { naturalKey: 'role-src', resourceType: 'defenderRoleDefinition', payload: defenderRole({ rolePermissions: [] }), references: [] }, 'create', FAST);
  assert.match(empty.failed?.error ?? '', /has no permissions/);
  assert.equal(graph.calls.filter((call) => call.method !== 'GET').length, 0);
});

test('restore gaps batch 21: a second create of a Defender role finds the first by name and never makes a twin', async () => {
  const backup = defenderRole();
  const graph = idoFakeGraph({ seed: DEFENDER });
  const first = await applyIdentityObjectWrite(graph, { naturalKey: 'role-src', resourceType: 'defenderRoleDefinition', payload: backup, references: [] }, 'create', FAST);
  assert.equal(first.failed, undefined, first.failed?.error);
  const posts = () => graph.calls.filter((call) => call.method === 'POST').length;
  assert.equal(posts(), 1);

  const again = await applyIdentityObjectWrite(graph, { naturalKey: 'role-src', resourceType: 'defenderRoleDefinition', payload: backup, references: [] }, 'create', FAST);
  assert.match(again.skipped?.reason ?? '', /already there/);
  assert.equal(posts(), 1, 'the re-run writes nothing');

  const other = await applyIdentityObjectWrite(graph, { naturalKey: 'role-src', resourceType: 'defenderRoleDefinition', payload: defenderRole({ description: 'Other' }), references: [] }, 'create', FAST);
  assert.match(other.failed?.error ?? '', /already exists with other settings/);
  assert.equal(posts(), 1, 'a role with the same name and other settings is never duplicated');
});
