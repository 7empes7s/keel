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
  MISSING_PARTS, assertSitesRequest, backupSharePointSites, canonicalJson, defaultLibraryBackup,
} from './sharepointSites.mjs';

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

const site = (id, name) => ({ id, name, displayName: name, webUrl: `https://${id.split(',')[0]}/sites/${name}` });

function fixtureRoutes() {
  const root = site(ROOT, 'KEEL-RT-Site');
  const sub = { ...site(SUB, 'KEEL-RT-Site/Sub') };
  return {
    '/sites/getAllSites': [{ value: [root, site(OTHER, 'KEEL-RT-Elsewhere')], '@odata.nextLink': `${G}/sites/getAllSites?$skiptoken=2` }, { value: [root, site(`${HOST},66666666-6666-6666-6666-666666666666,77777777-7777-7777-7777-777777777777`, 'Finance')] }],
    [`/sites/${ROOT}`]: { ...root, lastModifiedDateTime: '2026-10-01T00:00:00Z' },
    [`/sites/${ROOT}/permissions`]: { value: [{ id: 'grant-1', roles: ['read'] }] },
    [`/sites/${ROOT}/columns`]: { value: [{ id: 'col-1', name: 'Region' }] },
    [`/sites/${ROOT}/contentTypes`]: { value: [{ id: '0x01', name: 'Item' }] },
    [`/sites/${ROOT}/sites`]: { value: [sub] },
    [`/sites/${ROOT}/lists`]: { value: [
      { id: LIST, displayName: 'KEEL-RT-Tasks', list: { template: 'genericList' } },
      { id: LIB, displayName: 'Documents', list: { template: 'documentLibrary' } },
    ] },
    [`/sites/${ROOT}/lists/${LIST}/columns`]: { value: [{ id: 'col-2', name: 'Title' }] },
    [`/sites/${ROOT}/lists/${LIST}/contentTypes`]: { value: [{ id: '0x0100', name: 'Item' }] },
    [`/sites/${ROOT}/lists/${LIST}/items`]: [
      { value: [{ id: '1', eTag: 'e1', fields: { Title: 'one' } }, { id: '2', eTag: 'e2', fields: { Title: 'two' } }], '@odata.nextLink': `${G}/sites/${encodeURIComponent(ROOT)}/lists/${LIST}/items?$expand=fields&$skiptoken=2` },
      { value: [{ id: '3', eTag: 'e3', fields: { Title: 'three' } }] },
    ],
    [`/sites/${ROOT}/lists/${LIB}/columns`]: { value: [] },
    [`/sites/${ROOT}/lists/${LIB}/contentTypes`]: { value: [{ id: '0x0101', name: 'Document' }] },
    [`/sites/${ROOT}/lists/${LIB}/items`]: { value: [{ id: '1', eTag: 'd1', fields: { FileLeafRef: 'KEEL-RT-a.docx', Region: 'EU' } }] },
    [`/sites/${ROOT}/lists/${LIB}/drive`]: { id: 'b!drive-1', driveType: 'documentLibrary' },
    [`/sites/${ROOT}/pages/microsoft.graph.sitePage`]: { value: [{ id: PAGE, name: 'Home.aspx' }] },
    [`/sites/${ROOT}/pages/${PAGE}/microsoft.graph.sitePage`]: { id: PAGE, title: 'Home', eTag: 'p1', canvasLayout: { horizontalSections: [{ id: '1', columns: [{ webparts: [{ id: 'wp', innerHtml: '<p>Hi</p>' }] }] }] } },
    [`/sites/${SUB}`]: sub,
    [`/sites/${SUB}/permissions`]: { value: [] },
    [`/sites/${SUB}/columns`]: { value: [] },
    [`/sites/${SUB}/contentTypes`]: { value: [] },
    [`/sites/${SUB}/sites`]: { value: [] },
    [`/sites/${SUB}/lists`]: { value: [{ id: SUBLIST, displayName: 'KEEL-RT-Sub list', list: { template: 'genericList' } }] },
    [`/sites/${SUB}/lists/${SUBLIST}/columns`]: { value: [] },
    [`/sites/${SUB}/lists/${SUBLIST}/contentTypes`]: { value: [] },
    [`/sites/${SUB}/lists/${SUBLIST}/items`]: { value: [{ id: '1', eTag: 's1', fields: { Title: 'sub' } }] },
    [`/sites/${SUB}/pages/microsoft.graph.sitePage`]: { value: [] },
  };
}

// A fake Graph: answers from the routes; a route that is an array is paged by $skiptoken.
function fakeGraph(routes, { override = {} } = {}) {
  const requests = [];
  const transport = async (url, { method, headers } = {}) => {
    requests.push({ url, method, headers });
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname.slice('/v1.0'.length));
    if (override[path]) return override[path](parsed);
    const route = routes[path];
    if (route === undefined) return { status: 404, headers: {}, body: { error: { code: 'itemNotFound' } } };
    if (Array.isArray(route)) return { status: 200, headers: {}, body: route[parsed.searchParams.get('$skiptoken') ? 1 : 0] };
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
    `page/${PAGE}`, 'site', 'site/columns', 'site/contentTypes', 'site/permissions',
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
  assert.deepEqual(result.sites[0].missing.map((part) => part.part), MISSING_PARTS.map((part) => part.part));
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
  const ok = `${G}/sites/${encodeURIComponent(ROOT)}/lists/${LIST}/items?$expand=fields`;
  assert.doesNotThrow(() => assertSitesRequest(ok));
  assert.throws(() => assertSitesRequest(ok, 'POST'), /read-only/);
  assert.throws(() => assertSitesRequest(ok, 'PATCH'), /read-only/);
  assert.throws(() => assertSitesRequest(`${G}/sites/${encodeURIComponent(ROOT)}/lists/${LIST}/items/1`), /not an allow-listed read/);
  assert.throws(() => assertSitesRequest(`${G}/drives/b!x/items/root/children`), /not an allow-listed read/);
  assert.throws(() => assertSitesRequest(`${G}/sites/${encodeURIComponent(ROOT)}/lists?$filter=x`), /refused query/);
  assert.throws(() => assertSitesRequest(`https://evil.example/v1.0/sites/getAllSites`), /not Graph v1.0/);
  assert.throws(() => assertSitesRequest(`https://graph.microsoft.com/beta/sites/getAllSites`), /not Graph v1.0/);
});

test('a denied read is partial coverage and the rest of the site is still captured', async () => {
  const { transport } = fakeGraph(fixtureRoutes(), {
    override: { [`/sites/${ROOT}/lists/${LIST}/items`]: () => ({ status: 403, headers: {}, body: {} }) },
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
  routes[`/sites/${ROOT}/lists/${LIST}/items`][0]['@odata.nextLink'] = `${G}/sites/${encodeURIComponent(ROOT)}/lists/${LIB}/items?$skiptoken=2`;
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
