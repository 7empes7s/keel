/**
 * Security audit run 2, finding 1: a group member restore must never take a
 * break-glass account out of the group that makes it Global Administrator or out
 * of a Conditional Access exclusion group, and member writes that can change
 * break-glass readiness go through the lockout gate with the proposed membership.
 *
 * Pure: real planner and gate, no database, no Microsoft.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { planRelationshipOperations } from '../restore/relationshipWriter.mjs';
import {
  conditionalAccessGroupIds, gateRelationshipOperations, privilegedGroupIds, protectedEdgePrincipalIds, withProposedMembership,
} from './edgeLockoutGate.mjs';
import { GLOBAL_ADMINISTRATOR_TEMPLATE_ID as GA } from './protectedPrincipals.mjs';

const NOW = new Date('2026-10-20T12:00:00Z');
const BG1 = 'b0000000-0000-0000-0000-00000000b6b1';
const BG2 = 'b0000000-0000-0000-0000-00000000b6b2';
const DIRECT = 'd0000000-0000-0000-0000-0000000000d1';
const OTHER = 'c0000000-0000-0000-0000-0000000000c1';
const GA_GROUP = 'a0000000-0000-0000-0000-0000000000a1';
const EXCL_GROUP = 'e0000000-0000-0000-0000-0000000000e1';
const PLAIN_GROUP = 'f0000000-0000-0000-0000-0000000000f1';
const NESTED = '90000000-0000-0000-0000-000000000091';

// The live target as the restore re-reads it: GA held by a role-assignable group and by one user directly.
const targetResources = [
  { resourceType: 'roleAssignment', naturalKey: `roleAssignment:roleDefinition:${GA}@group:ga-admins@/`, payload: { roleDefinitionId: GA, principalId: GA_GROUP, directoryScopeId: '/' } },
  { resourceType: 'roleAssignment', naturalKey: `roleAssignment:roleDefinition:${GA}@user:direct@/`, payload: { roleDefinitionId: GA, principalId: DIRECT, directoryScopeId: '/' } },
  { resourceType: 'group', naturalKey: 'group:ga-admins', sourceId: GA_GROUP, payload: { id: GA_GROUP, isAssignableToRole: true } },
  { resourceType: 'group', naturalKey: 'group:ca-exclusions', sourceId: EXCL_GROUP, payload: { id: EXCL_GROUP } },
  { resourceType: 'group', naturalKey: 'group:plain', sourceId: PLAIN_GROUP, payload: { id: PLAIN_GROUP } },
  { resourceType: 'user', naturalKey: 'user:bg1', sourceId: BG1 },
  { resourceType: 'user', naturalKey: 'user:direct', sourceId: DIRECT },
  { resourceType: 'user', naturalKey: 'user:other', sourceId: OTHER },
  {
    resourceType: 'conditionalAccessPolicy', naturalKey: 'conditionalAccessPolicy:Require MFA',
    payload: { state: 'enabled', conditions: { users: { includeUsers: ['All'], excludeGroups: [EXCL_GROUP.toUpperCase()] } } },
  },
];
const keyById = new Map(targetResources.filter((r) => r.sourceId).map((r) => [r.sourceId, r.naturalKey]));
const idByKey = new Map([...keyById].map(([id, key]) => [key, id]));

/** Plans the member set of `parentKey` back to `desiredKeys` from the live `liveIds`. */
function planMembers(parentKey, desiredKeys, liveIds, protectedPrincipalIds) {
  return planRelationshipOperations({
    parents: [{ naturalKey: parentKey, verb: 'update', liveTargetId: idByKey.get(parentKey), groupTypes: [] }],
    desired: new Map([[`${parentKey}|member`, { outcome: 'complete', targets: desiredKeys.map((key) => ({ targetNaturalKey: key, targetId: `src-${key}` })) }]]),
    live: new Map([[`${parentKey}|member`, { outcome: 'complete', targets: liveIds.map((id) => ({ targetId: id })) }]]),
    resolveTargetId: (key) => idByKey.get(key) ?? null,
    naturalKeyForTargetId: (id) => keyById.get(id) ?? null,
    protectedPrincipalIds,
  });
}

