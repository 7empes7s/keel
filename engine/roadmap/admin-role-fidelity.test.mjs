/**
 * Roadmap task-151 boundary tests: restore of custom directory roles, PIM
 * eligible assignments and PIM role settings; collection of PIM role settings,
 * their role bindings and active time-bound assignments.
 *
 * Exercises engine/restore/adminRoleOperations.mjs through the production
 * applyWave() path and the reconciliation plan. Microsoft Graph is the
 * in-memory fake only; no tenant is read or written. Mutation checks:
 *
 * - Write a built-in role.
 * - Restore an expired eligibility, or one held through a group.
 * - Request an eligibility the target already has.
 * - Write a PIM rule change that weakens protection.
 * - Require approval from an approver who no longer exists.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph, runFixtureHarness } from '../../tools/qualification/operations.mjs';
import { CATALOG, catalogReadPath } from '../../tools/tenant-probe/catalog.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { naturalKeyFor } from '../cir/naturalKey.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { knownFieldsFor, reviewStateFor } from '../contracts/fieldProjection.mjs';
import { OPERATIONS, capabilityFor } from '../coverage/capabilities.mjs';
import { qualificationFor, remappingFor } from '../coverage/qualification.mjs';
import { buildReconciliationPlan } from '../reconcile/reconciliationPlan.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import {
  ADMIN_ROLE_RECORDS, ELIGIBILITY_JUSTIFICATION, PIM_RULE_KINDS, buildAdminRoleLedger, durationSeconds, ruleWeakening,
} from '../restore/adminRoleOperations.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const PROOF = 'engine/roadmap/admin-role-fidelity.test.mjs';
const NOW = new Date('2026-10-09T00:00:00Z');
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
const ADA = '4f1c2b3a-0d9e-4c8b-a7f6-1e2d3c4b5a69';
const APPROVER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ROLES = '/roleManagement/directory/roleDefinitions';
const SCHEDULES = '/roleManagement/directory/roleEligibilitySchedules';
const REQUESTS = '/roleManagement/directory/roleEligibilityScheduleRequests';
const POLICY_ID = 'DirectoryRole_fixture-tenant_00000000-aaaa-bbbb-cccc-000000000001';

/** fakeGraph plus the method, path and body of every write, and every read path. */
function recordingGraph({ readOverride = null } = {}) {
  const graph = fakeGraph();
  const bodies = [];
  const reads = [];
  const write = graph.write.bind(graph);
  const read = graph.read.bind(graph);
  graph.write = async (version, path, request) => {
    bodies.push({ method: request.method, path, body: request.body });
    return write(version, path, request);
  };
  graph.read = async (version, path) => {
    reads.push(path);
    const result = await read(version, path);
    return readOverride && result.ok ? { ...result, body: readOverride(result.body, path) } : result;
  };
  graph.bodies = bodies;
  graph.reads = reads;
  return graph;
}

function immediateTimers(t) {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => original(fn, 0, ...args);
  t.after(() => { globalThis.setTimeout = original; });
}

const run = (graph, wave, options = {}) => applyWave(graph, governor, wave, {
  targetTenant: 'fixture', mode: 'enforce', now: () => NOW, ...options,
});

// ------------------------------------------------------------------ fixtures

const customRole = Object.freeze({
  id: 'role-1', templateId: 'role-1', displayName: 'Helpdesk password reset', description: 'Resets passwords',
  isBuiltIn: false, isEnabled: true, version: '1', resourceScopes: ['/'],
  rolePermissions: [{ allowedResourceActions: ['microsoft.directory/users/password/update', 'microsoft.directory/users/basic/read'], condition: null }],
});

const eligibility = Object.freeze({
  id: 'schedule-old', principalId: ADA, roleDefinitionId: GLOBAL_ADMIN, directoryScopeId: '/', appScopeId: null,
  memberType: 'Direct', status: 'Provisioned', createdUsing: 'request-old',
  scheduleInfo: { startDateTime: '2026-06-01T00:00:00Z', expiration: { type: 'afterDateTime', endDateTime: '2027-06-01T00:00:00Z' } },
});

