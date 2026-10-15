import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { schemaSql } from '../engine/store/loadSchema.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { createMemoryContentStore } from '../engine/content/store.mjs';
import { createQuickXorHash, restoreRunKey } from '../engine/content/restore/files.mjs';
import { main } from './keel-content-restore.mjs';
import { filesRequestFromArgs, requestGuard } from './keel-content-restore-files.mjs';

const config = { tenantId: 'KEEL-RT-tenant-id', clientId: 'collector-app' };
const reader = { tenantId: config.tenantId, clientId: 'reader-app', certPath: '/etc/keel/r.pem', keyPath: '/etc/keel/r.key', contentKeyFile: '/etc/keel/content.key', storage: { kind: 'local', root: '/var/lib/keel/content' } };
const restorer = { tenantId: config.tenantId, clientId: 'restorer-app', certPath: '/etc/keel/w.pem', keyPath: '/etc/keel/w.key' };
const files = {
  '/etc/keel/tenant.json': JSON.stringify(config),
  '/etc/keel/content-reader.json': JSON.stringify(reader),
  '/etc/keel/content-restorer.json': JSON.stringify(restorer),
};
const TENANT = tenantRefFor(config.tenantId);
const DRIVE = 'b!keel-rt-onedrive';
const CONTENT = Buffer.from('KEEL-RT report, version 1\n');

// One OneDrive file as the DRIVE collector stores it: the content version and its record.
async function seededStore() {
  const store = createMemoryContentStore();
  const base = { tenantRef: TENANT, workload: 'onedrive', container: `drive:${DRIVE}`, itemKey: 'item-1' };
  const content = await store.putItem(Readable.from([CONTENT]), { ...base, version: 'v1', metadata: { kind: 'drive-content', driveId: DRIVE, itemId: 'item-1' } });
  const record = {
    kind: 'file', driveId: DRIVE, id: 'item-1', name: 'KEEL-RT-report.txt', parentId: 'root', path: '/KEEL-RT-report.txt', size: CONTENT.length,
    lastModifiedDateTime: '2026-10-14T10:00:00Z', currentVersion: 'v1', permissions: [], deleted: false,
    versions: [{ versionId: 'v1', ref: content.ref, sha256: content.sha256, bytes: content.bytes, lastModifiedDateTime: '2026-10-14T10:00:00Z' }],
  };
  await store.putItem(Readable.from([Buffer.from(JSON.stringify(record))]), {
    ...base, version: 'record:1', metadata: { kind: 'drive-record', driveId: DRIVE, itemId: 'item-1', observedAt: '2026-10-14T11:00:00Z' },
  });
  return store;
}

function fakeGraph({ owner = 'KEEL-RT-User' } = {}) {
  const requests = [];
  const items = new Map();
  const json = (body, status = 200) => ({ status, headers: {}, body });
  const view = (name, data) => ({ id: `id-${name}`, name, size: data.length, lastModifiedDateTime: '2026-10-15T09:00:00Z', file: { hashes: { quickXorHash: createQuickXorHash().update(data).digest() } } });
  const transport = async (url, { method = 'GET', body } = {}) => {
    requests.push({ method, url });
    const path = decodeURIComponent(new URL(url).pathname).replace('/v1.0', '');
    if (path === `/drives/${DRIVE}`) return json({ id: DRIVE, name: 'OneDrive', driveType: 'business', owner: { user: { displayName: owner } } });
    if (path === `/drives/${DRIVE}/root`) return json({ id: 'root', root: {}, folder: {} });
    let match = path.match(/^\/drives\/[^/]+\/root:\/(.+)$/);
    if (match) return items.has(match[1]) ? json(view(match[1], items.get(match[1]))) : json({ error: { code: 'itemNotFound' } }, 404);
    match = path.match(/^\/drives\/[^/]+\/items\/root:\/(.+):\/content$/);
    if (match && method === 'PUT') {
      items.set(match[1], Buffer.from(body));
      return json(view(match[1], items.get(match[1])), 201);
    }
    return json({ error: { code: 'unexpected' } }, 400);
  };
  return { requests, items, writes: () => requests.filter((request) => request.method !== 'GET'), transport };
}

