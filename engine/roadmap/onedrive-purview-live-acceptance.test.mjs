// Roadmap task-123: OneDrive and Purview configuration qualification.
//
// Acceptance:
//  - a valid independently captured record verifies;
//  - altered signature/digest, wrong tenant/build/operation, stale evidence and a
//    missing prerequisite fail.
// Mutation checks:
//  - accept missing external evidence;
//  - accept mismatched tenant or operation;
//  - elevate fixture evidence to live-qualified.
//
// All four capture tools (task-120 SharePoint, task-121 Teams, task-122 Exchange and
// task-123 OneDrive/Purview) run against in-memory fakes: Graph transports, and fake
// PowerShell containers behind the real engine/powershell/jobQueue.mjs spawn path that
// play the ops/powershell/run-cmdlet.ps1 contract (its allowlists are parsed from the
// script). Records are signed with a test-only key in a temporary directory. No tenant,
// OneDrive, label or policy is read or written, and no record produced here is
// persisted as release evidence.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildWorkloadLedger } from '../collect/workloadContract.mjs';
import { oneDriveActivation } from '../collect/workloads/onedrive.mjs';
import { purviewActivation } from '../collect/workloads/purview.mjs';
import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { signEvidence, verifyEvidence, verifyEvidenceFile } from '../../tools/release/qualification.mjs';
import { SHAREPOINT_LIVE_GATE, requiredDocumentation, requiredGrants } from '../../tools/qualification/sharepointAcceptance.mjs';
import { captureSharePointAcceptance, ledgerEvidenceFromAcceptance, writeAcceptanceFiles } from '../../tools/qualification/sharepointLive.mjs';
import { TEAMS_LIVE_GATE, teamsRequiredDocumentation, teamsRequiredGrants } from '../../tools/qualification/teamsAcceptance.mjs';
import { captureTeamsAcceptance, ledgerEvidenceFromTeamsAcceptance, writeTeamsAcceptanceFiles } from '../../tools/qualification/teamsLive.mjs';
import { EXCHANGE_LIVE_GATE, exchangeRequiredDocumentation, exchangeRequiredGrants } from '../../tools/qualification/exchangeAcceptance.mjs';
import { captureExchangeAcceptance, ledgerEvidenceFromExchangeAcceptance, writeExchangeAcceptanceFiles } from '../../tools/qualification/exchangeLive.mjs';
import {
  ONEDRIVE_PURVIEW_LIVE_GATE, ONEDRIVE_PURVIEW_READS, ONEDRIVE_PURVIEW_WRITES, onedrivePurviewPolicyAudienceProblems, onedrivePurviewRequiredDocumentation,
  onedrivePurviewRequiredGrants,
} from '../../tools/qualification/onedrivePurviewAcceptance.mjs';
import {
  captureOneDrivePurviewAcceptance, ledgerEvidenceFromOneDrivePurviewAcceptance, main as onedrivePurviewMain, writeOneDrivePurviewAcceptanceFiles,
} from '../../tools/qualification/onedrivePurviewLive.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const KEY = 'test-only';
const tenantRef = tenantRefFor('onedrive-purview-live-fixture');
const build = 'fixture-build';
const TENANT = '0f0f0f0f-0000-4000-8000-000000000001';
const OTHER_TENANT = '0f0f0f0f-0000-4000-8000-000000000002';
const observed = new Date('2026-10-03T08:00:00Z');
const verifyNow = new Date('2026-10-03T09:00:00Z');
const PNP_VERSION = '2.12.0';
const EXO_VERSION = '3.5.0';
const MODULES = { 'PnP.PowerShell': PNP_VERSION, ExchangeOnlineManagement: EXO_VERSION };

const dir = mkdtempSync(join(tmpdir(), 'keel-onedrive-purview-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const fixedClock = () => observed;
const noSleep = async () => {};

// ---- A fake container behind the real jobQueue spawn path, playing run-cmdlet.ps1.
function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const SESSIONS = Object.freeze({
  'ExchangeOnlineManagement:exo': containerAllowlist('Allowed'),
  'ExchangeOnlineManagement:ipps': containerAllowlist('AllowedPurview'),
  'PnP.PowerShell:pnp': containerAllowlist('AllowedPnP'),
});
// A file, list-item or labeled-content cmdlet: the fake answers it with content, so one such call would show.
const CONTENT_CMDLET = /File|ListItem|Folder|DriveItem|ContentExplorer|ActivityExplorer|ComplianceSearch|SensitivityLabel/;

function fakeContainer(handle) {
  const calls = [];
  const jobs = [];
  let contentCalls = 0;
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  function run(job) {
    jobs.push(job);
    if (job.mode !== 'cmdlet' || job.script !== undefined) return { stdout: '', stderr: 'refused descriptor', exitCode: 2 };
    if (CONTENT_CMDLET.test(job.cmdlet)) {
      contentCalls += 1;
      return envelope({ ok: true, output: [{ Name: 'Q3 board pack.docx', SensitivityLabel: 'Confidential' }] });
    }
    const session = Object.entries(SESSIONS).find(([key, list]) => key.startsWith(`${job.module}:`) && list[job.cmdlet]);
    if (!session) return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, errorId: 'CmdletNotAllowed' } }, 1);
    for (const name of Object.keys(job.parameters ?? {})) {
      if (!session[1][job.cmdlet].includes(name)) return envelope({ ok: false, error: { message: `parameter ${name} is not allowed`, errorId: 'ParameterNotAllowed' } }, 1);
    }
    calls.push({ cmdlet: job.cmdlet, session: session[0], parameters: job.parameters ?? {}, config: job.tenantConfigPath ?? null });
    const answer = handle(job.cmdlet, job.parameters ?? {});
    return answer.error ? envelope({ ok: false, error: answer.error }, 1) : envelope({ ok: true, output: answer.output ?? [] });
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
          if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
          if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
          child.emit('close', result.exitCode);
        });
      },
    };
    return child;
  }
  return { calls, jobs, spawnFn, contentCalls: () => contentCalls };
}

// ---- The task-120, task-121 and task-122 prerequisites: verified records beside this one.
const SP_HOST = 'contoso.sharepoint.com';
const SP_SITE = `${SP_HOST},11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222`;
const SP_URL = `https://${SP_HOST}/sites/KEEL-RT-20261003`;
const TEAM = '7e7e7e7e-1111-4111-8111-111111111111';
const MAILBOX = 'keel-rt-20260908-alice@contoso.test';

function sharePointGraph() {
  const settings = { sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'none', sharingAllowedDomainList: [], sharingBlockedDomainList: [], isResharingByExternalUsersEnabled: true };
  return async (url, init) => {
    const path = decodeURIComponent(new URL(url).pathname);
    if (path === '/v1.0/admin/sharepoint/settings') {
      if (init?.method === 'PATCH') { Object.assign(settings, init.body); return { status: 204, headers: {}, body: null }; }
      return { status: 200, headers: {}, body: structuredClone(settings) };
    }
    if (path === '/v1.0/sites/getAllSites') return { status: 200, headers: {}, body: { value: [{ id: SP_SITE, webUrl: SP_URL }] } };
    if (path === `/v1.0/sites/${SP_SITE}`) return { status: 200, headers: {}, body: { id: SP_SITE, webUrl: SP_URL } };
    if (path === `/v1.0/sites/${SP_SITE}/permissions`) return { status: 200, headers: {}, body: { value: [] } };
    return { status: 404, headers: {}, body: null };
  };
}