const target = (caller, level) => ({ caller, operations: ['all'], level, inheritableSettings: [], enforcedSettings: [] });
const enablement = (enabledRules) => ({
  '@odata.type': PIM_RULE_KINDS.enablement.odataType, id: 'Enablement_EndUser_Assignment', enabledRules, target: target('EndUser', 'Assignment'),
});
const expiration = (isExpirationRequired, maximumDuration, id = 'Expiration_EndUser_Assignment') => ({
  '@odata.type': PIM_RULE_KINDS.expiration.odataType, id, isExpirationRequired, maximumDuration, target: target('EndUser', 'Assignment'),
});
const approval = (isApprovalRequired, approvers = [{ '@odata.type': '#microsoft.graph.singleUser', userId: APPROVER }]) => ({
  '@odata.type': PIM_RULE_KINDS.approval.odataType, id: 'Approval_EndUser_Assignment', target: target('EndUser', 'Assignment'),
  setting: {
    isApprovalRequired, isApprovalRequiredForExtension: false, isRequestorJustificationRequired: true, approvalMode: 'SingleStage',
    approvalStages: [{ approvalStageTimeOutInDays: 1, isApproverJustificationRequired: true, escalationTimeInMinutes: 0, isEscalationEnabled: false, primaryApprovers: approvers, escalationApprovers: [] }],
  },
});
const notification = (recipients) => ({
  '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyNotificationRule', id: 'Notification_Admin_EndUser_Assignment',
  notificationType: 'Email', recipientType: 'Admin', notificationLevel: 'All', isDefaultRecipientsEnabled: true,
  notificationRecipients: recipients, target: target('EndUser', 'Assignment'),
});

function policy(rules) {
  return {
    id: POLICY_ID, displayName: 'DirectoryRole', description: 'DirectoryRole', isOrganizationDefault: false,
    scopeId: '/', scopeType: 'DirectoryRole', lastModifiedDateTime: null, lastModifiedBy: { displayName: null, id: null }, rules,
  };
}

const snapshotPolicy = Object.freeze(policy([
  enablement(['MultiFactorAuthentication', 'Justification']), expiration(true, 'PT8H'), approval(true), notification(['security@contoso.example']),
]));

function plannedPolicyUpdate(graph, desired, live) {
  graph.objects.set(`/policies/roleManagementPolicies/${live.id}`, live);
  return {
    naturalKey: `unifiedRoleManagementPolicy:${live.id}`, resourceType: 'unifiedRoleManagementPolicy', verb: 'update', payload: desired,
    references: [], blastRadius: 'tenant-lockout', targetId: live.id, live: { state: 'present', targetId: live.id, payload: live },
  };
}

function plannedRoleUpdate(graph, desired, live) {
  graph.objects.set(`${ROLES}/${live.id}`, live);
  return {
    naturalKey: `roleDefinition:${desired.templateId}`, resourceType: 'roleDefinition', verb: 'update', payload: desired,
    references: [], blastRadius: 'tenant-lockout', targetId: live.id, live: { state: 'present', targetId: live.id, payload: live },
  };
}

const eligibilityCreate = (payload = eligibility, extra = {}) => ({
  naturalKey: `roleEligibilitySchedule:${payload.id}`, resourceType: 'roleEligibilitySchedule', verb: 'create', payload,
  references: [], blastRadius: 'tenant-lockout', ...extra,
});

// ------------------------------------------------------------------ registry

