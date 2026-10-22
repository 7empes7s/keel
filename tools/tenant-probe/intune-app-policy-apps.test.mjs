/**
 * Restore gaps batch 13: the apps an iOS or Android app protection policy, or
 * an app configuration policy, covers are read per policy, so a backup holds
 * what a recreate needs. Fake reader only; nothing reads a tenant.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { get } from '../../engine/collect/registry.mjs';
import '../../engine/collect/entraAdapter.mjs';

const page = (items) => ({ items, pages: 1, status: 200, capped: false, error: null });
const app = (bundleId) => ({ id: `${bundleId}.ios`, mobileAppIdentifier: { '@odata.type': '#microsoft.graph.iosMobileAppIdentifier', bundleId } });

test('each iOS and Android app protection policy is read with the apps it protects; other kinds are left as listed', async () => {
  const urls = [];
  const reader = {
    async collect(version, path) {
      urls.push(`/${version}${path}`);
      if (path === '/deviceAppManagement/managedAppPolicies') {
        return page([
          { id: 'T_ios-1', '@odata.type': '#microsoft.graph.iosManagedAppProtection', displayName: 'KEEL-RT-ios' },
          { id: 'T_and-1', '@odata.type': '#microsoft.graph.androidManagedAppProtection', displayName: 'KEEL-RT-android' },
          { id: 'wip-1', '@odata.type': '#microsoft.graph.windowsInformationProtectionPolicy', displayName: 'KEEL-RT-wip' },
        ]);
      }
      if (path === '/deviceAppManagement/iosManagedAppProtections/T_ios-1/apps') return page([app('com.microsoft.office.outlook')]);
      if (path === '/deviceAppManagement/androidManagedAppProtections/T_and-1/apps') return page([]);
      throw new Error(`unexpected read ${path}`);
    },
  };
  const result = await get('managedAppPolicy').adapter.collectRaw(reader, {});
  assert.equal(result.error, null);
  assert.deepEqual(urls, [
    '/v1.0/deviceAppManagement/managedAppPolicies',
    '/v1.0/deviceAppManagement/iosManagedAppProtections/T_ios-1/apps',
    '/v1.0/deviceAppManagement/androidManagedAppProtections/T_and-1/apps',
  ], 'the list, then one read per iOS or Android policy at its own collection');
  assert.equal(result.pages, 3);
  assert.deepEqual(result.items[0].apps, [app('com.microsoft.office.outlook')]);
  assert.deepEqual(result.items[1].apps, [], 'a policy with no apps reads as an empty list, not a missing one');
  assert.equal('apps' in result.items[2], false, 'a kind with no apps route is left as listed');
});

test('each app configuration policy is read with the apps it targets', async () => {
  const reader = {
    async collect(version, path) {
      if (path === '/deviceAppManagement/targetedManagedAppConfigurations') return page([{ id: 'A_cfg-1', displayName: 'KEEL-RT-cfg' }]);
      if (path === '/deviceAppManagement/targetedManagedAppConfigurations/A_cfg-1/apps') return page([app('com.microsoft.skype.teams')]);
      throw new Error(`unexpected read ${path}`);
    },
  };
  const result = await get('targetedManagedAppConfiguration').adapter.collectRaw(reader, {});
  assert.equal(result.error, null);
  assert.deepEqual(result.items[0].apps, [app('com.microsoft.skype.teams')]);
});

test('a failed apps read fails the app protection backup, never hides the apps', async () => {
  const reader = {
    async collect(version, path) {
      if (path === '/deviceAppManagement/managedAppPolicies') return page([{ id: 'T_ios-1', '@odata.type': '#microsoft.graph.iosManagedAppProtection' }]);
      return { items: [], pages: 0, status: 403, capped: false, error: { status: 403, error: 'denied' } };
    },
  };
  const result = await get('managedAppPolicy').adapter.collectRaw(reader, {});
  assert.equal(result.error.status, 403);
  assert.deepEqual(result.items, []);
});
