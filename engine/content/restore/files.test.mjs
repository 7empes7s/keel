import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { createIsolatedTestDatabase } from '../../test/dbTestHelper.mjs';
import { schemaSql } from '../../store/loadSchema.mjs';
import { syncDrive } from '../drive.mjs';
import { createPgContentIndex } from '../index.mjs';
import { createContentStore, createMemoryContentStore, createMemoryStorage } from '../store.mjs';
import {
  FilesRestoreRefused, SIMPLE_UPLOAD_LIMIT, columnDefinition, copyName, createQuickXorHash,
  loadDriveBackup, restoreFiles, restoreList, writableFields,
} from './files.mjs';
import { createMemoryRestoreJournal } from './journal.mjs';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TENANT = 'tenant-ref-1';
const DRIVE = 'b!KEEL-RT-drive';
const OTHER = 'b!KEEL-RT-other';
const PROD = 'b!production-drive';
const SITE = 'keelrt.sharepoint.com,site-1,web-1';

const quickXor = (data) => createQuickXorHash().update(data).digest();
const read = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
const approveAll = async ({ action }) => ({ approvalId: `approval-${action}` });

/**
 * A fake Graph tenant: drives with versioned files and folders (delta for the backup,
 * path lookups, uploads and folder creation for the restore), users, and one site with
 * lists. Every non-GET request is logged in `writes`.
 */
