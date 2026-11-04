import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drivePermissionExposure, everyoneAudience } from './permissionExposure.mjs';
test('OneDrive Graph permissions retain Everyone roles and classify all link scopes', () => {
  const permissions = [
    { id: 'a', link: { scope: 'anonymous', type: 'edit' } },
    { id: 'b', link: { scope: 'organization', type: 'view' } },
    { id: 'c', link: { scope: 'users', type: 'view' } },
    { roles: ['write'], grantedToV2: { siteUser: { loginName: 'c:0(.s|true' } } },
    { roles: ['read'], grantedToIdentitiesV2: [{ siteUser: { loginName: 'c:0-.f|rolemanager|spo-grid-all-users/tenant' } }] },
    { roles: ['write'], grantedToV2: { group: { displayName: 'Members' } } },
  ];
  const exposure = drivePermissionExposure(permissions);
  assert.deepEqual(exposure.everyone, [{ audience: 'everyone', roles: ['write'] }, { audience: 'everyone-except-external', roles: ['read'] }]);
  assert.equal(exposure.links.anyone.edit, 1);
  assert.equal(exposure.links.organisation.view, 1);
  assert.equal(exposure.links.specificPeople.view, 1);
  assert.equal(drivePermissionExposure(null), null);
  assert.equal(everyoneAudience('Ordinary members'), null);
});

test('an anonymous link remains urgent evidence when its access type is unknown', () => {
  const exposure = drivePermissionExposure([{ id: 'embed', link: { scope: 'anonymous', type: 'embed' } }]);
  assert.equal(exposure.links.anyone.unknown, 1);
  assert.equal(exposure.links.unknown, 0);
});
