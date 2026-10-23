// Wave 1 SITES: SharePoint site backup.
//
// Done-test: a fixture site with a list, a page and a library is fully captured.
// Also: every request is a GET on an allow-listed path, a denied read is partial
// coverage, a site on another host is never read, a second run stores nothing new,
// and a library's files go through the drive backup (syncDrive) into the site's container.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  ITEM_PERMISSIONS_MISSING, MISSING_PARTS, SITE_PERMISSIONS_MISSING, assertPermissionsRequest, assertSitesRequest,
  PERMISSIONS_SUMMARY_VERSION, backupSharePointSites, canonicalJson, defaultLibraryBackup, permissionsSummary,
} from './sharepointSites.mjs';
import { createMemoryContentStore } from './store.mjs';
import { loadSitePermissionsSource } from '../restore/workloads/sharepointSitePermissions.mjs';

const HOST = 'contoso.sharepoint.com';
const G = 'https://graph.microsoft.com/v1.0';
const ROOT = `${HOST},11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222`;
const SUB = `${HOST},11111111-1111-1111-1111-111111111111,33333333-3333-3333-3333-333333333333`;
const OTHER = 'fabrikam.sharepoint.com,44444444-4444-4444-4444-444444444444,55555555-5555-5555-5555-555555555555';
const LIST = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const LIB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PAGE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SUBLIST = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// The content store interface, in memory: dedupe by sha256 of the bytes.
function memoryStore() {
  const blobs = new Map();
  const items = [];
  return {
    items,
    async putItem(stream, meta) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const deduped = blobs.has(sha256);
      blobs.set(sha256, bytes);
      const ref = `mem:${sha256}`;
      items.push({ ref, ...meta });
      return { ref, sha256, bytes: bytes.length, deduped };
    },
    async getItem(ref) { return blobs.get(ref.slice(4)); },
    async listItems({ container }) { return items.filter((item) => item.container === container); },
  };
}

const itemsDeltaLink = (siteId, listId, token = 'latest-1') => `${G}/sites/${encodeURIComponent(siteId)}/lists/${listId}/items/delta?token=${token}`;
const site = (id, name) => ({ id, name, displayName: name, webUrl: `https://${id.split(',')[0]}/sites/${name}` });

function fixtureRoutes() {
  const root = site(ROOT, 'KEEL-RT-Site');
  const sub = { ...site(SUB, 'KEEL-RT-Site/Sub') };
  return {
    '/sites/getAllSites': [{ value: [root, site(OTHER, 'KEEL-RT-Elsewhere')], '@odata.nextLink': `${G}/sites/getAllSites?$skiptoken=2` }, { value: [root, site(`${HOST},66666666-6666-6666-6666-666666666666,77777777-7777-7777-7777-777777777777`, 'Finance')] }],
    [`/sites/${ROOT}`]: { ...root, lastModifiedDateTime: '2026-10-01T00:00:00Z' },
    [`/sites/${ROOT}/columns`]: { value: [{ id: 'col-1', name: 'Region' }] },
    [`/sites/${ROOT}/contentTypes`]: { value: [{ id: '0x01', name: 'Item' }] },
    [`/sites/${ROOT}/sites`]: { value: [sub] },
    [`/sites/${ROOT}/lists`]: { value: [
      { id: LIST, displayName: 'KEEL-RT-Tasks', list: { template: 'genericList' } },
      { id: LIB, displayName: 'Documents', list: { template: 'documentLibrary' } },
    ] },
    [`/sites/${ROOT}/lists/${LIST}/columns`]: { value: [{ id: 'col-2', name: 'Title' }] },
    [`/sites/${ROOT}/lists/${LIST}/contentTypes`]: { value: [{ id: '0x0100', name: 'Item' }] },
    [`/sites/${ROOT}/lists/${LIST}/items/delta`]: [
      { value: [{ id: '1', eTag: 'e1', fields: { Title: 'one' } }, { id: '2', eTag: 'e2', fields: { Title: 'two' } }], '@odata.nextLink': `${G}/sites/${encodeURIComponent(ROOT)}/lists/${LIST}/items/delta?token=page-2` },
      { value: [{ id: '3', eTag: 'e3', fields: { Title: 'three' } }], '@odata.deltaLink': itemsDeltaLink(ROOT, LIST) },
    ],
    [`/sites/${ROOT}/lists/${LIB}/columns`]: { value: [] },
    [`/sites/${ROOT}/lists/${LIB}/contentTypes`]: { value: [{ id: '0x0101', name: 'Document' }] },
    [`/sites/${ROOT}/lists/${LIB}/items/delta`]: { value: [{ id: '1', eTag: 'd1', fields: { FileLeafRef: 'KEEL-RT-a.docx', Region: 'EU' } }], '@odata.deltaLink': itemsDeltaLink(ROOT, LIB) },
    [`/sites/${ROOT}/lists/${LIB}/drive`]: { id: 'b!drive-1', driveType: 'documentLibrary' },
    [`/sites/${ROOT}/pages/microsoft.graph.sitePage`]: { value: [{ id: PAGE, name: 'Home.aspx', eTag: 'p1' }] },
    [`/sites/${ROOT}/pages/${PAGE}/microsoft.graph.sitePage`]: { id: PAGE, title: 'Home', eTag: 'p1', canvasLayout: { horizontalSections: [{ id: '1', columns: [{ webparts: [{ id: 'wp', innerHtml: '<p>Hi</p>' }] }] }] } },
    [`/sites/${SUB}`]: sub,
    [`/sites/${SUB}/columns`]: { value: [] },
    [`/sites/${SUB}/contentTypes`]: { value: [] },
    [`/sites/${SUB}/sites`]: { value: [] },
    [`/sites/${SUB}/lists`]: { value: [{ id: SUBLIST, displayName: 'KEEL-RT-Sub list', list: { template: 'genericList' } }] },
    [`/sites/${SUB}/lists/${SUBLIST}/columns`]: { value: [] },
    [`/sites/${SUB}/lists/${SUBLIST}/contentTypes`]: { value: [] },
    [`/sites/${SUB}/lists/${SUBLIST}/items/delta`]: { value: [{ id: '1', eTag: 's1', fields: { Title: 'sub' } }], '@odata.deltaLink': itemsDeltaLink(SUB, SUBLIST) },
    [`/sites/${SUB}/pages/microsoft.graph.sitePage`]: { value: [] },
  };
}

