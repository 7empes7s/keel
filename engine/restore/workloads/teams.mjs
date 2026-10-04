/**
 * Roadmap task-104: qualified Teams settings and structural membership restore.
 *
 * One plan covers one team. It holds two kinds of operation, each with its own
 * qualification, its own outcome and its own evidence:
 *  - settings: one PATCH /teams/{id} carrying only the changed settings groups
 *    (member, guest, messaging, fun, discovery);
 *  - membership: one POST, PATCH (roles) or DELETE per member, through
 *    /teams/{id}/members.
 * Everything else stays manual or excluded:
 *  - team properties (name, description, visibility, archive state) are changed by a
 *    person;
 *  - members from another tenant (shared channels, B2B direct connect) are re-added
 *    by a person;
 *  - group membership is observed separately and restores through the Entra group
 *    path (relationshipWriter), never here;
 *  - messages, chats, channel posts and files are content. They are never read,
 *    written or claimed as recovered.
 *
 * Rules:
 *  - Immutable plan, persisted as a restore_dry_run artifact; the task-66 approval and
 *    promotion checks are the existing ones.
 *  - Disabled until qualified, per operation. An operation whose write is not
 *    live-qualified (coverage/qualification.mjs, which also requires SharePoint first)
 *    sends nothing; the others still run and report their own outcome.
 *  - Exact approval for widening changes (guest channel rights, discoverability,
 *    adding a guest).
 *  - Tenant identity. The plan names the tenant; the live team must still belong to
 *    it. A member is identified by (tenantId, userId) in planning, retry and
 *    verification, so a same-id user in another tenant never counts as restored.
 *  - No overwrite. Settings and members are re-read first; a change since the plan
 *    is `stale`.
 *  - Retry without resending. A throttled write (429) was not applied and is resent
 *    after Retry-After. An ambiguous outcome (thrown request, 5xx) is reconciled by
 *    re-reading the members; it is never sent a second time.
 *  - Removal needs a complete Teams membership read, in the source and live. Group
 *    membership completeness never authorizes a Teams membership change.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  TEAMS_EXCLUDED_CONTENT, TEAMS_WORKLOAD, TEAM_PROPERTY_FIELDS, TEAM_SETTING_FIELDS, assertTeamsRequest, memberIdentity, normalizeMember,
} from '../../collect/workloads/teams.mjs';
import { WORKLOAD_DESCRIPTORS, readGraphConfiguration } from '../../collect/workloadContract.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../coverage/qualification.mjs';
import { appendEvidence } from '../../govern/evidence.mjs';
import { assertContentEffectApproval, classifyContentEffects, isPreservationLockFailure } from '../../safety/contentEffects.mjs';
import { createDryRunArtifact, getDryRunArtifact, validateArtifactForApproval } from '../dryRunArtifact.mjs';

export const TEAMS_SETTINGS_WRITE = 'teams.settings.update';
export const TEAMS_MEMBER_ADD = 'teams.membership.add';
export const TEAMS_MEMBER_UPDATE = 'teams.membership.update';
export const TEAMS_MEMBER_REMOVE = 'teams.membership.remove';
export const TEAMS_WRITE_OPERATIONS = Object.freeze([TEAMS_SETTINGS_WRITE, TEAMS_MEMBER_ADD, TEAMS_MEMBER_UPDATE, TEAMS_MEMBER_REMOVE]);
export const TEAMS_RESTORE_EVIDENCE_KIND = 'workload-restore';
const CONFIG_PATH = 'workload:teams-settings';
const GRAPH = 'https://graph.microsoft.com';
const VERSION = 'v1.0';
const THROTTLE_MAX_ATTEMPTS = 3;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMBERSHIP_ID_RE = /^[A-Za-z0-9=+_-]+$/;

const declared = (id) => WORKLOAD_WRITE_OPERATIONS[id];
for (const id of TEAMS_WRITE_OPERATIONS) if (!declared(id)) throw new Error(`${id} is not a declared workload write`);
if (declared(TEAMS_SETTINGS_WRITE).fields.some((field) => !TEAM_SETTING_FIELDS.includes(field))) {
  throw new Error('every written Teams setting must be one the reader observes');
}
const readSettings = WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === 'teams.settings');
const readMembers = WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === 'teams.membership');

// Properties KEEL observes but never writes, and why.
const MANUAL_PROPERTY_REASON = Object.freeze({
  displayName: 'team properties are not written by KEEL; rename the team in Teams',
  description: 'team properties are not written by KEEL; edit the description in Teams',
  visibility: 'a visibility change can expose the team\'s content to everyone; a person changes it',
  isArchived: 'archiving and unarchiving are separate Teams actions; a person does it',
  classification: 'classification follows the tenant\'s group naming and label policy; a person sets it',
});
const SERVER_OWNED = Object.freeze(['webUrl', 'createdDateTime', 'tenantId', 'specialization']);

function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : null);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The live team settings as KEEL compares them: every field Graph returned, minus annotations. */
export function teamSettingsFingerprint(team) {
  return sha256(Object.fromEntries(Object.entries(team ?? {}).filter(([key]) => !key.startsWith('@odata'))));
}