test('custom role create/update, eligibility create and PIM settings update are fixture-tested; every sibling stays unsupported', () => {
  const expected = { roleDefinition: ['create', 'update'], roleEligibilitySchedule: ['create'], unifiedRoleManagementPolicy: ['update'] };
  for (const [type, operations] of Object.entries(expected)) {
    for (const operation of OPERATIONS) {
      const capability = capabilityFor(type, operation);
      if (operations.includes(operation)) {
        assert.equal(capability.claim, 'fixture-tested', `${type} ${operation}`);
        assert.equal(capability.proofRef, PROOF);
      } else {
        assert.equal(capability.claim, 'unsupported', `${type} ${operation}`);
      }
    }
    assert.equal(qualificationFor(type).decision, 'automated');
    assert.equal(qualificationFor(type).expansion.status, 'qualified-subset');
  }
  assert.equal(capabilityFor('roleDefinition', 'create').subtype, 'custom', 'only custom roles are covered');
  assert.equal(qualificationFor('unifiedRoleManagementPolicyAssignment').decision, 'manual');
  assert.equal(qualificationFor('roleAssignmentSchedule').expansion.status, 'research-needed');
  assert.equal(remappingFor('roleEligibilitySchedule', 'create').qualified, true);
  assert.equal(remappingFor('unifiedRoleManagementPolicy', 'update').qualified, false, 'approvers are never remapped to other ids');

  const ledger = buildAdminRoleLedger();
  assert.equal(ledger.operations.length, 4);
  assert.ok(ledger.operations.every((op) => op.claim === 'fixture-tested'));
});

test('every record writes only fields its type\'s reviewed field projection knows', () => {
  for (const type of ['roleDefinition', 'roleEligibilitySchedule', 'unifiedRoleManagementPolicy']) {
    assert.equal(reviewStateFor(type), 'reviewed-empty', type);
  }
  for (const entry of ADMIN_ROLE_RECORDS.filter((record) => record.resourceType !== 'roleEligibilitySchedule')) {
    const known = knownFieldsFor(entry.resourceType);
    for (const field of entry.writableFields) assert.ok(known.includes(field), `${entry.resourceType} ${field}`);
  }
  // The eligibility request body is built from the schedule's own known fields plus action and justification.
  const known = knownFieldsFor('roleEligibilitySchedule');
  const request = ADMIN_ROLE_RECORDS.find((record) => record.resourceType === 'roleEligibilitySchedule').writableFields;
  assert.deepEqual(request.filter((field) => !known.includes(field)), ['action', 'justification']);
});

// ------------------------------------------------------------------ collection and keys

test('PIM settings, their role bindings and active schedules are collected, keyed by id', () => {
  for (const type of ['unifiedRoleManagementPolicy', 'unifiedRoleManagementPolicyAssignment', 'roleAssignmentSchedule']) {
    assert.ok(CATALOG.some((entry) => entry.type === type), `${type} is a catalogue type`);
    assert.equal(DESCRIPTORS.find((descriptor) => descriptor.type === type).naturalKeyStrategy, 'id');
  }
  const policies = CATALOG.find((entry) => entry.type === 'unifiedRoleManagementPolicy');
  assert.equal(catalogReadPath(policies), "/policies/roleManagementPolicies?$filter=scopeId eq '/' and scopeType eq 'DirectoryRole'&$expand=rules");
  // An existing type's read path and key are unchanged.
  assert.equal(catalogReadPath(CATALOG.find((entry) => entry.type === 'roleEligibilitySchedule')), '/roleManagement/directory/roleEligibilitySchedules');
  assert.equal(naturalKeyFor('roleEligibilitySchedule', eligibility), 'schedule-old');
  assert.equal(naturalKeyFor('roleDefinition', customRole), 'role-1', 'a custom role keeps its templateId key');
  // Two policies with the same display name stay distinct.
  const keys = canonicalizeAll([['unifiedRoleManagementPolicy', [snapshotPolicy, { ...snapshotPolicy, id: 'DirectoryRole_other' }]]]).map((r) => r.naturalKey);
  assert.deepEqual(keys, [`unifiedRoleManagementPolicy:${POLICY_ID}`, 'unifiedRoleManagementPolicy:DirectoryRole_other']);
});