// A fake Graph: answers from the routes; a route that is an array is paged by $skiptoken or token.
function fakeGraph(routes, { override = {} } = {}) {
  const requests = [];
  const transport = async (url, { method, headers } = {}) => {
    requests.push({ url, method, headers });
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname.slice('/v1.0'.length));
    if (override[path]) return override[path](parsed);
    const route = routes[path];
    if (route === undefined) return { status: 404, headers: {}, body: { error: { code: 'itemNotFound' } } };
    if (Array.isArray(route)) return { status: 200, headers: {}, body: route[parsed.searchParams.get('$skiptoken') || parsed.searchParams.get('token') ? 1 : 0] };
    return { status: 200, headers: {}, body: route };
  };
  return { transport, requests };
}

const keelRt = (candidate) => /^KEEL-RT-/.test(candidate.name ?? '');
const completeLibrary = (calls) => async (options) => { calls.push(options); return { outcome: 'complete', files: 1 }; };

test('a fixture site with a list, a page, a library and a subsite is fully captured', async () => {
  const { transport } = fakeGraph(fixtureRoutes());
  const store = memoryStore();
  const libraryCalls = [];
  const result = await backupSharePointSites({
    transport, store, tenantRef: 'tenant-a', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary(libraryCalls),
  });

  assert.equal(result.outcome, 'complete');
  assert.deepEqual(result.sites.map((entry) => entry.siteId), [ROOT, SUB]);
  assert.equal(result.sites[1].parentSiteId, ROOT);
  const keys = store.items.filter((item) => item.container === `site:${ROOT}`).map((item) => item.itemKey).sort();
  assert.deepEqual(keys, [
    `list/${LIB}`, `list/${LIB}/columns`, `list/${LIB}/contentTypes`, `list/${LIB}/item/1`,
    `list/${LIST}`, `list/${LIST}/columns`, `list/${LIST}/contentTypes`,
    `list/${LIST}/item/1`, `list/${LIST}/item/2`, `list/${LIST}/item/3`,
    `page/${PAGE}`, 'site', 'site/columns', 'site/contentTypes',
  ].sort());
  assert.ok(store.items.every((item) => item.workload === 'sharepoint-sites' && item.tenantRef === 'tenant-a'));
  assert.ok(store.items.some((item) => item.container === `site:${SUB}` && item.itemKey === `list/${SUBLIST}/item/1`));

  // The page is stored with its web parts, read back byte-identical.
  const pageRef = store.items.find((item) => item.itemKey === `page/${PAGE}`).ref;
  const page = JSON.parse(String(await store.getItem(pageRef)));
  assert.equal(page.canvasLayout.horizontalSections[0].columns[0].webparts[0].innerHtml, '<p>Hi</p>');

  // The library's files went to the drive backup, with its drive id; the list items
  // (custom column values) were stored here.
  assert.equal(libraryCalls.length, 1);
  assert.equal(libraryCalls[0].driveId, 'b!drive-1');
  assert.equal(libraryCalls[0].container, `site:${ROOT}`);
  const libraryEntry = result.sites[0].lists.find((list) => list.listId === LIB);
  assert.equal(libraryEntry.library.status, 'observed');
  assert.equal(result.sites[0].lists.find((list) => list.listId === LIST).items, 3);

  // What Graph can't return is listed, never silently missing.
  // Without a SharePoint REST transport, groups and role assignments are declared missing.
  assert.deepEqual(result.sites[0].missing.map((part) => part.part), [...MISSING_PARTS, SITE_PERMISSIONS_MISSING].map((part) => part.part));
  assert.ok(MISSING_PARTS.some((part) => part.part === 'site-app-permissions'));
  assert.equal(result.sites[0].reads.permissions, undefined);
});

test('every request is a GET on an allow-listed path, and other hosts are never read', async () => {
  const { transport, requests } = fakeGraph(fixtureRoutes());
  const result = await backupSharePointSites({ transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, backupLibrary: completeLibrary([]) });
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.equal(request.method, 'GET');
    assert.doesNotThrow(() => assertSitesRequest(request.url, request.method));
  }
  assert.ok(!requests.some((request) => request.url.includes('fabrikam')));
  assert.deepEqual(result.outOfScope.map((entry) => entry.siteId), [OTHER]);
  // The site listed on both discovery pages is backed up once.
  assert.equal(result.sites.filter((entry) => entry.siteId === ROOT).length, 1);
});

test('assertSitesRequest refuses writes, content paths outside the list, other hosts and unknown query keys', () => {
  const ok = `${G}/sites/${encodeURIComponent(ROOT)}/lists/${LIST}/items/delta?$expand=fields&token=abc`;
  assert.doesNotThrow(() => assertSitesRequest(ok));
  assert.throws(() => assertSitesRequest(ok, 'POST'), /read-only/);
  assert.throws(() => assertSitesRequest(ok, 'PATCH'), /read-only/);
  assert.doesNotThrow(() => assertSitesRequest(`${G}/sites/${encodeURIComponent(ROOT)}/lists/${LIST}/items/1?$expand=fields`));
  assert.throws(() => assertSitesRequest(`${G}/sites/${encodeURIComponent(ROOT)}/lists/${LIST}/items?$expand=fields`), /not an allow-listed read/);
  assert.throws(() => assertSitesRequest(`${G}/sites/${encodeURIComponent(ROOT)}/lists/${LIST}/items/1/versions`), /not an allow-listed read/);
  assert.throws(() => assertSitesRequest(`${G}/drives/b!x/items/root/children`), /not an allow-listed read/);
  // Site app grants need Sites.FullControl.All; the read-only reader declares them missing instead (#264).
  assert.throws(() => assertSitesRequest(`${G}/sites/${encodeURIComponent(ROOT)}/permissions`), /not an allow-listed read/);
  assert.throws(() => assertSitesRequest(`${G}/sites/${encodeURIComponent(ROOT)}/lists?$filter=x`), /refused query/);
  assert.throws(() => assertSitesRequest(`https://evil.example/v1.0/sites/getAllSites`), /not Graph v1.0/);
  assert.throws(() => assertSitesRequest(`https://graph.microsoft.com/beta/sites/getAllSites`), /not Graph v1.0/);
});

