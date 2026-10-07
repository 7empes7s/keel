// Roadmap task-122: Exchange configuration workload qualification.
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
// All three capture tools (task-120 SharePoint, task-121 Teams, task-122 Exchange)
// run against in-memory fakes: Graph transports, and a fake PowerShell container
// behind the real engine/powershell/jobQueue.mjs spawn path that plays the
// ops/powershell/run-cmdlet.ps1 contract. Records are signed with a test-only key in
// a temporary directory. No tenant or mailbox is read or written, and no record
// produced here is persisted as release evidence.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildWorkloadLedger } from '../collect/workloadContract.mjs';
import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { signEvidence, verifyEvidence, verifyEvidenceFile } from '../../tools/release/qualification.mjs';
import { assertCommittedLiveRecord, isPendingPlaceholder } from '../test/committedEvidence.mjs';
import { SHAREPOINT_LIVE_GATE, requiredDocumentation, requiredGrants } from '../../tools/qualification/sharepointAcceptance.mjs';
import { captureSharePointAcceptance, ledgerEvidenceFromAcceptance, writeAcceptanceFiles } from '../../tools/qualification/sharepointLive.mjs';
import { TEAMS_LIVE_GATE, teamsRequiredDocumentation, teamsRequiredGrants } from '../../tools/qualification/teamsAcceptance.mjs';
import { captureTeamsAcceptance, ledgerEvidenceFromTeamsAcceptance, writeTeamsAcceptanceFiles } from '../../tools/qualification/teamsLive.mjs';
import {
  EXCHANGE_LIVE_EXCLUDED_WRITES, EXCHANGE_LIVE_GATE, EXCHANGE_LIVE_READS, EXCHANGE_LIVE_WRITES, exchangeRequiredDocumentation, exchangeRequiredGrants,
} from '../../tools/qualification/exchangeAcceptance.mjs';
import {
  captureExchangeAcceptance, ledgerEvidenceFromExchangeAcceptance, main as exchangeMain, writeExchangeAcceptanceFiles,
} from '../../tools/qualification/exchangeLive.mjs';
import { pseudonymizer } from '../../tools/qualification/pseudonymize.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const KEY = 'test-only';
const tenantRef = tenantRefFor('exchange-live-fixture');
const build = 'fixture-build';
const TENANT = '0f0f0f0f-0000-4000-8000-000000000001';
const OTHER_TENANT = '0f0f0f0f-0000-4000-8000-000000000002';
const MAILBOX = 'keel-rt-20260908-alice@contoso.test';
const OTHER_MAILBOX = 'ceo@contoso.test';
const PROBE = 'keel-rt-absent-0001@contoso.test';
const MAILBOX_OBJECT = 'c0c0c0c0-0000-4000-8000-00000000000c';
const MODULE_VERSION = '3.5.0';
const observed = new Date('2026-10-03T08:00:00Z');
const verifyNow = new Date('2026-10-03T09:00:00Z');

const dir = mkdtempSync(join(tmpdir(), 'keel-exchange-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const fixedClock = () => observed;
const noSleep = async () => {};

// ---- The task-120 and task-121 prerequisites: verified records beside the Exchange one.
const SP_HOST = 'contoso.sharepoint.com';
const SP_SITE = `${SP_HOST},11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222`;
const SP_URL = `https://${SP_HOST}/sites/KEEL-RT-20261003`;
const TEAM = '7e7e7e7e-1111-4111-8111-111111111111';
const OWNER = 'a0a0a0a0-0000-4000-8000-00000000000a';
const TEAM_MEMBER = 'b0b0b0b0-0000-4000-8000-00000000000b';

function sharePointGraph() {
  const settings = {
    sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'none',
    sharingAllowedDomainList: [], sharingBlockedDomainList: [], isResharingByExternalUsersEnabled: true,
  };
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
    id: TEAM, displayName: 'KEEL-RT-20261003', tenantId: TENANT,
    memberSettings: { allowCreateUpdateChannels: true }, guestSettings: { allowCreateUpdateChannels: false },
    messagingSettings: { allowUserEditMessages: true }, funSettings: { allowGiphy: true, allowCustomMemes: true },
    discoverySettings: { showInTeamsSearchAndSuggestions: false },
  };
  const members = [{ id: 'MjA-owner', userId: OWNER, tenantId: TENANT, roles: ['owner'] }];
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
    if (path === `/v1.0/groups/${TEAM}/owners`) return { status: 200, headers: {}, body: { value: [{ id: OWNER }] } };
    return { status: 404, headers: {}, body: null };
  };
}

const SP_FILE = 'sharepoint-live-acceptance.json';
const TEAMS_FILE = 'teams-live-acceptance.json';
let sharePointEvidence;
let teamsEvidence;
let teamsReference;
before(async () => {
  const sp = sharePointGraph();
  const spResult = await captureSharePointAcceptance({
    collector: sp, restorer: sp, tenantHost: SP_HOST, fixtureSiteUrl: SP_URL, tenantRef, build,
    credentials: { collector: 'app:keel-sp-collector', restorer: 'app:keel-sp-restorer' }, grants: requiredGrants(),
    documentation: requiredDocumentation().map((url) => ({ url, retrievedAt: '2026-10-02T12:00:00Z' })),
    now: fixedClock, sleep: noSleep, readBackDelayMs: 0,
  });
  ({ evidence: sharePointEvidence } = writeAcceptanceFiles({ ...spResult, outPath: join(dir, SP_FILE), hmacKey: KEY }));
  const teams = teamsGraph();
  const teamsResult = await captureTeamsAcceptance({
    collector: teams, restorer: teams, directoryTenantId: TENANT, fixtureTeamId: TEAM, fixtureMemberUserId: TEAM_MEMBER, tenantRef, build,
    credentials: { collector: 'app:keel-teams-collector', restorer: 'app:keel-teams-restorer' }, grants: teamsRequiredGrants(),
    sharePointQualification: { gate: SHAREPOINT_LIVE_GATE, evidence: SP_FILE, captureLogSha256: sharePointEvidence.subject.captureLogSha256 },
    documentation: teamsRequiredDocumentation().map((url) => ({ url, retrievedAt: '2026-10-02T12:00:00Z' })),
    now: fixedClock, sleep: noSleep, readBackDelayMs: 0,
  });
  ({ evidence: teamsEvidence } = writeTeamsAcceptanceFiles({ ...teamsResult, outPath: join(dir, TEAMS_FILE), hmacKey: KEY }));
  assert.deepEqual(verifyEvidenceFile(join(dir, TEAMS_FILE), { gate: TEAMS_LIVE_GATE, tenantRef, build, now: verifyNow, hmacKey: KEY, requireLive: true }).failures, []);
  teamsReference = { gate: TEAMS_LIVE_GATE, evidence: TEAMS_FILE, captureLogSha256: teamsEvidence.subject.captureLogSha256 };
});

