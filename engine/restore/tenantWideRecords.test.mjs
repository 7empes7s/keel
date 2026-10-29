// The tenant-wide records (recordWriter.mjs#tenantWideRecordProblem): each Entra
// and Intune setting that is one object for the whole tenant is refused on the
// test tenant unless the restore was planned with the tenant-wide option, which
// the batch 17 live proofs use (keel-restore --allow-tenant-wide-test-writes).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IDENTITY_RECORDS, applyIdentityObjectWrite } from './identityObjectOperations.mjs';
import { INTUNE_EXTENDED_RECORDS, applyIntuneExtendedWrite } from './intuneOperations.mjs';
import { fakeGraph, fixtureFor } from '../../tools/qualification/operations.mjs';

const TEST_TENANT = Object.freeze({
  tenantRef: 'sha256:keeltesttenant0', testTenantRefs: ['sha256:keeltesttenant0'], readAfterWriteOptions: { attempts: 1, delayMs: 0 },
});

const ENTRA = Object.freeze([
  'lifecycleManagementSettings', 'entitlementManagementSettings', 'multiTenantOrganization', 'externalIdentitiesPolicy',
  'accessReviewPolicy', 'directoryRoleAccessReviewPolicy', 'multiTenantOrganizationIdentitySyncPolicyTemplate',
  'multiTenantOrganizationPartnerConfigurationTemplate', 'b2bManagementPolicy', 'sharepointSettings',
  'formsSettings', 'microsoft365AppsInstallationOptions', 'appsAndServicesSettings', 'adminReportSettings', 'pronounsSettings',
]);
const INTUNE = Object.freeze(['deviceManagementSettings', 'microsoftTunnelHealthThreshold', 'onPremisesConditionalAccessSettings']);

const writes = (graph) => graph.writes.filter((write) => write.method !== 'GET');
const writerFor = (type) => (IDENTITY_RECORDS[type] ? applyIdentityObjectWrite : applyIntuneExtendedWrite);

test('every tenant-wide Entra and Intune setting is marked tenant-wide', () => {
  const marked = (records) => Object.values(records).filter((record) => record.tenantWide === true).map((record) => record.resourceType).sort();
  assert.deepEqual(marked(IDENTITY_RECORDS), [...ENTRA].sort());
  assert.deepEqual(marked(INTUNE_EXTENDED_RECORDS), [...INTUNE].sort());
  // A new singleton (one object per tenant) cannot be added without the mark.
  for (const record of [...Object.values(IDENTITY_RECORDS), ...Object.values(INTUNE_EXTENDED_RECORDS)]) {
    if (record.singleton) assert.equal(record.tenantWide, true, `${record.resourceType} is one object per tenant`);
  }
  // The default branding profile is tenant-wide; a group's profile is not.
  const branding = INTUNE_EXTENDED_RECORDS.intuneBrandingProfile.tenantWide;
  assert.equal(branding({ payload: { isDefaultProfile: true }, live: { payload: { isDefaultProfile: true } } }), true);
  assert.equal(branding({ payload: { isDefaultProfile: false }, live: { payload: { isDefaultProfile: false } } }), false);
  assert.equal(IDENTITY_RECORDS.engageCommunity.tenantWide, false);
});

test('on the test tenant a tenant-wide setting is refused without the tenant-wide option, in the dry run and the write', async () => {
  for (const type of [...ENTRA, ...INTUNE]) {
    for (const mode of ['dry-run', 'enforce']) {
      const graph = fakeGraph();
      const resource = fixtureFor(type, 'update', graph);
      const result = await writerFor(type)(graph, resource, 'update', { ...TEST_TENANT, mode });
      assert.equal(result.applied, undefined, `${type} ${mode}: ${JSON.stringify(result)}`);
      assert.match(result.skipped?.reason ?? '', /is tenant-wide and needs a dry run made with --allow-tenant-wide-test-writes/, `${type} ${mode}`);
      assert.equal(writes(graph).length, 0, `${type} ${mode}`);
    }
  }
});

test('on the test tenant the tenant-wide option lets each setting be planned and written (the batch 17 live path)', async () => {
  for (const type of [...ENTRA, ...INTUNE]) {
    const dry = fakeGraph();
    const planned = await writerFor(type)(dry, fixtureFor(type, 'update', dry), 'update', { ...TEST_TENANT, mode: 'dry-run', allowTenantWide: true });
    assert.ok(planned.applied?.changes?.fields?.length > 0, `${type} dry run: ${JSON.stringify(planned)}`);
    assert.equal(writes(dry).length, 0, `${type} dry run`);
    const graph = fakeGraph();
    const result = await writerFor(type)(graph, fixtureFor(type, 'update', graph), 'update', { ...TEST_TENANT, mode: 'enforce', allowTenantWide: true });
    assert.ok(result.applied, `${type}: ${JSON.stringify(result)}`);
    assert.ok(writes(graph).length >= 1, type);
  }
});

test('a tenant-wide setting is written on a customer tenant without the option, and never when the tenant is not known', async () => {
  for (const type of [...ENTRA, ...INTUNE]) {
    const graph = fakeGraph();
    const result = await writerFor(type)(graph, fixtureFor(type, 'update', graph), 'update', {
      ...TEST_TENANT, tenantRef: 'sha256:customer0000000', mode: 'enforce',
    });
    assert.ok(result.applied, `${type}: ${JSON.stringify(result)}`);
    const unknown = fakeGraph();
    const refused = await writerFor(type)(unknown, fixtureFor(type, 'update', unknown), 'update', {
      ...TEST_TENANT, tenantRef: undefined, mode: 'enforce', allowTenantWide: true,
    });
    assert.match(refused.skipped?.reason ?? '', /target tenant is not known/, type);
    assert.equal(writes(unknown).length, 0, type);
  }
});

test('the default branding profile is tenant-wide on the test tenant; a KEEL-RT- group profile is not', async () => {
  const run = async (isDefaultProfile, ctx) => {
    const payload = { displayName: isDefaultProfile ? 'Contoso' : 'KEEL-RT-branding', isDefaultProfile, contactITName: 'Help desk' };
    const graph = fakeGraph();
    graph.objects.set('/deviceManagement/intuneBrandingProfiles/profile-1', { ...payload, id: 'profile-1', contactITName: 'Drifted' });
    const resource = {
      naturalKey: `intuneBrandingProfile:${payload.displayName}`, resourceType: 'intuneBrandingProfile', references: [], payload, targetId: 'profile-1',
      live: { state: 'present', targetId: 'profile-1', payload: { ...payload, id: 'profile-1', contactITName: 'Drifted' } },
    };
    return applyIntuneExtendedWrite(graph, resource, 'update', { ...TEST_TENANT, mode: 'dry-run', ...ctx });
  };
  assert.match((await run(true, {})).skipped?.reason ?? '', /intuneBrandingProfile is tenant-wide/);
  assert.deepEqual((await run(true, { allowTenantWide: true })).applied?.changes?.fields, ['contactITName']);
  assert.deepEqual((await run(false, {})).applied?.changes?.fields, ['contactITName']);
});
