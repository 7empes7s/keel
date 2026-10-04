/**
 * Roadmap task-104: the Teams configuration and structural membership read adapter.
 * For each team it reads:
 *  - the team's settings (member, guest, messaging, fun and discovery settings) and
 *    its properties;
 *  - the team's members and their roles (Teams membership);
 *  - the members of the Microsoft 365 group behind the team (group membership).
 * Every request goes through the task-101 contract. It never reads messages, chats,
 * channel content, replies, hosted content, tabs or files.
 *
 * Rules:
 *  - Disabled until qualified. collectTeams() sends nothing unless SharePoint, the
 *    workload before it, is qualified AND every Teams operation it needs is
 *    live-qualified and enabled in the task-101 ledger. SharePoint proof never stands
 *    in for Teams proof. Fixture tests drive readTeams() directly.
 *  - Messages are content. `messagingSettings` is configuration about messaging and is
 *    read; a message, chat or channel post is never requested, stored or counted. Every
 *    request must match one of TEAMS_REQUEST_SHAPES before it is sent.
 *  - Two memberships, two observations. Teams membership (`members`) and group
 *    membership (`groupMembers`) each carry their own coverage. One complete read never
 *    makes the other complete.
 *  - Tenant scope comes from configuration. `tenantId` is the managed tenant's id. A
 *    team whose settings name another tenant is recorded out of scope and its members
 *    are never read. Each member keeps its own tenant id, so a member from another
 *    tenant (shared channels, B2B direct connect) is never mistaken for a local user.
 *  - Coverage is per field, bounded and keyed by team id, exactly as task-102.
 */
import { registerWorkload } from '../registry.mjs';
import { WORKLOAD_DESCRIPTORS, readGraphConfiguration } from '../workloadContract.mjs';
import { sharePointActivation } from './sharepoint.mjs';

export const TEAMS_WORKLOAD = 'teams-settings';
export const DEFAULT_MAX_TEAMS = 500;

const operation = (id) => WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === id);
export const TEAMS_OPERATIONS = Object.freeze(['teams.team-discovery', 'teams.settings', 'teams.membership', 'teams.group-membership']);

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const TEAMS_DESCRIPTOR = Object.freeze({
  type: 'teamsTeam',
  workload: TEAMS_WORKLOAD,
  adapter: 'teams-settings',
  readOnly: true,
  enabledByDefault: false,
  operations: TEAMS_OPERATIONS,
});

// Settings groups: what the task-104 restore may write back.
export const TEAM_SETTING_FIELDS = Object.freeze(['memberSettings', 'guestSettings', 'messagingSettings', 'funSettings', 'discoverySettings']);
// Properties: observed, never written by KEEL.
export const TEAM_PROPERTY_FIELDS = Object.freeze([
  'displayName', 'description', 'visibility', 'isArchived', 'classification', 'specialization', 'webUrl', 'createdDateTime', 'tenantId',
]);
// Content a team body can carry when expanded, or that a careless reader could fetch.
// Never read, never stored, never counted as configuration.
export const TEAMS_EXCLUDED_CONTENT = Object.freeze([
  'messages', 'chats', 'channels', 'primaryChannel', 'allChannels', 'incomingChannels', 'replies', 'hostedContents',
  'filesFolder', 'tabs', 'installedApps', 'photo', 'schedule',
]);

// The only request shapes this workload sends. Anything else is refused before it leaves.
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GUID_RE = new RegExp(`^${GUID}$`, 'i');
export const TEAMS_REQUEST_SHAPES = Object.freeze([
  { method: 'GET', path: new RegExp('^/v1\\.0/teams$') },
  { method: 'GET', path: new RegExp(`^/v1\\.0/teams/${GUID}$`, 'i') },
  { method: 'GET', path: new RegExp(`^/v1\\.0/teams/${GUID}/members$`, 'i') },
  { method: 'GET', path: new RegExp(`^/v1\\.0/groups/${GUID}/members$`, 'i') },
  { method: 'PATCH', path: new RegExp(`^/v1\\.0/teams/${GUID}$`, 'i') },
  { method: 'POST', path: new RegExp(`^/v1\\.0/teams/${GUID}/members$`, 'i') },
  { method: 'PATCH', path: new RegExp(`^/v1\\.0/teams/${GUID}/members/[A-Za-z0-9=+_-]+$`) },
  { method: 'DELETE', path: new RegExp(`^/v1\\.0/teams/${GUID}/members/[A-Za-z0-9=+_-]+$`) },
  // A Teams owner is also an owner of the team's group, and that link can outlive the
  // Teams membership. The live capture reads it and, if its own promotion left it, removes it.
  { method: 'GET', path: new RegExp(`^/v1\\.0/groups/${GUID}/owners$`, 'i') },
  { method: 'DELETE', path: new RegExp(`^/v1\\.0/groups/${GUID}/owners/${GUID}/\\$ref$`, 'i') },
]);
const ALLOWED_QUERY = new Set(['$skiptoken', '$top']);

