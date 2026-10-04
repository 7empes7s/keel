/**
 * Roadmap task-121: the Teams configuration workload live-acceptance gate.
 *
 * This is the evidence contract and its gate validator. It is registered in
 * tools/release/qualification.mjs (GATE_VALIDATORS) and checks the `subject` of
 * a record captured by tools/qualification/teamsLive.mjs against the production
 * declarations it qualifies:
 *  - the task-104 reads (teams.team-discovery, teams.settings, teams.membership,
 *    teams.group-membership) at the API version KEEL calls now;
 *  - the task-104 writes: teams.settings.update and the three structural membership
 *    writes (teams.membership.add, .update, .remove), each with its own capture.
 *
 * What a passing subject proves, beyond the generic verifier (signature, capture
 * log digest, gate, tenant, freshness, --require-live):
 *  - identity: operation, build, credential mode, two distinct credential references
 *    (the collector reads, the restorer writes; the collector holds no write
 *    permission), and the directory tenant the fixture team belongs to;
 *  - prerequisites: tasks 104 and 120 are named; the Teams declarations exist in
 *    this build; and the task-120 SharePoint record it names verifies on its own,
 *    for the same tenant and build. SharePoint proof is a prerequisite, never Teams
 *    proof: every Teams operation needs its own capture in this record, and the
 *    SharePoint record's log can never stand in for this one;
 *  - fixture: one disposable `KEEL-RT-*` team in the managed tenant, and one
 *    membership fixture user from the same tenant who was not a member before the
 *    capture and is not one after it. No other team, group or user is addressed;
 *  - zero content calls: every logged request is re-checked against the task-104
 *    Teams request shapes and the task-101 scope validator, and every write is the
 *    restorer's, on the fixture team, in the expected number;
 *  - guarded post-state: a supported setting was changed, read back, put back; the
 *    fixture user was added, promoted, demoted and removed, each read back; the
 *    final settings and membership match the starting fingerprints;
 *  - paging and throttle behaviour and documentation retrieval are recorded;
 *  - no credential material anywhere in the record.
 *
 * It never sends a request and never enables anything. A verified record is turned
 * into ledger evidence only by tools/qualification/teamsLive.mjs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WORKLOAD_DESCRIPTORS, scopeProblems } from '../../engine/collect/workloadContract.mjs';
import { TEAMS_OPERATIONS, TEAM_SETTING_FIELDS, assertTeamsRequest } from '../../engine/collect/workloads/teams.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../engine/coverage/qualification.mjs';
import { SHAREPOINT_LIVE_GATE } from './sharepointAcceptance.mjs';

export const TEAMS_LIVE_GATE = 'teams-live-acceptance';
export const TEAMS_LIVE_OPERATION = 'teams.configuration-qualification';
export const TEAMS_LIVE_CREDENTIAL_MODE = 'collector-read+restorer-write';
export const TEAMS_LIVE_PREREQUISITES = Object.freeze(['task-104', 'task-120']);
export const TEAMS_LIVE_READS = TEAMS_OPERATIONS;
export const TEAMS_LIVE_SETTINGS_WRITE = 'teams.settings.update';
export const TEAMS_LIVE_MEMBER_WRITES = Object.freeze(['teams.membership.add', 'teams.membership.update', 'teams.membership.remove']);
export const TEAMS_LIVE_WRITES = Object.freeze([TEAMS_LIVE_SETTINGS_WRITE, ...TEAMS_LIVE_MEMBER_WRITES]);
export const TEAMS_FIXTURE_PREFIX = 'KEEL-RT-';
// Writes a capture sends, by operation: change then put back; add, promote, demote, remove.
export const TEAMS_EXPECTED_WRITES = Object.freeze({
  [TEAMS_LIVE_SETTINGS_WRITE]: 2, 'teams.membership.add': 1, 'teams.membership.update': 2, 'teams.membership.remove': 1,
});
// A capture belongs to the record it is in: no older than this before observedAt.
export const TEAMS_CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

const SECRET_KEY = /(token|secret|password|passwd|private.?key|bearer|authorization|cookie)/i;
const SECRET_VALUE = /^(eyJ[\w-]+\.[\w-]+\.|Bearer\s)|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export function teamsReadDescriptor(id) {
  return WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === id) ?? null;
}

/** The documentation every qualified Teams operation was declared from. */
export function teamsRequiredDocumentation() {
  const urls = TEAMS_LIVE_READS.map((id) => teamsReadDescriptor(id)?.source?.url);
  for (const id of TEAMS_LIVE_WRITES) urls.push(WORKLOAD_WRITE_OPERATIONS[id]?.source);
  return [...new Set(urls.filter(Boolean))];
}