test('the reconciliation plan reads live policies with the scope filter and plans an update under the snapshot key', async () => {
  const [resource] = canonicalizeAll([['unifiedRoleManagementPolicy', [snapshotPolicy]]]);
  const paths = [];
  const live = policy([enablement(['Justification']), expiration(true, 'PT8H'), approval(true), notification(['security@contoso.example'])]);
  const plan = await buildReconciliationPlan({
    async collect(_version, path) { paths.push(path); return { items: [live], error: null }; },
  }, [resource]);
  assert.deepEqual(paths, ["/policies/roleManagementPolicies?$filter=scopeId eq '/' and scopeType eq 'DirectoryRole'&$expand=rules"]);
  assert.equal(plan.resources[0].verb, 'update');
  assert.equal(plan.resources[0].targetId, POLICY_ID);
  assert.equal(plan.resources[0].recovery.mechanism, 'update-existing');
});

// ------------------------------------------------------------------ custom roles

test('a deleted custom role is recreated from its allowlist with its templateId, so its key survives', async () => {
  const graph = recordingGraph();
  const result = await run(graph, [{
    naturalKey: 'roleDefinition:role-1', resourceType: 'roleDefinition', verb: 'create', payload: customRole, references: [],
  }]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{
    method: 'POST', path: ROLES,
    body: {
      description: 'Resets passwords', displayName: 'Helpdesk password reset', isEnabled: true, templateId: 'role-1',
      rolePermissions: customRole.rolePermissions,
    },
  }]);
  const created = graph.objects.get(`${ROLES}/${result.applied[0].targetId}`);
  assert.equal(naturalKeyFor('roleDefinition', created), naturalKeyFor('roleDefinition', customRole));
  assert.deepEqual(result.applied[0].changes.addedActions, ['microsoft.directory/users/basic/read', 'microsoft.directory/users/password/update']);
});

test('a custom role update PATCHes only what changed, and the dry run names the actions it adds and removes', async () => {
  const live = {
    ...customRole, displayName: 'Renamed',
    rolePermissions: [{ allowedResourceActions: ['microsoft.directory/users/password/update', 'microsoft.directory/groups/members/update'] }],
  };
  const dry = recordingGraph();
  const preview = await run(dry, [plannedRoleUpdate(dry, customRole, live)], { mode: 'dry-run' });
  assert.equal(dry.bodies.length, 0);
  assert.deepEqual(preview.applied[0].changes, {
    fields: ['displayName', 'rolePermissions'],
    addedActions: ['microsoft.directory/users/basic/read'], removedActions: ['microsoft.directory/groups/members/update'],
  });

  const graph = recordingGraph();
  const result = await run(graph, [plannedRoleUpdate(graph, customRole, live)]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{
    method: 'PATCH', path: `${ROLES}/role-1`, body: { displayName: 'Helpdesk password reset', rolePermissions: customRole.rolePermissions },
  }]);
});

test('mutation: a built-in role is never written, and a role that does not say is refused', async () => {
  const builtIn = { ...customRole, id: GLOBAL_ADMIN, templateId: GLOBAL_ADMIN, displayName: 'Global Administrator', isBuiltIn: true };
  let graph = recordingGraph();
  let result = await run(graph, [plannedRoleUpdate(graph, builtIn, { ...builtIn, description: 'changed' })]);
  assert.match(result.skipped[0].reason, /immutable built-in role/);
  graph = recordingGraph();
  result = await run(graph, [{ naturalKey: `roleDefinition:${GLOBAL_ADMIN}`, resourceType: 'roleDefinition', verb: 'create', payload: builtIn, references: [] }]);
  assert.match(result.skipped[0].reason, /immutable built-in role/);
  // The snapshot says custom but the target is built in: still never written.
  graph = recordingGraph();
  result = await run(graph, [plannedRoleUpdate(graph, customRole, { ...customRole, isBuiltIn: true })]);
  assert.match(result.skipped[0].reason, /immutable built-in role/);
  graph = recordingGraph();
  const { isBuiltIn: _flag, ...unknown } = customRole;
  result = await run(graph, [plannedRoleUpdate(graph, unknown, { ...unknown, displayName: 'x' })]);
  assert.match(result.failed[0].error, /does not say whether it is built in/);
  assert.equal(graph.bodies.length, 0);
});