function fakeTenant() {
  let clock = 1;
  let ids = 0;
  const tick = () => `2026-10-${String(clock++).padStart(2, '0')}T00:00:00Z`;
  const writes = [];
  const requests = [];
  const failures = [];
  const users = new Set(['user-alice']);
  const drives = new Map();
  const sessions = new Map();
  const newDrive = (driveId, name, extra = {}) => {
    const items = new Map([['root', { id: 'root', root: true, name: 'root', versions: [], permissions: [] }]]);
    drives.set(driveId, { id: driveId, name, items, extra });
    return items;
  };
  newDrive(DRIVE, 'KEEL-RT-Docs', { sharePointIds: { siteId: SITE } });
  newDrive(OTHER, 'OneDrive', { owner: { user: { displayName: 'KEEL-RT-User' } } });
  newDrive(PROD, 'Documents', { owner: { user: { displayName: 'Real Person' } } });

  const site = {
    id: SITE, name: 'KEEL-RT-Site', displayName: 'KEEL-RT-Site', lists: new Map(),
  };

  const tenant = {
    writes, requests, failures, users, drives, site, tick,
    items: (driveId = DRIVE) => drives.get(driveId).items,
    add(id, { name, parentId = 'root', folder = false, data = null, driveId = DRIVE, permissions = [] }) {
      tenant.items(driveId).set(id, { id, name, parentId, folder, versions: data === null ? [] : [{ id: '1.0', data: Buffer.from(data), at: tick() }], permissions });
    },
    write(id, data, driveId = DRIVE) {
      const item = tenant.items(driveId).get(id);
      item.versions.unshift({ id: `${item.versions.length + 1}.0`, data: Buffer.from(data), at: tick() });
    },
    rename(id, name, driveId = DRIVE) { tenant.items(driveId).get(id).name = name; },
    remove(id, driveId = DRIVE) {
      const items = tenant.items(driveId);
      for (const [childId, child] of items) if (child.parentId === id) tenant.remove(childId, driveId);
      items.get(id).deleted = true;
    },
    // The live file at a path, as bytes (null when absent).
    at(path, driveId = DRIVE) {
      const item = find(drives.get(driveId), path);
      return item && !item.folder ? item.versions[0].data : null;
    },
    paths(driveId = DRIVE) {
      const drive = drives.get(driveId);
      return [...drive.items.values()].filter((item) => !item.root && !item.deleted).map((item) => pathOf(drive, item)).sort();
    },
  };

  const pathOf = (drive, item) => {
    const names = [];
    for (let current = item; current && !current.root; current = drive.items.get(current.parentId)) names.unshift(current.name);
    return names.join('/');
  };
  const childOf = (drive, parentId, name) => [...drive.items.values()].find((item) => !item.deleted && item.parentId === parentId && item.name === name);
  const find = (drive, path) => {
    let current = drive.items.get('root');
    for (const name of path.split('/').filter(Boolean)) {
      current = childOf(drive, current.id, name);
      if (!current) return null;
    }
    return current;
  };
  const view = (drive, item) => {
    if (item.deleted) return { id: item.id, deleted: { state: 'deleted' }, parentReference: { id: item.parentId } };
    if (item.root) return { id: 'root', name: 'root', root: {}, folder: { childCount: 0 } };
    const base = { id: item.id, name: item.name, parentReference: { driveId: drive.id, id: item.parentId }, eTag: `"e-${item.id}-${item.name}"` };
    if (item.folder) return { ...base, folder: { childCount: 0 } };
    const current = item.versions[0];
    return {
      ...base, cTag: `"c-${item.id}-${current.id}"`, size: current.data.length, lastModifiedDateTime: current.at,
      file: { mimeType: 'application/octet-stream', hashes: { quickXorHash: quickXor(current.data) } },
    };
  };
  const json = (body, status = 200) => ({ status, headers: {}, body });
  const asJson = (body) => (Buffer.isBuffer(body) || typeof body === 'string' ? JSON.parse(body.toString()) : body);

  const putFile = (drive, parentId, name, data, behavior) => {
    const existing = childOf(drive, parentId, name);
    if (existing && behavior === 'fail') return json({ error: { code: 'nameAlreadyExists' } }, 409);
    if (existing) {
      existing.versions.unshift({ id: `${existing.versions.length + 1}.0`, data, at: tick() });
      return json(view(drive, existing));
    }
    const id = `new-${++ids}`;
    const item = { id, name, parentId, folder: false, versions: [{ id: '1.0', data, at: tick() }], permissions: [] };
    drive.items.set(id, item);
    return json(view(drive, item), 201);
  };

  tenant.transport = async (url, { method = 'GET', body, headers = {} } = {}) => {
    requests.push({ method, url });
    if (method !== 'GET') writes.push({ method, url });
    for (const failure of failures) {
      const answer = failure({ method, url });
      if (answer) return answer;
    }
    // A chunk of an upload session: bytes and a range, to the URL the session named.
    if (sessions.has(url)) {
      const session = sessions.get(url);
      assert.equal(method, 'PUT');
      assert.deepEqual(Object.keys(headers).sort(), ['content-range', 'content-type']);
      const [, start, end, total] = headers['content-range'].match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      assert.equal(Number(start), session.received.length);
      assert.equal(body.length, Number(end) - Number(start) + 1);
      assert.ok(body.length % (320 * 1024) === 0 || Number(end) + 1 === Number(total), 'chunks are multiples of 320 KiB');
      session.received = Buffer.concat([session.received, Buffer.from(body)]);
      if (session.received.length < Number(total)) return json({ nextExpectedRanges: [`${session.received.length}-`] }, 202);
      sessions.delete(url);
      return putFile(session.drive, session.parentId, session.name, session.received, session.behavior);
    }
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://graph.microsoft.com');
    const path = decodeURIComponent(parsed.pathname).replace(/^\/v1\.0/, '');
    let match;
    if ((match = path.match(/^\/users\/([^/]+)$/))) return users.has(match[1]) ? json({ id: match[1] }) : json({ error: { code: 'Request_ResourceNotFound' } }, 404);
    if (path.startsWith('/sites/')) return siteRequest(method, path, parsed, body);
    match = path.match(/^\/drives\/([^/]+)(.*)$/);
    assert.ok(match, path);
    const drive = drives.get(match[1]);
    if (!drive) return json({ error: { code: 'itemNotFound' } }, 404);
    const rest = match[2];
    if (rest === '') return json({ id: drive.id, name: drive.name, driveType: 'business', ...drive.extra });
    if (rest === '/root/delta') {
      const value = [...drive.items.values()].map((item) => view(drive, item));
      return json({ value, '@odata.deltaLink': `${GRAPH}/drives/${drive.id}/root/delta?token=${clock}` });
    }
    if (rest === '/root') return json(view(drive, drive.items.get('root')));
    if ((match = rest.match(/^\/root:\/(.+)$/))) {
      const item = find(drive, match[1]);
      return item ? json(view(drive, item)) : json({ error: { code: 'itemNotFound' } }, 404);
    }
    if ((match = rest.match(/^\/items\/([^/:]+):\/([^/:]+):\/(content|createUploadSession)$/))) {
      const [, parentId, name, verb] = match;
      if (verb === 'content') {
        assert.equal(method, 'PUT');
        return putFile(drive, parentId, name, Buffer.from(body), parsed.searchParams.get('@microsoft.graph.conflictBehavior'));
      }
      assert.equal(method, 'POST');
      const uploadUrl = `https://keelrt.sharepoint.com/_api/upload/${++ids}`;
      sessions.set(uploadUrl, { drive, parentId, name, behavior: asJson(body).item['@microsoft.graph.conflictBehavior'], received: Buffer.alloc(0) });
      return json({ uploadUrl });
    }
    match = rest.match(/^\/items\/([^/]+)(\/.*)?$/);
    assert.ok(match, rest);
    const item = drive.items.get(match[1]);
    if (!item || item.deleted) return json({ error: { code: 'itemNotFound' } }, 404);
    const sub = match[2] ?? '';
    if (sub === '/children' && method === 'POST') {
      const request = asJson(body);
      if (childOf(drive, item.id, request.name)) return json({ error: { code: 'nameAlreadyExists' } }, 409);
      const id = `new-${++ids}`;
      drive.items.set(id, { id, name: request.name, parentId: item.id, folder: true, versions: [], permissions: [] });
      return json(view(drive, drive.items.get(id)), 201);
    }
    if (sub === '/invite' && method === 'POST') {
      const request = asJson(body);
      assert.equal(request.sendInvitation, false);
      for (const recipient of request.recipients) {
        item.permissions.push({ id: `p-${++ids}`, roles: request.roles, grantedToV2: { user: { id: recipient.objectId } } });
      }
      return json({ value: [] });
    }
    assert.equal(method, 'GET', `${method} ${url}`);
    if (sub === '/permissions') return json({ value: item.permissions });
    if (sub === '/versions') return json({ value: item.versions.map((v) => ({ id: v.id, lastModifiedDateTime: v.at, size: v.data.length })) });
    if (sub === '/content') return { status: 200, headers: {}, body: Readable.from([item.versions[0].data]) };
    if ((match = sub.match(/^\/versions\/([^/]+)\/content$/))) return { status: 200, headers: {}, body: item.versions.find((v) => v.id === match[1]).data };
    throw new Error(`unexpected request ${method} ${url}`);
  };

  function siteRequest(method, path, parsed, body) {
    const prefix = `/sites/${SITE}`;
    if (!path.startsWith(prefix)) return json({ error: { code: 'itemNotFound' } }, 404);
    const rest = path.slice(prefix.length);
    if (rest === '') return json({ id: site.id, name: site.name, displayName: site.displayName });
    if (rest === '/lists') {
      if (method === 'POST') {
        const request = asJson(body);
        const id = `list-${++ids}`;
        site.lists.set(id, { id, displayName: request.displayName, list: request.list, columns: [{ name: 'Title', text: {} }], items: new Map() });
        return json({ id }, 201);
      }
      return json({ value: [...site.lists.values()].map((list) => ({ id: list.id, displayName: list.displayName })) });
    }
    const match = rest.match(/^\/lists\/([^/]+)(?:\/(columns|items)(?:\/([^/]+)(\/fields)?)?)?$/);
    assert.ok(match, rest);
    const list = site.lists.get(match[1]);
    if (!list) return json({ error: { code: 'itemNotFound' } }, 404);
    const [, , part, itemId, fields] = match;
    if (!part) return json({ id: list.id, displayName: list.displayName });
    if (part === 'columns') {
      if (method === 'POST') {
        const column = asJson(body);
        list.columns.push(column);
        return json({ id: `col-${++ids}`, ...column }, 201);
      }
      return json({ value: list.columns });
    }
    if (method === 'POST') {
      const id = String(++ids);
      list.items.set(id, { id, lastModifiedDateTime: tick(), fields: { ...asJson(body).fields } });
      return json({ id }, 201);
    }
    if (method === 'PATCH' && fields) {
      const item = list.items.get(itemId);
      Object.assign(item.fields, asJson(body));
      item.lastModifiedDateTime = tick();
      return json(item.fields);
    }
    assert.equal(method, 'GET');
    assert.equal(parsed.searchParams.get('$expand'), 'fields');
    // What Graph returns: the item's values plus what SharePoint sets on its own.
    return json({
      value: [...list.items.values()].map((item) => ({
        ...item, eTag: `"${item.id},3"`,
        fields: {
          '@odata.etag': `"${item.id},3"`, id: item.id, ContentType: 'Item', Modified: item.lastModifiedDateTime, Created: '2026-10-01T00:00:00Z',
          AuthorLookupId: '7', EditorLookupId: '7', _UIVersionString: '3.0', Attachments: false, Edit: '', LinkTitle: item.fields.Title, ...item.fields,
        },
      })),
    });
  }
  return tenant;
}