test('the audit repro: break-glass is not removed from the group that holds Global Administrator', () => {
  const protectedIds = protectedEdgePrincipalIds(targetResources, [BG1]);
  assert.ok(protectedIds.includes(GA_GROUP.toLowerCase()) && protectedIds.includes(BG1));
  const plan = planMembers('group:ga-admins', ['user:other'], [BG1, OTHER, DIRECT], protectedIds);
  assert.deepEqual(plan.operations.filter((op) => op.action === 'remove'), [], 'no member of a Global Administrator group is removed');
  assert.equal(plan.refusals.length, 2);
  assert.ok(plan.refusals.every((refusal) => /protected-principal/.test(refusal.reason)));
});

test('an ordinary member of a Global Administrator group is not removed either: it holds GA through the group', () => {
  const plan = planMembers('group:ga-admins', [], [NESTED], protectedEdgePrincipalIds(targetResources, []));
  assert.deepEqual(plan.operations, []);
  assert.match(plan.refusals[0].reason, /holds Global Administrator/);
  const plain = planMembers('group:plain', [], [NESTED], protectedEdgePrincipalIds(targetResources, []));
  assert.deepEqual(plain.operations.map((op) => op.action), ['remove'], 'the same member leaves a group with no role');
});

test('mutation check: without the registered break-glass ids and the group rule the removal was planned', () => {
  const plan = planMembers('group:ga-admins', ['user:other'], [BG1, OTHER], []);
  assert.deepEqual(plan.operations.map((op) => `${op.action}:${op.targetId}`), [`remove:${BG1}`]);
});

test('a registered break-glass account is never removed from any group, even one with no role', () => {
  const plan = planMembers('group:plain', [], [BG1, OTHER], protectedEdgePrincipalIds(targetResources, [BG1]));
  assert.deepEqual(plan.operations.map((op) => `${op.action}:${op.targetNaturalKey}`), ['remove:user:other']);
  assert.match(plan.refusals[0].reason, /protected-principal/);
});

test('which groups are Conditional Access groups and which hold a role', () => {
  assert.deepEqual([...conditionalAccessGroupIds(targetResources)], [EXCL_GROUP]);
  const privileged = privilegedGroupIds(targetResources);
  assert.ok(privileged.has(GA_GROUP));
  assert.ok(!privileged.has(EXCL_GROUP) && !privileged.has(PLAIN_GROUP));
  const assignableOnly = privilegedGroupIds([{ resourceType: 'group', sourceId: 'G-NEW', payload: { isAssignableToRole: true } }]);
  assert.ok(assignableOnly.has('g-new'), 'a role-assignable group with no role yet still counts');
});

// --- the lockout gate on member writes ---

const covered = (resources) => ({ status: 'covered', resources, observedAt: NOW.toISOString() });
const accounts = [BG1, BG2].map((accountId, i) => ({
  accountId, label: `BG${i + 1}`, validationIntervalDays: 90, rotationIntervalDays: null,
  registeredAt: '2026-09-01T00:00:00Z', lastValidatedAt: '2026-10-15T00:00:00Z', lastRotatedAt: null,
  methodEvidence: { basis: 'observed', occurredAt: '2026-10-15T00:00:00Z', methods: ['fido2'] },
}));
const inventory = {
  user: covered(accounts.map((a) => ({ naturalKey: `user:${a.label}`, payload: { id: a.accountId, userPrincipalName: `${a.label}@contoso.example`, accountEnabled: true, userType: 'Member', onPremisesSyncEnabled: null } }))),
  domain: covered([{ naturalKey: 'domain:contoso.example', payload: { id: 'contoso.example', authenticationType: 'Managed' } }]),
  conditionalAccessPolicy: covered([{ naturalKey: 'conditionalAccessPolicy:Require MFA', payload: targetResources.at(-1).payload }]),
  roleAssignment: covered(accounts.map((a) => ({ naturalKey: `roleAssignment:GA@${a.label}`, payload: { principalId: a.accountId, roleDefinitionId: GA, directoryScopeId: '/' } }))),
  roleEligibilitySchedule: covered([]),
  authenticationMethodsPolicy: covered([{ naturalKey: 'authenticationMethodsPolicy:x', payload: { authenticationMethodConfigurations: [{ id: 'Fido2', state: 'enabled' }] } }]),
};
// Both break-glass accounts are excluded from the MFA policy through the exclusion group.
const groupMembers = (group, account) => (group === EXCL_GROUP ? [BG1, BG2].includes(account) : null);
const readyInputs = { configured: true, accounts, inventory, groupMembers, now: NOW };
const parentTargetIds = new Map([['group:ca-exclusions', EXCL_GROUP], ['group:ga-admins', GA_GROUP], ['group:plain', PLAIN_GROUP]]);
const memberOp = (parentNaturalKey, action, targetNaturalKey, targetId) => ({ parentNaturalKey, family: 'member', action, targetNaturalKey, targetId });
const gate = (operations, inputs = readyInputs, extra = {}) => gateRelationshipOperations({
  operations, parentTargetIds, caGroupIds: conditionalAccessGroupIds(targetResources), privilegedGroupIds: privilegedGroupIds(targetResources), inputs, ...extra,
});