/** The live Teams membership as KEEL compares it: identity, membership id and roles. */
export function membersFingerprint(members) {
  return sha256((members ?? []).map(normalizeMember)
    .map(({ membershipId, userId, tenantId, roles }) => ({ membershipId, userId, tenantId, roles }))
    .sort((a, b) => memberIdentity(a).localeCompare(memberIdentity(b))));
}

export function teamsPlanDigest(plan) {
  const { digest, ...rest } = plan;
  return sha256(rest);
}

const isGuest = (member) => member.roles.includes('guest');
const isOwner = (member) => member.roles.includes('owner');

function memberAddBody(member) {
  return {
    '@odata.type': '#microsoft.graph.aadUserConversationMember',
    roles: member.roles.filter((role) => role !== 'guest'),
    'user@odata.bind': `${GRAPH}/${VERSION}/users('${member.userId}')`,
  };
}

/**
 * Builds the frozen plan for one team. `source` is a recorded task-104 collection
 * ({ collectionId, tenantId, outcome, observedTo, observations: [{ resourceKey, fields, fieldCoverage }] });
 * `live` is { team, members, membersComplete } read now.
 */
export function planTeamsRestore({ source, live, tenantId, teamId }) {
  if (!source?.collectionId) throw new TypeError('a Teams restore needs a recorded source collection');
  if (typeof tenantId !== 'string' || !GUID_RE.test(tenantId)) throw new TypeError('tenantId must be the managed tenant\'s directory id');
  if (typeof teamId !== 'string' || !GUID_RE.test(teamId)) throw new TypeError('teamId must be a team id (a GUID)');
  const tenant = tenantId.toLowerCase();
  const team = teamId.toLowerCase();
  if (lower(source.tenantId) !== tenant) throw new Error('the source collection was taken from a different tenant');
  if (!['complete', 'complete-empty', 'partial'].includes(source.outcome)) throw new Error(`a ${source.outcome} collection is not a restore source`);
  if (lower(live?.team?.tenantId) !== tenant) throw new Error('the live team does not belong to the managed tenant');

  const observation = (source.observations ?? []).find((entry) => entry.resourceKey === `team:${team}`);
  const resourceKey = `team:${team}`;
  const manual = [];
  const excluded = TEAMS_EXCLUDED_CONTENT.map((field) => ({ resourceKey, field, reason: 'Teams content: messages, chats, channel posts and files are never read or restored' }));
  const operations = [];
  const refusals = [];
  if (!observation) {
    manual.push({ resourceKey, field: null, reason: 'the source collection has no observation of this team' });
  }

  // Settings.
  const settingsChanges = [];
  for (const field of declared(TEAMS_SETTINGS_WRITE).fields) {
    if (!observation) break;
    const coverage = observation.fieldCoverage?.[field]?.status ?? 'unknown';
    if (coverage !== 'observed') {
      manual.push({ resourceKey, field, reason: `${coverage} in the source collection, so there is no value to restore` });
      continue;
    }
    const after = observation.fields?.[field] ?? null;
    const before = live.team?.[field] ?? null;
    if (!same(before, after)) settingsChanges.push({ field, before, after });
  }
  for (const field of TEAM_PROPERTY_FIELDS) {
    if (!observation) break;
    if (SERVER_OWNED.includes(field)) { excluded.push({ resourceKey, field, reason: 'server-owned' }); continue; }
    if (observation.fieldCoverage?.[field]?.status !== 'observed') continue;
    if (!same(observation.fields?.[field], live.team?.[field])) manual.push({ resourceKey, field, reason: MANUAL_PROPERTY_REASON[field] });
  }
  if (settingsChanges.length) {
    operations.push({
      key: `settings:${team}`,
      kind: 'settings',
      operationId: TEAMS_SETTINGS_WRITE,
      naturalKey: `teams:${team}:settings`,
      method: 'PATCH',
      path: `/teams/${team}`,
      changes: settingsChanges,
      body: Object.fromEntries(settingsChanges.map(({ field, after }) => [field, after])),
    });
  }

  // Group membership is its own observation. It is reported, never used here.
  const groupMembership = {
    status: observation?.fieldCoverage?.groupMembers?.status ?? 'unknown',
    note: 'group membership restores through the Entra group relationship path, not the Teams restore',
  };

  // Teams membership. Only a complete Teams membership read in the source is a basis.
  const sourceStatus = observation?.fieldCoverage?.members?.status ?? 'unknown';
  const memberOps = [];
  if (observation && sourceStatus !== 'observed') {
    manual.push({ resourceKey, field: 'members', reason: `Teams membership was ${sourceStatus} in the source collection, so no member change is planned` });
  } else if (observation) {
    const desired = (observation.fields?.members ?? []).map(normalizeMember);
    const current = (live.members ?? []).map(normalizeMember);
    const currentByIdentity = new Map(current.map((member) => [memberIdentity(member), member]));
    const desiredIdentities = new Set();
    for (const member of desired) {
      if (!member.userId || !GUID_RE.test(member.userId) || !member.tenantId) {
        manual.push({ resourceKey, field: 'members', member: memberIdentity(member), reason: 'the source member has no usable user and tenant identity' });
        continue;
      }
      if (member.tenantId !== tenant) {
        manual.push({ resourceKey, field: 'members', member: memberIdentity(member), reason: 'a member from another tenant (shared channel or B2B direct connect) is re-added by a person' });
        continue;
      }
      desiredIdentities.add(memberIdentity(member));
      const existing = currentByIdentity.get(memberIdentity(member));
      if (!existing) {
        memberOps.push({
          key: `member-add:${memberIdentity(member)}`, kind: 'member-add', operationId: TEAMS_MEMBER_ADD,
          naturalKey: `teams:${team}:member:${memberIdentity(member)}`, method: 'POST', path: `/teams/${team}/members`,
          member: { userId: member.userId, tenantId: member.tenantId, roles: member.roles, displayName: member.displayName },
          body: memberAddBody(member),
        });
      } else if (!same(existing.roles, member.roles)) {
        if (!existing.membershipId || !MEMBERSHIP_ID_RE.test(existing.membershipId)) {
          manual.push({ resourceKey, field: 'members', member: memberIdentity(member), reason: 'the live membership id cannot be addressed safely' });
          continue;
        }
        memberOps.push({
          key: `member-update:${memberIdentity(member)}`, kind: 'member-update', operationId: TEAMS_MEMBER_UPDATE,
          naturalKey: `teams:${team}:member:${memberIdentity(member)}`, method: 'PATCH', path: `/teams/${team}/members/${existing.membershipId}`,
          member: { userId: member.userId, tenantId: member.tenantId, roles: member.roles, membershipId: existing.membershipId, displayName: member.displayName },
          before: existing.roles,
          body: { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: member.roles.filter((role) => role !== 'guest') },
        });
      }
    }
    for (const member of current) {
      if (desiredIdentities.has(memberIdentity(member))) continue;
      if (member.tenantId !== tenant) {
        manual.push({ resourceKey, field: 'members', member: memberIdentity(member), reason: 'a member from another tenant is never removed automatically' });
        continue;
      }
      if (live.membersComplete !== true) {
        manual.push({ resourceKey, field: 'members', member: memberIdentity(member), reason: 'the live Teams membership read was not complete, so no removal is authorized' });
        continue;
      }
      if (!member.membershipId || !MEMBERSHIP_ID_RE.test(member.membershipId)) {
        manual.push({ resourceKey, field: 'members', member: memberIdentity(member), reason: 'the live membership id cannot be addressed safely' });
        continue;
      }
      memberOps.push({
        key: `member-remove:${memberIdentity(member)}`, kind: 'member-remove', operationId: TEAMS_MEMBER_REMOVE,
        naturalKey: `teams:${team}:member:${memberIdentity(member)}`, method: 'DELETE', path: `/teams/${team}/members/${member.membershipId}`,
        member: { userId: member.userId, tenantId: member.tenantId, roles: member.roles, membershipId: member.membershipId, displayName: member.displayName },
      });
    }
    // Owners never drop to zero: Teams refuses it, and a half-applied set would strand the team.
    const after = new Map(current.map((member) => [memberIdentity(member), member]));
    for (const op of memberOps) {
      const identity = `${op.member.tenantId}|${op.member.userId}`;
      if (op.kind === 'member-remove') after.delete(identity);
      else after.set(identity, { ...op.member });
    }
    if (memberOps.length && ![...after.values()].some(isOwner)) {
      refusals.push({ naturalKey: `teams:${team}:members`, reason: 'the planned membership would leave the team with no owner' });
    } else {
      // Adds, then role changes, then removals: the team is never transiently emptier than needed.
      const order = { 'member-add': 0, 'member-update': 1, 'member-remove': 2 };
      memberOps.sort((a, b) => order[a.kind] - order[b.kind] || a.key.localeCompare(b.key));
      operations.push(...memberOps);
    }
  }

  // Content effects: settings and guest additions, classified by the reviewed rules.
  const resources = [];
  if (settingsChanges.length) {
    const body = operations.find((op) => op.kind === 'settings').body;
    resources.push({
      naturalKey: `teams:${team}:settings`, resourceType: 'teamsTeamSettings', verb: 'update',
      payload: { ...live.team, ...body }, live: { state: 'present', payload: live.team },
    });
  }
  const addedGuests = operations.filter((op) => (op.kind === 'member-add' || op.kind === 'member-update') && op.member.roles.includes('guest'))
    .map((op) => `${op.member.tenantId}|${op.member.userId}`);
  if (addedGuests.length) {
    const currentGuests = (live.members ?? []).map(normalizeMember).filter(isGuest).map(memberIdentity);
    resources.push({
      naturalKey: `teams:${team}:members`, resourceType: 'teamsMembership', verb: 'update',
      payload: { guests: [...new Set([...currentGuests, ...addedGuests])].sort() }, live: { state: 'present', payload: { guests: currentGuests.sort() } },
    });
  }
  const classified = resources.length ? classifyContentEffects(resources) : { effects: [], refusals: [] };

  const plan = {
    workload: TEAMS_WORKLOAD,
    tenantId: tenant,
    teamId: team,
    source: { collectionId: source.collectionId, observedTo: source.observedTo ?? null, outcome: source.outcome },
    operations,
    manual,
    excluded,
    groupMembership,
    contentEffects: classified.effects,
    refusals: [...refusals, ...classified.refusals],
    liveFingerprints: { settings: teamSettingsFingerprint(live.team), members: membersFingerprint(live.members) },
  };
  plan.digest = teamsPlanDigest(plan);
  return deepFreeze(plan);
}

