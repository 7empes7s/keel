// Security audit run 2, findings 4 and 6: a content restore's approval covers exactly what
// was reviewed. A restore to another location is filed under the tenant's two-person rule,
// the point in time is fixed when the request is made, the approval runs only within its
// window, and a completed run never starts again. Fake Graph and local Postgres only.
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { schemaSql } from '../engine/store/loadSchema.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { createMemoryContentStore } from '../engine/content/store.mjs';
import { createQuickXorHash, filesRestoreRequest, restoreRunKey } from '../engine/content/restore/files.mjs';
import { CONTENT_RESTORE_OTHER_LOCATION } from '../engine/content/restore/gate.mjs';
import { mailRestoreRunId, normalizeMailRestoreRequest } from '../engine/content/restore/mail.mjs';
import { normalizeTeamsMessagesRequest } from '../engine/content/restore/teamsMessages.mjs';
import { approveRequest } from '../engine/govern/approvals.mjs';
import { setApprovalPolicy } from '../engine/govern/approvalPolicy.mjs';
import { main, mailPolicyActions } from './keel-content-restore.mjs';
import { teamsPolicyActions } from './keel-content-restore-teams.mjs';

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
const TEAM = '11111111-2222-3333-4444-555555555555';
const OTHER_TEAM = '66666666-7777-8888-9999-aaaaaaaaaaaa';

async function addFile(store, itemKey, name, text, observedAt) {
  const data = Buffer.from(text);
  const base = { tenantRef: TENANT, workload: 'onedrive', container: `drive:${DRIVE}`, itemKey };
  const content = await store.putItem(Readable.from([data]), { ...base, version: 'v1', metadata: { kind: 'drive-content', driveId: DRIVE, itemId: itemKey } });
  const record = {
    kind: 'file', driveId: DRIVE, id: itemKey, name, parentId: 'root', path: `/${name}`, size: data.length,
    lastModifiedDateTime: observedAt, currentVersion: 'v1', permissions: [], deleted: false,
    versions: [{ versionId: 'v1', ref: content.ref, sha256: content.sha256, bytes: content.bytes, lastModifiedDateTime: observedAt }],
  };
  await store.putItem(Readable.from([Buffer.from(JSON.stringify(record))]), {
    ...base, version: 'record:1', metadata: { kind: 'drive-record', driveId: DRIVE, itemId: itemKey, observedAt },
  });
}

// A drive that can hold folders, so a restore into another folder works end to end.
function fakeGraph() {
  const requests = [];
  const items = new Map();
  const byId = new Map([['root', '']]);
  let ids = 0;
  const json = (body, status = 200) => ({ status, headers: {}, body });
  const view = (path) => {
    const value = items.get(path);
    const id = [...byId].find(([, held]) => held === path)?.[0];
    if (value === 'folder') return { id, name: path.split('/').pop(), folder: {} };
    return { id, name: path.split('/').pop(), size: value.length, lastModifiedDateTime: new Date().toISOString(), file: { hashes: { quickXorHash: createQuickXorHash().update(value).digest() } } };
  };
  const transport = async (url, { method = 'GET', body } = {}) => {
    requests.push({ method, url });
    const path = decodeURIComponent(new URL(url).pathname).replace('/v1.0', '');
    let match;
    if ((match = path.match(/^\/drives\/([^/]+)$/))) return json({ id: match[1], name: 'OneDrive', driveType: 'business', owner: { user: { displayName: 'KEEL-RT-User' } } });
    if (/^\/drives\/[^/]+\/root$/.test(path)) return json({ id: 'root', root: {}, folder: {} });
    if ((match = path.match(/^\/drives\/[^/]+\/root:\/(.+)$/))) return items.has(match[1]) ? json(view(match[1])) : json({ error: { code: 'itemNotFound' } }, 404);
    if ((match = path.match(/^\/drives\/[^/]+\/items\/([^/]+)\/children$/)) && method === 'POST') {
      const parsed = JSON.parse(Buffer.isBuffer(body) || typeof body === 'string' ? body.toString() : JSON.stringify(body));
      const held = [byId.get(match[1]), parsed.name].filter(Boolean).join('/');
      const id = `f${++ids}`;
      byId.set(id, held);
      items.set(held, 'folder');
      return json(view(held), 201);
    }
    if ((match = path.match(/^\/drives\/[^/]+\/items\/([^/:]+):\/(.+):\/content$/)) && method === 'PUT') {
      const held = [byId.get(match[1]), match[2]].filter(Boolean).join('/');
      const id = `i${++ids}`;
      byId.set(id, held);
      items.set(held, Buffer.from(body));
      return json(view(held), 201);
    }
    return json({ error: { code: 'unexpected', path, method } }, 400);
  };
  return { requests, items, writes: () => requests.filter((request) => request.method !== 'GET'), transport };
}

