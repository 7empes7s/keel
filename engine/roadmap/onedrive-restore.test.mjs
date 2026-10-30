// OneDrive site settings restore (engine/restore/workloads/onedriveSettings.mjs).
//
// Acceptance:
//  - a drifted site's own sharing settings are put back with Set-PnPTenantSite and read
//    back; a second run plans and sends nothing;
//  - a value the backup shows as the tenant default is listed, never pinned on the site;
//    the owner, quota, label and conditional access setting are listed, never written;
//  - wider sharing is a content effect and is blocked until someone else approves it;
//  - a locked site is refused, and on the test tenant only a KEEL-RT- person's site is written;
//  - only personal sites on one -my host are read or written, here and in run-cmdlet.ps1.
//
// Runs against the isolated test database and a fake PowerShell container behind the
// real jobQueue spawn path, which enforces the allowlists parsed from run-cmdlet.ps1.
// No tenant is touched; every site belongs to a KEEL-RT- person.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { ONEDRIVE_WORKLOAD, recordOneDriveRun } from '../collect/workloads/onedrive.mjs';
import { TEST_TENANT_REFS } from '../govern/approvalPolicy.mjs';
import {
  WORKLOAD_EFFECT_RULES, createWorkloadSettingsArtifact, executeWorkloadSettingsRestore, planWorkloadSettingsRestore, unreviewedWrittenFields,
  writeCmdletParameters,
} from '../restore/workloads/cmdletSettings.mjs';
import { WORKLOAD_RESTORES } from '../restore/workloads/dispatch.mjs';
import { loadOneDriveSource, oneDriveReader, oneDriveScope, planSites } from '../restore/workloads/onedriveSettings.mjs';
import { ONEDRIVE_WRITE_OPERATION, WKLD_WRITE_OPERATIONS } from '../restore/workloads/writeDeclarations.mjs';
import { approveContentEffects, contentEffectsDigest } from '../safety/contentEffects.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { containerAllowlist, fakeCmdletContainer } from '../test/fakeCmdletContainer.mjs';

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

const TENANT = '00000000-0000-4000-8000-0000000000e1';
const MY_HOST = 'contoso-my.sharepoint.com';
const ALICE = `https://${MY_HOST}/personal/keel-rt-alice_contoso_test`;
const BOB = `https://${MY_HOST}/personal/bob_contoso_test`;
let tenantSeq = 0;
const nextTenant = () => `sha256:onedrive-restore-${tenantSeq += 1}`;
let principalSeq = 0;
async function principal(client, label, role = null) {
  const { rows } = await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [`${label}-${principalSeq += 1}@example.test`]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id, activeFrom: new Date(Date.now() - 60_000) });
  return rows[0].id;
}

// ExternalUserExpirationInDays and DefaultSharingLinkType follow the tenant default here.
const site = (url, owner, extra = {}) => ({
  Url: url, Template: 'SPSPERS#10', Owner: owner,
  SharingCapability: 'ExternalUserSharingOnly', SharingDomainRestrictionMode: 'AllowList', SharingAllowedDomainList: 'partner.test', SharingBlockedDomainList: '',
  DefaultSharingLinkType: 'None', DefaultLinkPermission: 'View',
  OverrideTenantExternalUserExpirationPolicy: false, ExternalUserExpirationInDays: 60,
  OverrideTenantAnonymousLinkExpirationPolicy: true, AnonymousLinkExpirationInDays: 7,
  StorageQuota: 1048576, StorageQuotaWarningLevel: 943718, LockState: 'Unlock',
  SensitivityLabel: '11111111-1111-4111-8111-111111111111', ConditionalAccessPolicy: 'AllowFullAccess',
  ...extra,
});
const ALLOWLIST = { ...containerAllowlist('AllowedPnP'), ...containerAllowlist('AllowedOneDriveWrites') };