/** The permissions and roles each credential must hold, from the production declarations. */
export function teamsRequiredGrants() {
  const collect = (ids, lookup) => {
    const permissions = new Set();
    const roles = new Set();
    for (const id of ids) {
      const rbac = lookup(id)?.rbac;
      for (const permission of rbac?.permissions ?? []) permissions.add(permission);
      for (const role of rbac?.roles ?? []) roles.add(role);
    }
    return { permissions: [...permissions].sort(), roles: [...roles].sort() };
  };
  return {
    collector: collect(TEAMS_LIVE_READS, teamsReadDescriptor),
    restorer: collect(TEAMS_LIVE_WRITES, (id) => WORKLOAD_WRITE_OPERATIONS[id]),
  };
}

/** Every key path in the record whose name or value looks like credential material. */
export function teamsSecretProblems(value, path = '$') {
  const problems = [];
  if (Array.isArray(value)) value.forEach((item, index) => problems.push(...teamsSecretProblems(item, `${path}[${index}]`)));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) problems.push(`${path}.${key} looks like credential material`);
      problems.push(...teamsSecretProblems(child, `${path}.${key}`));
    }
  } else if (typeof value === 'string' && SECRET_VALUE.test(value)) problems.push(`${path} holds credential material`);
  return problems;
}

function teamsCaptureTimeProblems(label, capturedAt, observedAt) {
  const at = Date.parse(capturedAt ?? '');
  if (Number.isNaN(at)) return [`${label}: no valid capture time`];
  if (Number.isNaN(observedAt)) return [];
  if (at > observedAt + CLOCK_SKEW_MS) return [`${label}: captured after the record was observed`];
  if (observedAt - at > TEAMS_CAPTURE_WINDOW_MS) return [`${label}: captured more than 24h before the record (stale capture)`];
  return [];
}

function teamsMissing(held, needed) {
  const have = new Set(Array.isArray(held) ? held : []);
  return needed.filter((item) => !have.has(item));
}

/** Which declared write a logged request is, or null. */
function teamsWriteFor(request, teamId) {
  const team = `/teams/${teamId}`;
  if (request.method === 'PATCH' && request.path === team) return TEAMS_LIVE_SETTINGS_WRITE;
  if (request.method === 'POST' && request.path === `${team}/members`) return 'teams.membership.add';
  if (request.method === 'PATCH' && request.path.startsWith(`${team}/members/`)) return 'teams.membership.update';
  if (request.method === 'DELETE' && request.path.startsWith(`${team}/members/`)) return 'teams.membership.remove';
  return null;
}

