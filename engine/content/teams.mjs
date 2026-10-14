/**
 * Wave 1 package TEAMS: back up every Teams container.
 *
 * For each team in the managed tenant it reads, with GET only:
 *  - the team itself (properties and the member, guest, messaging, fun and discovery settings);
 *  - every channel the team hosts: standard, private and shared, with its settings;
 *  - the members of each private and shared channel (who can see it is part of the container);
 *  - the tabs in each channel, with the app behind each tab;
 *  - the apps installed in the team;
 *  - where each channel keeps its files (a folder in a SharePoint document library).
 *
 * Rules:
 *  - Read-only. Every request must match one of TEAMS_CONTENT_REQUEST_SHAPES, and every
 *    shape is a GET. Anything else is refused before it leaves.
 *  - Messages are never read. Until Microsoft approves the Teams export API for the tenant
 *    (ask 2), each channel carries `messages: { status: 'waiting-on-microsoft' }`, so the
 *    gap is flagged on every backup and never silently missing.
 *  - Channel files belong to SharePoint. This module only finds the folder and asks the
 *    injected `sites.backupDriveFolder` who covers it. The default, SITE_LIBRARY_COVERAGE,
 *    points at the team's site: backupSharePointSites backs up that library whole, so the
 *    folder is recorded `covered-by-site` with `coveredBy: 'site:<siteId>'`, never as a second
 *    copy. An answer without that pointer is recorded `unconfirmed`, never `backed-up`.
 *    With `sites: null`, the folder is recorded `waiting-on-sites`.
 *  - Content goes through the content store interface (section 2 of the coverage plan):
 *    `putItem(stream, { tenantRef, workload, container, itemKey, version, metadata })`.
 *    Each team is one item: a canonical JSON document keyed by the team id, versioned by
 *    its own sha256, so an unchanged team is stored once.
 *  - Tenant scope comes from configuration. A team or channel that names another tenant
 *    is recorded out of scope and never read further.
 *  - A failed read is recorded on the part it affects (`denied` or `failed`), never as empty.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export const TEAMS_CONTENT_WORKLOAD = 'teams';
export const DEFAULT_MAX_TEAMS = 500;
export const DEFAULT_MAX_PAGES = 100;
export const CHANNEL_KINDS = Object.freeze(['standard', 'private', 'shared']);

export const MESSAGES_WAITING = Object.freeze({
  status: 'waiting-on-microsoft',
  reason: 'Teams messages need the Microsoft Teams export API, which Microsoft must approve for this tenant first.',
});

export const TEAM_FIELDS = Object.freeze([
  'displayName', 'description', 'visibility', 'isArchived', 'classification', 'specialization', 'webUrl', 'createdDateTime',
  'tenantId', 'internalId', 'memberSettings', 'guestSettings', 'messagingSettings', 'funSettings', 'discoverySettings',
]);
export const CHANNEL_FIELDS = Object.freeze([
  'displayName', 'description', 'membershipType', 'email', 'webUrl', 'createdDateTime', 'isFavoriteByDefault', 'tenantId',
  'isArchived', 'moderationSettings',
]);

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GUID_RE = new RegExp(`^${GUID}$`, 'i');
const CHANNEL = '19:[A-Za-z0-9_.-]+@thread\\.(?:tacv2|skype)';
const CHANNEL_RE = new RegExp(`^${CHANNEL}$`);
const team = `/v1\\.0/teams/${GUID}`;
const channel = `${team}/channels/${CHANNEL}`;

// The only requests this module sends: all GET, none touch messages.
export const TEAMS_CONTENT_REQUEST_SHAPES = Object.freeze([
  { path: new RegExp('^/v1\\.0/teams$'), query: [] },
  { path: new RegExp(`^${team}$`, 'i'), query: [] },
  { path: new RegExp(`^${team}/installedApps$`, 'i'), query: ['$expand=teamsAppDefinition'] },
  { path: new RegExp(`^${team}/channels$`, 'i'), query: [] },
  { path: new RegExp(`^${channel}$`, 'i'), query: [] },
  { path: new RegExp(`^${channel}/members$`, 'i'), query: [] },
  { path: new RegExp(`^${channel}/tabs$`, 'i'), query: ['$expand=teamsApp'] },
  { path: new RegExp(`^${channel}/filesFolder$`, 'i'), query: [] },
].map((shape) => Object.freeze({ method: 'GET', ...shape })));
const PAGING_QUERY = new Set(['$skiptoken', '$top']);

export class TeamsContentScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TeamsContentScopeError';
  }
}

/** Throws unless the request is one of the read-only Teams container shapes. */
export function assertTeamsContentRequest(url, method = 'GET') {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://graph.microsoft.com') throw new TeamsContentScopeError(`${url} is not a Microsoft Graph request`);
  const path = decodeURIComponent(parsed.pathname);
  if (method !== 'GET') throw new TeamsContentScopeError(`${method} ${path} refused: the Teams backup only reads`);
  const shape = TEAMS_CONTENT_REQUEST_SHAPES.find((candidate) => candidate.path.test(path));
  if (!shape) throw new TeamsContentScopeError(`GET ${path} is not a Teams container request; messages are never read`);
  for (const [key, value] of parsed.searchParams) {
    if (PAGING_QUERY.has(key)) continue;
    if (!shape.query.includes(`${key}=${value}`)) throw new TeamsContentScopeError(`GET ${path}: query ${key}=${value} is not allowed`);
  }
  return true;
}