test('removing an ordinary user from a Conditional Access exclusion group runs when break-glass stays ready', () => {
  const ops = [memberOp('group:ca-exclusions', 'remove', 'user:other', OTHER)];
  assert.deepEqual(gate(ops), { operations: ops, refusals: [] });
});

test('removing a nested group from an exclusion group is withheld: break-glass may leave with it', () => {
  const ops = [memberOp('group:ca-exclusions', 'remove', 'group:nested', NESTED), memberOp('group:plain', 'add', 'user:other', OTHER)];
  const result = gate(ops);
  assert.deepEqual(result.operations, [ops[1]], 'a write on an unrelated group still runs');
  assert.equal(result.refusals.length, 1);
  assert.match(result.refusals[0].reason, /^lockout-gate: .*not-ready|^lockout-gate: .*unknown/);
});

test('member writes on Conditional Access or role-holding groups are withheld when break-glass is not configured', () => {
  const ops = [
    memberOp('group:ca-exclusions', 'add', 'user:other', OTHER),
    memberOp('group:ga-admins', 'remove', 'user:other', OTHER),
    memberOp('group:plain', 'remove', 'user:other', OTHER),
  ];
  const result = gate(ops, { configured: false, accounts: [], inventory: {}, groupMembers: () => null, now: NOW });
  assert.deepEqual(result.operations, [ops[2]]);
  assert.equal(result.refusals.length, 2);
  assert.ok(result.refusals.every((refusal) => /break-glass accounts are not configured/.test(refusal.reason)));
});

test('when break-glass accounts cannot be read, every removal is refused (fails closed)', () => {
  const ops = [memberOp('group:plain', 'add', 'user:other', OTHER), memberOp('group:plain', 'remove', 'user:direct', DIRECT)];
  const result = gate(ops, null, { loadError: 'database unavailable' });
  assert.deepEqual(result.operations, [ops[0]]);
  assert.match(result.refusals[0].reason, /could not be read \(database unavailable\)/);
});

test('proposed membership: direct adds and removes, other users, and nested groups', () => {
  const ops = [
    { ...memberOp('g', 'remove', 'user:bg1', BG1), parentId: 'g' },
    { ...memberOp('h', 'add', 'user:bg2', BG2), parentId: 'h' },
    { ...memberOp('i', 'remove', 'user:other', OTHER), parentId: 'i' },
    { ...memberOp('j', 'remove', null, NESTED), parentId: 'j' },
  ];
  const lookup = withProposedMembership(() => true, ops);
  assert.equal(lookup('g', BG1), null, 'removed directly: may still be a member through a nested group');
  assert.equal(lookup('h', BG2), true);
  assert.equal(lookup('i', BG1), true, 'another user leaving changes nothing');
  assert.equal(lookup('j', BG1), null, 'an object of unknown type leaving makes membership unknown');
  assert.equal(withProposedMembership(() => false, ops)('j', BG1), false, 'a non-member stays a non-member when something leaves');
  assert.equal(lookup('untouched', BG1), true);
});
