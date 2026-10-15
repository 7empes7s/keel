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
 *  - Change-only on repeat runs. List items are read through Graph list item delta and
 *    library files through drive delta, each resuming from the link saved in `deltaState`
 *    / `libraryState`. A page is fetched again only when its eTag changed, and site and
 *    list settings (which Graph has no delta for) are re-read but stored only when they
 *    changed. An item the delta reports deleted gets a `deleted` record; nothing stored
 *    is removed. A saved link Graph refuses (410, or 400 for a stale link) starts one
 *    full pass, which marks deleted whatever it no longer sees.
 *  - Bounded. Items are stored page by page, so memory does not grow with a list's size.
 *    `maxSites`, `maxDepth` and `maxPages` cap a run, and a capped run is `partial`.
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

// Parts of a site Graph v1.0 does not return. Recorded on every site so a backup never
// looks complete when it is not.
export const MISSING_PARTS = Object.freeze([
  { part: 'site-app-permissions', reason: 'app-only Graph needs Sites.FullControl.All to read site app grants; the Content Reader stays read-only (Sites.Read.All)' },
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
 */
export async function backupSharePointSites({
  transport, store, tenantRef, tenantHost, backupLibrary, libraryState = null, deltaState = null, siteFilter = () => true,
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
    const putSetting = async (itemKey, value, version) => {
      const sha256 = createHash('sha256').update(canonicalJson(value)).digest('hex');
      const known = previous.stored[itemKey];
      if (known?.sha256 === sha256 && known.ref) {
        counters.unchanged += 1;
        next.stored[itemKey] = known;
        return known.ref;
      }
      const stored = await put(container, itemKey, value, version);
      next.stored[itemKey] = stored;
      return stored.ref;
    };
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
      entry.refs.site = await putSetting('site', body, body.lastModifiedDateTime);
    });
    await read('columns', async () => {
      entry.refs.columns = await putSetting('site/columns', await reader.all(`${base}/columns`));
    });
    await read('contentTypes', async () => {
      entry.refs.contentTypes = await putSetting('site/contentTypes', await reader.all(`${base}/contentTypes`));
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
    const deltaPath = assertSitesRequest(first, 'GET');
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
      try { return assertSitesRequest(link, 'GET') === deltaPath; } catch { return false; }
    };

    let link = current.nextLink ?? current.deltaLink;
    // A saved link for another path (or a malformed one) is dropped, never followed.
    if (!link || !onSavedPath(link)) link = startFullPass();
    let fromSaved = link !== first;
    while (link) {
      if (result.pages >= maxPages) throw Object.assign(new Error(`more than ${maxPages} pages: ${deltaPath}`), { capped: true });
      if (assertSitesRequest(link, 'GET') !== deltaPath) throw new Error(`refused a next page outside ${deltaPath}`);
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
        const full = item.fields ? item : await reader.get(`${listBase}/items/${enc(id)}?$expand=fields`);
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