function teamsGraph() {
  const team = {
    id: TEAM, displayName: 'KEEL-RT-20261003', tenantId: TENANT, memberSettings: { allowCreateUpdateChannels: true }, guestSettings: { allowCreateUpdateChannels: false },
    messagingSettings: { allowUserEditMessages: true }, funSettings: { allowGiphy: true, allowCustomMemes: true }, discoverySettings: { showInTeamsSearchAndSuggestions: false },
  };
  const members = [{ id: 'MjA-owner', userId: 'a0a0a0a0-0000-4000-8000-00000000000a', tenantId: TENANT, roles: ['owner'] }];
  let next = 1;
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = decodeURIComponent(new URL(url).pathname);
    if (path === '/v1.0/teams') return { status: 200, headers: {}, body: { value: [{ id: TEAM, displayName: team.displayName }] } };
    if (path === `/v1.0/teams/${TEAM}`) {
      if (method === 'PATCH') { Object.assign(team, structuredClone(init.body)); return { status: 204, headers: {}, body: null }; }
      return { status: 200, headers: {}, body: structuredClone(team) };
    }
    if (path === `/v1.0/teams/${TEAM}/members`) {
      if (method === 'POST') {
        const member = { id: `MjA-new-${next++}`, userId: /users\('([^']+)'\)/.exec(init.body['user@odata.bind'])[1], tenantId: TENANT, roles: init.body.roles };
        members.push(member);
        return { status: 201, headers: {}, body: member };
      }
      return { status: 200, headers: {}, body: { value: structuredClone(members) } };
    }
    const membership = new RegExp(`^/v1\\.0/teams/${TEAM}/members/(.+)$`).exec(path);
    if (membership) {
      const index = members.findIndex((member) => member.id === membership[1]);
      if (method === 'PATCH') { members[index].roles = init.body.roles; return { status: 200, headers: {}, body: members[index] }; }
      members.splice(index, 1);
      return { status: 204, headers: {}, body: null };
    }
    if (path === `/v1.0/groups/${TEAM}/members`) return { status: 200, headers: {}, body: { value: members.map((member) => ({ id: member.userId })) } };
    if (path === `/v1.0/groups/${TEAM}/owners`) return { status: 200, headers: {}, body: { value: [{ id: members[0].userId }] } };
    return { status: 404, headers: {}, body: null };
  };
}

function exchangeSide() {
  const settings = {
    automaticRepliesSetting: { status: 'disabled' }, timeZone: 'UTC', language: { locale: 'en-US' }, workingHours: { daysOfWeek: ['monday'] },
    dateFormat: 'yyyy-MM-dd', timeFormat: 'HH:mm', delegateMeetingMessageDeliveryOptions: 'sendToDelegateOnly', userPurpose: 'user',
  };
  const cas = { OWAEnabled: true, ActiveSyncEnabled: true, PopEnabled: false, ImapEnabled: false, MAPIEnabled: true, EwsEnabled: true, SmtpClientAuthenticationDisabled: true };
  const retention = {
    LitigationHoldEnabled: false, RetentionHoldEnabled: false, SingleItemRecoveryEnabled: true, RetainDeletedItemsFor: '14.00:00:00',
    InPlaceHolds: [], ComplianceTagHoldApplied: false, DelayHoldApplied: false, DelayReleaseHoldApplied: false, LitigationHoldDuration: 'Unlimited',
  };
  const organization = {
    FocusedInboxOn: true, MailTipsAllTipsEnabled: true, MailTipsExternalRecipientsTipsEnabled: false, MailTipsGroupMetricsEnabled: true,
    MailTipsLargeAudienceThreshold: 25, OAuth2ClientProfileEnabled: true, SmtpActionableMessagesEnabled: true, ConnectorsEnabled: true, ExternalDirectoryOrganizationId: TENANT,
  };
  const container = fakeContainer((cmdlet, parameters) => {
    if (cmdlet === 'Get-OrganizationConfig') return { output: [organization] };
    if (parameters.Identity !== MAILBOX) return { error: { message: `object '${parameters.Identity}' couldn't be found.`, category: 'NotSpecified', errorId: 'ManagementObjectNotFoundException' } };
    if (cmdlet === 'Get-CASMailbox') return { output: [{ ...cas }] };
    if (cmdlet === 'Get-Mailbox') return { output: [{ UserPrincipalName: MAILBOX, ExternalDirectoryObjectId: 'c0c0c0c0-0000-4000-8000-00000000000c', RecipientTypeDetails: 'UserMailbox', ...retention }] };
    const { Identity, ...changes } = parameters;
    Object.assign(cmdlet === 'Set-CASMailbox' ? cas : retention, changes);
    return { output: [] };
  });
  const transport = async (url, init) => {
    if (init?.method === 'PATCH') { Object.assign(settings, init.body); return { status: 200, headers: {}, body: { ...settings } }; }
    return { status: 200, headers: {}, body: { ...settings } };
  };
  const side = (config) => ({ transport, powershell: { spawnFn: container.spawnFn, timeoutMs: 200, tenantConfigPath: config } });
  return { collector: side('/etc/keel/exchange-collector.json'), restorer: side('/etc/keel/exchange-restorer.json') };
}

const SP_FILE = 'sharepoint-live-acceptance.json';
const TEAMS_FILE = 'teams-live-acceptance.json';
const EXCHANGE_FILE = 'exchange-live-acceptance.json';
const docsFor = (urls) => urls.map((url) => ({ url, retrievedAt: '2026-10-02T12:00:00Z' }));
let sharePointEvidence;
let teamsEvidence;
let exchangeEvidence;
let exchangeReference;
before(async () => {
  const sp = sharePointGraph();
  const spResult = await captureSharePointAcceptance({
    collector: sp, restorer: sp, tenantHost: SP_HOST, fixtureSiteUrl: SP_URL, tenantRef, build,
    credentials: { collector: 'app:keel-sp-collector', restorer: 'app:keel-sp-restorer' }, grants: requiredGrants(),
    documentation: docsFor(requiredDocumentation()), now: fixedClock, sleep: noSleep, readBackDelayMs: 0,
  });
  ({ evidence: sharePointEvidence } = writeAcceptanceFiles({ ...spResult, outPath: join(dir, SP_FILE), hmacKey: KEY }));
  const teams = teamsGraph();
  const teamsResult = await captureTeamsAcceptance({
    collector: teams, restorer: teams, directoryTenantId: TENANT, fixtureTeamId: TEAM, fixtureMemberUserId: 'b0b0b0b0-0000-4000-8000-00000000000b', tenantRef, build,
    credentials: { collector: 'app:keel-teams-collector', restorer: 'app:keel-teams-restorer' }, grants: teamsRequiredGrants(),
    sharePointQualification: { gate: SHAREPOINT_LIVE_GATE, evidence: SP_FILE, captureLogSha256: sharePointEvidence.subject.captureLogSha256 },
    documentation: docsFor(teamsRequiredDocumentation()), now: fixedClock, sleep: noSleep, readBackDelayMs: 0,
  });
  ({ evidence: teamsEvidence } = writeTeamsAcceptanceFiles({ ...teamsResult, outPath: join(dir, TEAMS_FILE), hmacKey: KEY }));
  const exo = exchangeSide();
  const exchangeResult = await captureExchangeAcceptance({
    collector: exo.collector, restorer: exo.restorer, directoryTenantId: TENANT, fixtureMailbox: MAILBOX, probeIdentity: 'keel-rt-absent-0001@contoso.test',
    tenantRef, build, moduleVersion: EXO_VERSION, credentials: { collector: 'app:keel-exo-collector', restorer: 'app:keel-exo-restorer' },
    grants: exchangeRequiredGrants(), teamsQualification: { gate: TEAMS_LIVE_GATE, evidence: TEAMS_FILE, captureLogSha256: teamsEvidence.subject.captureLogSha256 },
    documentation: docsFor(exchangeRequiredDocumentation()), now: fixedClock, sleep: noSleep, readBackDelayMs: 0,
  });
  ({ evidence: exchangeEvidence } = writeExchangeAcceptanceFiles({ ...exchangeResult, outPath: join(dir, EXCHANGE_FILE), hmacKey: KEY }));
  assert.deepEqual(verifyEvidenceFile(join(dir, EXCHANGE_FILE), { gate: EXCHANGE_LIVE_GATE, tenantRef, build, now: verifyNow, hmacKey: KEY, requireLive: true }).failures, []);
  exchangeReference = { gate: EXCHANGE_LIVE_GATE, evidence: EXCHANGE_FILE, captureLogSha256: exchangeEvidence.subject.captureLogSha256 };
});