function fakeTenant(sites) {
  const state = structuredClone(sites);
  const writes = [];
  const container = fakeCmdletContainer({
    module: 'PnP.PowerShell',
    allowlist: ALLOWLIST,
    answer(cmdlet, parameters) {
      const found = state[String(parameters.Identity).toLowerCase()] ?? Object.values(state).find((item) => item.Url.toLowerCase() === String(parameters.Identity).toLowerCase());
      if (cmdlet === 'Get-PnPTenantSite') return found ? [found] : { error: { message: `Cannot get site ${parameters.Identity}`, category: 'InvalidOperation', errorId: 'EXCEPTION' } };
      writes.push({ cmdlet, parameters });
      const { Identity, ...values } = parameters;
      if (!found) return { error: { message: `Cannot get site ${Identity}`, category: 'InvalidOperation', errorId: 'EXCEPTION' } };
      Object.assign(found, values);
      return [];
    },
  });
  return { state, writes, powershell: container.powershell };
}

const reader = oneDriveReader();
async function recordSource(client, tenantRef, tenant, sites = Object.values(tenant.state).map((item) => item.Url)) {
  const { readOneDrive } = await import('../collect/workloads/onedrive.mjs');
  const result = await readOneDrive({ powershell: tenant.powershell, sites, myHost: MY_HOST });
  const run = await recordOneDriveRun(client, { tenantRef, result });
  return loadOneDriveSource(client, { tenantRef, collectionId: run.id });
}

async function planned(client, tenantRef, { source, live, targets = [] }) {
  const read = await reader({ powershell: live.powershell, sites: source.observations.map((item) => item.fields.url) });
  const plan = planWorkloadSettingsRestore({ workload: ONEDRIVE_WORKLOAD, source, live: read, tenantId: TENANT, tenantRef, targets });
  const requestedBy = await principal(client, 'requester');
  const artifact = await createWorkloadSettingsArtifact(client, { tenantRef, plan, requestedBy });
  return { plan, artifact };
}

const ENABLED = { [ONEDRIVE_WRITE_OPERATION]: { operationId: ONEDRIVE_WRITE_OPERATION, state: 'live-qualified', enabled: true, reasons: [] } };
const execute = (client, tenantRef, artifact, plan, live, qualifications = ENABLED) => executeWorkloadSettingsRestore(client, {
  tenantRef, artifactId: artifact.id, tenantId: TENANT, workload: ONEDRIVE_WORKLOAD, powershell: live.powershell, qualifications,
  read: ({ powershell }) => reader({ powershell, sites: planSites(plan) }),
});

test('a site\'s own sharing settings are put back and read back; the tenant default and the rest are listed', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant({ [ALICE]: site(ALICE, 'keel-rt-alice@contoso.test') });
  const source = await recordSource(client, tenantRef, live);
  assert.equal(source.outcome, 'complete');

  // Narrower now than in the backup would be no effect; here the site was made stricter and its expiry longer.
  Object.assign(live.state[ALICE], {
    SharingCapability: 'Disabled', AnonymousLinkExpirationInDays: 30,
    ExternalUserExpirationInDays: 30, StorageQuota: 5, Owner: 'keel-rt-bob@contoso.test', SensitivityLabel: null,
  });
  const { plan, artifact } = await planned(client, tenantRef, { source, live });
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.operations.length, 1);
  const [op] = plan.operations;
  assert.equal(op.cmdlet, 'Set-PnPTenantSite');
  assert.deepEqual(op.parameters, { Identity: ALICE, SharingCapability: 'ExternalUserSharingOnly', AnonymousLinkExpirationInDays: 7 });
  // Back to sharing with guests is wider than "Disabled": it waits for a second approver.
  assert.deepEqual(plan.contentEffects.map((effect) => `${effect.field}:${effect.effect}`), ['SharingCapability:externally-sharing']);
  const manual = Object.fromEntries(plan.manual.map((item) => [item.field, item.reason]));
  assert.match(manual.ExternalUserExpirationInDays, /tenant default/);
  for (const field of ['StorageQuota', 'Owner', 'SensitivityLabel']) assert.match(manual[field], /KEEL does not write this setting/, field);

  const blocked = await execute(client, tenantRef, artifact, plan, live);
  assert.equal(blocked.outcome, 'blocked-content-effect');
  assert.deepEqual(live.writes, []);

  const approver = await principal(client, 'approver', 'approver');
  await approveContentEffects(client, {
    tenantRef, artifactId: artifact.id, approverId: approver, effectsDigest: contentEffectsDigest(plan.contentEffects), justification: 'KEEL-RT- fixture restore',
  });
  const result = await execute(client, tenantRef, artifact, plan, live);
  assert.equal(result.outcome, 'verified', JSON.stringify(result.operations));
  assert.deepEqual(live.writes.map((write) => write.cmdlet), ['Set-PnPTenantSite']);
  assert.equal(live.state[ALICE].SharingCapability, 'ExternalUserSharingOnly');
  assert.equal(live.state[ALICE].ExternalUserExpirationInDays, 30, 'the tenant default is never pinned');

  // Idempotent: nothing left to write.
  live.writes.length = 0;
  const again = await planned(client, tenantRef, { source, live });
  assert.deepEqual(again.plan.operations, []);
  assert.equal((await execute(client, tenantRef, again.artifact, again.plan, live)).outcome, 'no-change');
  assert.deepEqual(live.writes, []);
});