test('role delete stays unsupported', async () => {
  const graph = recordingGraph();
  graph.objects.set(`${ROLES}/role-1`, customRole);
  const result = await run(graph, [{
    naturalKey: 'roleDefinition:role-1', resourceType: 'roleDefinition', verb: 'delete', payload: null, references: [], targetId: 'role-1',
    live: { state: 'present', targetId: 'role-1', payload: customRole },
  }]);
  assert.match(result.failed[0].error, /unsupported operation: roleDefinition delete/);
  assert.equal(graph.bodies.length, 0);
});

test('a role that does not read back as written fails with the field named', async (t) => {
  immediateTimers(t);
  const graph = recordingGraph({ readOverride: (body) => ({ ...body, displayName: 'Renamed' }) });
  const result = await run(graph, [plannedRoleUpdate(graph, customRole, { ...customRole, displayName: 'Renamed' })]);
  assert.match(result.failed[0].error, /post-state: displayName did not read back/);
});

test('a role create whose key already exists in the target is checked and never sent twice', async () => {
  const graph = recordingGraph();
  graph.objects.set(`${ROLES}/role-1`, customRole);
  const resource = { naturalKey: 'roleDefinition:role-1', resourceType: 'roleDefinition', verb: 'create', payload: customRole, references: [] };
  let result = await run(graph, [resource], { existingTargetIds: new Map([['roleDefinition:role-1', 'role-1']]) });
  assert.deepEqual(result.applied, [{ naturalKey: 'roleDefinition:role-1', targetId: 'role-1' }]);
  graph.objects.set(`${ROLES}/role-1`, { ...customRole, displayName: 'Other' });
  result = await run(graph, [resource], { existingTargetIds: new Map([['roleDefinition:role-1', 'role-1']]) });
  assert.match(result.failed[0].error, /conflict: role-1 exists in target and differs/);
  assert.equal(graph.bodies.length, 0);
});

// ------------------------------------------------------------------ eligibility

test('an eligibility is requested as adminAssign with a justification and the snapshot end date, then read back', async () => {
  const graph = recordingGraph();
  const result = await run(graph, [eligibilityCreate()]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{
    method: 'POST', path: REQUESTS,
    body: {
      action: 'adminAssign', justification: ELIGIBILITY_JUSTIFICATION, principalId: ADA, roleDefinitionId: GLOBAL_ADMIN, directoryScopeId: '/',
      scheduleInfo: { startDateTime: NOW.toISOString(), expiration: { type: 'afterDateTime', endDateTime: '2027-06-01T00:00:00.000Z' } },
    },
  }]);
  assert.ok(graph.reads.every((path) => path.startsWith(`${SCHEDULES}?$filter=principalId eq '${ADA}' and roleDefinitionId eq '${GLOBAL_ADMIN}'`)));
  const schedule = graph.objects.get(`${SCHEDULES}/${result.applied[0].targetId}`);
  assert.equal(schedule.principalId, ADA);
  assert.notEqual(schedule.id, eligibility.id, 'a recreated eligibility gets a new id');
});

test('an after-duration eligibility keeps the same end date; a permanent one stays permanent', async () => {
  const graph = recordingGraph();
  await run(graph, [eligibilityCreate({ ...eligibility, scheduleInfo: { startDateTime: '2026-10-01T00:00:00Z', expiration: { type: 'afterDuration', duration: 'P30D' } } })]);
  assert.deepEqual(graph.bodies[0].body.scheduleInfo.expiration, { type: 'afterDateTime', endDateTime: '2026-10-31T00:00:00.000Z' });
  const permanent = recordingGraph();
  await run(permanent, [eligibilityCreate({ ...eligibility, scheduleInfo: { startDateTime: '2026-01-01T00:00:00Z', expiration: { type: 'noExpiration' } } })]);
  assert.deepEqual(permanent.bodies[0].body.scheduleInfo.expiration, { type: 'noExpiration' });
});

