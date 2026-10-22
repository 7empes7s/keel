/**
 * Wave 1 SITES: SharePoint site backup.
 *
 * Enumerates every site and subsite on the tenant's SharePoint host and stores, per site:
 *  - the site's own properties, its app permission grants, its columns and content types;
 *  - every list (system lists included) with its columns, content types and every item's fields;
 *  - every modern page with its canvas layout (web parts);
 *  - every document library's files through the drive backup (engine/content/drive.mjs).
 *
 * Rules:
 *  - Read-only. Every request is a Graph GET on an allow-listed path. The transport is
 *    never asked for anything else: assertSitesRequest() refuses a non-GET method, a path
 *    outside the list below, or a query key outside $select/$expand/$top/$skiptoken.
 *  - Nothing readable is skipped, nothing unreadable is silent. Parts Graph can't return
 *    (item attachments, item version history, navigation) are listed on every site as
 *    `missing` with the reason. A denied or failed
 *    read is recorded where it happened and makes the run `partial`, never `complete`.
 *  - Tenant scope comes from configuration. A site whose id or URL names another host is
 *    recorded out of scope and never read.
 *  - Change-only on repeat runs. List items are read through Graph list item delta and
 *    library files through drive delta, each resuming from the link saved in `deltaState`
 *    / `libraryState`. A page is fetched again only when its eTag changed, and site and
 *    list settings (which Graph has no delta for) are re-read but stored only when they
 *    changed. An item the delta reports deleted gets a `deleted` record; nothing stored
 *    is removed. A saved link Graph refuses (410, or 400 for a stale link) starts one
 *    full pass, which marks deleted whatever it no longer sees.
 *  - Bounded. Items are stored page by page, so memory does not grow with a list's size.
 *    `maxSites`, `maxDepth` and `maxPages` cap a run, and a capped run is `partial`.
 *  - Site permissions (SharePoint groups and their members, site collection admins,
 *    permission levels and role assignments on the site and on each list with unique
 *    permissions) come from the SharePoint REST API, which Graph does not cover. Reading
 *    role assignments needs Sites.FullControl.All on SharePoint, which the read-only
 *    Content Reader does not hold, so the caller passes `permissionsTransport` built
 *    on the Collector's certificate (it holds that role). Those reads are GETs on the
 *    allow-list in PERMISSION_API_PATHS, on the tenant host only; assertPermissionsRequest()
 *    refuses anything else. Without that transport the part is declared missing.
 *  - Storage goes through the content store interface: putItem(stream, meta) -> { ref, ... }.
 *    Each object is stored as canonical JSON (sorted keys), so an unchanged object
 *    hashes the same on every run and the store deduplicates it.
 */
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

import { syncDrive } from './drive.mjs';

export const SITES_WORKLOAD = 'sharepoint-sites';
export const DEFAULT_MAX_SITES = 5000;
export const DEFAULT_MAX_DEPTH = 10;
export const DEFAULT_MAX_PAGES = 1000;

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SITE = `[a-z0-9.-]+,${GUID},${GUID}`;
const SITE_ID = new RegExp(`^${SITE}$`, 'i');

// Every path this module may read, relative to /v1.0. Nothing else is ever requested.
export const ALLOWED_PATHS = Object.freeze([
  /^\/sites\/getAllSites$/,
  new RegExp(`^/sites/${SITE}$`, 'i'),
  new RegExp(`^/sites/${SITE}/(sites|columns|contentTypes|lists)$`, 'i'),
  new RegExp(`^/sites/${SITE}/lists/${GUID}/(columns|contentTypes|drive)$`, 'i'),
  new RegExp(`^/sites/${SITE}/lists/${GUID}/items/delta$`, 'i'),
  // One item, read only when its delta entry came back without fields.
  new RegExp(`^/sites/${SITE}/lists/${GUID}/items/[0-9]+$`, 'i'),
  new RegExp(`^/sites/${SITE}/pages/microsoft\\.graph\\.sitePage$`, 'i'),
  new RegExp(`^/sites/${SITE}/pages/${GUID}/microsoft\\.graph\\.sitePage$`, 'i'),
]);
const ALLOWED_QUERY = new Set(['$select', '$expand', '$top', '$skiptoken', '$deltatoken', 'token']);
// Version of the per-site and per-list states kept in deltaState.
export const SITE_STATE_VERSION = 1;
export const LIST_STATE_VERSION = 1;

// Parts of a site this backup does not read. Recorded on every site so a backup never
// looks complete when it is not. One of the two permission parts below is added too.
export const MISSING_PARTS = Object.freeze([
  { part: 'site-app-permissions', reason: 'app-only Graph needs Sites.FullControl.All to read site app grants; the Content Reader stays read-only (Sites.Read.All)' },
  { part: 'list-item-attachments', reason: 'binary route: attachments are on the SharePoint REST API, not Graph' },
  { part: 'list-item-versions', reason: 'not read in this release: only the current version of each list item is stored' },
  { part: 'navigation-and-features', reason: 'Graph does not expose site navigation or activated features' },
]);

