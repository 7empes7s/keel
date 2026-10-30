// SharePoint and OneDrive tenant settings through PnP, read-only: the tenant object
// (Get-PnPTenant), OneDrive sync limits, idle sign-out and Restricted SharePoint Search.
//
// Acceptance:
//  - the reads are declared, pass the scope validator, are run by the read-only probe, and
//    ship disabled; the Node and container allowlists match; no write is reachable;
//  - each read is one tenant-wide object with declared fields only; enum numbers are stored
//    by name, time spans in seconds, lists sorted, so the same settings always compare equal;
//  - an empty answer for a setting every tenant has is a gap, an empty allowed site list is
//    not; a failure is a failure; a tenant without Copilot is "not licensed", not failed;
//  - each read turns on with its own proof; a changed setting is a change on the Changes page;
//  - the read capture tool can qualify it, with no extra arguments;
//  - it sits in SharePoint's "Tenant settings" group, first, and its rows have plain names.
//
// Everything runs against the isolated test database and a fake PowerShell container that
// plays the ops/powershell/run-cmdlet.ps1 contract through the real jobQueue spawn path.
// No tenant is touched.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  FAMILIES, SHAREPOINT_TENANT_CMDLET_PARAMETERS, SHAREPOINT_TENANT_DESCRIPTOR, SHAREPOINT_TENANT_OPERATIONS, SHAREPOINT_TENANT_WORKLOAD,
  SharePointTenantScopeError, assertSharePointTenantCmdlet, collectSharePointTenant, enumName, readSharePointTenant,
  sharePointTenantActivation, timeSpanSeconds,
} from '../collect/workloads/sharepointTenant.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { detectWorkloadDrift } from '../govern/workloadDrift.mjs';
import { compareInService, typeInfo } from '../insights/taxonomy.mjs';
import { runFixtureHarness } from '../../tools/qualification/workloads.mjs';
import { readModule, workloadReads } from '../../tools/qualification/workloadReadsAcceptance.mjs';
import { ALL_READS, GRANTS, RUNTIME, containerAllowlist, fakeCmdletContainer, ledgerWith, notFound } from '../test/fakeCmdletContainer.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

const NOW = new Date('2026-10-30T12:00:00Z');
let tenantSeq = 0;
const nextTenant = () => `sha256:sp-tenant-${tenantSeq += 1}`;
const ALLOWED = containerAllowlist('AllowedPnPTenant');

