// Roadmap task-121: Teams configuration workload qualification.
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
// Both capture tools (task-120 SharePoint, task-121 Teams) run against in-memory
// fake Graphs, and the records are signed with a test-only key in a temporary
// directory. No tenant is read or written, and no record produced here is persisted
// as release evidence.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
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
import {
  TEAMS_LIVE_GATE, TEAMS_LIVE_READS, TEAMS_LIVE_WRITES, teamsRequiredDocumentation, teamsRequiredGrants,
} from '../../tools/qualification/teamsAcceptance.mjs';
import {
  TEAMS_TOGGLE_GROUP, TEAMS_TOGGLE_PROPERTY, captureTeamsAcceptance, ledgerEvidenceFromTeamsAcceptance, main as teamsMain, tokenTenantId,
  writeTeamsAcceptanceFiles,
} from '../../tools/qualification/teamsLive.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const KEY = 'test-only';
const tenantRef = tenantRefFor('teams-live-fixture');
const build = 'fixture-build';
const TENANT = '0f0f0f0f-0000-4000-8000-000000000001';
const OTHER_TENANT = '0f0f0f0f-0000-4000-8000-000000000002';
const TEAM = '7e7e7e7e-1111-4111-8111-111111111111';
const OTHER_TEAM = '7e7e7e7e-2222-4222-8222-222222222222';
const OWNER = 'a0a0a0a0-0000-4000-8000-00000000000a';
const FIXTURE_USER = 'b0b0b0b0-0000-4000-8000-00000000000b';
const observed = new Date('2026-10-03T08:00:00Z');
const verifyNow = new Date('2026-10-03T09:00:00Z');

