import { strict as assert } from 'node:assert';
import { compareSignInPaths, snapshotSignInPath } from './signInPathGate.mjs';

const protectedPrincipalIds = ['break-glass-1', 'break-glass-2'];

function fixture() {
  return {
    conditionalAccessPolicies: [
      {
        id: 'ca-1',
        displayName: 'Require phishing-resistant MFA',
        state: 'enabledForReportingButNotEnforced',
        modifiedDateTime: '2026-09-08T00:00:00Z',
        conditions: { users: { includeUsers: ['break-glass-2', 'break-glass-1'] } },
        grantControls: { operator: 'OR', builtInControls: ['mfa', 'compliantDevice'] },
      },
      {
        id: 'ca-2',
        displayName: 'Block legacy authentication',
        state: 'enabledForReportingButNotEnforced',
        conditions: { users: { includeUsers: ['All'] } },
        grantControls: { operator: 'OR', builtInControls: ['block'] },
      },
    ],
    authenticationMethodsPolicy: {
      id: 'authenticationMethodsPolicy',
      lastModifiedDateTime: '2026-09-08T00:00:00Z',
      authenticationMethodConfigurations: [
        { id: 'fido2', state: 'enabled' },
        { id: 'microsoftAuthenticator', state: 'enabled' },
      ],
    },
    securityDefaults: {
      id: 'identitySecurityDefaultsEnforcementPolicy',
      isEnabled: true,
      modifiedDateTime: '2026-09-08T00:00:00Z',
    },
    users: {
      'break-glass-1': { id: 'break-glass-1', accountEnabled: true },
      'break-glass-2': { id: 'break-glass-2', accountEnabled: true },
    },
    roleAssignments: [
      { id: 'role-1', principalId: 'break-glass-1', roleDefinitionId: 'global-admin', directoryScopeId: '/' },
      { id: 'role-2', principalId: 'break-glass-2', roleDefinitionId: 'global-admin', directoryScopeId: '/' },
    ],
  };
}

function readerFor(state) {
  return {
    async collect(version, path) {
      assert.equal(version, 'v1.0');
      if (path === '/identity/conditionalAccess/policies') {
        return { items: state.conditionalAccessPolicies, capped: false, error: null };
      }
      if (path.startsWith('/roleManagement/directory/roleAssignments?')) {
        const filter = new URLSearchParams(path.split('?', 2)[1]).get('$filter');
        const principalId = filter.match(/'(.+)'/)[1];
        return {
          items: state.roleAssignments.filter((assignment) => assignment.principalId === principalId),
          capped: false,
          error: null,
        };
      }
      throw new Error(`unexpected collection path ${path}`);
    },
    async get(version, path) {
      assert.equal(version, 'v1.0');
      if (path === '/policies/authenticationMethodsPolicy') {
        return { ok: true, status: 200, body: state.authenticationMethodsPolicy };
      }
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') {
        return { ok: true, status: 200, body: state.securityDefaults };
      }
      if (path.startsWith('/users/')) {
        const principalId = decodeURIComponent(path.slice('/users/'.length, path.indexOf('?')));
        const user = state.users[principalId];
        return user
          ? { ok: true, status: 200, body: user }
          : { ok: false, status: 404, error: 'not found' };
      }
      throw new Error(`unexpected get path ${path}`);
    },
  };
}

async function snapshot(state) {
  return snapshotSignInPath(readerFor(state), { protectedPrincipalIds });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const before = await snapshot(fixture());

// An unchanged path passes, including Graph-owned timestamps that can change without a restore.
const unchanged = fixture();
unchanged.conditionalAccessPolicies[0].modifiedDateTime = '2026-09-08T01:00:00Z';
unchanged.authenticationMethodsPolicy.lastModifiedDateTime = '2026-09-08T01:00:00Z';
unchanged.securityDefaults.modifiedDateTime = '2026-09-08T01:00:00Z';
assert.equal(compareSignInPaths(before, await snapshot(unchanged)).allowed, true);

const changedCaPolicy = fixture();
changedCaPolicy.conditionalAccessPolicies[0].grantControls.builtInControls = ['block'];
assert.equal(compareSignInPaths(before, await snapshot(changedCaPolicy)).allowed, false);

const disabledAccount = fixture();
disabledAccount.users['break-glass-1'].accountEnabled = false;
assert.equal(compareSignInPaths(before, await snapshot(disabledAccount)).allowed, false);

const removedDirectoryRole = fixture();
removedDirectoryRole.roleAssignments = removedDirectoryRole.roleAssignments.filter((role) => role.id !== 'role-1');
assert.equal(compareSignInPaths(before, await snapshot(removedDirectoryRole)).allowed, false);

const changedSecurityDefaults = fixture();
changedSecurityDefaults.securityDefaults.isEnabled = false;
assert.equal(compareSignInPaths(before, await snapshot(changedSecurityDefaults)).allowed, false);

// Graph makes no ordering promise for collections or array-valued policy fields.
const reordered = clone(fixture());
reordered.conditionalAccessPolicies.reverse();
reordered.conditionalAccessPolicies[1].conditions.users.includeUsers.reverse();
reordered.conditionalAccessPolicies[1].grantControls.builtInControls.reverse();
reordered.authenticationMethodsPolicy.authenticationMethodConfigurations.reverse();
reordered.roleAssignments.reverse();
assert.equal(compareSignInPaths(before, await snapshot(reordered)).allowed, true);

console.log('signInPathGate.test.mjs — all assertions passed');
