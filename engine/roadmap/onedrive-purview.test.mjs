// Roadmap task-106: OneDrive container settings and Purview label configuration.
//
// Acceptance:
//  - a label definition change is tracked without reading labeled content;
//  - an inherited setting is distinguished from an explicit value;
//  - a preservation lock refuses;
//  - no per-item crawl;
//  - proof for another family cannot enable writes.
// Mutation checks:
//  - enumerate files for label inventory;
//  - ignore inherited versus explicit state;
//  - reuse unrelated workload qualification.
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays the ops/powershell/run-cmdlet.ps1 contract through the real
// engine/powershell/jobQueue.mjs spawn path. The fake answers every file, list-item
// and labeled-content cmdlet with content, so one such call would show up. No tenant,
// site, label or policy is touched.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { EXCHANGE_OPERATIONS } from '../collect/workloads/exchange.mjs';
import {
  ONEDRIVE_CMDLET_PARAMETERS, ONEDRIVE_FIELDS, OneDriveScopeError, assertOneDriveCmdlet, collectOneDrive, compareOneDriveSites,
  oneDriveActivation, readOneDrive, siteKey,
} from '../collect/workloads/onedrive.mjs';
import {
  LABEL_ACTION_FIELDS, PURVIEW_CMDLET_PARAMETERS, PURVIEW_OPERATIONS, PurviewScopeError, assertPurviewCmdlet, collectPurview,
  labelActionFields, loadPurviewCollection, purviewActivation, readPurview, trackLabelChanges,
} from '../collect/workloads/purview.mjs';
import { SHAREPOINT_OPERATIONS } from '../collect/workloads/sharepoint.mjs';
import { TEAMS_OPERATIONS } from '../collect/workloads/teams.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, scopeProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { WORKLOAD_WRITE_OPERATIONS, workloadWriteQualification } from '../coverage/qualification.mjs';
import { planDeletionWaves, planWaves } from '../restore/wavePlanner.mjs';
import {
  PURVIEW_LABEL_WRITE, PURVIEW_POLICY_WRITE, PURVIEW_RESTORE_EVIDENCE_KIND, PURVIEW_WRITE_OPERATIONS, createPurviewRestoreArtifact,
  executePurviewRestore, planPurviewRestore,
} from '../restore/workloads/purview.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
  }
  return client;
}

const NOW = new Date('2026-10-04T12:00:00Z');
const TENANT = '00000000-0000-4000-8000-0000000000c1';
const MY_HOST = 'contoso-my.sharepoint.com';
const ALICE = `https://${MY_HOST}/personal/keel-rt-alice_contoso_test`;
const BOB = `https://${MY_HOST}/personal/keel-rt-bob_contoso_test`;
const EXO_VERSION = '3.5.0';
const PNP_VERSION = '3.4.1';
const CONFIDENTIAL = '11111111-1111-4111-8111-111111111111';
const PUBLIC = '22222222-2222-4222-8222-222222222222';
const SECRET = '33333333-3333-4333-8333-333333333333';
const POLICY = '44444444-4444-4444-8444-444444444444';

let tenantSeq = 0;
const nextTenant = () => `sha256:task-106-${tenantSeq += 1}`;

const SITE = Object.freeze({
  Url: ALICE, Template: 'SPSPERS#10', Owner: 'keel-rt-alice@contoso.test',
  SharingCapability: 'ExternalUserSharingOnly', SharingDomainRestrictionMode: 'None', SharingAllowedDomainList: '', SharingBlockedDomainList: '',
  DefaultSharingLinkType: 'None', DefaultLinkPermission: 'View',
  OverrideTenantExternalUserExpirationPolicy: false, ExternalUserExpirationInDays: 60,
  OverrideTenantAnonymousLinkExpirationPolicy: true, AnonymousLinkExpirationInDays: 7,
  StorageQuota: 1048576, StorageQuotaWarningLevel: 943718, LockState: 'Unlock',
  SensitivityLabel: CONFIDENTIAL, ConditionalAccessPolicy: 'AllowFullAccess',
});
const label = (id, name, extra = {}) => ({
  ImmutableId: id, Guid: id, Name: name, DisplayName: name, ParentId: null, Priority: 1, ContentType: 'File, Email, Site, UnifiedGroup',
  Disabled: false, Tooltip: `${name} information`, Comment: '', EncryptionEnabled: false, EncryptionProtectionType: null, EncryptionOfflineAccessDays: null,
  ApplyContentMarkingHeaderEnabled: false, ApplyContentMarkingFooterEnabled: false, ApplyWaterMarkingEnabled: false,
  SiteAndGroupProtectionEnabled: true, SiteAndGroupProtectionPrivacy: 'Private', SiteAndGroupProtectionAllowAccessToGuestUsers: false,
  SiteExternalSharingControlType: 'ExistingExternalUserSharingOnly', WhenChangedUTC: '2026-09-01T00:00:00Z',
  // Adversarial: usage and labeled-item data a careless reader would keep. Never stored.
  LabelUsageCount: 4211, LabeledItems: ['Q3 board pack.docx'],
  ...extra,
});
const policy = (extra = {}) => ({
  ImmutableId: POLICY, Guid: POLICY, Name: 'Global label policy', Enabled: true, Mode: 'Enforce', Priority: 0,
  Labels: ['Confidential', 'Public'], ExchangeLocation: ['All'], ModernGroupLocation: [], SharePointLocation: [], OneDriveLocation: [],
  Settings: ['requiredowngradejustification=true'], WhenChangedUTC: '2026-09-01T00:00:00Z', ...extra,
});

// The allowlists the container enforces, parsed from the script it ships.
function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const ALLOWED = Object.freeze({
  'ExchangeOnlineManagement:exo': containerAllowlist('Allowed'),
  'ExchangeOnlineManagement:ipps': containerAllowlist('AllowedPurview'),
  'PnP.PowerShell:pnp': containerAllowlist('AllowedPnP'),
});
// A file, list-item or labeled-content cmdlet: the fake answers it with content.
const CONTENT_CMDLET = /File|ListItem|Folder|DriveItem|ContentExplorer|ActivityExplorer|ComplianceSearch|SensitivityLabel/;

