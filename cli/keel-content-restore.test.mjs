import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { schemaSql } from '../engine/store/loadSchema.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { createMemoryContentStore } from '../engine/content/store.mjs';
import { mailRestoreRunId, normalizeMailRestoreRequest } from '../engine/content/restore/mail.mjs';
import { approveRequest } from '../engine/govern/approvals.mjs';
import { main, mailRequestFromArgs, restorerProblems } from './keel-content-restore.mjs';

const config = { tenantId: 'KEEL-RT-tenant-id', clientId: 'collector-app' };
const reader = { tenantId: config.tenantId, clientId: 'reader-app', certPath: '/etc/keel/r.pem', keyPath: '/etc/keel/r.key', contentKeyFile: '/etc/keel/content.key', storage: { kind: 'local', root: '/var/lib/keel/content' } };
const restorer = { tenantId: config.tenantId, clientId: 'restorer-app', certPath: '/etc/keel/w.pem', keyPath: '/etc/keel/w.key' };
const files = {
  '/etc/keel/tenant.json': JSON.stringify(config),
  '/etc/keel/content-reader.json': JSON.stringify(reader),
  '/etc/keel/content-restorer.json': JSON.stringify(restorer),
};
const TENANT = tenantRefFor(config.tenantId);
const USER = 'u-keel-rt';
const AT = '2026-10-15T09:00:00.000Z';
const MIME = Buffer.from('Message-ID: <KEEL-RT-1@contoso.test>\r\nSubject: KEEL-RT-1\r\n\r\nHello\r\n');

async function seededStore() {
  const store = createMemoryContentStore({ now: () => new Date('2026-10-15T08:00:00Z') });
  const base = { tenantRef: TENANT, workload: 'exchange-mail' };
  await store.putItem(Readable.from([Buffer.from(JSON.stringify({ id: 'f-inbox', displayName: 'Inbox', parentFolderId: 'root' }))]), {
    ...base, container: `mailbox/${USER}/mail-folders`, itemKey: 'f-inbox', version: 'ck-f', metadata: { kind: 'mailFolder' },
  });
  await store.putItem(Readable.from([MIME]), {
    ...base, container: `mailbox/${USER}/mail/f-inbox`, itemKey: 'm-1', version: 'ck-m',
    metadata: { kind: 'message', contentType: 'message/rfc822', internetMessageId: '<KEEL-RT-1@contoso.test>' },
  });
  return store;
}

function fakeGraph({ displayName = 'KEEL-RT-mailbox', mail = 'KEEL-RT-mailbox@contoso.test' } = {}) {
  const requests = [];
  let next = 0;
  const transport = async (url, { method = 'GET', body } = {}) => {
    requests.push({ method, url, body });
    const path = new URL(url).pathname.replace('/v1.0', '');
    if (method === 'GET' && path === `/users/${USER}`) return { status: 200, headers: {}, body: { id: USER, displayName, mail, userPrincipalName: mail } };
    if (method === 'POST') return { status: 201, headers: {}, body: { id: `new-${++next}` } };
    return { status: 404, headers: {}, body: null };
  };
  return { requests, writes: () => requests.filter((request) => request.method !== 'GET'), transport };
}

test('the command line names one restore request', () => {
  const request = mailRequestFromArgs(['--source-mailbox', USER, '--at', AT, '--kind', 'mail', '--folder', 'f-inbox', '--item', 'm-1'], TENANT);
  assert.deepEqual(request.selection, { kind: 'mail', folderId: 'f-inbox', itemKey: 'm-1' });
  assert.deepEqual(request.kinds, ['mail']);
  assert.equal(request.targetMailboxId, USER);
  assert.throws(() => mailRequestFromArgs(['--source-mailbox', USER, '--at', AT, '--folder', 'f-inbox'], TENANT), /go together/);
  assert.deepEqual(mailRequestFromArgs(['--source-mailbox', USER, '--at', AT, '--kinds', 'todo,mail'], TENANT).kinds, ['mail', 'todo']);
});

test('the restorer is its own app on the same tenant', () => {
  assert.deepEqual(restorerProblems(restorer, config, reader), []);
  assert.match(restorerProblems({ ...restorer, clientId: 'reader-app' }, config, reader)[0], /its own app registration/);
  assert.match(restorerProblems({ ...restorer, tenantId: 'other' }, config, reader)[0], /another tenant/);
});