test('a denied read is partial coverage and the rest of the site is still captured', async () => {
  const { transport } = fakeGraph(fixtureRoutes(), {
    override: { [`/sites/${ROOT}/lists/${LIST}/items/delta`]: () => ({ status: 403, headers: {}, body: {} }) },
  });
  const store = memoryStore();
  const result = await backupSharePointSites({ transport, store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]) });
  assert.equal(result.outcome, 'partial');
  const list = result.sites[0].lists.find((entry) => entry.listId === LIST);
  assert.equal(list.reads.items.status, 'denied');
  assert.equal(list.reads.items.httpStatus, 403);
  assert.ok(store.items.some((item) => item.itemKey === `page/${PAGE}`));
  assert.ok(store.items.some((item) => item.itemKey === `list/${LIB}/item/1`));
});

test('a failed discovery is a failed run, never an empty success', async () => {
  const { transport } = fakeGraph(fixtureRoutes(), { override: { '/sites/getAllSites': () => ({ status: 403, headers: {}, body: {} }) } });
  const result = await backupSharePointSites({ transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, backupLibrary: completeLibrary([]) });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.discovery.status, 'denied');
});

test('a second run of an unchanged site stores nothing new', async () => {
  const store = memoryStore();
  const run = () => backupSharePointSites({ transport: fakeGraph(fixtureRoutes()).transport, store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]) });
  const first = await run();
  const second = await run();
  // (The first run already dedupes identical bodies, such as two empty column lists.)
  assert.ok(first.counters.deduped < first.counters.stored);
  assert.equal(second.counters.stored, first.counters.stored);
  assert.equal(second.counters.deduped, second.counters.stored);
});

// A fixture library drive: a root folder and one file, answered by Graph drive delta.
const DRIVE = 'b!drive-1';
const DELTA_LINK = `${G}/drives/${DRIVE}/root/delta?token=KEEL-RT-1`;
function driveRoutes(routes = fixtureRoutes()) {
  return {
    ...routes,
    [`/drives/${DRIVE}/root/delta`]: { value: [
      { id: 'root', name: 'root', root: {}, folder: { childCount: 1 } },
      { id: 'f1', name: 'KEEL-RT-a.docx', cTag: 'c1', size: 5, file: { mimeType: 'application/msword' }, parentReference: { id: 'root' } },
    ], '@odata.deltaLink': DELTA_LINK },
    [`/drives/${DRIVE}/items/f1/versions`]: { value: [] },
    [`/drives/${DRIVE}/items/f1/content`]: 'hello',
    [`/drives/${DRIVE}/items/f1/permissions`]: { value: [{ id: 'p1', roles: ['read'] }] },
  };
}

test('library files go through the drive backup into the site container, and its delta state is kept', async () => {
  const store = memoryStore();
  const saved = new Map();
  const libraryState = {
    async load({ driveId }) { return saved.get(driveId) ?? null; },
    async save({ siteId, listId, driveId, state }) { assert.equal(siteId, ROOT); assert.equal(listId, LIB); saved.set(driveId, state); },
  };
  const first = fakeGraph(driveRoutes());
  const result = await backupSharePointSites({ transport: first.transport, store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, libraryState });
  assert.equal(result.outcome, 'complete');
  const entry = result.sites[0].lists.find((list) => list.listId === LIB);
  assert.equal(entry.library.status, 'observed');
  assert.equal(entry.library.result.stats.files, 1);
  const files = store.items.filter((item) => item.metadata?.kind === 'drive-content');
  assert.equal(files.length, 1);
  assert.equal(files[0].container, `site:${ROOT}`);
  assert.equal(files[0].workload, 'sharepoint-sites');
  assert.equal(files[0].itemKey, 'f1');
  // Every library request was a GET, and the delta request carried the drive backup's Prefer header.
  assert.ok(first.requests.every((request) => request.method === 'GET'));
  const delta = first.requests.find((request) => request.url.includes('/root/delta'));
  assert.match(delta.headers.Prefer, /deltashowremovedasdeleted/);
  assert.equal(saved.get(DRIVE).deltaLink, DELTA_LINK);

  // The next run resumes from the saved delta link and stores nothing new.
  const routes = driveRoutes();
  const second = fakeGraph(routes, { override: { [`/drives/${DRIVE}/root/delta`]: () => ({ status: 200, headers: {}, body: { value: [], '@odata.deltaLink': DELTA_LINK } }) } });
  const driveItems = () => store.items.filter((item) => item.metadata?.kind?.startsWith('drive-')).length;
  const before = driveItems();
  const again = await backupSharePointSites({ transport: second.transport, store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, libraryState });
  assert.equal(again.outcome, 'complete');
  assert.ok(second.requests.some((request) => request.url === DELTA_LINK));
  assert.equal(driveItems(), before);
});

test('a denied library is recorded as denied and the run is partial', async () => {
  const { transport } = fakeGraph(driveRoutes(), { override: { [`/drives/${DRIVE}/root/delta`]: () => ({ status: 403, headers: {}, body: { error: { code: 'accessDenied' } } }) } });
  const result = await backupSharePointSites({ transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: defaultLibraryBackup() });
  const entry = result.sites[0].lists.find((list) => list.listId === LIB);
  assert.equal(entry.library.status, 'denied');
  assert.equal(entry.reads.library.status, 'denied');
  assert.equal(entry.library.driveId, DRIVE);
  assert.equal(result.outcome, 'partial');
});

test('a file Graph will not hand over makes the library partial', async () => {
  const { transport } = fakeGraph(driveRoutes(), { override: { [`/drives/${DRIVE}/items/f1/content`]: () => ({ status: 404, headers: {}, body: {} }) } });
  const result = await backupSharePointSites({ transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, siteFilter: keelRt });
  const entry = result.sites[0].lists.find((list) => list.listId === LIB);
  assert.equal(entry.library.result.outcome, 'partial');
  assert.equal(entry.library.status, 'partial');
  assert.equal(result.outcome, 'partial');
});

test('throttling honours Retry-After', async () => {
  let calls = 0;
  const waits = [];
  const routes = fixtureRoutes();
  const { transport } = fakeGraph(routes, {
    override: { [`/sites/${ROOT}/columns`]: () => (calls++ === 0 ? { status: 429, headers: { 'retry-after': '7' }, body: {} } : { status: 200, headers: {}, body: routes[`/sites/${ROOT}/columns`] }) },
  });
  const result = await backupSharePointSites({ transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]), sleep: async (ms) => { waits.push(ms); } });
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(waits, [7000]);
  assert.equal(result.counters.throttled, 1);
});