function teamsRequestProblems(requests, { teamId, member }) {
  const failures = [];
  if (!Array.isArray(requests) || requests.length === 0) return ['no request log recorded'];
  if (!teamId) return ['no fixture team id to check the request log against'];
  const team = `/teams/${teamId}`;
  const counts = Object.fromEntries(TEAMS_LIVE_WRITES.map((id) => [id, 0]));
  for (const [index, request] of requests.entries()) {
    const label = `request ${index} (${request?.method ?? '?'} ${request?.path ?? '?'})`;
    if (!['collector', 'restorer'].includes(request?.credential)) { failures.push(`${label}: unknown credential`); continue; }
    if (typeof request.path !== 'string' || !request.path.startsWith('/')) { failures.push(`${label}: no Graph path`); continue; }
    if (request.version !== 'v1.0') failures.push(`${label}: not the declared API version`);
    try {
      assertTeamsRequest(`https://graph.microsoft.com/${request.version}${request.path}`, request.method);
    } catch (error) {
      failures.push(`${label}: content call or undeclared shape: ${error.message}`);
      continue;
    }
    const [pathOnly] = request.path.split('?');
    const groupReads = [`/groups/${teamId}/members`, `/groups/${teamId}/owners`];
    const ownerLink = member?.userId ? `/groups/${teamId}/owners/${member.userId}/$ref` : null;
    if (pathOnly !== '/teams' && !pathOnly.startsWith(team) && !groupReads.includes(pathOnly) && pathOnly !== ownerLink) {
      failures.push(`${label}: addresses a team, group or user other than the KEEL-RT fixture`);
      continue;
    }
    if (request.method === 'GET') {
      const scope = scopeProblems({ kind: 'graph', method: 'GET', endpoint: request.path });
      if (scope.length) failures.push(`${label}: content call: ${scope.join('; ')}`);
      if (request.credential === 'restorer' && pathOnly !== team && pathOnly !== `${team}/members`) {
        failures.push(`${label}: the restorer reads only the team and members it writes`);
      }
      continue;
    }
    // Removing the fixture user's own group owner link is clean-up, not a qualified write.
    if (request.method === 'DELETE' && pathOnly === ownerLink) {
      if (request.credential !== 'restorer') failures.push(`${label}: only the restorer removes the fixture user's owner link`);
      continue;
    }
    const writeId = teamsWriteFor({ ...request, path: pathOnly }, teamId);
    if (!writeId || request.credential !== 'restorer') {
      failures.push(`${label}: not an allowed write (only the restorer writes the fixture team)`);
      continue;
    }
    // A throttled write was not applied; Retry-After resends it, so it is not counted.
    if (request.status === 429 || request.status === 503) continue;
    counts[writeId] += 1;
    if (writeId === 'teams.membership.add' && (typeof request.memberUserId !== 'string' || request.memberUserId.toLowerCase() !== member?.userId)) {
      failures.push(`${label}: adds a user other than the membership fixture`);
    }
    if (writeId !== 'teams.membership.add' && writeId !== TEAMS_LIVE_SETTINGS_WRITE) {
      const membershipId = pathOnly.slice(`${team}/members/`.length);
      if (!member?.membershipId || membershipId !== member.membershipId) failures.push(`${label}: addresses a membership other than the fixture user's`);
    }
  }
  for (const [id, expected] of Object.entries(TEAMS_EXPECTED_WRITES)) {
    if (counts[id] !== expected) failures.push(`expected exactly ${expected} ${id} write(s), found ${counts[id]}`);
  }
  return failures;
}

function teamsWriteCaptureProblems(capture, id, observedAt) {
  const failures = [];
  const declared = WORKLOAD_WRITE_OPERATIONS[id];
  if (!capture) return [`missing prerequisite: no live capture of ${id}`];
  if (capture.synthetic !== false) failures.push(`${id}: synthetic or unlabelled capture`);
  if (declared && capture.version !== declared.version) failures.push(`${id}: captured at ${capture.version ?? 'unknown'}, not ${declared.version}`);
  if (capture.ok !== true) failures.push(`${id}: the write failed`);
  if (capture.readBackVerified !== true) failures.push(`${id}: the change was not read back as written`);
  failures.push(...teamsCaptureTimeProblems(id, capture.capturedAt, observedAt));
  return failures;
}

/**
 * The task-120 SharePoint record this one depends on. It must verify by itself,
 * with --require-live, for the same tenant and build. `verifyEvidence` is passed in
 * by the release verifier so this module never imports it (no import cycle).
 */
