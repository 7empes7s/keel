import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import {
  DriveScopeError, DriveSyncError, assertDriveUrl, deltaUrl, itemPath, newDriveState, resolveUserDrive, syncDrive,
} from './drive.mjs';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const DRIVE = 'b!KEEL-RT-drive';
const TENANT = 'tenant-ref-1';

// An in-memory content store with the plan's interface (section 2). Blobs are
// deduplicated by sha256; every put is kept as an index row.
function fakeStore() {
  const blobs = new Map();
  const rows = [];
  return {
    rows,
    async putItem(stream, { tenantRef, workload, container, itemKey, version, metadata }) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks);
      const sha256 = createHash('sha256').update(data).digest('hex');
      const deduped = blobs.has(sha256);
      blobs.set(sha256, data);
      const ref = `fake:${sha256}`;
      rows.push({ ref, sha256, bytes: data.length, tenantRef, workload, container, itemKey, version, metadata, seq: rows.length });
      return { ref, sha256, bytes: data.length, deduped };
    },
    getItem(ref) {
      const data = blobs.get(ref.replace(/^fake:/, ''));
      if (!data) throw new Error(`no blob ${ref}`);
      return Readable.from([data]);
    },
    async listItems({ container, since = -1 }) {
      return rows.filter((row) => row.container === container && row.seq > since);
    },
  };
}

