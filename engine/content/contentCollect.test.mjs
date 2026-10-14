import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { CONTENT_READER_IDENTITY, descriptorProblems, scopeProblems, WORKLOAD_DESCRIPTORS } from '../collect/workloadContract.mjs';
import {
  CONTENT_READ_SCOPES, prerequisiteForWorkload, registerWorkloadPrerequisite,
} from '../bootstrap/prerequisites.mjs';
import { capabilityForJobKind } from '../authz/jobCapabilities.mjs';
import { MINIMUM_INTERVAL_MS, nextDueAt, validateSchedule } from '../schedules/cadence.mjs';
import { initialSchedules } from '../store/scheduleSeed.mjs';
import { contentReadTransport } from './transport.mjs';
import { createMemoryContentStore } from './store.mjs';
import { CONTENT_COLLECTORS } from './collectors.mjs';
import { JOB_HANDLERS, JOB_TIMEOUT_MS } from '../../cli/keel-worker.mjs';
import { main, readerProblems, runContentCollection } from '../../cli/keel-content-collect.mjs';

const messages = { kind: 'graph', method: 'GET', endpoint: '/users/{id}/messages' };

test('only the content reader may address content, and it still only reads', () => {
  assert.notDeepEqual(scopeProblems(messages), [], 'configuration reads still refuse content');
  assert.deepEqual(scopeProblems(messages, { identity: CONTENT_READER_IDENTITY }), []);
  assert.deepEqual(scopeProblems({ kind: 'graph', method: 'GET', endpoint: '/drives/{id}/items/{item}/content' }, { identity: CONTENT_READER_IDENTITY }), []);
  assert.deepEqual(scopeProblems({ ...messages, method: 'POST' }, { identity: CONTENT_READER_IDENTITY }), ['POST is not a read']);
  assert.deepEqual(scopeProblems({ kind: 'cmdlet', cmdlet: 'Set-Mailbox', module: 'x' }, { identity: CONTENT_READER_IDENTITY }), ['Set-Mailbox is not a read cmdlet']);
  assert.deepEqual(scopeProblems(messages, { identity: 'restorer' }), ['unknown read identity restorer']);
  // A configuration workload descriptor can never claim the reader's exemption.
  const descriptor = { ...WORKLOAD_DESCRIPTORS[0], operation: { ...messages, version: 'v1.0' } };
  assert.ok(descriptorProblems(descriptor).some((problem) => problem.includes('reads content')));
});

test('content-read scopes are the content reader\'s alone, and it holds read scopes only', () => {
  const source = { url: 'https://learn.microsoft.com/en-us/graph/permissions-reference', retrievedAt: '2026-10-14' };
  const backup = prerequisiteForWorkload('content-backup');
  assert.equal(backup.identity, CONTENT_READER_IDENTITY);
  assert.ok(backup.graphPermissions.includes('Mail.Read') && backup.graphPermissions.includes('Files.Read.All'));
  assert.ok(backup.graphPermissions.every((scope) => !/Write/.test(scope)));
  assert.ok(!backup.graphPermissions.includes('ChannelMessage.Read.All'), 'Teams messages wait on Microsoft (ask 2)');
  for (const scope of ['Mail.Read', 'Files.Read.All']) {
    assert.ok(CONTENT_READ_SCOPES.includes(scope));
    assert.throws(() => registerWorkloadPrerequisite({ workload: `KEEL-RT-collector-${scope}`, identity: 'collector', graphPermissions: [scope], source }), /only the content-reader identity/);
  }
  assert.throws(() => registerWorkloadPrerequisite({ workload: 'KEEL-RT-reader-write', identity: CONTENT_READER_IDENTITY, graphPermissions: ['Sites.ReadWrite.All'], source }), /not a read scope/);
  assert.throws(() => registerWorkloadPrerequisite({ workload: 'KEEL-RT-reader-mail', identity: CONTENT_READER_IDENTITY, graphPermissions: ['Mail.ReadWrite'], source }), /forbidden broad grant/);
});

test('content-collect is a nightly schedule, a collect capability and a worker dispatch', () => {
  const seed = initialSchedules(new Date('2026-10-14T20:00:00Z')).find((row) => row.jobKind === 'content-collect');
  assert.deepEqual(seed.cadence, { every: 'day', n: 1, atTime: '01:00' });
  assert.equal(seed.nextDueAt.toISOString(), '2026-10-15T01:00:00.000Z');
  const row = { job_kind: 'content-collect', tier: null, cadence: seed.cadence, cron_override: null };
  assert.doesNotThrow(() => validateSchedule(row));
  assert.equal(nextDueAt(row, seed.nextDueAt).toISOString(), '2026-10-16T01:00:00.000Z');
  assert.throws(() => validateSchedule({ ...row, cadence: { every: 'hour', n: 1, atTime: null } }), /schedule_minimum_interval/);
  assert.equal(MINIMUM_INTERVAL_MS['content-collect'], 4 * 60 * 60 * 1000);
  assert.equal(capabilityForJobKind('content-collect'), 'collect');
  const handler = JOB_HANDLERS['content-collect'];
  assert.ok(handler.script.endsWith('cli/keel-content-collect.mjs'));
  assert.deepEqual(handler.argsFor({ tenantRef: 'sha256:x' }), ['run', '--tenant-ref', 'sha256:x']);
  assert.deepEqual(handler.argsFor({ reader: '/etc/keel/content-reader.json' }), ['run', '--reader', '/etc/keel/content-reader.json']);
  assert.throws(() => handler.argsFor({ tenantRef: 'x', storage: '/tmp' }), /only config, reader, scope and tenantRef/);
  assert.equal(JOB_TIMEOUT_MS['content-collect'], 6 * 60 * 60 * 1000);
});