test('the command line names one file or list restore, keyed the way the engine keys it', () => {
  const request = filesRequestFromArgs(['--drive', DRIVE, '--file', 'item-1', '--at', '2026-10-14T12:00:00Z'], TENANT);
  assert.deepEqual(request.source, { tenantRef: TENANT, workload: 'onedrive', container: `drive:${DRIVE}`, driveId: DRIVE });
  assert.deepEqual(request.scope, { kind: 'file', itemId: 'item-1' });
  assert.equal(request.conflict, 'copy');
  const library = filesRequestFromArgs(['--drive', 'b!lib', '--site', 'site-1', '--whole-drive', '--target-folder', 'KEEL-RT-restore'], TENANT);
  assert.deepEqual(library.source, { tenantRef: TENANT, workload: 'sharepoint-sites', container: 'site:site-1', driveId: 'b!lib' });
  assert.deepEqual(library.target, { driveId: 'b!lib', folderPath: 'KEEL-RT-restore' });
  const list = filesRequestFromArgs(['--site', 'site-1', '--list', 'list-1', '--items', '2,1', '--target-list-name', 'KEEL-RT-Tasks restored'], TENANT);
  assert.deepEqual(list.itemIds, ['1', '2']);
  assert.deepEqual(list.target, { siteId: 'site-1', listId: null, listName: 'KEEL-RT-Tasks restored' });
  assert.throws(() => filesRequestFromArgs(['--drive', DRIVE, '--file', 'a', '--whole-drive'], TENANT), /exactly one/);
  assert.throws(() => filesRequestFromArgs(['--drive', DRIVE, '--file', 'a', '--conflict', 'clobber'], TENANT), /--conflict/);
  assert.match(restoreRunKey(request), /^files:[0-9a-f]{32}$/);
});

test('the transport guard keeps every call inside the target drive or site', () => {
  const files = requestGuard(filesRequestFromArgs(['--drive', DRIVE, '--file', 'x', '--permissions'], TENANT));
  assert.equal(files('', { method: 'PUT', endpoint: `/drives/${DRIVE}/items/root:/a.txt:/content` }), true);
  assert.equal(files('', { method: 'GET', endpoint: '/sites/s1?$select=id' }), true);
  assert.equal(files('', { method: 'GET', endpoint: '/users/u1?$select=id' }), true);
  assert.match(files('', { method: 'POST', endpoint: '/sites/s1/lists' }), /outside the restore target/);
  assert.match(files('', { method: 'PUT', endpoint: '/drives/b!other/items/root:/a.txt:/content' }), /outside/);
  assert.match(files('', { method: 'POST', endpoint: '/users/u1/sendMail' }), /outside/);
  assert.equal(files('https://keelrt.sharepoint.com/upload/1', { method: 'PUT', endpoint: null }), true);
  const list = requestGuard(filesRequestFromArgs(['--site', 'site-1', '--list', 'l1'], TENANT));
  assert.match(list('https://keelrt.sharepoint.com/upload/1', { method: 'PUT', endpoint: null }), /upload chunk/);
  assert.equal(list('', { method: 'POST', endpoint: '/sites/site-1/lists/l1/items' }), true);
  assert.match(list('', { method: 'GET', endpoint: '/sites/site-2/lists' }), /outside/);
});