/**
 * A fake tenant behind the real jobQueue spawn path. It plays run-cmdlet.ps1: only a
 * cmdlet in the allowlist of its module's session runs, parameters are splatted.
 * `hooks.cmdlet({ cmdlet, args, state })` may return 'timeout', 'apply-then-timeout',
 * { error } or { output }.
 */
function fakeTenant({ sites = { [ALICE]: SITE }, labels = [label(CONFIDENTIAL, 'Confidential'), label(PUBLIC, 'Public')], policies = [policy()], hooks = {} } = {}) {
  const state = { sites: structuredClone(sites), labels: structuredClone(labels), policies: structuredClone(policies) };
  const calls = [];
  let contentCalls = 0;
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  const fail = (message, errorId) => envelope({ ok: false, error: { message, category: 'InvalidOperation', errorId } }, 1);

  function run(job) {
    const keys = Object.keys(job).filter((key) => key !== 'jobId').sort();
    if (job.mode !== 'cmdlet' || keys.some((key) => !['adapter', 'cmdlet', 'mode', 'module', 'parameters', 'tenantConfigPath'].includes(key))) {
      return { stdout: '', stderr: `run-job.sh: refused descriptor with ${keys.join(',')}`, exitCode: 2 };
    }
    if (CONTENT_CMDLET.test(job.cmdlet)) {
      contentCalls += 1;
      return envelope({ ok: true, output: [{ Name: 'Q3 board pack.docx', SensitivityLabel: CONFIDENTIAL, ServerRelativeUrl: '/personal/x/Documents/Q3.docx' }] });
    }
    const session = Object.entries(ALLOWED).find(([key, list]) => key.startsWith(`${job.module}:`) && list[job.cmdlet]);
    if (!session) return fail(`cmdlet ${job.cmdlet} is not allowed`, 'CmdletNotAllowed');
    const allowed = session[1][job.cmdlet];
    const args = [];
    for (const [name, value] of Object.entries(job.parameters ?? {})) {
      if (!allowed.includes(name)) return fail(`parameter ${name} is not allowed for ${job.cmdlet}`, 'ParameterNotAllowed');
      args.push([name, value]);
    }
    calls.push({ cmdlet: job.cmdlet, session: session[0], args });
    const override = hooks.cmdlet?.({ cmdlet: job.cmdlet, args, state });
    if (override === 'timeout') return { timeout: true };
    if (override?.error) return envelope({ ok: false, error: override.error }, 1);
    if (override?.output) return envelope({ ok: true, output: override.output });
    const parameters = Object.fromEntries(args);
    const apply = () => {
      if (job.cmdlet === 'Get-PnPTenantSite') {
        const site = state.sites[parameters.Identity];
        return site ? envelope({ ok: true, output: [structuredClone(site)] }) : fail(`Cannot get site ${parameters.Identity}`, 'EXCEPTION,PnP.PowerShell.Commands.GetTenantSite');
      }
      if (job.cmdlet === 'Get-Label') return envelope({ ok: true, output: structuredClone(state.labels) });
      if (job.cmdlet === 'Get-LabelPolicy') return envelope({ ok: true, output: structuredClone(state.policies) });
      if (job.cmdlet === 'Set-Label') {
        const target = state.labels.find((item) => item.ImmutableId === parameters.Identity);
        const { Identity, ...values } = parameters;
        Object.assign(target, values, { WhenChangedUTC: '2026-10-04T12:30:00Z' });
        return envelope({ ok: true, output: [] });
      }
      if (job.cmdlet === 'Set-LabelPolicy') {
        const target = state.policies.find((item) => item.ImmutableId === parameters.Identity);
        target.Labels = [...target.Labels, ...parameters.AddLabels];
        return envelope({ ok: true, output: [] });
      }
      return fail(`${job.cmdlet} has no fake`, 'NoFake');
    };
    if (override === 'apply-then-timeout') { apply(); return { timeout: true }; }
    return apply();
  }

  function spawnFn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let input = '';
    child.stdin = {
      write(chunk) { input += chunk; },
      end() {
        queueMicrotask(() => {
          const result = run(JSON.parse(input));
          if (result.timeout) return;
          if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
          if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
          child.emit('close', result.exitCode);
        });
      },
    };
    return child;
  }

  return {
    state, calls,
    powershell: { spawnFn, timeoutMs: 50, tenantConfigPath: '/etc/keel/restorer.json' },
    contentCalls: () => contentCalls,
    cmdlets: () => calls.map((call) => call.cmdlet),
    writes: () => calls.filter((call) => call.cmdlet.startsWith('Set-')).map((call) => call.cmdlet),
  };
}

// --------------------------------------------------------------- ledgers

const liveCapture = (operationId, tenantRef) => {
  const descriptor = WORKLOAD_DESCRIPTORS.find((item) => item.id === operationId);
  const version = descriptor.operation.kind === 'graph' ? descriptor.operation.version : descriptor.operation.module === 'PnP.PowerShell' ? PNP_VERSION : EXO_VERSION;
  return { operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-03T00:00:00Z', version, ok: true, proofRef: `${operationId}@sha256:x` };
};
const fixtureRun = (operationId) => ({ operationId, kind: 'fixture', synthetic: true, ok: true, proofRef: `${operationId}.fixture` });
const COLLECTOR_GRANTS = Object.freeze({
  permissions: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.permissions))],
  roles: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.roles))],
});
const RUNTIME = Object.freeze({ modules: { ExchangeOnlineManagement: EXO_VERSION, 'PnP.PowerShell': PNP_VERSION, MicrosoftTeams: '6.0.0' } });
/** The real task-101 ledger, built from the evidence named in `live` (and fixture proof for the rest). */
function ledgerWith(tenantRef, live) {
  const evidence = WORKLOAD_DESCRIPTORS.map((descriptor) => (live.includes(descriptor.id) ? liveCapture(descriptor.id, tenantRef) : fixtureRun(descriptor.id)));
  return buildWorkloadLedger({ evidence, grants: COLLECTOR_GRANTS, runtime: RUNTIME, tenantRef, now: NOW });
}
const PREDECESSOR_READS = Object.freeze([...SHAREPOINT_OPERATIONS, 'sharepoint.site-sharing', ...TEAMS_OPERATIONS, ...EXCHANGE_OPERATIONS]);
const ALL_READS = Object.freeze(WORKLOAD_DESCRIPTORS.map((descriptor) => descriptor.id));