test('the content transport reads Graph only, with GET only', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(url.endsWith('/content') ? 'KEEL-RT- bytes' : JSON.stringify({ value: [] }), { status: 200 });
  };
  let tokens = 0;
  const transport = contentReadTransport(async () => { tokens += 1; return 'KEEL-RT-token'; }, fetchImpl);
  const json = await transport('https://graph.microsoft.com/v1.0/users/KEEL-RT-user/messages/delta');
  assert.deepEqual(json.body, { value: [] });
  const stream = await transport('https://graph.microsoft.com/v1.0/drives/d/items/i/content', { as: 'stream' });
  assert.equal(Buffer.concat(await stream.body.toArray()).toString(), 'KEEL-RT- bytes');
  assert.equal(tokens, 1);
  assert.ok(calls.every((call) => call.init.method === 'GET'));
  await assert.rejects(transport('https://graph.microsoft.com/v1.0/users/u/messages', { method: 'POST' }), /read-only/);
  await assert.rejects(transport('https://graph.microsoft.com/v1.0/users/u/messages', { body: '{}' }), /read-only/);
  await assert.rejects(transport('https://contoso.sharepoint.com/_api/web'), /Microsoft Graph only/);
  assert.equal(calls.length, 2, 'refused requests were never sent');
});

test('the content transport renews its token before expiry and once on a 401', async () => {
  let clock = 0;
  const issued = [];
  const tokenSource = async () => { issued.push(clock); return { accessToken: `KEEL-RT-token-${issued.length}`, expiresAt: clock + 60 * 60 * 1000 }; };
  const seen = [];
  let expireNext = false;
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.authorization);
    if (expireNext) { expireNext = false; return new Response('', { status: 401 }); }
    return new Response('{}', { status: 200 });
  };
  const transport = contentReadTransport(tokenSource, fetchImpl, { now: () => clock });
  const url = 'https://graph.microsoft.com/v1.0/users/KEEL-RT-user/messages/delta';
  await transport(url);
  clock = 50 * 60 * 1000;
  await transport(url);
  assert.equal(issued.length, 1, 'a token with ten minutes left is kept');
  clock = 56 * 60 * 1000;
  await transport(url);
  assert.equal(issued.length, 2, 'a token within five minutes of expiry is renewed');
  expireNext = true;
  assert.equal((await transport(url)).status, 200);
  assert.equal(issued.length, 3, 'a 401 renews once and retries');
  assert.deepEqual(seen.slice(-2), ['Bearer KEEL-RT-token-2', 'Bearer KEEL-RT-token-3']);
});

test('a content-collect run waits on the reader, checks it, and runs every registered collector', async () => {
  const config = { tenantId: '00000000-0000-0000-0000-0000000000c1', clientId: 'collector-app' };
  const files = { '/etc/keel/tenant.json': JSON.stringify(config) };
  const lines = [];
  const logger = { log: (line) => lines.push(line) };
  const deps = { readFile: (path) => files[path], exists: (path) => path in files, logger, connectFn: async () => assert.fail('no database before the reader exists') };
  assert.equal(await main(['run'], deps), 0);
  assert.match(lines.at(-1), /waiting on the content-reader app/);

  const reader = { tenantId: config.tenantId, clientId: 'reader-app', contentKeyFile: '/etc/keel/content.key', storage: { kind: 'local', root: '/var/lib/keel/content' } };
  assert.deepEqual(readerProblems(reader, config), []);
  assert.ok(readerProblems({ ...reader, clientId: 'collector-app' }, config).some((p) => p.includes('its own app registration')));
  assert.ok(readerProblems({ ...reader, tenantId: 'other' }, config).some((p) => p.includes('another tenant')));
  assert.ok(readerProblems({ ...reader, contentKeyFile: '/tmp/content.key' }, config).some((p) => p.includes('/etc/keel/')));
  files['/etc/keel/content-reader.json'] = JSON.stringify({ ...reader, clientId: 'collector-app' });
  await assert.rejects(main(['run'], deps), /its own app registration/);
  await assert.rejects(main(['run', '--tenant-ref', 'sha256:other'], deps), /another tenant/);

  assert.deepEqual(CONTENT_COLLECTORS.map((entry) => entry.workload).filter((w) => !['exchange-mail', 'onedrive', 'sharepoint', 'sharepoint-sites', 'teams', 'planner', 'group-conversations'].includes(w)), []);
  const store = createMemoryContentStore();
  const collectors = [
    { workload: 'teams', collect: async (client, { store: given, tenantRef }) => {
      const put = await given.putItem(Readable.from([Buffer.from('{"team":"KEEL-RT-team"}')]), { tenantRef, workload: 'teams', container: 'team:KEEL-RT-team', itemKey: 'team.json' });
      return { outcome: 'succeeded', items: 1, bytes: put.bytes, reasons: [] };
    } },
    { workload: 'planner', collect: async () => { throw new Error('KEEL-RT- planner read failed'); } },
  ];
  const result = await runContentCollection(null, { tenantRef: 'sha256:KEEL-RT', store, transport: null, collectors, logger });
  assert.deepEqual(result.runs.map((run) => [run.workload, run.outcome]), [['teams', 'succeeded'], ['planner', 'failed']]);
  assert.equal(result.exitCode, 1, 'a failed collector fails the job, after the others ran');
  assert.equal((await store.listItems({ container: 'team:KEEL-RT-team' })).length, 1);
  await assert.rejects(runContentCollection(null, { tenantRef: 't', store, collectors: [{ workload: 'calendar', collect: async () => ({}) }], logger }), /unknown workload/);
});