function failure(error) {
  const status = error?.status === 401 || error?.status === 403 ? 'denied' : 'failed';
  return { status, httpStatus: Number.isInteger(error?.status) ? error.status : null, error: String(error?.message ?? error) };
}

const pick = (body, fields) => Object.fromEntries(fields.map((field) => [field, body?.[field] ?? null]));
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : null);

/** Canonical JSON: keys sorted at every depth, so the same team always hashes the same. */
export function canonicalJson(value) {
  const sort = (node) => {
    if (Array.isArray(node)) return node.map(sort);
    if (node && typeof node === 'object') return Object.fromEntries(Object.keys(node).sort().map((key) => [key, sort(node[key])]));
    return node;
  };
  return JSON.stringify(sort(value));
}

function normalizeChannelMember(member) {
  return {
    membershipId: member?.id ?? null,
    userId: lower(member?.userId),
    tenantId: lower(member?.tenantId),
    roles: Array.isArray(member?.roles) ? member.roles.map((role) => String(role).toLowerCase()).sort() : [],
    displayName: member?.displayName ?? null,
  };
}

function normalizeTab(tab) {
  return {
    id: tab?.id ?? null,
    displayName: tab?.displayName ?? null,
    webUrl: tab?.webUrl ?? null,
    configuration: tab?.configuration ?? null,
    app: tab?.teamsApp ? { id: tab.teamsApp.id ?? null, displayName: tab.teamsApp.displayName ?? null, distributionMethod: tab.teamsApp.distributionMethod ?? null } : null,
  };
}

function normalizeInstalledApp(app) {
  const definition = app?.teamsAppDefinition ?? {};
  return {
    id: app?.id ?? null,
    teamsAppId: definition.teamsAppId ?? null,
    displayName: definition.displayName ?? null,
    version: definition.version ?? null,
    publishingState: definition.publishingState ?? null,
  };
}

const byKey = (key) => (a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? ''));

/**
 * Reads every team the tenant has, as containers. Pure apart from the injected
 * transport: `transport(url)` resolves `{ status, headers, body }`.
 */