// Without a SharePoint REST transport, groups and role assignments are not read at all.
export const SITE_PERMISSIONS_MISSING = Object.freeze({
  part: 'site-groups-and-user-permissions',
  reason: 'SharePoint groups and role assignments need the SharePoint REST API as the Collector; no SharePoint transport was given to this run',
});
// With it, only permissions broken on single items and folders are left out.
export const ITEM_PERMISSIONS_MISSING = Object.freeze({
  part: 'item-unique-permissions',
  reason: 'unique permissions on single list items and folders are not read; file sharing in libraries is backed up with the files',
});

// The SharePoint REST reads for site permissions, relative to <site>/_api/. Nothing else is requested.
export const PERMISSION_API_PATHS = Object.freeze([
  /^web$/i,
  /^web\/(roledefinitions|sitegroups|siteusers|roleassignments|lists)$/i,
  /^web\/sitegroups\/getbyid\([0-9]+\)\/users$/i,
  new RegExp(`^web/lists\\(guid'${GUID}'\\)/roleassignments$`, 'i'),
]);
const PERMISSION_QUERY = new Set(['$select', '$expand', '$filter', '$top', '$skiptoken']);
const PRINCIPAL_SELECT = 'Id,Title,LoginName,Email,PrincipalType,IsSiteAdmin,UserPrincipalName';
const GROUP_SELECT = 'Id,Title,Description,LoginName,OwnerTitle,AllowMembersEditMembership,AllowRequestToJoinLeave,'
  + 'AutoAcceptRequestToJoinLeave,OnlyAllowMembersViewMembership,RequestToJoinLeaveEmailSetting';
const ROLE_DEFINITION_SELECT = 'Id,Name,Description,Hidden,RoleTypeKind,Order,BasePermissions';
const ROLE_ASSIGNMENT_QUERY = '$expand=Member,RoleDefinitionBindings'
  + '&$select=PrincipalId,Member/Id,Member/Title,Member/LoginName,Member/PrincipalType,RoleDefinitionBindings/Id,RoleDefinitionBindings/Name';

// List templates whose files live in a drive.
const LIBRARY_TEMPLATES = new Set(['documentLibrary', 'pictureLibrary', 'webPageLibrary', 'assetLibrary', 'formLibrary', 'mySiteDocumentLibrary']);

const SITE_SELECT = 'id,name,displayName,description,webUrl,createdDateTime,lastModifiedDateTime,siteCollection,root,sharepointIds';
const LIST_SELECT = 'id,name,displayName,description,webUrl,createdDateTime,lastModifiedDateTime,list,system,sharepointIds';

/** Throws unless the request is a GET on an allow-listed Graph path with allow-listed query keys. */
export function assertSitesRequest(url, method = 'GET') {
  if (method !== 'GET') throw new Error(`sharepoint sites: refused ${method}: this backup is read-only`);
  const parsed = new URL(url);
  if (parsed.origin !== 'https://graph.microsoft.com' || !parsed.pathname.startsWith('/v1.0/')) {
    throw new Error(`sharepoint sites: refused ${parsed.origin}${parsed.pathname}: not Graph v1.0`);
  }
  const path = decodeURIComponent(parsed.pathname.slice('/v1.0'.length));
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) throw new Error(`sharepoint sites: refused ${path}: not an allow-listed read`);
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_QUERY.has(key)) throw new Error(`sharepoint sites: refused query ${key}`);
  }
  return path;
}

/**
 * Throws unless the request is a GET on the tenant's own SharePoint host, under a site's
 * /_api/, on an allow-listed path with allow-listed query keys. Returns the site path and
 * API path, lower case, so a next page can be held to the same read.
 */
export function assertPermissionsRequest(url, method = 'GET', tenantHost) {
  if (method !== 'GET') throw new Error(`sharepoint sites: refused ${method}: this backup is read-only`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.port || parsed.hostname.toLowerCase() !== String(tenantHost).toLowerCase()) {
    throw new Error(`sharepoint sites: refused ${parsed.origin}: not the tenant's SharePoint host`);
  }
  const path = decodeURIComponent(parsed.pathname);
  const at = path.toLowerCase().indexOf('/_api/');
  const api = at < 0 ? null : path.slice(at + '/_api/'.length);
  if (api === null || !PERMISSION_API_PATHS.some((pattern) => pattern.test(api))) throw new Error(`sharepoint sites: refused ${path}: not an allow-listed read`);
  for (const key of parsed.searchParams.keys()) {
    if (!PERMISSION_QUERY.has(key)) throw new Error(`sharepoint sites: refused query ${key}`);
  }
  return `${path.slice(0, at)}|${api}`.toLowerCase();
}

/** True when a site belongs to the configured tenant host, by both its id and its URL. */
export function siteInScope(site, tenantHost) {
  const host = String(tenantHost).toLowerCase();
  if (!SITE_ID.test(String(site?.id ?? ''))) return false;
  let urlHost = null;
  try { urlHost = new URL(site.webUrl).hostname.toLowerCase(); } catch { urlHost = null; }
  return urlHost === host && String(site.id).split(',')[0].toLowerCase() === host;
}

/** JSON with sorted keys, so the same object always gives the same bytes. */
export function canonicalJson(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sort(input[key])]));
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

