import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { permissionsSummary } from '../content/sharepointSites.mjs';
import { drivePermissionExposure } from '../content/permissionExposure.mjs';
import { compareDriveExposure, compareSiteExposure, exposureActivity, levelOf, siteExposure } from './sharingExposure.mjs';

// Who can reach a site, compared between two backups (#968). Summaries are built by the
// backup's own permissionsSummary from SharePoint REST answers in their real shape
// (as in engine/content/sharepointSites.test.mjs), so a change to the saved shape breaks here.

const EVERYONE = { id: 4, title: 'Everyone', loginName: 'c:0(.s|true', principalType: 4 };
const ALL_USERS = { id: 5, title: 'Everyone except external users', loginName: 'c:0-.f|rolemanager|spo-grid-all-users/11111111-2222-4333-8444-555555555555', principalType: 4 };
const ADA = { id: 7, title: 'Ada Admin', loginName: 'i:0#.f|membership|ada@contoso.test', principalType: 1 };
const GUEST = (n) => ({ id: 100 + n, title: `Guest ${n}`, loginName: `i:0#.f|membership|guest${n}_fabrikam.test#ext#@contoso.onmicrosoft.com`, principalType: 1 });
const link = (n, kind = 'AnonymousView') => ({ id: 200 + n, title: `SharingLinks.0b0c${n}.${kind}.f00d${n}`, members: [] });

function site({ everyone = [], links = 0, guests = 0, owners = [ADA], inherits = false } = {}) {
  const groups = [
    { id: 3, title: 'Finance Owners', members: owners },
    { id: 9, title: 'Finance Visitors', members: Array.from({ length: guests }, (_, n) => GUEST(n)) },
    ...Array.from({ length: links }, (_, n) => link(n)),
  ];
  const roleAssignments = inherits ? null : [
    { principalId: 3, member: { id: 3, title: 'Finance Owners', principalType: 8 }, roles: [{ name: 'Full Control' }] },
    { principalId: 9, member: { id: 9, title: 'Finance Visitors', principalType: 8 }, roles: [{ name: 'Read' }] },
    ...everyone.map(([principal, role]) => ({ principalId: principal.id, member: principal, roles: [{ name: role }, { name: 'Limited Access' }] })),
  ];
  return permissionsSummary({ groups, siteCollectionAdmins: [], roleAssignments });
}

test('an Everyone grant added and removed, with its level', () => {
  assert.deepEqual(compareSiteExposure(site(), site({ everyone: [[ALL_USERS, 'Edit']] })), [
    { what: 'everyone', change: 'added', audience: 'everyone-except-external', level: 'edit', before: null },
  ]);
  assert.deepEqual(compareSiteExposure(site(), site({ everyone: [[EVERYONE, 'Read']] })), [
    { what: 'everyone', change: 'added', audience: 'everyone', level: 'view', before: null },
  ]);
  assert.deepEqual(compareSiteExposure(site({ everyone: [[EVERYONE, 'Read']] }), site()), [
    { what: 'everyone', change: 'removed', audience: 'everyone', level: 'view', after: null },
  ]);
  // View raised to edit is an edit grant added; edit lowered to view is the edit removed.
  assert.deepEqual(compareSiteExposure(site({ everyone: [[ALL_USERS, 'Read']] }), site({ everyone: [[ALL_USERS, 'Contribute']] })).map((c) => [c.change, c.level, c.before]), [['added', 'edit', 'view']]);
  assert.deepEqual(compareSiteExposure(site({ everyone: [[ALL_USERS, 'Edit']] }), site({ everyone: [[ALL_USERS, 'Read']] })).map((c) => [c.change, c.level, c.after]), [['removed', 'edit', 'view']]);
  // The same grant in both backups is no change.
  assert.deepEqual(compareSiteExposure(site({ everyone: [[ALL_USERS, 'Edit']] }), site({ everyone: [[ALL_USERS, 'Edit']] })), []);
});