const liveWrite = (operationId, tenantRef, extra = {}) => {
  const declared = WORKLOAD_WRITE_OPERATIONS[operationId];
  return {
    operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: '2026-10-02T00:00:00Z',
    version: declared.kind === 'cmdlet' ? EXO_VERSION : declared.version, ok: true, readBackVerified: true, proofRef: `${operationId}.json@sha256:x`, ...extra,
  };
};
const PREDECESSOR_WRITES = Object.freeze(['sharepoint.tenant-settings.update', 'teams.settings.update', 'exchange.client-access.update']);
const RESTORER_GRANTS = Object.freeze({ permissions: ['SharePointTenantSettings.ReadWrite.All', 'TeamSettings.ReadWrite.All', 'Exchange.ManageAsApp'], roles: ['SharePoint Administrator', 'Exchange Administrator', 'Compliance Administrator'] });
function qualifications(tenantRef, { writes = [...PREDECESSOR_WRITES, ...PURVIEW_WRITE_OPERATIONS], grants = RESTORER_GRANTS, runtime = RUNTIME, reads = ALL_READS } = {}) {
  const evidence = writes.map((id) => liveWrite(id, tenantRef));
  const readLedger = ledgerWith(tenantRef, reads);
  return Object.fromEntries(PURVIEW_WRITE_OPERATIONS.map((id) => [id, workloadWriteQualification(id, { readLedger, evidence, tenantRef, now: NOW, runtime, grants })]));
}

let principalSeq = 0;
async function principal(client, name) {
  const { rows } = await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [`${name}-${principalSeq += 1}@example.test`]);
  return rows[0].id;
}

async function evidenceRows(client, tenantRef) {
  const { rows } = await client.query(`SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = $2 ORDER BY seq`, [tenantRef, PURVIEW_RESTORE_EVIDENCE_KIND]);
  return rows.map((row) => row.subject);
}

const sourceTenant = () => fakeTenant();
async function recordedSource(client, tenantRef, tenant = sourceTenant()) {
  const ledger = ledgerWith(tenantRef, ALL_READS);
  const { run } = await collectPurview(client, { tenantRef, ledger, powershell: tenant.powershell, now: () => NOW });
  return loadPurviewCollection(client, { tenantRef, collectionId: run.id });
}
async function planned(client, tenantRef, live, targets, source = null) {
  const recorded = source ?? await recordedSource(client, tenantRef);
  const read = await readPurview({ powershell: live.powershell });
  live.calls.length = 0;
  const plan = planPurviewRestore({ source: recorded, live: read, tenantId: TENANT, targets });
  const artifact = await createPurviewRestoreArtifact(client, { tenantRef, plan, requestedBy: await principal(client, 'requester') });
  return { plan, artifact };
}

// ------------------------------------------------------- OneDrive reads

test('OneDrive reads named sites one by one, records inherited versus explicit state, and never crawls', async (t) => {
  const tenant = fakeTenant({ sites: { [ALICE]: SITE, [BOB]: { ...SITE, Url: BOB, DefaultSharingLinkType: 'Internal', OverrideTenantExternalUserExpirationPolicy: true } } });
  const result = await readOneDrive({
    powershell: tenant.powershell, myHost: MY_HOST, now: () => NOW,
    sites: [ALICE, BOB, `${ALICE}/Documents/Q3.docx`, `https://contoso.sharepoint.com/sites/finance`, `${ALICE}?web=1`, ALICE.toUpperCase().replace('HTTPS', 'https')],
  });
  // Exactly one Get-PnPTenantSite per named site, by -Identity: no listing, no item, no file.
  assert.deepEqual(tenant.calls.map((call) => [call.cmdlet, call.args]), [['Get-PnPTenantSite', [['Identity', ALICE]]], ['Get-PnPTenantSite', [['Identity', BOB]]]]);
  assert.ok(tenant.calls.every((call) => call.session === 'PnP.PowerShell:pnp'));
  assert.equal(tenant.contentCalls(), 0);
  assert.equal(result.discovery.crawl, false);
  assert.equal(result.outOfScope.length, 3, 'a path inside a site, another host and a query are refused with nothing sent');
  assert.equal(result.outcome, 'partial');

  const alice = result.resources.find((entry) => entry.resourceKey === siteKey(ALICE));
  const bob = result.resources.find((entry) => entry.resourceKey === siteKey(BOB));
  const inheritance = (entry, field) => entry.fieldCoverage[field].inheritance;
  assert.equal(inheritance(alice, 'DefaultSharingLinkType'), 'inherited');
  assert.equal(inheritance(bob, 'DefaultSharingLinkType'), 'explicit');
  assert.equal(inheritance(alice, 'ExternalUserExpirationInDays'), 'inherited');
  assert.equal(inheritance(bob, 'ExternalUserExpirationInDays'), 'explicit');
  assert.equal(inheritance(alice, 'AnonymousLinkExpirationInDays'), 'explicit');
  assert.equal(inheritance(alice, 'SharingCapability'), 'explicit');
  assert.equal(inheritance(alice, 'StorageQuota'), 'undetermined');
  // The inherited value is still recorded as the value the site shows.
  assert.equal(alice.fields.ExternalUserExpirationInDays, 60);
  assert.deepEqual(Object.keys(alice.fieldCoverage).sort(), Object.keys(ONEDRIVE_FIELDS).sort());

  // Only the declared cmdlet and parameter; file and item cmdlets are refused.
  for (const cmdlet of ['Get-PnPFile', 'Get-PnPListItem', 'Get-PnPFolderItem', 'Get-PnPFileSharingLink', 'Get-PnPList', 'Set-PnPTenantSite']) {
    assert.throws(() => assertOneDriveCmdlet({ cmdlet }), OneDriveScopeError, cmdlet);
  }
  assert.throws(() => assertOneDriveCmdlet({ cmdlet: 'Get-PnPTenantSite', parameters: { IncludeOneDriveSites: true } }), /does not take IncludeOneDriveSites/);
  assert.deepEqual(Object.fromEntries(Object.entries(ONEDRIVE_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), ALLOWED['PnP.PowerShell:pnp']);

  // A site that is not a personal site is refused, never read as OneDrive.
  const team = fakeTenant({ sites: { [ALICE]: { ...SITE, Template: 'GROUP#0' } } });
  const [notOneDrive] = (await readOneDrive({ powershell: team.powershell, myHost: MY_HOST, sites: [ALICE] })).resources;
  assert.equal(notOneDrive.fieldCoverage.SharingCapability.status, 'refused');
  assert.equal(notOneDrive.fieldCoverage.SharingCapability.error.code, 'NOT_ONEDRIVE');

  // A failed read is structured, never an empty success; it persists as such.
  const failing = fakeTenant({ sites: {} });
  const failed = await readOneDrive({ powershell: failing.powershell, myHost: MY_HOST, sites: [ALICE] });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.resources[0].fieldCoverage.LockState.status, 'failed');
  assert.equal(failed.resources[0].fieldCoverage.LockState.error.code, 'CMDLET_ERROR');

  // Persisted with inheritance per field.
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const enabled = await collectOneDrive(client, { tenantRef, ledger: ledgerWith(tenantRef, ALL_READS), powershell: tenant.powershell, myHost: MY_HOST, sites: [ALICE], now: () => NOW });
  assert.equal(enabled.result.outcome, 'complete');
  const { rows: [row] } = await client.query(`SELECT field_coverage FROM workload_observation WHERE collection_id = $1`, [enabled.run.id]);
  assert.equal(row.field_coverage.ExternalUserExpirationInDays.inheritance, 'inherited');
  assert.equal(row.field_coverage.AnonymousLinkExpirationInDays.inheritance, 'explicit');
});