test('mutation: an expired eligibility is not restored, and an unreadable schedule is refused', async () => {
  const graph = recordingGraph();
  let result = await run(graph, [eligibilityCreate({ ...eligibility, scheduleInfo: { startDateTime: '2026-01-01T00:00:00Z', expiration: { type: 'afterDateTime', endDateTime: '2026-10-08T00:00:00Z' } } })]);
  assert.match(result.skipped[0].reason, /expired: the eligibility ended on 2026-10-08/);
  result = await run(graph, [eligibilityCreate({ ...eligibility, scheduleInfo: { startDateTime: '2026-01-01T00:00:00Z', expiration: { type: 'afterDuration', duration: 'P1Y' } } })]);
  assert.match(result.failed[0].error, /start or duration cannot be read/);
  assert.equal(graph.bodies.length, 0);
  assert.equal(graph.reads.length, 0);
});

test('mutation: an eligibility held through a group is not copied to the member', async () => {
  const graph = recordingGraph();
  const result = await run(graph, [eligibilityCreate({ ...eligibility, memberType: 'Group' })]);
  assert.match(result.skipped[0].reason, /held through a group/);
  assert.equal(graph.bodies.length, 0);
});

test('mutation: an eligibility the target already has is never requested again', async () => {
  const graph = recordingGraph();
  graph.objects.set(`${SCHEDULES}/schedule-new`, { ...eligibility, id: 'schedule-new' });
  const result = await run(graph, [eligibilityCreate()]);
  assert.equal(graph.bodies.length, 0);
  assert.equal(result.applied[0].targetId, 'schedule-new');
  assert.equal(result.applied[0].changes.existing, true);
  // A group-inherited copy, or another scope, is not the same eligibility.
  const other = recordingGraph();
  other.objects.set(`${SCHEDULES}/inherited`, { ...eligibility, id: 'inherited', memberType: 'Group' });
  other.objects.set(`${SCHEDULES}/scoped`, { ...eligibility, id: 'scoped', directoryScopeId: '/administrativeUnits/au-1' });
  await run(other, [eligibilityCreate()]);
  assert.equal(other.bodies.length, 1);
});

test('a failed lookup is never read as absent: nothing is requested', async () => {
  const graph = recordingGraph();
  const read = graph.read;
  graph.read = async (version, path) => (path.startsWith(SCHEDULES) ? { ok: false, status: 403, body: null } : read(version, path));
  const result = await run(graph, [eligibilityCreate()]);
  assert.match(result.failed[0].error, /lookup-failed/);
  assert.equal(graph.bodies.length, 0);
});

test('a request that is not granted fails and says so', async () => {
  const graph = recordingGraph();
  const write = graph.write;
  graph.write = async (version, path, request) => {
    const result = await write(version, path, request);
    return path === REQUESTS ? { ...result, body: { ...result.body, status: 'PendingApproval' } } : result;
  };
  const result = await run(graph, [eligibilityCreate()]);
  assert.match(result.failed[0].error, /request ended PendingApproval/);
});

test('an eligibility whose group and custom role were recreated in this run is requested for the new ids', async () => {
  const graph = recordingGraph();
  const groupEligibility = { ...eligibility, principalId: 'group-old', roleDefinitionId: 'role-old' };
  const result = await run(graph, [eligibilityCreate(groupEligibility, {
    references: [
      { field: 'principalId', symbol: 'group:pim-admins', required: true },
      { field: 'roleDefinitionId', symbol: 'roleDefinition:role-old', required: true },
      // A reference outside what is sent is never resolved.
      { field: 'createdUsing', symbol: null, required: true },
    ],
  })], { appliedIds: new Map([['group:pim-admins', 'group-new'], ['roleDefinition:role-old', 'role-new']]) });
  assert.deepEqual(result.failed, []);
  assert.equal(graph.bodies[0].body.principalId, 'group-new');
  assert.equal(graph.bodies[0].body.roleDefinitionId, 'role-new');
});

test('eligibility update and removal stay unsupported', async () => {
  const graph = recordingGraph();
  for (const verb of ['update', 'delete']) {
    const result = await run(graph, [{
      ...eligibilityCreate(), verb, payload: verb === 'delete' ? null : eligibility, targetId: 'schedule-old',
      live: { state: 'present', targetId: 'schedule-old', payload: eligibility },
    }]);
    assert.match(result.failed[0].error, new RegExp(`unsupported operation: roleEligibilitySchedule ${verb}`));
  }
  assert.equal(graph.bodies.length, 0);
});

