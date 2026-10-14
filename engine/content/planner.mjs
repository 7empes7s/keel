/**
 * Wave 1 package PLANNER: backs up Planner plans, buckets and tasks, and Group
 * conversations, for every Microsoft 365 group the run covers.
 *
 * What one run reads, per group (Graph v1.0, GET only):
 *  - Planner: the group's plans, each plan's details, buckets and tasks, and each
 *    task's details (description, checklist, references).
 *  - Conversations: the group's conversations, each conversation's threads, each
 *    thread's posts, and the attachments of posts that have any.
 *
 * Rules:
 *  - Read-only. Every request goes through assertPlannerRequest: GET on
 *    graph.microsoft.com, one of the paths below, and only paging or $select and
 *    $top query keys. A next page is checked the same way before it is followed.
 *  - Content goes to the content store through its fixed interface
 *    (putItem(stream, { tenantRef, workload, container, itemKey, version, metadata })),
 *    one item per object. The container is the group. Dedupe is the store's job.
 *  - Nothing readable is skipped. A file attachment's bytes are stored as their own
 *    item. An item attachment (a mail or event attached to a post) cannot be read
 *    without $expand, which the allowlist refuses, so it is stored as what Graph
 *    returns and listed under `incomplete` with the reason.
 *  - Errors are structured. A failed group discovery means the group set is
 *    unknown, never empty. A 401 or 403 is `denied`, any other failure is
 *    `failed`, and a section with some failed reads is `partial`. A list that hits
 *    the page cap keeps what it read and makes its section `partial`. A named
 *    group that can't be read is listed under `unreachable`. A run in which no
 *    section read anything is `failed`.
 *  - An object whose id KEEL won't put in a path is still stored, and its
 *    children are listed under `incomplete`.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export const PLANNER_WORKLOAD = 'planner';
export const CONVERSATIONS_WORKLOAD = 'group-conversations';
export const DEFAULT_MAX_GROUPS = 500;
export const DEFAULT_MAX_PAGES = 200;

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const BASE = `${GRAPH_ORIGIN}/v1.0`;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Planner ids are short url-safe strings. Conversation, thread, post and
// attachment ids are base64 and may carry + / =; they are encoded in the path.
const PLANNER_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAIL_ID_RE = /^[A-Za-z0-9+/=_-]{1,1024}$/;

const GUID = (segment) => GUID_RE.test(segment);
const PLANNER_ID = (segment) => PLANNER_ID_RE.test(segment);
const MAIL_ID = (segment) => MAIL_ID_RE.test(segment);
const literal = (word) => (segment) => segment === word;

const PAGING_QUERY = ['$top', '$skiptoken', '$skip', '$select'];

// Every request shape a run may send, as path segments after /v1.0.
export const PLANNER_REQUEST_SHAPES = Object.freeze([
  { id: 'groups.discovery', segments: ['groups'], query: [...PAGING_QUERY, '$filter'] },
  { id: 'groups.group', segments: ['groups', GUID], query: ['$select'] },
  { id: 'planner.plans', segments: ['groups', GUID, 'planner', 'plans'], query: PAGING_QUERY },
  { id: 'planner.plan-details', segments: ['planner', 'plans', PLANNER_ID, 'details'], query: [] },
  { id: 'planner.buckets', segments: ['planner', 'plans', PLANNER_ID, 'buckets'], query: PAGING_QUERY },
  { id: 'planner.tasks', segments: ['planner', 'plans', PLANNER_ID, 'tasks'], query: PAGING_QUERY },
  { id: 'planner.task-details', segments: ['planner', 'tasks', PLANNER_ID, 'details'], query: [] },
  { id: 'conversations.list', segments: ['groups', GUID, 'conversations'], query: PAGING_QUERY },
  { id: 'conversations.threads', segments: ['groups', GUID, 'conversations', MAIL_ID, 'threads'], query: PAGING_QUERY },
  { id: 'conversations.posts', segments: ['groups', GUID, 'conversations', MAIL_ID, 'threads', MAIL_ID, 'posts'], query: PAGING_QUERY },
  { id: 'conversations.attachments', segments: ['groups', GUID, 'conversations', MAIL_ID, 'threads', MAIL_ID, 'posts', MAIL_ID, 'attachments'], query: PAGING_QUERY },
].map((shape) => Object.freeze({
  ...shape,
  segments: Object.freeze(shape.segments.map((part) => (typeof part === 'string' ? literal(part) : part))),
  query: Object.freeze(shape.query.map((key) => key.toLowerCase())),
})));

export class PlannerScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlannerScopeError';
  }
}

/** Throws unless `url` is a GET this package may send. Returns the matching shape id. */
export function assertPlannerRequest(url, method = 'GET') {
  if (method !== 'GET') throw new PlannerScopeError(`${method} ${url}: Planner and conversation backup only reads`);
  let parsed;
  try { parsed = new URL(url); } catch { throw new PlannerScopeError(`${url} is not a URL`); }
  if (parsed.origin !== GRAPH_ORIGIN || parsed.username || parsed.password || parsed.hash) {
    throw new PlannerScopeError(`${url} is not a Microsoft Graph request`);
  }
  const raw = parsed.pathname.split('/').filter(Boolean);
  if (raw[0] !== 'v1.0') throw new PlannerScopeError(`${parsed.pathname} is not a Graph v1.0 path`);
  let segments;
  try { segments = raw.slice(1).map((segment) => decodeURIComponent(segment)); } catch {
    throw new PlannerScopeError(`${parsed.pathname} has a malformed segment`);
  }
  const shape = PLANNER_REQUEST_SHAPES.find((candidate) => candidate.segments.length === segments.length
    && candidate.segments.every((matches, index) => matches(segments[index])));
  if (!shape) throw new PlannerScopeError(`GET ${parsed.pathname} is not a Planner or Group conversation read`);
  // Graph spells paging keys either way ($skiptoken, $skipToken); match without case.
  const keys = [...parsed.searchParams.keys()].map((key) => key.toLowerCase());
  for (const key of keys) {
    if (!shape.query.includes(key)) throw new PlannerScopeError(`GET ${parsed.pathname}: query ${key} is not allowed`);
  }
  if (new Set(keys).size !== keys.length) throw new PlannerScopeError(`GET ${parsed.pathname}: a query key repeats`);
  if (shape.id === 'groups.discovery') {
    const filter = [...parsed.searchParams].find(([key]) => key.toLowerCase() === '$filter');
    if (filter && filter[1] !== UNIFIED_FILTER) {
      throw new PlannerScopeError(`GET ${parsed.pathname}: only the Microsoft 365 group filter is allowed`);
    }
  }
  return shape.id;
}

