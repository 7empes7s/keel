/**
 * Teams channel message restore through Microsoft's message import API.
 *
 * Messages come back into a new standard channel, "<name> (restored <date>)", in the
 * original team or another one. The live channel is never touched: putting it into import
 * mode would hide new messages from its members until the import ends.
 *
 * How the import API works (Microsoft Graph, app-only, `Teamwork.Migrate.All`):
 *  1. POST /teams/{team}/channels with "@microsoft.graph.channelCreationMode": "migration"
 *     and a createdDateTime in the past creates the channel in import mode.
 *  2. POST .../messages and .../messages/{id}/replies with the original createdDateTime
 *     and author (`from.user`, a user of the tenant) import each message.
 *  3. POST .../completeMigration ends import mode; the channel opens to its members.
 *     A run that resumes after that puts the channel back into import mode with
 *     POST .../startMigration first.
 *
 * Where the messages come from:
 *  - The content store, container `team:<teamId>/channel:<channelId>/messages`, one item
 *    per thread (the first message and its replies, schema keel.teams.channelThread/v1),
 *    taking the version held at the chosen point in time. Nothing writes that container
 *    yet: reading messages needs Microsoft's Teams export API (`ChannelMessage.Read.All`),
 *    a protected API Microsoft must approve first (docs/prerequisites.md).
 *  - On the test tenant only, a fixture file of the same threads (teamsMessageFixture), so
 *    the import can be proved live before that approval.
 *
 * What is kept and what is not (each one is counted in the report):
 *  - Kept: text and formatting, subject, importance, the original time and author, replies
 *    under their thread, inline images (sent again as hosted content), and links to files
 *    in SharePoint (reference attachments; the files are restored with the site).
 *  - An author who is no longer in the tenant (or an app) is replaced by the fallback
 *    author the request names, and the message starts with "Originally posted by <name>".
 *    Without a fallback author that message fails and the report says why.
 *  - @mentions are kept as bold text, not as live mentions.
 *  - Reactions, cards and other attachments are not imported.
 *  - Deleted messages and system messages (someone joined, a tab was added) are skipped.
 *
 * The run is journaled (./journal.mjs) before and after every write. A resumed run writes
 * nothing already imported. The import API cannot be read back without the export API, so
 * a message whose write was sent but not journaled is sent again and listed under
 * `possibleDuplicates`.
 */
import { canonicalDigest } from '../../restore/dryRunArtifact.mjs';
import { TEAMS_CONTENT_WORKLOAD } from '../teams.mjs';

export const THREAD_SCHEMA = 'keel.teams.channelThread/v1';
export const FIXTURE_SCHEMA = 'keel.teams.channelFixture/v1';
export const TEAMS_MESSAGES_WORKLOAD = 'teams-messages';
export const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
export const CHANNEL_NAME_MAX = 50;
// Microsoft allows about five import requests a second per channel.
export const WRITE_GAP_MS = 250;
const RETRY_STATUSES = new Set([429, 503, 504]);
const MAX_RETRIES = 5;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_RE = /^19:[A-Za-z0-9_.-]+@thread\.(?:tacv2|skype)$/;
const seg = (value) => encodeURIComponent(String(value));

export const messagesContainer = (teamId, channelId) => `team:${String(teamId).toLowerCase()}/channel:${channelId}/messages`;