/** Reads a recorded task-104 collection as a restore source. */
export async function loadTeamsSource(client, { tenantRef, collectionId }) {
  const { rows: [run] } = await client.query(
    `SELECT * FROM workload_collection WHERE id::text = $1 AND tenant_ref = $2 AND workload = $3`,
    [collectionId, tenantRef, TEAMS_WORKLOAD],
  );
  if (!run) return null;
  const { rows } = await client.query(
    `SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key`,
    [run.id],
  );
  return {
    collectionId: run.id,
    tenantId: run.digest?.tenantId ?? null,
    outcome: run.outcome,
    observedTo: new Date(run.observed_to).toISOString(),
    observations: rows.map((row) => ({ resourceKey: row.resource_key, fields: row.fields, fieldCoverage: row.field_coverage })),
  };
}

function guardedTransport(transport, requests) {
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    assertTeamsRequest(url, method);
    requests.push({ url, method });
    return transport(url, init);
  };
}

/** Reads the live team and its members through the task-101 contract. */
export async function readLiveTeam({ transport, teamId, sleep }) {
  const requests = [];
  const guarded = guardedTransport(transport, requests);
  const { items: [team = {}] } = await readGraphConfiguration(readSettings, { transport: guarded, sleep, substitute: { 'team-id': teamId } });
  let members = [];
  let membersComplete = false;
  try {
    ({ items: members } = await readGraphConfiguration(readMembers, { transport: guarded, sleep, substitute: { 'team-id': teamId } }));
    membersComplete = true;
  } catch {
    members = [];
  }
  return { team, members, membersComplete };
}