// The OneDrive collector's shape: container drive:<id>, workload sharepoint here
// because the fixture drive is a site library.
async function backup(tenant, store, { driveId = DRIVE, state = null } = {}) {
  const at = tenant.tick();
  const result = await syncDrive({
    transport: ({ method, url }) => tenant.transport(url, { method }), store, driveId, tenantRef: TENANT, workload: 'sharepoint', state, now: () => new Date(at),
  });
  return { state: result.state, at };
}
const source = { tenantRef: TENANT, workload: 'sharepoint', container: `drive:${DRIVE}`, driveId: DRIVE };

function seedDrive(tenant, { big = null } = {}) {
  tenant.add('folder-docs', { name: 'Docs', folder: true });
  tenant.add('folder-sub', { name: 'Sub', folder: true, parentId: 'folder-docs' });
  tenant.add('file-a', { name: 'a.txt', parentId: 'folder-docs', data: 'alpha v1' });
  tenant.add('file-b', { name: 'b.txt', parentId: 'folder-sub', data: 'bravo' });
  if (big) tenant.add('file-big', { name: 'big.bin', parentId: 'folder-docs', data: big });
  tenant.add('file-top', { name: 'top.txt', data: 'top level' });
}

test('quickXorHash matches Graph for known inputs', () => {
  assert.equal(quickXor(Buffer.alloc(0)), 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  assert.equal(quickXor(Buffer.from('J')), 'SgAAAAAAAAAAAAAAAQAAAAAAAAA=');
  // Chunked updates give the same hash as one update.
  const data = randomBytes(5000);
  assert.equal(createQuickXorHash().update(data.subarray(0, 123)).update(data.subarray(123)).digest(), quickXor(data));
});

test('copy names keep the extension and carry the restored date', () => {
  assert.equal(copyName('report.docx', '2026-10-12T08:00:00Z'), 'report (restored 2026-10-12).docx');
  assert.equal(copyName('README', '2026-10-12T08:00:00Z', 2), 'README (restored 2026-10-12 2)');
});

test('a deleted folder restores byte for byte, large files through an upload session, and a rerun writes nothing', async () => {
  const tenant = fakeTenant();
  const store = createMemoryContentStore();
  const big = randomBytes(SIMPLE_UPLOAD_LIMIT + 3 * 1024 * 1024 + 17);
  seedDrive(tenant, { big });
  let { state } = await backup(tenant, store);
  tenant.remove('folder-docs');
  ({ state } = await backup(tenant, store, { state }));
  assert.deepEqual(tenant.paths(), ['top.txt']);

  const gateCalls = [];
  const gate = async (request) => { gateCalls.push(request); return { approvalId: 'approval-1' }; };
  const journal = createMemoryRestoreJournal();
  const first = await restoreFiles({ store, transport: tenant.transport, journal, gate, source, scope: { kind: 'folder', itemId: 'folder-docs' } });
  assert.equal(first.approvalId, 'approval-1');
  assert.equal(gateCalls.length, 1);
  assert.equal(gateCalls[0].capability, 'content-restore');
  assert.equal(gateCalls[0].action, 'content-restore');
  assert.equal(first.stats.failed, 0);
  assert.deepEqual(tenant.paths(), ['Docs', 'Docs/Sub', 'Docs/Sub/b.txt', 'Docs/a.txt', 'Docs/big.bin', 'top.txt']);
  assert.equal(tenant.at('Docs/a.txt').toString(), 'alpha v1');
  assert.equal(tenant.at('Docs/Sub/b.txt').toString(), 'bravo');
  assert.ok(tenant.at('Docs/big.bin').equals(big), 'large file is byte-identical');
  assert.ok(tenant.writes.some((w) => w.url.endsWith('/createUploadSession')), 'large file used an upload session');
  assert.ok(tenant.writes.some((w) => w.url.startsWith('https://keelrt.sharepoint.com/')));

  tenant.writes.length = 0;
  const second = await restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate, source, scope: { kind: 'folder', itemId: 'folder-docs' } });
  assert.deepEqual(tenant.writes, []);
  assert.equal(second.stats.writes, 0);
  assert.equal(gateCalls.length, 1, 'nothing to write asks for no approval');
  assert.ok(second.plan.every((step) => step.action === 'skip'));
});

