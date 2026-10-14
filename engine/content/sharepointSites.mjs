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
 *    (SharePoint groups and user role assignments, item attachments, item version history,
 *    navigation) are listed on every site as `missing` with the reason. A denied or failed
 *    read is recorded where it happened and makes the run `partial`, never `complete`.
 *  - Tenant scope comes from configuration. A site whose id or URL names another host is
 *    recorded out of scope and never read.
 *  - Bounded. Items are stored page by page, so memory does not grow with a list's size.
 *    `maxSites`, `maxDepth` and `maxPages` cap a run, and a capped run is `partial`.
 *  - Storage goes through the content store interface: putItem(stream, meta) -> { ref, ... }.
 *    Each object is stored as canonical JSON (sorted keys), so an unchanged object
 *    hashes the same on every run and the store deduplicates it.
 */
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

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
  new RegExp(`^/sites/${SITE}/(sites|permissions|columns|contentTypes|lists)$`, 'i'),
  new RegExp(`^/sites/${SITE}/lists/${GUID}/(columns|contentTypes|items|drive)$`, 'i'),
  new RegExp(`^/sites/${SITE}/pages/microsoft\\.graph\\.sitePage$`, 'i'),
  new RegExp(`^/sites/${SITE}/pages/${GUID}/microsoft\\.graph\\.sitePage$`, 'i'),
]);
const ALLOWED_QUERY = new Set(['$select', '$expand', '$top', '$skiptoken']);