test('an inherited setting is distinguished from an explicit value when OneDrive sites are compared', async () => {
  const read = async (site) => (await readOneDrive({ powershell: fakeTenant({ sites: { [ALICE]: site } }).powershell, myHost: MY_HOST, sites: [ALICE] })).resources[0];
  const baseline = await read(SITE);

  // Same shown value, but the site now owns it: an inheritance change, not "no change".
  const pinned = await read({ ...SITE, OverrideTenantExternalUserExpirationPolicy: true });
  const pinnedDiff = compareOneDriveSites(baseline, pinned);
  const expiry = pinnedDiff.changes.find((change) => change.field === 'ExternalUserExpirationInDays');
  assert.ok(expiry, 'a site that stopped following the tenant default is a change even with the same value');
  assert.equal(expiry.change, 'inheritance');
  assert.deepEqual([expiry.before, expiry.after], [{ value: 60, inheritance: 'inherited' }, { value: 60, inheritance: 'explicit' }]);
  assert.equal(expiry.siteChange, true);

  // The tenant default moved; the site still follows it. Not a site change.
  const tenantMoved = await read({ ...SITE, ExternalUserExpirationInDays: 30 });
  const moved = compareOneDriveSites(baseline, tenantMoved).changes.find((change) => change.field === 'ExternalUserExpirationInDays');
  assert.equal(moved.change, 'inherited-default');
  assert.equal(moved.siteChange, false);

  // An explicit value changed on the site itself.
  const shortened = await read({ ...SITE, AnonymousLinkExpirationInDays: 30 });
  const own = compareOneDriveSites(baseline, shortened).changes.find((change) => change.field === 'AnonymousLinkExpirationInDays');
  assert.equal(own.change, 'value');
  assert.equal(own.siteChange, true);

  // Every change is manual: no OneDrive write is declared.
  assert.ok(Object.values(WORKLOAD_WRITE_OPERATIONS).every((write) => write.workload !== 'onedrive-site-settings'));
  assert.ok([expiry, moved, own].every((change) => change.restore === 'manual'));

  // A legacy observation recorded without inheritance reads as undetermined, never explicit.
  const legacy = structuredClone(baseline);
  for (const coverage of Object.values(legacy.fieldCoverage)) delete coverage.inheritance;
  assert.equal(compareOneDriveSites(legacy, pinned).changes.some((change) => change.field === 'ExternalUserExpirationInDays'), false);

  // A locked site is flagged; its changes are never planned as writes.
  const locked = compareOneDriveSites(baseline, await read({ ...SITE, LockState: 'ReadOnly', SharingCapability: 'Disabled' }));
  assert.equal(locked.locked, true);
  assert.match(locked.changes.find((change) => change.field === 'SharingCapability').reason, /locked .*never changes or unlocks/);
});

// ---------------------------------------------------------- Purview reads