/** Persists the plan as an immutable dry-run artifact. */
export async function createTeamsRestoreArtifact(client, { tenantRef, plan, requestedBy }) {
  const keys = [`teams:${plan.teamId}`, ...plan.operations.map((op) => op.naturalKey)];
  return createDryRunArtifact(client, {
    id: randomUUID(),
    tenantRef,
    snapshotId: null,
    selection: [`teams:${plan.teamId}`],
    closureKeys: [...new Set(keys)],
    targetTenantId: plan.tenantId,
    collectorConfigPath: CONFIG_PATH,
    targetConfigPath: CONFIG_PATH,
    reconciliationResources: null,
    waves: [],
    patches: [],
    guardRefusals: plan.refusals,
    results: { operations: plan.operations.length, manual: plan.manual.length },
    currentStateFingerprint: sha256(plan.liveFingerprints),
    digest: plan.digest,
    status: plan.refusals.length ? 'refused' : 'completed',
    requestedBy,
    contentEffects: plan.contentEffects,
    workloadRestore: plan,
  });
}

function operationTarget(op) {
  return op.kind === 'settings' ? { teamId: op.path.split('/')[2] } : { userId: op.member.userId, tenantId: op.member.tenantId };
}

async function recordOperation(client, { tenantRef, artifactId, actor, op, result }) {
  await appendEvidence(client, {
    tenantRef,
    kind: TEAMS_RESTORE_EVIDENCE_KIND,
    subject: {
      artifactId, operationId: op.operationId, kind: op.kind, target: operationTarget(op),
      outcome: result.outcome, writes: result.writes, attempts: result.attempts ?? result.writes, verified: result.verified ?? [], reasons: result.reasons,
    },
    actor,
  });
}