// ---- The OneDrive and Purview fake: one PnP and one Security & Compliance session.
const MY_HOST = 'contoso-my.sharepoint.com';
const SITE = `https://${MY_HOST}/personal/keel-rt-20260908-alice_contoso_test`;
const OTHER_SITE = `https://${MY_HOST}/personal/ceo_contoso_test`;
const PROBE_SITE = `https://${MY_HOST}/personal/keel-rt-absent-0001`;
const LABEL_ID = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const LABEL_NAME = 'KEEL-RT-20261003-Label';
const CONFIDENTIAL_ID = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const POLICY_ID = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const POLICY_NAME = 'KEEL-RT-20261003-Policy';
const GLOBAL_POLICY_ID = 'bbbbbbbb-0000-4000-8000-0000000000b2';

const labelBody = (id, name, extra = {}) => ({
  ImmutableId: id, Guid: id, Name: name, DisplayName: name, ParentId: null, Priority: 3, ContentType: 'File, Email', Disabled: false,
  Tooltip: `${name} tooltip`, Comment: 'fixture comment', EncryptionEnabled: true, EncryptionProtectionType: 'Template', EncryptionOfflineAccessDays: 7,
  ApplyContentMarkingHeaderEnabled: false, ApplyContentMarkingFooterEnabled: false, ApplyWaterMarkingEnabled: false,
  SiteAndGroupProtectionEnabled: false, SiteAndGroupProtectionPrivacy: null, SiteAndGroupProtectionAllowAccessToGuestUsers: false,
  SiteExternalSharingControlType: null, WhenChangedUTC: '2026-09-01T00:00:00Z', ...extra,
});
const policyBody = (id, name, extra = {}) => ({
  ImmutableId: id, Guid: id, Name: name, Enabled: true, Mode: 'Enforce', Priority: 1, Labels: [],
  ExchangeLocation: [MAILBOX], ModernGroupLocation: [], SharePointLocation: [], OneDriveLocation: [SITE],
  Settings: [], WhenChangedUTC: '2026-09-01T00:00:00Z', ...extra,
});

function purviewFake({
  template = 'SPSPERS#10', siteExists = true, probeExists = false, labels = null, policies = null, labelLock = undefined, policyAudience = null,
  alreadyPublished = false, ignoreLabelWrites = false, ignorePolicyWrites = false, failLabelRevert = false, mutateOtherLabel = false, siteOverrides = {},
} = {}) {
  const state = {
    sites: {
      ...(siteExists ? {
        [SITE]: {
          Url: SITE, Template: template, Owner: 'keel-rt-20260908-alice@contoso.test', SharingCapability: 'ExternalUserSharingOnly', SharingDomainRestrictionMode: 'None',
          SharingAllowedDomainList: '', SharingBlockedDomainList: '', DefaultSharingLinkType: 'None', DefaultLinkPermission: 'View',
          OverrideTenantExternalUserExpirationPolicy: false, ExternalUserExpirationInDays: 60, OverrideTenantAnonymousLinkExpirationPolicy: true,
          AnonymousLinkExpirationInDays: 7, StorageQuota: 1048576, StorageQuotaWarningLevel: 943718, LockState: 'Unlock', SensitivityLabel: null,
          ConditionalAccessPolicy: 'AllowFullAccess', ...siteOverrides,
        },
      } : {}),
      ...(probeExists ? { [PROBE_SITE]: { Url: PROBE_SITE, Template: 'SPSPERS#10' } } : {}),
    },
    labels: labels ?? [
      labelBody(LABEL_ID, LABEL_NAME, labelLock === undefined ? {} : { IsPreservationLocked: labelLock }),
      labelBody(CONFIDENTIAL_ID, 'Confidential'),
    ],
    policies: policies ?? [
      policyBody(POLICY_ID, POLICY_NAME, { Labels: alreadyPublished ? [LABEL_NAME] : [], ...(policyAudience ? { ExchangeLocation: policyAudience } : {}) }),
      policyBody(GLOBAL_POLICY_ID, 'Global label policy', { Labels: ['Confidential'], ExchangeLocation: ['All'], OneDriveLocation: [] }),
    ],
  };
  let labelSets = 0;
  let labelReads = 0;
  const container = fakeContainer((cmdlet, parameters) => {
    if (cmdlet === 'Get-PnPTenantSite') {
      const site = state.sites[parameters.Identity];
      return site ? { output: [structuredClone(site)] } : { error: { message: `Cannot get site ${parameters.Identity}`, category: 'InvalidOperation', errorId: 'EXCEPTION,PnP.PowerShell.Commands.GetTenantSite' } };
    }
    if (cmdlet === 'Get-Label') {
      labelReads += 1;
      if (mutateOtherLabel && labelReads === 3) state.labels.find((item) => item.ImmutableId === CONFIDENTIAL_ID).EncryptionEnabled = false;
      // Adversarial: usage counts in the answer; never stored.
      return { output: state.labels.map((item) => ({ ...structuredClone(item), LabelUsageCount: 4242 })) };
    }
    if (cmdlet === 'Get-LabelPolicy') return { output: structuredClone(state.policies) };
    if (cmdlet === 'Set-Label') {
      labelSets += 1;
      if (failLabelRevert && labelSets === 2) return { error: { message: 'The server is busy.', category: 'ResourceUnavailable', errorId: 'ServerBusy' } };
      const { Identity, ...values } = parameters;
      if (!ignoreLabelWrites) Object.assign(state.labels.find((item) => item.ImmutableId === Identity), values, { WhenChangedUTC: '2026-10-03T08:00:00Z' });
      return { output: [] };
    }
    if (cmdlet === 'Set-LabelPolicy') {
      const target = state.policies.find((item) => item.ImmutableId === parameters.Identity);
      if (!ignorePolicyWrites) target.Labels = [...target.Labels, ...parameters.AddLabels];
      return { output: [] };
    }
    return { error: { message: `${cmdlet} has no fake`, errorId: 'NoFake' } };
  });
  const side = (config) => ({ powershell: { spawnFn: container.spawnFn, timeoutMs: 200, tenantConfigPath: config } });
  return {
    state, calls: container.calls, jobs: container.jobs, contentCalls: container.contentCalls,
    collector: side('/etc/keel/purview-collector.json'), restorer: side('/etc/keel/purview-restorer.json'),
    writes: () => container.calls.filter((call) => call.cmdlet.startsWith('Set-')).map((call) => call.cmdlet),
  };
}

const odpDocumentation = () => docsFor(onedrivePurviewRequiredDocumentation());

async function capture(fake = purviewFake(), overrides = {}) {
  return captureOneDrivePurviewAcceptance({
    collector: fake.collector, restorer: fake.restorer, directoryTenantId: TENANT, tenantHost: SP_HOST, fixtureSite: SITE, fixtureLabel: LABEL_NAME,
    fixturePolicy: POLICY_NAME, probeSite: PROBE_SITE, tenantRef, build, modules: MODULES,
    credentials: { collector: 'app:keel-purview-collector', restorer: 'app:keel-purview-restorer' }, grants: onedrivePurviewRequiredGrants(),
    exchangeQualification: exchangeReference, documentation: odpDocumentation(), now: fixedClock, sleep: noSleep, readBackDelayMs: 0, ...overrides,
  });
}

let counter = 0;
async function capturedFiles(fake, overrides) {
  const result = await capture(fake, overrides);
  const outPath = join(dir, `onedrive-purview-record-${counter += 1}.json`);
  const { evidence, logPath } = writeOneDrivePurviewAcceptanceFiles({ ...result, outPath, hmacKey: KEY });
  return { ...result, evidence, outPath, logPath };
}

const options = (extra = {}) => ({ gate: ONEDRIVE_PURVIEW_LIVE_GATE, tenantRef, build, now: verifyNow, hmacKey: KEY, requireLive: true, ...extra });
const verifyIn = (evidence, extra) => verifyEvidence(evidence, { ...options(extra), evidenceDir: dir });
/** Applies a change and re-signs it with the trusted test key, as a dishonest capture would. */
const resign = (evidence, change) => signEvidence(change(structuredClone(evidence)), KEY);