// ---- The Exchange fake: mailboxSettings over Graph, cmdlets through the real jobQueue spawn path.
function containerAllowlist() {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = /\$Allowed = @\{([\s\S]*?)\n\}/.exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, list]) => [name, [...list.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const ALLOWLIST = containerAllowlist();

function exchangeFake({
  retainFor = '14.00:00:00', orgTenant = TENANT, recipientType = 'UserMailbox', probeExists = false, ignoreSettingsWrites = false,
  ignoreCasWrites = false, failCasRevert = false, ignoreRetentionWrites = false, timeZone = 'UTC',
} = {}) {
  const mailbox = {
    settings: {
      automaticRepliesSetting: { status: 'disabled' }, timeZone, language: { locale: 'en-US' }, workingHours: { daysOfWeek: ['monday'] },
      dateFormat: 'yyyy-MM-dd', timeFormat: 'HH:mm', delegateMeetingMessageDeliveryOptions: 'sendToDelegateOnly', userPurpose: 'user',
    },
    cas: { OWAEnabled: true, ActiveSyncEnabled: true, PopEnabled: false, ImapEnabled: false, MAPIEnabled: true, EwsEnabled: true, SmtpClientAuthenticationDisabled: true },
    retention: {
      LitigationHoldEnabled: false, RetentionHoldEnabled: false, SingleItemRecoveryEnabled: true, RetainDeletedItemsFor: retainFor,
      InPlaceHolds: [], ComplianceTagHoldApplied: false, DelayHoldApplied: false, DelayReleaseHoldApplied: false, LitigationHoldDuration: 'Unlimited',
    },
    facts: { UserPrincipalName: MAILBOX, ExternalDirectoryObjectId: MAILBOX_OBJECT, RecipientTypeDetails: recipientType },
  };
  const organization = {
    FocusedInboxOn: true, MailTipsAllTipsEnabled: true, MailTipsExternalRecipientsTipsEnabled: false, MailTipsGroupMetricsEnabled: true,
    MailTipsLargeAudienceThreshold: 25, OAuth2ClientProfileEnabled: true, SmtpActionableMessagesEnabled: true, ConnectorsEnabled: true,
    ExternalDirectoryOrganizationId: orgTenant,
  };
  const calls = [];
  const graphCalls = [];
  const jobs = [];
  let throttled = false;
  let casSets = 0;
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });

  async function transport(url, init) {
    const method = init?.method ?? 'GET';
    const { pathname, search } = new URL(url);
    graphCalls.push(`${method} ${decodeURIComponent(pathname)}${search}`);
    const match = /^\/v1\.0\/users\/(.+)\/mailboxSettings$/.exec(decodeURIComponent(pathname));
    if (!match || match[1] !== MAILBOX) return { status: 404, headers: {}, body: null };
    if (method === 'GET' && !throttled) { throttled = true; return { status: 429, headers: { 'retry-after': '1' }, body: null }; }
    if (method === 'PATCH') {
      if (!ignoreSettingsWrites) Object.assign(mailbox.settings, structuredClone(init.body));
      return { status: 200, headers: {}, body: structuredClone(mailbox.settings) };
    }
    // Adversarial: a content-adjacent property. Never stored.
    return { status: 200, headers: {}, body: { archiveFolder: 'AAMkAD-archive', ...structuredClone(mailbox.settings) } };
  }

  function run(job) {
    const allowed = ALLOWLIST[job.cmdlet];
    if (job.mode !== 'cmdlet' || job.script !== undefined) return { stdout: '', stderr: 'refused descriptor', exitCode: 2 };
    if (!allowed) return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, errorId: 'CmdletNotAllowed' } }, 1);
    const args = Object.entries(job.parameters ?? {});
    for (const [name] of args) {
      if (!allowed.includes(name)) return envelope({ ok: false, error: { message: `parameter ${name} is not allowed`, errorId: 'ParameterNotAllowed' } }, 1);
    }
    calls.push({ cmdlet: job.cmdlet, args, config: job.tenantConfigPath ?? null });
    const values = Object.fromEntries(args);
    if (job.cmdlet === 'Get-OrganizationConfig') return envelope({ ok: true, output: [{ Identity: 'contoso.onmicrosoft.com', ...organization }] });
    if (values.Identity !== MAILBOX && !(probeExists && values.Identity === PROBE)) {
      return envelope({ ok: false, error: { message: `The operation couldn't be performed because object '${values.Identity}' couldn't be found.`, category: 'NotSpecified', errorId: 'ManagementObjectNotFoundException' } }, 1);
    }
    // Adversarial: content-adjacent properties. Never stored.
    if (job.cmdlet === 'Get-CASMailbox') return envelope({ ok: true, output: [{ Identity: values.Identity, RecentMessageSubjects: ['Q3 board pack'], ...mailbox.cas }] });
    if (job.cmdlet === 'Get-Mailbox') return envelope({ ok: true, output: [{ Identity: values.Identity, TotalItemSize: '1.2 GB', ...mailbox.facts, ...mailbox.retention }] });
    const { Identity, ...changes } = values;
    if (job.cmdlet === 'Set-CASMailbox') {
      casSets += 1;
      if (failCasRevert && casSets === 2) return envelope({ ok: false, error: { message: 'The server is busy.', category: 'ResourceUnavailable', errorId: 'ServerBusy' } }, 1);
      if (!ignoreCasWrites) Object.assign(mailbox.cas, changes);
    }
    if (job.cmdlet === 'Set-Mailbox' && !ignoreRetentionWrites) Object.assign(mailbox.retention, changes);
    if (job.cmdlet === 'Set-OrganizationConfig') Object.assign(organization, changes);
    return envelope({ ok: true, output: [] });
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
          const job = JSON.parse(input);
          jobs.push(job);
          const result = run(job);
          if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
          if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
          child.emit('close', result.exitCode);
        });
      },
    };
    return child;
  }
  const side = (config) => ({ transport, powershell: { spawnFn, timeoutMs: 200, tenantConfigPath: config } });
  return {
    mailbox, organization, calls, graphCalls, jobs,
    collector: side('/etc/keel/exchange-collector.json'), restorer: side('/etc/keel/exchange-restorer.json'),
    writes: () => [...graphCalls.filter((call) => !call.startsWith('GET')), ...calls.filter((call) => call.cmdlet.startsWith('Set-')).map((call) => call.cmdlet)],
  };
}