const isAmbiguous = (response) => response === null || response.status >= 500;

/** Sends one write. 429 is resent after Retry-After; anything else is returned once. */
async function sendOnce(counted, url, init, sleep) {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    let response;
    try {
      response = await counted(url, init);
    } catch (error) {
      return { response: null, attempts, error };
    }
    if (response.status !== 429 || attempts >= THROTTLE_MAX_ATTEMPTS) return { response, attempts };
    const seconds = Number(response.headers?.['retry-after']);
    await sleep(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempts * 1000);
  }
}

function findMember(members, { userId, tenantId }) {
  return members.map(normalizeMember).find((member) => member.userId === userId && member.tenantId === tenantId) ?? null;
}

function memberMatches(op, members) {
  const found = findMember(members, op.member);
  if (op.kind === 'member-remove') return found === null;
  return found !== null && same(found.roles, op.member.roles);
}

/**
 * Promotes one approved artifact. `qualifications` maps each Teams write operationId
 * to workloadWriteQualification(operationId, ...). `transport(url, init?)` answers
 * { status, headers, body }.
 * Plan outcomes: refused, blocked-content-effect, no-change, disabled, verified, partial.
 * Operation outcomes: disabled, refused, stale, failed, verification-failed, verified.
 */
export async function executeTeamsRestore(client, {
  tenantRef, artifactId, tenantId, transport, qualifications = {}, actor = null, sleep = async () => {},
}) {
  const requests = [];
  const counted = guardedTransport(transport, requests);
  const artifact = await getDryRunArtifact(client, { id: artifactId, tenantRef });
  const by = actor ?? artifact?.requestedBy ?? 'keel';
  const finish = async (result) => {
    await appendEvidence(client, {
      tenantRef, kind: TEAMS_RESTORE_EVIDENCE_KIND,
      subject: { artifactId, operationId: 'teams.restore', outcome: result.outcome, operations: result.operations.map(({ key, outcome }) => ({ key, outcome })), reasons: result.reasons ?? [] },
      actor: by,
    });
    return { ...result, requests };
  };
  const refuse = (reason) => finish({ outcome: 'refused', operations: [], reasons: [reason] });

  const plan = artifact?.workloadRestore ?? null;
  if (!plan || plan.workload !== TEAMS_WORKLOAD) return refuse('no Teams restore plan with this id');
  const promotable = validateArtifactForApproval(artifact);
  if (!promotable.ok) return refuse(promotable.reason);
  if (teamsPlanDigest(plan) !== plan.digest || artifact.digest !== plan.digest || !same(artifact.contentEffects ?? [], plan.contentEffects)) {
    return refuse('the stored plan no longer matches its digest; a new dry run is required');
  }
  if (lower(tenantId) !== plan.tenantId) return refuse(`the plan targets tenant ${plan.tenantId}, not ${tenantId}`);
  if (plan.operations.length === 0) return finish({ outcome: 'no-change', operations: [], reasons: ['the live team already matches the source'] });

  const results = new Map();
  const settle = async (op, result) => {
    const full = { writes: 0, verified: [], ...result };
    results.set(op.key, { key: op.key, kind: op.kind, operationId: op.operationId, ...full });
    await recordOperation(client, { tenantRef, artifactId, actor: by, op, result: full });
  };

  // Qualification first, per operation: an unqualified operation sends nothing.
  const runnable = [];
  for (const op of plan.operations) {
    const qualification = qualifications[op.operationId];
    if (qualification?.operationId !== op.operationId || qualification.enabled !== true) {
      await settle(op, { outcome: 'disabled', reasons: [...(qualification?.reasons ?? [`no write qualification was supplied for ${op.operationId}`])] });
    } else runnable.push(op);
  }

  if (runnable.length) {
    let approved = true;
    try {
      if (plan.contentEffects.length) await assertContentEffectApproval(client, { artifact, effects: plan.contentEffects });
    } catch (error) {
      approved = false;
      for (const op of runnable) await settle(op, { outcome: 'blocked-content-effect', reasons: [error.message] });
    }
    if (approved) await runOperations(plan, runnable, { counted, sleep, settle });
  }

  const operations = plan.operations.map((op) => results.get(op.key));
  const outcomes = new Set(operations.map((op) => op.outcome));
  let outcome;
  if (outcomes.size === 1 && outcomes.has('verified')) outcome = 'verified';
  else if (outcomes.size === 1 && outcomes.has('disabled')) outcome = 'disabled';
  else if (outcomes.size === 1 && outcomes.has('blocked-content-effect')) outcome = 'blocked-content-effect';
  else outcome = 'partial';
  return finish({ outcome, operations, reasons: [] });
}

