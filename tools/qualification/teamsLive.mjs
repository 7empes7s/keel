#!/usr/bin/env node
/**
 * Roadmap task-121: capture and import Teams configuration live-acceptance
 * evidence. The operator runs this; builders and CI never point it at a tenant.
 *
 *   node tools/qualification/teamsLive.mjs plan --fixture-team-id <guid> --fixture-member-user-id <guid>
 *     Offline (the default). Prints every request a capture would send. No network.
 *
 *   KEEL_TEAMS_COLLECTOR_TOKEN=... KEEL_TEAMS_RESTORER_TOKEN=... [KEEL_QUALIFICATION_HMAC_KEY=...] \
 *   node tools/qualification/teamsLive.mjs capture --confirm-live-tenant-write \
 *        --tenant-ref sha256:... --directory-tenant-id <guid> \
 *        --fixture-team-id <guid of the KEEL-RT-* team> --fixture-member-user-id <guid of the fixture user> \
 *        --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
 *        --grants grants.json --docs docs.json \
 *        --sharepoint-evidence docs/release/qualifications/sharepoint-live-acceptance.json \
 *        --out docs/release/qualifications/teams-live-acceptance.json [--build <sha>]
 *
 * Before anything is sent, the task-120 SharePoint record must verify with
 * --require-live for the same tenant and build, and sit beside --out: Teams is
 * qualified only after SharePoint, and SharePoint proof is never Teams proof.
 *
 * What a capture does, in order (and nothing else):
 *  1. collector: GET /teams (all pages; only the count is kept), to find the fixture
 *     team, whose display name must start with KEEL-RT-;
 *  2. collector: GET /teams/{fixture}, /teams/{fixture}/members,
 *     /groups/{fixture}/members and /groups/{fixture}/owners;
 *  3. restorer: GET /teams/{fixture}; PATCH funSettings with allowCustomMemes set to
 *     the other value; read it back; PATCH the original funSettings back; read back;
 *  4. restorer: POST the fixture user as a member; read back; PATCH its roles to
 *     owner; read back; PATCH its roles back to member; read back; DELETE it; read
 *     back. Then read the roster, the group's owners and its members until the user
 *     is absent from all three (polled for about 3 minutes, since the roster can lag
 *     a removal by a minute or more), wait a settle delay, and read them once more;
 *     whenever a read shows the fixture user as an owner of the team's group (the
 *     promotion creates that link asynchronously), DELETE that owner link, and if the
 *     last read is not clean, repeat (at most 3 rounds). Only the last read decides
 *     whether membership was restored.
 * Every request is checked against the task-104 Teams request shapes before it is
 * sent. Only the fixture team, its group and the fixture user are addressed; no
 * message, chat, channel, tab or file endpoint is ever requested. Step 3 changes a
 * TEAM-scoped setting only. Step 4 adds and removes one membership of the fixture
 * team. No tenant-wide setting is touched.
 *
 * Tokens come from the environment and are never written. The record carries
 * credential references only. With KEEL_QUALIFICATION_HMAC_KEY set the record is
 * signed as `keel-release-runner`; without it the record cannot verify.
 *
 * ledgerEvidenceFromTeamsAcceptance() is the import seam: a record that passes
 * `verify --require-live` becomes task-101 read evidence for the four Teams reads and
 * one live write capture per Teams write. Anything less becomes nothing.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readGraphConfiguration } from '../../engine/collect/workloadContract.mjs';
import { TEAM_SETTING_FIELDS, assertTeamsRequest, normalizeMember } from '../../engine/collect/workloads/teams.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../engine/coverage/qualification.mjs';
import { membersFingerprint, teamSettingsFingerprint } from '../../engine/restore/workloads/teams.mjs';
import { QUALIFICATION_CONTRACT_VERSION, signEvidence, verifyEvidence } from '../release/qualification.mjs';
import { SHAREPOINT_LIVE_GATE } from './sharepointAcceptance.mjs';
import {
  TEAMS_FIXTURE_PREFIX, TEAMS_LIVE_CREDENTIAL_MODE, TEAMS_LIVE_GATE, TEAMS_LIVE_MEMBER_WRITES, TEAMS_LIVE_OPERATION,
  TEAMS_LIVE_PREREQUISITES, TEAMS_LIVE_READS, TEAMS_LIVE_SETTINGS_WRITE, teamsReadDescriptor,
} from './teamsAcceptance.mjs';

const GRAPH = 'https://graph.microsoft.com';
const VERSION = 'v1.0';
export const TEAMS_TOGGLE_GROUP = 'funSettings';
export const TEAMS_TOGGLE_PROPERTY = 'allowCustomMemes';
const MEMBER_TYPE = '#microsoft.graph.aadUserConversationMember';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITE_THROTTLE_MAX_ATTEMPTS = 3;

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const sameRoles = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

/** Refuses anything but a team id and a fixture user id that are GUIDs. */
export function teamsFixtureProblems({ fixtureTeamId, fixtureMemberUserId }) {
  const problems = [];
  if (typeof fixtureTeamId !== 'string' || !GUID_RE.test(fixtureTeamId)) problems.push('--fixture-team-id must be the KEEL-RT team id (a GUID)');
  if (typeof fixtureMemberUserId !== 'string' || !GUID_RE.test(fixtureMemberUserId)) problems.push('--fixture-member-user-id must be the fixture user id (a GUID)');
  return problems;
}