const exchangeDocumentation = () => exchangeRequiredDocumentation().map((url) => ({ url, retrievedAt: '2026-10-02T12:00:00Z' }));

async function capture(fake = exchangeFake(), overrides = {}) {
  return captureExchangeAcceptance({
    collector: fake.collector, restorer: fake.restorer, directoryTenantId: TENANT, fixtureMailbox: MAILBOX, probeIdentity: PROBE,
    tenantRef, build, moduleVersion: MODULE_VERSION, credentials: { collector: 'app:keel-exo-collector', restorer: 'app:keel-exo-restorer' },
    grants: exchangeRequiredGrants(), teamsQualification: teamsReference, documentation: exchangeDocumentation(),
    now: fixedClock, sleep: noSleep, readBackDelayMs: 0, ...overrides,
  });
}

let counter = 0;
async function capturedFiles(fake, overrides) {
  const result = await capture(fake, overrides);
  const outPath = join(dir, `exchange-record-${counter += 1}.json`);
  const { evidence, logPath } = writeExchangeAcceptanceFiles({ ...result, outPath, hmacKey: KEY });
  return { ...result, evidence, outPath, logPath };
}

const options = (extra = {}) => ({ gate: EXCHANGE_LIVE_GATE, tenantRef, build, now: verifyNow, hmacKey: KEY, requireLive: true, ...extra });
const verifyIn = (evidence, extra) => verifyEvidence(evidence, { ...options(extra), evidenceDir: dir });
/** Applies a change and re-signs it with the trusted test key, as a dishonest capture would. */
const resign = (evidence, change) => signEvidence(change(structuredClone(evidence)), KEY);

test('a valid independently captured record verifies, and the capture touched only the keel-rt fixture mailbox', async () => {
  const fake = exchangeFake();
  const { evidence, outPath, record } = await capturedFiles(fake);
  assert.deepEqual(verifyEvidenceFile(outPath, options()), { ok: true, failures: [] });
  assert.equal(evidence.proof.runner.identity, 'keel-release-runner');

  const { subject } = record;
  assert.deepEqual(subject.reads.map((read) => [read.operationId, read.ok]).sort(), EXCHANGE_LIVE_READS.map((id) => [id, true]).sort());
  assert.equal(subject.reads.find((read) => read.operationId === 'exchange.client-access').version, MODULE_VERSION, 'cmdlet reads are bound to the module version');
  assert.equal(subject.throttle.retryAfterResponses, 1, 'the throttled mailboxSettings read was retried and recorded');
  // Only the fixture (and the absent probe) were addressed; no content path or cmdlet was sent.
  assert.ok(fake.graphCalls.every((call) => call.endsWith(`/users/${MAILBOX}/mailboxSettings`)), fake.graphCalls.join('\n'));
  assert.deepEqual([...new Set(fake.calls.map((call) => call.args.find(([name]) => name === 'Identity')?.[1]).filter(Boolean))].sort(), [MAILBOX, PROBE].sort());
  assert.ok(!fake.calls.some((call) => /Folder|Message|Search|Export|InboxRule|Calendar|Remove-/.test(call.cmdlet)), 'zero content calls, no deletion');
  // Each identity is one argument in a data job, never script source; collector and restorer use their own configs.
  for (const job of fake.jobs) assert.deepEqual(Object.keys(job).sort(), ['adapter', 'cmdlet', 'jobId', 'mode', 'module', 'parameters', 'tenantConfigPath']);
  assert.ok(fake.calls.filter((call) => call.cmdlet.startsWith('Set-')).every((call) => call.config === '/etc/keel/exchange-restorer.json'));
  assert.ok(fake.calls.filter((call) => call.cmdlet === 'Get-OrganizationConfig').every((call) => call.config === '/etc/keel/exchange-collector.json'));
  // Writes: 2 settings PATCHes, 2 Set-CASMailbox, 1 Set-Mailbox; never Set-OrganizationConfig.
  assert.deepEqual(fake.writes().sort(), [
    `PATCH /v1.0/users/${MAILBOX}/mailboxSettings`, `PATCH /v1.0/users/${MAILBOX}/mailboxSettings`, 'Set-CASMailbox', 'Set-CASMailbox', 'Set-Mailbox',
  ].sort());
  // Post-state: settings and client access back; retention one day longer; no hold moved.
  assert.equal(fake.mailbox.settings.timeZone, 'UTC');
  assert.equal(fake.mailbox.cas.PopEnabled, false);
  assert.equal(fake.mailbox.retention.RetainDeletedItemsFor, '15.00:00:00');
  assert.deepEqual([fake.mailbox.retention.LitigationHoldEnabled, fake.mailbox.retention.RetentionHoldEnabled, fake.mailbox.retention.SingleItemRecoveryEnabled], [false, false, true]);
  assert.equal(subject.writes.mailboxSettings.preFingerprint, subject.writes.mailboxSettings.finalFingerprint);
  assert.equal(subject.writes.clientAccess.preFingerprint, subject.writes.clientAccess.finalFingerprint);
  // A held field was refused before sending; a platform error came back structured.
  assert.deepEqual([subject.refusals.heldField.refused, subject.refusals.heldField.sent], [true, false]);
  assert.ok(!fake.jobs.some((job) => 'LitigationHoldDuration' in job.parameters));
  assert.deepEqual([subject.platformError.status, subject.platformError.error.code, subject.platformError.error.errorId], ['failed', 'CMDLET_ERROR', 'ManagementObjectNotFoundException']);
  // Nothing from the mailbox's content-adjacent properties is kept; no secret in the record.
  const text = readFileSync(outPath, 'utf8') + readFileSync(join(dir, evidence.proof.artifact.path), 'utf8');
  assert.doesNotMatch(text, /Q3 board pack|archiveFolder|AAMkAD|TotalItemSize|bearer\s|authorization|access_?token/i);
});