async function runOperations(plan, runnable, { counted, sleep, settle }) {
  // Re-read the team: it must still belong to the planned tenant, and nothing may
  // have changed since the dry run.
  let live;
  try {
    live = await readLiveTeam({ transport: counted, teamId: plan.teamId, sleep });
  } catch (error) {
    for (const op of runnable) await settle(op, { outcome: 'failed', reasons: [`could not re-read the team before writing: ${error.message}`] });
    return;
  }
  if (lower(live.team?.tenantId) !== plan.tenantId) {
    for (const op of runnable) await settle(op, { outcome: 'refused', reasons: ['the team no longer belongs to the planned tenant'] });
    return;
  }
  const settingsStale = teamSettingsFingerprint(live.team) !== plan.liveFingerprints.settings;
  const membersStale = !live.membersComplete || membersFingerprint(live.members) !== plan.liveFingerprints.members;

  for (const op of runnable) {
    if (op.kind === 'settings') {
      if (settingsStale) { await settle(op, { outcome: 'stale', reasons: ['the team settings changed since the dry run; a new dry run is required'] }); continue; }
      await runSettings(op, plan, { counted, sleep, settle });
    } else {
      if (membersStale) { await settle(op, { outcome: 'stale', reasons: ['the Teams membership changed since the dry run, or could not be fully re-read; a new dry run is required'] }); continue; }
      await runMember(op, plan, { counted, sleep, settle });
    }
  }
}

