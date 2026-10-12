// Gap B4 (Q43 step 10): a soft-deleted user was refused with "retention
// deadline unprovable (no deletedDateTime)" because the deleted-items listing
// named no $select and Graph's default user projection omits deletedDateTime.
// The replan then saw the user nowhere and planned "user create", which is not
// a registered capability. This fixture reader behaves like Graph: it returns
// deletedDateTime only when the listing's $select names it.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildReconciliationPlan } from './reconciliationPlan.mjs';
import { DELETED_ITEM_ROUTES, deletedItemListPath } from './liveState.mjs';
import { EXECUTABLE_MECHANISMS, recoveryGate, softDeleteDeadline } from '../restore/recoveryMechanism.mjs';

const NOW = new Date('2026-10-12T12:00:00Z');
const DELETED_AT = '2026-10-01T08:30:00Z';
const DEADLINE = '2026-10-31T08:30:00.000Z';

const snapshotUser = {
  id: 'u-1', userPrincipalName: 'ada@contoso.example', displayName: 'Ada', accountEnabled: true, userType: 'Member',
};
const deletedUser = { ...snapshotUser, deletedDateTime: DELETED_AT };
const desired = (overrides = {}) => ({
  naturalKey: 'user:ada@contoso.example', resourceType: 'user', sourceId: 'u-1', payload: snapshotUser, references: [], ...overrides,
});

/** Like Graph: a deleted user's deletedDateTime is returned only when $select names it. */
function graphLikeReader({ deletedUsers = [], honourSelect = true } = {}) {
  const calls = [];
  return {
    calls,
    async collect(version, path) {
      calls.push({ version, path });
      const [base, query = ''] = path.split('?');
      const select = new URLSearchParams(query).get('$select');
      if (base === '/users') return { items: [], error: null };
      if (base === DELETED_ITEM_ROUTES.user.list) {
        const items = deletedUsers.map((user) => {
          if (honourSelect && select && select.split(',').includes('deletedDateTime')) return user;
          const { deletedDateTime, ...withoutDeletedDateTime } = user;
          return withoutDeletedDateTime;
        });
        return { items, error: null };
      }
      throw new Error(`unexpected collection: ${path}`);
    },
  };
}

test('the deleted-items route names deletedDateTime and the natural-key fields', () => {
  for (const type of ['user', 'group', 'application']) {
    const path = deletedItemListPath(type);
    const select = new URLSearchParams(path.split('?')[1]).get('$select')?.split(',') ?? [];
    assert.ok(select.includes('id') && select.includes('deletedDateTime'), `${type}: ${path}`);
  }
  assert.ok(deletedItemListPath('user').includes('userPrincipalName'));
  assert.ok(deletedItemListPath('group').includes('mailNickname'));
  assert.ok(deletedItemListPath('application').includes('appId'));
});

test('a soft-deleted user is planned as a soft-delete restore with a computed deadline', async () => {
  const reader = graphLikeReader({ deletedUsers: [deletedUser] });
  const plan = await buildReconciliationPlan(reader, [desired()], { now: NOW });
  const [ada] = plan.resources;
  assert.equal(ada.verb, 'restore-soft-deleted');
  assert.equal(ada.deletedItemId, 'u-1');
  assert.equal(ada.live.payload.deletedDateTime, DELETED_AT, 'the listing carried deletedDateTime');
  assert.equal(ada.recovery.mechanism, 'soft-delete-restore');
  assert.equal(ada.recovery.deadline, DEADLINE);
  assert.equal(ada.recovery.deadline, softDeleteDeadline(deletedUser));
  assert.equal(ada.recovery.retainedId, 'u-1');
  assert.equal(recoveryGate(ada, { now: NOW }), null, 'executable before the deadline');
  assert.ok(reader.calls.some(({ path }) => path === deletedItemListPath('user')), 'the deleted-items read names its $select');
});

test('a deleted user whose UPN changed on deletion is matched by the snapshot sourceId', async () => {
  const renamed = { ...deletedUser, userPrincipalName: 'u-1ada@contoso.example' };
  const plan = await buildReconciliationPlan(graphLikeReader({ deletedUsers: [renamed] }), [desired()], { now: NOW });
  const [ada] = plan.resources;
  assert.equal(ada.verb, 'restore-soft-deleted', 'matched by sourceId, not by the renamed UPN');
  assert.equal(ada.recovery.mechanism, 'soft-delete-restore');
  assert.equal(ada.recovery.retainedId, 'u-1');
  assert.equal(ada.recovery.deadline, DEADLINE);

  // Without a sourceId the natural key is the only match, and it must still work.
  const byKey = await buildReconciliationPlan(graphLikeReader({ deletedUsers: [deletedUser] }), [desired({ sourceId: undefined })], { now: NOW });
  assert.equal(byKey.resources[0].verb, 'restore-soft-deleted');
  assert.equal(byKey.resources[0].recovery.mechanism, 'soft-delete-restore');
});

test('an unprovable deadline is a blocked restore, never a planned "user create"', async () => {
  // A listing that drops deletedDateTime despite the $select (a Graph regression).
  const plan = await buildReconciliationPlan(graphLikeReader({ deletedUsers: [deletedUser], honourSelect: false }), [desired()], { now: NOW });
  const [ada] = plan.resources;
  assert.equal(ada.verb, 'restore-soft-deleted', 'the verb never degrades to create');
  assert.equal(ada.recovery.mechanism, 'refused');
  assert.equal(ada.recovery.verb, 'restore-soft-deleted');
  assert.match(ada.recovery.reason, /unprovable.*deletedDateTime.*\$select/);
  assert.equal(ada.recovery.deadline, null);
  assert.equal(recoveryGate(ada, { now: NOW }).outcome, 'skipped');

  // A user that is neither live nor deleted: "user create" is not registered,
  // so the plan is an explicit manual handoff that applyWave never executes.
  const nowhere = await buildReconciliationPlan(graphLikeReader(), [desired()], { now: NOW });
  const [missing] = nowhere.resources;
  assert.equal(missing.verb, 'create');
  assert.equal(missing.recovery.mechanism, 'manual');
  assert.match(missing.recovery.reason, /user create has no qualified capability.*neither live nor among the deleted items.*nothing is recreated/);
  assert.equal(EXECUTABLE_MECHANISMS.has(missing.recovery.mechanism), false);
  assert.equal(recoveryGate(missing, { now: NOW }).outcome, 'skipped');
});