test('a renamed file restores at its old version under its old name', async () => {
  const tenant = fakeTenant();
  const store = createMemoryContentStore();
  seedDrive(tenant);
  let { state, at: before } = await backup(tenant, store);
  tenant.rename('file-a', 'a-final.txt');
  tenant.write('file-a', 'alpha v2');
  ({ state } = await backup(tenant, store, { state }));

  const result = await restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source, scope: { kind: 'file', itemId: 'file-a' }, at: before });
  assert.equal(result.plan[0].action, 'create');
  assert.equal(tenant.at('Docs/a.txt').toString(), 'alpha v1');
  assert.equal(tenant.at('Docs/a-final.txt').toString(), 'alpha v2', 'the live file is untouched');

  // A chosen older version of the file as it is now, by version id.
  const backed = await loadDriveBackup({ store, tenantRef: TENANT, workload: 'sharepoint', container: `drive:${DRIVE}`, driveId: DRIVE });
  assert.deepEqual(backed.records.get('file-a').versions.map((v) => v.versionId), ['1.0', '2.0']);
  const versioned = await restoreFiles({
    store, transport: tenant.transport, gate: approveAll, journal: createMemoryRestoreJournal(), source, scope: { kind: 'file', itemId: 'file-a' }, version: '1.0',
    target: { driveId: OTHER, folderPath: 'KEEL-RT-restore' },
  });
  assert.equal(versioned.approvalId, 'approval-content-restore-other-location');
  assert.equal(tenant.at('KEEL-RT-restore/a-final.txt', OTHER).toString(), 'alpha v1');
});