function teamsReadPrerequisiteRecord(name, evidenceDir) {
  try {
    return JSON.parse(readFileSync(join(evidenceDir ?? process.cwd(), name), 'utf8'));
  } catch {
    return null;
  }
}

function teamsSharePointPrerequisiteProblems(reference, { tenantRef, build, now, maxAgeHours, hmacKey, evidenceDir, trustedRunners, verifyEvidence }) {
  if (!reference || typeof reference !== 'object') return ['missing prerequisite: no task-120 SharePoint qualification record named'];
  if (reference.gate !== SHAREPOINT_LIVE_GATE) return [`missing prerequisite: the named prerequisite is '${reference.gate ?? 'missing'}', not ${SHAREPOINT_LIVE_GATE}`];
  if (typeof reference.evidence !== 'string' || !/^[\w.-]+\.json$/.test(reference.evidence)) {
    return ['missing prerequisite: the SharePoint record must be named as a file beside this one'];
  }
  if (typeof verifyEvidence !== 'function') return ['missing prerequisite: the SharePoint record cannot be verified here'];
  const record = teamsReadPrerequisiteRecord(reference.evidence, evidenceDir);
  if (!record) return [`missing prerequisite: SharePoint record ${reference.evidence} is absent or unreadable`];
  const result = verifyEvidence(record, {
    gate: SHAREPOINT_LIVE_GATE, tenantRef, build, requireLive: true, now, maxAgeHours, hmacKey, evidenceDir, trustedRunners,
  });
  const failures = result.ok ? [] : [`missing prerequisite: SharePoint record does not verify: ${result.failures.join('; ')}`];
  if (record.subject?.captureLogSha256 !== reference.captureLogSha256) {
    failures.push('missing prerequisite: the SharePoint record is not the one this capture named');
  }
  return failures;
}

/**
 * Gate validator for the task-121 record. Returns failure reasons; empty means the
 * subject holds. `runner` is the release verifier's runner-proof result.
 */