export class TeamsScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TeamsScopeError';
  }
}

/** Throws unless the request is one of the Teams configuration shapes. */
export function assertTeamsRequest(url, method = 'GET') {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://graph.microsoft.com') throw new TeamsScopeError(`${url} is not a Microsoft Graph request`);
  const path = decodeURIComponent(parsed.pathname);
  if (!TEAMS_REQUEST_SHAPES.some((shape) => shape.method === method && shape.path.test(path))) {
    throw new TeamsScopeError(`${method} ${path} is not a Teams configuration request; messages, chats and channel content are never read`);
  }
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_QUERY.has(key)) throw new TeamsScopeError(`${method} ${path}: query ${key} is not allowed (no $expand, $select or filter into content)`);
  }
  return true;
}

/** One Teams member as KEEL compares it. Identity is (tenantId, userId). */
export function normalizeMember(member) {
  return {
    membershipId: member?.id ?? null,
    userId: typeof member?.userId === 'string' ? member.userId.toLowerCase() : null,
    tenantId: typeof member?.tenantId === 'string' ? member.tenantId.toLowerCase() : null,
    roles: Array.isArray(member?.roles) ? member.roles.map((role) => String(role).toLowerCase()).sort() : [],
    displayName: member?.displayName ?? null,
  };
}

export const memberIdentity = (member) => `${member.tenantId ?? '?'}|${member.userId ?? '?'}`;

const sortMembers = (members) => [...members].sort((a, b) => memberIdentity(a).localeCompare(memberIdentity(b)));

function normalizeGroupMember(member) {
  return { id: typeof member?.id === 'string' ? member.id.toLowerCase() : null, type: member?.['@odata.type'] ?? null };
}

function failureStatus(error) {
  return error?.status === 401 || error?.status === 403 ? 'denied' : 'failed';
}

function failure(error) {
  return { status: failureStatus(error), httpStatus: Number.isInteger(error?.status) ? error.status : null, error: String(error?.message ?? error) };
}

/**
 * Discovers teams and reads each in-scope team. Pure apart from the injected
 * transport: no database, no gate. Callers outside tests use collectTeams.
 */
export async function readTeams({ transport, tenantId, maxTeams = DEFAULT_MAX_TEAMS, sleep, now = () => new Date() }) {
  if (typeof tenantId !== 'string' || !GUID_RE.test(tenantId)) {
    throw new TypeError('tenantId must be the managed tenant\'s directory id (a GUID)');
  }
  const tenant = tenantId.toLowerCase();
  const requests = [];
  const recordingTransport = async (url) => {
    assertTeamsRequest(url, 'GET');
    requests.push(url);
    return transport(url);
  };
  const read = (id, substitute = {}) => readGraphConfiguration(operation(id), { transport: recordingTransport, sleep, substitute });
  const observedFrom = now().toISOString();

  // Discovery. A failed discovery means the team set is unknown, never empty.
  let discovered;
  let discovery;
  try {
    const { items, observed } = await read('teams.team-discovery');
    discovered = items;
    discovery = { status: 'observed', pages: observed.pages };
  } catch (error) {
    discovered = null;
    discovery = { ...failure(error), pages: null };
  }

  const teams = new Map();
  const outOfScope = [];
  let capped = false;
  for (const team of discovered ?? []) {
    if (!team?.id || teams.has(String(team.id).toLowerCase())) continue;
    if (!GUID_RE.test(String(team.id))) {
      outOfScope.push({ teamId: String(team.id), reason: 'not a team id KEEL will put in a path' });
      continue;
    }
    if (teams.size >= maxTeams) { capped = true; break; }
    teams.set(String(team.id).toLowerCase(), { teamId: String(team.id).toLowerCase(), fields: {}, fieldCoverage: {} });
  }

  for (const entry of [...teams.values()]) {
    let body = null;
    let settingsError = null;
    try {
      ({ items: [body = {}] } = await read('teams.settings', { 'team-id': entry.teamId }));
    } catch (error) {
      settingsError = error;
    }
    if (body && typeof body.tenantId === 'string' && body.tenantId.toLowerCase() !== tenant) {
      // Another tenant's team: recorded, never read further.
      teams.delete(entry.teamId);
      outOfScope.push({ teamId: entry.teamId, reason: 'the team belongs to another tenant' });
      continue;
    }
    for (const field of [...TEAM_SETTING_FIELDS, ...TEAM_PROPERTY_FIELDS]) {
      if (settingsError) {
        entry.fieldCoverage[field] = { ...failure(settingsError), operation: 'teams.settings' };
        continue;
      }
      const value = body[field];
      entry.fields[field] = value ?? null;
      entry.fieldCoverage[field] = { status: value === undefined ? 'unknown' : 'observed', operation: 'teams.settings' };
    }

    // Teams membership and group membership: two reads, two coverage entries.
    try {
      const { items } = await read('teams.membership', { 'team-id': entry.teamId });
      entry.fields.members = sortMembers(items.map(normalizeMember));
      entry.fieldCoverage.members = { status: 'observed', operation: 'teams.membership' };
    } catch (error) {
      entry.fieldCoverage.members = { ...failure(error), operation: 'teams.membership' };
    }
    try {
      const { items } = await read('teams.group-membership', { 'group-id': entry.teamId });
      entry.fields.groupMembers = items.map(normalizeGroupMember).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      entry.fieldCoverage.groupMembers = { status: 'observed', operation: 'teams.group-membership' };
    } catch (error) {
      entry.fieldCoverage.groupMembers = { ...failure(error), operation: 'teams.group-membership' };
    }
  }

  const supportedStatuses = [...teams.values()].flatMap((entry) => Object.values(entry.fieldCoverage).map((coverage) => coverage.status));
  const fieldCounts = supportedStatuses.reduce((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});
  let outcome;
  if (discovery.status !== 'observed') outcome = 'failed';
  else if (capped || supportedStatuses.some((status) => status !== 'observed')) outcome = 'partial';
  else outcome = teams.size === 0 ? 'complete-empty' : 'complete';

  return {
    workload: TEAMS_WORKLOAD,
    tenantId: tenant,
    outcome,
    observedFrom,
    observedTo: now().toISOString(),
    discovery: { ...discovery, teams: discovered === null ? null : teams.size, capped, maxTeams },
    teams: [...teams.values()],
    outOfScope,
    fieldCounts,
    requests,
  };
}

