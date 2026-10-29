// Teams channel message restore through the import API. Everything runs against a fake
// Graph, the in-memory content store and the in-memory journal. No tenant is written.
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { createMemoryContentStore } from '../store.mjs';
import { createMemoryRestoreJournal } from './journal.mjs';
import { canonicalDigest } from '../../restore/dryRunArtifact.mjs';
import {
  CHANNEL_NAME_MAX, THREAD_SCHEMA, importPayload, messagesContainer, normalizeTeamsMessagesRequest, planTeamsMessageRestore,
  restoreTeamsMessages, restoredChannelName, teamsMessageFixture, teamsMessagesRunId,
} from './teamsMessages.mjs';

const TENANT = 'tenant-ref-keel-rt';
const TEAM = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_TEAM = 'aaaaaaaa-0000-4000-8000-000000000002';
const CHANNEL = '19:keelrtgeneral@thread.tacv2';
const ALEX = 'bbbbbbbb-0000-4000-8000-000000000001';
const BEA = 'bbbbbbbb-0000-4000-8000-000000000002';
const GONE = 'bbbbbbbb-0000-4000-8000-0000000000ff';
const FALLBACK = 'bbbbbbbb-0000-4000-8000-0000000000fb';
// Times relative to the run, so the fixture never ages into the future or out of range.
const RUN = new Date();
const daysAgo = (days, minutes = 0) => new Date(RUN.valueOf() - days * 86400000 + minutes * 60000).toISOString();
const STORED_AT = new Date(RUN.valueOf() - 2 * 86400000);
const AT = daysAgo(1);

const user = (id, displayName) => ({ user: { id, displayName, userIdentityType: 'aadUser' }, application: null });
const message = (id, created, from, content, extra = {}) => ({
  id, createdDateTime: created, deletedDateTime: null, messageType: 'message', importance: 'normal', subject: null,
  from, body: { contentType: 'html', content }, attachments: [], mentions: [], reactions: [], hostedContents: [], ...extra,
});

async function seededStore() {
  const store = createMemoryContentStore({ now: () => STORED_AT });
  const put = (container, itemKey, doc) => store.putItem(Readable.from([Buffer.from(JSON.stringify(doc))]), {
    tenantRef: TENANT, workload: 'teams', container, itemKey, version: canonicalDigest(doc), metadata: {},
  });
  await put(`team:${TEAM}`, 'team.json', {
    schema: 'keel.teams.team/v1', teamId: TEAM, channels: { items: [{ channelId: CHANNEL, fields: { displayName: 'KEEL-RT-general', description: 'Fixture channel' } }] },
  });
  const container = messagesContainer(TEAM, CHANNEL);
  await put(container, '2001', { schema: THREAD_SCHEMA, message: message('2001', daysAgo(5), user(BEA, 'Bea'), '<p>Second thread</p>'), replies: [] });
  await put(container, '1001', {
    schema: THREAD_SCHEMA,
    message: message('1001', daysAgo(6), user(ALEX, 'Alex'), '<p>Hello <at id="0">Bea</at></p>', { subject: 'Kick-off', reactions: [{ reactionType: 'like' }] }),
    replies: [
      message('1003', daysAgo(6, 10), user(GONE, 'Gus Gone'), '<p>From someone who left</p>'),
      message('1002', daysAgo(6, 5), user(BEA, 'Bea'), '<p>First reply</p>'),
      message('1004', daysAgo(6, 20), user(ALEX, 'Alex'), '<p>removed</p>', { deletedDateTime: daysAgo(6, 21) }),
    ],
  });
  await put(container, '3001', { schema: THREAD_SCHEMA, message: message('3001', daysAgo(4), user(ALEX, 'Alex'), '', { messageType: 'systemEventMessage' }), replies: [] });
  return store;
}