test('a newer live file is never overwritten unless asked', async () => {
  const tenant = fakeTenant();
  const store = createMemoryContentStore();
  seedDrive(tenant);
  await backup(tenant, store);
  tenant.write('file-a', 'alpha edited after the backup');
  const scope = { kind: 'file', itemId: 'file-a' };

  const copy = await restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source, scope });
  assert.equal(copy.plan[0].action, 'create-copy');
  const copyPath = copy.plan[0].path;
  assert.match(copyPath, /^Docs\/a \(restored 2026-10-\d\d\)\.txt$/);
  assert.equal(tenant.at(copyPath).toString(), 'alpha v1');
  assert.equal(tenant.at('Docs/a.txt').toString(), 'alpha edited after the backup');

  const replace = await restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source, scope, conflict: 'replace' });
  assert.equal(replace.plan[0].action, 'skip', 'the copy made before is found, not made again');
  assert.equal(tenant.at('Docs/a.txt').toString(), 'alpha edited after the backup');

  const forced = await restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source, scope, conflict: 'replace-newer' });
  assert.equal(forced.plan[0].action, 'replace');
  assert.equal(tenant.at('Docs/a.txt').toString(), 'alpha v1');
});

test('replace overwrites a live file that is older than the restored version', async () => {
  const tenant = fakeTenant();
  const store = createMemoryContentStore();
  seedDrive(tenant);
  tenant.write('file-a', 'alpha v2');
  await backup(tenant, store);
  // An older file appears in its place (a restore from elsewhere, an old upload).
  const item = tenant.items().get('file-a');
  item.versions.unshift({ id: '9.0', data: Buffer.from('stale'), at: '2026-01-01T00:00:00Z' });
  const result = await restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source, scope: { kind: 'file', itemId: 'file-a' }, conflict: 'replace' });
  assert.equal(result.plan[0].action, 'replace');
  assert.equal(tenant.at('Docs/a.txt').toString(), 'alpha v2');
});

