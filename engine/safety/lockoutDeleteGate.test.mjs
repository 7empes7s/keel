/**
 * Gap register D1: a tenant-lockout delete (role assignment, named location,
 * Conditional Access policy) is decided from break-glass readiness and the
 * sign-in path gate, both evaluated against the state after the delete.
 *
 * Runs through the production applyWave() path against an in-memory tenant.
 * Nothing reads or writes Microsoft.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { applyWave } from '../restore/applyEngine.mjs';
import { breakGlassLockoutGate, closedLockoutGate } from './lockoutGate.mjs';
import { lockoutDeleteRefusal } from './lockoutDeleteGate.mjs';
import { recordSignInPath } from './signInPathGate.mjs';

const NOW = new Date('2026-10-09T12:00:00Z');
const GA = '62e90394-69f5-4237-9190-012177145e10';
const HELPDESK_ROLE = '729827e3-9c14-49f7-bb1b-9608f156bbb8';
const BG1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const BG2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const STAFF = 'bbbbbbbb-0000-0000-0000-000000000001';
const CA_PATH = '/identity/conditionalAccess/policies';
const LOCATION_PATH = '/identity/conditionalAccess/namedLocations';
const ROLE_PATH = '/roleManagement/directory/roleAssignments';

const methods = Object.freeze({
  id: 'authenticationMethodsPolicy',
  authenticationMethodConfigurations: [
    { id: 'Fido2', state: 'enabled', includeTargets: [{ targetType: 'group', id: 'all_users' }] },
  ],
});
const accounts = [BG1, BG2].map((accountId, i) => ({
  accountId, label: `BG${i + 1}`, validationIntervalDays: 90, rotationIntervalDays: null,
  registeredAt: '2026-09-01T00:00:00Z', lastValidatedAt: '2026-10-01T00:00:00Z', lastRotatedAt: null,
  methodEvidence: { basis: 'observed', occurredAt: '2026-10-01T00:00:00Z', methods: ['fido2'] },
}));

// The target tenant: one object store the sign-in path reader, the writer and
// the readiness inventory are all built from.
function tenant() {
  const caPolicy = {
    id: 'ca-legacy', displayName: 'Legacy report-only policy', state: 'enabledForReportingButNotEnforced',
    conditions: { users: { includeUsers: ['All'] }, locations: { includeLocations: ['All'], excludeLocations: [] } },
    grantControls: { operator: 'OR', builtInControls: ['mfa'] },
  };
  const usedLocationPolicy = {
    id: 'ca-office', displayName: 'Block outside the office', state: 'enabledForReportingButNotEnforced',
    conditions: { users: { includeUsers: ['All'] }, locations: { includeLocations: ['All'], excludeLocations: ['loc-office'] } },
    grantControls: { operator: 'OR', builtInControls: ['block'] },
  };
  return {
    [CA_PATH]: new Map([[caPolicy.id, caPolicy], [usedLocationPolicy.id, usedLocationPolicy]]),
    [LOCATION_PATH]: new Map([
      ['loc-office', { id: 'loc-office', displayName: 'Office' }],
      ['loc-old', { id: 'loc-old', displayName: 'Closed branch' }],
    ]),
    [ROLE_PATH]: new Map([
      ['ra-bg1', { id: 'ra-bg1', principalId: BG1, roleDefinitionId: GA, directoryScopeId: '/' }],
      ['ra-bg2', { id: 'ra-bg2', principalId: BG2, roleDefinitionId: GA, directoryScopeId: '/' }],
      ['ra-staff', { id: 'ra-staff', principalId: STAFF, roleDefinitionId: HELPDESK_ROLE, directoryScopeId: '/' }],
    ]),
  };
}

const NATURAL_KEYS = {
  'ca-legacy': 'conditionalAccessPolicy:Legacy report-only policy',
  'ca-office': 'conditionalAccessPolicy:Block outside the office',
  'ra-bg1': 'roleAssignment:GlobalAdministrator@BG1',
  'ra-bg2': 'roleAssignment:GlobalAdministrator@BG2',
  'ra-staff': 'roleAssignment:Helpdesk@Staff',
};
const covered = (resources) => ({ status: 'covered', resources, observedAt: NOW.toISOString() });

/** Readiness inputs as the newest collection of `store` would hold them. */
function readinessInventory(store) {
  const collected = (path) => [...store[path].values()].map((payload) => ({ naturalKey: NATURAL_KEYS[payload.id], payload }));
  return {
    user: covered(accounts.map((account) => ({ naturalKey: `user:${account.label}`, payload: { id: account.accountId, userPrincipalName: `${account.label}@contoso.example`, accountEnabled: true, userType: 'Member', onPremisesSyncEnabled: null } }))),
    domain: covered([{ naturalKey: 'domain:contoso.example', payload: { id: 'contoso.example', authenticationType: 'Managed' } }]),
    conditionalAccessPolicy: covered(collected(CA_PATH)),
    roleAssignment: covered(collected(ROLE_PATH)),
    roleEligibilitySchedule: covered([]),
    authenticationMethodsPolicy: covered([{ naturalKey: 'authenticationMethodsPolicy:x', payload: methods }]),
  };
}