function fakeGraph({ users = [ALEX, BEA, FALLBACK], fail = () => null } = {}) {
  const requests = [];
  let next = 0;
  const completed = new Set();
  const transport = async (url, { method = 'GET', body } = {}) => {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).replace('/v1.0', '');
    requests.push({ method, path, body });
    const failed = fail({ method, path, body });
    if (failed) return failed;
    if (method === 'GET' && path.startsWith('/users/')) {
      const id = path.split('/')[2];
      return users.includes(id) ? { status: 200, headers: {}, body: { id, displayName: `User ${id.slice(-2)}` } } : { status: 404, headers: {}, body: { error: { code: 'Request_ResourceNotFound' } } };
    }
    if (method === 'GET' && path.endsWith('/channels')) return { status: 200, headers: {}, body: { value: [] } };
    if (method === 'POST' && path.endsWith('/channels')) return { status: 201, headers: {}, body: { id: '19:restored@thread.tacv2' } };
    if (method === 'POST' && path.endsWith('/completeMigration')) { completed.add(path); return { status: 204, headers: {}, body: null }; }
    if (method === 'POST' && path.endsWith('/startMigration')) { completed.clear(); return { status: 204, headers: {}, body: null }; }
    if (method === 'POST') return { status: 201, headers: {}, body: { id: `m-${++next}` } };
    return { status: 404, headers: {}, body: null };
  };
  return { requests, transport, writes: () => requests.filter((r) => r.method !== 'GET'), completed };
}

const request = (extra = {}) => normalizeTeamsMessagesRequest({ tenantRef: TENANT, sourceTeamId: TEAM, sourceChannelId: CHANNEL, at: AT, ...extra });
const run = (plan, graph, journal, extra = {}) => restoreTeamsMessages({
  transport: graph.transport, journal, plan, target: { id: plan.request.targetTeamId }, now: () => RUN, sleep: async () => {}, gapMs: 0, ...extra,
});

test('a request is normalized and its run id is stable', () => {
  const a = request();
  assert.equal(a.targetTeamId, TEAM);
  assert.equal(teamsMessagesRunId(a), teamsMessagesRunId(request()));
  assert.notEqual(teamsMessagesRunId(a), teamsMessagesRunId(request({ targetTeamId: OTHER_TEAM })));
  assert.throws(() => request({ sourceChannelId: 'general' }), /source channel id/);
  assert.throws(() => request({ at: 'soon' }), /point in time/);
  assert.throws(() => request({ fallbackAuthorId: 'alex@contoso' }), /fallback author/);
});

test('the plan takes threads in time order, skipping deleted and system messages', async () => {
  const plan = await planTeamsMessageRestore(await seededStore(), request());
  assert.equal(plan.channel.displayName, 'KEEL-RT-general');
  assert.deepEqual(plan.threads.map((thread) => thread.message.id), ['1001', '2001']);
  assert.deepEqual(plan.threads[0].replies.map((reply) => reply.id), ['1002', '1003']);
  assert.equal(plan.messages, 4);
  assert.deepEqual(plan.skipped.map((entry) => [entry.messageId, entry.reason]).sort(), [['1004', 'deleted before the backup'], ['3001', 'a system message']]);
});

test('a point in time before the backup holds nothing, and says why', async () => {
  await assert.rejects(planTeamsMessageRestore(await seededStore(), request({ at: daysAgo(30) })), /export API/);
});