/** Offline: the requests a capture would send, in order. */
export function teamsCapturePlan({ fixtureTeamId, fixtureMemberUserId }) {
  const problems = teamsFixtureProblems({ fixtureTeamId, fixtureMemberUserId });
  if (problems.length) throw new Error(problems.join('; '));
  const team = `/v1.0/teams/${fixtureTeamId.toLowerCase()}`;
  const user = fixtureMemberUserId.toLowerCase();
  return [
    { step: 1, credential: 'collector', method: 'GET', path: '/v1.0/teams (all pages; count only)', operationId: 'teams.team-discovery' },
    { step: 2, credential: 'collector', method: 'GET', path: team, operationId: 'teams.settings' },
    { step: 2, credential: 'collector', method: 'GET', path: `${team}/members`, operationId: 'teams.membership' },
    { step: 2, credential: 'collector', method: 'GET', path: `/v1.0/groups/${fixtureTeamId.toLowerCase()}/members`, operationId: 'teams.group-membership' },
    { step: 2, credential: 'collector', method: 'GET', path: `/v1.0/groups/${fixtureTeamId.toLowerCase()}/owners`, operationId: 'teams.group-membership' },
    { step: 3, credential: 'restorer', method: 'GET', path: team, operationId: TEAMS_LIVE_SETTINGS_WRITE },
    { step: 3, credential: 'restorer', method: 'PATCH', path: `${team} { ${TEAMS_TOGGLE_GROUP}.${TEAMS_TOGGLE_PROPERTY}: <other value> } (this team only)`, operationId: TEAMS_LIVE_SETTINGS_WRITE },
    { step: 3, credential: 'restorer', method: 'GET', path: `${team} (read back)`, operationId: TEAMS_LIVE_SETTINGS_WRITE },
    { step: 3, credential: 'restorer', method: 'PATCH', path: `${team} { ${TEAMS_TOGGLE_GROUP}: <original> }`, operationId: TEAMS_LIVE_SETTINGS_WRITE },
    { step: 3, credential: 'restorer', method: 'GET', path: `${team} (read back)`, operationId: TEAMS_LIVE_SETTINGS_WRITE },
    { step: 4, credential: 'restorer', method: 'POST', path: `${team}/members { user ${user}, roles: [] }`, operationId: 'teams.membership.add' },
    { step: 4, credential: 'restorer', method: 'GET', path: `${team}/members (read back)`, operationId: 'teams.membership.add' },
    { step: 4, credential: 'restorer', method: 'PATCH', path: `${team}/members/{fixture membership} { roles: [owner] }`, operationId: 'teams.membership.update' },
    { step: 4, credential: 'restorer', method: 'GET', path: `${team}/members (read back)`, operationId: 'teams.membership.update' },
    { step: 4, credential: 'restorer', method: 'PATCH', path: `${team}/members/{fixture membership} { roles: [] }`, operationId: 'teams.membership.update' },
    { step: 4, credential: 'restorer', method: 'GET', path: `${team}/members (read back)`, operationId: 'teams.membership.update' },
    { step: 4, credential: 'restorer', method: 'DELETE', path: `${team}/members/{fixture membership}`, operationId: 'teams.membership.remove' },
    { step: 4, credential: 'restorer', method: 'GET', path: `${team}/members (read back)`, operationId: 'teams.membership.remove' },
    { step: 4, credential: 'restorer', method: 'DELETE', path: `/v1.0/groups/${fixtureTeamId.toLowerCase()}/owners/${user}/$ref (whenever a read shows the owner link)`, operationId: 'teams.membership.remove' },
    { step: 4, credential: 'collector', method: 'GET', path: `${team}/members (restorer), /v1.0/groups/${fixtureTeamId.toLowerCase()}/owners and /members (until absent, then again after a settle delay)`, operationId: 'teams.membership.remove' },
  ];
}