test('mail and Teams restores to another mailbox or team are another location', () => {
  const mail = (target) => normalizeMailRestoreRequest({ tenantRef: TENANT, sourceMailboxId: 'u-1', targetMailboxId: target, at: '2026-10-15T09:00:00Z' });
  assert.deepEqual(mailPolicyActions(mail(undefined)), []);
  assert.deepEqual(mailPolicyActions(mail('u-1')), []);
  assert.deepEqual(mailPolicyActions(mail('u-2')), [CONTENT_RESTORE_OTHER_LOCATION]);
  const teams = (target) => normalizeTeamsMessagesRequest({ tenantRef: TENANT, sourceTeamId: TEAM, sourceChannelId: '19:a@thread.tacv2', targetTeamId: target, at: '2026-10-15T09:00:00Z' });
  assert.deepEqual(teamsPolicyActions(teams(undefined)), []);
  assert.deepEqual(teamsPolicyActions(teams(TEAM.toUpperCase())), []);
  assert.deepEqual(teamsPolicyActions(teams(OTHER_TEAM)), [CONTENT_RESTORE_OTHER_LOCATION]);
});

test('a content restore to another location needs two approvers, and its approval covers only what was reviewed', async (t) => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const db = await database.connect();
  t.after(async () => {
    await db.end();
    await database.cleanup();
  });
  await db.query(schemaSql());
  const principal = async (email) => (await db.query('INSERT INTO principal (email) VALUES ($1) RETURNING id', [email])).rows[0].id;
  const actor = await principal('keel-rt-restorer@contoso.test');
  const first = await principal('keel-rt-approver-1@contoso.test');
  const second = await principal('keel-rt-approver-2@contoso.test');
  await db.query(`INSERT INTO role_grant (principal_id, role) VALUES ($1, 'approver'), ($2, 'approver')`, [first, second]);
  await setApprovalPolicy(db, { tenantRef: TENANT, actionClass: CONTENT_RESTORE_OTHER_LOCATION, twoPerson: true, actor: first });

  const store = createMemoryContentStore();
  // Backed up before the request; dates are relative to the run.
  await addFile(store, 'item-1', 'KEEL-RT-a.txt', 'A version 1\n', new Date(Date.now() - 3_600_000).toISOString());
  const graph = fakeGraph();
  const lines = [];
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
  const approve = (id, decidedBy) => approveRequest(db, { tenantRef: TENANT, id, decidedBy, enforceScope: true, approverScope: { central: true } });
  const runOf = (id) => main(['files', 'run', '--approval-id', id, '--actor', actor], deps());

  // A point in time after the request would let later backups in: refused.
  const future = new Date(Date.now() + 86_400_000).toISOString();
  await assert.rejects(main(['files', 'request', '--drive', DRIVE, '--whole-drive', '--at', future, '--actor', actor], deps()), /after now/);
  await assert.rejects(main(['mail', 'request', '--source-mailbox', 'u-keel-rt', '--at', future, '--actor', actor], deps()), /after now/);
  await assert.rejects(main(['teams', 'request', '--team', TEAM, '--channel', '19:a@thread.tacv2', '--at', future, '--actor', actor], deps()), /after now/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM approval_request')).rows[0].n, 0, 'nothing was filed');

  // The whole drive, no --at, into another folder.
  const source = ['--drive', DRIVE, '--whole-drive', '--target-folder', 'KEEL-RT-restored'];
  assert.equal(await main(['files', 'request', ...source, '--actor', actor], deps()), 0);
  const filed = JSON.parse(lines.pop());
  assert.equal(filed.summary.otherLocation, true);
  const { rows: [held] } = await db.query('SELECT policy_actions, required_approvals, params FROM approval_request WHERE id = $1', [filed.approvalId]);
  assert.deepEqual(held.policy_actions, [CONTENT_RESTORE_OTHER_LOCATION], 'finding 4: the request is filed as a restore to another location');
  assert.equal(held.required_approvals, 2, 'finding 4: the two-person rule applies');
  assert.equal(held.params.request.at, filed.summary.at);
  assert.notEqual(held.params.request.at, null);

  // One approval is a sign-off only: the restore cannot run yet.
  const once = await approve(filed.approvalId, first);
  assert.equal(once.request.status, 'pending');
  await assert.rejects(runOf(filed.approvalId), /is pending, not approved/);
  assert.equal(graph.writes().length, 0);

  // A file the backup gains after the request is never part of it.
  await addFile(store, 'item-2', 'KEEL-RT-b-never-reviewed.txt', 'B arrived after the request\n', new Date(Date.now() + 60_000).toISOString());

  const twice = await approve(filed.approvalId, second);
  assert.equal(twice.request.status, 'approved');
  assert.equal(await runOf(filed.approvalId), 0);
  assert.equal(JSON.parse(lines.pop()).status, 'completed');
  assert.deepEqual([...graph.items.keys()].sort(), ['KEEL-RT-restored', 'KEEL-RT-restored/KEEL-RT-a.txt']);
  const writes = graph.writes().length;

  // Finding 6: the same approval never runs again.
  await assert.rejects(runOf(filed.approvalId), /already completed/);
  assert.equal(graph.writes().length, writes);

  // An approval filed without the class (as before this fix) is refused before any write.
  assert.equal(await main(['files', 'request', '--drive', DRIVE, '--whole-drive', '--target-folder', 'KEEL-RT-again', '--actor', actor], deps()), 0);
  const old = JSON.parse(lines.pop());
  await db.query(`UPDATE approval_request SET policy_actions = '[]', required_approvals = 1, status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [old.approvalId, first]);
  await assert.rejects(runOf(old.approvalId), /not filed as content-restore-other-location/);
  assert.equal(graph.writes().length, writes, 'nothing was written');

  // Finding 6: an approval decided more than a day ago no longer runs.
  await db.query(`UPDATE approval_request SET policy_actions = $2, decided_at = now() - interval '25 hours' WHERE id = $1`, [old.approvalId, JSON.stringify([CONTENT_RESTORE_OTHER_LOCATION])]);
  await assert.rejects(runOf(old.approvalId), /approved more than 24 hours ago/);
  await db.query(`UPDATE approval_request SET decided_at = now() - interval '90 days' WHERE id = $1`, [old.approvalId]);
  await assert.rejects(runOf(old.approvalId), /approved more than 24 hours ago/);
  assert.equal(graph.writes().length, writes, 'nothing was written');

  // An approval held from before the point in time was fixed restores nothing.
  const latest = filesRestoreRequest({ ...held.params.request, at: null });
  const { rows: [legacy] } = await db.query(
    `INSERT INTO approval_request (action, params, requested_by, decided_by, decided_at, status, expires_at, policy_actions)
     VALUES ('content-restore', $1, $2, $3, now(), 'approved', now() + interval '1 day', $4) RETURNING id`,
    [{ runId: restoreRunKey(latest), tenantRef: TENANT, workload: 'onedrive', request: latest }, actor, first, JSON.stringify([CONTENT_RESTORE_OTHER_LOCATION])],
  );
  await assert.rejects(runOf(legacy.id), /has no point in time/);
  assert.equal(graph.writes().length, writes, 'nothing was written');
});

test('a mail restore to another mailbox is refused when its approval was not filed as another location', async (t) => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const db = await database.connect();
  t.after(async () => {
    await db.end();
    await database.cleanup();
  });
  await db.query(schemaSql());
  const actor = (await db.query(`INSERT INTO principal (email) VALUES ('keel-rt-restorer@contoso.test') RETURNING id`)).rows[0].id;
  const approver = (await db.query(`INSERT INTO principal (email) VALUES ('keel-rt-approver@contoso.test') RETURNING id`)).rows[0].id;
  const request = normalizeMailRestoreRequest({ tenantRef: TENANT, sourceMailboxId: 'u-keel-rt', targetMailboxId: 'u-keel-rt-other', at: new Date(Date.now() - 60_000).toISOString() });
  const { rows: [row] } = await db.query(
    `INSERT INTO approval_request (action, params, requested_by, decided_by, decided_at, status, expires_at, policy_actions)
     VALUES ('content-restore', $1, $2, $3, now(), 'approved', now() + interval '1 day', '[]') RETURNING id`,
    [{ runId: mailRestoreRunId(request), tenantRef: TENANT, workload: 'mail', request }, actor, approver],
  );
  let wrote = false;
  const deps = {
    readFile: (path) => { if (!(path in files)) throw new Error(`no file ${path}`); return files[path]; },
    exists: (path) => path in files,
    connectFn: () => database.connect(),
    env: { KEEL_DB_URL: 'test' },
    logger: { log: () => {} },
    openStore: () => createMemoryContentStore(),
    getTokenFn: async () => 'token',
    writeTransportFor: async () => async () => { wrote = true; return { status: 500, body: null }; },
    testTenantRefs: [TENANT],
    canFn: async () => true,
  };
  await assert.rejects(main(['mail', 'run', '--approval-id', row.id, '--actor', actor], deps), /not filed as content-restore-other-location/);
  assert.equal(wrote, false, 'refused before Graph');
});