test('anyone links added, new guests and the last owner removed; fewer of them is not a change', () => {
  assert.deepEqual(compareSiteExposure(site({ links: 1 }), site({ links: 4 })), [{ what: 'anyone-links', change: 'added', count: 3, total: 4 }]);
  assert.deepEqual(compareSiteExposure(site({ links: 4 }), site({ links: 1 })), []);
  assert.deepEqual(compareSiteExposure(site({ guests: 1 }), site({ guests: 3 })), [{ what: 'guests', change: 'added', count: 2, total: 3 }]);
  assert.deepEqual(compareSiteExposure(site({ guests: 3 }), site({ guests: 1 })), []);
  assert.deepEqual(compareSiteExposure(site(), site({ owners: [] })), [{ what: 'owners', change: 'removed', count: 1 }]);
  assert.deepEqual(compareSiteExposure(site({ owners: [] }), site()), []);
  // Organisation and specific-people links are not anyone links.
  const orgLinks = permissionsSummary({ groups: [link(1, 'OrganizationEdit'), link(2, 'Flexible')], siteCollectionAdmins: [], roleAssignments: [] });
  assert.deepEqual(compareSiteExposure(site(), orgLinks).filter((c) => c.what === 'anyone-links'), []);
});

test('an older backup without the exposure counts produces nothing, never a false "removed"', () => {
  const now = site({ everyone: [[ALL_USERS, 'Edit']], links: 3 });
  // Summary v1 (before #963): no exposure, no Everyone grants recognised.
  const { exposure: _gone, ...older } = site();
  const v1 = { ...older, v: 1 };
  assert.deepEqual(compareSiteExposure(v1, now), []);
  assert.deepEqual(compareSiteExposure(now, v1), []);
  assert.deepEqual(compareSiteExposure(null, now), []);
  assert.equal(siteExposure(v1).everyone, null);
  // A site that inherits its roles saves no Everyone list: not read, so nothing compares.
  assert.deepEqual(compareSiteExposure(site({ inherits: true }), now).filter((c) => c.what === 'everyone'), []);
});

test('a OneDrive: new anyone links counted once across files, Everyone grants added', () => {
  const file = (permissions) => drivePermissionExposure(permissions);
  const anyone = (id) => ({ id, roles: ['read'], link: { scope: 'anonymous', type: 'view' } });
  const everyone = { id: 'e1', roles: ['write'], grantedToV2: { siteGroup: { loginName: 'c:0-.f|rolemanager|spo-grid-all-users/1111' } } };
  const changes = compareDriveExposure([
    { before: file([]), after: file([anyone('L1')]) },
    // An inherited link shows on a child too: still one link.
    { before: file([]), after: file([anyone('L1'), everyone]) },
    { before: file([anyone('L0')]), after: file([anyone('L0'), anyone('L2')]) },
    // No exposure saved before: skipped.
    { before: null, after: file([anyone('L9')]) },
  ]);
  assert.deepEqual(changes, [
    { what: 'everyone', change: 'added', audience: 'everyone-except-external', level: 'edit', before: null },
    { what: 'anyone-links', change: 'added', count: 2, total: null },
  ]);
  assert.deepEqual(compareDriveExposure([{ before: file([anyone('L1'), everyone]), after: file([]) }]), []);
});

test('levels and activity words', () => {
  assert.deepEqual([levelOf(['Read']), levelOf(['Edit']), levelOf(['Full Control']), levelOf(['write']), levelOf([])], ['view', 'edit', 'full control', 'edit', 'view']);
  assert.equal(exposureActivity({ what: 'everyone', change: 'added', audience: 'everyone-except-external', level: 'edit' }), 'Everyone in the company can now edit.');
  assert.equal(exposureActivity({ what: 'everyone', change: 'removed', audience: 'everyone', level: 'edit', after: 'view' }), 'Everyone, guests included can no longer edit (can still view).');
  assert.equal(exposureActivity({ what: 'anyone-links', change: 'added', count: 1, total: 4 }), '1 new link anyone can open (4 in all).');
  assert.equal(exposureActivity({ what: 'guests', change: 'added', count: 2, total: 3 }), '2 new guests (3 in all).');
  assert.equal(exposureActivity({ what: 'owners', change: 'removed', count: 2 }), 'No owner left: the last owner was removed.');
});