async function read(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

// A fixture drive behind a fake Graph transport. Every change appends to a log;
// delta answers the items changed since a token, a few per page, parents first.
function fakeDrive({ pageSize = 2 } = {}) {
  const items = new Map();
  const log = [];
  const requests = [];
  let expiredBelow = -1;
  const hooks = [];
  const touch = (id) => log.push(id);
  const at = (n) => `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`;
  let clock = 1;

  const drive = {
    requests,
    hooks,
    add({ id, name, parentId = 'root', folder = false, content = null, permissions = [] }) {
      items.set(id, { id, name, parentId, folder, versions: content === null ? [] : [{ id: '1.0', data: content, at: at(clock++) }], permissions, deleted: false });
      touch(id);
    },
    rename(id, name) { items.get(id).name = name; touch(id); },
    move(id, parentId) { items.get(id).parentId = parentId; touch(id); },
    write(id, data) {
      const item = items.get(id);
      item.versions.unshift({ id: `${item.versions.length + 1}.0`, data, at: at(clock++) });
      touch(id);
    },
    share(id, permission) { items.get(id).permissions.push(permission); touch(id); },
    remove(id) { items.get(id).deleted = true; touch(id); },
    // Removes an item without a log entry: only a full pass can notice it.
    vanish(id) { items.delete(id); },
    expireTokens() { expiredBelow = log.length + 1; },
    contentRequests: () => requests.filter((r) => r.url.includes('/content')),
  };
  items.set('root', { id: 'root', root: true, name: 'root', versions: [], permissions: [], deleted: false });
  touch('root');

  const view = (item) => {
    if (item.deleted) return { id: item.id, deleted: { state: 'deleted' }, parentReference: { id: item.parentId } };
    if (item.root) return { id: 'root', name: 'root', root: {}, folder: { childCount: 0 } };
    const base = { id: item.id, name: item.name, parentReference: { driveId: DRIVE, id: item.parentId }, eTag: `"e-${item.id}-${item.name}-${item.parentId}"` };
    if (item.folder) return { ...base, folder: { childCount: 0 } };
    const current = item.versions[0];
    return {
      ...base,
      cTag: `"c-${item.id}-${current.id}"`,
      size: Buffer.byteLength(current.data),
      lastModifiedDateTime: current.at,
      file: { mimeType: 'text/plain', hashes: { quickXorHash: 'fixture' } },
    };
  };
  const json = (body, status = 200) => ({ status, headers: {}, body });

  drive.transport = async ({ method, url, headers }) => {
    requests.push({ method, url, headers });
    for (const hook of hooks) {
      const answer = hook({ method, url });
      if (answer) return answer;
    }
    assert.equal(method, 'GET');
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    const prefix = `/v1.0/drives/${DRIVE}`;
    assert.ok(path.startsWith(prefix), path);
    const rest = path.slice(prefix.length);
    if (rest === '/root/delta') {
      // No token (or `full`): every item. A token: the items changed since that log position.
      const full = !parsed.searchParams.has('token');
      const from = full ? 0 : Number(parsed.searchParams.get('token'));
      if (!full && from < expiredBelow) return json({ error: { code: 'resyncRequired' } }, 410);
      const end = Number(parsed.searchParams.get('end') ?? log.length);
      const skip = Number(parsed.searchParams.get('skip') ?? 0);
      const ids = full ? [...items.keys()] : [...new Set(log.slice(from, end))];
      const body = { value: ids.slice(skip, skip + pageSize).filter((id) => items.has(id)).map((id) => view(items.get(id))) };
      const position = full ? '' : `token=${from}&`;
      if (skip + pageSize < ids.length) body['@odata.nextLink'] = `${GRAPH}/drives/${DRIVE}/root/delta?${position}end=${end}&skip=${skip + pageSize}`;
      else body['@odata.deltaLink'] = `${GRAPH}/drives/${DRIVE}/root/delta?token=${end}`;
      return json(body);
    }
    const match = rest.match(/^\/items\/([^/]+)(\/.*)?$/);
    assert.ok(match, rest);
    const item = items.get(match[1]);
    if (!item || item.deleted) return json({ error: { code: 'itemNotFound' } }, 404);
    const sub = match[2] ?? '';
    if (sub === '/permissions') return json({ value: item.permissions });
    if (sub === '/versions') return json({ value: item.versions.map((v) => ({ id: v.id, lastModifiedDateTime: v.at, size: Buffer.byteLength(v.data) })) });
    if (sub === '/content') return { status: 200, headers: {}, body: Readable.from([Buffer.from(item.versions[0].data)]) };
    const version = sub.match(/^\/versions\/([^/]+)\/content$/);
    if (version) return { status: 200, headers: {}, body: Buffer.from(item.versions.find((v) => v.id === version[1]).data) };
    throw new Error(`unexpected request ${url}`);
  };
  return drive;
}

function fixtureDrive(options) {
  const drive = fakeDrive(options);
  drive.add({ id: 'f-docs', name: 'KEEL-RT-Docs', folder: true });
  drive.add({ id: 'i-report', name: 'KEEL-RT-report.txt', parentId: 'f-docs', content: 'report v1', permissions: [{ id: 'p1', roles: ['read'], grantedToV2: { user: { displayName: 'KEEL-RT-reader' } } }] });
  drive.write('i-report', 'report v2');
  drive.add({ id: 'i-notes', name: 'KEEL-RT-notes.txt', content: 'notes' });
  drive.add({ id: 'i-copy', name: 'KEEL-RT-copy.txt', parentId: 'f-docs', content: 'notes' });
  return drive;
}

const sync = (drive, store, extra = {}) => syncDrive({ transport: drive.transport, store, driveId: DRIVE, tenantRef: TENANT, ...extra });
const records = (store, itemKey) => store.rows.filter((row) => row.itemKey === itemKey && row.metadata.kind === 'drive-record');
const lastRecord = async (store, itemKey) => JSON.parse(await read(store.getItem(records(store, itemKey).at(-1).ref)));

test('a fixture drive syncs: content, versions, folders, paths and sharing permissions', async () => {
  const drive = fixtureDrive();
  const store = fakeStore();
  const { state, stats } = await sync(drive, store);

  assert.equal(stats.files, 3);
  assert.equal(stats.folders, 1);
  assert.equal(stats.versionsFetched, 4, 'two versions of the report, one of each other file');
  assert.equal(stats.deduped, 1, 'the copy has the same bytes as the notes');
  assert.ok(state.deltaLink.includes('/root/delta?token='));
  assert.equal(state.nextLink, null);
  assert.equal(itemPath(state, 'i-report'), '/KEEL-RT-Docs/KEEL-RT-report.txt');

  const report = await lastRecord(store, 'i-report');
  assert.equal(report.path, '/KEEL-RT-Docs/KEEL-RT-report.txt');
  assert.equal(report.currentVersion, '2.0');
  assert.deepEqual(report.permissions.map((p) => p.grantedToV2.user.displayName), ['KEEL-RT-reader']);
  const byVersion = Object.fromEntries(report.versions.map((v) => [v.versionId, v]));
  assert.equal(await read(store.getItem(byVersion['1.0'].ref)), 'report v1');
  assert.equal(await read(store.getItem(byVersion['2.0'].ref)), 'report v2');

  const content = store.rows.filter((row) => row.metadata.kind === 'drive-content');
  assert.ok(content.every((row) => row.container === `drive:${DRIVE}` && row.workload === 'onedrive' && row.tenantRef === TENANT));
  assert.ok(drive.requests.every((r) => r.method === 'GET'), 'read-only: GET only');
  assert.ok(drive.requests.every((r) => r.url.startsWith(`${GRAPH}/drives/${DRIVE}/`)), 'nothing outside the drive');
});

test('a rerun with no change writes nothing and reads only the delta', async () => {
  const drive = fixtureDrive();
  const store = fakeStore();
  const first = await sync(drive, store);
  const puts = store.rows.length;
  drive.requests.length = 0;
  const second = await sync(drive, store, { state: first.state });
  assert.equal(store.rows.length, puts);
  assert.equal(drive.requests.length, 1);
  assert.equal(second.stats.items, 0);
});

test('a renamed and moved file keeps its history under the same key and fetches no content', async () => {
  const drive = fixtureDrive();
  const store = fakeStore();
  const first = await sync(drive, store);
  const before = await lastRecord(store, 'i-report');
  drive.rename('i-report', 'KEEL-RT-renamed.txt');
  drive.move('i-report', 'root');
  drive.requests.length = 0;
  const second = await sync(drive, store, { state: first.state });

  assert.equal(drive.contentRequests().length, 0);
  assert.equal(drive.requests.filter((r) => r.url.endsWith('/versions')).length, 0);
  assert.equal(second.stats.versionsFetched, 0);
  const history = records(store, 'i-report');
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((row) => row.metadata.name), ['KEEL-RT-report.txt', 'KEEL-RT-renamed.txt']);
  const after = await lastRecord(store, 'i-report');
  assert.equal(after.path, '/KEEL-RT-renamed.txt');
  assert.deepEqual(after.versions, before.versions, 'the stored versions carry over');
});