test('plan, request, gate, test-tenant guard, run and rerun of a file restore through the command line', async (t) => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const setup = await database.connect();
  t.after(async () => {
    await setup.end();
    await database.cleanup();
  });
  await setup.query(schemaSql());
  const { rows: [actor] } = await setup.query(`INSERT INTO principal (email) VALUES ('keel-rt-operator@contoso.test') RETURNING id`);
  const { rows: [approver] } = await setup.query(`INSERT INTO principal (email) VALUES ('keel-rt-approver@contoso.test') RETURNING id`);
  const store = await seededStore();
  const lines = [];
  const graph = fakeGraph();
  const deps = (overrides = {}) => ({
    readFile: (path) => { if (!(path in files)) throw new Error(`no file ${path}`); return files[path]; },
    exists: (path) => path in files,
    connectFn: () => database.connect(),
    env: { KEEL_DB_URL: 'test' },
    logger: { log: (line) => lines.push(line) },
    openStore: () => store,
    getTokenFn: async () => 'token',
    writeTransportFor: async (_token, { guard }) => async (url, options) => {
      const endpoint = decodeURIComponent(new URL(url).pathname).replace('/v1.0', '') + new URL(url).search;
      const verdict = guard(url, { method: options?.method ?? 'GET', endpoint });
      if (verdict !== true) throw new Error(`guard refused: ${verdict}`);
      return graph.transport(url, options);
    },
    testTenantRefs: [TENANT],
    canFn: async () => true,
    ...overrides,
  });
  const source = ['--drive', DRIVE, '--file', 'item-1'];

  assert.equal(await main(['files', 'plan', ...source], deps()), 0);
  const planned = JSON.parse(lines.pop());
  assert.equal(planned.dryRun, true);
  assert.deepEqual(planned.steps.map((step) => [step.path, step.action]), [['KEEL-RT-report.txt', 'create']]);
  assert.equal(graph.writes().length, 0, 'a plan writes nothing');

  const request = filesRequestFromArgs(source, TENANT);
  assert.equal(restoreRunKey(request), planned.runId);
  const approval = async (params, decidedBy = approver.id) => (await setup.query(
    `INSERT INTO approval_request (action, params, requested_by, decided_by, status, expires_at) VALUES ('content-restore', $1, $2, $3, 'approved', now() + interval '1 day') RETURNING id`,
    [params, actor.id, decidedBy],
  )).rows[0].id;
  const approvalId = await approval({ runId: planned.runId, tenantRef: TENANT, workload: 'onedrive', request });
  const run = (overrides, id = approvalId) => main(['files', 'run', '--approval-id', id, '--actor', actor.id], deps(overrides));

  await assert.rejects(run({}, await approval({ runId: planned.runId, tenantRef: TENANT, workload: 'onedrive', request }, actor.id)), /not decided by someone other than the requester/);
  const tampered = await approval({ runId: planned.runId, tenantRef: TENANT, workload: 'onedrive', request: { ...request, target: { driveId: 'b!other', folderPath: null } } });
  await assert.rejects(run({}, tampered), /not a file restore of this tenant/);

  await assert.rejects(run({ canFn: async () => false }), /does not hold the content-restore capability/);
  await assert.rejects(run({ exists: (path) => path in files && !path.endsWith('content-restorer.json') }), /waiting on the content-restorer app/);
  const notFixture = fakeGraph({ owner: 'Alex Wilber' });
  await assert.rejects(
    run({ writeTransportFor: async () => notFixture.transport }),
    /only to KEEL-RT- targets/,
  );
  assert.equal(notFixture.writes().length, 0, 'a refused target gets no write');
  assert.equal(graph.writes().length, 0);

  assert.equal(await run(), 0);
  const report = JSON.parse(lines.pop());
  assert.equal(report.status, 'completed');
  assert.deepEqual(graph.items.get('KEEL-RT-report.txt'), CONTENT);
  const writes = graph.writes().length;
  assert.equal(writes, 1);
  assert.equal(await run(), 0);
  assert.equal(graph.writes().length, writes, 'running the approved request again writes nothing');
  const { rows: [held] } = await setup.query('SELECT status, requested_by, approved_by FROM content_restore_run WHERE id = $1', [planned.runId]);
  assert.deepEqual(held, { status: 'completed', requested_by: actor.id, approved_by: approver.id });
});