// Parts of a site Graph v1.0 does not return. Recorded on every site so a backup never
// looks complete when it is not.
export const MISSING_PARTS = Object.freeze([
  { part: 'site-groups-and-user-permissions', reason: 'Graph returns only app grants; SharePoint groups and user role assignments need the SharePoint REST API, which is not qualified' },
  { part: 'list-item-attachments', reason: 'binary route: attachments are on the SharePoint REST API, not Graph' },
  { part: 'list-item-versions', reason: 'not read in this release: only the current version of each list item is stored' },
  { part: 'navigation-and-features', reason: 'Graph does not expose site navigation or activated features' },
]);

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
function createReader({ transport, sleep, maxPages, maxRetries = 3, counters }) {
  async function get(url) {
    assertSitesRequest(url, 'GET');
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
    const firstPath = assertSitesRequest(url, 'GET');
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
      const link = body['@odata.nextLink'];
      if (!link) return;
      if (assertSitesRequest(link, 'GET') !== firstPath) throw new Error(`refused a next page outside ${firstPath}`);
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

/**
 * Backs up every in-scope site. Pure apart from the injected transport, store and drive
 * backup: no database and no gate.
 *
 * - transport(url, { method }) -> { status, headers, body }
 * - store: the content store interface (putItem(stream, meta) -> { ref, sha256, bytes, deduped }).
 * - backupLibrary({ driveId, siteId, listId, tenantRef, container, store, transport, sleep })
 *   backs up one library's files. Defaults to engine/content/drive.mjs's backupDrive when
 *   that module exists; until then each library is recorded as waiting on the drive backup.
 * - siteFilter(site) narrows the run (for example to `KEEL-RT-` sites for a live check).
 */
export async function backupSharePointSites({
  transport, store, tenantRef, tenantHost, backupLibrary, siteFilter = () => true,
  sleep = async () => {}, now = () => new Date(),
  maxSites = DEFAULT_MAX_SITES, maxDepth = DEFAULT_MAX_DEPTH, maxPages = DEFAULT_MAX_PAGES,
}) {
  if (typeof tenantHost !== 'string' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(tenantHost)) {
    throw new TypeError('tenantHost must be the tenant\'s SharePoint host, such as contoso.sharepoint.com');
  }
  if (typeof store?.putItem !== 'function') throw new TypeError('store must implement putItem');
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('tenantRef is required');
  const library = backupLibrary ?? await defaultLibraryBackup();
  const counters = { requests: 0, throttled: 0, stored: 0, deduped: 0, bytes: 0 };
  const reader = createReader({ transport, sleep, maxPages, counters });
  const startedAt = now().toISOString();
  // The drive backup reads its own paths, but it gets a transport that still refuses
  // anything except a Graph GET.
  const libraryTransport = (url, { method = 'GET', ...rest } = {}) => {
    if (method !== 'GET') throw new Error(`sharepoint sites: refused ${method} from the library backup: this backup is read-only`);
    if (new URL(url).origin !== 'https://graph.microsoft.com') throw new Error(`sharepoint sites: refused ${new URL(url).origin} from the library backup`);
    return transport(url, { ...rest, method: 'GET' });
  };

  const put = async (container, itemKey, value, version) => {
    const bytes = Buffer.from(canonicalJson(value));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const result = await store.putItem(Readable.from([bytes]), {
      tenantRef, workload: SITES_WORKLOAD, container, itemKey,
      version: version ?? sha256,
      metadata: { contentType: 'application/json' },
    });
    counters.stored += 1;
    counters.bytes += bytes.length;
    if (result?.deduped) counters.deduped += 1;
    return result?.ref ?? null;
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
    const entry = {
      siteId, webUrl: discovered.webUrl ?? null, displayName: discovered.displayName ?? null, parentSiteId,
      refs: {}, reads: {}, lists: [], pages: null, subsites: null,
      missing: MISSING_PARTS.map((part) => ({ ...part })),
    };
    // Each read records its own status; a failure in one never hides the others.
    const read = async (name, fn) => {
      try { await fn(); entry.reads[name] = { status: 'observed' }; } catch (error) {
        if (error.capped) { capped = true; entry.reads[name] = { status: 'capped', error: String(error.message) }; } else entry.reads[name] = failure(error);
      }
    };

    await read('site', async () => {
      const body = await reader.get(`${base}?$select=${SITE_SELECT}`);
      entry.refs.site = await put(container, 'site', body, body.lastModifiedDateTime);
    });
    await read('permissions', async () => {
      entry.refs.permissions = await put(container, 'site/permissions', await reader.all(`${base}/permissions`));
    });
    await read('columns', async () => {
      entry.refs.columns = await put(container, 'site/columns', await reader.all(`${base}/columns`));
    });
    await read('contentTypes', async () => {
      entry.refs.contentTypes = await put(container, 'site/contentTypes', await reader.all(`${base}/contentTypes`));
    });

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
      for (const list of lists) entry.lists.push(await backupList(list, { siteId, base, container }));
    });

    await read('pages', async () => {
      const summaries = await reader.all(`${base}/pages/microsoft.graph.sitePage?$select=id,name,title,eTag,lastModifiedDateTime`);
      const pages = { count: 0, failed: [] };
      for (const summary of summaries) {
        try {
          const page = await reader.get(`${base}/pages/${enc(summary.id)}/microsoft.graph.sitePage?$expand=canvasLayout`);
          await put(container, `page/${summary.id}`, page, page.eTag ?? page.lastModifiedDateTime);
          pages.count += 1;
        } catch (error) {
          pages.failed.push({ pageId: summary.id, ...failure(error) });
        }
      }
      entry.pages = pages;
      if (pages.failed.length) throw Object.assign(new Error(`${pages.failed.length} page(s) not read`), { status: pages.failed[0].httpStatus });
    });

    return entry;
  }

  async function backupList(list, { siteId, base, container }) {
    const listBase = `${base}/lists/${enc(list.id)}`;
    const template = list.list?.template ?? null;
    const entry = { listId: list.id, displayName: list.displayName ?? list.name ?? null, template, refs: {}, reads: {}, items: 0, library: null };
    const read = async (name, fn) => {
      try { await fn(); entry.reads[name] = { status: 'observed' }; } catch (error) {
        if (error.capped) { capped = true; entry.reads[name] = { status: 'capped', error: String(error.message) }; } else entry.reads[name] = failure(error);
      }
    };
    await read('list', async () => {
      entry.refs.list = await put(container, `list/${list.id}`, list, list.lastModifiedDateTime);
    });
    await read('columns', async () => {
      entry.refs.columns = await put(container, `list/${list.id}/columns`, await reader.all(`${listBase}/columns`));
    });
    await read('contentTypes', async () => {
      entry.refs.contentTypes = await put(container, `list/${list.id}/contentTypes`, await reader.all(`${listBase}/contentTypes`));
    });
    // Item fields for every list, libraries included: a library's custom column values
    // live on its list items, not in the drive.
    await read('items', async () => {
      for await (const page of reader.pages(`${listBase}/items?$expand=fields`)) {
        for (const item of page) {
          await put(container, `list/${list.id}/item/${item.id}`, item, item.eTag ?? item.lastModifiedDateTime);
          entry.items += 1;
        }
      }
    });
    if (LIBRARY_TEMPLATES.has(template)) {
      await read('library', async () => {
        const drive = await reader.get(`${listBase}/drive?$select=id,driveType,name,webUrl`);
        entry.library = { driveId: drive.id ?? null };
        const result = await library({
          driveId: drive.id, siteId, listId: list.id, tenantRef, container, store, transport: libraryTransport, sleep,
        });
        entry.library.result = result;
        entry.library.status = result?.outcome === 'waiting' ? 'waiting' : (['complete', 'complete-empty'].includes(result?.outcome) ? 'observed' : 'partial');
      });
    }
    return entry;
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
 * The drive backup from engine/content/drive.mjs when it exists. Until it merges, each
 * library is recorded as `waiting` (the run is then `partial`), never as backed up.
 */
export async function defaultLibraryBackup() {
  let drive = null;
  try {
    drive = await import('./drive.mjs');
  } catch (error) {
    // Only a missing drive.mjs itself means "not merged yet"; any other failure is real.
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.url ?? error.message).includes('content/drive.mjs')) throw error;
  }
  if (typeof drive?.backupDrive === 'function') return (options) => drive.backupDrive(options);
  return async () => ({ outcome: 'waiting', reason: 'library files wait on the drive backup (engine/content/drive.mjs), which is not merged yet' });
}
