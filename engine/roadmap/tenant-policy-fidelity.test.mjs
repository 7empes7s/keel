/**
 * Roadmap task-149 boundary tests: restore of the tenant-wide Entra security
 * policies (authorization, authentication methods, security defaults,
 * cross-tenant access default and partners, admin consent requests).
 *
 * Exercises engine/restore/tenantPolicyOperations.mjs through the production
 * applyWave() path and engine/safety/lockoutGate.mjs over task-94's
 * break-glass readiness evaluation. Microsoft Graph is an in-memory fake only;
 * no tenant is read or written. Required mutation checks:
 *
 * - Write a lockout-sensitive policy without the lockout gate.
 * - Send a field outside the record's allowlist.
 * - Restore a method policy that switches off the break-glass method.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { lockoutGateFor } from '../../cli/keel-restore.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { naturalKeyFor } from '../cir/naturalKey.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { OPERATIONS, capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { buildExpansionInventory, qualificationFor } from '../coverage/qualification.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import {
  METHOD_CONFIGURATION_TYPES, TENANT_POLICY_RECORDS, buildTenantPolicyLedger, tenantPolicyWriteRefusal,
} from '../restore/tenantPolicyOperations.mjs';
import { breakGlassLockoutGate, closedLockoutGate } from '../safety/lockoutGate.mjs';
import { compareSignInPaths } from '../safety/signInPathGate.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const ALLOW = Object.freeze({ evaluate: () => ({ allowed: true, reason: 'test' }) });
const DENY = Object.freeze({ evaluate: () => ({ allowed: false, reason: 'test says no' }) });
const PROOF = 'engine/roadmap/tenant-policy-fidelity.test.mjs';
// Issue #156 added the basic tenant settings to the same records; their proof is its own file.
const BASIC_SETTINGS_PROOF = 'engine/roadmap/entra-basic-settings.test.mjs';
const BASIC_SETTINGS = new Set(['organizationalBranding', 'organizationalBrandingLocalization', 'groupLifecyclePolicy', 'authenticationFlowsPolicy']);

/** fakeGraph plus the method, path and body of every write. */
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

function immediateTimers(t) {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => original(fn, 0, ...args);
  t.after(() => { globalThis.setTimeout = original; });
}

/** Seeds `live` at `path` and returns the planned update. */
function plannedUpdate(graph, resourceType, path, desired, live, extra = {}) {
  graph.objects.set(path, live);
  return {
    naturalKey: `${resourceType}:${resourceType}`, resourceType, verb: 'update', payload: desired,
    references: [], blastRadius: 'tenant-lockout', targetId: live.id ?? resourceType,
    live: { state: 'present', targetId: live.id ?? resourceType, payload: live },
    ...extra,
  };
}

const run = (graph, wave, options = {}) => applyWave(graph, governor, wave, {
  targetTenant: 'fixture', mode: 'enforce', ...options,
});

const authorization = Object.freeze({
  id: 'authorizationPolicy', displayName: 'Authorization Policy', description: 'Used to manage authorization related settings',
  allowInvitesFrom: 'adminsAndGuestInviters', allowedToUseSSPR: true, blockMsolPowerShell: true,
  guestUserRoleId: '10dae51f-b6af-4016-8d66-8c2a99b929b3',
  defaultUserRolePermissions: Object.freeze({ allowedToCreateApps: false, allowedToCreateSecurityGroups: false, permissionGrantPoliciesAssigned: [] }),
});

const methods = Object.freeze({
  id: 'authenticationMethodsPolicy', displayName: 'Authentication Methods Policy', policyVersion: '1.5',
  registrationEnforcement: { authenticationMethodsRegistrationCampaign: { state: 'enabled', snoozeDurationInDays: 1 } },
  authenticationMethodConfigurations: [
    { '@odata.type': '#microsoft.graph.fido2AuthenticationMethodConfiguration', id: 'Fido2', state: 'enabled', isAttestationEnforced: true, includeTargets: [{ targetType: 'group', id: 'all_users', isRegistrationRequired: false }] },
    { '@odata.type': '#microsoft.graph.smsAuthenticationMethodConfiguration', id: 'Sms', state: 'disabled', includeTargets: [] },
  ],
});

// ------------------------------------------------------------------ ledger