test('a next page on another path is refused', async () => {
  const routes = fixtureRoutes();
  routes[`/sites/${ROOT}/lists/${LIST}/items/delta`][0]['@odata.nextLink'] = `${G}/sites/${encodeURIComponent(ROOT)}/lists/${LIB}/items/delta?token=2`;
  const { transport } = fakeGraph(routes);
  const result = await backupSharePointSites({ transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]) });
  const list = result.sites[0].lists.find((entry) => entry.listId === LIST);
  assert.equal(list.reads.items.status, 'failed');
  assert.match(list.reads.items.error, /refused a next page/);
  assert.equal(result.outcome, 'partial');
});

test('the site cap makes the run partial', async () => {
  const { transport } = fakeGraph(fixtureRoutes());
  const result = await backupSharePointSites({ transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, maxSites: 1, backupLibrary: completeLibrary([]) });
  assert.equal(result.capped, true);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.sites.length, 1);
});

test('canonicalJson gives the same bytes for the same object in any key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { f: 1, e: 2 }], c: 3 } }), canonicalJson({ a: { c: 3, d: [1, { e: 2, f: 1 }] }, b: 1 }));
});

test('the library backup gets a transport that refuses anything except a Graph GET', async () => {
  const { transport } = fakeGraph(fixtureRoutes());
  const attempts = [];
  const library = async ({ transport: libraryTransport }) => {
    for (const [url, method] of [[`${G}/drives/b!drive-1/items/x`, 'DELETE'], ['https://evil.example/x', 'GET']]) {
      try { await libraryTransport({ method, url }); attempts.push('sent'); } catch { attempts.push('refused'); }
    }
    const ok = await libraryTransport({ method: 'GET', url: `${G}/sites/${encodeURIComponent(ROOT)}` });
    return { outcome: ok.status === 200 ? 'complete' : 'failed' };
  };
  const result = await backupSharePointSites({ transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: library });
  assert.deepEqual(attempts, ['refused', 'refused']);
  assert.equal(result.outcome, 'complete');
});

test('Retry-After is read from a fetch-style Headers object too', async () => {
  let calls = 0;
  const waits = [];
  const routes = fixtureRoutes();
  const { transport } = fakeGraph(routes, {
    override: { [`/sites/${ROOT}/columns`]: () => (calls++ === 0 ? { status: 429, headers: new Headers({ 'Retry-After': '3' }), body: {} } : { status: 200, headers: {}, body: routes[`/sites/${ROOT}/columns`] }) },
  });
  await backupSharePointSites({ transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]), sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [3000]);
});

// Change-only repeat runs: list item delta, page eTags and unchanged settings.
function memoryDeltaState() {
  const rows = new Map();
  return {
    rows,
    async load(key) { return rows.has(key) ? structuredClone(rows.get(key)) : null; },
    async save(key, state) { rows.set(key, structuredClone(state)); },
  };
}
const LIST_DELTA = `/sites/${ROOT}/lists/${LIST}/items/delta`;
const deltaPage = (value, token = 'latest-2') => () => ({ status: 200, headers: {}, body: { value, '@odata.deltaLink': itemsDeltaLink(ROOT, LIST, token) } });
const unchangedDeltas = () => Object.fromEntries([[ROOT, LIST], [ROOT, LIB], [SUB, SUBLIST]].map(([siteId, listId]) => [
  `/sites/${siteId}/lists/${listId}/items/delta`,
  (parsed) => ({ status: 200, headers: {}, body: { value: [], '@odata.deltaLink': itemsDeltaLink(siteId, listId, parsed.searchParams.get('token') ?? 'x') } }),
]));

test('a repeat run reads only changes: saved delta links, no unchanged page fetched, nothing stored', async () => {
  const store = memoryStore();
  const deltaState = memoryDeltaState();
  const options = { store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]), deltaState };
  const first = await backupSharePointSites({ transport: fakeGraph(fixtureRoutes()).transport, ...options });
  assert.equal(first.outcome, 'complete');
  assert.equal(deltaState.rows.get(`items:${ROOT}/${LIST}`).deltaLink, itemsDeltaLink(ROOT, LIST));
  const before = store.items.length;

  const second = fakeGraph(fixtureRoutes(), { override: unchangedDeltas() });
  const again = await backupSharePointSites({ transport: second.transport, ...options });
  assert.equal(again.outcome, 'complete');
  assert.equal(again.counters.stored, 0);
  assert.equal(store.items.length, before);
  assert.ok(again.counters.unchanged > 0);
  // Every list read resumed from its saved delta link, and the unchanged page was not fetched.
  const itemReads = second.requests.filter((request) => request.url.includes('/items'));
  assert.equal(itemReads.length, 3);
  assert.ok(itemReads.every((request) => new URL(request.url).searchParams.get('token') === 'latest-1'));
  assert.ok(!second.requests.some((request) => request.url.includes(`/pages/${PAGE}/`)));
});

test('a changed and a deleted item are the only list items stored on a repeat run', async () => {
  const store = memoryStore();
  const deltaState = memoryDeltaState();
  const options = { store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]), deltaState };
  await backupSharePointSites({ transport: fakeGraph(fixtureRoutes()).transport, ...options });
  const before = store.items.length;
  const { transport } = fakeGraph(fixtureRoutes(), { override: {
    ...unchangedDeltas(),
    [LIST_DELTA]: deltaPage([{ id: '2', eTag: 'e2b', fields: { Title: 'two, edited' } }, { id: '3', deleted: { state: 'deleted' } }]),
  } });
  const result = await backupSharePointSites({ transport, ...options });
  const added = store.items.slice(before);
  assert.deepEqual(added.map((item) => [item.itemKey, item.version]), [[`list/${LIST}/item/2`, 'e2b'], [`list/${LIST}/item/3`, 'deleted:e3']]);
  assert.equal(JSON.parse(String(await store.getItem(added[1].ref))).deleted, true);
  const list = result.sites[0].lists.find((entry) => entry.listId === LIST);
  assert.equal(list.items, 1);
  assert.equal(list.itemsDeleted, 1);
  assert.equal(deltaState.rows.get(`items:${ROOT}/${LIST}`).items['3'], null);
});

