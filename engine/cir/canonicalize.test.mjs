import { strict as assert } from 'node:assert';
import { canonicalizeAll, NaturalKeyCollisionError } from './canonicalize.mjs';

const GA_ROLE_TEMPLATE = '62e90394-69f5-4237-9190-012177145e10'; // real Global Administrator template id

const groupA = { id: 'g-a', mailNickname: 'FIN-Admins', displayName: 'Finance Admins', groupTypes: [] };
const groupB = { id: 'g-b', mailNickname: 'Legacy-VPN-Users', displayName: 'Legacy VPN', groupTypes: [] };
const userCloud = { id: 'u-1', userPrincipalName: 'ana@contoso.com', onPremisesSyncEnabled: false };
const namedLoc = { id: 'nl-1', displayName: 'Corp-IPs' };
const roleAssignGA = {
  id: 'ra-1',
  roleDefinitionId: GA_ROLE_TEMPLATE, // resolves via classify()'s WELL_KNOWN/catalog path, not our own index
  principalId: 'u-1',
  directoryScopeId: '/',
};
const caPolicy = {
  id: 'ca-1',
  displayName: 'Require-MFA-Admins',
  state: 'enabled',
  conditions: {
    users: { includeRoles: [GA_ROLE_TEMPLATE], excludeGroups: ['g-b'] },
    locations: { includeLocations: ['nl-1'] },
  },
};

const collected = [
  ['user', [userCloud]],
  ['authenticationStrengthPolicy', []],
  ['group', [groupA, groupB]],
  ['roleAssignment', [roleAssignGA]],
  ['namedLocation', [namedLoc]],
  ['conditionalAccessPolicy', [caPolicy]],
];

const resources = canonicalizeAll(collected);
const byKey = Object.fromEntries(resources.map((r) => [r.naturalKey, r]));

// Groups have no outbound references — leaf nodes, per plan design (no membership collected).
assert.equal(byKey['group:FIN-Admins'].references.length, 0);

// namedLocation has no outbound references either.
assert.equal(byKey['namedLocation:Corp-IPs'].references.length, 0);

// roleAssignment's key is the composite built in Task 1, using pass-1 symbols.
const raKey = 'roleAssignment:global:GlobalAdministrator@user:ana@contoso.com@/';
assert.ok(byKey[raKey], `expected ${raKey} in ${Object.keys(byKey).join(', ')}`);

// conditionalAccessPolicy resolves its role (global constant), group (tenant
// symbol), and namedLocation (tenant symbol) references distinctly.
const ca = byKey['conditionalAccessPolicy:Require-MFA-Admins'];
const bySymbol = Object.fromEntries(ca.references.map((r) => [r.field, r]));
assert.equal(bySymbol['conditions.users.includeRoles[0]'].klass, 'globalConstant');
assert.equal(bySymbol['conditions.users.excludeGroups[0]'].symbol, 'group:Legacy-VPN-Users');
assert.equal(bySymbol['conditions.locations.includeLocations[0]'].symbol, 'namedLocation:Corp-IPs');

// blastRadius / restorePriority / fidelity come from the plan's fixed tables, not
// guessed per-object.
assert.equal(ca.blastRadius, 'tenant-lockout');
assert.equal(ca.restorePriority, 150);
assert.equal(byKey['group:FIN-Admins'].provenance.fidelity, 'full');
assert.equal(byKey['user:ana@contoso.com'].provenance.fidelity, 'read-only');

// Collision: two groups sharing a mailNickname is a hard error, not a silent drop.
assert.throws(
  () =>
    canonicalizeAll([
      ['group', [
        { id: 'g-x', mailNickname: 'DUPE', displayName: 'One' },
        { id: 'g-y', mailNickname: 'DUPE', displayName: 'Two' },
      ]],
    ]),
  NaturalKeyCollisionError,
);

console.log('canonicalize.test.mjs — all assertions passed');