function failure(error) {
  const status = error?.status === 401 || error?.status === 403 ? 'denied' : 'failed';
  return { status, httpStatus: Number.isInteger(error?.status) ? error.status : null, error: String(error?.message ?? error) };
}

/**
 * The read side: one GET (with Retry-After) and a pager that refuses a next page on any
 * other path. Every URL passes assertSitesRequest before the transport sees it.
 */
function createReader({ transport, sleep, maxPages, maxRetries = 3, counters, assert = assertSitesRequest }) {
  async function get(url) {
    assert(url, 'GET');
    for (let attempt = 0; ; attempt += 1) {
      counters.requests += 1;
      const response = await transport(url, { method: 'GET' });
      if (response.status === 429 || response.status === 503) {
        counters.throttled += 1;
        if (attempt >= maxRetries) {
          const error = new Error(`still throttled after ${maxRetries} retries: ${new URL(url).pathname}`);
          error.status = response.status;
          throw error;
        }
        const header = typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : response.headers?.['retry-after'];
        const seconds = Number(header);
        await sleep(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempt * 1000);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        const error = new Error(`HTTP ${response.status}: ${new URL(url).pathname}`);
        error.status = response.status;
        throw error;
      }
      return response.body ?? {};
    }
  }

  async function* pages(url) {
    const firstPath = assert(url, 'GET');
    let next = url;
    let count = 0;
    while (next) {
      if (count >= maxPages) {
        const error = new Error(`more than ${maxPages} pages: ${firstPath}`);
        error.capped = true;
        throw error;
      }
      const body = await get(next);
      count += 1;
      yield Array.isArray(body.value) ? body.value : [];
      // Graph names the next page @odata.nextLink; SharePoint REST (nometadata) odata.nextLink.
      const link = body['@odata.nextLink'] ?? body['odata.nextLink'];
      if (!link) return;
      if (assert(link, 'GET') !== firstPath) throw new Error(`refused a next page outside ${firstPath}`);
      next = link;
    }
  }

  async function all(url) {
    const items = [];
    for await (const page of pages(url)) items.push(...page);
    return items;
  }

  return { get, pages, all };
}

const enc = encodeURIComponent;

/** The read-only SharePoint REST reader for site permissions (assertPermissionsRequest on every URL). */
export function createPermissionsReader({ transport, tenantHost, sleep = async () => {}, maxPages = DEFAULT_MAX_PAGES, counters = { requests: 0, throttled: 0 } }) {
  return createReader({ transport, sleep, maxPages, counters, assert: (url, method) => assertPermissionsRequest(url, method, tenantHost) });
}

/**
 * One site's permissions through SharePoint REST: its permission levels, the site
 * collection's groups with their members, its admins, and the role assignments on the
 * site and on each list that breaks inheritance. A subsite that inherits records
 * `roleAssignments: null`. Every list is sorted, so an unchanged site stores nothing.
 * A failed group member or list read is recorded on that group or list and makes the
 * read partial; the rest is still stored. The restore (engine/restore/workloads/
 * sharepointSitePermissions.mjs) reads a site now through this same function, so the
 * backup and the live state compare in one form.
 */