test('an expired delta link starts one full pass that marks unseen items deleted', async () => {
  const store = memoryStore();
  const deltaState = memoryDeltaState();
  const options = { store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]), deltaState };
  await backupSharePointSites({ transport: fakeGraph(fixtureRoutes()).transport, ...options });
  const before = store.items.length;
  const { transport, requests } = fakeGraph(fixtureRoutes(), { override: {
    ...unchangedDeltas(),
    [LIST_DELTA]: (parsed) => (parsed.searchParams.get('token')
      ? { status: 410, headers: {}, body: { error: { code: 'resyncRequired' } } }
      : deltaPage([{ id: '1', eTag: 'e1', fields: { Title: 'one' } }, { id: '2', eTag: 'e2', fields: { Title: 'two' } }])()),
  } });
  const result = await backupSharePointSites({ transport, ...options });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.counters.resyncs, 1);
  // Items 1 and 2 are unchanged, so only item 3's deletion is stored.
  assert.deepEqual(store.items.slice(before).map((item) => item.itemKey), [`list/${LIST}/item/3`]);
  assert.equal(requests.filter((request) => request.url.includes(`/lists/${LIST}/items`)).length, 2);
});

test('a stale saved link Graph answers 400 starts one full pass; a second 400 fails the read', async () => {
  const deltaState = memoryDeltaState();
  await deltaState.save(`items:${ROOT}/${LIST}`, { version: 1, nextLink: null, deltaLink: itemsDeltaLink(ROOT, LIST, 'stale'), fullPass: null, items: {} });
  const routes = fixtureRoutes();
  const stale = fakeGraph(routes, { override: { [LIST_DELTA]: (parsed) => (parsed.searchParams.get('token') === 'stale' ? { status: 400, headers: {}, body: {} } : deltaPage([{ id: '1', eTag: 'e1', fields: { Title: 'one' } }])()) } });
  const result = await backupSharePointSites({ transport: stale.transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]), deltaState });
  assert.equal(result.sites[0].lists.find((entry) => entry.listId === LIST).reads.items.status, 'observed');
  assert.equal(deltaState.rows.get(`items:${ROOT}/${LIST}`).deltaLink, itemsDeltaLink(ROOT, LIST, 'latest-2'));

  const broken = fakeGraph(routes, { override: { [LIST_DELTA]: () => ({ status: 400, headers: {}, body: {} }) } });
  await deltaState.save(`items:${ROOT}/${LIST}`, { version: 1, nextLink: null, deltaLink: itemsDeltaLink(ROOT, LIST, 'stale'), fullPass: null, items: {} });
  const failed = await backupSharePointSites({ transport: broken.transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]), deltaState });
  assert.equal(failed.sites[0].lists.find((entry) => entry.listId === LIST).reads.items.status, 'failed');
  assert.equal(failed.outcome, 'partial');
});

test('a delta item without fields is read on its own, and a saved link for another list is never followed', async () => {
  const deltaState = memoryDeltaState();
  await deltaState.save(`items:${ROOT}/${LIST}`, { version: 1, nextLink: null, deltaLink: itemsDeltaLink(ROOT, LIB, 'other'), fullPass: null, items: {} });
  const store = memoryStore();
  const { transport, requests } = fakeGraph({
    ...fixtureRoutes(),
    [`/sites/${ROOT}/lists/${LIST}/items/7`]: { id: '7', eTag: 'e7', fields: { Title: 'seven' } },
  }, { override: { [LIST_DELTA]: deltaPage([{ id: '7', eTag: 'e7' }]) } });
  await backupSharePointSites({ transport, store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]), deltaState });
  assert.ok(!requests.some((request) => request.url.includes('token=other')));
  const ref = store.items.find((item) => item.itemKey === `list/${LIST}/item/7`).ref;
  assert.equal(JSON.parse(String(await store.getItem(ref))).fields.Title, 'seven');
});

test('a changed page is fetched again on a repeat run', async () => {
  const store = memoryStore();
  const deltaState = memoryDeltaState();
  const options = { store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]), deltaState };
  const withTag = (tag) => { const routes = fixtureRoutes(); routes[`/sites/${ROOT}/pages/microsoft.graph.sitePage`] = { value: [{ id: PAGE, name: 'Home.aspx', eTag: tag }] }; return routes; };
  await backupSharePointSites({ transport: fakeGraph(withTag('p1')).transport, ...options });
  const same = fakeGraph(withTag('p1'), { override: unchangedDeltas() });
  await backupSharePointSites({ transport: same.transport, ...options });
  assert.ok(!same.requests.some((request) => request.url.includes(`/pages/${PAGE}/`)));
  const changed = fakeGraph(withTag('p2'), { override: unchangedDeltas() });
  await backupSharePointSites({ transport: changed.transport, ...options });
  assert.ok(changed.requests.some((request) => request.url.includes(`/pages/${PAGE}/`)));
});

test('a site without a Site Pages library (404 on its pages) has no pages, not a failed read', async () => {
  // The search centre site has no Site Pages library, and Graph answers 404 for its pages.
  const routes = fixtureRoutes();
  delete routes[`/sites/${SUB}/pages/microsoft.graph.sitePage`];
  const result = await backupSharePointSites({ transport: fakeGraph(routes).transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]) });
  assert.equal(result.outcome, 'complete');
  const sub = result.sites.find((entry) => entry.siteId === SUB);
  assert.equal(sub.reads.pages.status, 'observed');
  assert.deepEqual(sub.pages, { count: 0, unchanged: 0, gone: 0, failed: [], library: 'none' });
});

test('a 404 on the pages of a site that has a Site Pages library is still a failed read', async () => {
  const routes = fixtureRoutes();
  delete routes[`/sites/${SUB}/pages/microsoft.graph.sitePage`];
  routes[`/sites/${SUB}/lists`] = { value: [{ id: SUBLIST, displayName: 'Site Pages', list: { template: 'webPageLibrary' } }] };
  routes[`/sites/${SUB}/lists/${SUBLIST}/drive`] = { id: 'b!pages', driveType: 'documentLibrary' };
  const result = await backupSharePointSites({ transport: fakeGraph(routes).transport, store: memoryStore(), tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]) });
  assert.equal(result.outcome, 'partial');
  assert.equal(result.sites.find((entry) => entry.siteId === SUB).reads.pages.status, 'failed');
});