test('plan, gate, test-tenant guard, run and resume through the command line', async (t) => {
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
    writeTransportFor: async (_token, { guard }) => async (url, options) => { guard(url); return graph.transport(url, options); },
    testTenantRefs: [TENANT],
    canFn: async () => true,
    ...overrides,
  });

  assert.equal(await main(['mail', 'plan', '--source-mailbox', USER, '--at', AT], deps()), 0);
  const planned = JSON.parse(lines.pop());
  const request = normalizeMailRestoreRequest({ tenantRef: TENANT, sourceMailboxId: USER, at: AT });
  assert.equal(planned.runId, mailRestoreRunId(request));
  assert.equal(planned.items.mail, 1);

  const approval = async (params, decidedBy = approver.id) => (await setup.query(
    `INSERT INTO approval_request (action, params, requested_by, decided_by, status, expires_at) VALUES ('content-restore', $1, $2, $3, 'approved', now() + interval '1 day') RETURNING id`,
    [params, actor.id, decidedBy],
  )).rows[0].id;
  const approvalId = await approval({ runId: planned.runId, tenantRef: TENANT, workload: 'mail', request });
  const run = (id, overrides) => main(['mail', 'run', '--approval-id', id, '--actor', actor.id], deps(overrides));

  await assert.rejects(run(await approval({ runId: planned.runId, tenantRef: TENANT, request }, actor.id)), /not decided by someone other than the requester/);
  await assert.rejects(run(approvalId, { canFn: async () => false }), /does not hold the content-restore capability/);
  await assert.rejects(run(approvalId, { exists: (path) => path in files && !path.endsWith('content-restorer.json') }), /waiting on the content-restorer app/);
  const tampered = await approval({ runId: planned.runId, tenantRef: TENANT, request: { ...request, targetMailboxId: 'u-other' } });
  await assert.rejects(run(tampered), /not a mail restore of this tenant/);
  const notFixture = fakeGraph({ displayName: 'Alex Wilber', mail: 'alexw@contoso.test' });
  await assert.rejects(run(approvalId, { writeTransportFor: async () => notFixture.transport }), /only to KEEL-RT- targets/);
  assert.equal(notFixture.writes().length, 0, 'a refused target gets no write');
  assert.equal(graph.requests.length, 0, 'no refusal reached Graph');

  assert.equal(await run(approvalId), 0);
  const report = JSON.parse(lines.pop());
  assert.equal(report.status, 'completed');
  assert.equal(report.restored, 1);
  assert.deepEqual(graph.writes().map((write) => new URL(write.url).pathname), [
    `/v1.0/users/${USER}/mailFolders`, `/v1.0/users/${USER}/mailFolders/new-1/childFolders`, `/v1.0/users/${USER}/mailFolders/new-2/messages`,
  ]);
  assert.equal(Buffer.from(graph.writes()[2].body, 'base64').toString(), MIME.toString());

  const writes = graph.writes().length;
  assert.equal(await run(approvalId), 0);
  assert.equal(graph.writes().length, writes, 'running the approved request again writes nothing');
  const { rows: [held] } = await setup.query('SELECT status, requested_by, approved_by FROM content_restore_run WHERE id = $1', [planned.runId]);
  assert.deepEqual(held, { status: 'completed', requested_by: actor.id, approved_by: approver.id });
});

test('request, approval and run end to end, through the real write transport', async (t) => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const setup = await database.connect();
  t.after(async () => {
    await setup.end();
    await database.cleanup();
  });
  await setup.query(schemaSql());
  const { rows: [actor] } = await setup.query(`INSERT INTO principal (email) VALUES ('keel-rt-restorer@contoso.test') RETURNING id`);
  const { rows: [approver] } = await setup.query(`INSERT INTO principal (email) VALUES ('keel-rt-approver@contoso.test') RETURNING id`);
  await setup.query(`INSERT INTO role_grant (principal_id, role) VALUES ($1, 'restorer'), ($2, 'approver')`, [actor.id, approver.id]);
  const store = await seededStore();
  const lines = [];
  const sent = [];
  let next = 0;
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method, headers: init.headers, body: init.body });
    const path = new URL(url).pathname.replace('/v1.0', '');
    const reply = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (init.method === 'GET' && path === `/users/${USER}`) return reply(200, { id: USER, displayName: 'KEEL-RT-mailbox', mail: 'KEEL-RT-mailbox@contoso.test' });
    if (init.method === 'POST') return reply(201, { id: `new-${++next}` });
    return reply(404, null);
  };
  const deps = {
    readFile: (path) => { if (!(path in files)) throw new Error(`no file ${path}`); return files[path]; },
    exists: (path) => path in files,
    connectFn: () => database.connect(),
    env: { KEEL_DB_URL: 'test' },
    logger: { log: (line) => lines.push(line) },
    openStore: () => store,
    getTokenFn: async () => 'token',
    fetchImpl,
    testTenantRefs: [TENANT],
  };

  assert.equal(await main(['mail', 'request', '--source-mailbox', USER, '--at', AT, '--actor', actor.id, '--justification', 'KEEL-RT- check'], deps), 0);
  const { approvalId } = JSON.parse(lines.pop());
  await approveRequest(setup, { tenantRef: TENANT, id: approvalId, decidedBy: approver.id });

  assert.equal(await main(['mail', 'run', '--approval-id', approvalId, '--actor', actor.id], deps), 0);
  assert.equal(JSON.parse(lines.pop()).restored, 1);
  const message = sent.find((request) => request.method === 'POST' && request.url.endsWith('/messages'));
  assert.equal(message.headers['content-type'], 'text/plain');
  assert.equal(message.headers.authorization, 'Bearer token');
  assert.equal(Buffer.from(message.body, 'base64').toString(), MIME.toString());
  assert.ok(sent.every((request) => new URL(request.url).pathname.startsWith(`/v1.0/users/${USER}`)));
});