const UNIFIED_FILTER = "groupTypes/any(c:c eq 'Unified')";

function failureStatus(error) {
  return error?.status === 401 || error?.status === 403 ? 'denied' : 'failed';
}

function failure(error) {
  return {
    status: failureStatus(error),
    httpStatus: Number.isInteger(error?.status) ? error.status : null,
    error: String(error?.message ?? error),
  };
}

const seg = (value) => encodeURIComponent(value);

function assertContentStore(store) {
  if (!store || typeof store.putItem !== 'function') {
    throw new TypeError('contentStore must provide putItem(stream, { tenantRef, workload, container, itemKey, version, metadata })');
  }
}

/**
 * Reads the given groups' plans and conversations and stores each object in the
 * content store. Pure apart from the injected transport and store.
 *   transport(url) -> { status, headers: { 'retry-after'? }, body }
 */
export async function backupPlannerAndConversations({
  transport,
  contentStore,
  tenantRef,
  groupIds = null,
  namePrefix = null,
  maxGroups = DEFAULT_MAX_GROUPS,
  maxPages = DEFAULT_MAX_PAGES,
  maxRetries = 3,
  sleep = async () => {},
  now = () => new Date(),
}) {
  if (typeof transport !== 'function') throw new TypeError('transport must be a function');
  assertContentStore(contentStore);
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('tenantRef is required');
  if (groupIds !== null && !Array.isArray(groupIds)) throw new TypeError('groupIds must be a list of group ids');

  const observedFrom = now().toISOString();
  let requests = 0;
  const stored = { items: 0, bytes: 0, deduped: 0 };
  const incomplete = [];

  async function getPage(url) {
    assertPlannerRequest(url, 'GET');
    for (let attempt = 0; ; attempt += 1) {
      requests += 1;
      const response = await transport(url);
      if (response?.status === 429 || response?.status === 503) {
        if (attempt >= maxRetries) {
          const error = new Error(`GET ${new URL(url).pathname}: still throttled after ${maxRetries} retries`);
          error.status = response.status;
          throw error;
        }
        const seconds = Number(response.headers?.['retry-after']);
        await sleep(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempt * 1000);
        continue;
      }
      if (!response || response.status < 200 || response.status >= 300) {
        const error = new Error(`GET ${new URL(url).pathname}: HTTP ${response?.status}`);
        error.status = response?.status;
        throw error;
      }
      return response.body ?? {};
    }
  }

  // Reads every page. At the page cap it returns what it read with capped: true,
  // never throws it away. A next page outside the allowlist is a read failure
  // (the items already read are lost to that read only), not a run-ending error:
  // a PlannerScopeError is kept for requests this code builds itself.
  async function getAll(url) {
    const items = [];
    let next = url;
    let pages = 0;
    while (next) {
      if (pages >= maxPages) return { items, pages, capped: true };
      const body = await getPage(next);
      pages += 1;
      if (Array.isArray(body.value)) items.push(...body.value);
      const link = body['@odata.nextLink'];
      if (!link) break;
      let refused = null;
      try {
        if (decodeURIComponent(new URL(link).pathname) !== decodeURIComponent(new URL(url).pathname)) refused = `it leaves ${new URL(url).pathname}`;
        else assertPlannerRequest(link, 'GET');
      } catch (error) {
        refused = error.message;
      }
      if (refused) {
        const error = new Error(`GET ${new URL(url).pathname}: refused a next page: ${refused}`);
        error.code = 'REFUSED_NEXT_PAGE';
        throw error;
      }
      next = link;
    }
    return { items, pages, capped: false };
  }

  async function put({ workload, container, itemKey, version, metadata, bytes }) {
    const result = await contentStore.putItem(Readable.from([bytes]), {
      tenantRef, workload, container, itemKey, version: version ?? null, metadata,
    });
    stored.items += 1;
    stored.bytes += Number.isFinite(result?.bytes) ? result.bytes : bytes.length;
    if (result?.deduped) stored.deduped += 1;
    return result;
  }

  const putJson = (entry, body) => put({ ...entry, bytes: Buffer.from(JSON.stringify(body)) });

  // Group discovery. A failed discovery means the group set is unknown, never empty.
  let candidates;
  let discovery;
  const unreachable = [];
  try {
    if (groupIds) {
      for (const id of groupIds) {
        if (typeof id !== 'string' || !GUID_RE.test(id)) throw new TypeError(`${id} is not a group id`);
      }
      // A named group that can't be read is that group's failure, not the run's.
      candidates = [];
      for (const id of groupIds) {
        try {
          candidates.push(await getPage(`${BASE}/groups/${seg(id)}?$select=id,displayName`));
        } catch (error) {
          if (error instanceof PlannerScopeError) throw error;
          unreachable.push({ groupId: id.toLowerCase(), ...failure(error) });
        }
      }
      discovery = { status: 'observed', mode: 'named', pages: groupIds.length };
    } else {
      const query = new URLSearchParams({ $filter: UNIFIED_FILTER, $select: 'id,displayName' });
      const { items, pages, capped: discoveryCapped } = await getAll(`${BASE}/groups?${query}`);
      candidates = items;
      discovery = { status: 'observed', mode: 'all-unified-groups', pages, capped: discoveryCapped };
    }
  } catch (error) {
    if (error instanceof TypeError || error instanceof PlannerScopeError) throw error;
    candidates = null;
    discovery = { ...failure(error), mode: groupIds ? 'named' : 'all-unified-groups', pages: null };
  }

  const groups = [];
  const outOfScope = [];
  let capped = discovery.capped === true;
  const seen = new Set();
  for (const group of candidates ?? []) {
    const id = String(group?.id ?? '').toLowerCase();
    if (!GUID_RE.test(id)) {
      outOfScope.push({ groupId: String(group?.id ?? ''), reason: 'not a group id KEEL will put in a path' });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (namePrefix && !String(group.displayName ?? '').startsWith(namePrefix)) continue;
    if (groups.length >= maxGroups) { capped = true; break; }
    groups.push({ groupId: id, displayName: group.displayName ?? null });
  }

  for (const group of groups) {
    const container = `group:${group.groupId}`;
    group.planner = await backupPlanner(group.groupId, container);
    group.conversations = await backupConversations(group.groupId, container);
  }

  async function section(work) {
    const counts = {};
    const errors = [];
    const count = (name, n = 1) => { counts[name] = (counts[name] ?? 0) + n; };
    const attempt = async (scope, fn) => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof PlannerScopeError) throw error;
        errors.push({ scope, ...failure(error) });
        return null;
      }
    };
    const list = async (scope, url) => {
      const { items, capped: listCapped } = await getAll(url);
      if (listCapped) errors.push({ scope, status: 'capped', httpStatus: null, error: `more than ${maxPages} pages; the rest was not read` });
      return items;
    };
    // An object whose id KEEL won't put in a path is still stored, and its
    // children are recorded as not read.
    const unsafe = async (entry, kind, object, missing) => {
      const key = `${kind}:unsafe-id:${createHash('sha256').update(String(object?.id ?? '')).digest('hex').slice(0, 16)}`;
      await putJson(entry(key, null, { kind, unsafeId: String(object?.id ?? '') }), object);
      count(`${kind}s`);
      incomplete.push({ itemKey: key, missing, reason: 'the id is not one KEEL will put in a path' });
      errors.push({ scope: key, status: 'unsafe-id', httpStatus: null, error: `${missing.join(', ')} not read` });
    };
    let top = null;
    try {
      await work({ count, attempt, list, unsafe });
    } catch (error) {
      if (error instanceof PlannerScopeError) throw error;
      top = failure(error);
    }
    if (top) return { ...top, counts, errors };
    return { status: errors.length ? 'partial' : 'observed', counts, errors };
  }

  async function backupPlanner(groupId, container) {
    const entry = (itemKey, version, metadata) => ({ workload: PLANNER_WORKLOAD, container, itemKey, version, metadata });
    return section(async ({ count, attempt, list, unsafe }) => {
      const plans = await list(`group:${groupId}/plans`, `${BASE}/groups/${seg(groupId)}/planner/plans`);
      for (const plan of plans) {
        if (!PLANNER_ID_RE.test(String(plan?.id ?? ''))) { await unsafe(entry, 'plan', plan, ['details', 'buckets', 'tasks']); continue; }
        const planId = plan.id;
        await putJson(entry(`plan:${planId}`, plan['@odata.etag'], { kind: 'plan', title: plan.title ?? null }), plan);
        count('plans');
        await attempt(`plan:${planId}/details`, async () => {
          const details = await getPage(`${BASE}/planner/plans/${seg(planId)}/details`);
          await putJson(entry(`plan:${planId}/details`, details['@odata.etag'], { kind: 'planDetails', planId }), details);
          count('planDetails');
        });
        await attempt(`plan:${planId}/buckets`, async () => {
          const buckets = await list(`plan:${planId}/buckets`, `${BASE}/planner/plans/${seg(planId)}/buckets`);
          for (const bucket of buckets) {
            await putJson(entry(`bucket:${bucket.id}`, bucket['@odata.etag'], { kind: 'bucket', planId, name: bucket.name ?? null }), bucket);
            count('buckets');
          }
        });
        await attempt(`plan:${planId}/tasks`, async () => {
          const tasks = await list(`plan:${planId}/tasks`, `${BASE}/planner/plans/${seg(planId)}/tasks`);
          for (const task of tasks) {
            if (!PLANNER_ID_RE.test(String(task?.id ?? ''))) { await unsafe(entry, 'task', task, ['details']); continue; }
            await putJson(entry(`task:${task.id}`, task['@odata.etag'], { kind: 'task', planId, bucketId: task.bucketId ?? null, title: task.title ?? null }), task);
            count('tasks');
            await attempt(`task:${task.id}/details`, async () => {
              const details = await getPage(`${BASE}/planner/tasks/${seg(task.id)}/details`);
              await putJson(entry(`task:${task.id}/details`, details['@odata.etag'], { kind: 'taskDetails', planId, taskId: task.id }), details);
              count('taskDetails');
            });
          }
        });
      }
    });
  }

  async function backupConversations(groupId, container) {
    const entry = (itemKey, version, metadata) => ({ workload: CONVERSATIONS_WORKLOAD, container, itemKey, version, metadata });
    const g = `${BASE}/groups/${seg(groupId)}`;
    return section(async ({ count, attempt, list, unsafe }) => {
      const conversations = await list(`group:${groupId}/conversations`, `${g}/conversations`);
      for (const conversation of conversations) {
        const cid = String(conversation?.id ?? '');
        if (!MAIL_ID_RE.test(cid)) { await unsafe(entry, 'conversation', conversation, ['threads']); continue; }
        await putJson(entry(`conversation:${cid}`, conversation.lastDeliveredDateTime, { kind: 'conversation', topic: conversation.topic ?? null }), conversation);
        count('conversations');
        await attempt(`conversation:${cid}/threads`, async () => {
          const threads = await list(`conversation:${cid}/threads`, `${g}/conversations/${seg(cid)}/threads`);
          for (const thread of threads) {
            const tid = String(thread?.id ?? '');
            if (!MAIL_ID_RE.test(tid)) { await unsafe(entry, 'thread', thread, ['posts']); continue; }
            await putJson(entry(`thread:${cid}/${tid}`, thread.lastDeliveredDateTime, { kind: 'thread', conversationId: cid, topic: thread.topic ?? null }), thread);
            count('threads');
            await attempt(`thread:${cid}/${tid}/posts`, async () => {
              const posts = await list(`thread:${cid}/${tid}/posts`, `${g}/conversations/${seg(cid)}/threads/${seg(tid)}/posts`);
              for (const post of posts) {
                const pid = String(post?.id ?? '');
                if (!MAIL_ID_RE.test(pid)) { await unsafe(entry, 'post', post, ['attachments']); continue; }
                const postKey = `post:${cid}/${tid}/${pid}`;
                await putJson(entry(postKey, post.changeKey ?? post.lastModifiedDateTime, { kind: 'post', conversationId: cid, threadId: tid, receivedDateTime: post.receivedDateTime ?? null }), post);
                count('posts');
                if (post.hasAttachments !== true) continue;
                await attempt(`${postKey}/attachments`, async () => {
                  const attachments = await list(`${postKey}/attachments`, `${g}/conversations/${seg(cid)}/threads/${seg(tid)}/posts/${seg(pid)}/attachments`);
                  for (const attachment of attachments) await storeAttachment(attachment, postKey, entry, count);
                });
              }
            });
          }
        });
      }
    });
  }

  async function storeAttachment(attachment, postKey, entry, count) {
    // The attachment id never goes into a path, so any id (or none) is stored.
    const aid = String(attachment?.id ?? '') || `no-id:${createHash('sha256').update(JSON.stringify(attachment ?? null)).digest('hex').slice(0, 16)}`;
    const key = `attachment:${postKey.slice('post:'.length)}/${aid}`;
    const type = attachment['@odata.type'] ?? null;
    const metadata = { kind: 'attachment', attachmentType: type, name: attachment.name ?? null, contentType: attachment.contentType ?? null, size: attachment.size ?? null };
    if (type === '#microsoft.graph.fileAttachment' && typeof attachment.contentBytes === 'string') {
      const { contentBytes, ...rest } = attachment;
      await put({ ...entry(`${key}/content`, attachment.lastModifiedDateTime, { ...metadata, kind: 'attachmentContent' }), bytes: Buffer.from(contentBytes, 'base64') });
      await putJson(entry(key, attachment.lastModifiedDateTime, metadata), rest);
      count('attachments');
      return;
    }
    await putJson(entry(key, attachment.lastModifiedDateTime, metadata), attachment);
    count('attachments');
    if (type === '#microsoft.graph.itemAttachment') {
      incomplete.push({ itemKey: key, missing: ['item'], reason: 'the attached item needs $expand, which this read-only package does not send' });
    } else if (type === '#microsoft.graph.fileAttachment') {
      incomplete.push({ itemKey: key, missing: ['contentBytes'], reason: 'Graph returned the file attachment without its bytes' });
    }
  }

  const statuses = groups.flatMap((group) => [group.planner.status, group.conversations.status]);
  let outcome;
  const anyRead = statuses.some((status) => status === 'observed' || status === 'partial');
  if (discovery.status !== 'observed') outcome = 'failed';
  // Every group failed (for example, no consent): the run read nothing, so it failed.
  else if ((statuses.length > 0 || unreachable.length > 0) && !anyRead) outcome = 'failed';
  else if (capped || unreachable.length > 0 || statuses.some((status) => status !== 'observed')) outcome = 'partial';
  else outcome = groups.length === 0 ? 'complete-empty' : 'complete';

  return {
    workloads: [PLANNER_WORKLOAD, CONVERSATIONS_WORKLOAD],
    tenantRef,
    observedFrom,
    observedTo: now().toISOString(),
    outcome,
    discovery,
    groups,
    outOfScope,
    unreachable,
    capped,
    stored,
    incomplete,
    requests,
  };
}