// The tenant object as ConvertTo-Json writes it: enums as numbers, plus CSOM plumbing and
// usage counters a careless reader would keep.
const TENANT = {
  SharingCapability: 2, OneDriveSharingCapability: 1, SharingDomainRestrictionMode: 1, SharingAllowedDomainList: 'fabrikam.com', SharingBlockedDomainList: '',
  DefaultSharingLinkType: 2, DefaultLinkPermission: 1, FileAnonymousLinkType: 1, FolderAnonymousLinkType: 1, RequireAnonymousLinksExpireInDays: 30,
  ExternalUserExpirationRequired: true, ExternalUserExpireInDays: 60, EmailAttestationRequired: true, EmailAttestationReAuthDays: 30,
  RequireAcceptingAccountMatchInvitedAccount: true, PreventExternalUsersFromResharing: true, NotifyOwnersWhenItemsReshared: true,
  BccExternalSharingInvitations: false, ShowEveryoneClaim: false, ShowEveryoneExceptExternalUsersClaim: true, ShowAllUsersClaim: false,
  ShowPeoplePickerSuggestionsForGuestUsers: false, ODBAccessRequests: 0, ODBMembersCanShare: 0,
  ConditionalAccessPolicy: 1, AllowDownloadingNonWebViewableFiles: false, AllowEditing: true, LimitedAccessFileType: 1,
  IPAddressEnforcement: false, IPAddressAllowList: '', IPAddressWACTokenLifetime: 15, LegacyAuthProtocolsEnabled: false,
  DisableCustomAppAuthentication: true, DisallowInfectedFileDownload: true,
  OrphanedPersonalSitesRetentionPeriod: 30, OneDriveStorageQuota: 1048576, NotificationsInOneDriveForBusinessEnabled: true,
  NoAccessRedirectUrl: '', CommentsOnSitePagesDisabled: false, SocialBarOnSitePagesDisabled: false, DisablePersonalListCreation: false,
  DelayDenyAddAndCustomizePagesEnforcement: false, SearchResolveExactEmailOrUPN: false, SpecialCharactersStateInFileFolderNames: 1,
  DisabledWebPartIds: ['B0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001'], ExternalServicesEnabled: true,
  MarkNewFilesSensitiveByDefault: 0, EnableAIPIntegration: true,
  IsLoopEnabled: true, EnableAutoExpirationVersionTrim: false, ExpireVersionsAfterDays: 0, MajorVersionLimit: 500,
  StorageQuotaAllocated: 123456, ResourceQuotaAllocated: 1, Context: { internal: true }, Path: 'x',
};
const SYNC = {
  TenantRestrictionEnabled: true, AllowedDomainList: ['BBBBBBBB-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001'], BlockMacSync: false,
  ExcludedFileExtensions: ['PST', 'exe'], DisableReportProblemDialog: false, OptOutOfGrooveBlock: false, OptOutOfGrooveSoftBlock: false,
};
// TimeSpans as ConvertTo-Json writes them.
const span = (seconds) => ({ Ticks: seconds * 1e7, Days: 0, Hours: Math.floor(seconds / 3600), TotalSeconds: seconds });
const IDLE = { Enabled: true, WarnAfter: span(2700), SignOutAfter: span(3600) };

/** A fake tenant behind the real jobQueue spawn path. `answers` overrides a cmdlet's answer. */
function fakeTenant(answers = {}) {
  const state = {
    'Get-PnPTenant': [TENANT], 'Get-PnPTenantSyncClientRestriction': [SYNC], 'Get-PnPBrowserIdleSignout': [IDLE],
    'Get-PnPTenantRestrictedSearchMode': [1], 'Get-PnPTenantRestrictedSearchAllowedList': ['https://contoso.sharepoint.com/sites/HR/', 'https://contoso.sharepoint.com/sites/Benefits'],
    ...answers,
  };
  const live = fakeCmdletContainer({ module: 'PnP.PowerShell', allowlist: ALLOWED, answer: (cmdlet) => state[cmdlet] });
  return { ...live, state };
}
const read = (live, extra = {}) => readSharePointTenant({ powershell: live.powershell, now: () => NOW, ...extra });