/** The request a restore is planned, approved and run from. Throws on a malformed one. */
export function normalizeTeamsMessagesRequest({
  tenantRef, sourceTeamId, sourceChannelId, targetTeamId, at, fallbackAuthorId = null, fixture = null,
} = {}) {
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('a Teams message restore needs tenantRef');
  if (typeof sourceTeamId !== 'string' || !GUID_RE.test(sourceTeamId)) throw new TypeError('a Teams message restore needs the source team id (a GUID)');
  if (typeof sourceChannelId !== 'string' || !CHANNEL_RE.test(sourceChannelId)) throw new TypeError('a Teams message restore needs the source channel id (19:...@thread.tacv2)');
  const target = targetTeamId ?? sourceTeamId;
  if (typeof target !== 'string' || !GUID_RE.test(target)) throw new TypeError('the target team id must be a GUID');
  const point = new Date(at);
  if (at === undefined || at === null || !Number.isFinite(point.valueOf())) throw new TypeError('a Teams message restore needs a point in time (at)');
  if (fallbackAuthorId !== null && (typeof fallbackAuthorId !== 'string' || !GUID_RE.test(fallbackAuthorId))) {
    throw new TypeError('the fallback author must be a user id (a GUID)');
  }
  let picked = null;
  if (fixture !== null) {
    if (typeof fixture?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(fixture.sha256)) throw new TypeError('a fixture source needs its sha256');
    picked = { sha256: fixture.sha256 };
  }
  return {
    tenantRef,
    sourceTeamId: sourceTeamId.toLowerCase(),
    sourceChannelId,
    targetTeamId: target.toLowerCase(),
    at: point.toISOString(),
    fallbackAuthorId: fallbackAuthorId === null ? null : fallbackAuthorId.toLowerCase(),
    fixture: picked,
  };
}

/** The run id of a request: its digest, so the same request always resumes the same run. */
export function teamsMessagesRunId(request) {
  return `teams-messages:${canonicalDigest({ workload: TEAMS_MESSAGES_WORKLOAD, ...normalizeTeamsMessagesRequest(request) }).slice(0, 40)}`;
}

async function readBytes(store, ref) {
  const parts = [];
  for await (const chunk of await store.getItem(ref)) parts.push(chunk);
  return Buffer.concat(parts);
}
const readJson = async (store, ref) => JSON.parse((await readBytes(store, ref)).toString('utf8'));

/** itemKey -> the version held at `at`, leaving out items removed by then. */
async function versionsAt(store, { tenantRef, container, at }) {
  const point = new Date(at).valueOf();
  const latest = new Map();
  let after = null;
  for (;;) {
    const page = await store.listItems({ container, tenantRef, workload: TEAMS_CONTENT_WORKLOAD, limit: 1000, ...(after ? { after } : {}) });
    for (const row of page) {
      if (new Date(row.createdAt).valueOf() > point) continue;
      const held = latest.get(row.itemKey);
      if (!held || new Date(row.createdAt) >= new Date(held.createdAt)) latest.set(row.itemKey, row);
    }
    if (page.length < 1000) break;
    after = page[page.length - 1];
  }
  return [...latest.values()].filter((row) => !row.metadata?.removed);
}

/** The channel's name and description at `at`, from the team backup (team:<id>/team.json). */
async function channelFromTeamBackup(store, { tenantRef, teamId, channelId, at }) {
  const [team] = await versionsAt(store, { tenantRef, container: `team:${teamId}`, at });
  if (!team) return null;
  const document = await readJson(store, team.ref);
  const channel = document?.channels?.items?.find((item) => item.channelId === channelId);
  return channel ? { displayName: channel.fields?.displayName ?? null, description: channel.fields?.description ?? null } : null;
}

function checkThread(thread, where) {
  if (thread?.schema !== THREAD_SCHEMA) throw new Error(`${where} is not a ${THREAD_SCHEMA} thread`);
  if (typeof thread.message?.id !== 'string' || !thread.message.id) throw new Error(`${where} has no first message id`);
  if (!Number.isFinite(new Date(thread.message.createdDateTime).valueOf())) throw new Error(`${where} has no createdDateTime`);
}

/** Why a message is not imported, or null when it is. */
export function skipReason(message) {
  if (message?.deletedDateTime) return 'deleted before the backup';
  if (message?.messageType && message.messageType !== 'message') return 'a system message';
  return null;
}

const byTime = (a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime) || String(a.id).localeCompare(String(b.id));

/**
 * Plans a restore; reads the content store (or the fixture) only and writes nothing.
 * Returns { request, runId, channel, threads, skipped, messages }. `fixture` is the parsed
 * fixture document, required when the request names one.
 */