/**
 * Runs a capture against two injected transports (collector, restorer), each
 * `(url, init?) => { status, headers, body }`. Returns the unsigned record and the
 * raw capture log; it never signs and never writes files.
 */
export async function captureTeamsAcceptance({
  collector, restorer, directoryTenantId, fixtureTeamId, fixtureMemberUserId, tenantRef, build, credentials, grants,
  sharePointQualification, credentialTenants = {}, documentation = [], now = () => new Date(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  readBackAttempts = 5, readBackDelayMs = 2000, settleDelayMs = 20000, restoreReadAttempts = 37, restoreReadDelayMs = 5000,
}) {
  const problems = teamsFixtureProblems({ fixtureTeamId, fixtureMemberUserId });
  if (typeof directoryTenantId !== 'string' || !GUID_RE.test(directoryTenantId)) problems.push('--directory-tenant-id must be the managed tenant id (a GUID)');
  if (problems.length) throw new Error(problems.join('; '));
  if (!tenantRef || !build) throw new Error('a capture needs --tenant-ref and a build');
  if (!credentials?.collector || !credentials?.restorer || credentials.collector === credentials.restorer) {
    throw new Error('a capture needs two separate credential references (collector, restorer)');
  }
  if (sharePointQualification?.gate !== SHAREPOINT_LIVE_GATE || !sharePointQualification.captureLogSha256) {
    throw new Error('a capture needs the verified task-120 SharePoint record: Teams is qualified only after SharePoint');
  }
  const tenant = directoryTenantId.toLowerCase();
  // The tenant each token was issued for (its `tid`), when known. A token for another
  // tenant is refused before any request.
  const tokenTenant = (role) => (typeof credentialTenants[role] === 'string' ? credentialTenants[role].toLowerCase() : null);
  for (const role of ['collector', 'restorer']) {
    if (tokenTenant(role) && tokenTenant(role) !== tenant) throw new Error(`the ${role} token was issued for another tenant; nothing was sent`);
  }
  const teamId = fixtureTeamId.toLowerCase();
  const userId = fixtureMemberUserId.toLowerCase();

  const requests = [];
  const log = { requests, values: {} };
  let retryAfterResponses = 0;
  const logged = (credential, transport) => async (url, init) => {
    const method = init?.method ?? 'GET';
    assertTeamsRequest(url, method);
    const parsed = new URL(url);
    const [, version, ...rest] = parsed.pathname.split('/');
    const response = await transport(url, init);
    if (response.status === 429 || response.status === 503) retryAfterResponses += 1;
    const entry = { credential, method, version, path: `/${rest.join('/')}${parsed.search}`, status: response.status, at: now().toISOString() };
    if (method === 'POST') entry.memberUserId = init?.memberUserId ?? null;
    requests.push(entry);
    return response;
  };
  const asCollector = logged('collector', collector);
  const asRestorer = logged('restorer', restorer);

  const reads = [];
  const read = async (id, substitute = {}) => {
    const descriptor = teamsReadDescriptor(id);
    try {
      const { items, observed } = await readGraphConfiguration(descriptor, { transport: asCollector, sleep, substitute });
      reads.push({ operationId: id, version: descriptor.operation.version, capturedAt: now().toISOString(), ok: true, synthetic: false, pages: observed.pages, items: items.length });
      return items;
    } catch (error) {
      reads.push({ operationId: id, version: descriptor.operation.version, capturedAt: now().toISOString(), ok: false, synthetic: false, error: error.message });
      return null;
    }
  };

  const discovered = (await read('teams.team-discovery')) ?? [];
  log.values.discoveredTeams = discovered.length;
  const listed = discovered.find((team) => String(team?.id ?? '').toLowerCase() === teamId) ?? null;
  let fixtureTeam = { id: teamId, displayName: listed?.displayName ?? null, tenantId: null };
  let startMembers = null;
  let startGroupMembers = null;
  let startOwners = null;
  let refusal = null;
  if (!listed) refusal = 'the fixture team was not discovered; nothing was written';
  else if (typeof listed.displayName !== 'string' || !listed.displayName.startsWith(TEAMS_FIXTURE_PREFIX)) {
    refusal = `the fixture team is not a disposable ${TEAMS_FIXTURE_PREFIX}* team; nothing was read further or written`;
  } else {
    const [body] = (await read('teams.settings', { 'team-id': teamId })) ?? [];
    // Graph v1.0 often omits a team's tenantId for app-only callers. A tenantId Graph
    // reports must be the managed tenant's; when it reports none, the team's tenant is
    // the tenant of the collector token that read it (only that tenant's teams are visible).
    const reported = typeof body?.tenantId === 'string' && body.tenantId ? body.tenantId.toLowerCase() : null;
    const teamTenant = reported ?? tokenTenant('collector');
    fixtureTeam = {
      id: teamId, displayName: body?.displayName ?? listed.displayName, tenantId: teamTenant,
      tenantIdSource: reported ? 'team' : (teamTenant ? 'collector-token' : null),
    };
    if (body && reported && reported !== tenant) refusal = 'the fixture team belongs to another tenant; nothing was written';
    else if (body && !teamTenant) refusal = 'Graph did not report the fixture team\'s tenant and the collector token\'s tenant is unknown; nothing was written';
    else {
      log.values.supportedFields = body ? TEAM_SETTING_FIELDS.filter((field) => Object.hasOwn(body, field)) : [];
      startMembers = await read('teams.membership', { 'team-id': teamId });
      startGroupMembers = await read('teams.group-membership', { 'group-id': teamId });
      try {
        startOwners = await teamsReadGroupOwners(asCollector, teamId);
      } catch (error) {
        refusal = `the fixture group's owners could not be read (${error.message}); nothing was written`;
      }
    }
  }
  const supportedFields = log.values.supportedFields ?? [];
  const readsOk = !refusal && reads.length === TEAMS_LIVE_READS.length && reads.every((item) => item.ok);
  const memberBefore = startMembers ? startMembers.map(normalizeMember).some((member) => member.userId === userId) : null;
  if (!refusal && !readsOk) refusal = 'a read failed; nothing was written';
  const ownerBefore = startOwners ? startOwners.includes(userId) : null;
  const groupMemberBefore = startGroupMembers ? startGroupMembers.some((member) => String(member?.id ?? '').toLowerCase() === userId) : null;
  if (!refusal && memberBefore) refusal = 'the fixture user is already a member of the fixture team; remove it first; nothing was written';
  if (!refusal && ownerBefore) refusal = 'the fixture user is already an owner of the fixture group; remove it first; nothing was written';
  if (!refusal && groupMemberBefore) refusal = 'the fixture user is already a member of the fixture group; remove it first; nothing was written';
  if (!refusal && !startMembers.map(normalizeMember).some((member) => member.roles.includes('owner') && member.userId !== userId)) {
    refusal = 'the fixture team has no owner besides the fixture user; nothing was written';
  }

  const settingsWrite = {
    operationId: TEAMS_LIVE_SETTINGS_WRITE, version: WORKLOAD_WRITE_OPERATIONS[TEAMS_LIVE_SETTINGS_WRITE].version, synthetic: false,
    writeMode: 'reversible-change', group: TEAMS_TOGGLE_GROUP, property: TEAMS_TOGGLE_PROPERTY,
    ok: false, readBackVerified: false, restoredToOriginal: false, preFingerprint: null, finalFingerprint: null,
  };
  const membership = {
    captures: [], restoredToOriginal: false, preFingerprint: null, finalFingerprint: null,
    ownersPreFingerprint: startOwners ? ownersFingerprint(startOwners) : null, ownersFinalFingerprint: null, ownerLinkRemoved: false,
  };
  const fixtureMember = {
    userId, tenantId: null, membershipId: null, memberBefore, memberAfter: null, ownerBefore, ownerAfter: null, groupMemberBefore, groupMemberAfter: null,
  };
  const timing = {
    sleep, attempts: readBackAttempts, delayMs: readBackDelayMs, settleMs: settleDelayMs,
    restoreAttempts: restoreReadAttempts, restoreDelayMs: restoreReadDelayMs,
  };
  if (refusal) {
    settingsWrite.error = refusal;
    membership.error = refusal;
  } else {
    await teamsToggleAndRestore({ transport: asRestorer, teamId, capture: settingsWrite, log, timing });
    settingsWrite.capturedAt = now().toISOString();
    await teamsMembershipRoundTrip({ transport: asRestorer, reader: asCollector, teamId, userId, membership, fixtureMember, log, timing, now });
  }
  settingsWrite.capturedAt ??= now().toISOString();

  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: TEAMS_LIVE_GATE,
    tenantRef,
    build,
    operation: TEAMS_LIVE_OPERATION,
    credentialMode: TEAMS_LIVE_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      prerequisites: [...TEAMS_LIVE_PREREQUISITES],
      sharePointQualification: { gate: SHAREPOINT_LIVE_GATE, evidence: sharePointQualification.evidence, captureLogSha256: sharePointQualification.captureLogSha256 },
      directoryTenantId: tenant,
      fixtureTeam,
      fixtureMember,
      credentials: { collector: credentials.collector, restorer: credentials.restorer },
      grants,
      reads,
      supportedFields,
      settingsWrite,
      membershipWrites: membership,
      requests: requests.map(({ at, ...request }) => request),
      throttle: { retryAfterResponses },
      documentation,
      captureLogSha256: sha256Hex(captureLog),
    },
  };
  const needsManualRevert = (log.values.settingsWritten === true && settingsWrite.restoredToOriginal !== true)
    || (log.values.memberAdded === true && membership.restoredToOriginal !== true);
  return { record, captureLog, needsManualRevert };
}