test('an edited file fetches only its new version', async () => {
  const drive = fixtureDrive();
  const store = fakeStore();
  const first = await sync(drive, store);
  drive.write('i-notes', 'notes v2');
  drive.requests.length = 0;
  const second = await sync(drive, store, { state: first.state });
  assert.equal(second.stats.versionsFetched, 1);
  assert.deepEqual(drive.contentRequests().map((r) => new URL(r.url).pathname), [`/v1.0/drives/${DRIVE}/items/i-notes/content`]);
  const notes = await lastRecord(store, 'i-notes');
  assert.deepEqual(notes.versions.map((v) => v.versionId), ['1.0', '2.0']);
});

test('a sharing change alone writes a new record', async () => {
  const drive = fixtureDrive();
  const store = fakeStore();
  const first = await sync(drive, store);
  drive.share('i-notes', { id: 'p9', roles: ['write'], link: { scope: 'organization' } });
  const second = await sync(drive, store, { state: first.state });
  assert.equal(second.stats.versionsFetched, 0);
  assert.equal(second.stats.records, 1);
  assert.equal((await lastRecord(store, 'i-notes')).permissions[0].id, 'p9');
});

test('a deleted file is flagged and its stored content is kept', async () => {
  const drive = fixtureDrive();
  const store = fakeStore();
  const first = await sync(drive, store);
  drive.remove('i-notes');
  const second = await sync(drive, store, { state: first.state });
  assert.equal(second.stats.deleted, 1);
  const notes = await lastRecord(store, 'i-notes');
  assert.equal(notes.deleted, true);
  assert.equal(notes.name, 'KEEL-RT-notes.txt');
  assert.equal(await read(store.getItem(notes.versions[0].ref)), 'notes');
  assert.equal(second.state.items['i-notes'].deleted, true);
});

test('delta resumes after an interruption from the last checkpoint', async () => {
  const drive = fixtureDrive({ pageSize: 2 });
  const store = fakeStore();
  const checkpoints = [];
  let fail = true;
  // The copy is on the last page: the run stops there, after two pages are stored.
  drive.hooks.push(({ url }) => {
    if (fail && url.includes('/items/i-copy/')) throw new Error('connection reset');
  });
  await assert.rejects(sync(drive, store, { checkpoint: async (s) => checkpoints.push(JSON.parse(JSON.stringify(s))) }), /connection reset/);
  assert.equal(checkpoints.length, 2);
  const saved = checkpoints.at(-1);
  assert.ok(saved.nextLink, 'the checkpoint holds the next page');
  assert.equal(saved.deltaLink, null);

  fail = false;
  drive.requests.length = 0;
  const resumed = await sync(drive, store, { state: saved });
  assert.ok(!drive.requests.some((r) => r.url === deltaUrl(DRIVE)), 'did not restart from the first page');
  assert.ok(!drive.contentRequests().some((r) => r.url.includes('i-report')), 'stored pages are not fetched again');
  assert.ok(resumed.state.deltaLink);
  assert.equal(resumed.state.fullPass, null);

  // The resumed backup matches one that never stopped.
  const clean = await sync(fixtureDrive(), fakeStore());
  const summary = (s) => Object.fromEntries(Object.entries(s.items).map(([id, item]) => [id, { deleted: item.deleted, versions: Object.keys(item.versions ?? {}).sort(), recordHash: item.recordHash }]));
  assert.deepEqual(summary(resumed.state), summary(clean.state));
});