function readerFor(store) {
  return {
    async collect(_version, path) {
      if (path === CA_PATH) return { items: [...store[CA_PATH].values()].map((item) => structuredClone(item)) };
      if (path.startsWith(`${ROLE_PATH}?`)) {
        const principalId = /principalId eq '([^']+)'/.exec(decodeURIComponent(path.replace(/\+/g, ' ')))[1];
        return { items: [...store[ROLE_PATH].values()].filter((item) => item.principalId === principalId).map((item) => structuredClone(item)) };
      }
      return { error: { status: 404 } };
    },
    async get(_version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: structuredClone(methods) };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { isEnabled: false } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: decodeURIComponent(path.slice(7).split('?')[0]), accountEnabled: true } };
      return { ok: false, status: 404 };
    },
  };
}

function writerFor(store) {
  const deletes = [];
  return {
    deletes,
    async write(_version, path, request) {
      assert.equal(request.method, 'DELETE');
      const base = Object.keys(store).find((prefix) => path.startsWith(`${prefix}/`));
      store[base].delete(path.slice(base.length + 1));
      deletes.push(path);
      return { ok: true, status: 204, body: null };
    },
    async read(_version, path) {
      const base = Object.keys(store).find((prefix) => path.startsWith(`${prefix}/`));
      const item = store[base]?.get(path.slice(base.length + 1));
      return item ? { ok: true, status: 200, body: structuredClone(item) } : { ok: false, status: 404, body: null };
    },
  };
}

const governor = { async acquire() {}, observeRetryAfter() {} };

function planned(store, resourceType, path, id) {
  const payload = store[path].get(id);
  return {
    naturalKey: NATURAL_KEYS[id] ?? `${resourceType}:${payload.displayName}`, resourceType, verb: 'delete', targetId: id,
    blastRadius: 'tenant-lockout', payload, references: [], live: { targetId: id, payload },
  };
}

/** One delete through applyWave with the evidence a production run has; `omit` drops one input. */
async function run(store, resource, { omit = null, lockoutGate, inventory = readinessInventory(store), mode = 'enforce' } = {}) {
  const writer = writerFor(store);
  const gate = lockoutGate ?? breakGlassLockoutGate({ accounts, inventory, now: NOW });
  const result = await applyWave(writer, governor, [resource], {
    targetTenant: 'fixture', mode,
    deletionGuardOptions: { breakGlassUserIds: [BG1, BG2], keelAppIds: [], caPolicies: [...store[CA_PATH].values()] },
    ...(omit === 'lockoutGate' ? {} : { lockoutGate: gate }),
    ...(omit === 'signInPathGate' ? {} : { signInPathGate: { reader: readerFor(store), protectedPrincipalIds: [BG1, BG2] } }),
  });
  return { result, writer };
}