test('without a qualification nothing is sent', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant({ [ALICE]: site(ALICE, 'keel-rt-alice@contoso.test') });
  const source = await recordSource(client, tenantRef, live);
  live.state[ALICE].AnonymousLinkExpirationInDays = 30;
  const { plan, artifact } = await planned(client, tenantRef, { source, live });
  assert.equal(plan.contentEffects.length, 0, 'a shorter link expiry is no effect');
  const result = await execute(client, tenantRef, artifact, plan, live, {});
  assert.equal(result.outcome, 'disabled');
  assert.deepEqual(live.writes, []);
});

test('a locked site is refused; on the test tenant only a KEEL-RT- person\'s site is written', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = TEST_TENANT_REFS[0];
  const live = fakeTenant({ [ALICE]: site(ALICE, 'keel-rt-alice@contoso.test'), [BOB]: site(BOB, 'bob@contoso.test') });
  const source = await recordSource(client, tenantRef, live);
  live.state[ALICE].AnonymousLinkExpirationInDays = 30;
  live.state[ALICE].LockState = 'ReadOnly';
  live.state[BOB].AnonymousLinkExpirationInDays = 30;
  const { plan } = await planned(client, tenantRef, { source, live });
  assert.deepEqual(plan.operations, []);
  const reasons = Object.fromEntries(plan.refusals.map((item) => [item.naturalKey.split('/personal/')[1], item.reason]));
  assert.match(reasons['keel-rt-alice_contoso_test'], /^site-locked: .*never changes or unlocks it/);
  assert.match(reasons.bob_contoso_test, /^not-a-fixture: /);
});

test('a site whose lock state was not read, or a value of unknown origin, is never written', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const live = fakeTenant({ [ALICE]: site(ALICE, 'keel-rt-alice@contoso.test', { DefaultSharingLinkType: 'Direct' }) });
  const source = await recordSource(client, tenantRef, live);
  // The backup could not tell where these came from (pre-tracking, or an override that is not a switch).
  for (const field of ['AnonymousLinkExpirationInDays', 'DefaultSharingLinkType']) {
    source.observations[0].fieldCoverage[field] = { ...source.observations[0].fieldCoverage[field], inheritance: 'undetermined' };
  }
  delete source.observations[0].fieldCoverage.SharingCapability.inheritance;
  Object.assign(live.state[ALICE], { AnonymousLinkExpirationInDays: 30, DefaultSharingLinkType: 'Internal', SharingCapability: 'Disabled' });
  const { plan } = await planned(client, tenantRef, { source, live });
  assert.deepEqual(plan.operations, []);
  const manual = Object.fromEntries(plan.manual.map((item) => [item.field, item.reason]));
  for (const field of ['AnonymousLinkExpirationInDays', 'DefaultSharingLinkType', 'SharingCapability']) assert.match(manual[field], /cannot tell whether/, field);

  // The live read did not return a lock state: nothing is planned for the site.
  const fresh = await recordSource(client, tenantRef, live);
  live.state[ALICE].AnonymousLinkExpirationInDays = 7;
  for (const value of [undefined, null, 2]) {
    if (value === undefined) delete live.state[ALICE].LockState; else live.state[ALICE].LockState = value;
    const again = await planned(client, tenantRef, { source: fresh, live });
    assert.deepEqual(again.plan.operations, [], `LockState ${value}`);
    assert.ok(again.plan.manual.some((item) => /lock state was not read/.test(item.reason)) || again.plan.refusals.some((item) => /^site-locked/.test(item.reason)), `LockState ${value}`);
  }
});