test('the target guard and the gate refuse before anything is written', async () => {
  const tenant = fakeTenant();
  const store = createMemoryContentStore();
  seedDrive(tenant);
  await backup(tenant, store);
  tenant.remove('file-top');
  const scope = { kind: 'file', itemId: 'file-top' };

  await assert.rejects(
    restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source, scope, target: { driveId: PROD, folderPath: 'x' } }),
    FilesRestoreRefused,
  );
  await assert.rejects(restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, source, scope }), /needs a gate/);
  await assert.rejects(
    restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: async () => { throw new Error('two approvers needed'); }, source, scope }),
    /not approved: two approvers needed/,
  );
  await assert.rejects(restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: async () => null, source, scope }), FilesRestoreRefused);
  assert.deepEqual(tenant.writes, []);

  const dry = await restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, source, scope, dryRun: true });
  assert.equal(dry.plan[0].action, 'create');
  assert.deepEqual(tenant.writes, []);
});

test('a run that failed part way resumes from the journal with no duplicate writes', async () => {
  const tenant = fakeTenant();
  const store = createMemoryContentStore();
  seedDrive(tenant);
  let { state } = await backup(tenant, store);
  tenant.remove('folder-docs');
  ({ state } = await backup(tenant, store, { state }));

  const journal = createMemoryRestoreJournal();
  const scope = { kind: 'folder', itemId: 'folder-docs' };
  let uploads = 0;
  tenant.failures.push(({ method, url }) => {
    if (method === 'PUT' && url.includes('/content') && ++uploads === 2) throw new Error('worker killed');
    return null;
  });
  const stopped = await restoreFiles({ store, transport: tenant.transport, journal, gate: approveAll, source, scope });
  assert.equal(stopped.stats.failed, 1);
  assert.match(stopped.plan.find((step) => step.outcome === 'failed').error, /worker killed/);
  tenant.failures.length = 0;
  const before = tenant.writes.length;
  const resumed = await restoreFiles({ store, transport: tenant.transport, journal, gate: approveAll, source, scope });
  assert.equal(resumed.stats.failed, 0);
  assert.ok(resumed.plan.some((step) => step.outcome === 'done-earlier'));
  const uploadsTo = (name) => tenant.writes.filter((w) => w.method === 'PUT' && w.url.includes(`:/${name}:`)).length;
  assert.equal(uploadsTo('a.txt'), 1, 'the file written before the failure is not written again');
  assert.equal(uploadsTo('b.txt'), 2, 'the failed upload, then its retry');
  assert.deepEqual(tenant.paths(), ['Docs', 'Docs/Sub', 'Docs/Sub/b.txt', 'Docs/a.txt', 'top.txt']);
  assert.ok(tenant.writes.length > before);
  assert.equal(tenant.at('Docs/Sub/b.txt').toString(), 'bravo');
});