test('pass: a Conditional Access policy, an unused named location and a staff role assignment are deleted', async () => {
  const store = tenant();
  const policy = await run(store, planned(store, 'conditionalAccessPolicy', CA_PATH, 'ca-legacy'));
  assert.deepEqual(policy.result.skipped, []);
  assert.deepEqual(policy.result.failed, [], 'the closing sign-in path comparison expects exactly this policy gone');
  assert.deepEqual(policy.result.applied, [{ naturalKey: NATURAL_KEYS['ca-legacy'], targetId: 'ca-legacy' }]);
  assert.deepEqual(policy.writer.deletes, [`${CA_PATH}/ca-legacy`]);

  const location = await run(store, planned(store, 'namedLocation', LOCATION_PATH, 'loc-old'));
  assert.deepEqual([location.result.skipped, location.result.failed], [[], []]);
  assert.deepEqual(location.writer.deletes, [`${LOCATION_PATH}/loc-old`]);

  const role = await run(store, planned(store, 'roleAssignment', ROLE_PATH, 'ra-staff'));
  assert.deepEqual([role.result.skipped, role.result.failed], [[], []]);
  assert.deepEqual(role.writer.deletes, [`${ROLE_PATH}/ra-staff`]);
});

test('pass in a dry run sends nothing and leaves the closing comparison clean', async () => {
  const store = tenant();
  const { result, writer } = await run(store, planned(store, 'conditionalAccessPolicy', CA_PATH, 'ca-legacy'), { mode: 'dry-run' });
  assert.deepEqual([result.skipped, result.failed], [[], []]);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(writer.deletes, []);
});

test('missing input: each one refuses the delete and names what was missing', async () => {
  const cases = [
    ['no break-glass readiness', { omit: 'lockoutGate' }, /break-glass readiness was not loaded for this run/],
    ['readiness could not be read', { lockoutGate: closedLockoutGate('break-glass readiness could not be read: db down') }, /break-glass readiness after the delete is not established: break-glass readiness could not be read: db down/],
    ['no break-glass accounts registered', { lockoutGate: breakGlassLockoutGate({ configured: false }) }, /break-glass accounts are not configured for this tenant/],
    ['role inventory not covered', { inventoryChange: (inventory) => ({ ...inventory, roleAssignment: { status: 'unavailable', resources: [], observedAt: null } }) }, /newest collection of roleAssignment is incomplete/],
    ['object not in the newest collection', { inventoryChange: (inventory) => ({ ...inventory, roleAssignment: covered(inventory.roleAssignment.resources.filter((entry) => entry.payload.id !== 'ra-staff')) }) }, /not in the newest collection of roleAssignment/],
    ['user inventory unknown', { inventoryChange: (inventory) => ({ ...inventory, user: { status: 'unavailable', resources: [], observedAt: null } }) }, /break-glass readiness is unknown after the delete .*user-inventory-unavailable/],
    ['no sign-in path gate', { omit: 'signInPathGate' }, /the sign-in path gate was not available for this run/],
  ];
  for (const [name, { inventoryChange, ...options }, expected] of cases) {
    const store = tenant();
    const inventory = inventoryChange ? inventoryChange(readinessInventory(store)) : undefined;
    const { result, writer } = await run(store, planned(store, 'roleAssignment', ROLE_PATH, 'ra-staff'), { ...options, ...(inventory ? { inventory } : {}) });
    assert.deepEqual(writer.deletes, [], name);
    assert.equal(result.skipped.length, 1, name);
    assert.match(result.skipped[0].reason, /^refusing to delete tenant-lockout resource: /, name);
    assert.match(result.skipped[0].reason, expected, name);
  }
});