test('the reads are declared, in scope, probed, Get-only and ship disabled', async () => {
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === SHAREPOINT_TENANT_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [...SHAREPOINT_TENANT_OPERATIONS]);
  assert.deepEqual(declared.map((descriptor) => descriptor.operation.cmdlet), [
    'Get-PnPTenant', 'Get-PnPTenantSyncClientRestriction', 'Get-PnPBrowserIdleSignout', 'Get-PnPTenantRestrictedSearchMode', 'Get-PnPTenantRestrictedSearchAllowedList',
  ]);
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const spo = /# --- SharePoint \/ PnP ---([\s\S]*)$/.exec(probe)[1];
  for (const descriptor of declared) {
    assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
    assert.equal(descriptor.operation.module, 'PnP.PowerShell');
    assert.ok(spo.includes(`name = "${descriptor.operation.probeName}"; block = { ${descriptor.operation.probeName} }`), descriptor.id);
  }
  const bare = buildWorkloadLedger({ grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(bare.rows.filter((row) => row.id.startsWith('sharepoint-tenant.')).every((row) => row.enabled === false));
  const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

  assert.equal(SHAREPOINT_TENANT_DESCRIPTOR.enabledByDefault, false);
  assert.equal(SHAREPOINT_TENANT_DESCRIPTOR.readOnly, true);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === SHAREPOINT_TENANT_WORKLOAD));
  assert.ok(WORKLOAD_COLLECTORS.some((entry) => entry.workload === SHAREPOINT_TENANT_WORKLOAD && entry.powershellFamily === 'sharepoint'));
  assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((operation) => operation.workload === SHAREPOINT_TENANT_WORKLOAD), [], 'no writer exists');

  assert.deepEqual(Object.fromEntries(Object.entries(SHAREPOINT_TENANT_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), ALLOWED,
    'the Node and container allowlists are identical');
  for (const cmdlet of ['Set-PnPTenant', 'Set-PnPTenantSyncClientRestriction', 'Set-PnPBrowserIdleSignout', 'Set-PnPTenantRestrictedSearchMode',
    'Add-PnPTenantRestrictedSearchAllowedList', 'Remove-PnPTenantRestrictedSearchAllowedList', 'Get-PnPTenantSite', 'Get-PnPFile']) {
    assert.throws(() => assertSharePointTenantCmdlet({ cmdlet }), SharePointTenantScopeError, cmdlet);
  }
  assert.throws(() => assertSharePointTenantCmdlet({ cmdlet: 'Get-PnPTenant', parameters: { Identity: 'x' } }), /does not take Identity/);

  assert.equal(readModule(SHAREPOINT_TENANT_WORKLOAD), 'PnP.PowerShell');
  assert.deepEqual(workloadReads(SHAREPOINT_TENANT_WORKLOAD).map((item) => item.family),
    ['tenantSettings', 'syncClientRestriction', 'browserIdleSignout', 'restrictedSearchMode', 'restrictedSearchAllowedSites']);
  // The container connects to the admin site for these (only templates name another site).
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  assert.match(script, /elseif \(\$AllowedPnPTenant\.ContainsKey\(\$name\) -and \$module -eq 'PnP\.PowerShell'\) \{ \$session = 'pnp'; \$permitted = \$AllowedPnPTenant\[\$name\] \}/);
  assert.match(script, /\$pnpUrl = \$config\.sharePointAdminUrl/);
});

test('each read is one tenant-wide object with declared fields, enums by name, spans in seconds, lists sorted', async () => {
  const live = fakeTenant();
  const result = await read(live);
  assert.equal(result.outcome, 'complete', JSON.stringify({ failures: result.failures, unknown: result.unknownFields }));
  assert.deepEqual(live.calls.map((call) => [call.cmdlet, call.parameters]), Object.keys(ALLOWED).map((cmdlet) => [cmdlet, {}]));
  const byKey = Object.fromEntries(result.resources.map((resource) => [resource.resourceKey, resource]));
  assert.deepEqual(Object.keys(byKey), ['tenant-settings:tenant', 'sync-client:tenant', 'idle-sign-out:tenant', 'restricted-search:tenant', 'restricted-search-sites:tenant']);

  const tenant = byKey['tenant-settings:tenant'].fields;
  assert.deepEqual(Object.keys(tenant), [...FAMILIES.tenantSettings.fields]);
  for (const dropped of ['StorageQuotaAllocated', 'ResourceQuotaAllocated', 'Context', 'Path']) assert.equal(tenant[dropped], undefined, dropped);
  assert.equal(tenant.SharingCapability, 'ExternalUserAndGuestSharing');
  assert.equal(tenant.OneDriveSharingCapability, 'ExternalUserSharingOnly');
  assert.equal(tenant.SharingDomainRestrictionMode, 'AllowList');
  assert.equal(tenant.DefaultSharingLinkType, 'Internal');
  assert.equal(tenant.DefaultLinkPermission, 'View');
  assert.equal(tenant.FileAnonymousLinkType, 'View');
  assert.equal(tenant.ConditionalAccessPolicy, 'AllowLimitedAccess');
  assert.equal(tenant.LimitedAccessFileType, 'WebPreviewableFiles');
  assert.equal(tenant.SpecialCharactersStateInFileFolderNames, 'Allowed');
  assert.deepEqual(tenant.DisabledWebPartIds, ['a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002']);
  assert.equal(tenant.LegacyAuthProtocolsEnabled, false);

  assert.deepEqual(byKey['sync-client:tenant'].fields.AllowedDomainList, ['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002']);
  assert.deepEqual(byKey['sync-client:tenant'].fields.ExcludedFileExtensions, ['exe', 'pst']);
  assert.deepEqual(byKey['idle-sign-out:tenant'].fields, { Enabled: true, WarnAfter: 2700, SignOutAfter: 3600 });
  assert.deepEqual(byKey['restricted-search:tenant'].fields, { Mode: 'Enabled' });
  assert.deepEqual(byKey['restricted-search-sites:tenant'].fields, {
    SiteUrls: ['https://contoso.sharepoint.com/sites/benefits', 'https://contoso.sharepoint.com/sites/hr'],
  });
  assert.ok(result.resources.every((resource) => Object.values(resource.fieldCoverage).every((coverage) => coverage.status === 'observed')));

  // The mode as an object, and as a name, read the same.
  const asObject = await read(fakeTenant({ 'Get-PnPTenantRestrictedSearchMode': [{ Mode: 'Disabled' }] }), { families: ['restrictedSearchMode'] });
  assert.deepEqual(asObject.resources[0].fields, { Mode: 'Disabled' });
  // Time spans as text, and enum names passed through.
  assert.equal(timeSpanSeconds('01:00:00'), 3600);
  assert.equal(timeSpanSeconds('1.00:00:30'), 86430);
  assert.equal(timeSpanSeconds(900), 900);
  assert.equal(enumName(['Disabled', 'Enabled'], 'Enabled'), 'Enabled');
  assert.equal(enumName(['Disabled', 'Enabled'], '1'), 'Enabled');
  assert.equal(enumName(['Disabled', 'Enabled'], 7), 7, 'an unknown number is kept, never guessed');
});