export async function planTeamsMessageRestore(store, rawRequest, { fixture = null } = {}) {
  const request = normalizeTeamsMessagesRequest(rawRequest);
  let documents;
  let channel;
  if (request.fixture) {
    if (!fixture) throw new Error('this restore reads a fixture file; pass the same --fixture file');
    if (canonicalDigest(fixture) !== request.fixture.sha256) throw new Error('the fixture file is not the one this restore was planned from');
    if (fixture.schema !== FIXTURE_SCHEMA || !Array.isArray(fixture.threads)) throw new Error(`the fixture file is not a ${FIXTURE_SCHEMA} document`);
    documents = fixture.threads.map((thread, i) => ({ sourceKey: `fixture:${thread?.message?.id ?? i}`, thread }));
    channel = { displayName: fixture.channel?.displayName ?? null, description: fixture.channel?.description ?? null };
  } else {
    const rows = await versionsAt(store, { tenantRef: request.tenantRef, container: messagesContainer(request.sourceTeamId, request.sourceChannelId), at: request.at });
    documents = [];
    for (const row of rows) documents.push({ sourceKey: row.ref, thread: await readJson(store, row.ref) });
    channel = await channelFromTeamBackup(store, { tenantRef: request.tenantRef, teamId: request.sourceTeamId, channelId: request.sourceChannelId, at: request.at });
  }
  const threads = [];
  const skipped = [];
  let messages = 0;
  for (const { sourceKey, thread } of documents) {
    checkThread(thread, sourceKey);
    const why = skipReason(thread.message);
    const replies = [...(thread.replies ?? [])].sort(byTime);
    if (why) {
      // A deleted first message takes its replies with it: Teams has nowhere to put them.
      skipped.push({ messageId: thread.message.id, reason: why, replies: replies.length });
      continue;
    }
    const kept = [];
    for (const reply of replies) {
      const reason = skipReason(reply);
      if (reason) skipped.push({ messageId: reply.id, parentId: thread.message.id, reason });
      else kept.push(reply);
    }
    threads.push({ sourceKey, message: thread.message, replies: kept });
    messages += 1 + kept.length;
  }
  threads.sort((a, b) => byTime(a.message, b.message));
  if (!threads.length && !skipped.length && !request.fixture) {
    throw new Error(`the backup holds no messages for channel ${request.sourceChannelId} at ${request.at}; Teams messages are backed up once Microsoft approves the Teams export API`);
  }
  return {
    request,
    runId: teamsMessagesRunId(request),
    channel: { displayName: channel?.displayName ?? 'Channel', description: channel?.description ?? null },
    threads,
    skipped,
    messages,
  };
}