test('the restore creates a new channel in import mode, imports each message as its author, and completes', async () => {
  const plan = await planTeamsMessageRestore(await seededStore(), request({ fallbackAuthorId: FALLBACK }));
  const graph = fakeGraph();
  const journal = createMemoryRestoreJournal();
  const report = await run(plan, graph, journal);
  assert.equal(report.status, 'completed');
  assert.equal(report.restored, 4);
  assert.equal(report.skipped, 2);
  assert.equal(report.authorsReplaced, 1);
  assert.equal(report.notes.mentionsAsText, 1);
  assert.equal(report.notes.reactionsDropped, 1);

  const writes = graph.writes();
  const [create] = writes;
  assert.equal(create.path, `/teams/${TEAM}/channels`);
  assert.equal(create.body['@microsoft.graph.channelCreationMode'], undefined, 'Graph refuses an import-mode channel in an existing team (#656)');
  assert.equal(create.body.membershipType, 'standard');
  assert.match(create.body.displayName, /^KEEL-RT-general \(restored \d{4}-\d{2}-\d{2}\)$/);

  const base = `/teams/${TEAM}/channels/19:restored@thread.tacv2`;
  assert.deepEqual(writes.slice(1).map((w) => w.path), [
    `${base}/startMigration`, `${base}/messages`, `${base}/messages/m-1/replies`, `${base}/messages/m-1/replies`, `${base}/messages`, `${base}/completeMigration`,
  ]);
  assert.deepEqual(writes[1].body, { conversationCreationDateTime: daysAgo(6, -1) }, 'imported history starts a minute before the first message');
  const [root, reply, goneReply, second] = writes.slice(2);
  assert.equal(root.body.createdDateTime, daysAgo(6));
  assert.equal(root.body.from.user.id, ALEX);
  assert.equal(root.body.subject, 'Kick-off');
  assert.equal(root.body.body.content, '<p>Hello <strong>@Bea</strong></p>');
  assert.equal(reply.body.from.user.id, BEA);
  assert.equal(goneReply.body.from.user.id, FALLBACK);
  assert.match(goneReply.body.body.content, /^<p><em>Originally posted by Gus Gone<\/em><\/p>/);
  assert.equal(second.body.createdDateTime, daysAgo(5));
  assert.ok(writes.every((w) => w.path.startsWith(`/teams/${TEAM}/`)), 'every write stays in the target team');
  assert.equal(graph.requests.filter((r) => r.method === 'GET' && r.path === `/users/${ALEX}`).length, 1, 'each author is checked once');

  // Running the same plan again writes nothing: the import is already complete.
  const quiet = fakeGraph();
  const again = await run(plan, quiet, journal);
  assert.equal(again.alreadyDone, 4);
  assert.equal(again.restored, 0);
  assert.equal(again.status, 'completed');
  assert.equal(quiet.writes().length, 0);
});

test('without a fallback author, a message from someone who left fails with the reason; a resume finishes it', async () => {
  const store = await seededStore();
  const plan = await planTeamsMessageRestore(store, request());
  const journal = createMemoryRestoreJournal();
  const graph = fakeGraph();
  const report = await run(plan, graph, journal);
  assert.equal(report.status, 'partial');
  assert.equal(report.failed, 1);
  assert.match(report.errors[0].error, /no longer in the tenant; name a fallback author/);
  assert.ok(graph.writes().some((w) => w.path.endsWith('/completeMigration')), 'the import is completed even when a message failed');
  assert.equal((await journal.entry(plan.runId, 'import-mode')).status, 'restored');
});

test('a resume after a completed import puts the channel back into import mode first', async () => {
  const store = await seededStore();
  const plan = await planTeamsMessageRestore(store, request());
  const journal = createMemoryRestoreJournal();
  // First run: Bea's reply fails with a server error.
  const flaky = fakeGraph({ fail: ({ method, body }) => (method === 'POST' && body?.from?.user?.id === BEA && body.createdDateTime === daysAgo(6, 5) ? { status: 500, headers: {}, body: { error: { code: 'InternalServerError' } } } : null) });
  const first = await run(plan, flaky, journal);
  assert.equal(first.status, 'partial');
  const graph = fakeGraph();
  const second = await run(plan, graph, journal);
  const writes = graph.writes().map((w) => w.path.split('/').pop());
  assert.equal(writes[0], 'startMigration');
  assert.equal(graph.writes()[0].body.conversationCreationDateTime, daysAgo(6, -1));
  assert.ok(!writes.includes('channels'), 'the channel is not created twice');
  assert.equal(writes.at(-1), 'completeMigration');
  // Bea's reply comes back; Gus still fails (no fallback author).
  assert.equal(second.restored, 1);
  assert.equal(second.failed, 1);
});