export async function readSitePermissions(permissionsReader, webUrl) {
  const api = `${String(webUrl).replace(/\/+$/, '')}/_api`;
  const byId = (a, b) => Number(a.id ?? a.principalId) - Number(b.id ?? b.principalId);
  const principal = (p) => ({
    id: p?.Id ?? null, title: p?.Title ?? null, loginName: p?.LoginName ?? null, email: p?.Email || null,
    principalType: p?.PrincipalType ?? null, isSiteAdmin: p?.IsSiteAdmin ?? null, userPrincipalName: p?.UserPrincipalName ?? null,
  });
  const assignments = (rows) => rows.map((row) => ({
    principalId: row.PrincipalId ?? row.Member?.Id ?? null,
    member: { id: row.Member?.Id ?? null, title: row.Member?.Title ?? null, loginName: row.Member?.LoginName ?? null, principalType: row.Member?.PrincipalType ?? null },
    roles: (row.RoleDefinitionBindings ?? []).map((role) => ({ id: role.Id ?? null, name: role.Name ?? null })).sort(byId),
  })).sort(byId);
  const failed = [];

  const web = await permissionsReader.get(`${api}/web?$select=Id,Url,HasUniqueRoleAssignments`);
  const roleDefinitions = (await permissionsReader.all(`${api}/web/roledefinitions?$select=${ROLE_DEFINITION_SELECT}`))
    .map((role) => ({
      id: role.Id ?? null, name: role.Name ?? null, description: role.Description ?? null, hidden: role.Hidden ?? null,
      roleTypeKind: role.RoleTypeKind ?? null, order: role.Order ?? null,
      basePermissions: role.BasePermissions ? { high: String(role.BasePermissions.High), low: String(role.BasePermissions.Low) } : null,
    })).sort(byId);
  const groups = [];
  for (const group of await permissionsReader.all(`${api}/web/sitegroups?$select=${GROUP_SELECT}`)) {
    const entry = {
      id: group.Id ?? null, title: group.Title ?? null, description: group.Description ?? null, loginName: group.LoginName ?? null,
      ownerTitle: group.OwnerTitle ?? null, allowMembersEditMembership: group.AllowMembersEditMembership ?? null,
      allowRequestToJoinLeave: group.AllowRequestToJoinLeave ?? null, autoAcceptRequestToJoinLeave: group.AutoAcceptRequestToJoinLeave ?? null,
      onlyAllowMembersViewMembership: group.OnlyAllowMembersViewMembership ?? null, requestToJoinLeaveEmailSetting: group.RequestToJoinLeaveEmailSetting ?? null,
      members: null,
    };
    try {
      entry.members = (await permissionsReader.all(`${api}/web/sitegroups/GetById(${Number(group.Id)})/users?$select=${PRINCIPAL_SELECT}`)).map(principal).sort(byId);
    } catch (error) {
      entry.membersRead = failure(error);
      failed.push({ what: `members of ${entry.title ?? entry.id}`, ...entry.membersRead });
    }
    groups.push(entry);
  }
  groups.sort(byId);
  const siteCollectionAdmins = (await permissionsReader.all(`${api}/web/siteusers?$filter=IsSiteAdmin eq true&$select=${PRINCIPAL_SELECT}`))
    .map(principal).sort(byId);
  const hasUnique = web.HasUniqueRoleAssignments === true;
  const roleAssignments = hasUnique ? assignments(await permissionsReader.all(`${api}/web/roleassignments?${ROLE_ASSIGNMENT_QUERY}`)) : null;
  const lists = [];
  for (const list of await permissionsReader.all(`${api}/web/lists?$select=Id,Title,Hidden,HasUniqueRoleAssignments`)) {
    if (list.HasUniqueRoleAssignments !== true) continue;
    const entry = { id: String(list.Id ?? '').toLowerCase(), title: list.Title ?? null, hidden: list.Hidden ?? null, roleAssignments: null };
    try {
      if (!new RegExp(`^${GUID}$`, 'i').test(entry.id)) throw new Error(`not a list id: ${entry.id}`);
      entry.roleAssignments = assignments(await permissionsReader.all(`${api}/web/lists(guid'${entry.id}')/roleassignments?${ROLE_ASSIGNMENT_QUERY}`));
    } catch (error) {
      entry.read = failure(error);
      failed.push({ what: `list ${entry.title ?? entry.id}`, ...entry.read });
    }
    lists.push(entry);
  }
  lists.sort((a, b) => a.id.localeCompare(b.id));
  return {
    value: {
      web: { id: web.Id ?? null, url: web.Url ?? null, hasUniqueRoleAssignments: hasUnique },
      roleDefinitions, groups, siteCollectionAdmins, roleAssignments, lists,
    },
    failed,
  };
}


