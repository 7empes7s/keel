// The `teams` subcommand: plan, approval, KEEL-RT- guard and run of a Teams message
// restore, end to end through the real write transport over a fake fetch.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { schemaSql } from '../engine/store/loadSchema.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { createMemoryContentStore } from '../engine/content/store.mjs';
import { approveRequest } from '../engine/govern/approvals.mjs';
import { teamsMessageFixture } from '../engine/content/restore/teamsMessages.mjs';
import { main } from './keel-content-restore.mjs';
import { teamsGuard, teamsRequestFromArgs } from './keel-content-restore-teams.mjs';

const config = { tenantId: 'KEEL-RT-tenant-id', clientId: 'collector-app' };
const reader = { tenantId: config.tenantId, clientId: 'reader-app', certPath: '/etc/keel/r.pem', keyPath: '/etc/keel/r.key', contentKeyFile: '/etc/keel/content.key', storage: { kind: 'local', root: '/var/lib/keel/content' } };
const restorer = { tenantId: config.tenantId, clientId: 'restorer-app', certPath: '/etc/keel/w.pem', keyPath: '/etc/keel/w.key' };
const TENANT = tenantRefFor(config.tenantId);
const TEAM = 'aaaaaaaa-0000-4000-8000-000000000001';
const CHANNEL = '19:keelrtgeneral@thread.tacv2';
const ALEX = 'bbbbbbbb-0000-4000-8000-000000000001';
const BEA = 'bbbbbbbb-0000-4000-8000-000000000002';
const FALLBACK = 'bbbbbbbb-0000-4000-8000-0000000000fb';
const RUN = new Date();
const fixture = teamsMessageFixture({ authors: [ALEX, BEA], now: RUN });
const files = {
  '/etc/keel/tenant.json': JSON.stringify(config),
  '/etc/keel/content-reader.json': JSON.stringify(reader),
  '/etc/keel/content-restorer.json': JSON.stringify(restorer),
  '/tmp/keel-rt-fixture.json': JSON.stringify(fixture),
};

test('the command line names one request, and the guard keeps calls in the target team', () => {
  const request = teamsRequestFromArgs(['--team', TEAM, '--channel', CHANNEL, '--at', RUN.toISOString(), '--fallback-author', FALLBACK], TENANT);
  assert.equal(request.targetTeamId, TEAM);
  assert.equal(request.fallbackAuthorId, FALLBACK);
  const guard = teamsGuard(request);
  assert.equal(guard('x', { method: 'POST', endpoint: `/teams/${TEAM}/channels` }), true);
  assert.equal(guard('x', { method: 'GET', endpoint: `/users/${ALEX}?$select=id` }), true);
  assert.match(guard('x', { method: 'POST', endpoint: `/users/${ALEX}` }), /outside the restore target/);
  assert.match(guard('x', { method: 'POST', endpoint: '/teams/aaaaaaaa-0000-4000-8000-000000000009/channels' }), /outside the restore target/);
});

test('request, approval and run of a fixture restore through the real write transport', async (t) => {
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
  const lines = [];
  const sent = [];
  let next = 0;
  let teamName = 'KEEL-RT-Containers';
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const path = decodeURIComponent(new URL(url).pathname).replace('/v1.0', '');
    const reply = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (init.method === 'GET' && path === `/teams/${TEAM}`) return reply(200, { id: TEAM, displayName: teamName });
    if (init.method === 'GET' && path.startsWith('/users/')) {
      const id = path.split('/')[2];
      return [ALEX, BEA, FALLBACK].includes(id) ? reply(200, { id, displayName: `KEEL-RT-user ${id.slice(-2)}` }) : reply(404, { error: { code: 'Request_ResourceNotFound' } });
    }
    if (init.method === 'POST' && path.endsWith('/channels')) return reply(201, { id: '19:restored@thread.tacv2' });
    if (init.method === 'POST' && path.endsWith('Migration')) return reply(204, null);
    if (init.method === 'POST') return reply(201, { id: `m-${++next}` });
    return reply(404, null);
  };
  const deps = (overrides = {}) => ({
    readFile: (path) => { if (!(path in files)) throw new Error(`no file ${path}`); return files[path]; },
    exists: (path) => path in files,
    connectFn: () => database.connect(),
    env: { KEEL_DB_URL: 'test' },
    logger: { log: (line) => lines.push(line) },
    openStore: () => createMemoryContentStore(),
    getTokenFn: async () => 'token',
    fetchImpl,
    testTenantRefs: [TENANT],
    ...overrides,
  });
  const source = ['--team', TEAM, '--channel', CHANNEL, '--at', RUN.toISOString(), '--fallback-author', FALLBACK, '--fixture', '/tmp/keel-rt-fixture.json'];

  await assert.rejects(main(['teams', 'plan', ...source], deps({ testTenantRefs: [] })), /only be restored on the test tenant/);
  assert.equal(await main(['teams', 'plan', ...source], deps()), 0);
  assert.equal(JSON.parse(lines.pop()).messages, 5);

  assert.equal(await main(['teams', 'request', ...source, '--actor', actor.id, '--justification', 'KEEL-RT- import proof'], deps()), 0);
  const { approvalId } = JSON.parse(lines.pop());
  await approveRequest(setup, { tenantRef: TENANT, id: approvalId, decidedBy: approver.id });
  const run = (extra = [], overrides) => main(['teams', 'run', '--approval-id', approvalId, '--actor', actor.id, ...extra], deps(overrides));

  await assert.rejects(run(), /pass the same --fixture file/);
  teamName = 'Finance';
  await assert.rejects(run(['--fixture', '/tmp/keel-rt-fixture.json']), /only to KEEL-RT- targets/);
  assert.ok(sent.every((request) => request.method === 'GET'), 'a refused team gets no write');
  teamName = 'KEEL-RT-Containers';

  assert.equal(await run(['--fixture', '/tmp/keel-rt-fixture.json']), 0);
  const report = JSON.parse(lines.pop());
  assert.equal(report.status, 'completed');
  assert.equal(report.restored, 5);
  assert.equal(report.authorsReplaced, 1);
  const writes = sent.filter((request) => request.method === 'POST');
  assert.equal(writes[0].body['@microsoft.graph.channelCreationMode'], 'migration');
  assert.match(writes[0].body.displayName, /^KEEL-RT-import-proof \(restored /);
  assert.ok(new URL(writes.at(-1).url).pathname.endsWith('/completeMigration'));
  assert.ok(writes.every((request) => decodeURIComponent(new URL(request.url).pathname).startsWith(`/v1.0/teams/${TEAM}/`)));

  const count = sent.length;
  assert.equal(await run(['--fixture', '/tmp/keel-rt-fixture.json']), 0);
  assert.equal(JSON.parse(lines.pop()).alreadyDone, 5);
  assert.ok(sent.slice(count).filter((request) => request.method === 'POST').every((request) => request.url.endsWith('/completeMigration')), 'a second run imports nothing again');
  const { rows: [held] } = await setup.query('SELECT status, workload FROM content_restore_run');
  assert.deepEqual(held, { status: 'completed', workload: 'teams' });
});