/** Sends one write; a throttled (429/503) write was not applied and is resent after Retry-After. */
async function teamsSendWrite(transport, url, init, sleep) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await transport(url, init);
    if ((response.status !== 429 && response.status !== 503) || attempt >= WRITE_THROTTLE_MAX_ATTEMPTS) return response;
    const seconds = Number(response.headers?.['retry-after']);
    await sleep(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempt * 1000);
  }
}

const ok = (response) => response.status >= 200 && response.status < 300;

async function teamsReadTeam(transport, teamId, sleep) {
  const { items: [body = {}] } = await readGraphConfiguration(teamsReadDescriptor('teams.settings'), { transport, sleep, substitute: { 'team-id': teamId } });
  return body;
}

async function teamsReadMembers(transport, teamId, sleep) {
  const { items } = await readGraphConfiguration(teamsReadDescriptor('teams.membership'), { transport, sleep, substitute: { 'team-id': teamId } });
  return items;
}

/** Every id on one page-followed group listing (owners or members), lower-cased. */
async function teamsReadGroupList(transport, teamId, list) {
  const ids = [];
  let url = `${GRAPH}/${VERSION}/groups/${teamId}/${list}`;
  for (let page = 0; url; page += 1) {
    if (page >= 50) throw new Error(`the group's ${list} did not finish paging`);
    const response = await transport(url);
    if (!ok(response)) throw new Error(`GET /groups/${teamId}/${list} failed (HTTP ${response.status})`);
    for (const item of response.body?.value ?? []) ids.push(String(item?.id ?? '').toLowerCase());
    url = response.body?.['@odata.nextLink'] ?? null;
  }
  return ids;
}