test('every record is a fixture-tested registration; no singleton is created or deleted', () => {
  for (const record of TENANT_POLICY_RECORDS) {
    const capability = capabilityFor(record.resourceType, record.operation);
    assert.equal(capability.claim, 'fixture-tested', `${record.resourceType} ${record.operation}`);
    assert.equal(capability.proofRef, BASIC_SETTINGS.has(record.resourceType) ? BASIC_SETTINGS_PROOF : PROOF);
    assert.equal(qualificationFor(record.resourceType).decision, 'automated');
  }
  for (const type of ['authorizationPolicy', 'authenticationMethodsPolicy', 'identitySecurityDefaultsEnforcementPolicy',
    'crossTenantAccessPolicy', 'crossTenantAccessPolicyConfigurationDefault', 'adminConsentRequestPolicy']) {
    assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor(type, operation).claim)), ['update'], type);
  }
  assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor('crossTenantAccessPolicyPartner', operation).claim)), ['create', 'update']);
  assert.equal(capabilityFor('permissionGrantPolicy', 'update').claim, 'unsupported', 'permission grant policies stay research-needed');
  const lockout = TENANT_POLICY_RECORDS.filter((record) => record.lockout).map((record) => record.resourceType).sort();
  assert.deepEqual(lockout, ['authenticationMethodsPolicy', 'authorizationPolicy', 'identitySecurityDefaultsEnforcementPolicy']);
  const inventory = buildExpansionInventory();
  const policy = inventory.batches.find((batch) => batch.id === 'policy');
  for (const type of ['identitySecurityDefaultsEnforcementPolicy', 'crossTenantAccessPolicyConfigurationDefault']) {
    assert.equal(policy.types.find((entry) => entry.resourceType === type).status, 'qualified-subset', type);
  }
  assert.equal(buildTenantPolicyLedger().operations.length, TENANT_POLICY_RECORDS.length);
});

test('security defaults and the cross-tenant default are collected with constant keys the live plan reproduces', () => {
  for (const type of ['identitySecurityDefaultsEnforcementPolicy', 'crossTenantAccessPolicyConfigurationDefault']) {
    const descriptor = DESCRIPTORS.find((entry) => entry.type === type);
    assert.ok(descriptor, `${type} is a catalogue type`);
    assert.equal(descriptor.naturalKeyStrategy, 'constant');
    assert.equal(descriptor.criticality, 'tier1');
  }
  const collected = [
    ['identitySecurityDefaultsEnforcementPolicy', [{ id: '00000000-0000-0000-0000-000000000005', displayName: 'Security Defaults', isEnabled: true }]],
    ['crossTenantAccessPolicyConfigurationDefault', [{ isServiceDefault: true, inboundTrust: null }]],
    ['crossTenantAccessPolicyPartner', [{ tenantId: '9f1c0a7e-6b3d-4b8e-9d55-1c2b3a4d5e6f', inboundTrust: null }]],
    ['adminConsentRequestPolicy', [{ isEnabled: false, reviewers: [] }]],
  ];
  const resources = canonicalizeAll(collected);
  for (const resource of resources) {
    const object = collected.find(([type]) => type === resource.resourceType)[1][0];
    // reconciliationPlan keys a live object `${type}:${naturalKeyFor(...)}`.
    assert.equal(`${resource.resourceType}:${naturalKeyFor(resource.resourceType, object)}`, resource.naturalKey, resource.resourceType);
  }
});

// ------------------------------------------------------------------ writes

test('authorization policy: only the changed allowlisted fields are PATCHed and read back', async () => {
  const graph = recordingGraph();
  const desired = { ...authorization, displayName: 'Renamed in snapshot', allowInvitesFrom: 'none' };
  const live = { ...authorization, allowInvitesFrom: 'everyone' };
  const result = await run(graph, [plannedUpdate(graph, 'authorizationPolicy', '/policies/authorizationPolicy', desired, live)], { lockoutGate: ALLOW });
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path: '/policies/authorizationPolicy', body: { allowInvitesFrom: 'none' } }]);
  assert.equal(graph.objects.get('/policies/authorizationPolicy').displayName, 'Authorization Policy', 'displayName is not in the allowlist');
});