test('gaps are never silent: empty, missing fields, failures, and no Copilot licence', async () => {
  const empty = await read(fakeTenant({ 'Get-PnPTenant': [], 'Get-PnPTenantRestrictedSearchAllowedList': [] }));
  assert.equal(empty.outcome, 'partial');
  assert.deepEqual(empty.discovery.empty, ['tenantSettings'], 'every tenant has settings; an empty allowed site list is not a gap');
  assert.deepEqual(empty.resources.find((resource) => resource.kind === 'restrictedSearchAllowedSites').fields, { SiteUrls: [] });

  const { LegacyAuthProtocolsEnabled, ...withoutOne } = TENANT;
  const sparse = await read(fakeTenant({ 'Get-PnPTenant': [withoutOne] }), { families: ['tenantSettings'] });
  assert.equal(sparse.outcome, 'partial');
  assert.deepEqual(sparse.unknownFields, { tenantSettings: { LegacyAuthProtocolsEnabled: 1 } });
  assert.equal('LegacyAuthProtocolsEnabled' in sparse.resources[0].fields, false, 'a missing setting is never stored as a value');

  const denied = await read(fakeTenant({ 'Get-PnPTenant': { error: { message: 'Access is denied', category: 'PermissionDenied', errorId: 'x' } } }), { families: ['tenantSettings'] });
  assert.equal(denied.outcome, 'failed');
  assert.equal(denied.failures[0].status, 'denied');

  const noCopilot = await read(fakeTenant({
    'Get-PnPTenantRestrictedSearchMode': { error: notFound('Get-PnPTenantRestrictedSearchMode') },
    'Get-PnPTenantRestrictedSearchAllowedList': { error: notFound('Get-PnPTenantRestrictedSearchAllowedList') },
  }));
  assert.equal(noCopilot.outcome, 'partial');
  assert.deepEqual(noCopilot.unavailable.map((item) => [item.family, item.status]), [['restrictedSearchMode', 'not-licensed'], ['restrictedSearchAllowedSites', 'not-licensed']]);
  assert.equal(noCopilot.failures.length, 0);

  const odd = await read(fakeTenant({ 'Get-PnPTenantRestrictedSearchAllowedList': [{ nope: 1 }] }), { families: ['restrictedSearchAllowedSites'] });
  assert.equal(odd.outcome, 'failed', 'an answer KEEL cannot read as site URLs is never kept as an empty list');
});