test('a thread whose first message fails takes its replies with it, and the write that was sent but not journaled is flagged', async () => {
  const plan = await planTeamsMessageRestore(await seededStore(), request({ fallbackAuthorId: FALLBACK }));
  const journal = createMemoryRestoreJournal();
  const graph = fakeGraph({ fail: ({ method, path }) => (method === 'POST' && path.endsWith('/messages') ? { status: 400, headers: {}, body: { error: { code: 'BadRequest', message: 'no' } } } : null) });
  const report = await run(plan, graph, journal);
  assert.equal(report.status, 'failed');
  assert.equal(report.failed, 4);
  assert.ok(report.errors.some((e) => /first message was not restored/.test(e.error)));

  // A write that went out but was never journaled as done is sent again and flagged.
  await journal.mark(plan.runId, 'message:2001', { kind: 'teams-message', status: 'pending' });
  const again = await run(plan, fakeGraph(), journal);
  assert.deepEqual(again.possibleDuplicates, ['2001']);
  assert.equal(again.status, 'completed');
});

test('a channel that cannot be created fails the run before any message is sent', async () => {
  const plan = await planTeamsMessageRestore(await seededStore(), request());
  const graph = fakeGraph({ fail: ({ method, path }) => (method === 'POST' && path.endsWith('/channels') ? { status: 403, headers: {}, body: { error: { code: 'Forbidden', message: 'Missing role permissions' } } } : null) });
  const report = await run(plan, graph, createMemoryRestoreJournal());
  assert.equal(report.status, 'failed');
  assert.match(report.errors[0].error, /creating channel .* failed: 403 Forbidden/);
  assert.equal(graph.writes().length, 1);
});

test('a restore into another team needs that team as its checked target', async () => {
  const plan = await planTeamsMessageRestore(await seededStore(), request({ targetTeamId: OTHER_TEAM, fallbackAuthorId: FALLBACK }));
  await assert.rejects(restoreTeamsMessages({ transport: fakeGraph().transport, journal: createMemoryRestoreJournal(), plan, target: { id: TEAM } }), /not the team the plan restores to/);
  const graph = fakeGraph();
  await run(plan, graph, createMemoryRestoreJournal());
  assert.ok(graph.writes().every((w) => w.path.startsWith(`/teams/${OTHER_TEAM}/`)));
});