test('a page deleted between the listing and its read is gone, not a failed page', async () => {
  const routes = fixtureRoutes();
  delete routes[`/sites/${ROOT}/pages/${PAGE}/microsoft.graph.sitePage`];
  const store = memoryStore();
  const result = await backupSharePointSites({ transport: fakeGraph(routes).transport, store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]) });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.sites[0].reads.pages.status, 'observed');
  assert.equal(result.sites[0].pages.gone, 1);
  assert.ok(!store.items.some((item) => item.itemKey === `page/${PAGE}`));
});

test('a delta item gone before its own read is a deletion, and a next link in another case is followed', async () => {
  const deltaState = memoryDeltaState();
  await deltaState.save(`items:${ROOT}/${LIST}`, { version: 1, nextLink: null, deltaLink: null, fullPass: null, items: { 8: 'e8' } });
  const store = memoryStore();
  const upper = `${G}/sites/${encodeURIComponent(ROOT.toUpperCase())}/lists/${LIST.toUpperCase()}/items/delta?token=page-2`;
  const { transport } = fakeGraph(fixtureRoutes(), { override: {
    [LIST_DELTA]: () => ({ status: 200, headers: {}, body: { value: [{ id: '1', eTag: 'e1', fields: { Title: 'one' } }], '@odata.nextLink': upper } }),
    [`/sites/${ROOT.toUpperCase()}/lists/${LIST.toUpperCase()}/items/delta`]: deltaPage([{ id: '8', eTag: 'e8b' }]),
  } });
  const result = await backupSharePointSites({ transport, store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]), deltaState });
  const list = result.sites[0].lists.find((entry) => entry.listId === LIST);
  assert.equal(list.reads.items.status, 'observed');
  assert.equal(list.itemsDeleted, 1);
  assert.equal(deltaState.rows.get(`items:${ROOT}/${LIST}`).items['8'], null);
});

// SharePoint REST (site permissions): the fixture site breaks inheritance on itself and
// on one list; its subsite inherits.
const ROOT_URL = `https://${HOST}/sites/KEEL-RT-Site`;
const SUB_URL = `https://${HOST}/sites/KEEL-RT-Site/Sub`;
const UNIQUE_LIST = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const assignment = (id, title, roles) => ({
  PrincipalId: id, Member: { Id: id, Title: title, LoginName: title, PrincipalType: 8 },
  RoleDefinitionBindings: roles.map(([roleId, name]) => ({ Id: roleId, Name: name })),
});
function permissionRoutes(webUrl, { unique }) {
  const base = new URL(webUrl).pathname;
  return {
    [`${base}/_api/web`]: { Id: unique ? 'w-root' : 'w-sub', Url: webUrl, HasUniqueRoleAssignments: unique },
    [`${base}/_api/web/roledefinitions`]: { value: [
      { Id: 1073741829, Name: 'Full Control', Hidden: false, RoleTypeKind: 5, Order: 1, BasePermissions: { High: '2147483647', Low: '4294967295' } },
      { Id: 1073741826, Name: 'Read', Hidden: false, RoleTypeKind: 2, Order: 128, BasePermissions: { High: '176', Low: '138612833' } },
    ] },
    [`${base}/_api/web/sitegroups`]: { value: [
      { Id: 5, Title: 'KEEL-RT-Site Members', OwnerTitle: 'KEEL-RT-Site Owners', OnlyAllowMembersViewMembership: false },
      { Id: 3, Title: 'KEEL-RT-Site Owners', OwnerTitle: 'KEEL-RT-Site Owners', OnlyAllowMembersViewMembership: false },
    ] },
    [`${base}/_api/web/sitegroups/GetById(3)/users`]: { value: [{ Id: 11, Title: 'KEEL-RT-Owner', LoginName: 'i:0#.f|membership|keel-rt-owner@contoso.com', PrincipalType: 1, IsSiteAdmin: true }] },
    [`${base}/_api/web/sitegroups/GetById(5)/users`]: [
      { value: [{ Id: 13, Title: 'KEEL-RT-Member B', PrincipalType: 1 }], 'odata.nextLink': `${webUrl}/_api/web/sitegroups/GetById(5)/users?%24skiptoken=Paged%3dTRUE%26p_ID%3d13&$select=Id` },
      { value: [{ Id: 12, Title: 'KEEL-RT-Member A', PrincipalType: 1 }] },
    ],
    [`${base}/_api/web/siteusers`]: { value: [{ Id: 11, Title: 'KEEL-RT-Owner', PrincipalType: 1, IsSiteAdmin: true }] },
    [`${base}/_api/web/roleassignments`]: { value: [assignment(5, 'KEEL-RT-Site Members', [[1073741830, 'Edit']]), assignment(3, 'KEEL-RT-Site Owners', [[1073741829, 'Full Control']])] },
    [`${base}/_api/web/lists`]: { value: unique ? [
      { Id: LIST, Title: 'KEEL-RT-Tasks', Hidden: false, HasUniqueRoleAssignments: false },
      { Id: UNIQUE_LIST, Title: 'KEEL-RT-Private', Hidden: false, HasUniqueRoleAssignments: true },
    ] : [] },
    [`${base}/_api/web/lists(guid'${UNIQUE_LIST}')/roleassignments`]: { value: [assignment(3, 'KEEL-RT-Site Owners', [[1073741829, 'Full Control']])] },
  };
}

function fakeSharePoint({ override = {} } = {}) {
  const routes = { ...permissionRoutes(ROOT_URL, { unique: true }), ...permissionRoutes(SUB_URL, { unique: false }) };
  const requests = [];
  const transport = async (url, { method } = {}) => {
    requests.push({ url, method });
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    if (override[path]) return override[path](parsed);
    const route = routes[path];
    if (route === undefined) return { status: 404, headers: {}, body: { 'odata.error': { code: 'not found' } } };
    if (Array.isArray(route)) return { status: 200, headers: {}, body: route[parsed.searchParams.get('$skiptoken') ? 1 : 0] };
    return { status: 200, headers: {}, body: route };
  };
  return { transport, requests };
}