test('only personal sites on one -my host are read; the plan names them by resource key', () => {
  assert.deepEqual(oneDriveScope([ALICE]), { sites: [ALICE], myHost: MY_HOST });
  assert.throws(() => oneDriveScope([`https://${MY_HOST}/personal/a`, 'https://other-my.sharepoint.com/personal/b']), /not on one host/);
  assert.throws(() => oneDriveScope(['https://contoso.sharepoint.com/sites/finance']), /OneDrive|not on|personal/i);
  assert.throws(() => oneDriveScope([`${ALICE}/Documents/x.docx`]));
  assert.deepEqual(planSites({ targets: [`onedrive:${ALICE}`, 'other:x'] }), [ALICE]);
  assert.match(WORKLOAD_RESTORES[ONEDRIVE_WORKLOAD].usage, /^--collection <id> \[--target <key> \.\.\.\]/);
});

test('the OneDrive write: declared sharing fields only, each judged for wider sharing, and the container allows exactly them', () => {
  const write = WKLD_WRITE_OPERATIONS[ONEDRIVE_WRITE_OPERATION];
  assert.equal(write.method, 'Set-PnPTenantSite');
  for (const field of ['Owner', 'LockState', 'StorageQuota', 'SensitivityLabel', 'ConditionalAccessPolicy', 'Template']) {
    assert.ok(!write.fields.includes(field), `${field} is never written`);
  }
  const ruled = new Set(WORKLOAD_EFFECT_RULES.onedriveSiteSettings.map((item) => item.field));
  assert.deepEqual(write.fields.filter((field) => !ruled.has(field)), [], 'every written OneDrive field has a sharing rule');
  assert.deepEqual(unreviewedWrittenFields().filter((item) => String(item).includes('onedrive')), []);
  assert.deepEqual(containerAllowlist('AllowedOneDriveWrites'), { 'Set-PnPTenantSite': writeCmdletParameters()['Set-PnPTenantSite'].parameters });
  // The container checks the site again: one personal site on the tenant's -my host.
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  assert.match(script, /if \(\$name -eq 'Set-PnPTenantSite'\) \{[\s\S]*?'\/personal\/\[A-Za-z0-9\]\[A-Za-z0-9_\.-\]\*\/\?\\z'[\s\S]*?SiteNotAllowed/);

  const effect = (field, before, after) => WORKLOAD_EFFECT_RULES.onedriveSiteSettings.find((item) => item.field === field).when(before, after, {});
  assert.equal(effect('SharingCapability', 'ExternalUserAndGuestSharing', 'ExistingExternalUserSharingOnly'), false);
  assert.equal(effect('SharingCapability', 'Disabled', 'ExternalUserSharingOnly'), true);
  assert.equal(effect('SharingAllowedDomainList', 'a.test', 'a.test b.test'), true);
  assert.equal(effect('SharingAllowedDomainList', 'a.test b.test', 'b.test'), false);
  assert.equal(effect('SharingBlockedDomainList', 'a.test b.test', 'b.test'), true);
  assert.equal(effect('DefaultLinkPermission', 'View', 'Edit'), true);
  assert.equal(effect('AnonymousLinkExpirationInDays', 7, 30), true);
  assert.equal(effect('AnonymousLinkExpirationInDays', 30, 0), true, '0 never expires');
  assert.equal(effect('AnonymousLinkExpirationInDays', 30, 7), false);
});