test('missing input: no target id, or a policy the sign-in path read does not hold', async () => {
  const store = tenant();
  const gate = breakGlassLockoutGate({ accounts, inventory: readinessInventory(store), now: NOW });
  const signInPath = await recordSignInPath(readerFor(store), { protectedPrincipalIds: [BG1, BG2] });
  assert.match(await lockoutDeleteRefusal({ resourceType: 'roleAssignment', naturalKey: NATURAL_KEYS['ra-staff'], targetId: null }, { lockoutGate: gate, signInPath }),
    /the object's id in the target tenant is unknown/);

  // The readiness inventory still holds the policy, but the live read does not.
  store[CA_PATH].delete('ca-legacy');
  const stale = await recordSignInPath(readerFor(store), { protectedPrincipalIds: [BG1, BG2] });
  assert.match(await lockoutDeleteRefusal({ resourceType: 'conditionalAccessPolicy', naturalKey: NATURAL_KEYS['ca-legacy'], targetId: 'ca-legacy' }, { lockoutGate: gate, signInPath: stale }),
    /the policy is not in the sign-in path read/);
});

test('a named location a Conditional Access policy still uses is refused', async () => {
  const store = tenant();
  const { result, writer } = await run(store, planned(store, 'namedLocation', LOCATION_PATH, 'loc-office'));
  assert.deepEqual(writer.deletes, []);
  assert.match(result.skipped[0].reason, /the sign-in path still uses this object after the delete \(Block outside the office\)/);
});

test('lockout: deleting a break-glass account\'s Global Administrator assignment is refused, nothing is sent', async () => {
  const store = tenant();
  const { result, writer } = await run(store, planned(store, 'roleAssignment', ROLE_PATH, 'ra-bg1'));
  assert.deepEqual(writer.deletes, []);
  assert.equal(result.applied.length, 0);
  assert.match(result.skipped[0].reason, /break-glass readiness is not-ready after the delete/);
  assert.match(result.skipped[0].reason, /BG1: privilegedAccessPath fail \(no-active-global-administrator\)/);

  // When the stored collection wrongly shows BG1 with a second Global
  // Administrator assignment, readiness passes, but the sign-in path gate read
  // live still refuses: a protected account loses its assignment.
  const inventory = readinessInventory(store);
  inventory.roleAssignment = covered([
    ...inventory.roleAssignment.resources,
    { naturalKey: 'roleAssignment:GlobalAdministrator@BG1-second', payload: { id: 'ra-bg1-second', principalId: BG1, roleDefinitionId: GA, directoryScopeId: '/' } },
  ]);
  const second = await run(store, planned(store, 'roleAssignment', ROLE_PATH, 'ra-bg1'), { inventory });
  assert.deepEqual(second.writer.deletes, []);
  assert.match(second.result.skipped[0].reason, /the delete changes the sign-in path of a protected account \(roleAssignments\)/);
});

test('lockout: the second of two deletes that together remove every Global Administrator assignment of a break-glass account is refused', async () => {
  const store = tenant();
  const inventory = readinessInventory(store);
  inventory.roleAssignment = covered([
    ...inventory.roleAssignment.resources,
    { naturalKey: 'roleAssignment:GlobalAdministrator@BG1-group', payload: { id: 'ra-bg1-extra', principalId: BG1, roleDefinitionId: GA, directoryScopeId: '/' } },
  ]);
  const gate = breakGlassLockoutGate({ accounts, inventory, now: NOW });
  const signInPath = await recordSignInPath(readerFor(store), { protectedPrincipalIds: [BG1, BG2] });
  const first = { resourceType: 'roleAssignment', naturalKey: 'roleAssignment:GlobalAdministrator@BG1-group', targetId: 'ra-bg1-extra' };
  assert.equal(gate.evaluate({ operation: 'delete', ...first }).allowed, true, 'BG1 still holds its first assignment');
  const verdict = gate.evaluate({ operation: 'delete', ...{ resourceType: 'roleAssignment', naturalKey: NATURAL_KEYS['ra-bg1'], targetId: 'ra-bg1' }, earlierDeletes: [first] });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /BG1: privilegedAccessPath fail/);
  assert.match(await lockoutDeleteRefusal({ resourceType: 'roleAssignment', naturalKey: NATURAL_KEYS['ra-bg1'], targetId: 'ra-bg1' }, { lockoutGate: gate, signInPath, earlierDeletes: [first] }),
    /break-glass readiness is not-ready after the delete/);
});