// ------------------------------------------------------------------ PIM role settings

test('PIM settings: only the changed reviewed rules are PATCHed, each with its type, id and target', async () => {
  const graph = recordingGraph();
  graph.objects.set(`/users/${APPROVER}`, { id: APPROVER });
  const live = policy([enablement(['Justification']), expiration(true, 'PT8H'), approval(true), notification(['someone@contoso.example'])]);
  const result = await run(graph, [plannedPolicyUpdate(graph, snapshotPolicy, live)]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{
    method: 'PATCH', path: `/policies/roleManagementPolicies/${POLICY_ID}/rules/Enablement_EndUser_Assignment`,
    body: {
      '@odata.type': PIM_RULE_KINDS.enablement.odataType, id: 'Enablement_EndUser_Assignment',
      target: target('EndUser', 'Assignment'), enabledRules: ['MultiFactorAuthentication', 'Justification'],
    },
  }]);
  assert.deepEqual(result.applied[0].changes, {
    rules: ['Enablement_EndUser_Assignment'], withheld: [], manual: ['Notification_Admin_EndUser_Assignment'],
  });
  assert.deepEqual(graph.objects.get(`/policies/roleManagementPolicies/${POLICY_ID}`).rules[0].enabledRules, ['MultiFactorAuthentication', 'Justification']);
});

test('mutation: a rule change that weakens protection is withheld and reported, never written', async () => {
  const graph = recordingGraph();
  // The snapshot is weaker than live on every reviewed rule.
  const weaker = policy([enablement(['Justification']), expiration(false, 'P365D'), approval(false)]);
  const live = policy([enablement(['MultiFactorAuthentication', 'Justification']), expiration(true, 'PT8H'), approval(true)]);
  const result = await run(graph, [plannedPolicyUpdate(graph, weaker, live)]);
  assert.equal(graph.bodies.length, 0);
  assert.deepEqual(result.applied[0].changes.withheld.map((entry) => entry.ruleId), [
    'Enablement_EndUser_Assignment', 'Expiration_EndUser_Assignment', 'Approval_EndUser_Assignment',
  ]);
  assert.match(result.applied[0].changes.withheld[0].reason, /stop requiring MultiFactorAuthentication/);

  // Mixed: a longer maximum is withheld while MFA is put back.
  const mixed = recordingGraph();
  const desired = policy([enablement(['MultiFactorAuthentication']), expiration(true, 'PT10H')]);
  const current = policy([enablement([]), expiration(true, 'PT8H')]);
  const outcome = await run(mixed, [plannedPolicyUpdate(mixed, desired, current)]);
  assert.deepEqual(mixed.bodies.map((write) => write.body.id), ['Enablement_EndUser_Assignment']);
  assert.match(outcome.applied[0].changes.withheld[0].reason, /raise the maximum duration from PT8H to PT10H/);
});

test('mutation: approval is written only when every approver still exists', async () => {
  const live = policy([approval(false)]);
  const desired = policy([approval(true)]);
  let graph = recordingGraph();
  let result = await run(graph, [plannedPolicyUpdate(graph, desired, live)]);
  assert.match(result.failed[0].error, new RegExp(`dependency: approver users/${APPROVER} in Approval_EndUser_Assignment does not exist`));
  assert.equal(graph.bodies.length, 0);

  graph = recordingGraph();
  graph.objects.set(`/users/${APPROVER}`, { id: APPROVER });
  result = await run(graph, [plannedPolicyUpdate(graph, desired, live)]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map((write) => write.body.id), ['Approval_EndUser_Assignment']);

  graph = recordingGraph();
  result = await run(graph, [plannedPolicyUpdate(graph, policy([approval(true, [])]), live)]);
  assert.match(result.failed[0].error, /approval would be required with no approver/);
  assert.equal(graph.bodies.length, 0);
});