async function runSettings(op, plan, { counted, sleep, settle }) {
  const { response, attempts } = await sendOnce(counted, `${GRAPH}/${VERSION}${op.path}`, { method: op.method, body: op.body }, sleep);
  if (!response || response.status < 200 || response.status >= 300) {
    const locked = response && isPreservationLockFailure(response);
    await settle(op, {
      outcome: locked ? 'refused' : 'failed', writes: 1, attempts,
      reasons: [locked ? 'the platform refused the change under a preservation lock; KEEL does not retry or work around it'
        : `the settings write failed (${response ? `HTTP ${response.status}` : 'no response'}); nothing is retried automatically`],
    });
    return;
  }
  let after;
  try {
    ({ team: after } = await readLiveTeam({ transport: counted, teamId: plan.teamId, sleep }));
  } catch (error) {
    await settle(op, { outcome: 'verification-failed', writes: 1, attempts, reasons: [`the write was sent but could not be read back: ${error.message}`] });
    return;
  }
  if (lower(after?.tenantId) !== plan.tenantId) {
    await settle(op, { outcome: 'verification-failed', writes: 1, attempts, reasons: ['the read-back team does not belong to the planned tenant'] });
    return;
  }
  const verified = [];
  const mismatched = [];
  for (const { field, after: expected } of op.changes) (same(after?.[field], expected) ? verified : mismatched).push(field);
  await settle(op, {
    outcome: mismatched.length ? 'verification-failed' : 'verified', writes: 1, attempts, verified,
    reasons: mismatched.map((field) => `${field} did not read back as written`),
  });
}

async function runMember(op, plan, { counted, sleep, settle }) {
  const { response, attempts, error } = await sendOnce(counted, `${GRAPH}/${VERSION}${op.path}`, { method: op.method, body: op.body }, sleep);
  const ambiguous = isAmbiguous(response);
  if (!ambiguous && (response.status < 200 || response.status >= 300)) {
    await settle(op, { outcome: 'failed', writes: 1, attempts, reasons: [`the member write failed with HTTP ${response.status}; nothing is retried automatically`] });
    return;
  }
  // Verify, or reconcile an ambiguous outcome, by re-reading the members. The write
  // is never sent again: only the read decides.
  let members;
  try {
    const live = await readLiveTeam({ transport: counted, teamId: plan.teamId, sleep });
    if (!live.membersComplete) throw new Error('the Teams membership read was not complete');
    members = live.members;
  } catch (readError) {
    await settle(op, { outcome: 'verification-failed', writes: 1, attempts, reasons: [`the member write ${ambiguous ? 'had an unknown outcome' : 'was sent'} and could not be read back: ${readError.message}`] });
    return;
  }
  if (memberMatches(op, members)) {
    await settle(op, {
      outcome: 'verified', writes: 1, attempts, verified: [`${op.member.tenantId}|${op.member.userId}`],
      reasons: ambiguous ? [`the write outcome was unknown (${error ? error.message : `HTTP ${response.status}`}); the re-read shows it applied, so it was not resent`] : [],
    });
    return;
  }
  await settle(op, {
    outcome: ambiguous ? 'failed' : 'verification-failed', writes: 1, attempts,
    reasons: [ambiguous
      ? `the write outcome was unknown (${error ? error.message : `HTTP ${response.status}`}) and the re-read does not show it; it was not resent`
      : `the member ${op.member.tenantId}|${op.member.userId} did not read back as written`],
  });
}