test('label definitions and their publication are read and change-tracked without reading labeled content', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const ledger = ledgerWith(tenantRef, ALL_READS);
  const tenant = fakeTenant();
  const first = await collectPurview(client, { tenantRef, ledger, powershell: tenant.powershell, now: () => NOW });
  assert.equal(first.result.outcome, 'complete');
  assert.equal(first.result.labelChanges, null, 'nothing to compare on the first run');
  // Only the two definition cmdlets ran, with no parameters, in the compliance session.
  assert.deepEqual(tenant.calls.map((call) => [call.cmdlet, call.session, call.args.length]), [
    ['Get-Label', 'ExchangeOnlineManagement:ipps', 0], ['Get-LabelPolicy', 'ExchangeOnlineManagement:ipps', 0],
  ]);
  assert.equal(tenant.contentCalls(), 0);
  assert.equal(first.result.discovery.itemCrawl, false);
  assert.doesNotMatch(JSON.stringify(first.result), /LabelUsageCount|LabeledItems|Q3 board pack/);
  const { rows: stored } = await client.query(`SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key`, [first.run.id]);
  // Compared as a set: ORDER BY on text follows the database collation.
  assert.deepEqual(stored.map((row) => row.resource_key).sort(), [`label-policy:${POLICY}`, `label:${CONFIDENTIAL}`, `label:${PUBLIC}`].sort());
  assert.doesNotMatch(JSON.stringify(stored), /LabelUsageCount|LabeledItems|Q3 board pack/);

  // An unchanged second run reports no change, though every save time moved.
  for (const item of [...tenant.state.labels, ...tenant.state.policies]) item.WhenChangedUTC = '2026-10-04T00:00:00Z';
  const quiet = await collectPurview(client, { tenantRef, ledger, powershell: tenant.powershell, now: () => NOW });
  assert.deepEqual(quiet.result.labelChanges, { added: [], removed: [], changed: [] });

  // A label renamed and re-encrypted, a label added, a label deleted, and the policy changed.
  const confidential = tenant.state.labels.find((item) => item.ImmutableId === CONFIDENTIAL);
  Object.assign(confidential, { DisplayName: 'Confidential - Finance', EncryptionEnabled: true });
  tenant.state.labels = tenant.state.labels.filter((item) => item.ImmutableId !== PUBLIC);
  tenant.state.labels.push(label(SECRET, 'Secret'));
  tenant.state.policies[0].Labels = ['Confidential', 'Secret'];
  tenant.calls.length = 0;
  const changed = await collectPurview(client, { tenantRef, ledger, powershell: tenant.powershell, now: () => NOW });
  assert.deepEqual(changed.result.labelChanges, {
    added: [`label:${SECRET}`],
    removed: [`label:${PUBLIC}`],
    changed: [
      { resourceKey: `label:${CONFIDENTIAL}`, fields: ['DisplayName', 'EncryptionEnabled'], unknown: [] },
      { resourceKey: `label-policy:${POLICY}`, fields: ['Labels'], unknown: [] },
    ],
  });
  const { rows: [run] } = await client.query(`SELECT digest FROM workload_collection WHERE id = $1`, [changed.run.id]);
  assert.deepEqual(run.digest.labelChanges.added, [`label:${SECRET}`]);
  // Tracking the change read nothing beyond the definitions.
  assert.deepEqual(tenant.cmdlets(), ['Get-Label', 'Get-LabelPolicy']);
  assert.equal(tenant.contentCalls(), 0);

  // A family that fails is unknown, never "every policy was removed".
  const broken = fakeTenant({ hooks: { cmdlet: ({ cmdlet }) => (cmdlet === 'Get-LabelPolicy' ? { error: { message: 'The term Get-LabelPolicy is not recognized', category: 'ObjectNotFound', errorId: 'CommandNotFoundException' } } : null) } });
  const partial = await readPurview({ powershell: broken.powershell, previous: (await loadPurviewCollection(client, { tenantRef })).observations });
  assert.equal(partial.outcome, 'partial');
  assert.equal(partial.failures[0].error.code, 'CMDLET_ERROR');
  assert.equal(partial.labelChanges.removed.includes(`label-policy:${POLICY}`), false);

  // Only the declared cmdlets; labeled-item, usage and search cmdlets are refused.
  for (const cmdlet of ['Get-PnPFile', 'Get-PnPListItem', 'Export-ContentExplorerData', 'Export-ActivityExplorerData', 'Get-ComplianceSearch', 'Remove-Label', 'Set-LabelPolicy -RemoveLabels']) {
    assert.throws(() => assertPurviewCmdlet({ cmdlet }), PurviewScopeError, cmdlet);
  }
  assert.throws(() => assertPurviewCmdlet({ cmdlet: 'Set-LabelPolicy', parameters: { Identity: POLICY, RemoveLabels: ['Public'] } }), /does not take RemoveLabels/);
  assert.throws(() => assertPurviewCmdlet({ cmdlet: 'Set-Label', parameters: { Identity: CONFIDENTIAL, EncryptionEnabled: false } }), /does not take EncryptionEnabled/);
  assert.deepEqual(Object.fromEntries(Object.entries(PURVIEW_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), ALLOWED['ExchangeOnlineManagement:ipps']);
  // Every read cmdlet the workloads run passes the task-101 configuration-scope validator.
  for (const cmdlet of [...Object.keys(PURVIEW_CMDLET_PARAMETERS), ...Object.keys(ONEDRIVE_CMDLET_PARAMETERS)].filter((name) => name.startsWith('Get-'))) {
    assert.deepEqual(scopeProblems({ kind: 'cmdlet', cmdlet, module: 'x' }), [], cmdlet);
    assert.doesNotMatch(cmdlet, CONTENT_CMDLET);
  }
  // Two empty runs compare as no change.
  assert.deepEqual(trackLabelChanges([], []), { added: [], removed: [], changed: [] });
});

// ----------------------------------------------------------- activation

// Get-Label as ExchangeOnlineManagement 3.10.1 returns it (Q34, 2026-10-05): no protection
// properties, LabelActions as JSON strings. Copied from the protected fixture label's dump.
const LIVE_LABEL_ACTIONS = [
  '{"Type":"applycontentmarking","SubType":"footer","Settings":[{"Key":"disabled","Value":"false"},{"Key":"text","Value":"KEEL-RT fixture"}]}',
  '{"Type":"applycontentmarking","SubType":"header","Settings":[{"Key":"disabled","Value":"false"},{"Key":"text","Value":"KEEL-RT fixture"}]}',
  '{"Type":"applywatermarking","SubType":null,"Settings":[{"Key":"disabled","Value":"false"},{"Key":"layout","Value":"Diagonal"}]}',
  '{"Type":"encrypt","SubType":null,"Settings":[{"Key":"donotforward","Value":"true"},{"Key":"disabled","Value":"false"},{"Key":"encryptonly","Value":"false"},{"Key":"promptuser","Value":"true"},{"Key":"protectiontype","Value":"userdefined"}]}',
  '{"Type":"protectgroup","SubType":null,"Settings":[{"Key":"allowaccesstoguestusers","Value":"false"},{"Key":"allowemailfromguestusers","Value":"false"},{"Key":"disabled","Value":"false"},{"Key":"privacy","Value":"private"}]}',
  '{"Type":"protectsite","SubType":null,"Settings":[{"Key":"allowfullaccess","Value":"false"},{"Key":"externalsharingcontroltype","Value":"ExistingExternalUserSharingOnly"},{"Key":"disabled","Value":"false"}]}',
];
const liveLabel = (id, name, extra = {}) => {
  const body = label(id, name, extra);
  for (const field of LABEL_ACTION_FIELDS) if (!(field in extra)) delete body[field];
  return body;
};

