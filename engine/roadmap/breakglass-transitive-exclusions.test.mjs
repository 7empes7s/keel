/**
 * Gap D5: break-glass Conditional Access exclusions through (nested) groups.
 *
 * Scheduled collection reads, read-only, the transitive members of every group a
 * Conditional Access policy names in its user conditions. Break-glass readiness
 * then reports the policy-exclusions dimension as pass or fail instead of
 * unknown. A failed membership read keeps it unknown.
 *
 * Fixture reader and isolated test database only; no tenant is read or written.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { collectSnapshot, conditionalAccessGroupIds } from '../collect/snapshot.mjs';
import { loadBreakGlassReadiness, registerBreakGlassAccount } from '../safety/breakGlassReadiness.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { COLLECT_RELATIONSHIPS } from '../../cli/keel-collect.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const BG = 'b9000000-0000-4000-8000-0000000000d5';
const OTHER = 'a0000000-0000-4000-8000-0000000000d5';
const OUTER = 'e9000000-0000-4000-8000-0000000000e1';
const INNER = 'e9000000-0000-4000-8000-0000000000e2';

const ok = (items) => ({ items, pages: 1, status: 200, capped: false, error: null });
const denied = { items: undefined, pages: 0, status: 403, capped: false, error: { status: 403, code: 'Authorization_RequestDenied' } };
const asUser = (id) => ({ id, '@odata.type': '#microsoft.graph.user' });
const asGroup = (id) => ({ id, '@odata.type': '#microsoft.graph.group' });

/**
 * One enabled policy for all users. `exclusion` is how the break-glass account is
 * left out: 'direct' (excludeUsers), 'nested' (excluded group OUTER contains group
 * INNER, which contains the account), 'none' (OUTER holds someone else),
 * 'read-fails' (OUTER's nested membership cannot be read).
 */
function fixtureReader(exclusion) {
  const calls = [];
  const users = exclusion === 'direct'
    ? { includeUsers: ['All'], excludeUsers: [BG] }
    : { includeUsers: ['All'], excludeGroups: [OUTER.toUpperCase()] };
  return {
    calls,
    async collect(version, path) {
      calls.push(path);
      if (path.startsWith('/identity/conditionalAccess/policies')) {
        return ok([{ id: 'ca-1', displayName: 'Require MFA for all', state: 'enabled', conditions: { users }, grantControls: { builtInControls: ['mfa'] } }]);
      }
      if (path === '/groups' || path.startsWith('/groups?')) {
        return ok([
          { id: OUTER, displayName: 'Emergency exclusions', mailNickname: 'emergency-exclusions' },
          { id: INNER, displayName: 'Emergency accounts', mailNickname: 'emergency-accounts' },
        ]);
      }
      if (path === '/users' || path.startsWith('/users?')) {
        return ok([
          { id: BG, displayName: 'Emergency 1', userPrincipalName: 'bg1@contoso.onmicrosoft.com' },
          { id: OTHER, displayName: 'Other', userPrincipalName: 'other@contoso.onmicrosoft.com' },
        ]);
      }
      if (path === `/groups/${OUTER}/members?$select=id`) return ok(exclusion === 'none' ? [asUser(OTHER)] : [asGroup(INNER)]);
      if (path === `/groups/${INNER}/members?$select=id`) return ok([asUser(BG)]);
      if (path === `/groups/${OUTER}/transitiveMembers?$select=id`) {
        if (exclusion === 'read-fails') return denied;
        return ok(exclusion === 'none' ? [asUser(OTHER)] : [asGroup(INNER), asUser(BG)]);
      }
      if (path.includes('transitiveMembers')) throw new Error(`unexpected nested membership read ${path}`);
      return ok([]);
    },
  };
}

async function exclusionAfterCollect(t, exclusion) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = `sha256:bg-transitive-${exclusion}`;
  const { rows: [admin] } = await client.query('INSERT INTO principal(email) VALUES ($1) RETURNING *', [`bg-d5-${exclusion}-${process.pid}-${Date.now()}@example.invalid`]);
  await grantRole(client, { principalId: admin.id, role: 'admin', grantedBy: 'fixture', activeFrom: new Date(Date.now() - 60_000) });
  await registerBreakGlassAccount(client, { tenantRef, actor: admin.id, accountId: BG, label: 'bg1@contoso.onmicrosoft.com' });
  const reader = fixtureReader(exclusion);
  const result = await collectSnapshot(client, { reader, tenantRef, tenantId: 'tid', relationships: COLLECT_RELATIONSHIPS });
  assert.equal(result.coverageDigest.conditionalAccessPolicy.outcome, 'complete');
  const report = await loadBreakGlassReadiness(client, { tenantRef, now: new Date() });
  assert.equal(report.accounts.length, 1);
  return { dimension: report.accounts[0].dimensions.policyExclusions, result, reader };
}

test('only groups a Conditional Access policy names get a nested membership read', () => {
  const canonical = [
    { resourceType: 'conditionalAccessPolicy', payload: { conditions: { users: { excludeGroups: [OUTER.toUpperCase()], includeGroups: [INNER] } } } },
    { resourceType: 'conditionalAccessPolicy', payload: { conditions: { users: { includeUsers: ['All'], excludeGroups: [OUTER] } } } },
    { resourceType: 'group', payload: { conditions: { users: { excludeGroups: ['not-a-policy'] } } } },
  ];
  assert.deepEqual(conditionalAccessGroupIds(canonical), [OUTER, INNER].sort());
  assert.equal(COLLECT_RELATIONSHIPS.conditionalAccessTransitive, true);
});

test('a direct exclusion passes', async (t) => {
  const { dimension, reader } = await exclusionAfterCollect(t, 'direct');
  assert.deepEqual([dimension.status, dimension.reason], ['pass', 'excluded-from-every-enforced-policy']);
  assert.ok(!reader.calls.some((path) => path.includes('transitiveMembers')), 'no policy names a group, so no nested read');
});

test('an exclusion through a nested group passes once the nested membership is read', async (t) => {
  const { dimension, result, reader } = await exclusionAfterCollect(t, 'nested');
  assert.deepEqual([dimension.status, dimension.reason], ['pass', 'excluded-from-every-enforced-policy']);
  assert.deepEqual(result.relationshipsByFamily.transitiveMember, { complete: 1 });
  // Only the group the policy names is expanded.
  assert.deepEqual(reader.calls.filter((path) => path.includes('transitiveMembers')), [`/groups/${OUTER}/transitiveMembers?$select=id`]);
});

test('an account the excluded group does not hold fails', async (t) => {
  const { dimension } = await exclusionAfterCollect(t, 'none');
  assert.equal(dimension.status, 'fail');
});

test('a failed nested membership read stays unknown', async (t) => {
  const { dimension, result } = await exclusionAfterCollect(t, 'read-fails');
  assert.deepEqual([dimension.status, dimension.reason], ['unknown', 'policy-treatment-unknown']);
  assert.deepEqual(result.relationshipsByFamily.transitiveMember, { failed: 1 });
});