test('each read turns on with its own proof; a changed sharing default is a change', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant();
  const others = ALL_READS.filter((id) => !SHAREPOINT_TENANT_OPERATIONS.includes(id));
  const off = await collectSharePointTenant(client, { tenantRef, ledger: ledgerWith(tenantRef, others, { now: NOW }), powershell: live.powershell, now: () => NOW });
  assert.equal(off.run.outcome, 'disabled');
  assert.deepEqual(live.calls, [], 'nothing is sent while disabled');
  assert.match(off.activation.reasons.join('; '), /sharepoint-tenant\.tenant is fixture-tested/);

  const idleOnly = sharePointTenantActivation(ledgerWith(tenantRef, [...others, 'sharepoint-tenant.idle-sign-out'], { now: NOW }));
  assert.deepEqual(idleOnly.families, ['browserIdleSignout']);
  assert.equal(idleOnly.skipped.length, 4);

  const ledger = ledgerWith(tenantRef, ALL_READS, { now: NOW });
  const first = await collectSharePointTenant(client, { tenantRef, ledger, powershell: live.powershell, now: () => new Date('2026-10-29T02:00:00Z') });
  assert.equal(first.run.outcome, 'complete');
  const { rows } = await client.query('SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [first.run.id]);
  assert.deepEqual(rows.map((row) => [row.resource_key, row.fields.kind]), [
    ['idle-sign-out:tenant', 'browserIdleSignout'], ['restricted-search-sites:tenant', 'restrictedSearchAllowedSites'], ['restricted-search:tenant', 'restrictedSearchMode'],
    ['sync-client:tenant', 'syncClientRestriction'], ['tenant-settings:tenant', 'tenantSettings'],
  ]);

  // Same settings again: no change. Anyone links turned on: one change, on that setting.
  const second = await collectSharePointTenant(client, { tenantRef, ledger, powershell: live.powershell, now: () => new Date('2026-10-29T14:00:00Z') });
  await detectWorkloadDrift(client, { collectionId: first.run.id });
  assert.equal((await detectWorkloadDrift(client, { collectionId: second.run.id })).drift.length, 0);
  live.state['Get-PnPTenant'] = [{ ...TENANT, DefaultSharingLinkType: 3 }];
  const third = await collectSharePointTenant(client, { tenantRef, ledger, powershell: live.powershell, now: () => new Date('2026-10-30T02:00:00Z') });
  const drift = await detectWorkloadDrift(client, { collectionId: third.run.id });
  assert.equal(drift.status, 'detected');
  const { rows: changes } = await client.query('SELECT resource_key, change_type, fields FROM workload_drift WHERE tenant_ref = $1', [tenantRef]);
  assert.deepEqual(changes.map((row) => [row.resource_key, row.change_type]), [['tenant-settings:tenant', 'modified']]);
  assert.deepEqual(changes[0].fields.map((field) => [field.path, field.before, field.after]), [['DefaultSharingLinkType', 'Internal', 'AnonymousAccess']]);
});

test('it sits first in SharePoint\'s "Tenant settings" group', () => {
  const info = typeInfo(SHAREPOINT_TENANT_WORKLOAD);
  assert.equal(info.service, 'SharePoint');
  assert.equal(info.category, 'tenant');
  assert.equal(info.priority, 'high');
  assert.ok(compareInService(SHAREPOINT_TENANT_WORKLOAD, 'sharepointSettings') < 0, 'before the Graph subset of the same settings');
  assert.ok(compareInService('onedrive-site-settings', SHAREPOINT_TENANT_WORKLOAD) < 0, 'after sites and OneDrive');
});