test('protection fields are read from LabelActions when Get-Label does not return them as properties', async () => {
  assert.deepEqual(labelActionFields({ LabelActions: LIVE_LABEL_ACTIONS }), {
    EncryptionEnabled: true, EncryptionProtectionType: 'UserDefined', EncryptionOfflineAccessDays: null,
    ApplyContentMarkingHeaderEnabled: true, ApplyContentMarkingFooterEnabled: true, ApplyWaterMarkingEnabled: true,
    SiteAndGroupProtectionEnabled: true, SiteAndGroupProtectionPrivacy: 'Private', SiteAndGroupProtectionAllowAccessToGuestUsers: false,
    SiteExternalSharingControlType: 'ExistingExternalUserSharingOnly',
  });
  // A label with no actions has none of them; a disabled action does not count.
  const plain = labelActionFields({ LabelActions: ['{"Type":"encrypt","SubType":null,"Settings":[{"Key":"disabled","Value":"true"}]}'] });
  assert.equal(plain.EncryptionEnabled, false);
  assert.equal(plain.SiteAndGroupProtectionEnabled, false);
  assert.equal(plain.SiteAndGroupProtectionPrivacy, null);
  assert.equal(labelActionFields({ LabelActions: [] }).ApplyWaterMarkingEnabled, false);
  // Encryption with a template and offline access keeps the day count as a number.
  assert.equal(labelActionFields({ LabelActions: [{ Type: 'encrypt', Settings: [{ Key: 'protectiontype', Value: 'template' }, { Key: 'offlineaccessdays', Value: '7' }] }] }).EncryptionOfflineAccessDays, 7);
  // No list, or one KEEL cannot parse, derives nothing: the fields stay unknown.
  assert.equal(labelActionFields({}), null);
  assert.equal(labelActionFields({ LabelActions: ['{not json'] }), null);
  assert.equal(labelActionFields({ LabelActions: [{ SubType: 'header' }] }), null);

  const tenant = fakeTenant();
  tenant.state.labels = [
    liveLabel(CONFIDENTIAL, 'Confidential', { LabelActions: LIVE_LABEL_ACTIONS }),
    liveLabel(PUBLIC, 'Public'),
    // A property the module does return wins over LabelActions.
    liveLabel(SECRET, 'Secret', { EncryptionEnabled: false, LabelActions: LIVE_LABEL_ACTIONS }),
  ];
  const read = await readPurview({ powershell: tenant.powershell });
  const byKey = Object.fromEntries(read.resources.map((entry) => [entry.resourceKey, entry]));
  const confidential = byKey[`label:${CONFIDENTIAL}`];
  for (const field of LABEL_ACTION_FIELDS) assert.equal(confidential.fieldCoverage[field].status, 'observed', field);
  assert.equal(confidential.fields.EncryptionProtectionType, 'UserDefined');
  assert.equal(confidential.fields.LabelActions, undefined, 'the raw list is not stored');
  for (const field of LABEL_ACTION_FIELDS) assert.equal(byKey[`label:${PUBLIC}`].fieldCoverage[field].status, 'unknown', field);
  assert.equal(byKey[`label:${SECRET}`].fields.EncryptionEnabled, false);
  assert.equal(byKey[`label:${SECRET}`].fields.ApplyWaterMarkingEnabled, true);
  assert.deepEqual(tenant.cmdlets(), ['Get-Label', 'Get-LabelPolicy']);
});