test('a valid independently captured record verifies, and the capture touched only the KEEL-RT fixtures', async () => {
  const fake = purviewFake();
  const { evidence, outPath, record } = await capturedFiles(fake);
  assert.deepEqual(verifyEvidenceFile(outPath, options()), { ok: true, failures: [] });
  assert.equal(evidence.proof.runner.identity, 'keel-release-runner');

  const { subject } = record;
  assert.deepEqual(subject.reads.map((read) => [read.operationId, read.ok]).sort(), ONEDRIVE_PURVIEW_READS.map((id) => [id, true]).sort());
  assert.equal(subject.reads.find((read) => read.operationId === 'onedrive.site-settings').version, PNP_VERSION, 'the OneDrive read is bound to the PnP version');
  assert.equal(subject.reads.find((read) => read.operationId === 'purview.label-definitions').version, EXO_VERSION);
  // Inherited versus explicit, recorded live per field.
  assert.equal(subject.inheritance.DefaultSharingLinkType, 'inherited');
  assert.equal(subject.inheritance.ExternalUserExpirationInDays, 'inherited');
  assert.equal(subject.inheritance.AnonymousLinkExpirationInDays, 'explicit');
  assert.equal(subject.inheritance.StorageQuota, 'undetermined');
  // Only the fixture OneDrive (and the absent probe) were addressed, and only by the collector, in the PnP session.
  const siteCalls = fake.calls.filter((call) => call.cmdlet === 'Get-PnPTenantSite');
  assert.deepEqual(siteCalls.map((call) => call.parameters.Identity).sort(), [PROBE_SITE, SITE].sort());
  assert.ok(siteCalls.every((call) => call.session === 'PnP.PowerShell:pnp' && call.config === '/etc/keel/purview-collector.json'));
  // Zero content calls: no file, list item, item label or label usage cmdlet was ever sent.
  assert.equal(fake.contentCalls(), 0);
  assert.deepEqual([...new Set(fake.calls.map((call) => call.cmdlet))].sort(), ['Get-Label', 'Get-LabelPolicy', 'Get-PnPTenantSite', 'Set-Label', 'Set-LabelPolicy']);
  // Each value is one argument in a data job, never script source; writes use the restorer's config only.
  for (const job of fake.jobs) assert.deepEqual(Object.keys(job).sort(), ['adapter', 'cmdlet', 'jobId', 'mode', 'module', 'parameters', 'tenantConfigPath']);
  const sets = fake.calls.filter((call) => call.cmdlet.startsWith('Set-'));
  assert.ok(sets.every((call) => call.config === '/etc/keel/purview-restorer.json' && call.session === 'ExchangeOnlineManagement:ipps'));
  assert.deepEqual(sets.map((call) => [call.cmdlet, call.parameters.Identity, Object.keys(call.parameters).sort()]), [
    ['Set-Label', LABEL_ID, ['Comment', 'Identity']], ['Set-Label', LABEL_ID, ['Comment', 'Identity']], ['Set-LabelPolicy', POLICY_ID, ['AddLabels', 'Identity']],
  ]);
  // Post-state: the label reads as it started (protection untouched); the policy only gained the label; nothing else moved.
  const fixture = fake.state.labels.find((item) => item.ImmutableId === LABEL_ID);
  assert.deepEqual([fixture.Comment, fixture.EncryptionEnabled, fixture.Disabled], ['fixture comment', true, false]);
  assert.deepEqual(fake.state.policies.find((item) => item.ImmutableId === POLICY_ID).Labels, [LABEL_NAME]);
  assert.deepEqual(fake.state.policies.find((item) => item.ImmutableId === GLOBAL_POLICY_ID).Labels, ['Confidential']);
  assert.equal(subject.writes.label.preFingerprint, subject.writes.label.finalFingerprint);
  assert.equal(subject.tenantDefinitions.otherFingerprint, subject.tenantDefinitions.finalOtherFingerprint);
  assert.deepEqual([subject.tenantDefinitions.labels, subject.tenantDefinitions.policies], [2, 2]);
  // Refusals were observed before anything was sent; the platform error came back structured.
  for (const name of ['protectionWeakening', 'unpublish', 'itemLabels', 'oneDriveContent', 'oneDrivePath', 'preservationLock']) {
    assert.deepEqual([subject.refusals[name].refused, subject.refusals[name].sent], [true, false], name);
  }
  assert.match(subject.refusals.preservationLock.reason, /preservation-locked/);
  assert.deepEqual([subject.platformError.status, subject.platformError.error.code, subject.platformError.error.errorId], ['failed', 'CMDLET_ERROR', 'EXCEPTION,PnP.PowerShell.Commands.GetTenantSite']);
  // No usage count, no content and no secret anywhere in the record or log.
  const text = readFileSync(outPath, 'utf8') + readFileSync(join(dir, evidence.proof.artifact.path), 'utf8');
  assert.doesNotMatch(text, /LabelUsageCount|4242|Q3 board pack|bearer\s|authorization|access_?token|BEGIN .*PRIVATE KEY/i);
});