const storedPermissions = async (store, siteId) => {
  const item = store.items.filter((entry) => entry.container === `site:${siteId}` && entry.itemKey === 'site/permissions').at(-1);
  return item ? JSON.parse(String(await store.getItem(item.ref))) : null;
};

test('site groups, members, admins and role assignments are read through SharePoint REST and stored per site', async () => {
  const sharePoint = fakeSharePoint();
  const store = memoryStore();
  const result = await backupSharePointSites({
    transport: fakeGraph(fixtureRoutes()).transport, permissionsTransport: sharePoint.transport,
    store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]),
  });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.sites[0].reads.permissions.status, 'observed');
  // Groups and role assignments are read now; only item-level unique permissions are declared missing.
  assert.deepEqual(result.sites[0].missing.map((part) => part.part), [...MISSING_PARTS, ITEM_PERMISSIONS_MISSING].map((part) => part.part));

  const root = await storedPermissions(store, ROOT);
  assert.deepEqual(root.web, { id: 'w-root', url: ROOT_URL, hasUniqueRoleAssignments: true });
  assert.deepEqual(root.groups.map((group) => group.title), ['KEEL-RT-Site Owners', 'KEEL-RT-Site Members']);
  // Members are read across pages and sorted.
  assert.deepEqual(root.groups[1].members.map((member) => member.title), ['KEEL-RT-Member A', 'KEEL-RT-Member B']);
  assert.deepEqual(root.siteCollectionAdmins.map((admin) => admin.title), ['KEEL-RT-Owner']);
  assert.deepEqual(root.roleAssignments.map((row) => [row.principalId, row.roles.map((role) => role.name)]), [[3, ['Full Control']], [5, ['Edit']]]);
  assert.deepEqual(root.roleDefinitions.map((role) => role.name), ['Read', 'Full Control']);
  assert.deepEqual(root.roleDefinitions[1].basePermissions, { high: '2147483647', low: '4294967295' });
  // Only the list that breaks inheritance is read, with its own role assignments.
  assert.deepEqual(root.lists.map((list) => [list.id, list.title, list.roleAssignments.length]), [[UNIQUE_LIST, 'KEEL-RT-Private', 1]]);

  // The subsite inherits: no role assignments of its own.
  const sub = await storedPermissions(store, SUB);
  assert.equal(sub.web.hasUniqueRoleAssignments, false);
  assert.equal(sub.roleAssignments, null);
  assert.ok(!sharePoint.requests.some((request) => request.url.startsWith(`${SUB_URL}/_api/web/roleassignments`)));

  for (const request of sharePoint.requests) {
    assert.equal(request.method, 'GET');
    assert.doesNotThrow(() => assertPermissionsRequest(request.url, request.method, HOST));
  }
});

test('assertPermissionsRequest refuses writes, other hosts, paths outside the list and unknown query keys', () => {
  const ok = `${ROOT_URL}/_api/web/roleassignments?$expand=Member,RoleDefinitionBindings`;
  assert.doesNotThrow(() => assertPermissionsRequest(ok, 'GET', HOST));
  assert.doesNotThrow(() => assertPermissionsRequest(`${ROOT_URL}/_api/web/lists(guid'${UNIQUE_LIST}')/roleassignments`, 'GET', HOST));
  assert.throws(() => assertPermissionsRequest(ok, 'POST', HOST), /read-only/);
  assert.throws(() => assertPermissionsRequest(ok.replace(HOST, 'fabrikam.sharepoint.com'), 'GET', HOST), /not the tenant's SharePoint host/);
  assert.throws(() => assertPermissionsRequest(`http://${HOST}/sites/KEEL-RT-Site/_api/web`, 'GET', HOST), /not the tenant's SharePoint host/);
  assert.throws(() => assertPermissionsRequest(`${ROOT_URL}/_api/web/lists/getbytitle('Documents')/items`, 'GET', HOST), /not an allow-listed read/);
  assert.throws(() => assertPermissionsRequest(`${ROOT_URL}/_api/web/sitegroups/GetById(3)/users/add`, 'GET', HOST), /not an allow-listed read/);
  assert.throws(() => assertPermissionsRequest(`${ROOT_URL}/_api/web/getfilebyserverrelativeurl('/x')/$value`, 'GET', HOST), /not an allow-listed read/);
  assert.throws(() => assertPermissionsRequest(`${ROOT_URL}/Shared%20Documents/a.docx`, 'GET', HOST), /not an allow-listed read/);
  assert.throws(() => assertPermissionsRequest(`${ROOT_URL}/_api/web?$format=x`, 'GET', HOST), /refused query/);
});

test('a group whose members cannot be read is recorded on the group, the rest is stored, and the run is partial', async () => {
  const sharePoint = fakeSharePoint({ override: { '/sites/KEEL-RT-Site/_api/web/sitegroups/GetById(5)/users': () => ({ status: 403, headers: {}, body: {} }) } });
  const store = memoryStore();
  const result = await backupSharePointSites({
    transport: fakeGraph(fixtureRoutes()).transport, permissionsTransport: sharePoint.transport,
    store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]),
  });
  assert.equal(result.outcome, 'partial');
  assert.equal(result.sites[0].reads.permissions.status, 'denied');
  const root = await storedPermissions(store, ROOT);
  const members = root.groups.find((group) => group.id === 5);
  assert.equal(members.members, null);
  assert.equal(members.membersRead.httpStatus, 403);
  assert.equal(root.groups.find((group) => group.id === 3).members.length, 1);
  assert.equal(root.roleAssignments.length, 2);
});

test('a denied permission read leaves the rest of the site captured', async () => {
  const sharePoint = fakeSharePoint({ override: { '/sites/KEEL-RT-Site/_api/web/roleassignments': () => ({ status: 403, headers: {}, body: {} }) } });
  const store = memoryStore();
  const result = await backupSharePointSites({
    transport: fakeGraph(fixtureRoutes()).transport, permissionsTransport: sharePoint.transport,
    store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]),
  });
  assert.equal(result.outcome, 'partial');
  assert.equal(result.sites[0].reads.permissions.status, 'denied');
  assert.ok(store.items.some((item) => item.itemKey === `page/${PAGE}`));
  assert.equal(result.sites[1].reads.permissions.status, 'observed');
});