const teamsReadGroupOwners = (transport, teamId) => teamsReadGroupList(transport, teamId, 'owners');
const teamsReadGroupMembers = (transport, teamId) => teamsReadGroupList(transport, teamId, 'members');
const ownersFingerprint = (ids) => sha256Hex(JSON.stringify([...ids].sort()));

// Settle rounds for the membership restore: the group owner link can reappear after
// the settle delay, so the restore re-checks (and re-deletes) at most this many times.
const TEAMS_RESTORE_ROUNDS = 3;

// The Teams roster can lag a removal by a minute or more (2026-10-04: ~60-90 s), so
// removal read-backs poll over a longer window than other read-backs.
const restoreTiming = ({ sleep, restoreAttempts, restoreDelayMs }) => ({ sleep, attempts: restoreAttempts, delayMs: restoreDelayMs });

async function teamsReadUntil(readOnce, matches, { sleep, attempts, delayMs }) {
  let body = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await sleep(delayMs);
    body = await readOnce();
    if (matches(body)) return { body, matched: true };
  }
  return { body, matched: false };
}

async function teamsToggleAndRestore({ transport, teamId, capture, log, timing }) {
  const url = `${GRAPH}/${VERSION}/teams/${teamId}`;
  const readTeam = () => teamsReadTeam(transport, teamId, timing.sleep);
  try {
    const before = await readTeam();
    capture.preFingerprint = teamSettingsFingerprint(before);
    const group = before[TEAMS_TOGGLE_GROUP];
    const original = group?.[TEAMS_TOGGLE_PROPERTY];
    log.values.originalToggle = original;
    if (typeof original !== 'boolean') { capture.error = `${TEAMS_TOGGLE_GROUP}.${TEAMS_TOGGLE_PROPERTY} is not a boolean; nothing was written`; return; }
    const changed = await teamsSendWrite(transport, url, { method: 'PATCH', body: { [TEAMS_TOGGLE_GROUP]: { ...group, [TEAMS_TOGGLE_PROPERTY]: !original } } }, timing.sleep);
    if (!ok(changed)) { capture.error = `the write failed (HTTP ${changed.status})`; return; }
    log.values.settingsWritten = true;
    const seen = await teamsReadUntil(readTeam, (body) => body?.[TEAMS_TOGGLE_GROUP]?.[TEAMS_TOGGLE_PROPERTY] === !original, timing);
    capture.readBackVerified = seen.matched;
    // Always put the setting back once a write was accepted, whatever the read-back said.
    const reverted = await teamsSendWrite(transport, url, { method: 'PATCH', body: { [TEAMS_TOGGLE_GROUP]: group } }, timing.sleep);
    const restored = ok(reverted)
      ? await teamsReadUntil(readTeam, (body) => body?.[TEAMS_TOGGLE_GROUP]?.[TEAMS_TOGGLE_PROPERTY] === original, timing)
      : { body: await readTeam(), matched: false };
    capture.restoredToOriginal = ok(reverted) && restored.matched;
    capture.finalFingerprint = teamSettingsFingerprint(restored.body);
    capture.ok = ok(reverted);
    if (!ok(reverted)) capture.error = `PUTTING THE SETTING BACK FAILED (HTTP ${reverted.status}): set ${TEAMS_TOGGLE_GROUP}.${TEAMS_TOGGLE_PROPERTY} to ${original} on the fixture team by hand`;
  } catch (error) {
    capture.error = error.message;
  }
}