test('throttled writes wait and retry', async () => {
  const plan = await planTeamsMessageRestore(await seededStore(), request({ fallbackAuthorId: FALLBACK }));
  let throttled = 0;
  const graph = fakeGraph({ fail: ({ method, path }) => (method === 'POST' && path.endsWith('/messages') && throttled++ === 0 ? { status: 429, headers: { 'retry-after': '2' }, body: null } : null) });
  const waits = [];
  const report = await run(plan, graph, createMemoryRestoreJournal(), { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(report.status, 'completed');
  assert.ok(waits.includes(2000));
});

test('the payload keeps inline images and file links, and drops cards with a note', () => {
  const { payload, notes } = importPayload(message('9', daysAgo(3), user(ALEX, 'Alex'),
    '<p>See <img src="https://graph.microsoft.com/v1.0/teams/t/channels/c/messages/9/hostedContents/aW1n/$value"></p><attachment id="f1"></attachment><attachment id="card"></attachment>', {
      hostedContents: [{ id: 'aW1n', contentType: 'image/png', contentBytes: 'iVBOR' }],
      attachments: [
        { id: 'f1', contentType: 'reference', contentUrl: 'https://contoso.sharepoint.com/sites/KEEL-RT/Shared%20Documents/a.docx', name: 'a.docx' },
        { id: 'card', contentType: 'application/vnd.microsoft.card.adaptive', content: '{}' },
      ],
      importance: 'urgent',
    }), { author: { id: ALEX, displayName: 'Alex', replaced: false }, root: false });
  assert.equal(payload.body.content, '<p>See <img src="../hostedContents/1/$value"></p><attachment id="f1"></attachment><p><em>1 attachment(s) could not be restored.</em></p>');
  assert.deepEqual(payload.hostedContents, [{ '@microsoft.graph.temporaryId': '1', contentBytes: 'iVBOR', contentType: 'image/png' }]);
  assert.deepEqual(payload.attachments, [{ id: 'f1', contentType: 'reference', contentUrl: 'https://contoso.sharepoint.com/sites/KEEL-RT/Shared%20Documents/a.docx', name: 'a.docx' }]);
  assert.equal(payload.importance, 'urgent');
  assert.equal(payload.subject, undefined, 'a reply carries no subject');
  assert.deepEqual(notes, { mentionsAsText: 0, reactionsDropped: 0, attachmentsDropped: 1, inlineImages: 1 });
});

test('the restored channel name fits Teams\' limit and keeps the start of the name', () => {
  const name = restoredChannelName(`KEEL-RT-${'x'.repeat(80)}`, RUN);
  assert.ok(name.length <= CHANNEL_NAME_MAX);
  assert.match(name, /^KEEL-RT-x+ \(restored \d{4}-\d{2}-\d{2}\)$/);
});

test('the live-proof fixture plans from its own file only, with dates before the run', async () => {
  const fixture = teamsMessageFixture({ authors: [ALEX, BEA], now: RUN });
  const req = request({ fixture: { sha256: canonicalDigest(fixture) }, at: RUN.toISOString() });
  const plan = await planTeamsMessageRestore(createMemoryContentStore(), req, { fixture });
  assert.equal(plan.channel.displayName, 'KEEL-RT-import-proof');
  assert.equal(plan.threads.length, 3);
  assert.equal(plan.messages, 5);
  assert.equal(plan.skipped.length, 2);
  assert.ok(plan.threads.every((thread) => new Date(thread.message.createdDateTime) < RUN));
  await assert.rejects(planTeamsMessageRestore(createMemoryContentStore(), req, { fixture: { ...fixture, threads: [] } }), /not the one this restore was planned from/);
  await assert.rejects(planTeamsMessageRestore(createMemoryContentStore(), req), /pass the same --fixture file/);

  const graph = fakeGraph({ users: [ALEX, BEA, FALLBACK] });
  const report = await run(plan, graph, createMemoryRestoreJournal(), {});
  assert.equal(report.status, 'partial');
  assert.equal(report.failed, 1, 'the author who left needs a fallback');
  const withFallback = await planTeamsMessageRestore(createMemoryContentStore(), { ...req, fallbackAuthorId: FALLBACK }, { fixture });
  const done = await run(withFallback, fakeGraph(), createMemoryRestoreJournal());
  assert.equal(done.status, 'completed');
  assert.equal(done.notes.inlineImages, 1);
  assert.equal(done.notes.attachmentsDropped, 1);
  assert.equal(done.authorsReplaced, 1);
});

test('a channel Microsoft will not put into import mode fails the run before any message is sent', async () => {
  const plan = await planTeamsMessageRestore(await seededStore(), request({ fallbackAuthorId: FALLBACK }));
  const graph = fakeGraph({ fail: ({ method, path }) => (method === 'POST' && path.endsWith('/startMigration') ? { status: 400, headers: {}, body: { error: { code: 'BadRequest', message: 'no' } } } : null) });
  const report = await run(plan, graph, createMemoryRestoreJournal());
  assert.equal(report.status, 'failed');
  assert.match(report.errors[0].error, /putting the channel into import mode failed: 400 BadRequest/);
  assert.ok(!graph.writes().some((w) => w.path.endsWith('/messages')));
  assert.ok(graph.writes().at(-1).path.endsWith('/completeMigration'), 'in case Microsoft opened it after all, import mode is closed');
});

test('a lost answer to startMigration is asked again, and "already in migration" counts as open', async () => {
  const plan = await planTeamsMessageRestore(await seededStore(), request({ fallbackAuthorId: FALLBACK }));
  const journal = createMemoryRestoreJournal();
  let lost = false;
  const first = fakeGraph();
  const transport = async (url, options) => {
    if (!lost && url.endsWith('/startMigration')) { lost = true; throw new Error('socket hang up'); }
    return first.transport(url, options);
  };
  const report = await restoreTeamsMessages({ transport, journal, plan, target: { id: TEAM }, now: () => RUN, sleep: async () => {}, gapMs: 0 });
  assert.equal(report.status, 'failed');
  const again = fakeGraph({ fail: ({ path }) => (path.endsWith('/startMigration') ? { status: 400, headers: {}, body: { error: { code: 'BadRequest', message: 'Channel is already in migration.' } } } : null) });
  const second = await run(plan, again, journal);
  assert.equal(second.status, 'completed');
  assert.equal(second.restored, 4);
  assert.equal(again.writes().filter((w) => w.path.endsWith('/startMigration')).length, 1, 'no beta retry for an already-open channel');
});

test('reopening import mode falls back to beta when v1.0 does not offer it', async () => {
  const plan = await planTeamsMessageRestore(await seededStore(), request());
  const journal = createMemoryRestoreJournal();
  await run(plan, fakeGraph(), journal); // Gus fails: no fallback author
  const seen = [];
  const graph = fakeGraph({ fail: ({ method, path }) => (method === 'POST' && path.endsWith('/startMigration') && !seen.length ? (seen.push(path), { status: 400, headers: {}, body: { error: { code: 'BadRequest' } } }) : null) });
  const urls = [];
  const transport = async (url, options) => { urls.push(url); return graph.transport(url, options); };
  await restoreTeamsMessages({ transport, journal, plan, target: { id: TEAM }, now: () => RUN, sleep: async () => {}, gapMs: 0 });
  const reopen = urls.filter((url) => url.endsWith('/startMigration'));
  assert.deepEqual(reopen.map((url) => new URL(url).pathname.split('/')[1]), ['v1.0', 'beta']);
});

test('a channel name another run holds today gets a number', async () => {
  const plan = await planTeamsMessageRestore(await seededStore(), request({ fallbackAuthorId: FALLBACK }));
  const graph = fakeGraph({ fail: ({ method, path, body }) => (method === 'POST' && path.endsWith('/channels') && !/#2\)$/.test(body.displayName) ? { status: 409, headers: {}, body: { error: { code: 'NameAlreadyExists' } } } : null) });
  const journal = createMemoryRestoreJournal();
  const report = await run(plan, graph, journal);
  assert.equal(report.status, 'completed');
  assert.match(report.channel.name, /^KEEL-RT-general \(restored \d{4}-\d{2}-\d{2} #2\)$/);
  assert.equal((await journal.entry(plan.runId, 'channel')).reason, report.channel.name);
});

test('a write that got no answer stays pending, and the resume flags it as a possible duplicate', async () => {
  const plan = await planTeamsMessageRestore(await seededStore(), request({ fallbackAuthorId: FALLBACK }));
  const journal = createMemoryRestoreJournal();
  const graph = fakeGraph();
  let dropped = false;
  const transport = async (url, options) => {
    if (!dropped && options.method === 'POST' && options.body?.createdDateTime === daysAgo(5)) { dropped = true; throw new Error('socket hang up'); }
    return graph.transport(url, options);
  };
  const first = await restoreTeamsMessages({ transport, journal, plan, target: { id: TEAM }, now: () => RUN, sleep: async () => {}, gapMs: 0 });
  assert.equal(first.status, 'partial');
  assert.equal((await journal.entry(plan.runId, 'message:2001')).status, 'pending');
  const again = await run(plan, fakeGraph(), journal);
  assert.deepEqual(again.possibleDuplicates, ['2001']);
  assert.equal(again.status, 'completed');
});

test('a write retried after a server error is flagged as a possible duplicate', async () => {
  const plan = await planTeamsMessageRestore(await seededStore(), request({ fallbackAuthorId: FALLBACK }));
  let once = false;
  const graph = fakeGraph({ fail: ({ method, body }) => (method === 'POST' && body?.createdDateTime === daysAgo(5) && !once ? (once = true, { status: 503, headers: {}, body: null }) : null) });
  const report = await run(plan, graph, createMemoryRestoreJournal());
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.possibleDuplicates, ['2001']);
});