test('mutation: a lockout-sensitive policy is never written without an allowing lockout gate', async () => {
  for (const lockoutGate of [null, DENY]) {
    const graph = recordingGraph();
    const live = { ...authorization, allowInvitesFrom: 'everyone' };
    const result = await run(graph, [plannedUpdate(graph, 'authorizationPolicy', '/policies/authorizationPolicy', authorization, live)], { lockoutGate });
    assert.equal(graph.bodies.length, 0, 'nothing is sent');
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /tenant-lockout policy/);
  }
  const graph = recordingGraph();
  const result = await run(graph, [plannedUpdate(graph, 'identitySecurityDefaultsEnforcementPolicy', '/policies/identitySecurityDefaultsEnforcementPolicy',
    { id: '00000000-0000-0000-0000-000000000005', isEnabled: true }, { id: '00000000-0000-0000-0000-000000000005', isEnabled: false })]);
  assert.equal(graph.bodies.length, 0);
  assert.match(result.skipped[0].reason, /none was supplied/);
});

test('a non-lockout policy needs no gate; the cross-tenant default PATCHes only what changed', async () => {
  const graph = recordingGraph();
  const desired = { isServiceDefault: false, inboundTrust: { isMfaAccepted: true, isCompliantDeviceAccepted: false }, b2bCollaborationOutbound: { usersAndGroups: { accessType: 'allowed', targets: [{ target: 'AllUsers', targetType: 'user' }] } } };
  const live = { ...desired, inboundTrust: { isMfaAccepted: false, isCompliantDeviceAccepted: false } };
  const result = await run(graph, [plannedUpdate(graph, 'crossTenantAccessPolicyConfigurationDefault', '/policies/crossTenantAccessPolicy/default', desired, live)]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path: '/policies/crossTenantAccessPolicy/default', body: { inboundTrust: desired.inboundTrust } }]);
});

test('authentication methods: each changed method is PATCHed with its @odata.type, then the root fields', async () => {
  const graph = recordingGraph();
  const live = {
    ...methods,
    registrationEnforcement: { authenticationMethodsRegistrationCampaign: { state: 'disabled', snoozeDurationInDays: 1 } },
    authenticationMethodConfigurations: methods.authenticationMethodConfigurations.map((config) => (config.id === 'Fido2' ? { ...config, state: 'disabled' } : config)),
  };
  // The snapshot's canonical payload has no @odata annotations.
  const desired = { ...methods, authenticationMethodConfigurations: methods.authenticationMethodConfigurations.map(({ '@odata.type': _t, ...config }) => config) };
  const result = await run(graph, [plannedUpdate(graph, 'authenticationMethodsPolicy', '/policies/authenticationMethodsPolicy', desired, live)], { lockoutGate: ALLOW });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies.map(({ method, path }) => `${method} ${path}`), [
    'PATCH /policies/authenticationMethodsPolicy/authenticationMethodConfigurations/Fido2',
    'PATCH /policies/authenticationMethodsPolicy',
  ]);
  assert.equal(graph.bodies[0].body['@odata.type'], METHOD_CONFIGURATION_TYPES.fido2);
  assert.equal(graph.bodies[0].body.state, 'enabled');
  assert.equal(Object.hasOwn(graph.bodies[0].body, 'id'), false);
  assert.deepEqual(Object.keys(graph.bodies[1].body), ['registrationEnforcement']);
});

test('authentication methods: an unknown or missing method is refused before any write', async () => {
  const graph = recordingGraph();
  const unknown = { ...methods, authenticationMethodConfigurations: [{ id: 'QRCodePin', state: 'enabled' }] };
  let result = await run(graph, [plannedUpdate(graph, 'authenticationMethodsPolicy', '/policies/authenticationMethodsPolicy', unknown, methods)], { lockoutGate: ALLOW });
  assert.match(result.failed[0].error, /has no known type/);
  const live = { ...methods, authenticationMethodConfigurations: methods.authenticationMethodConfigurations.filter((config) => config.id !== 'Sms') };
  result = await run(graph, [plannedUpdate(graph, 'authenticationMethodsPolicy', '/policies/authenticationMethodsPolicy', methods, live)], { lockoutGate: ALLOW });
  assert.match(result.failed[0].error, /Sms does not exist in the live policy/);
  assert.equal(graph.bodies.length, 0);
});

test('admin consent requests: a PUT carries every writable field and nothing else', async () => {
  const graph = recordingGraph();
  const desired = { isEnabled: true, notifyReviewers: true, remindersEnabled: true, requestDurationInDays: 30, version: 3, reviewers: [{ query: '/v1.0/users/abc', queryType: 'MicrosoftGraph', queryRoot: null }] };
  const live = { ...desired, isEnabled: false, version: 4 };
  const result = await run(graph, [plannedUpdate(graph, 'adminConsentRequestPolicy', '/policies/adminConsentRequestPolicy', desired, live)]);
  assert.deepEqual(result.failed, []);
  assert.equal(graph.bodies.length, 1);
  assert.equal(graph.bodies[0].method, 'PUT');
  assert.deepEqual(Object.keys(graph.bodies[0].body).sort(), ['isEnabled', 'notifyReviewers', 'remindersEnabled', 'requestDurationInDays', 'reviewers']);
});