async function teamsMembershipRoundTrip({ transport, reader, teamId, userId, membership, fixtureMember, log, timing, now }) {
  const base = `${GRAPH}/${VERSION}/teams/${teamId}/members`;
  const readMembers = () => teamsReadMembers(transport, teamId, timing.sleep);
  const find = (members) => (members ?? []).map(normalizeMember).find((member) => member.userId === userId) ?? null;
  const capture = (operationId) => {
    const entry = { operationId, version: WORKLOAD_WRITE_OPERATIONS[operationId].version, synthetic: false, ok: false, readBackVerified: false };
    membership.captures.push(entry);
    return entry;
  };
  let removed = false;
  try {
    membership.preFingerprint = membersFingerprint(await readMembers());

    const add = capture('teams.membership.add');
    const added = await teamsSendWrite(transport, base, {
      method: 'POST', memberUserId: userId,
      body: { '@odata.type': MEMBER_TYPE, roles: [], 'user@odata.bind': `${GRAPH}/${VERSION}/users('${userId}')` },
    }, timing.sleep);
    add.capturedAt = now().toISOString();
    if (!ok(added)) { add.error = `the add failed (HTTP ${added.status})`; return; }
    log.values.memberAdded = true;
    add.ok = true;
    const present = await teamsReadUntil(readMembers, (members) => sameRoles(find(members)?.roles, []), timing);
    add.readBackVerified = present.matched;
    const member = find(present.body);
    fixtureMember.tenantId = member?.tenantId ?? null;
    fixtureMember.membershipId = member?.membershipId ?? null;
    if (!member?.membershipId || !/^[A-Za-z0-9=+_-]+$/.test(member.membershipId)) { add.error = 'the added membership was not read back with an addressable id'; return; }
    const memberUrl = `${base}/${member.membershipId}`;

    const update = capture('teams.membership.update');
    let updateOk = true;
    let updateVerified = true;
    for (const roles of [['owner'], []]) {
      const response = await teamsSendWrite(transport, memberUrl, { method: 'PATCH', body: { '@odata.type': MEMBER_TYPE, roles } }, timing.sleep);
      if (!ok(response)) { updateOk = false; update.error = `the role change to [${roles.join(',')}] failed (HTTP ${response.status})`; break; }
      const seen = await teamsReadUntil(readMembers, (members) => sameRoles(find(members)?.roles, roles), timing);
      updateVerified &&= seen.matched;
    }
    update.ok = updateOk;
    update.readBackVerified = updateOk && updateVerified;
    update.capturedAt = now().toISOString();

    const remove = capture('teams.membership.remove');
    const deleted = await teamsSendWrite(transport, memberUrl, { method: 'DELETE' }, timing.sleep);
    remove.capturedAt = now().toISOString();
    removed = true;
    if (!ok(deleted)) { remove.error = `REMOVING THE FIXTURE USER FAILED (HTTP ${deleted.status}): remove ${userId} from the fixture team by hand`; return; }
    remove.ok = true;
    const gone = await teamsReadUntil(readMembers, (members) => find(members) === null, restoreTiming(timing));
    remove.readBackVerified = gone.matched;
  } catch (error) {
    membership.error = error.message;
  } finally {
    // Once the add was accepted the fixture user is always removed, whatever failed in between.
    if (log.values.memberAdded === true && !removed && fixtureMember.membershipId) {
      try { await teamsSendWrite(transport, `${base}/${fixtureMember.membershipId}`, { method: 'DELETE' }, timing.sleep); } catch { /* reported below */ }
    }
    // The group's owners and members are read by the collector; only the restorer writes.
    // Promoting to owner also makes the user an owner of the team's group, and demoting
    // and removing the Teams membership can leave that link behind; Teams later re-adds
    // the user from it. The link is created asynchronously, sometimes after the removal
    // (2026-10-05: the DELETE returned 404, then the link appeared), so every read of the
    // group's owners that shows the user re-issues the owner-link DELETE (404 = not there
    // yet). The restore holds once the user is absent from the Teams roster, the group's
    // owners and the group's members, and still absent after a settle delay; if the link
    // reappears during the settle delay, the round repeats (at most TEAMS_RESTORE_ROUNDS).
    if (log.values.memberAdded === true) {
      try {
        const unlinkOwner = async () => {
          const unlinked = await teamsSendWrite(transport, `${GRAPH}/${VERSION}/groups/${teamId}/owners/${userId}/$ref`, { method: 'DELETE' }, timing.sleep);
          if (ok(unlinked)) membership.ownerLinkRemoved = true;
          else if (unlinked.status !== 404) membership.error ??= `removing the fixture user's group owner link failed (HTTP ${unlinked.status})`;
        };
        const readAll = async () => {
          const state = {
            members: await readMembers(),
            owners: await teamsReadGroupOwners(reader, teamId),
            groupMembers: await teamsReadGroupMembers(reader, teamId),
          };
          if (state.owners.includes(userId)) await unlinkOwner();
          return state;
        };
        const absent = (state) => find(state.members) === null && !state.owners.includes(userId) && !state.groupMembers.includes(userId);
        let final = null;
        for (let round = 0; round < TEAMS_RESTORE_ROUNDS; round += 1) {
          await teamsReadUntil(readAll, absent, restoreTiming(timing));
          if (timing.settleMs) await timing.sleep(timing.settleMs);
          final = await readAll();
          if (absent(final)) break;
        }
        fixtureMember.memberAfter = find(final.members) !== null;
        fixtureMember.ownerAfter = final.owners.includes(userId);
        fixtureMember.groupMemberAfter = final.groupMembers.includes(userId);
        membership.finalFingerprint = membersFingerprint(final.members);
        membership.ownersFinalFingerprint = ownersFingerprint(final.owners);
        membership.restoredToOriginal = absent(final)
          && membership.ownersFinalFingerprint === membership.ownersPreFingerprint;
      } catch (error) {
        membership.error ??= `the final membership read failed: ${error.message}`;
      }
    }
    if (log.values.memberAdded === true && membership.restoredToOriginal !== true) {
      membership.error = `THE FIXTURE USER MAY STILL BE A MEMBER OR OWNER: remove ${userId} from the fixture team, and from the owners and members of group ${teamId}, by hand`;
    }
  }
}

