import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import {
  assertPlannerRequest, backupPlannerAndConversations, PlannerScopeError, PLANNER_WORKLOAD, CONVERSATIONS_WORKLOAD,
} from './planner.mjs';

// In-memory content store with the Wave 1 interface, until the content store merges.
function memoryContentStore() {
  const blobs = new Map();
  const items = [];
  return {
    items,
    async putItem(stream, { tenantRef, workload, container, itemKey, version, metadata }) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const deduped = blobs.has(sha256);
      if (!deduped) blobs.set(sha256, bytes);
      const ref = `mem:${sha256}`;
      items.push({ ref, tenantRef, workload, container, itemKey, version, metadata, at: new Date() });
      return { ref, sha256, bytes: deduped ? 0 : bytes.length, deduped };
    },
    async getItem(ref) {
      return Readable.from([blobs.get(ref.slice('mem:'.length))]);
    },
    async listItems({ container, since } = {}) {
      return items.filter((item) => (!container || item.container === container) && (!since || item.at >= since));
    },
  };
}

async function readBack(store, ref) {
  const chunks = [];
  for await (const chunk of await store.getItem(ref)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const G = 'https://graph.microsoft.com/v1.0';
const GROUP = '11111111-2222-3333-4444-555555555555';
const OTHER = '66666666-7777-8888-9999-000000000000';
const DENIED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PLAN = 'KeelRtPlan0000000000000001';
const CONV = 'AAQkAGRhY2Ux+conv/1==';
const THREAD = 'AAQkAGRhY2Ux+thread/1==';
const POST1 = 'AAMkAGRhY2Ux+post/1==';
const POST2 = 'AAMkAGRhY2Ux+post/2==';
const FILE_BYTES = Buffer.from('KEEL-RT- attachment bytes \u0000\u0001ÿ');
const enc = encodeURIComponent;
const unified = `${G}/groups?${new URLSearchParams({ $filter: "groupTypes/any(c:c eq 'Unified')", $select: 'id,displayName' })}`;

function fixtureRoutes() {
  const conv = `${G}/groups/${GROUP}/conversations/${enc(CONV)}`;
  const thread = `${conv}/threads/${enc(THREAD)}`;
  return {
    [unified]: { value: [{ id: GROUP, displayName: 'KEEL-RT-Planner' }, { id: DENIED, displayName: 'KEEL-RT-NoPlanner' }], '@odata.nextLink': `${unified}&$skiptoken=p2` },
    [`${unified}&$skiptoken=p2`]: { value: [{ id: OTHER, displayName: 'Finance' }, { id: 'not-a-guid', displayName: 'KEEL-RT-Bad' }] },
    [`${G}/groups/${GROUP}/planner/plans`]: { value: [{ id: PLAN, title: 'KEEL-RT-Plan', '@odata.etag': 'W/"p1"' }] },
    [`${G}/planner/plans/${PLAN}/details`]: { id: PLAN, categoryDescriptions: { category1: 'Urgent' }, '@odata.etag': 'W/"pd1"' },
    [`${G}/planner/plans/${PLAN}/buckets`]: { value: [{ id: 'bucketTodo', name: 'To do', planId: PLAN, '@odata.etag': 'W/"b1"' }, { id: 'bucketDone', name: 'Done', planId: PLAN, '@odata.etag': 'W/"b2"' }] },
    [`${G}/planner/plans/${PLAN}/tasks`]: { value: [{ id: 'task1', title: 'KEEL-RT-Task one', bucketId: 'bucketTodo', '@odata.etag': 'W/"t1"' }], '@odata.nextLink': `${G}/planner/plans/${PLAN}/tasks?$skiptoken=t2` },
    [`${G}/planner/plans/${PLAN}/tasks?$skiptoken=t2`]: { value: [{ id: 'task2', title: 'KEEL-RT-Task two', bucketId: 'bucketDone', '@odata.etag': 'W/"t2"' }] },
    [`${G}/planner/tasks/task1/details`]: { id: 'task1', description: 'First', checklist: { a: { title: 'step', isChecked: false } }, '@odata.etag': 'W/"td1"' },
    [`${G}/planner/tasks/task2/details`]: { id: 'task2', description: 'Second', references: {}, '@odata.etag': 'W/"td2"' },
    [`${G}/groups/${GROUP}/conversations`]: { value: [{ id: CONV, topic: 'KEEL-RT-Conversation', lastDeliveredDateTime: '2026-10-01T10:00:00Z' }] },
    [`${conv}/threads`]: { value: [{ id: THREAD, topic: 'KEEL-RT-Conversation', lastDeliveredDateTime: '2026-10-01T10:00:00Z' }] },
    [`${thread}/posts`]: { value: [
      { id: POST1, changeKey: 'ck1', hasAttachments: true, body: { contentType: 'html', content: '<p>Hello</p>' } },
      { id: POST2, changeKey: 'ck2', hasAttachments: false, body: { contentType: 'html', content: '<p>Reply</p>' } },
    ] },
    [`${thread}/posts/${enc(POST1)}/attachments`]: { value: [
      { '@odata.type': '#microsoft.graph.fileAttachment', id: 'att1', name: 'KEEL-RT-notes.txt', contentType: 'text/plain', size: FILE_BYTES.length, contentBytes: FILE_BYTES.toString('base64') },
      { '@odata.type': '#microsoft.graph.itemAttachment', id: 'att2', name: 'Forwarded mail', contentType: null, size: 900 },
    ] },
    [`${G}/groups/${OTHER}/planner/plans`]: { value: [] },
    [`${G}/groups/${OTHER}/conversations`]: { value: [] },
    [`${G}/groups/${DENIED}/conversations`]: { value: [] },
  };
}

function fixtureTransport({ routes = fixtureRoutes(), throttleOnce = [], fail = {} } = {}) {
  const calls = [];
  const throttled = new Set();
  const transport = async (url) => {
    calls.push(url);
    if (throttleOnce.includes(url) && !throttled.has(url)) {
      throttled.add(url);
      return { status: 429, headers: { 'retry-after': '2' }, body: null };
    }
    if (fail[url]) return { status: fail[url], headers: {}, body: { error: { code: 'Forbidden' } } };
    if (url.startsWith(`${G}/groups/${DENIED}/planner`)) return { status: 403, headers: {}, body: { error: { code: 'Forbidden' } } };
    if (!(url in routes)) return { status: 404, headers: {}, body: { error: { code: 'NotFound' } } };
    return { status: 200, headers: {}, body: routes[url] };
  };
  return { transport, calls };
}

test('a fixture plan and conversation are captured, every object once, read back byte-identical', async () => {
  const store = memoryContentStore();
  const sleeps = [];
  const { transport, calls } = fixtureTransport({ throttleOnce: [`${G}/planner/plans/${PLAN}/buckets`] });
  const result = await backupPlannerAndConversations({
    transport, contentStore: store, tenantRef: 'tenant-ref', namePrefix: 'KEEL-RT-', sleep: async (ms) => sleeps.push(ms),
  });

  assert.equal(result.discovery.status, 'observed');
  assert.equal(result.discovery.pages, 2);
  assert.deepEqual(result.groups.map((group) => group.displayName), ['KEEL-RT-Planner', 'KEEL-RT-NoPlanner']);
  assert.deepEqual(result.outOfScope, [{ groupId: 'not-a-guid', reason: 'not a group id KEEL will put in a path' }]);
  assert.deepEqual(sleeps, [2000], 'Retry-After is honoured');

  const [captured, denied] = result.groups;
  assert.equal(captured.planner.status, 'observed');
  assert.deepEqual(captured.planner.counts, { plans: 1, planDetails: 1, buckets: 2, tasks: 2, taskDetails: 2 });
  assert.equal(captured.conversations.status, 'observed');
  assert.deepEqual(captured.conversations.counts, { conversations: 1, threads: 1, posts: 2, attachments: 2 });
  assert.equal(denied.planner.status, 'denied');
  assert.equal(denied.planner.httpStatus, 403);
  assert.equal(denied.conversations.status, 'observed');
  assert.equal(result.outcome, 'partial', 'a denied section is never a complete run');

  const keys = store.items.filter((item) => item.container === `group:${GROUP}`).map((item) => item.itemKey);
  assert.equal(new Set(keys).size, keys.length, 'no object is stored twice in one run');
  assert.deepEqual(keys.filter((key) => !key.startsWith('attachment:') && !key.startsWith('post:') && !key.startsWith('thread:') && !key.startsWith('conversation:')).sort(), [
    'bucket:bucketDone', 'bucket:bucketTodo', `plan:${PLAN}`, `plan:${PLAN}/details`,
    'task:task1', 'task:task1/details', 'task:task2', 'task:task2/details',
  ]);
  for (const item of store.items) {
    assert.equal(item.tenantRef, 'tenant-ref');
    assert.ok([PLANNER_WORKLOAD, CONVERSATIONS_WORKLOAD].includes(item.workload));
  }

  const byKey = new Map(store.items.map((item) => [item.itemKey, item]));
  const task = JSON.parse(await readBack(store, byKey.get('task:task1/details').ref));
  assert.deepEqual(task.checklist, { a: { title: 'step', isChecked: false } });
  assert.equal(byKey.get('task:task1').version, 'W/"t1"');
  assert.equal(byKey.get('task:task2').metadata.bucketId, 'bucketDone');

  const post = byKey.get(`post:${CONV}/${THREAD}/${POST1}`);
  assert.equal(post.workload, CONVERSATIONS_WORKLOAD);
  assert.equal(post.version, 'ck1');
  assert.equal(JSON.parse(await readBack(store, post.ref)).body.content, '<p>Hello</p>');

  const fileKey = `attachment:${CONV}/${THREAD}/${POST1}/att1`;
  assert.deepEqual(await readBack(store, byKey.get(`${fileKey}/content`).ref), FILE_BYTES);
  assert.equal(JSON.parse(await readBack(store, byKey.get(fileKey).ref)).contentBytes, undefined, 'bytes are stored once, as their own item');
  assert.deepEqual(result.incomplete, [{
    itemKey: `attachment:${CONV}/${THREAD}/${POST1}/att2`, missing: ['item'], reason: 'the attached item needs $expand, which this read-only package does not send',
  }]);

  assert.ok(calls.every((url) => assertPlannerRequest(url, 'GET')), 'every request passed the read-only allowlist');
  assert.equal(result.requests, calls.length);
});

test('a second run of the same fixture stores nothing new', async () => {
  const store = memoryContentStore();
  const first = await backupPlannerAndConversations({ transport: fixtureTransport().transport, contentStore: store, tenantRef: 't' });
  const second = await backupPlannerAndConversations({ transport: fixtureTransport().transport, contentStore: store, tenantRef: 't' });
  assert.equal(second.stored.items, first.stored.items);
  assert.equal(second.stored.deduped, second.stored.items);
  assert.equal(second.stored.bytes, 0);
});

test('named groups skip discovery, and a failed sub-read makes the section partial', async () => {
  const store = memoryContentStore();
  const routes = { ...fixtureRoutes(), [`${G}/groups/${GROUP}?$select=id,displayName`]: { id: GROUP, displayName: 'KEEL-RT-Planner' } };
  const { transport, calls } = fixtureTransport({ routes, fail: { [`${G}/planner/tasks/task2/details`]: 500 } });
  const result = await backupPlannerAndConversations({ transport, contentStore: store, tenantRef: 't', groupIds: [GROUP] });
  assert.equal(result.discovery.mode, 'named');
  assert.ok(!calls.includes(unified));
  assert.equal(result.groups[0].planner.status, 'partial');
  assert.deepEqual(result.groups[0].planner.errors, [{ scope: 'task:task2/details', status: 'failed', httpStatus: 500, error: 'GET /v1.0/planner/tasks/task2/details: HTTP 500' }]);
  assert.equal(result.groups[0].planner.counts.tasks, 2);
  assert.equal(result.outcome, 'partial');
  await assert.rejects(backupPlannerAndConversations({ transport, contentStore: store, tenantRef: 't', groupIds: ['../me'] }), TypeError);
});

test('a failed discovery is a failed run with nothing stored, never an empty one', async () => {
  const store = memoryContentStore();
  const { transport } = fixtureTransport({ fail: { [unified]: 403 } });
  const result = await backupPlannerAndConversations({ transport, contentStore: store, tenantRef: 't' });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.discovery.status, 'denied');
  assert.deepEqual(result.groups, []);
  assert.equal(store.items.length, 0);
});

test('a refused next page fails that read only; the run still returns a result', async () => {
  const routes = fixtureRoutes();
  routes[`${G}/groups/${GROUP}/planner/plans`] = { value: [], '@odata.nextLink': `${G}/groups/${GROUP}/conversations` };
  routes[`${G}/planner/plans/${PLAN}/buckets`] = { value: [], '@odata.nextLink': `${G}/planner/plans/${PLAN}/buckets?$expand=tasks` };
  const { transport, calls } = fixtureTransport({ routes });
  const result = await backupPlannerAndConversations({ transport, contentStore: memoryContentStore(), tenantRef: 't', namePrefix: 'KEEL-RT-Planner' });
  const [group] = result.groups;
  assert.equal(group.planner.status, 'failed');
  assert.equal(group.planner.error.includes('refused a next page'), true);
  assert.equal(group.conversations.status, 'observed', 'the other section still ran');
  assert.equal(result.outcome, 'partial');
  assert.equal(calls.filter((url) => url === `${G}/groups/${GROUP}/conversations`).length, 1, 'only the real conversations read, never the off-path next page');
});

test('the page cap keeps what was read and marks the section partial', async () => {
  const routes = fixtureRoutes();
  const tasks = `${G}/planner/plans/${PLAN}/tasks`;
  routes[`${tasks}?$skipToken=t2`] = routes[`${tasks}?$skiptoken=t2`];
  routes[tasks] = { ...routes[tasks], '@odata.nextLink': `${tasks}?$skipToken=t2` };
  routes[`${tasks}?$skipToken=t2`] = { ...routes[`${tasks}?$skipToken=t2`], '@odata.nextLink': `${tasks}?$skipToken=t3` };
  const store = memoryContentStore();
  const { transport } = fixtureTransport({ routes });
  const result = await backupPlannerAndConversations({ transport, contentStore: store, tenantRef: 't', namePrefix: 'KEEL-RT-Planner', maxPages: 2 });
  const [group] = result.groups;
  assert.equal(group.planner.counts.tasks, 2, 'both pages read before the cap are stored ($skipToken in either case)');
  assert.equal(group.planner.status, 'partial');
  assert.deepEqual(group.planner.errors.map((error) => [error.scope, error.status]), [[`plan:${PLAN}/tasks`, 'capped']]);
  assert.equal(result.outcome, 'partial');
});

test('an object with an id KEEL will not put in a path is still stored and flagged', async () => {
  const routes = fixtureRoutes();
  routes[`${G}/planner/plans/${PLAN}/tasks?$skiptoken=t2`] = { value: [{ id: '../task', title: 'odd' }] };
  const store = memoryContentStore();
  const { transport, calls } = fixtureTransport({ routes });
  const result = await backupPlannerAndConversations({ transport, contentStore: store, tenantRef: 't', namePrefix: 'KEEL-RT-Planner' });
  const [group] = result.groups;
  assert.equal(group.planner.counts.tasks, 2);
  assert.equal(group.planner.status, 'partial');
  const flagged = result.incomplete.find((entry) => entry.itemKey.startsWith('task:unsafe-id:'));
  assert.deepEqual(flagged.missing, ['details']);
  const item = store.items.find((entry) => entry.itemKey === flagged.itemKey);
  assert.equal(JSON.parse(await readBack(store, item.ref)).title, 'odd');
  assert.ok(!calls.some((url) => url.includes('..') || url.includes('%2E%2E')));
});

test('a run where every group is denied is failed, and an unreadable named group is that group\'s failure', async () => {
  const routes = fixtureRoutes();
  delete routes[`${G}/groups/${DENIED}/conversations`];
  const named = { ...routes, [`${G}/groups/${DENIED}?$select=id,displayName`]: { id: DENIED, displayName: 'KEEL-RT-NoPlanner' } };
  const allDenied = await backupPlannerAndConversations({
    transport: fixtureTransport({ routes: named, fail: { [`${G}/groups/${DENIED}/conversations`]: 403 } }).transport,
    contentStore: memoryContentStore(), tenantRef: 't', groupIds: [DENIED],
  });
  assert.equal(allDenied.outcome, 'failed');

  const withGone = { ...named, [`${G}/groups/${GROUP}?$select=id,displayName`]: { id: GROUP, displayName: 'KEEL-RT-Planner' } };
  const result = await backupPlannerAndConversations({
    transport: fixtureTransport({ routes: withGone }).transport, contentStore: memoryContentStore(), tenantRef: 't', groupIds: [OTHER, GROUP],
  });
  assert.deepEqual(result.unreachable.map((entry) => [entry.groupId, entry.httpStatus]), [[OTHER, 404]]);
  assert.deepEqual(result.groups.map((group) => group.groupId), [GROUP]);
  assert.equal(result.groups[0].planner.status, 'observed');
  assert.equal(result.outcome, 'partial');
});

test('the allowlist refuses writes, other hosts, other paths and content-expanding queries', () => {
  assert.equal(assertPlannerRequest(`${G}/planner/plans/${PLAN}/tasks?$top=50`), 'planner.tasks');
  assert.equal(assertPlannerRequest(`${G}/groups/${GROUP}/conversations/${enc(CONV)}/threads`), 'conversations.threads');
  const refused = [
    [`${G}/planner/tasks/task1`, 'PATCH'],
    [`${G}/groups/${GROUP}/conversations`, 'POST'],
    [`${G}/planner/tasks/task1/details`, 'DELETE'],
    ['https://evil.example/v1.0/groups'],
    [`https://graph.microsoft.com/beta/groups/${GROUP}/planner/plans`],
    [`${G}/users/${GROUP}/messages`],
    [`${G}/chats`],
    [`${G}/groups/${GROUP}/drive/root/children`],
    [`${G}/groups/${GROUP}/conversations?$expand=threads`],
    [`${G}/groups/${GROUP}/conversations/${enc(CONV)}/threads/${enc(THREAD)}/reply`],
    [`${G}/groups?$filter=startswith(displayName,'a')`],
    [`${G}/groups?${new URLSearchParams([['$filter', "groupTypes/any(c:c eq 'Unified')"], ['$filter', "startswith(displayName,'a')"]])}`],
    [`${G}/groups?$FILTER=startswith(displayName,'a')`],
    [`${G}/groups/not-a-guid/planner/plans`],
  ];
  for (const [url, method] of refused) assert.throws(() => assertPlannerRequest(url, method), PlannerScopeError, `${method ?? 'GET'} ${url}`);
});

test('the content store and tenant ref are required', async () => {
  const { transport } = fixtureTransport();
  await assert.rejects(backupPlannerAndConversations({ transport, contentStore: {}, tenantRef: 't' }), TypeError);
  await assert.rejects(backupPlannerAndConversations({ transport, contentStore: memoryContentStore() }), TypeError);
});