export async function readTeamContainers({ transport, tenantId, maxTeams = DEFAULT_MAX_TEAMS, maxPages = DEFAULT_MAX_PAGES, maxRetries = 3, sleep = async () => {}, now = () => new Date() }) {
  if (typeof tenantId !== 'string' || !GUID_RE.test(tenantId)) throw new TypeError('tenantId must be the managed tenant\'s directory id (a GUID)');
  const tenant = tenantId.toLowerCase();
  const requests = [];
  const graph = 'https://graph.microsoft.com/v1.0';

  async function get(path) {
    const first = new URL(`${graph}${path}`);
    const items = [];
    let next = first.href;
    let pages = 0;
    while (next) {
      if (pages >= maxPages) throw new Error(`GET ${first.pathname}: more than ${maxPages} pages`);
      assertTeamsContentRequest(next, 'GET');
      let response;
      for (let attempt = 0; ; attempt += 1) {
        requests.push(next);
        response = await transport(next);
        if (response.status !== 429 && response.status !== 503) break;
        if (attempt >= maxRetries) throw Object.assign(new Error(`GET ${first.pathname}: still throttled after ${maxRetries} retries`), { status: response.status });
        const seconds = Number(response.headers?.['retry-after']);
        await sleep(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempt * 1000);
      }
      if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`GET ${first.pathname}: HTTP ${response.status}`), { status: response.status });
      pages += 1;
      const body = response.body ?? {};
      if (!Array.isArray(body.value)) return { items: [body], pages };
      items.push(...body.value);
      const link = body['@odata.nextLink'];
      if (!link) break;
      const url = new URL(link);
      if (url.origin !== first.origin || decodeURIComponent(url.pathname) !== decodeURIComponent(first.pathname)) {
        throw new Error(`GET ${first.pathname}: refused a next page outside the request`);
      }
      next = url.href;
    }
    return { items, pages };
  }
  const part = async (path, map) => {
    try {
      const { items } = await get(path);
      return { status: 'observed', items: map(items) };
    } catch (error) {
      if (error instanceof TeamsContentScopeError) throw error;
      return { ...failure(error), items: null };
    }
  };

  const observedFrom = now().toISOString();
  let discovered = null;
  let discovery;
  try {
    const { items, pages } = await get('/teams');
    discovered = items;
    discovery = { status: 'observed', pages };
  } catch (error) {
    if (error instanceof TeamsContentScopeError) throw error;
    discovery = { ...failure(error), pages: null };
  }

  const teams = [];
  const outOfScope = [];
  const seen = new Set();
  let capped = false;
  for (const listed of discovered ?? []) {
    const teamId = lower(listed?.id);
    if (!teamId || seen.has(teamId)) continue;
    seen.add(teamId);
    if (!GUID_RE.test(teamId)) { outOfScope.push({ teamId: String(listed.id), reason: 'not a team id Keel will put in a path' }); continue; }
    if (teams.length >= maxTeams) { capped = true; break; }
    const base = `/teams/${teamId}`;

    let body;
    let settings;
    try {
      ({ items: [body = {}] } = await get(base));
      settings = { status: 'observed' };
    } catch (error) {
      if (error instanceof TeamsContentScopeError) throw error;
      body = listed;
      settings = failure(error);
    }
    if (lower(body?.tenantId) && lower(body.tenantId) !== tenant) {
      outOfScope.push({ teamId, reason: 'the team belongs to another tenant' });
      continue;
    }

    const installedApps = await part(`${base}/installedApps?$expand=teamsAppDefinition`, (items) => items.map(normalizeInstalledApp).sort(byKey('teamsAppId')));
    const channelList = await part(`${base}/channels`, (items) => items);
    const channels = [];
    for (const listedChannel of channelList.items ?? []) {
      const channelId = listedChannel?.id;
      if (typeof channelId !== 'string' || !CHANNEL_RE.test(channelId)) {
        outOfScope.push({ teamId, channelId: channelId ?? null, reason: 'not a channel id Keel will put in a path' });
        continue;
      }
      if (lower(listedChannel.tenantId) && lower(listedChannel.tenantId) !== tenant) {
        outOfScope.push({ teamId, channelId, reason: 'the channel is hosted in another tenant' });
        continue;
      }
      const path = `${base}/channels/${encodeURIComponent(channelId)}`;
      let channelBody = listedChannel;
      let channelSettings = { status: 'observed' };
      try {
        ({ items: [channelBody = listedChannel] } = await get(path));
      } catch (error) {
        if (error instanceof TeamsContentScopeError) throw error;
        channelSettings = failure(error);
      }
      const kind = String(channelBody.membershipType ?? listedChannel.membershipType ?? 'standard').toLowerCase();
      const members = kind === 'standard'
        ? { status: 'inherited', items: null, reason: 'a standard channel has the team\'s members' }
        : await part(`${path}/members`, (items) => items.map(normalizeChannelMember).sort(byKey('userId')));
      const tabs = await part(`${path}/tabs?$expand=teamsApp`, (items) => items.map(normalizeTab).sort(byKey('id')));
      let files;
      try {
        const { items: [folder = {}] } = await get(`${path}/filesFolder`);
        files = {
          status: 'located',
          location: {
            driveId: folder.parentReference?.driveId ?? null,
            siteId: folder.parentReference?.siteId ?? null,
            itemId: folder.id ?? null,
            name: folder.name ?? null,
            webUrl: folder.webUrl ?? null,
          },
        };
      } catch (error) {
        if (error instanceof TeamsContentScopeError) throw error;
        files = error?.status === 404 ? { status: 'not-provisioned', location: null } : { ...failure(error), location: null };
      }
      channels.push({
        channelId,
        kind: CHANNEL_KINDS.includes(kind) ? kind : 'unknown',
        fields: pick(channelBody, CHANNEL_FIELDS),
        settings: channelSettings,
        members,
        tabs,
        files,
        messages: { ...MESSAGES_WAITING },
      });
    }
    channels.sort(byKey('channelId'));
    teams.push({
      teamId,
      fields: pick(body, TEAM_FIELDS),
      settings,
      installedApps,
      channels: { status: channelList.status, ...(channelList.status === 'observed' ? {} : { httpStatus: channelList.httpStatus, error: channelList.error }), items: channels },
    });
  }

  const partStatuses = teams.flatMap((entry) => [
    entry.settings.status, entry.installedApps.status, entry.channels.status,
    ...entry.channels.items.flatMap((item) => [item.settings.status, item.members.status, item.tabs.status, item.files.status]),
  ]);
  let outcome;
  if (discovery.status !== 'observed') outcome = 'failed';
  else if (capped || partStatuses.some((status) => status === 'denied' || status === 'failed')) outcome = 'partial';
  else outcome = teams.length === 0 ? 'complete-empty' : 'complete';

  return {
    workload: TEAMS_CONTENT_WORKLOAD,
    tenantId: tenant,
    outcome,
    observedFrom,
    observedTo: now().toISOString(),
    discovery: { ...discovery, teams: discovered === null ? null : teams.length, capped, maxTeams },
    teams,
    outOfScope,
    requests,
  };
}