/**
 * Writes the record and its capture log side by side, binding the log's digest as
 * the artifact proof, and signs the record when a runner key is given.
 */
export function writeTeamsAcceptanceFiles({ record, captureLog, outPath, hmacKey = null }) {
  const logPath = outPath.replace(/\.json$/, '') + '.capture.json';
  writeFileSync(logPath, captureLog);
  let evidence = { ...record, proof: { artifact: { path: basename(logPath), sha256: sha256Hex(captureLog) } } };
  if (hmacKey) evidence = signEvidence(evidence, hmacKey, 'keel-release-runner');
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { evidence, logPath };
}

/**
 * The import seam: a record that passes the gate with --require-live becomes
 * task-101 read evidence for the four Teams reads, one live write capture per Teams
 * write (for workloadWriteQualification) and the collector's grants. Anything else
 * yields none. SharePoint evidence is imported only by its own seam.
 */
export function ledgerEvidenceFromTeamsAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: TEAMS_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, reads: [], writes: [], grants: null };
  const { subject, tenantRef } = evidence;
  const proofRef = `${TEAMS_LIVE_GATE}@${subject.captureLogSha256}`;
  const write = (item) => ({
    operationId: item.operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
    version: item.version, ok: item.ok === true, readBackVerified: item.readBackVerified === true, proofRef,
  });
  return {
    ok: true,
    failures: [],
    reads: subject.reads.map((item) => ({
      operationId: item.operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: item.ok === true, error: null, observed: { pages: item.pages ?? null }, proofRef,
    })),
    writes: [subject.settingsWrite, ...TEAMS_LIVE_MEMBER_WRITES.map((id) => subject.membershipWrites.captures.find((item) => item.operationId === id))].map(write),
    grants: { permissions: [...subject.grants.collector.permissions], roles: [...subject.grants.collector.roles] },
  };
}

/**
 * The tenant a Graph access token was issued for: its `tid` claim, or null. Only the
 * payload is decoded; the token itself is never logged or returned.
 */