export function validateTeamsLiveSubject(evidence, context = {}) {
  const { tenantRef, build, artifact, runner } = context;
  const failures = [];
  if (evidence.status === 'pending') return ['Teams live evidence pending: no record has been captured'];
  // Both proofs: the runner signature over the record and the digest of its raw log.
  if (!runner?.ok) failures.push(`Teams runner proof required (${runner?.reason ?? 'not checked'})`);
  if (!artifact?.ok) failures.push(`Teams capture artifact required (${artifact?.reason ?? 'not checked'})`);
  if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner?.synthetic)) {
    failures.push('Teams fixture evidence cannot claim live qualification');
  }
  if (!tenantRef || !build) failures.push('Teams expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`Teams build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== TEAMS_LIVE_OPERATION) {
    failures.push(`Teams operation mismatch: expected '${TEAMS_LIVE_OPERATION}', got '${evidence.operation ?? 'missing'}'`);
  }
  if (evidence.credentialMode !== TEAMS_LIVE_CREDENTIAL_MODE) failures.push(`Teams requires credential mode '${TEAMS_LIVE_CREDENTIAL_MODE}'`);
  failures.push(...teamsSecretProblems(evidence));

  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];
  const observedAt = Date.parse(evidence.observedAt ?? '');

  // Prerequisites: named, declared in this build, and the SharePoint record verifies.
  for (const task of teamsMissing(subject.prerequisites, TEAMS_LIVE_PREREQUISITES)) failures.push(`missing prerequisite: ${task}`);
  for (const id of TEAMS_LIVE_READS) if (!teamsReadDescriptor(id)) failures.push(`prerequisite missing in this build: ${id} is not declared`);
  for (const id of TEAMS_LIVE_WRITES) if (!WORKLOAD_WRITE_OPERATIONS[id]) failures.push(`prerequisite missing in this build: ${id} is not declared`);
  failures.push(...teamsSharePointPrerequisiteProblems(subject.sharePointQualification, { ...context, tenantRef, build }));
  // SharePoint proof is never Teams proof: this record's own log must be its own.
  if (subject.captureLogSha256 && subject.captureLogSha256 === subject.sharePointQualification?.captureLogSha256) {
    failures.push('the SharePoint capture log cannot stand in for the Teams capture');
  }

  // Credentials: references only, two distinct identities, separated grants.
  const credentials = subject.credentials ?? {};
  for (const role of ['collector', 'restorer']) {
    if (typeof credentials[role] !== 'string' || !credentials[role].trim()) failures.push(`no ${role} credential reference`);
  }
  if (credentials.collector && credentials.collector === credentials.restorer) failures.push('collector and restorer must be separate credentials');
  const needed = teamsRequiredGrants();
  for (const role of ['collector', 'restorer']) {
    const held = subject.grants?.[role];
    for (const permission of teamsMissing(held?.permissions, needed[role].permissions)) failures.push(`missing prerequisite: ${role} lacks ${permission}`);
    for (const adminRole of teamsMissing(held?.roles, needed[role].roles)) failures.push(`missing prerequisite: ${role} lacks role ${adminRole}`);
  }
  const writePermissions = new Set(needed.restorer.permissions);
  if ((subject.grants?.collector?.permissions ?? []).some((permission) => writePermissions.has(permission))) {
    failures.push('the collector holds a write permission; read and write credentials are not separated');
  }

  // The disposable fixture team and its membership fixture user, in the managed tenant.
  const directoryTenantId = typeof subject.directoryTenantId === 'string' ? subject.directoryTenantId.toLowerCase() : null;
  if (!directoryTenantId || !GUID_RE.test(directoryTenantId)) failures.push('no managed directory tenant id');
  const team = subject.fixtureTeam ?? {};
  const teamId = typeof team.id === 'string' && GUID_RE.test(team.id) ? team.id.toLowerCase() : null;
  if (!teamId) failures.push('the fixture team has no team id');
  if (typeof team.displayName !== 'string' || !team.displayName.startsWith(TEAMS_FIXTURE_PREFIX)) {
    failures.push(`the fixture team is not a disposable ${TEAMS_FIXTURE_PREFIX}* team`);
  }
  if (directoryTenantId && String(team.tenantId ?? '').toLowerCase() !== directoryTenantId) failures.push('the fixture team belongs to another tenant');
  if (team.tenantIdSource !== undefined && !['team', 'collector-token'].includes(team.tenantIdSource)) {
    failures.push('the fixture team\'s tenant has no recognized source');
  }
  const member = subject.fixtureMember ?? {};
  const fixtureMember = {
    userId: typeof member.userId === 'string' && GUID_RE.test(member.userId) ? member.userId.toLowerCase() : null,
    membershipId: typeof member.membershipId === 'string' && member.membershipId ? member.membershipId : null,
  };
  if (!fixtureMember.userId) failures.push('the membership fixture has no user id');
  if (directoryTenantId && String(member.tenantId ?? '').toLowerCase() !== directoryTenantId) {
    failures.push('the membership fixture user belongs to another tenant');
  }
  if (member.memberBefore !== false || member.memberAfter !== false) {
    failures.push('the membership fixture user must be absent from the team before and after the capture');
  }
  if (member.ownerBefore !== false || member.ownerAfter !== false) {
    failures.push('the membership fixture user must not own the fixture group before or after the capture');
  }
  if (member.groupMemberBefore !== false || member.groupMemberAfter !== false) {
    failures.push('the membership fixture user must be absent from the fixture group before and after the capture');
  }

  // Reads: one successful, non-synthetic capture per operation, at the declared version.
  const reads = Array.isArray(subject.reads) ? subject.reads : [];
  for (const id of TEAMS_LIVE_READS) {
    const descriptor = teamsReadDescriptor(id);
    const capture = reads.find((item) => item?.operationId === id);
    if (!capture) { failures.push(`missing prerequisite: no live capture of ${id}`); continue; }
    if (capture.synthetic !== false) failures.push(`${id}: synthetic or unlabelled capture`);
    if (capture.ok !== true) failures.push(`${id}: the read failed`);
    if (descriptor && capture.version !== descriptor.operation.version) {
      failures.push(`${id}: captured at ${capture.version ?? 'unknown'}, not ${descriptor.operation.version}`);
    }
    if (!Number.isInteger(capture.pages) || capture.pages < 1) failures.push(`${id}: paging not recorded`);
    failures.push(...teamsCaptureTimeProblems(id, capture.capturedAt, observedAt));
  }
  for (const field of teamsMissing(subject.supportedFields, TEAM_SETTING_FIELDS)) failures.push(`supported field not observed live: ${field}`);

  // Settings write: changed, read back, put back, final state equals the start.
  const settings = subject.settingsWrite;
  if (settings?.operationId !== TEAMS_LIVE_SETTINGS_WRITE) failures.push(`missing prerequisite: no live capture of ${TEAMS_LIVE_SETTINGS_WRITE}`);
  else {
    failures.push(...teamsWriteCaptureProblems(settings, TEAMS_LIVE_SETTINGS_WRITE, observedAt));
    if (!TEAM_SETTING_FIELDS.includes(settings.group)) failures.push(`${TEAMS_LIVE_SETTINGS_WRITE}: ${settings.group ?? 'no group'} is not a written settings group`);
    if (settings.writeMode !== 'reversible-change') failures.push(`${TEAMS_LIVE_SETTINGS_WRITE}: a same-value write does not prove the platform applies a change`);
    if (settings.restoredToOriginal !== true) failures.push(`${TEAMS_LIVE_SETTINGS_WRITE}: the setting was not put back`);
    if (typeof settings.preFingerprint !== 'string' || settings.preFingerprint !== settings.finalFingerprint) {
      failures.push(`${TEAMS_LIVE_SETTINGS_WRITE}: the final settings do not match the starting settings`);
    }
  }

  // Membership writes: each its own capture; the membership ends where it started.
  const membership = subject.membershipWrites ?? {};
  const memberCaptures = Array.isArray(membership.captures) ? membership.captures : [];
  for (const id of TEAMS_LIVE_MEMBER_WRITES) {
    failures.push(...teamsWriteCaptureProblems(memberCaptures.find((item) => item?.operationId === id), id, observedAt));
  }
  if (membership.restoredToOriginal !== true) failures.push('membership: the fixture user was not removed again');
  if (typeof membership.preFingerprint !== 'string' || membership.preFingerprint !== membership.finalFingerprint) {
    failures.push('membership: the final membership does not match the starting membership');
  }
  if (typeof membership.ownersPreFingerprint !== 'string' || membership.ownersPreFingerprint !== membership.ownersFinalFingerprint) {
    failures.push('membership: the fixture group\'s final owners do not match its starting owners');
  }

  // The raw capture log is bound into the signed subject.
  if (typeof subject.captureLogSha256 !== 'string' || !SHA256_RE.test(subject.captureLogSha256)
      || subject.captureLogSha256 !== evidence.proof?.artifact?.sha256) {
    failures.push('the capture log digest is not bound to the signed subject');
  }

  // Zero content calls and fixture-only addressing, re-derived from the request log.
  failures.push(...teamsRequestProblems(subject.requests, { teamId, member: fixtureMember }));

  const throttle = subject.throttle;
  if (!throttle || !Number.isInteger(throttle.retryAfterResponses) || throttle.retryAfterResponses < 0) {
    failures.push('throttle behaviour not recorded');
  }

  const docs = Array.isArray(subject.documentation) ? subject.documentation : [];
  for (const url of teamsRequiredDocumentation()) {
    const entry = docs.find((item) => item?.url === url);
    if (!entry || Number.isNaN(Date.parse(entry.retrievedAt ?? ''))) failures.push(`documentation not retrieved: ${url}`);
  }
  return failures;
}