test('an altered signature or capture-log digest fails', async () => {
  const { evidence, logPath } = await capturedFiles();
  const forged = structuredClone(evidence);
  forged.proof.runner.signature = forged.proof.runner.signature.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  assert.match(verifyIn(forged).failures.join('\n'), /signature mismatch/);

  const edited = structuredClone(evidence);
  edited.subject.writes.retention.after.RetainDeletedItemsFor = '30.00:00:00';
  assert.match(verifyIn(edited).failures.join('\n'), /signature mismatch/, 'any edit after signing breaks the signature');

  writeFileSync(logPath, readFileSync(logPath, 'utf8').replace('"PATCH"', '"GET"'));
  assert.match(verifyIn(evidence).failures.join('\n'), /artifact digest mismatch/);

  // A swapped log with a matching proof digest is still not the one the signature covers.
  const swapped = structuredClone(evidence);
  writeFileSync(join(dir, 'exchange-swapped.capture.json'), '{}\n');
  swapped.proof.artifact = { path: 'exchange-swapped.capture.json', sha256: 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356' };
  const swappedFailures = verifyIn(swapped).failures.join('\n');
  assert.doesNotMatch(swappedFailures, /artifact digest mismatch/, 'the swapped log matches its own digest');
  assert.match(swappedFailures, /capture log digest is not bound/);
});

test('wrong tenant, build or operation fails, even when re-signed by the trusted runner', async () => {
  const { evidence } = await capturedFiles();
  assert.match(verifyIn(evidence, { tenantRef: tenantRefFor('another-tenant') }).failures.join('\n'), /cross-tenant/);
  assert.match(verifyIn(evidence, { build: 'another-build' }).failures.join('\n'), /Exchange build mismatch/);
  assert.match(verifyIn(evidence, { tenantRef: null }).failures.join('\n'), /expected tenant\/build/);
  for (const [change, pattern] of [
    [(e) => { e.operation = 'teams.configuration-qualification'; return e; }, /Exchange operation mismatch/],
    [(e) => { e.operation = 'exchange.mailbox-settings.update'; return e; }, /Exchange operation mismatch/],
    [(e) => { e.credentialMode = 'restorer'; return e; }, /credential mode/],
    [(e) => { e.gate = TEAMS_LIVE_GATE; return e; }, /gate mismatch/],
    [(e) => { e.subject.writes.mailboxSettings.operationId = 'teams.settings.update'; return e; }, /no live capture of exchange.mailbox-settings.update/],
    [(e) => { e.subject.writes.retention.operationId = 'exchange.organization-config.update'; return e; }, /no live capture of exchange.mailbox-retention.update/],
    [(e) => { e.subject.reads[0].version = 'beta'; return e; }, /exchange.mailbox-settings: captured at beta/],
    [(e) => { e.subject.writes.clientAccess.version = '3.4.0'; return e; }, /exchange.client-access.update: captured at 3.4.0, not 3.5.0/],
    [(e) => { e.subject.credentials.restorer = e.subject.credentials.collector; return e; }, /separate credentials/],
    [(e) => { e.subject.fixtureMailbox.identity = OTHER_MAILBOX; return e; }, /not a disposable keel-rt-\* mailbox/],
    [(e) => { e.subject.fixtureMailbox.userPrincipalName = OTHER_MAILBOX; return e; }, /did not answer as the identity named/],
    [(e) => { e.subject.fixtureMailbox.recipientTypeDetails = 'SharedMailbox'; return e; }, /not a user mailbox/],
    [(e) => { e.subject.organization.externalDirectoryOrganizationId = OTHER_TENANT; return e; }, /organization belongs to another tenant/],
    [(e) => { e.subject.directoryTenantId = OTHER_TENANT; return e; }, /organization belongs to another tenant/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }
});

test('stale evidence fails: an old record, old captures inside a fresh record, or a stale Teams prerequisite', async () => {
  const { evidence } = await capturedFiles();
  const lateFailures = verifyIn(evidence, { now: new Date('2026-11-10T00:00:00Z') }).failures.join('\n');
  assert.match(lateFailures, /observation is stale/);
  assert.match(lateFailures, /Teams record does not verify: .*stale/);
  for (const [change, pattern] of [
    [(e) => { e.subject.reads[2].capturedAt = '2026-09-30T08:00:00Z'; return e; }, /stale capture/],
    [(e) => { e.subject.writes.mailboxSettings.capturedAt = '2026-09-01T08:00:00Z'; return e; }, /exchange.mailbox-settings.update: .*stale capture/],
    [(e) => { e.subject.writes.retention.capturedAt = '2026-09-01T08:00:00Z'; return e; }, /exchange.mailbox-retention.update: .*stale capture/],
    [(e) => { e.subject.writes.clientAccess.capturedAt = '2026-10-04T08:00:00Z'; return e; }, /captured after the record was observed/],
    [(e) => { e.subject.documentation[0].retrievedAt = null; return e; }, /documentation not retrieved/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }
});

test('a missing prerequisite fails, and Teams or SharePoint proof never stands in for Exchange proof', async () => {
  const { evidence } = await capturedFiles();
  for (const [change, pattern] of [
    [(e) => { e.subject.prerequisites = ['task-105']; return e; }, /missing prerequisite: task-121/],
    [(e) => { delete e.subject.teamsQualification; return e; }, /no task-121 Teams qualification record named/],
    [(e) => { e.subject.teamsQualification.evidence = 'absent.json'; return e; }, /Teams record absent.json is absent/],
    [(e) => { e.subject.teamsQualification.evidence = '../teams.json'; return e; }, /named as a file beside this one/],
    [(e) => { e.subject.teamsQualification.gate = SHAREPOINT_LIVE_GATE; return e; }, /not teams-live-acceptance/],
    [(e) => { e.subject.teamsQualification.captureLogSha256 = '0'.repeat(64); return e; }, /not the one this capture named/],
    [(e) => { e.subject.captureLogSha256 = e.subject.teamsQualification.captureLogSha256; return e; }, /Teams or SharePoint capture log cannot stand in/],
    [(e) => { e.subject.captureLogSha256 = sharePointEvidence.subject.captureLogSha256; return e; }, /Teams or SharePoint capture log cannot stand in/],
    [(e) => { e.subject.reads = e.subject.reads.filter((r) => r.operationId !== 'exchange.mailbox-hold'); return e; }, /no live capture of exchange.mailbox-hold/],
    [(e) => { e.subject.reads[0].ok = false; return e; }, /the read failed/],
    [(e) => { e.subject.execution.moduleVersion = null; return e; }, /no ExchangeOnlineManagement module version/],
    [(e) => { e.subject.execution.transport = 'pwsh-script'; return e; }, /bounded powershell-cmdlet-job transport/],
    [(e) => { e.subject.grants.collector.roles = []; return e; }, /collector lacks role Exchange Administrator/],
    [(e) => { e.subject.grants.restorer.permissions = ['Exchange.ManageAsApp']; return e; }, /restorer lacks MailboxSettings.ReadWrite/],
    [(e) => { e.subject.grants.collector.permissions.push('MailboxSettings.ReadWrite'); return e; }, /collector holds a write permission/],
    [(e) => { e.subject.supportedFields.retention = e.subject.supportedFields.retention.filter((f) => f !== 'InPlaceHolds'); return e; }, /not observed live: retention.InPlaceHolds/],
    [(e) => { delete e.subject.writes.clientAccess; return e; }, /no live capture of exchange.client-access.update/],
    [(e) => { e.subject.refusals.heldField.refused = false; return e; }, /unsupported held field not shown refused/],
    [(e) => { e.subject.refusals.contentPath.sent = true; return e; }, /content path was not shown refused/],
    [(e) => { e.subject.platformError.status = 'ok'; return e; }, /recorded as a success/],
    [(e) => { e.subject.platformError.error = { code: 'ERROR', errorId: null, message: '' }; return e; }, /cmdlet error was not preserved/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }

  // A Teams record that does not verify (here: tampered after signing) blocks the Exchange record.
  const isolated = mkdtempSync(join(dir, 'broken-teams-'));
  for (const file of [SP_FILE, sharePointEvidence.proof.artifact.path, teamsEvidence.proof.artifact.path]) copyFileSync(join(dir, file), join(isolated, file));
  const broken = structuredClone(teamsEvidence);
  broken.subject.throttle.retryAfterResponses = 7;
  writeFileSync(join(isolated, TEAMS_FILE), JSON.stringify(broken));
  const { evidence: record, outPath } = await capturedFiles();
  copyFileSync(outPath, join(isolated, 'exchange.json'));
  copyFileSync(join(dir, record.proof.artifact.path), join(isolated, record.proof.artifact.path));
  assert.match(verifyEvidenceFile(join(isolated, 'exchange.json'), options()).failures.join('\n'), /Teams record does not verify: .*signature mismatch/);
  // The Teams prerequisite needs its own SharePoint prerequisite: without it, Exchange fails too.
  const noSharePoint = mkdtempSync(join(dir, 'no-sp-'));
  for (const file of [TEAMS_FILE, teamsEvidence.proof.artifact.path, record.proof.artifact.path]) copyFileSync(join(dir, file), join(noSharePoint, file));
  copyFileSync(outPath, join(noSharePoint, 'exchange.json'));
  assert.match(verifyEvidenceFile(join(noSharePoint, 'exchange.json'), options()).failures.join('\n'), /Teams record does not verify: .*SharePoint record .* is absent/);
  // A Teams record for another build does not qualify this one.
  assert.match(verifyIn(record, { build: 'another-build' }).failures.join('\n'), /Teams record does not verify: .*build mismatch/);

  // The Teams and SharePoint records themselves are never Exchange evidence.
  for (const upstream of [teamsEvidence, sharePointEvidence]) {
    assert.match(verifyIn(upstream).failures.join('\n'), /gate mismatch/);
    assert.equal(ledgerEvidenceFromExchangeAcceptance(upstream, { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir }).ok, false);
  }
});

test('missing external evidence fails: the checked-in pending record, an absent file, the release CLI', async () => {
  const pending = join(repo, 'docs/release/qualifications/exchange-live-acceptance.json');
  const record = JSON.parse(readFileSync(pending, 'utf8'));
  const placeholder = isPendingPlaceholder(pending);
  if (placeholder) {
    assert.equal(record.synthetic, true);
    assert.match(verifyEvidenceFile(pending, options()).failures.join('\n'), /pending/);
    assert.equal(verifyEvidenceFile(pending, options({ requireLive: false })).ok, false);
  } else {
    // A live capture has replaced the placeholder: it must still never verify without the key.
    assertCommittedLiveRecord(pending, { gate: EXCHANGE_LIVE_GATE, root: repo, verify: verifyEvidenceFile, verifyOptions: options() });
  }
  assert.match(verifyIn({ ...record, status: 'pending' }, { requireLive: false }).failures.join('\n'), /pending/);
  assert.equal(verifyEvidenceFile(join(dir, 'absent.json'), options()).ok, false);
  // A record without its capture log, or without a runner signature, is not evidence.
  const { evidence, logPath } = await capturedFiles();
  rmSync(logPath);
  assert.match(verifyIn(evidence).failures.join('\n'), /Exchange capture artifact required/);
  const { proof, ...unsigned } = evidence;
  assert.match(verifyIn({ ...unsigned, proof: { artifact: proof.artifact } }, { requireLive: false }).failures.join('\n'), /Exchange runner proof required/);
  if (placeholder) {
    // The exact release command exits nonzero on the checked-in record.
    assert.throws(() => execFileSync(process.execPath, [
      'tools/release/qualification.mjs', 'verify', '--require-live', '--gate', EXCHANGE_LIVE_GATE,
      '--evidence', 'docs/release/qualifications/exchange-live-acceptance.json',
    ], { cwd: repo, stdio: 'pipe' }), (error) => error.status === 1 && /pending/.test(String(error.stdout)));
  }
});

test('fixture evidence is never elevated to live-qualified, and only a verified record reaches the ledgers', async () => {
  const { evidence } = await capturedFiles();
  const fixtureRunner = signEvidence(structuredClone(evidence), KEY, 'keel-fixture-runner');
  assert.match(verifyIn(fixtureRunner).failures.join('\n'), /synthetic runner/);
  assert.match(verifyIn(fixtureRunner, { requireLive: false }).failures.join('\n'), /Exchange fixture evidence cannot claim live qualification/);
  const synthetic = resign(evidence, (e) => { e.synthetic = true; return e; });
  assert.match(verifyIn(synthetic, { requireLive: false }).failures.join('\n'), /Exchange fixture evidence cannot claim live/);
  const fixtureLevel = resign(evidence, (e) => { e.evidenceLevel = 'fixture-tested'; return e; });
  assert.match(verifyIn(fixtureLevel).failures.join('\n'), /needs evidenceLevel 'live-qualified'/);
  const syntheticRead = resign(evidence, (e) => { e.subject.reads[1].synthetic = true; return e; });
  assert.match(verifyIn(syntheticRead).failures.join('\n'), /synthetic or unlabelled capture/);
  const syntheticWrite = resign(evidence, (e) => { e.subject.writes.retention.synthetic = true; return e; });
  assert.match(verifyIn(syntheticWrite).failures.join('\n'), /exchange.mailbox-retention.update: synthetic/);
  const sameValue = resign(evidence, (e) => { e.subject.writes.clientAccess.writeMode = 'same-value'; return e; });
  assert.match(verifyIn(sameValue).failures.join('\n'), /same-value write/);

  // The import seam: nothing from a fixture record, everything from a verified one.
  const seam = { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir };
  for (const bad of [fixtureRunner, synthetic, fixtureLevel]) {
    const imported = ledgerEvidenceFromExchangeAcceptance(bad, seam);
    assert.equal(imported.ok, false);
    assert.deepEqual([imported.reads, imported.writes, imported.grants], [[], [], null]);
  }

  const sharePoint = ledgerEvidenceFromAcceptance(sharePointEvidence, seam);
  const teams = ledgerEvidenceFromTeamsAcceptance(teamsEvidence, seam);
  const exchange = ledgerEvidenceFromExchangeAcceptance(evidence, seam);
  for (const imported of [sharePoint, teams, exchange]) assert.equal(imported.ok, true, imported.failures.join('; '));
  const grants = {
    permissions: [...sharePoint.grants.permissions, ...teams.grants.permissions, ...exchange.grants.permissions],
    roles: [...sharePoint.grants.roles, ...teams.grants.roles, ...exchange.grants.roles],
  };
  const { runtime } = exchange;
  const upstreamReads = [...sharePoint.reads, ...teams.reads];
  const upstreamWrites = [...sharePoint.writes, ...teams.writes];
  const writeState = (id, ledger, writes, restorerGrants = exchange.restorerGrants) => workloadWriteQualification(id, {
    readLedger: ledger, evidence: writes, tenantRef, now: verifyNow, runtime, grants: restorerGrants,
  });
  // Teams and SharePoint evidence alone qualify no Exchange operation.
  const upstreamLedger = buildWorkloadLedger({ evidence: upstreamReads, grants, runtime, tenantRef, now: verifyNow });
  for (const id of EXCHANGE_LIVE_READS) assert.notEqual(upstreamLedger.rows.find((row) => row.id === id).state, 'live-qualified', id);
  for (const id of EXCHANGE_LIVE_WRITES) assert.equal(writeState(id, upstreamLedger, upstreamWrites).enabled, false, id);
  // Exchange evidence without Teams' (and SharePoint's) leaves the Exchange writes disabled.
  const exchangeOnly = buildWorkloadLedger({ evidence: exchange.reads, grants, runtime, tenantRef, now: verifyNow });
  for (const id of EXCHANGE_LIVE_READS) assert.equal(exchangeOnly.rows.find((row) => row.id === id).state, 'live-qualified', id);
  assert.equal(writeState('exchange.client-access.update', exchangeOnly, exchange.writes).enabled, false);
  // All three together enable every captured Exchange write, each on its own capture.
  const ledger = buildWorkloadLedger({ evidence: [...upstreamReads, ...exchange.reads], grants, runtime, tenantRef, now: verifyNow });
  const writes = [...upstreamWrites, ...exchange.writes];
  for (const id of EXCHANGE_LIVE_WRITES) {
    const state = writeState(id, ledger, writes);
    assert.equal(state.enabled, true, `${id}: ${state.reasons.join('; ')}`);
    assert.match(state.proof.live.proofRef, /^exchange-live-acceptance@/);
  }
  // The organization-wide write is not part of the capture and stays disabled.
  for (const id of EXCHANGE_LIVE_EXCLUDED_WRITES) assert.equal(writeState(id, ledger, writes).enabled, false, id);
  // Unknown restorer RBAC still blocks the writes; another module version invalidates the cmdlet captures.
  assert.equal(writeState('exchange.mailbox-retention.update', ledger, writes, null).enabled, false);
  assert.equal(workloadWriteQualification('exchange.client-access.update', {
    readLedger: ledger, evidence: writes, tenantRef, now: verifyNow, runtime: { modules: { ExchangeOnlineManagement: '3.6.0' } }, grants: exchange.restorerGrants,
  }).enabled, false);
  // The same record never qualifies another tenant.
  assert.equal(ledgerEvidenceFromExchangeAcceptance(evidence, { ...seam, tenantRef: tenantRefFor('another-tenant') }).ok, false);
});

test('a content call, another mailbox, a collector write, an organization-wide write, a hold release or shortened retention fails', async () => {
  const { evidence } = await capturedFiles();
  const settingsPath = `/users/${encodeURIComponent(MAILBOX)}/mailboxSettings`;
  const cmd = (credential, cmdlet, parameters, outcome = 'ok') => ({ credential, transport: 'powershell-cmdlet-job', cmdlet, parameters, outcome });
  for (const [request, pattern] of [
    [{ credential: 'collector', transport: 'graph', method: 'GET', version: 'v1.0', path: `/users/${encodeURIComponent(MAILBOX)}/messages`, status: 200 }, /content call/],
    [{ credential: 'collector', transport: 'graph', method: 'GET', version: 'v1.0', path: `${settingsPath}?$expand=messages`, status: 200 }, /content call/],
    [{ credential: 'collector', transport: 'graph', method: 'GET', version: 'v1.0', path: `/users/${encodeURIComponent(OTHER_MAILBOX)}/mailboxSettings`, status: 200 }, /other than the keel-rt fixture/],
    [{ credential: 'collector', transport: 'graph', method: 'PATCH', version: 'v1.0', path: settingsPath, status: 200 }, /not an allowed write/],
    [{ credential: 'restorer', transport: 'graph', method: 'PATCH', version: 'v1.0', path: settingsPath, status: 200 }, /exactly 2 exchange.mailbox-settings.update/],
    [cmd('collector', 'Get-MailboxFolderStatistics', { Identity: MAILBOX }), /content call or undeclared cmdlet/],
    [cmd('collector', 'Search-Mailbox', { Identity: MAILBOX }), /content call or undeclared cmdlet/],
    [cmd('restorer', 'Remove-Mailbox', { Identity: MAILBOX }), /content call or undeclared cmdlet/],
    [cmd('collector', 'Get-Mailbox', { Identity: OTHER_MAILBOX }), /other than the keel-rt fixture/],
    [cmd('collector', 'Get-Mailbox', { Identity: PROBE }), /probe identity answered/],
    [cmd('restorer', 'Get-OrganizationConfig', {}), /only the collector reads the organization/],
    [cmd('collector', 'Set-CASMailbox', { Identity: MAILBOX, PopEnabled: true }), /not an allowed write/],
    [cmd('restorer', 'Set-CASMailbox', { Identity: OTHER_MAILBOX, PopEnabled: true }), /other than the keel-rt fixture/],
    [cmd('restorer', 'Set-CASMailbox', { Identity: MAILBOX, PopEnabled: true }), /exactly 2 exchange.client-access.update/],
    [cmd('restorer', 'Set-CASMailbox', { Identity: MAILBOX, OWAEnabled: false }), /changes more than the PopEnabled switch/],
    [cmd('restorer', 'Set-OrganizationConfig', { FocusedInboxOn: false }), /organization-wide write is not part of this capture/],
    [cmd('restorer', 'Set-Mailbox', { Identity: MAILBOX, LitigationHoldEnabled: false }), /never releases or changes a hold/],
    [cmd('restorer', 'Set-Mailbox', { Identity: MAILBOX, SingleItemRecoveryEnabled: false }), /never releases or changes a hold/],
    [cmd('restorer', 'Set-Mailbox', { Identity: MAILBOX, RetainDeletedItemsFor: '7.00:00:00' }), /shortens or does not extend deleted item retention/],
    [cmd('restorer', 'Set-Mailbox', { Identity: MAILBOX, RetainDeletedItemsFor: '14.00:00:00' }), /shortens or does not extend/],
    [cmd('restorer', 'Set-Mailbox', { Identity: MAILBOX, RetainDeletedItemsFor: '45.00:00:00' }), /beyond the 30-day ceiling/],
    [cmd('restorer', 'Set-Mailbox', { Identity: MAILBOX, LitigationHoldDuration: '1' }), /undeclared cmdlet/],
    [{ credential: 'restorer', transport: 'script', cmdlet: 'Get-Mailbox', parameters: {} }, /not the Graph or bounded cmdlet transport/],
    [{ credential: 'restorer', transport: 'powershell-cmdlet-job', cmdlet: 'Get-Mailbox', parameters: `-Identity ${MAILBOX}` }, /parameters not recorded as data/],
  ]) {
    assert.match(verifyIn(resign(evidence, (e) => { e.subject.requests.push(request); return e; })).failures.join('\n'), pattern, JSON.stringify(request));
  }
  // The post-state: retention shortened or a hold moved in the recorded values also fails.
  for (const [change, pattern] of [
    [(e) => { e.subject.writes.retention.after.RetainDeletedItemsFor = '10.00:00:00'; return e; }, /retention was shortened or not extended/],
    [(e) => { e.subject.writes.retention.after.LitigationHoldEnabled = true; return e; }, /LitigationHoldEnabled changed/],
    [(e) => { e.subject.writes.retention.writeMode = 'reversible-change'; return e; }, /extend-only write/],
    [(e) => { e.subject.writes.retention.finalComplianceHoldsFingerprint = '0'.repeat(64); return e; }, /holds Purview owns changed/],
    [(e) => { e.subject.writes.clientAccess.finalFingerprint = '0'.repeat(64); return e; }, /final configuration does not match/],
    [(e) => { e.subject.writes.organization = { operationId: 'exchange.organization-config.update' }; return e; }, /not part of this capture/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }
  // A throttled (not applied) Graph write that Retry-After resent is not an extra write.
  const throttled = resign(evidence, (e) => { e.subject.requests.push({ credential: 'restorer', transport: 'graph', method: 'PATCH', version: 'v1.0', path: settingsPath, status: 429 }); return e; });
  assert.deepEqual(verifyIn(throttled).failures, []);
  const leaked = resign(evidence, (e) => { e.subject.credentials.accessToken = 'x'; return e; });
  assert.match(verifyIn(leaked).failures.join('\n'), /credential material/);
  const certificate = resign(evidence, (e) => { e.subject.credentials.certThumbprint = 'ABC'; return e; });
  assert.match(verifyIn(certificate).failures.join('\n'), /credential material/);
});

test('the capture tool is offline by default, refuses non-fixture mailboxes and unsafe states, and reports a failed clean-up', async () => {
  let sent = 0;
  const counting = async () => { sent += 1; return { status: 500, headers: {}, body: null }; };
  const countingSpawn = () => { sent += 1; throw new Error('no container here'); };
  const io = { env: { KEEL_EXCHANGE_COLLECTOR_TOKEN: 'c', KEEL_EXCHANGE_RESTORER_TOKEN: 'r' }, transportFor: () => counting, powershellFor: () => ({ spawnFn: countingSpawn }) };
  const lines = [];
  assert.equal(await exchangeMain(['plan', '--fixture-mailbox', MAILBOX], { ...io, out: (line) => lines.push(line) }), 0);
  assert.match(lines[0], /Set-Mailbox -LitigationHoldDuration \(held field; refused before sending\)/);
  assert.doesNotMatch(lines[0], /Set-OrganizationConfig/);
  assert.equal(await exchangeMain(['capture', '--fixture-mailbox', MAILBOX, '--tenant-ref', tenantRef], { ...io, out: (line) => lines.push(line) }), 2);
  assert.match(lines.at(-1), /--confirm-live-tenant-write/);
  await assert.rejects(exchangeMain(['plan', '--fixture-mailbox', OTHER_MAILBOX], { out: () => {} }), /keel-rt-\* mailbox/);
  await assert.rejects(exchangeMain(['capture', '--confirm-live-tenant-write', '--fixture-mailbox', MAILBOX, '--tenant-ref', tenantRef], { ...io, out: () => {} }), /needs --directory-tenant-id/);
  await assert.rejects(capture(exchangeFake(), { teamsQualification: null }), /Teams/);
  await assert.rejects(capture(exchangeFake(), { moduleVersion: 'latest' }), /module-version/);
  await assert.rejects(capture(exchangeFake(), { probeIdentity: MAILBOX }), /another keel-rt-\* identity/);

  // The CLI refuses before any request when the Teams record does not verify.
  const pendingTeams = join(dir, 'pending-teams.json');
  copyFileSync(join(repo, 'docs/release/qualifications/teams-live-acceptance.json'), pendingTeams);
  writeFileSync(join(dir, 'grants.json'), JSON.stringify(exchangeRequiredGrants()));
  writeFileSync(join(dir, 'docs.json'), JSON.stringify(exchangeDocumentation()));
  const refusal = [];
  assert.equal(await exchangeMain([
    'capture', '--confirm-live-tenant-write', '--fixture-mailbox', MAILBOX, '--tenant-ref', tenantRef, '--directory-tenant-id', TENANT, '--build', build,
    '--collector-ref', 'app:c', '--restorer-ref', 'app:r', '--collector-config', '/etc/keel/c.json', '--restorer-config', '/etc/keel/r.json',
    '--exchange-module-version', MODULE_VERSION, '--grants', join(dir, 'grants.json'), '--docs', join(dir, 'docs.json'),
    '--teams-evidence', pendingTeams, '--out', join(dir, 'cli-exchange.json'),
  ], { ...io, out: (line) => refusal.push(line) }), 2);
  assert.match(refusal.join('\n'), /Exchange is qualified only after Teams/);
  assert.equal(sent, 0, 'nothing was sent');

  // An organization in another tenant, a shared mailbox or an existing probe identity: no write at all.
  for (const [fake, pattern] of [
    [exchangeFake({ orgTenant: OTHER_TENANT }), /another tenant/],
    [exchangeFake({ recipientType: 'SharedMailbox' }), /not a user mailbox/],
    [exchangeFake({ probeExists: true }), /probe identity exists/],
  ]) {
    const result = await capture(fake);
    assert.deepEqual(fake.writes(), []);
    assert.match(result.record.subject.writes.retention.error, pattern);
    assert.equal(result.needsManualRevert, false);
  }
  // Retention already at the 30-day ceiling: it is never written (and never shortened), so it does not qualify.
  const atCeiling = exchangeFake({ retainFor: '30.00:00:00' });
  const ceiling = await capturedFiles(atCeiling);
  assert.ok(!atCeiling.calls.some((call) => call.cmdlet === 'Set-Mailbox'));
  assert.equal(atCeiling.mailbox.retention.RetainDeletedItemsFor, '30.00:00:00');
  assert.match(verifyEvidenceFile(ceiling.outPath, options()).failures.join('\n'), /exchange.mailbox-retention.update: the write failed/);
  // The settings toggle moves away from whichever zone is set, then back.
  const gmt = exchangeFake({ timeZone: 'Greenwich Standard Time' });
  assert.deepEqual(verifyEvidenceFile((await capturedFiles(gmt)).outPath, options()).failures, []);
  assert.equal(gmt.mailbox.settings.timeZone, 'Greenwich Standard Time');

  // A platform that ignores the writes is not qualified.
  for (const [flags, pattern] of [
    [{ ignoreSettingsWrites: true }, /exchange.mailbox-settings.update: the change was not read back/],
    [{ ignoreCasWrites: true }, /exchange.client-access.update: the change was not read back/],
    [{ ignoreRetentionWrites: true }, /exchange.mailbox-retention.update: the change was not read back/],
  ]) {
    assert.match(verifyEvidenceFile((await capturedFiles(exchangeFake(flags))).outPath, options()).failures.join('\n'), pattern);
  }
  // A failed put-back is loud, kept as the platform reported it, and never verifies.
  const stuck = exchangeFake({ failCasRevert: true });
  const failed = await capturedFiles(stuck);
  assert.equal(failed.needsManualRevert, true);
  assert.match(failed.record.subject.writes.clientAccess.error, /PUTTING THE SETTING BACK FAILED \(Set-CASMailbox: The server is busy.\)/);
  assert.equal(stuck.mailbox.cas.PopEnabled, true);
  assert.equal(verifyEvidenceFile(failed.outPath, options()).ok, false);
});

test('when Exchange reports an empty organization tenant id, the collector token\'s tenant proves it; an unproven or foreign tenant is refused', async () => {
  // Live Get-OrganizationConfig can return an empty ExternalDirectoryOrganizationId: the collector token's tenant stands in.
  const proven = await capturedFiles(exchangeFake({ orgTenant: '' }), { credentialTenants: { collector: TENANT, restorer: TENANT } });
  assert.deepEqual(verifyEvidenceFile(proven.outPath, options()), { ok: true, failures: [] });
  assert.equal(proven.record.subject.organization.externalDirectoryOrganizationId, pseudonymizer(proven.record.tenantRef).guid(TENANT));
  assert.equal(proven.record.subject.organization.tenantIdSource, 'collector-token');

  // A reported id is used as reported, and a reported foreign id still wins over the token.
  const reported = await capture(exchangeFake(), { credentialTenants: { collector: TENANT, restorer: TENANT } });
  assert.equal(reported.record.subject.organization.tenantIdSource, 'organization');
  const foreign = exchangeFake({ orgTenant: OTHER_TENANT });
  const foreignResult = await capture(foreign, { credentialTenants: { collector: TENANT, restorer: TENANT } });
  assert.deepEqual(foreign.writes(), []);
  assert.match(foreignResult.record.subject.writes.retention.error, /another tenant/);

  // No reported id and no known token tenant: nothing is written.
  const unknown = exchangeFake({ orgTenant: '' });
  const refused = await capture(unknown);
  assert.deepEqual(unknown.writes(), []);
  assert.match(refused.record.subject.writes.retention.error, /did not report its tenant id/);

  // A token for another tenant sends nothing.
  for (const role of ['collector', 'restorer']) {
    const untouched = exchangeFake();
    await assert.rejects(capture(untouched, { credentialTenants: { [role]: OTHER_TENANT } }), new RegExp(`${role} token was issued for another tenant`));
    assert.equal(untouched.calls.length, 0);
  }

  // A record whose tenant source was tampered with fails, even when re-signed.
  const tampered = resign(proven.evidence, (e) => { e.subject.organization.tenantIdSource = 'operator-said-so'; return e; });
  assert.match(verifyIn(tampered).failures.join('\n'), /organization's tenant has no recognized source/);
});