// Version of the plain summary saved beside each `site/permissions` item. A stored item
// with an older summary (or none) is stored again on the next run so the portal can read it.
export const PERMISSIONS_SUMMARY_VERSION = 1;
const SYSTEM_LOGINS = /^(SHAREPOINT\\system|c:0\(\.s\|true|i:0i\.t\|00000003-0000-0ff1-ce00-000000000000)/i;
const GUEST = /#ext#|urn%3aspo%3aguest/i;
const OWNER_ROLE = /^full control$/i;
const SHARING_LINK_GROUP = /^SharingLinks\./i;

/**
 * Who can reach a site, in a few counts and names, from a `site/permissions` value. Saved
 * as the item's metadata (plain, unlike the item itself) so the portal's Sites pages can
 * show groups, owners and guests without opening the backup. Names only: no logins or ids.
 */
export function permissionsSummary(value) {
  const groups = Array.isArray(value?.groups) ? value.groups : [];
  const admins = Array.isArray(value?.siteCollectionAdmins) ? value.siteCollectionAdmins : [];
  const assignments = Array.isArray(value?.roleAssignments) ? value.roleAssignments : null;
  const rolesOf = new Map((assignments ?? []).map((row) => [row.principalId, (row.roles ?? []).map((role) => role.name).filter((name) => name && name !== 'Limited Access')]));
  // SharePoint user ids are unique within a site, so they join a group member to an admin.
  const principalKey = (principal) => (principal.id !== null && principal.id !== undefined ? `id:${principal.id}` : principal.loginName ?? principal.title);
  const real = (principal) => principal && !SYSTEM_LOGINS.test(principal.loginName ?? '') && principal.title !== 'System Account';
  const people = new Map();
  const guests = new Set();
  const note = (principal) => {
    if (!real(principal)) return;
    const key = principalKey(principal);
    if (principal.principalType === 1 || principal.principalType === null || principal.principalType === undefined) people.set(key, principal);
    if (GUEST.test(principal.loginName ?? '') || GUEST.test(principal.userPrincipalName ?? '')) guests.add(key);
  };
  const sharingLinks = groups.filter((group) => SHARING_LINK_GROUP.test(group.title ?? ''));
  const shown = groups.filter((group) => !SHARING_LINK_GROUP.test(group.title ?? '') && !/^Limited Access System Group/i.test(group.title ?? ''));
  for (const group of groups) for (const member of group.members ?? []) note(member);
  for (const admin of admins) note(admin);
  for (const row of assignments ?? []) if (row.member?.principalType === 1) note(row.member);
  // Owners: site collection admins, and members of groups given Full Control (or, when the
  // site inherits and roles are not its own, the group SharePoint names "... Owners").
  const ownerGroup = (group) => (assignments ? (rolesOf.get(group.id) ?? []).some((role) => OWNER_ROLE.test(role)) : /\bOwners$/i.test(group.title ?? ''));
  const owners = new Map();
  for (const admin of admins) if (real(admin)) owners.set(principalKey(admin), admin.title ?? null);
  for (const group of shown.filter(ownerGroup)) for (const member of group.members ?? []) if (real(member)) owners.set(principalKey(member), member.title ?? null);
  const ownerNames = [...owners.values()].filter(Boolean).sort((a, b) => a.localeCompare(b));
  return {
    v: PERMISSIONS_SUMMARY_VERSION,
    inherits: assignments === null,
    groups: shown.map((group) => ({
      name: group.title ?? null,
      members: Array.isArray(group.members) ? group.members.filter(real).length : null,
      roles: assignments ? rolesOf.get(group.id) ?? [] : null,
    })),
    owners: ownerNames.slice(0, 20),
    ownerCount: owners.size,
    admins: admins.filter(real).length,
    people: people.size,
    guests: guests.size,
    sharingLinks: sharingLinks.length,
    directRoles: (assignments ?? []).filter((row) => row.member?.principalType === 1).length,
    uniqueLists: Array.isArray(value?.lists) ? value.lists.length : 0,
  };
}

/**
 * Backs up every in-scope site. Pure apart from the injected transport, store and drive
 * backup: no database and no gate.
 *
 * - transport(url, { method }) -> { status, headers, body }
 * - store: the content store interface (putItem(stream, meta) -> { ref, sha256, bytes, deduped }).
 * - backupLibrary({ driveId, siteId, listId, tenantRef, container, store, transport, sleep, state, checkpoint })
 *   backs up one library's files and returns { outcome, ... }. Defaults to the drive backup
 *   (syncDrive in engine/content/drive.mjs). Its transport takes the drive backup's shape,
 *   transport({ method, url, headers }), and is passed on to the sites transport as
 *   transport(url, { method: 'GET', headers }); the sites transport must follow Graph's
 *   download redirect for file content.
 * - libraryState: { load({ siteId, listId, driveId }) -> state | null, save({ siteId, listId, driveId, state }) }
 *   keeps each library's delta state between runs. Without it every run is a full pass
 *   (correct, since the store deduplicates, but slower).
 * - deltaState: { load(key) -> state | null, save(key, state) } keeps each site's stored
 *   settings and page eTags (key `site:<siteId>`) and each list's item delta
 *   (key `items:<siteId>/<listId>`) between runs. Without it every run reads every item.
 * - siteFilter(site) narrows the run (for example to `KEEL-RT-` sites for a live check).
 * - permissionsTransport(url, { method: 'GET' }) -> { status, headers, body } reads the
 *   SharePoint REST API on the tenant host (JSON, odata=nometadata). When given, each
 *   site's groups, members, admins and role assignments are stored as `site/permissions`.
 */
export async function backupSharePointSites({
  transport, store, tenantRef, tenantHost, backupLibrary, libraryState = null, deltaState = null, siteFilter = () => true,
  permissionsTransport = null,
  sleep = async () => {}, now = () => new Date(),
  maxSites = DEFAULT_MAX_SITES, maxDepth = DEFAULT_MAX_DEPTH, maxPages = DEFAULT_MAX_PAGES,
}) {
  if (typeof tenantHost !== 'string' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(tenantHost)) {
    throw new TypeError('tenantHost must be the tenant\'s SharePoint host, such as contoso.sharepoint.com');
  }
  if (typeof store?.putItem !== 'function') throw new TypeError('store must implement putItem');
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('tenantRef is required');
  const library = backupLibrary ?? defaultLibraryBackup();
  const counters = { requests: 0, throttled: 0, stored: 0, deduped: 0, bytes: 0, unchanged: 0, itemsDeleted: 0, resyncs: 0 };
  const loadState = async (key) => (deltaState ? deltaState.load(key) : null);
  const saveState = async (key, state) => { if (deltaState) await deltaState.save(key, state); };
  const reader = createReader({ transport, sleep, maxPages, counters });
  const permissionsReader = permissionsTransport
    ? createPermissionsReader({ transport: permissionsTransport, tenantHost, sleep, maxPages, counters })
    : null;
  const startedAt = now().toISOString();
  // The drive backup reads its own paths, but it gets a transport that still refuses
  // anything except a Graph GET. Response headers reach it as a plain object with
  // lower-case keys, so it can read Retry-After from a fetch-style Headers too.
  const libraryTransport = async ({ method = 'GET', url, headers = {} } = {}) => {
    if (method !== 'GET') throw new Error(`sharepoint sites: refused ${method} from the library backup: this backup is read-only`);
    if (new URL(url).origin !== 'https://graph.microsoft.com') throw new Error(`sharepoint sites: refused ${new URL(url).origin} from the library backup`);
    const response = await transport(url, { method: 'GET', headers });
    const answered = response?.headers;
    if (typeof answered?.entries !== 'function' || typeof answered?.get !== 'function') return response;
    return { ...response, headers: Object.fromEntries([...answered.entries()].map(([key, value]) => [key.toLowerCase(), value])) };
  };

  const put = async (container, itemKey, value, version, metadata = {}) => {
    const bytes = Buffer.from(canonicalJson(value));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const result = await store.putItem(Readable.from([bytes]), {
      tenantRef, workload: SITES_WORKLOAD, container, itemKey,
      version: version ?? sha256,
      metadata: { contentType: 'application/json', ...metadata },
    });
    counters.stored += 1;
    counters.bytes += bytes.length;
    if (result?.deduped) counters.deduped += 1;
    return { ref: result?.ref ?? null, sha256 };
  };

  // Discovery: every site collection, then each one's subsites, breadth first.
  let discovery;
  const queue = [];
  const outOfScope = [];
  const seen = new Set();
  let capped = false;
  const enqueue = (site, parentSiteId, depth) => {
    if (!site?.id || seen.has(site.id)) return;
    seen.add(site.id);
    if (!siteInScope(site, tenantHost)) {
      outOfScope.push({ siteId: String(site.id), webUrl: site.webUrl ?? null });
      return;
    }
    if (!siteFilter(site)) return;
    if (queue.length >= maxSites) { capped = true; return; }
    queue.push({ site, parentSiteId, depth });
  };
  try {
    for await (const page of reader.pages(`${GRAPH}/sites/getAllSites?$select=${SITE_SELECT}`)) {
      for (const site of page) enqueue(site, null, 0);
    }
    discovery = { status: 'observed' };
  } catch (error) {
    if (error.capped) { capped = true; discovery = { status: 'observed' }; } else discovery = failure(error);
  }

  const sites = [];
  for (let index = 0; index < queue.length; index += 1) {
    const { site, parentSiteId, depth } = queue[index];
    const result = await backupSite(site, { parentSiteId, depth });
    sites.push(result);
  }

  async function backupSite(discovered, { parentSiteId, depth }) {
    const siteId = discovered.id;
    const container = `site:${siteId}`;
    const base = `${GRAPH}/sites/${enc(siteId)}`;
    const stateKey = `site:${siteId}`;
    const saved = await loadState(stateKey);
    const previous = saved?.version === SITE_STATE_VERSION ? saved : { stored: {}, pages: {} };
    const next = { version: SITE_STATE_VERSION, stored: {}, pages: {} };
    // Settings Graph has no delta for: read every run, stored only when they changed.
    // `metadata` goes beside the item in plain form; `summary` is its version, and an item
    // stored with an older one is stored again even when the value has not changed.
    const putSetting = async (itemKey, value, version, { metadata, summary } = {}) => {
      const sha256 = createHash('sha256').update(canonicalJson(value)).digest('hex');
      const known = previous.stored[itemKey];
      if (known?.sha256 === sha256 && known.ref && (known.summary ?? null) === (summary ?? null)) {
        counters.unchanged += 1;
        next.stored[itemKey] = known;
        return known.ref;
      }
      const stored = await put(container, itemKey, value, version, metadata);
      next.stored[itemKey] = summary ? { ...stored, summary } : stored;
      return stored.ref;
    };
    const entry = {
      siteId, webUrl: discovered.webUrl ?? null, displayName: discovered.displayName ?? null, parentSiteId,
      refs: {}, reads: {}, lists: [], pages: null, subsites: null,
      missing: [...MISSING_PARTS, permissionsReader ? ITEM_PERMISSIONS_MISSING : SITE_PERMISSIONS_MISSING].map((part) => ({ ...part })),
    };
    // Each read records its own status; a failure in one never hides the others.
    const read = async (name, fn) => {
      try { await fn(); entry.reads[name] = { status: 'observed' }; } catch (error) {
        if (error.capped) { capped = true; entry.reads[name] = { status: 'capped', error: String(error.message) }; } else entry.reads[name] = failure(error);
      }
    };

    await read('site', async () => {
      const body = await reader.get(`${base}?$select=${SITE_SELECT}`);
      entry.refs.site = await putSetting('site', body, body.lastModifiedDateTime);
    });
    await read('columns', async () => {
      entry.refs.columns = await putSetting('site/columns', await reader.all(`${base}/columns`));
    });
    await read('contentTypes', async () => {
      entry.refs.contentTypes = await putSetting('site/contentTypes', await reader.all(`${base}/contentTypes`));
    });

    if (permissionsReader) {
      await read('permissions', async () => {
        const { value, failed } = await readSitePermissions(permissionsReader, discovered.webUrl);
        // Versioned by run as well as content: a site that goes back to an earlier state
        // gets a new row with this run's time, so the latest row is always the state now
        // (the restore picks a backup by time). Unchanged permissions are still not stored.
        const hash = createHash('sha256').update(canonicalJson(value)).digest('hex');
        entry.refs.permissions = await putSetting('site/permissions', value, `sha256:${hash}@${startedAt}`, {
          metadata: { summary: permissionsSummary(value) }, summary: PERMISSIONS_SUMMARY_VERSION,
        });
        if (failed.length) throw Object.assign(new Error(`${failed.length} permission read(s) failed, first ${failed[0].what}: ${failed[0].error}`), { status: failed[0].httpStatus });
      });
    }

    // Subsites go on the queue; each is backed up as a site of its own.
    await read('subsites', async () => {
      const children = await reader.all(`${base}/sites?$select=${SITE_SELECT}`);
      entry.subsites = children.map((child) => child.id);
      if (depth + 1 > maxDepth) {
        if (children.length) capped = true;
        return;
      }
      for (const child of children) enqueue(child, siteId, depth + 1);
    });

    await read('lists', async () => {
      const lists = await reader.all(`${base}/lists?$select=${LIST_SELECT}`);
      for (const list of lists) entry.lists.push(await backupList(list, { siteId, base, container, putSetting }));
    });

    await read('pages', async () => {
      const summaries = await reader.all(`${base}/pages/microsoft.graph.sitePage?$select=id,name,title,eTag,lastModifiedDateTime`);
      const pages = { count: 0, unchanged: 0, failed: [] };
      for (const summary of summaries) {
        // A page whose eTag is the one already stored is not fetched again.
        const tag = summary.eTag ?? summary.lastModifiedDateTime ?? null;
        const known = previous.pages[summary.id];
        if (tag && known?.tag === tag && known.ref) {
          next.pages[summary.id] = known;
          pages.unchanged += 1;
          counters.unchanged += 1;
          continue;
        }
        try {
          const page = await reader.get(`${base}/pages/${enc(summary.id)}/microsoft.graph.sitePage?$expand=canvasLayout`);
          const { ref } = await put(container, `page/${summary.id}`, page, page.eTag ?? page.lastModifiedDateTime);
          if (tag) next.pages[summary.id] = { tag, ref };
          pages.count += 1;
        } catch (error) {
          pages.failed.push({ pageId: summary.id, ...failure(error) });
        }
      }
      entry.pages = pages;
      if (pages.failed.length) throw Object.assign(new Error(`${pages.failed.length} page(s) not read`), { status: pages.failed[0].httpStatus });
    });

    // A part that failed this run is left out, so the next run stores it again.
    await saveState(stateKey, next);
    return entry;
  }

  async function backupList(list, { siteId, base, container, putSetting }) {
    const listBase = `${base}/lists/${enc(list.id)}`;
    const template = list.list?.template ?? null;
    const entry = { listId: list.id, displayName: list.displayName ?? list.name ?? null, template, refs: {}, reads: {}, items: 0, library: null };
    const read = async (name, fn) => {
      try { await fn(); entry.reads[name] = { status: 'observed' }; } catch (error) {
        if (error.capped) { capped = true; entry.reads[name] = { status: 'capped', error: String(error.message) }; } else entry.reads[name] = failure(error);
      }
    };
    await read('list', async () => {
      entry.refs.list = await putSetting(`list/${list.id}`, list, list.lastModifiedDateTime);
    });
    await read('columns', async () => {
      entry.refs.columns = await putSetting(`list/${list.id}/columns`, await reader.all(`${listBase}/columns`));
    });
    await read('contentTypes', async () => {
      entry.refs.contentTypes = await putSetting(`list/${list.id}/contentTypes`, await reader.all(`${listBase}/contentTypes`));
    });
    // Item fields for every list, libraries included: a library's custom column values
    // live on its list items, not in the drive. Read through list item delta: a repeat
    // run reads only what changed since the saved link.
    await read('items', async () => {
      const key = `items:${siteId}/${list.id}`;
      const synced = await syncListItems({
        listBase, container, listId: list.id, state: await loadState(key),
        checkpoint: (state) => saveState(key, state),
      });
      entry.items = synced.stored;
      entry.itemsDeleted = synced.deleted;
    });
    if (LIBRARY_TEMPLATES.has(template)) {
      await read('library', async () => {
        const drive = await reader.get(`${listBase}/drive?$select=id,driveType,name,webUrl`);
        entry.library = { driveId: drive.id ?? null };
        const key = { siteId, listId: list.id, driveId: drive.id };
        let result;
        try {
          result = await library({
            ...key, tenantRef, container, store, transport: libraryTransport, sleep,
            state: libraryState ? await libraryState.load(key) : null,
            checkpoint: async (state) => { if (libraryState) await libraryState.save({ ...key, state }); },
          });
        } catch (error) {
          entry.library.status = failure(error).status;
          throw error;
        }
        entry.library.result = result;
        entry.library.status = ['complete', 'complete-empty'].includes(result?.outcome) ? 'observed' : 'partial';
      });
    }
    return entry;
  }

  /**
   * One list's items through Graph list item delta. The state keeps the next or delta
   * link and each known item's eTag (null once deleted), so a replayed page or a full
   * pass after a resync stores nothing that is already stored.
   */
  async function syncListItems({ listBase, container, listId, state, checkpoint }) {
    const current = state?.version === LIST_STATE_VERSION
      ? structuredClone(state)
      : { version: LIST_STATE_VERSION, nextLink: null, deltaLink: null, fullPass: null, items: {} };
    const first = `${listBase}/items/delta?$expand=fields`;
    // Paths compare without case: Graph may echo site ids and GUIDs in another case.
    const pathOf = (link) => assertSitesRequest(link, 'GET').toLowerCase();
    const deltaPath = pathOf(first);
    const result = { stored: 0, deleted: 0, pages: 0, resynced: false };
    const itemKey = (id) => `list/${listId}/item/${id}`;
    const startFullPass = () => {
      current.nextLink = null;
      current.deltaLink = null;
      current.fullPass = { seen: {} };
      return first;
    };
    const markDeleted = async (id) => {
      const known = current.items[id];
      if (known === undefined || known === null) return;
      current.items[id] = null;
      await put(container, itemKey(id), { id, deleted: true }, `deleted:${known}`);
      result.deleted += 1;
      counters.itemsDeleted += 1;
    };
    const onSavedPath = (link) => {
      try { return pathOf(link) === deltaPath; } catch { return false; }
    };

    let link = current.nextLink ?? current.deltaLink;
    // A saved link for another path (or a malformed one) is dropped, never followed.
    if (!link || !onSavedPath(link)) link = startFullPass();
    let fromSaved = link !== first;
    while (link) {
      if (result.pages >= maxPages) throw Object.assign(new Error(`more than ${maxPages} pages: ${deltaPath}`), { capped: true });
      if (pathOf(link) !== deltaPath) throw new Error(`refused a next page outside ${deltaPath}`);
      let body;
      try {
        body = await reader.get(link);
      } catch (error) {
        // An expired link (410) or one Graph no longer accepts (400): one full pass.
        if ((error.status === 410 || (error.status === 400 && fromSaved)) && !result.resynced) {
          result.resynced = true;
          counters.resyncs += 1;
          link = startFullPass();
          fromSaved = false;
          continue;
        }
        throw error;
      }
      result.pages += 1;
      for (const item of Array.isArray(body.value) ? body.value : []) {
        const id = String(item.id);
        if (current.fullPass) current.fullPass.seen[id] = true;
        if (item.deleted) { await markDeleted(id); continue; }
        const tag = item.eTag ?? item.lastModifiedDateTime ?? null;
        if (tag && current.items[id] === tag) continue;
        let full = item;
        if (!item.fields) {
          try {
            full = await reader.get(`${listBase}/items/${enc(id)}?$expand=fields`);
          } catch (error) {
            // Gone between the delta page and the read: a deletion, not a failed page.
            if (error.status !== 404) throw error;
            await markDeleted(id);
            continue;
          }
        }
        await put(container, itemKey(id), full, full.eTag ?? full.lastModifiedDateTime);
        current.items[id] = full.eTag ?? full.lastModifiedDateTime ?? tag;
        result.stored += 1;
      }
      const nextLink = body['@odata.nextLink'];
      if (nextLink) {
        current.nextLink = nextLink;
        link = nextLink;
      } else {
        if (current.fullPass) {
          // Whatever a full pass did not see is gone from the list.
          for (const id of Object.keys(current.items)) if (!current.fullPass.seen[id]) await markDeleted(id);
          current.fullPass = null;
        }
        current.nextLink = null;
        current.deltaLink = body['@odata.deltaLink'] ?? null;
        if (!current.deltaLink) throw new Error(`the last delta page carried no delta link: ${deltaPath}`);
        link = null;
      }
      fromSaved = false;
      await checkpoint(structuredClone(current));
    }
    return result;
  }

  const statuses = sites.flatMap((site) => [
    ...Object.values(site.reads).map((read) => read.status),
    ...site.lists.flatMap((list) => [...Object.values(list.reads).map((read) => read.status), ...(list.library ? [list.library.status ?? 'failed'] : [])]),
  ]);
  let outcome;
  if (discovery.status !== 'observed') outcome = 'failed';
  else if (capped || statuses.some((status) => status !== 'observed')) outcome = 'partial';
  else outcome = sites.length === 0 ? 'complete-empty' : 'complete';

  return {
    workload: SITES_WORKLOAD,
    tenantHost,
    outcome,
    startedAt,
    finishedAt: now().toISOString(),
    discovery,
    capped,
    counters,
    outOfScope,
    sites,
  };
}

/**
 * The drive backup (syncDrive) adapted to one document library. Files land in the
 * site's own container under the sites workload. A file Graph would not hand over is a
 * warning from syncDrive and makes the library `partial`; a failed or denied read throws
 * (DriveSyncError carries the HTTP status) and is recorded where it happened.
 */
export function defaultLibraryBackup({ sync = syncDrive } = {}) {
  return async ({ driveId, tenantRef, container, store, transport, sleep, state, checkpoint }) => {
    const { stats } = await sync({
      transport, store, driveId, tenantRef, workload: SITES_WORKLOAD, container, state, checkpoint, sleep,
    });
    return { outcome: stats.warnings.length ? 'partial' : 'complete', stats };
  };
}