test('a rule that does not read back as written fails with the rule named', async (t) => {
  immediateTimers(t);
  const graph = recordingGraph({
    readOverride: (body) => ({ ...body, rules: body.rules.map((rule) => (rule.id === 'Enablement_EndUser_Assignment' ? { ...rule, enabledRules: [] } : rule)) }),
  });
  const result = await run(graph, [plannedPolicyUpdate(graph, policy([enablement(['MultiFactorAuthentication'])]), policy([enablement([])]))]);
  assert.match(result.failed[0].error, /post-state: rule Enablement_EndUser_Assignment did not read back/);
});

test('a policy outside the directory role scope, or without a live read, is refused', async () => {
  const graph = recordingGraph();
  let result = await run(graph, [plannedPolicyUpdate(graph, { ...snapshotPolicy, scopeType: 'Group' }, policy([enablement([])]))]);
  assert.match(result.failed[0].error, /not a directory role policy/);
  result = await run(graph, [{ naturalKey: 'unifiedRoleManagementPolicy:x', resourceType: 'unifiedRoleManagementPolicy', verb: 'update', payload: snapshotPolicy, references: [] }]);
  assert.match(result.failed[0].error, /no live unifiedRoleManagementPolicy was observed/);
  result = await run(graph, [{ ...plannedPolicyUpdate(graph, snapshotPolicy, policy([])), verb: 'create' }]);
  assert.match(result.failed[0].error, /unsupported operation: unifiedRoleManagementPolicy create/);
  assert.equal(graph.bodies.length, 0);
});

test('a reference outside the reviewed rules (lastModifiedBy) never blocks the restore', async () => {
  const graph = recordingGraph();
  const resource = plannedPolicyUpdate(graph, policy([enablement(['MultiFactorAuthentication'])]), policy([enablement([])]));
  resource.references = [{ field: 'lastModifiedBy.id', symbol: null, required: true }];
  const result = await run(graph, [resource]);
  assert.deepEqual(result.failed, []);
  assert.equal(graph.bodies.length, 1);
});

test('rule review: durations and weakening are judged conservatively', () => {
  assert.equal(durationSeconds('PT8H'), 28800);
  assert.equal(durationSeconds('P1DT30M'), 88200);
  assert.equal(durationSeconds('P1Y'), null, 'a calendar duration is never guessed');
  assert.equal(ruleWeakening('expiration', { isExpirationRequired: true, maximumDuration: 'PT4H' }, { isExpirationRequired: true, maximumDuration: 'PT8H' }), null);
  assert.match(ruleWeakening('expiration', { isExpirationRequired: true, maximumDuration: 'P1M' }, { isExpirationRequired: true, maximumDuration: 'PT8H' }), /cannot be compared/);
  assert.equal(ruleWeakening('expiration', { isExpirationRequired: true, maximumDuration: 'P365D' }, { isExpirationRequired: false, maximumDuration: 'P30D' }), null,
    'requiring an end date where none was required is never weaker');
  assert.equal(ruleWeakening('enablement', { enabledRules: ['Justification', 'MultiFactorAuthentication'] }, { enabledRules: ['Justification'] }), null);
  assert.match(ruleWeakening('approval', approval(true, []), { ...approval(true), setting: { ...approval(true).setting, approvalStages: [{}, {}] } }), /remove an approval stage/);
});

test('the dry run sends nothing and reads nothing', async () => {
  const graph = recordingGraph();
  const live = policy([enablement([])]);
  await run(graph, [
    plannedPolicyUpdate(graph, policy([enablement(['MultiFactorAuthentication'])]), live),
    eligibilityCreate(),
    { naturalKey: 'roleDefinition:role-1', resourceType: 'roleDefinition', verb: 'create', payload: customRole, references: [] },
  ], { mode: 'dry-run' });
  assert.equal(graph.bodies.length, 0);
  assert.equal(graph.reads.length, 0);
});

test('the fixture harness passes every task-151 operation', async () => {
  const results = await runFixtureHarness({ types: ['roleDefinition', 'roleEligibilitySchedule', 'unifiedRoleManagementPolicy'] });
  assert.equal(results.length, 4);
  assert.deepEqual(results.filter((result) => result.result !== 'passed'), []);
});