test('sharing permissions are restored only on request and only to principals that exist', async () => {
  const tenant = fakeTenant();
  const store = createMemoryContentStore();
  tenant.add('file-s', {
    name: 'shared.txt', data: 'shared',
    permissions: [
      { id: 'p1', roles: ['write'], grantedToV2: { user: { id: 'user-alice', displayName: 'KEEL-RT-Alice' } } },
      { id: 'p2', roles: ['read'], grantedToV2: { user: { id: 'user-gone', displayName: 'Gone' } } },
      { id: 'p3', roles: ['read'], link: { type: 'view', webUrl: 'https://x' } },
      { id: 'p4', roles: ['owner'], grantedToV2: { user: { id: 'user-owner' } } },
      { id: 'p5', roles: ['read'], inheritedFrom: { id: 'root' }, grantedToV2: { user: { id: 'user-alice' } } },
    ],
  });
  let { state } = await backup(tenant, store);
  tenant.remove('file-s');
  ({ state } = await backup(tenant, store, { state }));
  const scope = { kind: 'file', itemId: 'file-s' };

  const plain = await restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source, scope });
  assert.deepEqual(plain.plan[0].granted, undefined);
  const restored = tenant.items().get(plain.plan[0].targetRef);
  assert.deepEqual(restored.permissions, []);

  const withGrants = await restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source, scope, permissions: true });
  const outcomes = Object.fromEntries(withGrants.plan[0].granted.map((g) => [g.principalId ?? g.skip, g.outcome]));
  assert.deepEqual(outcomes, { 'user-alice': 'granted', 'user-gone': 'principal-missing', 'sharing link': 'not-restored', 'user-owner': 'not-restored' });
  assert.deepEqual(restored.permissions.map((p) => [p.grantedToV2.user.id, p.roles]), [['user-alice', ['write']]]);

  tenant.writes.length = 0;
  await restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source, scope, permissions: true });
  assert.deepEqual(tenant.writes, [], 'a grant already present is not made again');
});

// Lists, stored the way engine/content/sharepointSites.mjs stores them.
async function putJson(store, itemKey, value, version) {
  return store.putItem(Readable.from([Buffer.from(JSON.stringify(value))]), {
    tenantRef: TENANT, workload: 'sharepoint-sites', container: `site:${SITE}`, itemKey, version, metadata: { contentType: 'application/json' },
  });
}

const COLUMNS = [
  { name: 'Title', text: {} },
  { name: 'Status', displayName: 'Status', choice: { choices: ['Open', 'Done'] } },
  { name: 'Cost', number: { decimalPlaces: 'two' } },
  { name: 'Owner', personOrGroup: {} },
  { name: 'Modified', readOnly: true, dateTime: {} },
];

async function seedList(tenant, store) {
  const list = { id: 'list-orig', displayName: 'KEEL-RT-Tasks', list: { template: 'genericList' }, columns: COLUMNS.slice(0, 1), items: new Map() };
  tenant.site.lists.set(list.id, list);
  await putJson(store, 'list/list-orig', { id: 'list-orig', displayName: 'KEEL-RT-Tasks', list: { template: 'genericList' } }, 'v1');
  await putJson(store, 'list/list-orig/columns', COLUMNS, 'cols-1');
  const items = [
    { id: '1', eTag: 'e1', lastModifiedDateTime: '2026-10-05T00:00:00Z', fields: { Title: 'Ship it', Status: 'Open', Cost: 12.5, OwnerLookupId: '7', Modified: '2026-10-05T00:00:00Z', '@odata.etag': 'x', _UIVersionString: '1.0' } },
    { id: '2', eTag: 'e2', lastModifiedDateTime: '2026-10-05T00:00:00Z', fields: { Title: 'Test it', Status: 'Done' } },
  ];
  for (const item of items) await putJson(store, `list/list-orig/item/${item.id}`, item, item.eTag);
  return list;
}