/**
 * Whether live collection may run. SharePoint, the workload before Teams, must be
 * qualified first, and every Teams operation must be live-qualified and enabled on
 * its own. SharePoint proof never counts for a Teams operation.
 */
export function teamsActivation(ledger) {
  const rows = new Map((ledger?.rows ?? []).map((row) => [row.id, row]));
  const reasons = [];
  const sharePoint = sharePointActivation(ledger);
  if (!sharePoint.enabled) reasons.push(`SharePoint is not qualified yet, and Teams follows it: ${sharePoint.reasons.join('; ')}`);
  for (const id of TEAMS_OPERATIONS) {
    const row = rows.get(id);
    if (!row?.enabled) reasons.push(`${id} is ${row?.state ?? 'not in the ledger'}${row?.prerequisite ? `: ${row.prerequisite.message}` : ''}`);
  }
  return { enabled: reasons.length === 0, reasons };
}

/**
 * Persists one run in one transaction; each team is one row keyed by its id, so a
 * re-recorded run cannot double it.
 */
export async function recordTeamsRun(client, { tenantRef, result }) {
  await client.query('BEGIN');
  try {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, TEAMS_WORKLOAD, result.outcome, result.observedFrom, result.observedTo, {
        tenantId: result.tenantId ?? null,
        discovery: result.discovery ?? null,
        fieldCounts: result.fieldCounts ?? {},
        outOfScope: result.outOfScope ?? [],
        reasons: result.reasons ?? [],
      }],
    );
    for (const team of result.teams ?? []) {
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields, field_coverage)
         VALUES ($1,$2,$3,$4) ON CONFLICT (collection_id, resource_key) DO NOTHING`,
        [run.id, `team:${team.teamId}`, team.fields, team.fieldCoverage],
      );
    }
    await client.query('COMMIT');
    return run;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * The gated entry point. Without qualification it records a `disabled` run that
 * names what is missing, and sends no request.
 */
export async function collectTeams(client, { tenantRef, ledger, transport, tenantId, maxTeams, sleep, now }) {
  const activation = teamsActivation(ledger);
  if (!activation.enabled) {
    const at = (now?.() ?? new Date()).toISOString();
    const run = await recordTeamsRun(client, {
      tenantRef,
      result: { outcome: 'disabled', observedFrom: at, observedTo: at, tenantId, reasons: activation.reasons },
    });
    return { run, result: null, activation };
  }
  const result = await readTeams({ transport, tenantId, maxTeams, sleep, now });
  const run = await recordTeamsRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const teamsAdapter = Object.freeze({
  async collect() {
    throw new Error('the Teams workload adapter is disabled until live qualification; use collectTeams with the ledger');
  },
});

registerWorkload(TEAMS_DESCRIPTOR, teamsAdapter);