test('an expired delta link runs one full pass and flags what disappeared', async () => {
  const drive = fixtureDrive();
  const store = fakeStore();
  const first = await sync(drive, store);
  drive.vanish('i-copy');
  drive.expireTokens();
  drive.requests.length = 0;
  const second = await sync(drive, store, { state: first.state });
  assert.equal(second.stats.resyncs, 1);
  assert.equal(second.stats.versionsFetched, 0, 'unchanged files are not fetched again');
  assert.equal(second.stats.deleted, 1);
  assert.equal((await lastRecord(store, 'i-copy')).deleted, true);
  assert.equal(second.state.items['i-report'].deleted, false);
});

test('throttling waits for Retry-After', async () => {
  const drive = fixtureDrive();
  let throttled = false;
  drive.hooks.push(({ url }) => {
    if (!throttled && url.endsWith('/root/delta')) {
      throttled = true;
      return { status: 429, headers: { 'retry-after': '7' }, body: {} };
    }
    return null;
  });
  const waits = [];
  const { stats } = await sync(drive, fakeStore(), { sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [7000]);
  assert.equal(stats.throttled, 1);
});

test('a page link outside the drive delta is refused, not followed', async () => {
  const drive = fixtureDrive();
  drive.hooks.push(({ url }) => (url.endsWith('/root/delta')
    ? { status: 200, headers: {}, body: { value: [], '@odata.nextLink': `${GRAPH}/drives/${DRIVE}/items/root/children` } }
    : null));
  await assert.rejects(sync(drive, fakeStore()), DriveScopeError);
  const other = fixtureDrive();
  other.hooks.push(({ url }) => (url.endsWith('/root/delta')
    ? { status: 200, headers: {}, body: { value: [], '@odata.nextLink': `${GRAPH}/drives/b!other/root/delta?token=1` } }
    : null));
  await assert.rejects(sync(other, fakeStore()), DriveScopeError);
  assert.equal(other.requests.length, 1);
});

test('URLs are checked against Graph and this drive', () => {
  assert.ok(assertDriveUrl(deltaUrl(DRIVE), { driveId: DRIVE }));
  assert.throws(() => assertDriveUrl('https://evil.example/v1.0/drives/x/root/delta', { driveId: 'x' }), DriveScopeError);
  assert.throws(() => assertDriveUrl(`${GRAPH}/drives/other/items/a/content`, { driveId: DRIVE }), DriveScopeError);
  assert.throws(() => assertDriveUrl(`${GRAPH}/users/u1/messages`, { userId: 'u1' }), DriveScopeError);
  assert.ok(assertDriveUrl(`${GRAPH}/users/u1/drive`, { userId: 'u1' }));
});

test('a failed read is an error, never an empty backup', async () => {
  const drive = fixtureDrive();
  drive.hooks.push(({ url }) => (url.endsWith('/root/delta') ? { status: 403, headers: {}, body: { error: { code: 'accessDenied' } } } : null));
  await assert.rejects(sync(drive, fakeStore()), (error) => error instanceof DriveSyncError && error.status === 403 && /accessDenied/.test(error.message));
});

test('the caller state is not changed and a state for another drive is refused', async () => {
  const drive = fixtureDrive();
  const state = newDriveState(DRIVE);
  const copy = JSON.stringify(state);
  await sync(drive, fakeStore(), { state });
  assert.equal(JSON.stringify(state), copy);
  await assert.rejects(sync(drive, fakeStore(), { state: newDriveState('b!other') }), /belongs to drive/);
});

test('a user OneDrive is found by GET /users/{id}/drive', async () => {
  const seen = [];
  const transport = async (request) => {
    seen.push(request);
    return { status: 200, headers: {}, body: { id: DRIVE, driveType: 'business', owner: { user: { displayName: 'KEEL-RT-user' } } } };
  };
  const found = await resolveUserDrive({ transport, userId: 'KEEL-RT-user@contoso.test' });
  assert.equal(found.driveId, DRIVE);
  assert.deepEqual(seen.map((r) => [r.method, r.url]), [['GET', `${GRAPH}/users/KEEL-RT-user%40contoso.test/drive`]]);
});