test('proof for another family cannot enable OneDrive or Purview reads or writes', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();

  // Everything before OneDrive is live, including sharepoint.site-sharing, which runs the
  // same Get-PnPTenantSite cmdlet. That proof is SharePoint's, not OneDrive's.
  const predecessorsOnly = ledgerWith(tenantRef, PREDECESSOR_READS);
  assert.equal(predecessorsOnly.rows.find((row) => row.id === 'sharepoint.site-sharing').enabled, true);
  const onedrive = oneDriveActivation(predecessorsOnly);
  assert.equal(onedrive.enabled, false);
  assert.match(onedrive.reasons.join('; '), /onedrive\.site-settings is fixture-tested/);
  const purview = purviewActivation(predecessorsOnly);
  assert.equal(purview.enabled, false);
  assert.match(purview.reasons.join('; '), /purview\.label-definitions is fixture-tested/);

  const tenant = fakeTenant();
  const disabled = await collectOneDrive(client, { tenantRef, ledger: predecessorsOnly, powershell: tenant.powershell, myHost: MY_HOST, sites: [ALICE], now: () => NOW });
  assert.equal(disabled.run.outcome, 'disabled');
  const disabledPurview = await collectPurview(client, { tenantRef, ledger: predecessorsOnly, powershell: tenant.powershell, now: () => NOW });
  assert.equal(disabledPurview.run.outcome, 'disabled');
  assert.deepEqual(tenant.calls, [], 'nothing is sent while disabled');

  // OneDrive and Purview proof without Exchange does not activate either.
  const withoutExchange = ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)));
  assert.match(oneDriveActivation(withoutExchange).reasons[0], /Exchange is not qualified yet/);
  assert.match(purviewActivation(withoutExchange).reasons[0], /Exchange is not qualified yet/);
  // OneDrive proof never activates Purview, and the reverse.
  assert.equal(purviewActivation(ledgerWith(tenantRef, [...PREDECESSOR_READS, 'onedrive.site-settings'])).enabled, false);
  assert.equal(oneDriveActivation(ledgerWith(tenantRef, [...PREDECESSOR_READS, ...PURVIEW_OPERATIONS])).enabled, false);
  assert.equal(oneDriveActivation(ledgerWith(tenantRef, ALL_READS)).enabled, true);
  assert.equal(purviewActivation(ledgerWith(tenantRef, ALL_READS)).enabled, true);

  // Writes: every predecessor write is live, Purview has none of its own.
  const borrowed = qualifications(tenantRef, { writes: PREDECESSOR_WRITES });
  for (const id of PURVIEW_WRITE_OPERATIONS) {
    assert.equal(borrowed[id].enabled, false, id);
    assert.equal(borrowed[id].state, 'disabled', id);
  }
  // A predecessor capture relabelled as another operation still names the predecessor.
  const relabelled = workloadWriteQualification(PURVIEW_LABEL_WRITE, {
    readLedger: ledgerWith(tenantRef, ALL_READS), evidence: [...PREDECESSOR_WRITES.map((id) => liveWrite(id, tenantRef)), liveWrite(PURVIEW_POLICY_WRITE, tenantRef)],
    tenantRef, now: NOW, runtime: RUNTIME, grants: RESTORER_GRANTS,
  });
  assert.equal(relabelled.enabled, false, 'label-policy proof is not label proof');
  // Its own proof, but a missing predecessor, unknown grants, the wrong role or another module version: disabled.
  assert.equal(qualifications(tenantRef, { writes: [...PREDECESSOR_WRITES.slice(0, 2), ...PURVIEW_WRITE_OPERATIONS] })[PURVIEW_LABEL_WRITE].enabled, false);
  assert.equal(qualifications(tenantRef, { grants: null })[PURVIEW_LABEL_WRITE].enabled, false);
  assert.equal(qualifications(tenantRef, { grants: { ...RESTORER_GRANTS, roles: ['SharePoint Administrator', 'Exchange Administrator'] } })[PURVIEW_LABEL_WRITE].enabled, false);
  assert.equal(qualifications(tenantRef, { runtime: { modules: { ...RUNTIME.modules, ExchangeOnlineManagement: '3.6.0' } } })[PURVIEW_LABEL_WRITE].enabled, false);
  assert.equal(qualifications(tenantRef, { reads: [...PREDECESSOR_READS, 'onedrive.site-settings'] })[PURVIEW_LABEL_WRITE].enabled, false, 'the read-back must be enabled');
  const all = qualifications(tenantRef);
  assert.deepEqual(PURVIEW_WRITE_OPERATIONS.map((id) => all[id].enabled), [true, true]);

  // A restore with proof for the policy write only sends only Set-LabelPolicy.
  const live = fakeTenant({
    labels: [label(CONFIDENTIAL, 'Confidential', { DisplayName: 'Renamed' }), label(PUBLIC, 'Public')],
    policies: [policy({ Labels: ['Confidential'] })],
  });
  const { artifact } = await planned(client, tenantRef, live, [`label:${CONFIDENTIAL}`, `label-policy:${POLICY}`]);
  const policyOnly = qualifications(tenantRef, { writes: [...PREDECESSOR_WRITES, PURVIEW_POLICY_WRITE] });
  const result = await executePurviewRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, powershell: live.powershell, qualifications: policyOnly });
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.operations.map((op) => [op.kind, op.outcome]), [['label', 'disabled'], ['policy', 'verified']]);
  assert.deepEqual(live.writes(), ['Set-LabelPolicy']);

  // Coverage lists both workloads, disabled; neither enters an Entra wave.
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === 'onedrive-site-settings' && descriptor.enabledByDefault === false));
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === 'purview-labels' && descriptor.enabledByDefault === false));
  const report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [], now: NOW });
  assert.ok(report.workloads.some((entry) => entry.workload === 'purview-labels'));
  assert.ok(report.workloads.some((entry) => entry.workload === 'onedrive-site-settings'));
  for (const resourceType of ['onedriveSite', 'purviewLabel', 'purviewLabelPolicy']) {
    assert.throws(() => planWaves([{ naturalKey: 'x', resourceType, verb: 'update', payload: {} }]), /workload restore path/);
    assert.throws(() => planDeletionWaves([{ naturalKey: 'x', resourceType, verb: 'delete', payload: {} }]), /workload restore path/);
  }
});

// ------------------------------------------------------------- restores