test('Get-LabelPolicy location entries are objects: their Name decides fixture-only, and an All object still refuses', async () => {
  // The live cmdlet returns each location as an object, not a string (seen on the tenant at gate 123).
  const location = (name) => ({ DisplayName: name, Name: name, ImmutableIdentity: '00000000-0000-0000-0000-000000000001', Type: { Value: 'User' } });
  assert.deepEqual(onedrivePurviewPolicyAudienceProblems({ ExchangeLocation: [location(MAILBOX)], OneDriveLocation: [location(SITE)] }), []);
  assert.deepEqual(onedrivePurviewPolicyAudienceProblems({ ExchangeLocation: [location('All')] }), ['ExchangeLocation publishes to All, not only to KEEL-RT fixtures']);
  assert.match(onedrivePurviewPolicyAudienceProblems({ ExchangeLocation: [{ DisplayName: 'KEEL-RT-20260908 Alice Martin' }] })[0], /ExchangeLocation has an entry without a Name/,
    'an object without a Name fails, even when another field names a fixture');

  const fake = purviewFake({ policies: [
    policyBody(POLICY_ID, POLICY_NAME, { ExchangeLocation: [location(MAILBOX)], OneDriveLocation: [location(SITE)] }),
    policyBody(GLOBAL_POLICY_ID, 'Global label policy', { Labels: ['Confidential'], ExchangeLocation: [location('All')], OneDriveLocation: [] }),
  ] });
  const { outPath, record } = await capturedFiles(fake);
  assert.equal(record.subject.writes.label.error ?? null, null);
  assert.deepEqual(verifyEvidenceFile(outPath, options()), { ok: true, failures: [] });

  const everyone = purviewFake({ policyAudience: [location('All')] });
  const refused = await capturedFiles(everyone);
  assert.deepEqual(everyone.writes(), []);
  assert.match(refused.record.subject.writes.label.error, /not fixture-only \(ExchangeLocation publishes to All/);
});

test('an altered signature or capture-log digest fails', async () => {
  const { evidence, logPath } = await capturedFiles();
  const forged = structuredClone(evidence);
  forged.proof.runner.signature = forged.proof.runner.signature.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  assert.match(verifyIn(forged).failures.join('\n'), /signature mismatch/);

  const edited = structuredClone(evidence);
  edited.subject.writes.policy.after.Labels = [];
  assert.match(verifyIn(edited).failures.join('\n'), /signature mismatch/, 'any edit after signing breaks the signature');

  writeFileSync(logPath, readFileSync(logPath, 'utf8').replace('"Set-Label"', '"Get-Label"'));
  assert.match(verifyIn(evidence).failures.join('\n'), /artifact digest mismatch/);

  const swapped = structuredClone(evidence);
  writeFileSync(join(dir, 'odp-swapped.capture.json'), '{}\n');
  swapped.proof.artifact = { path: 'odp-swapped.capture.json', sha256: 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356' };
  const swappedFailures = verifyIn(swapped).failures.join('\n');
  assert.doesNotMatch(swappedFailures, /artifact digest mismatch/, 'the swapped log matches its own digest');
  assert.match(swappedFailures, /capture log digest is not bound/);
});

test('wrong tenant, build or operation fails, even when re-signed by the trusted runner', async () => {
  const { evidence } = await capturedFiles();
  assert.match(verifyIn(evidence, { tenantRef: tenantRefFor('another-tenant') }).failures.join('\n'), /cross-tenant/);
  assert.match(verifyIn(evidence, { build: 'another-build' }).failures.join('\n'), /OneDrive\/Purview build mismatch/);
  assert.match(verifyIn(evidence, { tenantRef: null }).failures.join('\n'), /expected tenant\/build/);
  for (const [change, pattern] of [
    [(e) => { e.operation = 'exchange.configuration-qualification'; return e; }, /OneDrive\/Purview operation mismatch/],
    [(e) => { e.operation = 'purview.label.update'; return e; }, /OneDrive\/Purview operation mismatch/],
    [(e) => { e.credentialMode = 'restorer'; return e; }, /credential mode/],
    [(e) => { e.gate = EXCHANGE_LIVE_GATE; return e; }, /gate mismatch/],
    [(e) => { e.subject.writes.label.operationId = 'exchange.client-access.update'; return e; }, /no live capture of purview.label.update/],
    [(e) => { e.subject.writes.policy.operationId = 'purview.label.update'; return e; }, /no live capture of purview.label-policy.update/],
    [(e) => { e.subject.reads[0].operationId = 'sharepoint.site-sharing'; return e; }, /no live capture of onedrive.site-settings/],
    [(e) => { e.subject.reads[0].version = EXO_VERSION; return e; }, /onedrive.site-settings: captured at 3.5.0, not 2.12.0/],
    [(e) => { e.subject.writes.label.version = '3.4.0'; return e; }, /purview.label.update: captured at 3.4.0, not 3.5.0/],
    [(e) => { e.subject.reads[0].form = 'Get-PnPTenantSite -IncludeOneDriveSites'; return e; }, /not captured in the -Identity form/],
    [(e) => { e.subject.credentials.restorer = e.subject.credentials.collector; return e; }, /separate credentials/],
    [(e) => { e.subject.directoryTenantId = OTHER_TENANT; return e; }, /another directory tenant than its Exchange prerequisite/],
    [(e) => { e.subject.fixtureSite.url = OTHER_SITE; return e; }, /not a keel-rt-\* personal site/],
    [(e) => { e.subject.fixtureSite.url = 'https://fabrikam-my.sharepoint.com/personal/keel-rt-20260908-alice_contoso_test'; return e; }, /not a keel-rt-\* personal site on contoso-my.sharepoint.com/],
    [(e) => { e.subject.fixtureSite.template = 'GROUP#0'; return e; }, /did not answer as a OneDrive personal site/],
    [(e) => { e.subject.fixtureLabel.name = 'Confidential'; return e; }, /fixture label is not a keel-rt-\* label/],
    [(e) => { e.subject.fixturePolicy.name = 'Global label policy'; return e; }, /fixture policy is not a keel-rt-\* policy/],
    [(e) => { e.subject.fixturePolicy.locations.ExchangeLocation = ['All']; return e; }, /fixture policy is not fixture-only: ExchangeLocation publishes to All/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }
});

test('stale evidence fails: an old record, old captures inside a fresh record, or a stale Exchange prerequisite', async () => {
  const { evidence } = await capturedFiles();
  const lateFailures = verifyIn(evidence, { now: new Date('2026-11-10T00:00:00Z') }).failures.join('\n');
  assert.match(lateFailures, /observation is stale/);
  assert.match(lateFailures, /Exchange record does not verify: .*stale/);
  for (const [change, pattern] of [
    [(e) => { e.subject.reads[1].capturedAt = '2026-09-30T08:00:00Z'; return e; }, /stale capture/],
    [(e) => { e.subject.writes.label.capturedAt = '2026-09-01T08:00:00Z'; return e; }, /purview.label.update: .*stale capture/],
    [(e) => { e.subject.writes.policy.capturedAt = '2026-10-04T08:00:00Z'; return e; }, /captured after the record was observed/],
    [(e) => { e.subject.documentation[0].retrievedAt = null; return e; }, /documentation not retrieved/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }
});

test('a missing prerequisite fails, and Exchange, Teams or SharePoint proof never stands in for OneDrive or Purview proof', async () => {
  const { evidence } = await capturedFiles();
  for (const [change, pattern] of [
    [(e) => { e.subject.prerequisites = ['task-106']; return e; }, /missing prerequisite: task-122/],
    [(e) => { delete e.subject.exchangeQualification; return e; }, /no task-122 Exchange qualification record named/],
    [(e) => { e.subject.exchangeQualification.evidence = 'absent.json'; return e; }, /Exchange record absent.json is absent/],
    [(e) => { e.subject.exchangeQualification.evidence = '../exchange.json'; return e; }, /named as a file beside this one/],
    [(e) => { e.subject.exchangeQualification.gate = TEAMS_LIVE_GATE; return e; }, /not exchange-live-acceptance/],
    [(e) => { e.subject.exchangeQualification.captureLogSha256 = '0'.repeat(64); return e; }, /not the one this capture named/],
    [(e) => { e.subject.captureLogSha256 = exchangeEvidence.subject.captureLogSha256; return e; }, /Exchange, Teams or SharePoint capture log cannot stand in/],
    [(e) => { e.subject.captureLogSha256 = teamsEvidence.subject.captureLogSha256; return e; }, /Exchange, Teams or SharePoint capture log cannot stand in/],
    [(e) => { e.subject.captureLogSha256 = sharePointEvidence.subject.captureLogSha256; return e; }, /Exchange, Teams or SharePoint capture log cannot stand in/],
    [(e) => { e.subject.reads = e.subject.reads.filter((r) => r.operationId !== 'purview.label-publication'); return e; }, /no live capture of purview.label-publication/],
    [(e) => { e.subject.reads[0].ok = false; return e; }, /the read failed/],
    [(e) => { delete e.subject.execution.modules['PnP.PowerShell']; return e; }, /no PnP.PowerShell module version/],
    [(e) => { e.subject.execution.transport = 'pwsh-script'; return e; }, /bounded powershell-cmdlet-job transport/],
    // Family-specific privilege: each family declared on its own, never assumed or borrowed.
    [(e) => { delete e.subject.grants.collector.onedrive; return e; }, /collector's onedrive grants were not declared/],
    [(e) => { e.subject.grants.collector.onedrive = e.subject.grants.collector.purview; return e; }, /collector lacks Sites.FullControl.All for onedrive/],
    [(e) => { e.subject.grants.restorer.purview.roles = ['Exchange Administrator']; return e; }, /restorer lacks role Compliance Administrator for purview/],
    [(e) => { e.subject.grants.restorer = { permissions: ['Exchange.ManageAsApp'], roles: ['Compliance Administrator'] }; return e; }, /restorer's purview grants were not declared/],
    [(e) => { e.subject.supportedFields.label = e.subject.supportedFields.label.filter((f) => f !== 'EncryptionEnabled'); return e; }, /not observed live: label.EncryptionEnabled/],
    [(e) => { e.subject.supportedFields.onedrive = e.subject.supportedFields.onedrive.filter((f) => f !== 'LockState'); return e; }, /not observed live: onedrive.LockState/],
    [(e) => { delete e.subject.inheritance.DefaultLinkPermission; return e; }, /inheritance not recorded for OneDrive field DefaultLinkPermission/],
    [(e) => { e.subject.inheritance.ExternalUserExpirationInDays = 'undetermined'; return e; }, /ExternalUserExpirationInDays was not determined live/],
    [(e) => { delete e.subject.writes.policy; return e; }, /no live capture of purview.label-policy.update/],
    [(e) => { e.subject.refusals.protectionWeakening.refused = false; return e; }, /protectionWeakening not shown refused/],
    [(e) => { e.subject.refusals.unpublish.sent = true; return e; }, /unpublish not shown refused/],
    [(e) => { delete e.subject.refusals.itemLabels; return e; }, /itemLabels not shown refused/],
    [(e) => { e.subject.refusals.oneDrivePath.refused = false; return e; }, /path inside the OneDrive was not shown refused/],
    [(e) => { e.subject.refusals.preservationLock = { refused: true, sent: false, reason: 'no reason' }; return e; }, /preservation lock not shown refused/],
    [(e) => { e.subject.platformError.status = 'ok'; return e; }, /recorded as a success/],
    [(e) => { e.subject.platformError.error = { code: 'ERROR', errorId: null, message: '' }; return e; }, /cmdlet error was not preserved/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }

  // An Exchange record that does not verify (here: tampered after signing) blocks this record.
  const { evidence: record, outPath } = await capturedFiles();
  const isolated = mkdtempSync(join(dir, 'broken-exchange-'));
  for (const file of [SP_FILE, TEAMS_FILE, sharePointEvidence.proof.artifact.path, teamsEvidence.proof.artifact.path, exchangeEvidence.proof.artifact.path, record.proof.artifact.path]) {
    copyFileSync(join(dir, file), join(isolated, file));
  }
  const broken = structuredClone(exchangeEvidence);
  broken.subject.throttle.retryAfterResponses = 7;
  writeFileSync(join(isolated, EXCHANGE_FILE), JSON.stringify(broken));
  copyFileSync(outPath, join(isolated, 'onedrive-purview.json'));
  assert.match(verifyEvidenceFile(join(isolated, 'onedrive-purview.json'), options()).failures.join('\n'), /Exchange record does not verify: .*signature mismatch/);
  // The Exchange prerequisite needs Teams, which needs SharePoint: without SharePoint, this fails too.
  const noSharePoint = mkdtempSync(join(dir, 'no-sp-'));
  for (const file of [TEAMS_FILE, EXCHANGE_FILE, teamsEvidence.proof.artifact.path, exchangeEvidence.proof.artifact.path, record.proof.artifact.path]) {
    copyFileSync(join(dir, file), join(noSharePoint, file));
  }
  copyFileSync(outPath, join(noSharePoint, 'onedrive-purview.json'));
  const chainFailures = verifyEvidenceFile(join(noSharePoint, 'onedrive-purview.json'), options()).failures.join('\n');
  assert.match(chainFailures, /Exchange record does not verify: .*Teams record does not verify: .*SharePoint record .* is absent/);
  assert.match(chainFailures, /SharePoint prerequisite names no tenant host/);
  // An Exchange record for another build does not qualify this one.
  assert.match(verifyIn(record, { build: 'another-build' }).failures.join('\n'), /Exchange record does not verify: .*build mismatch/);

  // The Exchange, Teams and SharePoint records themselves are never OneDrive or Purview evidence.
  for (const upstream of [exchangeEvidence, teamsEvidence, sharePointEvidence]) {
    assert.match(verifyIn(upstream).failures.join('\n'), /gate mismatch/);
    assert.equal(ledgerEvidenceFromOneDrivePurviewAcceptance(upstream, { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir }).ok, false);
  }
});

test('missing external evidence fails: the checked-in pending record, an absent file, the release CLI', async () => {
  const pending = join(repo, 'docs/release/qualifications/onedrive-purview-live-acceptance.json');
  const record = JSON.parse(readFileSync(pending, 'utf8'));
  assert.equal(record.status, 'pending');
  assert.equal(record.synthetic, true);
  assert.match(verifyEvidenceFile(pending, options()).failures.join('\n'), /pending/);
  assert.equal(verifyEvidenceFile(pending, options({ requireLive: false })).ok, false);
  assert.match(verifyIn({ ...record, status: 'pending' }, { requireLive: false }).failures.join('\n'), /pending/);
  assert.equal(verifyEvidenceFile(join(dir, 'absent.json'), options()).ok, false);
  // A record without its capture log, or without a runner signature, is not evidence.
  const { evidence, logPath } = await capturedFiles();
  rmSync(logPath);
  assert.match(verifyIn(evidence).failures.join('\n'), /OneDrive\/Purview capture artifact required/);
  const { proof, ...unsigned } = evidence;
  assert.match(verifyIn({ ...unsigned, proof: { artifact: proof.artifact } }, { requireLive: false }).failures.join('\n'), /OneDrive\/Purview runner proof required/);
  // The exact release command exits nonzero on the checked-in record.
  assert.throws(() => execFileSync(process.execPath, [
    'tools/release/qualification.mjs', 'verify', '--require-live', '--gate', ONEDRIVE_PURVIEW_LIVE_GATE,
    '--evidence', 'docs/release/qualifications/onedrive-purview-live-acceptance.json',
  ], { cwd: repo, stdio: 'pipe' }), (error) => error.status === 1 && /pending/.test(String(error.stdout)));
});

test('fixture evidence is never elevated to live-qualified, and only a verified record reaches the ledgers', async () => {
  const { evidence } = await capturedFiles();
  const fixtureRunner = signEvidence(structuredClone(evidence), KEY, 'keel-fixture-runner');
  assert.match(verifyIn(fixtureRunner).failures.join('\n'), /synthetic runner/);
  assert.match(verifyIn(fixtureRunner, { requireLive: false }).failures.join('\n'), /OneDrive\/Purview fixture evidence cannot claim live qualification/);
  const synthetic = resign(evidence, (e) => { e.synthetic = true; return e; });
  assert.match(verifyIn(synthetic, { requireLive: false }).failures.join('\n'), /OneDrive\/Purview fixture evidence cannot claim live/);
  const fixtureLevel = resign(evidence, (e) => { e.evidenceLevel = 'fixture-tested'; return e; });
  assert.match(verifyIn(fixtureLevel).failures.join('\n'), /needs evidenceLevel 'live-qualified'/);
  const syntheticRead = resign(evidence, (e) => { e.subject.reads[1].synthetic = true; return e; });
  assert.match(verifyIn(syntheticRead).failures.join('\n'), /synthetic or unlabelled capture/);
  const syntheticWrite = resign(evidence, (e) => { e.subject.writes.policy.synthetic = true; return e; });
  assert.match(verifyIn(syntheticWrite).failures.join('\n'), /purview.label-policy.update: synthetic/);
  const sameValue = resign(evidence, (e) => { e.subject.writes.label.writeMode = 'same-value'; return e; });
  assert.match(verifyIn(sameValue).failures.join('\n'), /same-value write/);

  // The import seam: nothing from a fixture record, everything from a verified one.
  const seam = { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir };
  for (const bad of [fixtureRunner, synthetic, fixtureLevel]) {
    const imported = ledgerEvidenceFromOneDrivePurviewAcceptance(bad, seam);
    assert.equal(imported.ok, false);
    assert.deepEqual([imported.reads, imported.writes, imported.grants], [[], [], null]);
  }

  const upstream = [ledgerEvidenceFromAcceptance(sharePointEvidence, seam), ledgerEvidenceFromTeamsAcceptance(teamsEvidence, seam), ledgerEvidenceFromExchangeAcceptance(exchangeEvidence, seam)];
  const mine = ledgerEvidenceFromOneDrivePurviewAcceptance(evidence, seam);
  for (const imported of [...upstream, mine]) assert.equal(imported.ok, true, imported.failures.join('; '));
  assert.deepEqual(mine.runtime.modules, MODULES);
  const union = (list) => ({ permissions: [...new Set(list.flatMap((g) => g.permissions))], roles: [...new Set(list.flatMap((g) => g.roles))] });
  const grants = union([...upstream, mine].map((imported) => imported.grants));
  const restorerGrants = union([upstream[2].restorerGrants, mine.restorerGrants]);
  const runtime = { modules: { ...upstream[2].runtime.modules, ...mine.runtime.modules } };
  const upstreamReads = upstream.flatMap((imported) => imported.reads);
  const upstreamWrites = upstream.flatMap((imported) => imported.writes);
  const ledgerOf = (reads) => buildWorkloadLedger({ evidence: reads, grants, runtime, tenantRef, now: verifyNow });
  const writeState = (id, ledger, writes, held = restorerGrants, at = runtime) => workloadWriteQualification(id, { readLedger: ledger, evidence: writes, tenantRef, now: verifyNow, runtime: at, grants: held });

  // Exchange, Teams and SharePoint evidence alone qualify no OneDrive or Purview operation.
  const upstreamLedger = ledgerOf(upstreamReads);
  for (const id of ONEDRIVE_PURVIEW_READS) assert.notEqual(upstreamLedger.rows.find((row) => row.id === id).state, 'live-qualified', id);
  for (const id of ONEDRIVE_PURVIEW_WRITES) assert.equal(writeState(id, upstreamLedger, upstreamWrites).enabled, false, id);
  assert.deepEqual([oneDriveActivation(upstreamLedger).enabled, purviewActivation(upstreamLedger).enabled], [false, false]);
  // This evidence without Exchange's (and Teams', SharePoint's) activates nothing and enables no write.
  const mineOnly = ledgerOf(mine.reads);
  for (const id of ONEDRIVE_PURVIEW_READS) assert.equal(mineOnly.rows.find((row) => row.id === id).state, 'live-qualified', id);
  assert.deepEqual([oneDriveActivation(mineOnly).enabled, purviewActivation(mineOnly).enabled], [false, false]);
  for (const id of ONEDRIVE_PURVIEW_WRITES) assert.equal(writeState(id, mineOnly, mine.writes).enabled, false, id);
  // All four together: both families activate and both Purview writes are enabled, each on its own capture.
  const ledger = ledgerOf([...upstreamReads, ...mine.reads]);
  const writes = [...upstreamWrites, ...mine.writes];
  assert.deepEqual([oneDriveActivation(ledger).enabled, purviewActivation(ledger).enabled], [true, true], JSON.stringify([oneDriveActivation(ledger).reasons, purviewActivation(ledger).reasons]));
  for (const id of ONEDRIVE_PURVIEW_WRITES) {
    const state = writeState(id, ledger, writes);
    assert.equal(state.enabled, true, `${id}: ${state.reasons.join('; ')}`);
    assert.match(state.proof.live.proofRef, /^onedrive-purview-live-acceptance@/);
  }
  // OneDrive proof never counts for Purview, and the reverse.
  const oneDriveOnly = ledgerOf([...upstreamReads, ...mine.reads.filter((read) => read.operationId === 'onedrive.site-settings')]);
  assert.deepEqual([oneDriveActivation(oneDriveOnly).enabled, purviewActivation(oneDriveOnly).enabled], [true, false]);
  const purviewOnly = ledgerOf([...upstreamReads, ...mine.reads.filter((read) => read.operationId !== 'onedrive.site-settings')]);
  assert.deepEqual([oneDriveActivation(purviewOnly).enabled, purviewActivation(purviewOnly).enabled], [false, true]);
  // Label-policy proof is not label proof; restorer grants without Purview's leave the writes disabled; another module version invalidates them.
  assert.equal(writeState('purview.label.update', ledger, writes.filter((item) => item.operationId !== 'purview.label.update')).enabled, false);
  assert.equal(writeState('purview.label-policy.update', ledger, writes, upstream[2].restorerGrants).enabled, false);
  assert.equal(writeState('purview.label.update', ledger, writes, restorerGrants, { modules: { ...runtime.modules, ExchangeOnlineManagement: '3.6.0' } }).enabled, false);
  // The same record never qualifies another tenant.
  assert.equal(ledgerEvidenceFromOneDrivePurviewAcceptance(evidence, { ...seam, tenantRef: tenantRefFor('another-tenant') }).ok, false);
});

test('a content call, another site, label or policy, a collector write, a protection change, an unpublish or a locked write fails', async () => {
  const { evidence } = await capturedFiles();
  const cmd = (credential, module, cmdlet, parameters, outcome = 'ok') => ({ credential, transport: 'powershell-cmdlet-job', module, cmdlet, parameters, outcome });
  const pnp = 'PnP.PowerShell';
  const exo = 'ExchangeOnlineManagement';
  for (const [request, pattern] of [
    [cmd('collector', pnp, 'Get-PnPListItem', { List: 'Documents' }), /content call or undeclared cmdlet/],
    [cmd('collector', pnp, 'Get-PnPTenantSite', { IncludeOneDriveSites: true }), /content call or undeclared cmdlet/],
    [cmd('collector', exo, 'Export-ContentExplorerData', {}), /content call or undeclared cmdlet/],
    [cmd('collector', exo, 'Get-Label', { Identity: LABEL_ID }), /content call or undeclared cmdlet/],
    [cmd('collector', 'Microsoft.Graph', 'Get-MgDriveItem', {}), /content call or undeclared cmdlet/],
    [cmd('collector', pnp, 'Get-PnPTenantSite', { Identity: OTHER_SITE }), /OneDrive other than the KEEL-RT fixture/],
    [cmd('restorer', pnp, 'Get-PnPTenantSite', { Identity: SITE }), /only the collector reads the OneDrive site/],
    [cmd('collector', pnp, 'Get-PnPTenantSite', { Identity: PROBE_SITE }), /probe site answered/],
    [cmd('collector', exo, 'Set-Label', { Identity: LABEL_ID, Comment: 'x' }), /not an allowed write/],
    [cmd('restorer', exo, 'Set-Label', { Identity: CONFIDENTIAL_ID, Comment: 'x' }), /label other than the KEEL-RT fixture label/],
    [cmd('restorer', exo, 'Set-Label', { Identity: LABEL_ID, Tooltip: 'x' }), /changes more than the label's Comment/],
    [cmd('restorer', exo, 'Set-Label', { Identity: LABEL_ID, Comment: 'x' }), /exactly 2 purview.label.update/],
    [cmd('restorer', exo, 'Set-Label', { Identity: LABEL_ID, EncryptionEnabled: false }), /content call or undeclared cmdlet/],
    [cmd('restorer', exo, 'Set-LabelPolicy', { Identity: POLICY_ID, RemoveLabels: [LABEL_NAME] }), /content call or undeclared cmdlet/],
    [cmd('restorer', exo, 'Set-LabelPolicy', { Identity: GLOBAL_POLICY_ID, AddLabels: [LABEL_NAME] }), /policy other than the KEEL-RT fixture policy/],
    [cmd('restorer', exo, 'Set-LabelPolicy', { Identity: POLICY_ID, AddLabels: ['Confidential'] }), /other than exactly the KEEL-RT fixture label/],
    [cmd('restorer', exo, 'Remove-Label', { Identity: LABEL_ID }), /content call or undeclared cmdlet/],
    [{ credential: 'restorer', transport: 'script', module: exo, cmdlet: 'Get-Label', parameters: {} }, /not the bounded cmdlet transport/],
    [{ credential: 'restorer', transport: 'powershell-cmdlet-job', module: exo, cmdlet: 'Get-Label', parameters: '-Identity x' }, /parameters not recorded as data/],
  ]) {
    assert.match(verifyIn(resign(evidence, (e) => { e.subject.requests.push(request); return e; })).failures.join('\n'), pattern, JSON.stringify(request));
  }
  for (const [change, pattern] of [
    [(e) => { e.subject.fixtureLabel.lock = 'locked'; return e; }, /write was sent to an object that reports a preservation lock/],
    [(e) => { e.subject.fixturePolicy.lock = 'locked'; return e; }, /write was sent to an object that reports a preservation lock/],
    [(e) => { e.subject.writes.label.finalFingerprint = '0'.repeat(64); return e; }, /label's definition \(and so its protection\) does not read as it started/],
    [(e) => { e.subject.writes.label.restoredToOriginal = false; return e; }, /label comment was not put back/],
    [(e) => { e.subject.writes.policy.after.Labels = [LABEL_NAME]; e.subject.writes.policy.before.Labels = ['Confidential']; return e; }, /removed from the policy; KEEL never unpublishes/],
    [(e) => { e.subject.writes.policy.after.Labels = [LABEL_NAME, 'Confidential']; return e; }, /did not gain exactly the fixture label/],
    [(e) => { e.subject.writes.policy.writeMode = 'reversible-change'; return e; }, /add-only write/],
    [(e) => { e.subject.writes.policy.finalFingerprint = '0'.repeat(64); return e; }, /policy setting other than its labels changed/],
    [(e) => { e.subject.writes.onedrive = { operationId: 'onedrive.site-settings.update' }; return e; }, /no OneDrive write is declared/],
    [(e) => { e.subject.tenantDefinitions.finalOtherFingerprint = '0'.repeat(64); return e; }, /non-fixture label or policy definition changed/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }
  const leaked = resign(evidence, (e) => { e.subject.credentials.accessToken = 'x'; return e; });
  assert.match(verifyIn(leaked).failures.join('\n'), /credential material/);
  const certificate = resign(evidence, (e) => { e.subject.credentials.certPfx = 'MII...'; return e; });
  assert.match(verifyIn(certificate).failures.join('\n'), /credential material/);
});

test('the capture tool is offline by default, refuses non-fixtures and unsafe states, never overrides a lock, and reports a failed clean-up', async () => {
  let sent = 0;
  const countingSpawn = () => { sent += 1; throw new Error('no container here'); };
  const io = { powershellFor: () => ({ spawnFn: countingSpawn }) };
  const args = ['--fixture-site', SITE, '--fixture-label', LABEL_NAME, '--fixture-policy', POLICY_NAME];
  const lines = [];
  assert.equal(await onedrivePurviewMain(['plan', ...args], { ...io, out: (line) => lines.push(line) }), 0);
  assert.match(lines[0], /Set-Label -EncryptionEnabled \(weakens protection; refused before sending\)/);
  assert.match(lines[0], /Set-LabelPolicy -RemoveLabels \(unpublishes a label; refused before sending\)/);
  assert.doesNotMatch(lines[0], /New-Label|Remove-Label|Get-PnPListItem"/);
  assert.equal(await onedrivePurviewMain(['capture', ...args, '--tenant-ref', tenantRef], { ...io, out: (line) => lines.push(line) }), 2);
  assert.match(lines.at(-1), /--confirm-live-tenant-write/);
  await assert.rejects(onedrivePurviewMain(['plan', '--fixture-site', OTHER_SITE, '--fixture-label', LABEL_NAME, '--fixture-policy', POLICY_NAME], { out: () => {} }), /keel-rt-\* OneDrive/);
  await assert.rejects(onedrivePurviewMain(['plan', '--fixture-site', SITE, '--fixture-label', 'Confidential', '--fixture-policy', POLICY_NAME], { out: () => {} }), /--fixture-label/);
  await assert.rejects(onedrivePurviewMain(['plan', '--fixture-site', SITE, '--fixture-label', LABEL_NAME, '--fixture-policy', 'Global label policy'], { out: () => {} }), /--fixture-policy/);
  await assert.rejects(onedrivePurviewMain(['capture', '--confirm-live-tenant-write', ...args, '--tenant-ref', tenantRef], { ...io, out: () => {} }), /needs --directory-tenant-id/);
  await assert.rejects(capture(purviewFake(), { exchangeQualification: null }), /Exchange/);
  await assert.rejects(capture(purviewFake(), { modules: { ...MODULES, 'PnP.PowerShell': 'latest' } }), /pnp-module-version/);
  await assert.rejects(capture(purviewFake(), { probeSite: SITE }), /another keel-rt-\* OneDrive/);
  await assert.rejects(capture(purviewFake(), { tenantHost: 'fabrikam.sharepoint.com' }), /must be on fabrikam-my.sharepoint.com/);

  // The CLI refuses before any cmdlet when the Exchange record does not verify.
  const pendingExchange = join(dir, 'pending-exchange.json');
  copyFileSync(join(repo, 'docs/release/qualifications/exchange-live-acceptance.json'), pendingExchange);
  writeFileSync(join(dir, 'grants.json'), JSON.stringify(onedrivePurviewRequiredGrants()));
  writeFileSync(join(dir, 'docs.json'), JSON.stringify(odpDocumentation()));
  const refusal = [];
  assert.equal(await onedrivePurviewMain([
    'capture', '--confirm-live-tenant-write', ...args, '--tenant-ref', tenantRef, '--directory-tenant-id', TENANT, '--build', build,
    '--collector-ref', 'app:c', '--restorer-ref', 'app:r', '--collector-config', '/etc/keel/c.json', '--restorer-config', '/etc/keel/r.json',
    '--pnp-module-version', PNP_VERSION, '--exchange-module-version', EXO_VERSION, '--grants', join(dir, 'grants.json'), '--docs', join(dir, 'docs.json'),
    '--exchange-evidence', pendingExchange, '--out', join(dir, 'cli-onedrive-purview.json'),
  ], { ...io, out: (line) => refusal.push(line) }), 2);
  assert.match(refusal.join('\n'), /qualified only after Exchange/);
  assert.equal(sent, 0, 'nothing was sent');

  // Unsafe states: no write at all, and the record does not verify.
  for (const [flags, pattern] of [
    [{ labelLock: true }, /reports a preservation lock; KEEL never writes a locked object/],
    [{ policies: [policyBody(POLICY_ID, POLICY_NAME, { IsPreservationLocked: true })] }, /reports a preservation lock/],
    [{ policyAudience: ['All'] }, /not fixture-only \(ExchangeLocation publishes to All/],
    [{ probeExists: true }, /probe OneDrive exists/],
    [{ template: 'GROUP#0' }, /a read failed/],
    [{ labels: [labelBody(LABEL_ID, LABEL_NAME), labelBody(CONFIDENTIAL_ID, LABEL_NAME)] }, /2 labels are named/],
    [{ siteExists: false }, /a read failed/],
  ]) {
    const fake = purviewFake(flags);
    const result = await capturedFiles(fake);
    assert.deepEqual(fake.writes(), [], JSON.stringify(flags));
    assert.match(result.record.subject.writes.label.error, pattern);
    assert.equal(result.needsManualRevert, false);
    assert.equal(verifyEvidenceFile(result.outPath, options()).ok, false);
    assert.equal(fake.contentCalls(), 0);
  }
  // A lock is observed and recorded, never overridden: the locked label kept its definition.
  const teamSite = await capture(purviewFake({ template: 'GROUP#0' }));
  assert.match(teamSite.record.subject.reads.find((read) => read.operationId === 'onedrive.site-settings').error, /not a OneDrive personal site/);
  const locked = purviewFake({ labelLock: true });
  const lockedRecord = await capturedFiles(locked);
  assert.equal(lockedRecord.record.subject.fixtureLabel.lock, 'locked');
  assert.equal(locked.state.labels[0].Comment, 'fixture comment');

  // A label the policy already publishes is never removed and re-added: the policy write is not sent.
  const published = purviewFake({ alreadyPublished: true });
  const already = await capturedFiles(published);
  assert.deepEqual(published.writes(), ['Set-Label', 'Set-Label']);
  assert.match(already.record.subject.writes.policy.error, /already published .* never removes it/);
  assert.match(verifyEvidenceFile(already.outPath, options()).failures.join('\n'), /purview.label-policy.update: the write failed/);

  // A platform that ignores the writes is not qualified.
  for (const [flags, pattern] of [
    [{ ignoreLabelWrites: true }, /purview.label.update: the change was not read back/],
    [{ ignorePolicyWrites: true }, /purview.label-policy.update: the change was not read back/],
  ]) {
    assert.match(verifyEvidenceFile((await capturedFiles(purviewFake(flags))).outPath, options()).failures.join('\n'), pattern);
  }
  // Another label changing during the capture (not by KEEL) is caught.
  assert.match(verifyEvidenceFile((await capturedFiles(purviewFake({ mutateOtherLabel: true }))).outPath, options()).failures.join('\n'), /non-fixture label or policy definition changed/);
  // A failed put-back is loud, kept as the platform reported it, stops the policy write, and never verifies.
  const stuck = purviewFake({ failLabelRevert: true });
  const failed = await capturedFiles(stuck);
  assert.equal(failed.needsManualRevert, true);
  assert.match(failed.record.subject.writes.label.error, /PUTTING THE LABEL COMMENT BACK FAILED \(Set-Label: The server is busy.\)/);
  assert.deepEqual(stuck.writes(), ['Set-Label', 'Set-Label']);
  assert.equal(verifyEvidenceFile(failed.outPath, options()).ok, false);
});