/** "<name> (restored <date>)", cut to Teams' 50-character limit from the name's end. */
export function restoredChannelName(name, now) {
  const suffix = ` (restored ${new Date(now).toISOString().slice(0, 10)})`;
  const base = String(name ?? 'Channel').trim() || 'Channel';
  return `${base.slice(0, Math.max(1, CHANNEL_NAME_MAX - suffix.length)).trimEnd()}${suffix}`;
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The import payload for one message. `author` is { id, displayName, replaced, original }.
 * Returns { payload, notes } where notes count what could not be carried over.
 */
export function importPayload(message, { author, root }) {
  const notes = { mentionsAsText: 0, reactionsDropped: 0, attachmentsDropped: 0, inlineImages: 0 };
  const html = (message.body?.contentType ?? 'html').toLowerCase() !== 'text';
  let content = String(message.body?.content ?? '');

  // @mentions become bold text: the import keeps the words, not a live mention.
  if (html) {
    content = content.replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, (_, name) => { notes.mentionsAsText += 1; return `<strong>@${name}</strong>`; });
  }

  // Inline images are sent again as hosted content, under new temporary ids.
  const hostedContents = [];
  for (const hosted of message.hostedContents ?? []) {
    if (typeof hosted?.contentBytes !== 'string' || !hosted.contentBytes || typeof hosted.id !== 'string') continue;
    const temporaryId = String(hostedContents.length + 1);
    const pattern = new RegExp(`(src=")[^"]*/hostedContents/${hosted.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\$value(")`, 'g');
    if (!pattern.test(content)) continue;
    content = content.replace(pattern, `$1../hostedContents/${temporaryId}/$value$2`);
    hostedContents.push({ '@microsoft.graph.temporaryId': temporaryId, contentBytes: hosted.contentBytes, contentType: hosted.contentType ?? 'image/png' });
    notes.inlineImages += 1;
  }

  // Links to files in SharePoint are kept; cards and other attachments are not.
  const attachments = [];
  for (const attachment of message.attachments ?? []) {
    if (attachment?.contentType === 'reference' && typeof attachment.contentUrl === 'string' && /^https:\/\//.test(attachment.contentUrl)) {
      attachments.push({ id: String(attachment.id), contentType: 'reference', contentUrl: attachment.contentUrl, name: attachment.name ?? null });
    } else {
      notes.attachmentsDropped += 1;
      if (html && attachment?.id) content = content.replace(new RegExp(`<attachment\\s+id="${String(attachment.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*>\\s*</attachment>`, 'g'), '');
    }
  }
  notes.reactionsDropped = Array.isArray(message.reactions) ? message.reactions.length : 0;

  if (author.replaced) {
    const note = `Originally posted by ${author.original}`;
    content = html ? `<p><em>${escapeHtml(note)}</em></p>${content}` : `${note}\n\n${content}`;
  }
  if (notes.attachmentsDropped) {
    const note = `${notes.attachmentsDropped} attachment(s) could not be restored.`;
    content = html ? `${content}<p><em>${note}</em></p>` : `${content}\n\n${note}`;
  }

  const payload = {
    createdDateTime: new Date(message.createdDateTime).toISOString(),
    from: { user: { id: author.id, displayName: author.displayName ?? null, userIdentityType: 'aadUser' } },
    body: { contentType: html ? 'html' : 'text', content },
    ...(root && message.subject ? { subject: message.subject } : {}),
    ...(message.importance && message.importance !== 'normal' ? { importance: message.importance } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(hostedContents.length ? { hostedContents } : {}),
  };
  return { payload, notes };
}

const authorOf = (message) => {
  const user = message?.from?.user;
  if (user?.id) return { id: String(user.id).toLowerCase(), displayName: user.displayName ?? null };
  const app = message?.from?.application;
  return { id: null, displayName: app?.displayName ? `${app.displayName} (app)` : 'an unknown author' };
};

/**
 * Runs a planned restore into `target` ({ id, displayName }), the team the caller already
 * checked (gate, KEEL-RT- guard). Returns the report; the journal holds each outcome.
 */
export async function restoreTeamsMessages({
  transport, journal, plan, target, actor = null, approvedBy = null, now = () => new Date(),
  sleep = (ms) => new Promise((done) => { setTimeout(done, ms); }), gapMs = WRITE_GAP_MS, logger = null,
}) {
  const { request } = plan;
  if (typeof transport !== 'function') throw new TypeError('a Teams message restore needs a content write transport');
  if (target?.id !== request.targetTeamId) throw new Error('the checked target is not the team the plan restores to');
  if (plan.runId !== teamsMessagesRunId(request)) throw new Error('the plan does not match its run id');
  const team = `/teams/${seg(request.targetTeamId)}`;
  const run = await journal.openRun({
    id: plan.runId, tenantRef: request.tenantRef, workload: TEAMS_CONTENT_WORKLOAD, plan: request,
    label: restoredChannelName(plan.channel.displayName, now()), requestedBy: actor, approvedBy,
  });
  const channelName = run.label;
  const report = {
    runId: plan.runId, channel: { id: null, name: channelName }, restored: 0, alreadyDone: 0, skipped: plan.skipped.length,
    failed: 0, writes: 0, authorsReplaced: 0, possibleDuplicates: [],
    notes: { mentionsAsText: 0, reactionsDropped: 0, attachmentsDropped: 0, inlineImages: 0 }, errors: [],
  };

  let lastWrite = null;
  const send = async (method, path, body) => {
    if (path !== team && !path.startsWith(`${team}/`) && !(method === 'GET' && path.startsWith('/users/'))) {
      throw new Error(`refused a request outside the target team: ${method} ${path}`);
    }
    for (let attempt = 0; ; attempt++) {
      if (method !== 'GET') {
        const wait = lastWrite === null ? 0 : gapMs - (Date.now() - lastWrite);
        if (wait > 0) await sleep(wait);
        lastWrite = Date.now();
        report.writes++;
      }
      const res = await transport(`${GRAPH_ROOT}${path}`, { method, ...(body !== undefined ? { body } : {}) });
      if (!RETRY_STATUSES.has(res?.status) || attempt >= MAX_RETRIES) return res;
      await sleep(Math.min(Number(res.headers?.['retry-after']) || 2 ** attempt, 60) * 1000);
    }
  };
  const ok = (res) => res?.status >= 200 && res.status < 300;
  const why = (res, what) => `${what} failed: ${res?.status ?? 'no answer'} ${res?.body?.error?.code ?? ''} ${res?.body?.error?.message ?? ''}`.trim();

  // Authors: a user still in the tenant posts as themselves; anyone else as the fallback.
  const known = new Map();
  const userExists = async (id) => {
    if (!known.has(id)) {
      const res = await send('GET', `/users/${seg(id)}?$select=id,displayName`);
      if (ok(res)) known.set(id, { id, displayName: res.body?.displayName ?? null });
      else if (res?.status === 404) known.set(id, null);
      else throw new Error(why(res, `checking author ${id}`));
    }
    return known.get(id);
  };
  const resolveAuthor = async (message) => {
    const original = authorOf(message);
    const live = original.id ? await userExists(original.id) : null;
    if (live) return { id: live.id, displayName: original.displayName ?? live.displayName, replaced: false };
    if (!request.fallbackAuthorId) {
      throw new Error(`${original.displayName ?? original.id} is no longer in the tenant; name a fallback author to restore this message`);
    }
    const fallback = await userExists(request.fallbackAuthorId);
    if (!fallback) throw new Error(`the fallback author ${request.fallbackAuthorId} is not a user of the tenant`);
    return { id: fallback.id, displayName: fallback.displayName, replaced: true, original: original.displayName ?? original.id };
  };

  // The channel: created once in import mode, reused by every resume.
  const earliest = plan.threads[0]?.message.createdDateTime ?? now().toISOString();
  const findChannel = async () => {
    const filter = encodeURIComponent(`displayName eq '${channelName.replace(/'/g, "''")}'`);
    const res = await send('GET', `${team}/channels?$filter=${filter}&$select=id,displayName`);
    return ok(res) ? res.body?.value?.find((item) => item.displayName === channelName)?.id ?? null : null;
  };
  const ensureChannel = async () => {
    const held = await journal.entry(plan.runId, 'channel');
    if (held?.status === 'restored') return held.targetId;
    let id = held ? await findChannel() : null;
    if (!id) {
      await journal.mark(plan.runId, 'channel', { kind: 'teams-channel', status: 'pending' });
      const res = await send('POST', `${team}/channels`, {
        '@microsoft.graph.channelCreationMode': 'migration',
        displayName: channelName,
        ...(plan.channel.description ? { description: String(plan.channel.description).slice(0, 1024) } : {}),
        membershipType: 'standard',
        createdDateTime: new Date(earliest).toISOString(),
      });
      if (!ok(res) || typeof res.body?.id !== 'string') throw new Error(why(res, `creating channel ${channelName}`));
      id = res.body.id;
    }
    await journal.mark(plan.runId, 'channel', { kind: 'teams-channel', status: 'restored', targetId: id });
    await journal.mark(plan.runId, 'import-mode', { kind: 'teams-import-mode', status: 'pending', reason: 'open' });
    return id;
  };

  let channelId;
  try {
    channelId = await ensureChannel();
  } catch (error) {
    report.failed = plan.messages;
    report.errors.push({ channel: channelName, error: String(error?.message ?? error) });
    report.status = 'failed';
    await journal.finishRun(plan.runId, { status: report.status, report });
    return report;
  }
  report.channel.id = channelId;
  const base = `${team}/channels/${seg(channelId)}`;

  // A resumed run whose import was already completed reopens import mode first.
  const mode = await journal.entry(plan.runId, 'import-mode');
  const pendingWork = [];
  for (const thread of plan.threads) {
    for (const message of [thread.message, ...thread.replies]) pendingWork.push(`message:${thread.message.id}${message === thread.message ? '' : `/${message.id}`}`);
  }
  const doneKeys = new Set((await journal.entries(plan.runId)).filter((entry) => entry.status === 'restored').map((entry) => entry.sourceKey));
  if (mode?.status === 'restored' && pendingWork.some((key) => !doneKeys.has(key))) {
    const res = await send('POST', `${base}/startMigration`, { conversationCreationDateTime: new Date(earliest).toISOString() });
    if (!ok(res)) {
      report.errors.push({ channel: channelName, error: why(res, 'reopening import mode') });
      report.failed = pendingWork.filter((key) => !doneKeys.has(key)).length;
      report.alreadyDone = pendingWork.length - report.failed;
      report.status = report.alreadyDone ? 'partial' : 'failed';
      await journal.finishRun(plan.runId, { status: report.status, report });
      return report;
    }
    await journal.mark(plan.runId, 'import-mode', { kind: 'teams-import-mode', status: 'pending', reason: 'reopened' });
  }

  const addNotes = (notes) => { for (const key of Object.keys(report.notes)) report.notes[key] += notes[key]; };
  const importOne = async (key, message, path, root) => {
    const held = await journal.entry(plan.runId, key);
    if (held?.status === 'restored' || held?.status === 'skipped') { report.alreadyDone++; return held.targetId; }
    if (held?.status === 'pending') report.possibleDuplicates.push(message.id);
    const author = await resolveAuthor(message);
    const { payload, notes } = importPayload(message, { author, root });
    await journal.mark(plan.runId, key, { kind: root ? 'teams-message' : 'teams-reply', status: 'pending' });
    const res = await send('POST', path, payload);
    if (!ok(res) || typeof res.body?.id !== 'string') throw new Error(why(res, `importing message ${message.id}`));
    await journal.mark(plan.runId, key, { kind: root ? 'teams-message' : 'teams-reply', status: 'restored', targetId: res.body.id });
    report.restored++;
    if (author.replaced) report.authorsReplaced++;
    addNotes(notes);
    return res.body.id;
  };
  const fail = async (key, message, error, root) => {
    report.failed++;
    report.errors.push({ messageId: message.id, error: String(error?.message ?? error) });
    await journal.mark(plan.runId, key, { kind: root ? 'teams-message' : 'teams-reply', status: 'failed', reason: String(error?.message ?? error).slice(0, 500) }).catch(() => {});
  };

  for (const thread of plan.threads) {
    const rootKey = `message:${thread.message.id}`;
    let rootId = null;
    try {
      rootId = await importOne(rootKey, thread.message, `${base}/messages`, true);
    } catch (error) {
      await fail(rootKey, thread.message, error, true);
    }
    for (const reply of thread.replies) {
      const key = `${rootKey}/${reply.id}`;
      if (!rootId) { await fail(key, reply, new Error('its first message was not restored'), false); continue; }
      try {
        await importOne(key, reply, `${base}/messages/${seg(rootId)}/replies`, false);
      } catch (error) {
        await fail(key, reply, error, false);
      }
    }
  }

  // Always end import mode, so the channel never stays hidden from its members.
  const completed = await send('POST', `${base}/completeMigration`, {});
  if (ok(completed)) {
    await journal.mark(plan.runId, 'import-mode', { kind: 'teams-import-mode', status: 'restored', reason: 'completed' });
  } else {
    report.errors.push({ channel: channelName, error: why(completed, 'completing the import') });
  }
  const clean = report.failed === 0 && ok(completed);
  report.status = clean ? 'completed' : report.restored + report.alreadyDone > 0 ? 'partial' : 'failed';
  await journal.finishRun(plan.runId, { status: report.status, report });
  logger?.log?.(`teams message restore ${plan.runId}: ${report.status}, ${report.restored} imported, ${report.alreadyDone} already done, ${report.skipped} skipped, ${report.failed} failed`);
  return report;
}

/**
 * A small fixture channel for the live proof on the test tenant: three threads with
 * replies, an inline image, a mention, a reaction, a card, a deleted message and a
 * system message, all dated in the past relative to `now`. `authors` are two KEEL-RT-
 * users; one more author is an id no tenant holds, so the fallback author is exercised.
 */
export function teamsMessageFixture({ authors, now = new Date(), channelName = 'KEEL-RT-import-proof' }) {
  if (!Array.isArray(authors) || authors.length < 2 || authors.some((id) => !GUID_RE.test(String(id)))) {
    throw new TypeError('a message fixture needs two author user ids');
  }
  const [a, b] = authors.map((id) => ({ id: String(id).toLowerCase(), displayName: null, userIdentityType: 'aadUser' }));
  const gone = { id: '00000000-0000-4000-8000-00000000dead', displayName: 'KEEL-RT-left-the-company', userIdentityType: 'aadUser' };
  const day = 24 * 60 * 60 * 1000;
  const start = new Date(new Date(now).valueOf() - 10 * day);
  start.setUTCHours(9, 0, 0, 0);
  const at = (days, minutes = 0) => new Date(start.valueOf() + days * day + minutes * 60 * 1000).toISOString();
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const message = (id, created, from, content, extra = {}) => ({
    id, createdDateTime: created, lastModifiedDateTime: created, deletedDateTime: null, messageType: 'message',
    importance: 'normal', subject: null, from: { user: from, application: null }, body: { contentType: 'html', content },
    attachments: [], mentions: [], reactions: [], hostedContents: [], ...extra,
  });
  const thread = (root, replies) => ({ schema: THREAD_SCHEMA, message: root, replies });
  return {
    schema: FIXTURE_SCHEMA,
    channel: { displayName: channelName, description: 'KEEL-RT- fixture messages for the Teams message import proof' },
    threads: [
      thread(message('1001', at(0), a, '<p>KEEL-RT- first message, with <b>bold</b> text.</p>', { subject: 'KEEL-RT- import proof' }), [
        message('1002', at(0, 5), b, '<p>A reply to <at id="0">KEEL-RT- author</at>.</p>', {
          mentions: [{ id: 0, mentionText: 'KEEL-RT- author', mentioned: { user: a } }],
          reactions: [{ reactionType: 'like', createdDateTime: at(0, 6), user: { user: a } }],
        }),
        message('1003', at(0, 10), gone, '<p>A reply from someone who left the tenant.</p>'),
      ]),
      thread(message('2001', at(1), b, '<p>An inline image:</p><p><img src="https://graph.microsoft.com/v1.0/teams/x/channels/y/messages/2001/hostedContents/aW1n/$value" alt="pixel"></p>', {
        importance: 'high',
        hostedContents: [{ id: 'aW1n', contentType: 'image/png', contentBytes: pixel }],
      }), [
        message('2002', at(1, 3), a, '<p>A reply that was deleted.</p>', { deletedDateTime: at(1, 4) }),
      ]),
      thread(message('3001', at(2), a, '<p>A message with a card.</p><attachment id="card-1"></attachment>', {
        attachments: [{ id: 'card-1', contentType: 'application/vnd.microsoft.card.adaptive', content: '{}' }],
      }), []),
      thread(message('4001', at(3), a, '<systemEventMessage/>', { messageType: 'systemEventMessage' }), []),
    ],
  };
}