export function tokenTenantId(token) {
  try {
    const [, payload] = String(token).split('.');
    const tid = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.tid;
    return typeof tid === 'string' && GUID_RE.test(tid) ? tid.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** A fetch-backed transport for one bearer token. The token never leaves this closure. */
export function teamsBearerTransport(token, fetchImpl = globalThis.fetch) {
  return async (url, init) => {
    const response = await fetchImpl(url, {
      method: init?.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
  };
}

function parseTeamsArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, confirm: false };
  const names = {
    '--tenant-ref': 'tenantRef', '--directory-tenant-id': 'directoryTenantId', '--fixture-team-id': 'fixtureTeamId',
    '--fixture-member-user-id': 'fixtureMemberUserId', '--collector-ref': 'collectorRef', '--restorer-ref': 'restorerRef',
    '--grants': 'grants', '--docs': 'docs', '--out': 'out', '--build': 'build', '--sharepoint-evidence': 'sharepointEvidence',
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--confirm-live-tenant-write') options.confirm = true;
    else if (names[arg]) options[names[arg]] = rest[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), { out = console.log, env = process.env, transportFor = teamsBearerTransport, readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  const options = parseTeamsArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(teamsCapturePlan(options), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: teamsLive.mjs plan|capture ...');
  if (!options.confirm) {
    out(JSON.stringify(teamsCapturePlan(options), null, 2));
    out('refused: a capture writes the fixture team\'s settings and membership; rerun with --confirm-live-tenant-write');
    return 2;
  }
  for (const [flag, key] of [
    ['--tenant-ref', 'tenantRef'], ['--directory-tenant-id', 'directoryTenantId'], ['--collector-ref', 'collectorRef'], ['--restorer-ref', 'restorerRef'],
    ['--grants', 'grants'], ['--docs', 'docs'], ['--sharepoint-evidence', 'sharepointEvidence'], ['--out', 'out'],
  ]) {
    if (!options[key]) throw new Error(`capture needs ${flag}`);
  }
  if (!env.KEEL_TEAMS_COLLECTOR_TOKEN || !env.KEEL_TEAMS_RESTORER_TOKEN) {
    throw new Error('capture needs KEEL_TEAMS_COLLECTOR_TOKEN and KEEL_TEAMS_RESTORER_TOKEN in the environment');
  }
  const build = options.build ?? env.KEEL_QUALIFICATION_BUILD;
  if (!build) throw new Error('capture needs --build (or KEEL_QUALIFICATION_BUILD): the build this capture qualifies');
  const outPath = resolve(options.out);
  const sharePointPath = resolve(options.sharepointEvidence);
  if (dirname(sharePointPath) !== dirname(outPath)) throw new Error('the SharePoint record must sit beside --out, where the verifier reads it');
  // Teams follows SharePoint: refuse before any request unless the task-120 record verifies.
  const sharePoint = JSON.parse(readFile(sharePointPath));
  const sharePointResult = verifyEvidence(sharePoint, {
    gate: SHAREPOINT_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(sharePointPath),
  });
  if (!sharePointResult.ok) {
    out(JSON.stringify({ refused: 'the task-120 SharePoint record does not verify; Teams is qualified only after SharePoint', failures: sharePointResult.failures }, null, 2));
    return 2;
  }
  const { record, captureLog, needsManualRevert } = await captureTeamsAcceptance({
    collector: transportFor(env.KEEL_TEAMS_COLLECTOR_TOKEN),
    restorer: transportFor(env.KEEL_TEAMS_RESTORER_TOKEN),
    directoryTenantId: options.directoryTenantId,
    fixtureTeamId: options.fixtureTeamId,
    fixtureMemberUserId: options.fixtureMemberUserId,
    tenantRef: options.tenantRef,
    build,
    credentials: { collector: options.collectorRef, restorer: options.restorerRef },
    grants: JSON.parse(readFile(options.grants)),
    documentation: JSON.parse(readFile(options.docs)),
    sharePointQualification: { gate: SHAREPOINT_LIVE_GATE, evidence: basename(sharePointPath), captureLogSha256: sharePoint.subject.captureLogSha256 },
    credentialTenants: { collector: tokenTenantId(env.KEEL_TEAMS_COLLECTOR_TOKEN), restorer: tokenTenantId(env.KEEL_TEAMS_RESTORER_TOKEN) },
  });
  const { evidence, logPath } = writeTeamsAcceptanceFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, { gate: TEAMS_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath) });
  out(JSON.stringify({
    evidence: outPath, captureLog: logPath, settingsWrite: record.subject.settingsWrite, membershipWrites: record.subject.membershipWrites, verify: result,
  }, null, 2));
  // 3: the fixture team may not be back where it started; the output says what to fix by hand.
  if (needsManualRevert) return 3;
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