test('admin consent requests: a reviewer named by id must still exist before the PUT', async () => {
  const reviewer = '3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d';
  const desired = { isEnabled: true, notifyReviewers: true, remindersEnabled: true, requestDurationInDays: 30, reviewers: [{ query: `/v1.0/groups/${reviewer}/transitiveMembers/microsoft.graph.user`, queryType: 'MicrosoftGraph', queryRoot: null }] };
  let graph = recordingGraph();
  let result = await run(graph, [plannedUpdate(graph, 'adminConsentRequestPolicy', '/policies/adminConsentRequestPolicy', desired, { ...desired, isEnabled: false })]);
  assert.match(result.failed[0].error, new RegExp(`dependency: admin consent reviewer /groups/${reviewer} does not exist`));
  assert.equal(graph.bodies.length, 0);

  graph = recordingGraph();
  graph.objects.set(`/groups/${reviewer}`, { id: reviewer });
  result = await run(graph, [plannedUpdate(graph, 'adminConsentRequestPolicy', '/policies/adminConsentRequestPolicy', desired, { ...desired, isEnabled: false })]);
  assert.deepEqual(result.failed, []);
  assert.equal(graph.bodies.length, 1);
});

test('authentication methods: a property outside the method allowlist is never sent', async () => {
  const graph = recordingGraph();
  const desired = { ...methods, authenticationMethodConfigurations: [{ ...methods.authenticationMethodConfigurations[0], isAttestationEnforced: false, serverOwnedCounter: 7 }] };
  const result = await run(graph, [plannedUpdate(graph, 'authenticationMethodsPolicy', '/policies/authenticationMethodsPolicy', desired, methods)], { lockoutGate: ALLOW });
  assert.deepEqual(result.failed, []);
  assert.equal(graph.bodies.length, 1);
  assert.deepEqual(Object.keys(graph.bodies[0].body).sort(), ['@odata.type', 'includeTargets', 'isAttestationEnforced', 'state']);
});

test('partners: create and update are addressed by the partner tenantId', async () => {
  const tenantId = '9f1c0a7e-6b3d-4b8e-9d55-1c2b3a4d5e6f';
  const payload = { tenantId, isServiceProvider: false, inboundTrust: { isMfaAccepted: true } };
  let graph = recordingGraph();
  let result = await run(graph, [{ naturalKey: `crossTenantAccessPolicyPartner:${tenantId}`, resourceType: 'crossTenantAccessPolicyPartner', verb: 'create', payload, references: [], blastRadius: 'access-affecting' }]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'POST', path: '/policies/crossTenantAccessPolicy/partners', body: { tenantId, inboundTrust: { isMfaAccepted: true } } }]);

  graph = recordingGraph();
  const path = `/policies/crossTenantAccessPolicy/partners/${tenantId}`;
  result = await run(graph, [plannedUpdate(graph, 'crossTenantAccessPolicyPartner', path, payload, { ...payload, inboundTrust: { isMfaAccepted: false } })]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path, body: { inboundTrust: { isMfaAccepted: true } } }]);
});

test('a write that does not read back as written fails with the field named', async (t) => {
  immediateTimers(t);
  const graph = recordingGraph({ readOverride: (body) => ({ ...body, allowInvitesFrom: 'everyone' }) });
  const live = { ...authorization, allowInvitesFrom: 'everyone' };
  const result = await run(graph, [plannedUpdate(graph, 'authorizationPolicy', '/policies/authorizationPolicy', authorization, live)], { lockoutGate: ALLOW });
  assert.equal(result.applied.length, 0);
  assert.match(result.failed[0].error, /post-state: allowInvitesFrom did not read back as written/);
});

test('a policy already matching the snapshot is not written', async () => {
  const graph = recordingGraph();
  const result = await run(graph, [plannedUpdate(graph, 'authorizationPolicy', '/policies/authorizationPolicy', authorization, { ...authorization, description: 'server text' })], { lockoutGate: ALLOW });
  assert.equal(result.applied.length, 1);
  assert.equal(graph.bodies.length, 0);
});