const dir = mkdtempSync(join(tmpdir(), 'keel-teams-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// ---- The task-120 prerequisite: a verified SharePoint record beside the Teams one.
const SP_HOST = 'contoso.sharepoint.com';
const SP_SITE = `${SP_HOST},11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222`;
const SP_URL = `https://${SP_HOST}/sites/KEEL-RT-20261003`;

function sharePointGraph() {
  const settings = {
    sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'none',
    sharingAllowedDomainList: [], sharingBlockedDomainList: [], isResharingByExternalUsersEnabled: true,
  };
  return async (url, init) => {
    const path = decodeURIComponent(new URL(url).pathname);
    const method = init?.method ?? 'GET';
    if (path === '/v1.0/admin/sharepoint/settings') {
      if (method === 'PATCH') { Object.assign(settings, init.body); return { status: 204, headers: {}, body: null }; }
      return { status: 200, headers: {}, body: structuredClone(settings) };
    }
    if (path === '/v1.0/sites/getAllSites') return { status: 200, headers: {}, body: { value: [{ id: SP_SITE, webUrl: SP_URL }] } };
    if (path === `/v1.0/sites/${SP_SITE}`) return { status: 200, headers: {}, body: { id: SP_SITE, webUrl: SP_URL } };
    if (path === `/v1.0/sites/${SP_SITE}/permissions`) return { status: 200, headers: {}, body: { value: [] } };
    return { status: 404, headers: {}, body: null };
  };
}

const SP_FILE = 'sharepoint-live-acceptance.json';
let sharePointEvidence;
let sharePointReference;
before(async () => {
  const transport = sharePointGraph();
  const result = await captureSharePointAcceptance({
    collector: transport, restorer: transport, tenantHost: SP_HOST, fixtureSiteUrl: SP_URL, tenantRef, build,
    credentials: { collector: 'app:keel-sp-collector', restorer: 'app:keel-sp-restorer' }, grants: requiredGrants(),
    documentation: requiredDocumentation().map((url) => ({ url, retrievedAt: '2026-10-02T12:00:00Z' })),
    now: () => observed, sleep: async () => {}, readBackDelayMs: 0,
  });
  ({ evidence: sharePointEvidence } = writeAcceptanceFiles({ ...result, outPath: join(dir, SP_FILE), hmacKey: KEY }));
  sharePointReference = { gate: SHAREPOINT_LIVE_GATE, evidence: SP_FILE, captureLogSha256: sharePointEvidence.subject.captureLogSha256 };
});

// ---- The Teams fake: two teams (one KEEL-RT), an owner, a fixture user to add and remove.
function teamsGraph({ ignoreSettingsWrites = false, ignoreRoleWrites = false, failRemove = false, failRevert = false, startWithFixtureUser = false, teamName = 'KEEL-RT-20261003', teamTenant = TENANT, leaveOwnerLink = false, failOwnerUnlink = false, fixtureOwnerBefore = false, rosterLagReads = 0, ownerLinkDelayReads = 0, memberLinkPersists = false } = {}) {
  const team = {
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#teams/$entity',
    id: TEAM, displayName: teamName, description: 'KEEL rehearsal team', visibility: 'private', isArchived: false, tenantId: teamTenant,
    memberSettings: { allowCreateUpdateChannels: true }, guestSettings: { allowCreateUpdateChannels: false },
    messagingSettings: { allowUserEditMessages: true }, funSettings: { allowGiphy: true, giphyContentRating: 'moderate', allowCustomMemes: true },
    discoverySettings: { showInTeamsSearchAndSuggestions: false },
  };
  const members = [{ id: 'MjA-owner', userId: OWNER, tenantId: TENANT, roles: ['owner'], displayName: 'Owner' }];
  if (startWithFixtureUser) members.push({ id: 'MjA-fixture', userId: FIXTURE_USER, tenantId: TENANT, roles: [], displayName: 'Fixture' });
  // Promoting a member to owner also makes it an owner of the team's group. With
  // leaveOwnerLink, demoting and removing the Teams membership leave that link behind,
  // as live Graph did on 2026-10-04.
  const owners = [OWNER];
  if (fixtureOwnerBefore) owners.push(FIXTURE_USER);
  // With rosterLagReads, a removed member stays in the Teams roster for that many
  // roster reads, as live Teams did for ~60-90 s on 2026-10-04.
  // With ownerLinkDelayReads, promoting creates the group owner link only after that many
  // reads of the group's owners, and the late link survives the demote and the removal (as
  // live Graph did on 2026-10-05).
  let pendingOwner = null;
  // With memberLinkPersists, the Teams removal returns 204 but the group member link stays
  // until it is deleted directly (seen live on 2026-10-05).
  const lingeringGroupMembers = [];
  let pendingOwnerReads = 0;
  let ghost = null;
  let ghostReads = 0;
  const calls = [];
  let throttled = false;
  let settingsPatches = 0;
  let next = 1;
  const transport = async (url, init) => {
    const { pathname, search } = new URL(url);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${pathname}${search}`);
    const path = decodeURIComponent(pathname);
    if (path === '/v1.0/teams' && method === 'GET') {
      if (!throttled) { throttled = true; return { status: 429, headers: { 'retry-after': '1' }, body: null }; }
      return search
        ? { status: 200, headers: {}, body: { value: [{ id: OTHER_TEAM, displayName: 'Finance' }] } }
        : { status: 200, headers: {}, body: { value: [{ id: TEAM, displayName: teamName }], '@odata.nextLink': `${url}?$skiptoken=p2` } };
    }
    if (path === `/v1.0/teams/${TEAM}`) {
      if (method === 'GET') return { status: 200, headers: {}, body: structuredClone(team) };
      if (method === 'PATCH') {
        settingsPatches += 1;
        if (failRevert && settingsPatches === 2) return { status: 500, headers: {}, body: null };
        if (!ignoreSettingsWrites) Object.assign(team, structuredClone(init.body));
        return { status: 204, headers: {}, body: null };
      }
    }
    if (path === `/v1.0/teams/${TEAM}/members`) {
      if (method === 'GET') {
        const roster = ghost && ghostReads > 0 ? [...members, ghost] : members;
        if (ghostReads > 0) ghostReads -= 1;
        return { status: 200, headers: {}, body: { value: structuredClone(roster) } };
      }
      if (method === 'POST') {
        const userId = /users\('([^']+)'\)/.exec(init.body['user@odata.bind'])[1];
        const member = { id: `MjA-new-${next++}`, userId, tenantId: TENANT, roles: init.body.roles, displayName: 'Fixture' };
        members.push(member);
        return { status: 201, headers: {}, body: member };
      }
    }
    const membership = new RegExp(`^/v1\\.0/teams/${TEAM}/members/(.+)$`).exec(path);
    if (membership) {
      const index = members.findIndex((member) => member.id === membership[1]);
      if (index < 0) return { status: 404, headers: {}, body: null };
      const unown = (userId) => { if (!leaveOwnerLink && owners.includes(userId)) owners.splice(owners.indexOf(userId), 1); };
      if (method === 'PATCH') {
        if (!ignoreRoleWrites) {
          members[index].roles = init.body.roles;
          if (init.body.roles.includes('owner') && ownerLinkDelayReads) { pendingOwner = members[index].userId; pendingOwnerReads = ownerLinkDelayReads; }
          else if (init.body.roles.includes('owner')) { if (!owners.includes(members[index].userId)) owners.push(members[index].userId); } else unown(members[index].userId);
        }
        return { status: 200, headers: {}, body: members[index] };
      }
      if (method === 'DELETE') {
        if (failRemove) return { status: 500, headers: {}, body: null };
        unown(members[index].userId);
        if (memberLinkPersists) lingeringGroupMembers.push(members[index].userId);
        [ghost] = members.splice(index, 1);
        ghostReads = rosterLagReads;
        return { status: 204, headers: {}, body: null };
      }
    }
    if (path === `/v1.0/groups/${TEAM}/owners` && method === 'GET') {
      if (pendingOwner && (pendingOwnerReads -= 1) <= 0) { owners.push(pendingOwner); pendingOwner = null; }
      return { status: 200, headers: {}, body: { value: owners.map((id) => ({ '@odata.type': '#microsoft.graph.user', id })) } };
    }
    const ownerLink = new RegExp(`^/v1\\.0/groups/${TEAM}/owners/(.+)/\\$ref$`).exec(path);
    if (ownerLink && method === 'DELETE') {
      if (failOwnerUnlink) return { status: 500, headers: {}, body: null };
      if (!owners.includes(ownerLink[1])) return { status: 404, headers: {}, body: null };
      owners.splice(owners.indexOf(ownerLink[1]), 1);
      return { status: 204, headers: {}, body: null };
    }
    if (path === `/v1.0/groups/${TEAM}/members` && method === 'GET') {
      const ids = [...members.map((member) => member.userId), ...lingeringGroupMembers];
      return { status: 200, headers: {}, body: { value: ids.map((id) => ({ '@odata.type': '#microsoft.graph.user', id })) } };
    }
    const memberLink = new RegExp(`^/v1\\.0/groups/${TEAM}/members/(.+)/\\$ref$`).exec(path);
    if (memberLink && method === 'DELETE') {
      if (!lingeringGroupMembers.includes(memberLink[1])) return { status: 404, headers: {}, body: null };
      lingeringGroupMembers.splice(lingeringGroupMembers.indexOf(memberLink[1]), 1);
      return { status: 204, headers: {}, body: null };
    }
    return { status: 404, headers: {}, body: null };
  };
  return { transport, calls, team, members, owners, lingeringGroupMembers };
}

const teamsDocumentation = () => teamsRequiredDocumentation().map((url) => ({ url, retrievedAt: '2026-10-02T12:00:00Z' }));

async function capture(graph = teamsGraph(), overrides = {}) {
  return captureTeamsAcceptance({
    collector: graph.transport, restorer: graph.transport, directoryTenantId: TENANT, fixtureTeamId: TEAM, fixtureMemberUserId: FIXTURE_USER,
    tenantRef, build, credentials: { collector: 'app:keel-teams-collector', restorer: 'app:keel-teams-restorer' },
    grants: teamsRequiredGrants(), sharePointQualification: sharePointReference, documentation: teamsDocumentation(),
    now: () => observed, sleep: async () => {}, readBackDelayMs: 0, ...overrides,
  });
}

let counter = 0;
async function capturedFiles(graph, overrides) {
  const result = await capture(graph, overrides);
  const outPath = join(dir, `teams-record-${counter += 1}.json`);
  const { evidence, logPath } = writeTeamsAcceptanceFiles({ ...result, outPath, hmacKey: KEY });
  return { ...result, evidence, outPath, logPath };
}

const options = (extra = {}) => ({ gate: TEAMS_LIVE_GATE, tenantRef, build, now: verifyNow, hmacKey: KEY, requireLive: true, ...extra });
const verifyIn = (evidence, extra) => verifyEvidence(evidence, { ...options(extra), evidenceDir: dir });
/** Applies a change and re-signs it with the trusted test key, as a dishonest capture would. */
const resign = (evidence, change) => signEvidence(change(structuredClone(evidence)), KEY);

test('a valid independently captured record verifies, and the capture touched only the KEEL-RT team and fixture user', async () => {
  const graph = teamsGraph();
  const { evidence, outPath, record } = await capturedFiles(graph);
  assert.deepEqual(verifyEvidenceFile(outPath, options()), { ok: true, failures: [] });

  assert.deepEqual(record.subject.reads.map((read) => [read.operationId, read.ok]), TEAMS_LIVE_READS.map((id) => [id, true]));
  assert.equal(record.subject.reads.find((read) => read.operationId === 'teams.team-discovery').pages, 2, 'discovery followed nextLink');
  assert.equal(record.subject.throttle.retryAfterResponses, 1, 'the throttled discovery page was retried and recorded');
  assert.equal(evidence.proof.runner.identity, 'keel-release-runner');
  // Only the fixture team (and its group) were addressed; the other team never was.
  assert.ok(!graph.calls.some((call) => call.includes(OTHER_TEAM)));
  assert.ok(!graph.calls.some((call) => /messages|chats|channels|tabs|drive|files|hostedContents/i.test(call)), 'zero content calls');
  // Settings: changed, read back, put back.
  assert.equal(graph.calls.filter((call) => call === `PATCH /v1.0/teams/${TEAM}`).length, 2);
  assert.equal(graph.team[TEAMS_TOGGLE_GROUP][TEAMS_TOGGLE_PROPERTY], true);
  assert.equal(record.subject.settingsWrite.readBackVerified, true);
  assert.equal(record.subject.settingsWrite.preFingerprint, record.subject.settingsWrite.finalFingerprint);
  // Membership: add, promote, demote, remove; the fixture user ends absent.
  assert.deepEqual(record.subject.membershipWrites.captures.map((item) => [item.operationId, item.ok, item.readBackVerified]),
    TEAMS_LIVE_WRITES.slice(1).map((id) => [id, true, true]));
  assert.deepEqual(graph.members.map((member) => member.userId), [OWNER]);
  assert.equal(record.subject.membershipWrites.preFingerprint, record.subject.membershipWrites.finalFingerprint);
  assert.deepEqual([record.subject.fixtureMember.memberBefore, record.subject.fixtureMember.memberAfter], [false, false]);
  assert.doesNotMatch(readFileSync(outPath, 'utf8'), /bearer\s|authorization|access_?token/i);
});

test('an altered signature or capture-log digest fails', async () => {
  const { evidence, logPath } = await capturedFiles();
  const forged = structuredClone(evidence);
  forged.proof.runner.signature = forged.proof.runner.signature.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  assert.match(verifyIn(forged).failures.join('\n'), /signature mismatch/);

  const edited = structuredClone(evidence);
  edited.subject.throttle.retryAfterResponses = 0;
  assert.match(verifyIn(edited).failures.join('\n'), /signature mismatch/, 'any edit after signing breaks the signature');

  writeFileSync(logPath, readFileSync(logPath, 'utf8').replace('"PATCH"', '"GET"'));
  assert.match(verifyIn(evidence).failures.join('\n'), /artifact digest mismatch/);

  // A swapped log with a matching proof digest is still not the one the signature covers.
  const swapped = structuredClone(evidence);
  writeFileSync(join(dir, 'teams-swapped.capture.json'), '{}\n');
  swapped.proof.artifact = { path: 'teams-swapped.capture.json', sha256: 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356' };
  const swappedFailures = verifyIn(swapped).failures.join('\n');
  assert.doesNotMatch(swappedFailures, /artifact digest mismatch/, 'the swapped log matches its own digest');
  assert.match(swappedFailures, /capture log digest is not bound/);
});

test('wrong tenant, build or operation fails, even when re-signed by the trusted runner', async () => {
  const { evidence } = await capturedFiles();
  assert.match(verifyIn(evidence, { tenantRef: tenantRefFor('another-tenant') }).failures.join('\n'), /cross-tenant/);
  assert.match(verifyIn(evidence, { build: 'another-build' }).failures.join('\n'), /Teams build mismatch/);
  assert.match(verifyIn(evidence, { tenantRef: null }).failures.join('\n'), /expected tenant\/build/);
  for (const [change, pattern] of [
    [(e) => { e.operation = 'sharepoint.configuration-qualification'; return e; }, /Teams operation mismatch/],
    [(e) => { e.operation = 'teams.settings.update'; return e; }, /Teams operation mismatch/],
    [(e) => { e.credentialMode = 'restorer'; return e; }, /credential mode/],
    [(e) => { e.gate = SHAREPOINT_LIVE_GATE; return e; }, /gate mismatch/],
    [(e) => { e.subject.settingsWrite.operationId = 'sharepoint.tenant-settings.update'; return e; }, /no live capture of teams.settings.update/],
    [(e) => { e.subject.membershipWrites.captures[0].operationId = 'sharepoint.tenant-settings.update'; return e; }, /no live capture of teams.membership.add/],
    [(e) => { e.subject.reads[1].version = 'beta'; return e; }, /teams.settings: captured at beta/],
    [(e) => { e.subject.credentials.restorer = e.subject.credentials.collector; return e; }, /separate credentials/],
    [(e) => { e.subject.fixtureTeam.displayName = 'Finance'; return e; }, /disposable KEEL-RT/],
    [(e) => { e.subject.fixtureTeam.tenantId = OTHER_TENANT; return e; }, /fixture team belongs to another tenant/],
    [(e) => { e.subject.fixtureMember.tenantId = OTHER_TENANT; return e; }, /fixture user belongs to another tenant/],
    [(e) => { e.subject.directoryTenantId = OTHER_TENANT; return e; }, /belongs to another tenant/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }
});

test('stale evidence fails: an old record, old captures inside a fresh record, or a stale SharePoint prerequisite', async () => {
  const { evidence } = await capturedFiles();
  const late = new Date('2026-11-10T00:00:00Z');
  const lateFailures = verifyIn(evidence, { now: late }).failures.join('\n');
  assert.match(lateFailures, /observation is stale/);
  assert.match(lateFailures, /SharePoint record does not verify: .*stale/);
  for (const [change, pattern] of [
    [(e) => { e.subject.reads[2].capturedAt = '2026-09-30T08:00:00Z'; return e; }, /teams.membership: .*stale capture/],
    [(e) => { e.subject.settingsWrite.capturedAt = '2026-09-01T08:00:00Z'; return e; }, /teams.settings.update: .*stale capture/],
    [(e) => { e.subject.membershipWrites.captures[2].capturedAt = '2026-09-01T08:00:00Z'; return e; }, /teams.membership.remove: .*stale capture/],
    [(e) => { e.subject.documentation[0].retrievedAt = null; return e; }, /documentation not retrieved/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }
});

test('a missing prerequisite fails, and SharePoint proof never stands in for Teams proof', async () => {
  const { evidence } = await capturedFiles();
  for (const [change, pattern] of [
    [(e) => { e.subject.prerequisites = ['task-104']; return e; }, /missing prerequisite: task-120/],
    [(e) => { delete e.subject.sharePointQualification; return e; }, /no task-120 SharePoint qualification record named/],
    [(e) => { e.subject.sharePointQualification.evidence = 'absent.json'; return e; }, /SharePoint record absent.json is absent/],
    [(e) => { e.subject.sharePointQualification.gate = TEAMS_LIVE_GATE; return e; }, /not sharepoint-live-acceptance/],
    [(e) => { e.subject.sharePointQualification.captureLogSha256 = '0'.repeat(64); return e; }, /not the one this capture named/],
    // Pointing the SharePoint reference at the Teams log, or the Teams log at SharePoint's.
    [(e) => { e.subject.captureLogSha256 = e.subject.sharePointQualification.captureLogSha256; return e; }, /SharePoint capture log cannot stand in/],
    [(e) => { e.subject.reads = e.subject.reads.filter((r) => r.operationId !== 'teams.group-membership'); return e; }, /no live capture of teams.group-membership/],
    [(e) => { e.subject.reads[0].ok = false; return e; }, /teams.team-discovery: the read failed/],
    [(e) => { delete e.subject.reads[0].pages; return e; }, /teams.team-discovery: paging not recorded/],
    [(e) => { e.subject.grants.collector.permissions = e.subject.grants.collector.permissions.filter((p) => p !== 'GroupMember.Read.All'); return e; }, /collector lacks GroupMember.Read.All/],
    [(e) => { e.subject.grants.restorer.permissions = ['TeamSettings.ReadWrite.All']; return e; }, /restorer lacks TeamMember.ReadWrite.All/],
    [(e) => { e.subject.grants.collector.permissions.push('TeamMember.ReadWrite.All'); return e; }, /collector holds a write permission/],
    [(e) => { e.subject.supportedFields = e.subject.supportedFields.filter((f) => f !== 'guestSettings'); return e; }, /not observed live: guestSettings/],
    [(e) => { delete e.subject.settingsWrite; return e; }, /no live capture of teams.settings.update/],
    [(e) => { e.subject.membershipWrites.captures = e.subject.membershipWrites.captures.filter((c) => c.operationId !== 'teams.membership.update'); return e; }, /no live capture of teams.membership.update/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }

  // A SharePoint record that does not verify (here: tampered after signing) blocks the Teams record.
  const isolated = mkdtempSync(join(dir, 'broken-sp-'));
  const broken = structuredClone(sharePointEvidence);
  broken.subject.write.field = 'sharingCapability';
  writeFileSync(join(isolated, SP_FILE), JSON.stringify(broken));
  copyFileSync(join(dir, sharePointEvidence.proof.artifact.path), join(isolated, sharePointEvidence.proof.artifact.path));
  const { evidence: teamsRecord, outPath } = await capturedFiles();
  copyFileSync(outPath, join(isolated, 'teams.json'));
  copyFileSync(join(dir, teamsRecord.proof.artifact.path), join(isolated, teamsRecord.proof.artifact.path));
  assert.match(verifyEvidenceFile(join(isolated, 'teams.json'), options()).failures.join('\n'), /SharePoint record does not verify: .*signature mismatch/);
  // A SharePoint record for another build does not qualify this one.
  assert.match(verifyIn(teamsRecord, { build: 'another-build' }).failures.join('\n'), /SharePoint record does not verify: .*build mismatch/);

  // The SharePoint record itself is never Teams evidence.
  assert.match(verifyIn(sharePointEvidence).failures.join('\n'), /gate mismatch/);
  assert.equal(ledgerEvidenceFromTeamsAcceptance(sharePointEvidence, { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir }).ok, false);
});

test('missing external evidence fails: the checked-in pending record, an absent file, the release CLI', async () => {
  const pending = join(repo, 'docs/release/qualifications/teams-live-acceptance.json');
  const record = JSON.parse(readFileSync(pending, 'utf8'));
  const placeholder = isPendingPlaceholder(pending);
  if (placeholder) {
    assert.equal(record.synthetic, true);
    assert.match(verifyEvidenceFile(pending, options()).failures.join('\n'), /pending/);
    assert.equal(verifyEvidenceFile(pending, options({ requireLive: false })).ok, false);
  } else {
    // A live capture has replaced the placeholder: it must still never verify without the key.
    assertCommittedLiveRecord(pending, { gate: TEAMS_LIVE_GATE, root: repo, verify: verifyEvidenceFile, verifyOptions: options() });
  }
  assert.equal(verifyEvidenceFile(join(dir, 'absent.json'), options()).ok, false);
  // A record without its capture log, or without a runner signature, is not evidence.
  const { evidence, logPath } = await capturedFiles();
  rmSync(logPath);
  assert.match(verifyIn(evidence).failures.join('\n'), /Teams capture artifact required/);
  const { proof, ...unsigned } = evidence;
  assert.match(verifyIn({ ...unsigned, proof: { artifact: proof.artifact } }, { requireLive: false }).failures.join('\n'), /Teams runner proof required/);
  if (placeholder) {
    // The exact release command exits nonzero on the checked-in record.
    assert.throws(() => execFileSync(process.execPath, [
      'tools/release/qualification.mjs', 'verify', '--require-live', '--gate', TEAMS_LIVE_GATE,
      '--evidence', 'docs/release/qualifications/teams-live-acceptance.json',
    ], { cwd: repo, stdio: 'pipe' }), (error) => error.status === 1 && /pending/.test(String(error.stdout)));
  }
});

test('fixture evidence is never elevated to live-qualified, and only a verified record reaches the ledgers', async () => {
  const { evidence } = await capturedFiles();
  const fixtureRunner = signEvidence(structuredClone(evidence), KEY, 'keel-fixture-runner');
  assert.match(verifyIn(fixtureRunner).failures.join('\n'), /synthetic runner/);
  assert.match(verifyIn(fixtureRunner, { requireLive: false }).failures.join('\n'), /Teams fixture evidence cannot claim live qualification/);
  const synthetic = resign(evidence, (e) => { e.synthetic = true; return e; });
  assert.match(verifyIn(synthetic, { requireLive: false }).failures.join('\n'), /Teams fixture evidence cannot claim live/);
  const fixtureLevel = resign(evidence, (e) => { e.evidenceLevel = 'fixture-tested'; return e; });
  assert.match(verifyIn(fixtureLevel).failures.join('\n'), /needs evidenceLevel 'live-qualified'/);
  const syntheticRead = resign(evidence, (e) => { e.subject.reads[1].synthetic = true; return e; });
  assert.match(verifyIn(syntheticRead).failures.join('\n'), /teams.settings: synthetic/);
  const syntheticWrite = resign(evidence, (e) => { e.subject.membershipWrites.captures[1].synthetic = true; return e; });
  assert.match(verifyIn(syntheticWrite).failures.join('\n'), /teams.membership.update: synthetic/);
  const sameValue = resign(evidence, (e) => { e.subject.settingsWrite.writeMode = 'same-value'; return e; });
  assert.match(verifyIn(sameValue).failures.join('\n'), /same-value write/);

  // The import seam: nothing from a fixture record, everything from a verified one.
  const seam = { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir };
  for (const bad of [fixtureRunner, synthetic, fixtureLevel]) {
    const imported = ledgerEvidenceFromTeamsAcceptance(bad, seam);
    assert.equal(imported.ok, false);
    assert.deepEqual([imported.reads, imported.writes], [[], []]);
  }

  const sharePoint = ledgerEvidenceFromAcceptance(sharePointEvidence, seam);
  const teams = ledgerEvidenceFromTeamsAcceptance(evidence, seam);
  assert.equal(sharePoint.ok, true, sharePoint.failures.join('; '));
  assert.equal(teams.ok, true, teams.failures.join('; '));
  const grants = {
    permissions: [...sharePoint.grants.permissions, ...teams.grants.permissions],
    roles: [...sharePoint.grants.roles, ...teams.grants.roles],
  };
  // SharePoint alone qualifies no Teams operation.
  const spLedger = buildWorkloadLedger({ evidence: sharePoint.reads, grants, tenantRef, now: verifyNow });
  for (const id of TEAMS_LIVE_READS) assert.notEqual(spLedger.rows.find((row) => row.id === id).state, 'live-qualified', id);
  for (const id of TEAMS_LIVE_WRITES) {
    assert.equal(workloadWriteQualification(id, { readLedger: spLedger, evidence: sharePoint.writes, tenantRef, now: verifyNow }).enabled, false, id);
  }
  // Teams evidence without SharePoint's leaves the Teams writes disabled.
  const teamsOnlyLedger = buildWorkloadLedger({ evidence: teams.reads, grants, tenantRef, now: verifyNow });
  for (const id of TEAMS_LIVE_READS) assert.equal(teamsOnlyLedger.rows.find((row) => row.id === id).state, 'live-qualified', id);
  assert.equal(workloadWriteQualification('teams.settings.update', { readLedger: teamsOnlyLedger, evidence: teams.writes, tenantRef, now: verifyNow }).enabled, false);
  // Both together enable every Teams write, each on its own capture.
  const ledger = buildWorkloadLedger({ evidence: [...sharePoint.reads, ...teams.reads], grants, tenantRef, now: verifyNow });
  for (const id of TEAMS_LIVE_WRITES) {
    const state = workloadWriteQualification(id, { readLedger: ledger, evidence: [...sharePoint.writes, ...teams.writes], tenantRef, now: verifyNow });
    assert.equal(state.enabled, true, `${id}: ${state.reasons.join('; ')}`);
    assert.match(state.proof.live.proofRef, /^teams-live-acceptance@/);
  }
  // The same record never qualifies another tenant.
  assert.equal(ledgerEvidenceFromTeamsAcceptance(evidence, { ...seam, tenantRef: tenantRefFor('another-tenant') }).ok, false);
});

test('a content call, another team or user, a write by the collector or credential material in the record fails', async () => {
  const { evidence, record } = await capturedFiles();
  const membershipId = record.subject.fixtureMember.membershipId;
  for (const [request, pattern] of [
    [{ credential: 'collector', method: 'GET', version: 'v1.0', path: `/teams/${TEAM}/channels`, status: 200 }, /content call/],
    [{ credential: 'collector', method: 'GET', version: 'v1.0', path: `/chats`, status: 200 }, /content call/],
    [{ credential: 'collector', method: 'GET', version: 'v1.0', path: `/teams/${TEAM}?$expand=channels`, status: 200 }, /content call/],
    [{ credential: 'collector', method: 'GET', version: 'v1.0', path: `/teams/${OTHER_TEAM}`, status: 200 }, /other than the KEEL-RT fixture/],
    [{ credential: 'collector', method: 'GET', version: 'v1.0', path: `/groups/${OTHER_TEAM}/members`, status: 200 }, /other than the KEEL-RT fixture/],
    [{ credential: 'collector', method: 'PATCH', version: 'v1.0', path: `/teams/${TEAM}`, status: 204 }, /not an allowed write/],
    [{ credential: 'restorer', method: 'PATCH', version: 'v1.0', path: `/teams/${OTHER_TEAM}`, status: 204 }, /other than the KEEL-RT fixture/],
    [{ credential: 'restorer', method: 'GET', version: 'v1.0', path: `/groups/${TEAM}/members`, status: 200 }, /restorer reads only/],
    [{ credential: 'restorer', method: 'PATCH', version: 'v1.0', path: `/teams/${TEAM}`, status: 204 }, /exactly 2 teams.settings.update/],
    [{ credential: 'restorer', method: 'POST', version: 'v1.0', path: `/teams/${TEAM}/members`, status: 201, memberUserId: OWNER }, /adds a user other than the membership fixture/],
    [{ credential: 'restorer', method: 'DELETE', version: 'v1.0', path: `/teams/${TEAM}/members/MjA-owner`, status: 204 }, /membership other than the fixture user's/],
    [{ credential: 'restorer', method: 'DELETE', version: 'v1.0', path: `/teams/${TEAM}/members/${membershipId}`, status: 204 }, /exactly 1 teams.membership.remove/],
  ]) {
    assert.match(verifyIn(resign(evidence, (e) => { e.subject.requests.push(request); return e; })).failures.join('\n'), pattern, JSON.stringify(request));
  }
  // A throttled (not applied) write that Retry-After resent is not an extra write.
  const throttled = resign(evidence, (e) => { e.subject.requests.push({ credential: 'restorer', method: 'PATCH', version: 'v1.0', path: `/teams/${TEAM}`, status: 429 }); return e; });
  assert.deepEqual(verifyIn(throttled).failures, []);
  const leaked = resign(evidence, (e) => { e.subject.credentials.accessToken = 'x'; return e; });
  assert.match(verifyIn(leaked).failures.join('\n'), /credential material/);
  const jwt = resign(evidence, (e) => { e.subject.credentials.collector = 'eyJhbGciOi.eyJzdWIiOi.sig'; return e; });
  assert.match(verifyIn(jwt).failures.join('\n'), /credential material/);
});

test('the capture tool is offline by default, refuses non-fixture teams, and reports a failed clean-up', async () => {
  let sent = 0;
  const counting = async () => { sent += 1; return { status: 500, headers: {}, body: null }; };
  const lines = [];
  const env = { KEEL_TEAMS_COLLECTOR_TOKEN: 'c', KEEL_TEAMS_RESTORER_TOKEN: 'r' };
  const base = ['--fixture-team-id', TEAM, '--fixture-member-user-id', FIXTURE_USER];
  assert.equal(await teamsMain(['plan', ...base], { out: (line) => lines.push(line), env, transportFor: () => counting }), 0);
  assert.equal(await teamsMain(['capture', ...base, '--tenant-ref', tenantRef], { out: (line) => lines.push(line), env, transportFor: () => counting }), 2);
  assert.match(lines.at(-1), /--confirm-live-tenant-write/);
  await assert.rejects(teamsMain(['plan', '--fixture-team-id', 'Finance', '--fixture-member-user-id', FIXTURE_USER], { out: () => {} }), /GUID/);
  await assert.rejects(teamsMain(['capture', '--confirm-live-tenant-write', ...base, '--tenant-ref', tenantRef], { out: () => {}, env: {}, transportFor: () => counting }), /needs --directory-tenant-id/);
  await assert.rejects(capture(teamsGraph(), { sharePointQualification: null, collector: counting, restorer: counting }), /SharePoint/);

  // The CLI refuses before any request when the SharePoint record does not verify.
  const pendingSp = join(dir, 'pending-sp.json');
  copyFileSync(join(repo, 'docs/release/qualifications/sharepoint-live-acceptance.json'), pendingSp);
  writeFileSync(join(dir, 'grants.json'), JSON.stringify(teamsRequiredGrants()));
  writeFileSync(join(dir, 'docs.json'), JSON.stringify(teamsDocumentation()));
  const refusal = [];
  assert.equal(await teamsMain([
    'capture', '--confirm-live-tenant-write', ...base, '--tenant-ref', tenantRef, '--directory-tenant-id', TENANT, '--build', build,
    '--collector-ref', 'app:c', '--restorer-ref', 'app:r', '--grants', join(dir, 'grants.json'), '--docs', join(dir, 'docs.json'),
    '--sharepoint-evidence', pendingSp, '--out', join(dir, 'cli-teams.json'),
  ], { out: (line) => refusal.push(line), env, transportFor: () => counting }), 2);
  assert.match(refusal.join('\n'), /Teams is qualified only after SharePoint/);
  assert.equal(sent, 0, 'nothing was sent');

  // A team that is not KEEL-RT-*, or that belongs to another tenant, is never written.
  for (const graph of [teamsGraph({ teamName: 'Finance' }), teamsGraph({ teamTenant: OTHER_TENANT })]) {
    const result = await capture(graph);
    assert.equal(graph.calls.filter((call) => !call.startsWith('GET')).length, 0);
    assert.match(result.record.subject.settingsWrite.error, /KEEL-RT|another tenant/);
    assert.equal(result.needsManualRevert, false);
  }
  // A fixture user who is already a member is refused: the capture must leave membership as it found it.
  const occupied = teamsGraph({ startWithFixtureUser: true });
  const refused = await capture(occupied);
  assert.equal(occupied.calls.filter((call) => !call.startsWith('GET')).length, 0);
  assert.match(refused.record.subject.membershipWrites.error, /already a member/);

  // A platform that ignores the writes is not qualified.
  const ignoringSettings = await capturedFiles(teamsGraph({ ignoreSettingsWrites: true }));
  assert.match(verifyEvidenceFile(ignoringSettings.outPath, options()).failures.join('\n'), /teams.settings.update: the change was not read back/);
  const ignoringRoles = await capturedFiles(teamsGraph({ ignoreRoleWrites: true }));
  assert.match(verifyEvidenceFile(ignoringRoles.outPath, options()).failures.join('\n'), /teams.membership.update: the change was not read back/);

  // A failed put-back or removal is loud and never verifies.
  const stuck = teamsGraph({ failRevert: true });
  const failed = await capture(stuck);
  assert.equal(failed.needsManualRevert, true);
  assert.match(failed.record.subject.settingsWrite.error, /PUTTING THE SETTING BACK FAILED/);
  const sticky = teamsGraph({ failRemove: true });
  const notRemoved = await capture(sticky);
  assert.equal(notRemoved.needsManualRevert, true);
  assert.match(notRemoved.record.subject.membershipWrites.error, /FIXTURE USER MAY STILL BE A MEMBER/);
  assert.ok(sticky.members.some((member) => member.userId === FIXTURE_USER));
});

test('when Graph omits the team\'s tenantId, the collector token\'s tenant proves it; an unproven or foreign tenant is refused', async () => {
  const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
  assert.equal(tokenTenantId(jwt({ tid: TENANT.toUpperCase() })), TENANT);
  assert.equal(tokenTenantId(jwt({})), null);
  assert.equal(tokenTenantId('not-a-token'), null);

  // Live Graph v1.0 returns no tenantId for app-only callers: the collector token's tenant stands in.
  const silent = teamsGraph({ teamTenant: null });
  const proven = await capturedFiles(silent, { credentialTenants: { collector: TENANT, restorer: TENANT } });
  assert.deepEqual(verifyEvidenceFile(proven.outPath, options()), { ok: true, failures: [] });
  assert.equal(proven.record.subject.fixtureTeam.tenantId, TENANT);
  assert.equal(proven.record.subject.fixtureTeam.tenantIdSource, 'collector-token');

  // A tenantId Graph does report is used as reported.
  const reported = await capture(teamsGraph(), { credentialTenants: { collector: TENANT, restorer: TENANT } });
  assert.equal(reported.record.subject.fixtureTeam.tenantIdSource, 'team');

  // No tenantId and no known token tenant: nothing is written.
  const unknown = teamsGraph({ teamTenant: null });
  const refused = await capture(unknown);
  assert.equal(unknown.calls.filter((call) => !call.startsWith('GET')).length, 0);
  assert.match(refused.record.subject.settingsWrite.error, /did not report the fixture team's tenant/);

  // A reported foreign tenant still wins over the token, and a token for another tenant sends nothing.
  const foreign = teamsGraph({ teamTenant: OTHER_TENANT });
  const foreignResult = await capture(foreign, { credentialTenants: { collector: TENANT, restorer: TENANT } });
  assert.equal(foreign.calls.filter((call) => !call.startsWith('GET')).length, 0);
  assert.match(foreignResult.record.subject.settingsWrite.error, /another tenant/);
  for (const role of ['collector', 'restorer']) {
    const untouched = teamsGraph();
    await assert.rejects(capture(untouched, { credentialTenants: { [role]: OTHER_TENANT } }), new RegExp(`${role} token was issued for another tenant`));
    assert.equal(untouched.calls.length, 0);
  }

  // A record whose tenant source was tampered with fails, even when re-signed.
  const tampered = resign(proven.evidence, (e) => { e.subject.fixtureTeam.tenantIdSource = 'operator-said-so'; return e; });
  assert.match(verifyIn(tampered).failures.join('\n'), /tenant has no recognized source/);
});

test('a promotion that leaves the group owner link is cleaned up and checked; an owner link that stays never verifies', async () => {
  // Live Graph left the fixture user as a group owner after demote and remove, and Teams re-added it later.
  const lingering = teamsGraph({ leaveOwnerLink: true });
  const cleaned = await capturedFiles(lingering);
  assert.deepEqual(verifyEvidenceFile(cleaned.outPath, options()), { ok: true, failures: [] });
  assert.ok(lingering.calls.includes(`DELETE /v1.0/groups/${TEAM}/owners/${FIXTURE_USER}/$ref`));
  assert.deepEqual(lingering.owners, [OWNER]);
  const { membershipWrites, fixtureMember } = cleaned.record.subject;
  assert.equal(membershipWrites.ownerLinkRemoved, true);
  assert.equal(membershipWrites.restoredToOriginal, true);
  assert.equal(membershipWrites.ownersPreFingerprint, membershipWrites.ownersFinalFingerprint);
  assert.deepEqual([fixtureMember.ownerBefore, fixtureMember.ownerAfter, fixtureMember.groupMemberBefore, fixtureMember.groupMemberAfter], [false, false, false, false]);

  // When Graph cleans up by itself, no owner link is removed.
  const clean = teamsGraph();
  const plain = await capturedFiles(clean);
  assert.deepEqual(verifyEvidenceFile(plain.outPath, options()), { ok: true, failures: [] });
  assert.ok(!clean.calls.some((call) => call.includes('/owners/')));
  assert.equal(plain.record.subject.membershipWrites.ownerLinkRemoved, false);

  // An owner link that cannot be removed is reported, needs a manual revert and never verifies.
  const stuck = teamsGraph({ leaveOwnerLink: true, failOwnerUnlink: true });
  const failed = await capturedFiles(stuck);
  assert.equal(failed.needsManualRevert, true);
  assert.equal(failed.record.subject.fixtureMember.ownerAfter, true);
  assert.match(failed.record.subject.membershipWrites.error, /MAY STILL BE A MEMBER OR OWNER/);
  const failures = verifyEvidenceFile(failed.outPath, options()).failures.join('\n');
  assert.match(failures, /must not own the fixture group/);
  assert.match(failures, /final owners do not match/);

  // A fixture user who already owns the fixture group is refused before any write.
  const owning = teamsGraph({ fixtureOwnerBefore: true });
  const refused = await capture(owning);
  assert.equal(owning.calls.filter((call) => !call.startsWith('GET')).length, 0);
  assert.match(refused.record.subject.membershipWrites.error, /already an owner of the fixture group/);

  // A record claiming a restore while the owner link stayed fails, even when re-signed;
  // so does an owner-link removal aimed at another user.
  const lied = resign(cleaned.evidence, (e) => { e.subject.fixtureMember.ownerAfter = true; return e; });
  assert.match(verifyIn(lied).failures.join('\n'), /must not own the fixture group/);
  const otherUser = resign(cleaned.evidence, (e) => {
    const unlink = e.subject.requests.find((request) => request.method === 'DELETE' && request.path.includes('/owners/'));
    unlink.path = `/groups/${TEAM}/owners/${OWNER}/$ref`;
    return e;
  });
  assert.match(verifyIn(otherUser).failures.join('\n'), /other than the KEEL-RT fixture/);
});

test('a Teams roster that lags the removal is polled until the user is gone, and a lag past the window never verifies', async () => {
  // 20 lagging roster reads outlast the 5 ordinary read-backs but not the removal window.
  const lagging = teamsGraph({ rosterLagReads: 20 });
  const settled = await capturedFiles(lagging, { restoreReadDelayMs: 0 });
  const { membershipWrites } = settled.record.subject;
  assert.equal(membershipWrites.captures.find((item) => item.operationId === 'teams.membership.remove').readBackVerified, true);
  assert.equal(membershipWrites.restoredToOriginal, true);
  assert.deepEqual(verifyEvidenceFile(settled.outPath, options()), { ok: true, failures: [] });

  const stale = await capture(teamsGraph({ rosterLagReads: 1000 }), { restoreReadDelayMs: 0 });
  assert.equal(stale.record.subject.membershipWrites.restoredToOriginal, false);
  assert.match(stale.record.subject.membershipWrites.error, /THE FIXTURE USER MAY STILL BE A MEMBER OR OWNER/);
});

test('a group member link that outlives the Teams removal is deleted when seen, and the record verifies', async () => {
  const persisting = teamsGraph({ memberLinkPersists: true });
  const settled = await capturedFiles(persisting, { restoreReadDelayMs: 0, settleDelayMs: 0 });
  assert.deepEqual(persisting.lingeringGroupMembers, []);
  assert.equal(persisting.calls.filter((call) => call === `DELETE /v1.0/groups/${TEAM}/members/${FIXTURE_USER}/$ref`).length, 1);
  const { membershipWrites, fixtureMember } = settled.record.subject;
  assert.equal(membershipWrites.memberLinkRemoved, true);
  assert.equal(membershipWrites.restoredToOriginal, true);
  assert.equal(fixtureMember.groupMemberAfter, false);
  assert.deepEqual(verifyEvidenceFile(settled.outPath, options()), { ok: true, failures: [] });

  // A clean run never touches the group member link, and only the fixture user's link may be removed.
  const clean = teamsGraph();
  await capture(clean, { restoreReadDelayMs: 0, settleDelayMs: 0 });
  assert.ok(!clean.calls.some((call) => call.includes('/members/') && call.includes('/groups/')));
  const other = resign(settled.evidence, (e) => {
    e.subject.requests.push({ credential: 'restorer', method: 'DELETE', version: 'v1.0', path: `/groups/${TEAM}/members/${OWNER}/$ref`, status: 204 });
    return e;
  });
  assert.match(verifyIn(other).failures.join('\n'), /addresses a team, group or user other than the KEEL-RT fixture/);
});

test('a group owner link that appears after the removal is deleted when seen, and the restore re-checks after the settle delay', async () => {
  // The link shows up on the settle read, after the first round looked clean: a second round removes it.
  const late = teamsGraph({ ownerLinkDelayReads: 2 });
  const settled = await capturedFiles(late, { restoreReadDelayMs: 0, settleDelayMs: 0 });
  assert.deepEqual(late.owners, [OWNER]);
  assert.equal(late.calls.filter((call) => call === `DELETE /v1.0/groups/${TEAM}/owners/${FIXTURE_USER}/$ref`).length, 1);
  const { membershipWrites, fixtureMember } = settled.record.subject;
  assert.equal(membershipWrites.ownerLinkRemoved, true);
  assert.equal(membershipWrites.restoredToOriginal, true);
  assert.equal(fixtureMember.ownerAfter, false);
  assert.deepEqual(verifyEvidenceFile(settled.outPath, options()), { ok: true, failures: [] });

  // A link already there on the first read is removed in the first round.
  const early = teamsGraph({ ownerLinkDelayReads: 1 });
  const first = await capturedFiles(early, { restoreReadDelayMs: 0, settleDelayMs: 0 });
  assert.deepEqual(early.owners, [OWNER]);
  assert.equal(first.record.subject.membershipWrites.restoredToOriginal, true);
  assert.deepEqual(verifyEvidenceFile(first.outPath, options()), { ok: true, failures: [] });
});