test('a Purview restore writes only display text and added labels, never weakens protection, and verifies by read-back', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  // Live drift: renamed with a new tooltip, encryption turned ON, a label removed from
  // the policy, a new label added to it, and the policy's mail location narrowed.
  const live = fakeTenant({
    labels: [
      label(CONFIDENTIAL, 'Confidential', { DisplayName: 'Conf', Tooltip: 'changed', EncryptionEnabled: true, Priority: 5 }),
      label(PUBLIC, 'Public', { SiteAndGroupProtectionAllowAccessToGuestUsers: false }),
      label(SECRET, 'Secret'),
    ],
    policies: [policy({ Labels: ['Confidential', 'Secret'], ExchangeLocation: ['finance@contoso.test'] })],
  });
  const { plan, artifact } = await planned(client, tenantRef, live, [`label:${CONFIDENTIAL}`, `label-policy:${POLICY}`, `label:${SECRET}`]);
  assert.deepEqual(plan.refusals, []);
  assert.deepEqual(plan.operations.map((op) => [op.cmdlet, op.parameters]), [
    ['Set-Label', { Identity: CONFIDENTIAL, DisplayName: 'Confidential', Tooltip: 'Confidential information' }],
    ['Set-LabelPolicy', { Identity: POLICY, AddLabels: ['Public'] }],
  ]);
  const manual = (field) => plan.manual.find((item) => item.field === field);
  // Turning encryption back off would weaken protection: listed, never written.
  assert.equal(manual('EncryptionEnabled').weakensProtection, true);
  // Removing Secret from the policy would unpublish it: never written.
  assert.match(manual('Labels').reason, /removing Secret .*never does that/);
  // Putting the location back drops an entry the live policy names: counted as
  // weakening (conservative, entries are not interpreted), never written.
  assert.equal(manual('ExchangeLocation').weakensProtection, true);
  // A setting KEEL cannot judge (priority decides which label wins) is never written either.
  assert.equal(manual('Priority').weakensProtection, null);
  assert.equal(manual('Settings'), undefined, 'unchanged settings are not listed');
  // A label the source never had is not deleted.
  assert.match(plan.manual.find((item) => item.resourceKey === `label:${SECRET}`).reason, /never deletes a label/);
  assert.ok(plan.excluded.some((item) => item.field === 'itemAppliedLabels'));

  const result = await executePurviewRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, powershell: live.powershell, qualifications: qualifications(tenantRef) });
  assert.equal(result.outcome, 'verified');
  assert.deepEqual(live.writes(), ['Set-Label', 'Set-LabelPolicy']);
  assert.equal(live.contentCalls(), 0);
  const confidential = live.state.labels.find((item) => item.ImmutableId === CONFIDENTIAL);
  assert.equal(confidential.DisplayName, 'Confidential');
  assert.equal(confidential.EncryptionEnabled, true, 'protection KEEL found stays in place');
  assert.deepEqual(live.state.policies[0].Labels, ['Confidential', 'Secret', 'Public']);
  const rows = await evidenceRows(client, tenantRef);
  assert.deepEqual(rows.map((row) => [row.operationId, row.outcome]), [[PURVIEW_LABEL_WRITE, 'verified'], [PURVIEW_POLICY_WRITE, 'verified'], ['purview.restore', 'verified']]);
  assert.deepEqual(rows[0].verified, ['DisplayName', 'Tooltip']);

  // A change after the plan makes only that operation stale; a lost answer is never resent.
  const tenant2 = nextTenant();
  const drift = fakeTenant({
    labels: [label(CONFIDENTIAL, 'Confidential', { DisplayName: 'Conf' }), label(PUBLIC, 'Public')],
    policies: [policy({ Labels: ['Confidential'] })],
    hooks: { cmdlet: ({ cmdlet }) => (cmdlet === 'Set-LabelPolicy' ? 'apply-then-timeout' : null) },
  });
  const second = await planned(client, tenant2, drift, [`label:${CONFIDENTIAL}`, `label-policy:${POLICY}`]);
  drift.state.labels[0].Comment = 'edited by an administrator';
  const raced = await executePurviewRestore(client, { tenantRef: tenant2, artifactId: second.artifact.id, tenantId: TENANT, powershell: drift.powershell, qualifications: qualifications(tenant2) });
  assert.deepEqual(raced.operations.map((op) => [op.kind, op.outcome]), [['label', 'stale'], ['policy', 'verified']]);
  assert.match(raced.operations[1].reasons[0], /unknown .*not resent/);
  assert.deepEqual(drift.writes(), ['Set-LabelPolicy']);

  // Another tenant id is refused before anything is sent.
  const other = await executePurviewRestore(client, { tenantRef: tenant2, artifactId: second.artifact.id, tenantId: '00000000-0000-4000-8000-0000000000f2', powershell: drift.powershell, qualifications: qualifications(tenant2) });
  assert.equal(other.outcome, 'refused');
});

test('a preservation lock refuses, at plan time, before writing and from the platform', async (t) => {
  const client = await schemaClient(t);

  // Locked when planned: the dry run is refused and cannot be promoted.
  const tenantRef = nextTenant();
  const locked = fakeTenant({ policies: [policy({ Labels: ['Confidential'], RestrictiveRetention: true })] });
  const { plan, artifact } = await planned(client, tenantRef, locked, [`label-policy:${POLICY}`]);
  assert.equal(plan.lock[`label-policy:${POLICY}`], 'locked');
  assert.match(plan.refusals[0].reason, /preservation-locked/);
  assert.equal(artifact.status, 'refused');
  const refused = await executePurviewRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, powershell: locked.powershell, qualifications: qualifications(tenantRef) });
  assert.equal(refused.outcome, 'refused');
  assert.deepEqual(locked.writes(), []);

  // Locked after the plan: refused before writing, nothing sent.
  const tenant2 = nextTenant();
  const later = fakeTenant({ policies: [policy({ Labels: ['Confidential'], RestrictiveRetention: false })] });
  const second = await planned(client, tenant2, later, [`label-policy:${POLICY}`]);
  assert.equal(second.plan.lock[`label-policy:${POLICY}`], 'unlocked');
  later.state.policies[0].RestrictiveRetention = true;
  const after = await executePurviewRestore(client, { tenantRef: tenant2, artifactId: second.artifact.id, tenantId: TENANT, powershell: later.powershell, qualifications: qualifications(tenant2) });
  assert.deepEqual(after.operations.map((op) => op.outcome), ['refused']);
  assert.match(after.operations[0].reasons[0], /preservation lock/);
  assert.deepEqual(later.writes(), []);

  // The platform refuses for a lock: recorded once with its error, never retried.
  const tenant3 = nextTenant();
  const platform = fakeTenant({
    policies: [policy({ Labels: ['Confidential'] })],
    hooks: { cmdlet: ({ cmdlet }) => (cmdlet === 'Set-LabelPolicy' ? { error: { message: 'The policy is under Preservation Lock and cannot be changed.', category: 'InvalidOperation', errorId: 'PreservationLockException' } } : null) },
  });
  const third = await planned(client, tenant3, platform, [`label-policy:${POLICY}`]);
  const blocked = await executePurviewRestore(client, { tenantRef: tenant3, artifactId: third.artifact.id, tenantId: TENANT, powershell: platform.powershell, qualifications: qualifications(tenant3) });
  assert.deepEqual(blocked.operations.map((op) => op.outcome), ['refused']);
  assert.deepEqual(platform.writes(), ['Set-LabelPolicy']);
  const [row] = await evidenceRows(client, tenant3);
  assert.equal(row.error.errorId, 'PreservationLockException');
});