test('dry run sends nothing', async () => {
  const graph = recordingGraph();
  const live = { ...authorization, allowInvitesFrom: 'everyone' };
  const result = await run(graph, [plannedUpdate(graph, 'authorizationPolicy', '/policies/authorizationPolicy', authorization, live)], { lockoutGate: ALLOW, mode: 'dry-run' });
  assert.equal(result.applied.length, 1);
  assert.equal(graph.bodies.length, 0);
});

test('a reference remapped to a different id is refused (remapping is not proven)', async () => {
  const graph = recordingGraph();
  const desired = { ...methods, authenticationMethodConfigurations: [{ id: 'Fido2', state: 'enabled', includeTargets: [{ targetType: 'group', id: 'source-group' }] }] };
  const planned = plannedUpdate(graph, 'authenticationMethodsPolicy', '/policies/authenticationMethodsPolicy', desired, methods, {
    references: [{ field: 'authenticationMethodConfigurations[0].includeTargets[0].id', symbol: 'group:admins', required: true }],
  });
  const result = await run(graph, [planned], { lockoutGate: ALLOW, existingTargetIds: new Map([['group:admins', 'target-group']]) });
  assert.match(result.failed[0].error, /unqualified-remapping/);
  assert.equal(graph.bodies.length, 0);
});

// ------------------------------------------------------------------ sign-in path gate

test('the sign-in path gate skips only the sections a verified tenant policy write changed', () => {
  const before = { authenticationMethodsPolicy: { a: 1 }, securityDefaults: { isEnabled: false }, conditionalAccessPolicies: [] };
  const after = { authenticationMethodsPolicy: { a: 2 }, securityDefaults: { isEnabled: false }, conditionalAccessPolicies: [] };
  assert.equal(compareSignInPaths(before, after).allowed, false);
  assert.equal(compareSignInPaths(before, after, { intendedSections: ['authenticationMethodsPolicy'] }).allowed, true);
  const alsoCa = { ...after, conditionalAccessPolicies: [{ x: 1 }] };
  const verdict = compareSignInPaths(before, alsoCa, { intendedSections: ['authenticationMethodsPolicy'] });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.changed, ['conditionalAccessPolicies']);
});

// ------------------------------------------------------------------ lockout gate

const NOW = new Date('2026-10-09T12:00:00Z');
const GA = '62e90394-69f5-4237-9190-012177145e10';
const accounts = ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002'].map((accountId, i) => ({
  accountId, label: `BG${i + 1}`, validationIntervalDays: 90, rotationIntervalDays: null,
  registeredAt: '2026-09-01T00:00:00Z', lastValidatedAt: '2026-10-01T00:00:00Z', lastRotatedAt: null,
  methodEvidence: { basis: 'observed', occurredAt: '2026-10-01T00:00:00Z', methods: ['fido2'] },
}));
const covered = (resources) => ({ status: 'covered', resources, observedAt: NOW.toISOString() });
const readyInventory = Object.freeze({
  user: covered(accounts.map((account) => ({ naturalKey: `user:${account.label}`, payload: { id: account.accountId, userPrincipalName: `${account.label}@contoso.example`, accountEnabled: true, userType: 'Member', onPremisesSyncEnabled: null } }))),
  domain: covered([{ naturalKey: 'domain:contoso.example', payload: { id: 'contoso.example', authenticationType: 'Managed' } }]),
  conditionalAccessPolicy: covered([]),
  roleAssignment: covered(accounts.map((account) => ({ naturalKey: `roleAssignment:GlobalAdministrator@${account.label}`, payload: { principalId: account.accountId, roleDefinitionId: GA, directoryScopeId: '/' } }))),
  roleEligibilitySchedule: covered([]),
  authenticationMethodsPolicy: covered([{ naturalKey: 'authenticationMethodsPolicy:x', payload: methods }]),
});