test('unchanged site permissions are not stored again on a repeat run', async () => {
  const store = memoryStore();
  const states = new Map();
  const deltaState = { load: async (key) => states.get(key) ?? null, save: async (key, state) => { states.set(key, state); } };
  const run = () => backupSharePointSites({
    transport: fakeGraph(fixtureRoutes()).transport, permissionsTransport: fakeSharePoint().transport, deltaState,
    store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]),
  });
  await run();
  const before = store.items.filter((item) => item.itemKey === 'site/permissions').length;
  assert.equal(before, 2);
  await run();
  assert.equal(store.items.filter((item) => item.itemKey === 'site/permissions').length, before);
});

test('site permissions that change and change back are stored again, so the latest backup is the latest state', async () => {
  // The content store keeps one row per version; a state seen before must still be the newest row.
  let clock = Date.parse('2026-10-15T08:00:00Z');
  const now = () => new Date(clock);
  const store = createMemoryContentStore({ now });
  const states = new Map();
  const deltaState = { load: async (key) => states.get(key) ?? null, save: async (key, state) => { states.set(key, state); } };
  const base = new URL(ROOT_URL).pathname;
  const admins = (title) => ({ [`${base}/_api/web/siteusers`]: () => ({ status: 200, headers: {}, body: { value: [{ Id: 11, Title: title, PrincipalType: 1, IsSiteAdmin: true }] } }) });
  const run = async (override) => {
    clock += 60_000;
    await backupSharePointSites({
      transport: fakeGraph(fixtureRoutes()).transport, permissionsTransport: fakeSharePoint({ override }).transport, deltaState,
      store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]), now,
    });
  };
  await run(admins('KEEL-RT-Owner'));
  await run(admins('KEEL-RT-Other'));
  await run(admins('KEEL-RT-Owner'));
  const latest = await loadSitePermissionsSource({ store, tenantRef: 't', siteId: ROOT });
  assert.deepEqual(latest.value.siteCollectionAdmins.map((admin) => admin.title), ['KEEL-RT-Owner']);
  assert.equal(latest.storedAt, new Date(clock).toISOString());
});

test('each stored site/permissions item carries a plain summary of groups, owners and guests', async () => {
  const store = memoryStore();
  await backupSharePointSites({
    transport: fakeGraph(fixtureRoutes()).transport, permissionsTransport: fakeSharePoint().transport,
    store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]),
  });
  const item = store.items.filter((entry) => entry.container === `site:${ROOT}` && entry.itemKey === 'site/permissions').at(-1);
  assert.equal(item.metadata.contentType, 'application/json');
  const summary = item.metadata.summary;
  assert.equal(summary.v, PERMISSIONS_SUMMARY_VERSION);
  assert.equal(summary.inherits, false);
  assert.deepEqual(summary.groups, [
    { name: 'KEEL-RT-Site Owners', members: 1, roles: ['Full Control'] },
    { name: 'KEEL-RT-Site Members', members: 2, roles: ['Edit'] },
  ]);
  assert.deepEqual(summary.owners, ['KEEL-RT-Owner']);
  assert.equal(summary.people, 3);
  assert.equal(summary.guests, 0);
  assert.equal(summary.uniqueLists, 1);
  // No logins or ids in the plain summary.
  assert.ok(!JSON.stringify(summary).includes('membership'));

  // The subsite inherits: its owners come from the group SharePoint names "... Owners".
  const sub = store.items.filter((entry) => entry.container === `site:${SUB}` && entry.itemKey === 'site/permissions').at(-1).metadata.summary;
  assert.equal(sub.inherits, true);
  assert.equal(sub.groups[0].roles, null);
  assert.deepEqual(sub.owners, ['KEEL-RT-Owner']);
});

test('the summary counts guests and sharing links and leaves out system accounts', () => {
  const summary = permissionsSummary({
    groups: [
      { id: 3, title: 'Hub Owners', members: [{ id: 1, title: 'Ann', loginName: 'i:0#.f|membership|ann@contoso.com', principalType: 1 }, { id: 2, title: 'System Account', loginName: 'SHAREPOINT\\system', principalType: 1 }] },
      { id: 7, title: 'Hub Visitors', members: [{ id: 4, title: 'Guest Gus', loginName: 'i:0#.f|membership|gus_fabrikam.com#ext#@contoso.onmicrosoft.com', principalType: 1 }] },
      { id: 9, title: 'SharingLinks.abc.OrganizationView.def', members: [] },
    ],
    siteCollectionAdmins: [{ id: 1, title: 'Ann', loginName: 'i:0#.f|membership|ann@contoso.com', principalType: 1 }],
    roleAssignments: [
      { principalId: 3, member: { principalType: 8 }, roles: [{ name: 'Full Control' }] },
      { principalId: 7, member: { principalType: 8 }, roles: [{ name: 'Read' }, { name: 'Limited Access' }] },
    ],
    lists: [],
  });
  assert.deepEqual(summary.groups.map((group) => [group.name, group.members, group.roles]), [['Hub Owners', 1, ['Full Control']], ['Hub Visitors', 1, ['Read']]]);
  assert.deepEqual(summary.owners, ['Ann']);
  assert.equal(summary.ownerCount, 1);
  assert.equal(summary.people, 2);
  assert.equal(summary.guests, 1);
  assert.equal(summary.sharingLinks, 1);
});

test('permissions stored before the summary existed are stored once more with it', async () => {
  const store = memoryStore();
  const deltaState = memoryDeltaState();
  const run = () => backupSharePointSites({
    transport: fakeGraph(fixtureRoutes()).transport, permissionsTransport: fakeSharePoint().transport, deltaState,
    store, tenantRef: 't', tenantHost: HOST, siteFilter: keelRt, backupLibrary: completeLibrary([]),
  });
  await run();
  // As an older release saved it: no summary version on the stored entry.
  for (const [key, state] of deltaState.rows) {
    if (!key.startsWith('site:')) continue;
    if (state.stored?.['site/permissions']) delete state.stored['site/permissions'].summary;
  }
  const before = store.items.filter((item) => item.itemKey === 'site/permissions').length;
  await run();
  const after = store.items.filter((item) => item.itemKey === 'site/permissions');
  assert.equal(after.length, before * 2);
  assert.ok(after.every((item) => item.metadata.summary?.v === PERMISSIONS_SUMMARY_VERSION));
  await run();
  assert.equal(store.items.filter((item) => item.itemKey === 'site/permissions').length, before * 2);
});