test('list columns and items restore, unportable values are reported, and a rerun writes nothing', async () => {
  const tenant = fakeTenant();
  const store = createMemoryContentStore();
  const list = await seedList(tenant, store);
  // Item 1 survives with an edit made after the backup, item 2 is gone.
  list.items.set('1', { id: '1', lastModifiedDateTime: '2026-10-20T00:00:00Z', fields: { Title: 'Ship it later', Status: 'Open', Cost: 12.5 } });
  const listSource = { tenantRef: TENANT, siteId: SITE, listId: 'list-orig' };

  const first = await restoreList({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source: listSource, conflict: 'replace' });
  const actions = Object.fromEntries(first.plan.map((step) => [step.itemKey, step.action]));
  assert.deepEqual(actions, {
    'column:Status': 'create-column', 'column:Cost': 'create-column', 'column:Owner': 'not-restored', 'item:1': 'create', 'item:2': 'create',
  });
  assert.match(first.plan.find((s) => s.itemKey === 'item:1').reason, /newer/);
  assert.deepEqual(list.columns.map((c) => c.name), ['Title', 'Status', 'Cost']);
  const values = [...list.items.values()].map((item) => item.fields).sort((a, b) => a.Title.localeCompare(b.Title));
  assert.deepEqual(values, [
    { Title: 'Ship it', Status: 'Open', Cost: 12.5 },
    { Title: 'Ship it later', Status: 'Open', Cost: 12.5 },
    { Title: 'Test it', Status: 'Done' },
  ]);

  tenant.writes.length = 0;
  const second = await restoreList({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source: listSource, conflict: 'replace' });
  assert.deepEqual(tenant.writes, []);
  assert.ok(second.plan.filter((s) => s.kind === 'item').every((s) => s.action === 'skip'));
});

test('a list restores into a new list on another location, once', async () => {
  const tenant = fakeTenant();
  const store = createMemoryContentStore();
  await seedList(tenant, store);
  tenant.site.lists.delete('list-orig');
  const request = {
    store, transport: tenant.transport, gate: approveAll, journal: createMemoryRestoreJournal(),
    source: { tenantRef: TENANT, siteId: SITE, listId: 'list-orig' }, target: { siteId: SITE, listName: 'KEEL-RT-Tasks restored' },
  };
  const first = await restoreList(request);
  assert.equal(first.approvalId, 'approval-content-restore-other-location');
  const [created] = [...tenant.site.lists.values()];
  assert.equal(created.displayName, 'KEEL-RT-Tasks restored');
  assert.equal(created.items.size, 2);
  tenant.writes.length = 0;
  await restoreList(request);
  assert.deepEqual(tenant.writes, []);

  await assert.rejects(
    restoreList({ ...request, target: undefined }),
    /no longer exists/,
  );
});

test('the list helpers keep user columns and drop system and id-valued ones', () => {
  assert.deepEqual([...writableFields(COLUMNS)].sort(), ['Cost', 'Status', 'Title']);
  assert.deepEqual(columnDefinition(COLUMNS[1]), { choice: { choices: ['Open', 'Done'] }, name: 'Status', displayName: 'Status' });
  assert.equal(columnDefinition(COLUMNS[3]), null);
  assert.equal(columnDefinition(COLUMNS[4]), null);
});

test('Postgres-indexed backup: the records read back from the database restore the same way', async (t) => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  t.after(async () => {
    await client.end();
    await database.cleanup();
  });
  await client.query(schemaSql());
  const store = createContentStore({ index: createPgContentIndex(client), storage: createMemoryStorage(), key: randomBytes(32) });
  const tenant = fakeTenant();
  seedDrive(tenant);
  let { state, at: before } = await backup(tenant, store);
  tenant.rename('file-a', 'a-final.txt');
  tenant.write('file-a', 'alpha v2');
  ({ state } = await backup(tenant, store, { state }));
  tenant.remove('folder-docs');
  ({ state } = await backup(tenant, store, { state }));

  const result = await restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source, scope: { kind: 'folder', itemId: 'folder-docs' }, at: before });
  assert.equal(result.stats.failed, 0);
  assert.deepEqual(tenant.paths(), ['Docs', 'Docs/Sub', 'Docs/Sub/b.txt', 'Docs/a.txt', 'top.txt']);
  assert.equal(tenant.at('Docs/a.txt').toString(), 'alpha v1');
  tenant.writes.length = 0;
  await restoreFiles({ journal: createMemoryRestoreJournal(), store, transport: tenant.transport, gate: approveAll, source, scope: { kind: 'folder', itemId: 'folder-docs' }, at: before });
  assert.deepEqual(tenant.writes, []);
});