test('lockout gate: allows only while every break-glass account stays ready under the proposed policy', () => {
  const gate = breakGlassLockoutGate({ accounts, inventory: readyInventory, now: NOW });
  assert.equal(gate.evaluate({ resourceType: 'authenticationMethodsPolicy', desired: methods }).allowed, true);
  assert.equal(gate.evaluate({ resourceType: 'authorizationPolicy', desired: authorization }).allowed, true);

  // Mutation: the proposed policy switches off FIDO2, the method both accounts rely on.
  const fido2Off = { ...methods, authenticationMethodConfigurations: methods.authenticationMethodConfigurations.map((config) => (config.id === 'Fido2' ? { ...config, state: 'disabled' } : config)) };
  const verdict = gate.evaluate({ resourceType: 'authenticationMethodsPolicy', desired: fido2Off });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /phishingResistantCredential fail \(method-disabled-by-tenant-policy\)/);

  assert.equal(breakGlassLockoutGate({ accounts: accounts.slice(0, 1), inventory: readyInventory, now: NOW }).evaluate({ resourceType: 'authorizationPolicy', desired: {} }).allowed, false, 'fewer than two accounts');
  assert.equal(breakGlassLockoutGate({ configured: false }).evaluate({ resourceType: 'authorizationPolicy', desired: {} }).allowed, false);
  const unknown = { ...readyInventory, roleAssignment: { status: 'unavailable', resources: [], observedAt: null } };
  assert.equal(breakGlassLockoutGate({ accounts, inventory: unknown, now: NOW }).evaluate({ resourceType: 'authorizationPolicy', desired: {} }).allowed, false, 'unknown is never ready');
  assert.equal(closedLockoutGate('x').evaluate({}).allowed, false);

  // Mutation: FIDO2 stays enabled but is narrowed to one group, or excludes some users.
  const withFido2 = (change) => ({ ...methods, authenticationMethodConfigurations: methods.authenticationMethodConfigurations.map((config) => (config.id === 'Fido2' ? { ...config, ...change } : config)) });
  for (const change of [
    { includeTargets: [{ targetType: 'group', id: 'pilot-group', isRegistrationRequired: false }] },
    { excludeTargets: [{ targetType: 'group', id: 'break-glass-group' }] },
  ]) {
    const narrowed = gate.evaluate({ resourceType: 'authenticationMethodsPolicy', desired: withFido2(change) });
    assert.equal(narrowed.allowed, false, JSON.stringify(change));
    assert.match(narrowed.reason, /changes who may use Fido2/);
  }
  // Re-scoping a method no break-glass account relies on is not a lockout question.
  const smsScoped = { ...methods, authenticationMethodConfigurations: methods.authenticationMethodConfigurations.map((config) => (config.id === 'Sms' ? { ...config, includeTargets: [{ targetType: 'group', id: 'pilot-group' }] } : config)) };
  assert.equal(gate.evaluate({ resourceType: 'authenticationMethodsPolicy', desired: smsScoped }).allowed, true);
});

test('the gate decides inside applyWave: a denied methods restore is skipped and nothing is sent', async () => {
  const gate = breakGlassLockoutGate({ accounts, inventory: readyInventory, now: NOW });
  const graph = recordingGraph();
  const fido2Off = { ...methods, authenticationMethodConfigurations: methods.authenticationMethodConfigurations.map((config) => (config.id === 'Fido2' ? { ...config, state: 'disabled' } : config)) };
  const result = await run(graph, [plannedUpdate(graph, 'authenticationMethodsPolicy', '/policies/authenticationMethodsPolicy', fido2Off, methods)], { lockoutGate: gate });
  assert.equal(graph.bodies.length, 0);
  assert.match(result.skipped[0].reason, /break-glass lockout gate/);
});

test('keel-restore loads a gate only when a lockout-sensitive write is planned, and fails closed', async () => {
  const quiet = [{ resourceType: 'authorizationPolicy', verb: 'noop' }, { resourceType: 'crossTenantAccessPolicyConfigurationDefault', verb: 'update' }];
  assert.equal(await lockoutGateFor({ query: () => { throw new Error('must not read'); } }, quiet, { tenantRef: 't' }), null);
  const gate = await lockoutGateFor({ query: async () => { throw new Error('db down'); } }, [{ resourceType: 'authorizationPolicy', verb: 'update' }], { tenantRef: 't' });
  const verdict = gate.evaluate({ resourceType: 'authorizationPolicy', desired: {} });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /could not be read: db down/);
});

test('the write gate refuses an unregistered verb and a partner without a tenantId', () => {
  assert.match(tenantPolicyWriteRefusal({ resourceType: 'authorizationPolicy', payload: {} }, 'create').reason, /no tenant policy operation record/);
  assert.match(tenantPolicyWriteRefusal({ resourceType: 'crossTenantAccessPolicyPartner', payload: { inboundTrust: {} } }, 'create').reason, /names no tenantId/);
  assert.equal(tenantPolicyWriteRefusal({ resourceType: 'group', payload: {} }, 'update'), null, 'other types are not governed here');
});
