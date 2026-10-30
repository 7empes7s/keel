/**
 * Groups a sign-in rule leaves out that hold only registered emergency accounts reach
 * ScubaGear's rules as exclusions (CapExclusions.Groups), and a result that relied on an
 * exclusion says so.
 *
 * Fixture reader and isolated test database only; no tenant is read or written.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { COLLECT_RELATIONSHIPS } from '../../../cli/keel-collect.mjs';
import { grantRole } from '../../authz/administration.mjs';
import { collectSnapshot } from '../../collect/snapshot.mjs';
import { registerBreakGlassAccount, retireBreakGlassAccount } from '../../safety/breakGlassReadiness.mjs';
import { schemaSql } from '../../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../../test/dbTestHelper.mjs';
import { controlFor } from '../registry.mjs';
import { runComplianceChecks } from '../runChecks.mjs';
import { evaluateControl } from '../evaluate.mjs';
import { emergencyAccessLine, emergencyGroupsFrom, loadScubaSettings, scubaConfigFrom } from './config.mjs';
import { FIXTURE_BACKUPS } from './fixtureTenant.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const BG = 'b9000000-0000-4000-8000-0000000000f1';
const OTHER = 'a0000000-0000-4000-8000-0000000000f1';
const GROUP = 'e9000000-0000-4000-8000-0000000000f1';

const ok = (items) => ({ items, pages: 1, status: 200, capped: false, error: null });
const asUser = (id) => ({ id, '@odata.type': '#microsoft.graph.user' });

/**
 * One rule that blocks legacy sign-in for everyone but the emergency account and
 * GROUP. `members` is who GROUP holds.
 */
function fixtureReader(members) {
  return {
    async collect(version, path) {
      if (path.startsWith('/identity/conditionalAccess/policies')) {
        return ok([{
          id: 'ca-legacy', displayName: 'KEEL-RT-Block legacy sign-in', state: 'enabled',
          conditions: {
            users: { includeUsers: ['All'], excludeUsers: [BG], includeGroups: [], excludeGroups: [GROUP], includeRoles: [], excludeRoles: [],
              includeGuestsOrExternalUsers: null, excludeGuestsOrExternalUsers: null },
            applications: { includeApplications: ['All'], excludeApplications: [] },
            clientAppTypes: ['exchangeActiveSync', 'other'],
          },
          grantControls: { operator: 'OR', builtInControls: ['block'] },
        }]);
      }
      if (path === '/groups' || path.startsWith('/groups?')) return ok([{ id: GROUP, displayName: 'KEEL-RT-Emergency', mailNickname: 'keel-rt-emergency' }]);
      if (path === '/users' || path.startsWith('/users?')) {
        return ok([
          { id: BG, displayName: 'KEEL-RT-Emergency 1', userPrincipalName: 'KEEL-RT-bg1@contoso.example' },
          { id: OTHER, displayName: 'KEEL-RT-Other', userPrincipalName: 'KEEL-RT-other@contoso.example' },
        ]);
      }
      if (path === `/groups/${GROUP}/members?$select=id` || path === `/groups/${GROUP}/transitiveMembers?$select=id`) return ok(members.map(asUser));
      return ok([]);
    },
  };
}

async function tenantWith(t, name, { members, register = true }) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(schemaSql());
  const tenantRef = `sha256:scuba-exclusions-${name}`;
  const { rows: [admin] } = await client.query('INSERT INTO principal(email) VALUES ($1) RETURNING *', [`scuba-${name}-${process.pid}@example.invalid`]);
  await grantRole(client, { principalId: admin.id, role: 'admin', grantedBy: 'fixture', activeFrom: new Date(Date.now() - 60_000) });
  if (register) await registerBreakGlassAccount(client, { tenantRef, actor: admin.id, accountId: BG, label: 'KEEL-RT-bg1@contoso.example' });
  const collected = await collectSnapshot(client, { reader: fixtureReader(members), tenantRef, tenantId: 'tid', relationships: COLLECT_RELATIONSHIPS });
  assert.equal(collected.coverageDigest.conditionalAccessPolicy.outcome, 'complete');
  return { client, tenantRef, admin };
}

const legacyBlock = (client, tenantRef) => runComplianceChecks(client, {
  tenantRef, actor: 'scheduler', controls: [controlFor('scubagear.MS.AAD.1.1v1')],
}).then((result) => result.evaluations[0]);

const note = (evaluation) => evaluation.details.find((detail) => detail.subject === 'Emergency access');

test('a registered account and a group holding only it are passed, and the rule that leaves them out passes', async (t) => {
  const { client, tenantRef } = await tenantWith(t, 'only', { members: [BG] });
  const { scubaConfig, emergencyAccess } = await loadScubaSettings(client, { tenantRef });
  assert.deepEqual(scubaConfig.Aad['MS.AAD.1.1v1'], { CapExclusions: { Users: [BG], Groups: [GROUP] } });
  assert.deepEqual(scubaConfig.Aad['MS.AAD.7.4v1'], { RoleExclusions: { Users: [BG] } });
  assert.equal(emergencyAccess.groupCount, 1);

  const evaluation = await legacyBlock(client, tenantRef);
  assert.equal(evaluation.verdict, 'pass');
  assert.equal(note(evaluation).value, '1 emergency account (KEEL-RT-bg1@contoso.example) and 1 group holding only them');
  assert.ok(!note(evaluation).value.includes(BG));
});