/**
 * Channel files live in the team site's document library, which backupSharePointSites
 * stores whole under container `site:<siteId>`. This adapter copies nothing: it answers
 * with a pointer to that site, or null when the folder's site or drive is unknown.
 */
export const SITE_LIBRARY_COVERAGE = Object.freeze({
  async backupDriveFolder({ siteId, driveId, itemId }) {
    if (!siteId || !driveId) return null;
    return { coveredBy: `site:${siteId}`, driveId, itemId: itemId ?? null };
  },
});

/**
 * Backs up every team: reads the containers, asks the sites module who covers each
 * channel folder, and stores one item per team through the content store.
 *
 *  - `store.putItem(stream, meta)` resolves `{ ref, sha256, bytes, deduped }`.
 *  - `sites.backupDriveFolder({ tenantRef, driveId, siteId, itemId, container })` resolves
 *    `{ coveredBy, driveId, itemId }` for a covered folder. Defaults to SITE_LIBRARY_COVERAGE.
 */
export async function backupTeams({ transport, tenantId, tenantRef, store, sites = SITE_LIBRARY_COVERAGE, maxTeams, maxPages, sleep, now = () => new Date() }) {
  if (typeof store?.putItem !== 'function') throw new TypeError('store.putItem is required');
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('tenantRef is required');
  const result = await readTeamContainers({ transport, tenantId, maxTeams, maxPages, sleep, now });
  const items = [];
  let messagesWaiting = 0;
  for (const entry of result.teams) {
    const container = `team:${entry.teamId}`;
    for (const item of entry.channels.items) {
      messagesWaiting += 1;
      if (item.files.status !== 'located') continue;
      if (typeof sites?.backupDriveFolder !== 'function') {
        item.files = { ...item.files, status: 'waiting-on-sites' };
        continue;
      }
      try {
        const backup = await sites.backupDriveFolder({ tenantRef, ...item.files.location, container: `${container}/channel:${item.channelId}` });
        item.files = typeof backup?.coveredBy === 'string' && backup.coveredBy
          ? { ...item.files, status: 'covered-by-site', coveredBy: backup.coveredBy, backup }
          : { ...item.files, status: 'unconfirmed', reason: 'the sites module did not say which backup covers this folder', backup: backup ?? null };
      } catch (error) {
        item.files = { ...item.files, ...failure(error) };
      }
    }
    const document = { schema: 'keel.teams.team/v1', tenantId: result.tenantId, observedAt: result.observedTo, ...entry };
    const json = canonicalJson(document);
    const version = createHash('sha256').update(json).digest('hex');
    const stored = await store.putItem(Readable.from([Buffer.from(json)]), {
      tenantRef,
      workload: TEAMS_CONTENT_WORKLOAD,
      container,
      itemKey: 'team.json',
      version,
      metadata: {
        displayName: entry.fields.displayName,
        channels: Object.fromEntries(CHANNEL_KINDS.map((kind) => [kind, entry.channels.items.filter((item) => item.kind === kind).length])),
        tabs: entry.channels.items.reduce((sum, item) => sum + (item.tabs.items?.length ?? 0), 0),
        installedApps: entry.installedApps.items?.length ?? 0,
        messages: MESSAGES_WAITING.status,
      },
    });
    items.push({ teamId: entry.teamId, container, version, ...stored });
  }
  return { ...result, items, messages: { ...MESSAGES_WAITING, channels: messagesWaiting } };
}