test('a group that also holds someone else is not passed, and the rule fails', async (t) => {
  const { client, tenantRef } = await tenantWith(t, 'mixed', { members: [BG, OTHER] });
  const { scubaConfig, emergencyAccess } = await loadScubaSettings(client, { tenantRef });
  assert.deepEqual(scubaConfig.Aad['MS.AAD.1.1v1'], { CapExclusions: { Users: [BG] } });
  assert.equal(emergencyAccess.groupCount, 0);
  const evaluation = await legacyBlock(client, tenantRef);
  assert.equal(evaluation.verdict, 'fail');
  assert.equal(note(evaluation).ok, false, 'the note says the exclusions did not make it pass');
});

test('with no registered account nothing is passed and there is no note', async (t) => {
  const { client, tenantRef } = await tenantWith(t, 'none', { members: [BG], register: false });
  const { scubaConfig } = await loadScubaSettings(client, { tenantRef });
  assert.deepEqual(scubaConfig.Aad, {});
  const evaluation = await legacyBlock(client, tenantRef);
  assert.equal(evaluation.verdict, 'fail');
  assert.equal(note(evaluation), undefined);
});

test('a retired account is no longer passed, nor is its group', async (t) => {
  const { client, tenantRef, admin } = await tenantWith(t, 'retired', { members: [BG] });
  await retireBreakGlassAccount(client, { tenantRef, actor: admin.id, accountId: BG, reason: 'KEEL-RT- account replaced' });
  assert.deepEqual((await loadScubaSettings(client, { tenantRef })).scubaConfig.Aad, {});
  assert.equal((await legacyBlock(client, tenantRef)).verdict, 'fail');
});

test('a group whose members were last read too long ago is not passed', async (t) => {
  const { client, tenantRef } = await tenantWith(t, 'stale', { members: [BG] });
  const later = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const { scubaConfig } = await loadScubaSettings(client, { tenantRef, now: later });
  assert.deepEqual(scubaConfig.Aad['MS.AAD.1.1v1'], { CapExclusions: { Users: [BG] } });
});

test('a group is an emergency group only when every member Keel read is a registered account', () => {
  const policies = [{ conditions: { users: { excludeGroups: [GROUP.toUpperCase()] } } }];
  const accounts = [{ accountId: BG, label: 'bg' }];
  const groups = (members) => emergencyGroupsFrom({ accounts, policies, membersOf: (group) => (group === GROUP ? members : null) });
  assert.deepEqual(groups(new Set([BG])), [GROUP.toUpperCase(), GROUP].sort(), 'every spelling the policies use');
  assert.deepEqual(groups(new Set([BG, OTHER])), [], 'a group holding anyone else');
  assert.deepEqual(groups(new Set()), [], 'an empty group');
  assert.deepEqual(groups(null), [], 'a group whose members Keel has not read lately');
  assert.deepEqual(emergencyGroupsFrom({ accounts: [], policies, membersOf: () => new Set([BG]) }), [], 'no registered account');
});

test('on the fixture tenant, an emergency group lets the sign-in rules pass, and a mixed one does not', () => {
  const HOUR = 3_600_000;
  const NOW = new Date('2026-06-01T12:00:00.000Z');
  const TENANT = 'sha256:0123456789abcdef';
  const backups = {
    ...FIXTURE_BACKUPS,
    conditionalAccessPolicy: FIXTURE_BACKUPS.conditionalAccessPolicy.map((policy) => ({
      ...policy, conditions: { ...policy.conditions, users: { ...policy.conditions.users, excludeUsers: [BG], excludeGroups: [GROUP] } },
    })),
  };
  const observations = Object.fromEntries(Object.entries(backups).map(([resourceType, resources]) => [resourceType, {
    observation: {
      resourceType, tenantRef: TENANT, completeness: 'complete',
      window: { startedAt: new Date(NOW - 2 * HOUR).toISOString(), endedAt: new Date(NOW - HOUR).toISOString() },
    },
    resources,
  }]));
  const accounts = [{ accountId: BG, label: 'KEEL-RT-bg1@contoso.example' }];
  const check = (policyId, emergencyGroups) => {
    const settings = {
      scubaConfig: scubaConfigFrom({ emergencyAccounts: accounts, emergencyGroups }),
      emergencyAccess: { accountLabels: ['KEEL-RT-bg1@contoso.example'], groupCount: emergencyGroups.length, ids: [BG, ...emergencyGroups] },
    };
    return evaluateControl({ controlId: `scubagear.${policyId}`, tenantRef: TENANT, observations, now: NOW, settings });
  };
  for (const policyId of ['MS.AAD.1.1v1', 'MS.AAD.2.1v1', 'MS.AAD.3.2v2']) {
    assert.equal(check(policyId, []).verdict, 'fail', `${policyId}: the group is not an emergency group`);
    const passed = check(policyId, [GROUP]);
    assert.equal(passed.verdict, 'pass', `${policyId}: the group holds only the emergency account`);
    assert.equal(note(passed).ok, true);
  }
  // A rule that reads no exclusion list gets no note.
  assert.equal(note(check('MS.AAD.7.1v1', [GROUP])), undefined);
  assert.equal(emergencyAccessLine({ ids: ['x'], accountLabels: ['a'], groupCount: 0 }, 'MS.AAD.1.1v1', { scuba_config: { x: '"x"' } }, 'pass'), null,
    'the config itself does not count as naming an account');
});
