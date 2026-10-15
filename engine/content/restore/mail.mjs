/**
 * Wave 2 MAILR: mail restore. Restores an item, a folder or a whole mailbox (mail,
 * calendars, contacts and To Do) as it was at a chosen point in time, from the content
 * store into the original mailbox or another one.
 *
 * Planning reads the content store only (engine/content/store.mjs, containers written by
 * engine/content/exchangeMail.mjs and exchangeItems.mjs). For each item it takes the
 * latest version stored at or before the point in time; an item whose version then is a
 * tombstone did not exist at that point and is left out.
 *
 * Restoring writes through a Graph content write transport:
 *   transport(url, { method, body, headers }) -> { status, headers, body }
 * Every write is a create (POST). Nothing in the target mailbox is updated or deleted, so
 * a newer item can never be overwritten:
 *  - into 'restored-folder' (the default), everything goes under new containers named
 *    "Restored <date>": a mail folder tree, a contact folder tree, and one calendar and
 *    one To Do list per source calendar or list (those two cannot nest).
 *  - into 'original' (same mailbox only), items go back to their original folder when it
 *    still exists. An item that still exists there is left as it is: unchanged when its
 *    changeKey matches the backup, newer otherwise. A folder that is gone is recreated
 *    under "Restored <date>".
 *
 * The run is journaled (./journal.mjs) before and after every write, so an interrupted run
 * resumes where it stopped and a second run of the same plan writes nothing. A message
 * whose write was sent but not journaled is looked up by its internetMessageId first.
 *
 * Fidelity notes:
 *  - Messages are rebuilt from their stored MIME as received messages, not drafts, with
 *    their original received and sent times (./mime.mjs, #293). A backed-up draft, a
 *    signed or encrypted message, and one too large for a Graph create payload are
 *    created from the MIME as is, which Exchange stores as a draft; the report lists them.
 *    A message stored without MIME (bigger than the backup limit) is reported as not
 *    restorable.
 *  - Events are recreated without attendees, so no meeting invitation is sent; the
 *    original attendees are listed in the event body.
 *  - Group and archive mailboxes are not restored here.
 */
import { MAIL_WORKLOAD, seg } from '../exchangeMail.mjs';
import { canonicalDigest } from '../../restore/dryRunArtifact.mjs';
import { receivedMessageFromMime } from './mime.mjs';

export const MAIL_RESTORE_KINDS = Object.freeze(['mail', 'calendar', 'contacts', 'todo']);
export const RESTORE_INTO = Object.freeze(['restored-folder', 'original']);
export const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const ROOT = '#root';
const RETRY_STATUSES = new Set([429, 503, 504]);
const MAX_RETRIES = 4;

const EVENT_FIELDS = [
  'subject', 'body', 'start', 'end', 'location', 'locations', 'isAllDay', 'recurrence', 'showAs', 'sensitivity',
  'importance', 'categories', 'isReminderOn', 'reminderMinutesBeforeStart', 'allowNewTimeProposals',
];
const CONTACT_FIELDS = [
  'givenName', 'surname', 'middleName', 'nickName', 'displayName', 'initials', 'title', 'generation', 'fileAs',
  'jobTitle', 'companyName', 'department', 'officeLocation', 'profession', 'manager', 'assistantName', 'spouseName',
  'children', 'birthday', 'personalNotes', 'categories', 'emailAddresses', 'imAddresses', 'businessPhones',
  'homePhones', 'mobilePhone', 'businessHomePage', 'businessAddress', 'homeAddress', 'otherAddress',
  'yomiGivenName', 'yomiSurname', 'yomiCompanyName',
];
const TASK_FIELDS = [
  'title', 'body', 'importance', 'status', 'categories', 'dueDateTime', 'startDateTime', 'reminderDateTime',
  'isReminderOn', 'recurrence', 'completedDateTime',
];

const pick = (body, keys) => Object.fromEntries(keys.filter((key) => body?.[key] !== undefined && body[key] !== null).map((key) => [key, body[key]]));

/** The request a restore is planned, approved and run from. Throws on a malformed one. */
export function normalizeMailRestoreRequest({ tenantRef, sourceMailboxId, targetMailboxId, at, into = 'restored-folder', kinds = MAIL_RESTORE_KINDS, selection = null } = {}) {
  for (const [name, value] of Object.entries({ tenantRef, sourceMailboxId })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`a mail restore needs ${name}`);
  }
  const point = new Date(at);
  if (at === undefined || at === null || !Number.isFinite(point.valueOf())) throw new TypeError('a mail restore needs a point in time (at)');
  if (!RESTORE_INTO.includes(into)) throw new TypeError(`into must be one of ${RESTORE_INTO.join(', ')}`);
  const target = targetMailboxId ?? sourceMailboxId;
  if (into === 'original' && target !== sourceMailboxId) throw new TypeError('a restore into the original folders must target the source mailbox');
  const wanted = [...new Set(kinds)];
  if (!wanted.length || wanted.some((kind) => !MAIL_RESTORE_KINDS.includes(kind))) {
    throw new TypeError(`kinds must be some of ${MAIL_RESTORE_KINDS.join(', ')}`);
  }
  let picked = null;
  if (selection) {
    const { kind, folderId, itemKey = null } = selection;
    if (!MAIL_RESTORE_KINDS.includes(kind)) throw new TypeError('selection.kind must be mail, calendar, contacts or todo');
    if (typeof folderId !== 'string' || !folderId) throw new TypeError('a selection needs the folderId (use "default" for the default contacts)');
    if (itemKey !== null && (typeof itemKey !== 'string' || !itemKey)) throw new TypeError('selection.itemKey must be an item id');
    picked = { kind, folderId, itemKey };
  }
  return {
    tenantRef, sourceMailboxId, targetMailboxId: target, at: point.toISOString(), into,
    kinds: picked ? [picked.kind] : MAIL_RESTORE_KINDS.filter((kind) => wanted.includes(kind)), selection: picked,
  };
}

/** The run id of a request: its digest, so the same request always resumes the same run. */
export function mailRestoreRunId(request) {
  return `mail:${canonicalDigest({ workload: MAIL_WORKLOAD, ...normalizeMailRestoreRequest(request) }).slice(0, 40)}`;
}

/** Every stored version in one container, oldest first. */
async function listVersions(store, { tenantRef, container }) {
  const rows = [];
  let after = null;
  for (;;) {
    const page = await store.listItems({ container, tenantRef, workload: MAIL_WORKLOAD, limit: 1000, ...(after ? { after } : {}) });
    rows.push(...page);
    if (page.length < 1000) return rows;
    after = page[page.length - 1];
  }
}

/** itemKey -> the version held at `at`, leaving out items that were removed by then. */
async function versionsAt(store, { tenantRef, container, at }) {
  const point = new Date(at).valueOf();
  const latest = new Map();
  for (const row of await listVersions(store, { tenantRef, container })) {
    if (new Date(row.createdAt).valueOf() > point) continue;
    const held = latest.get(row.itemKey);
    if (!held || new Date(row.createdAt) >= new Date(held.createdAt)) latest.set(row.itemKey, row);
  }
  return new Map([...latest].filter(([, row]) => !row.metadata?.removed).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

async function readBytes(store, ref) {
  const parts = [];
  for await (const chunk of await store.getItem(ref)) parts.push(chunk);
  return Buffer.concat(parts);
}

const readJson = async (store, ref) => JSON.parse((await readBytes(store, ref)).toString('utf8'));

/** The containers of one kind, as { key, kind, sourceId, name, parentKey, itemsContainer, defaultFolder? }. */
async function containersOf(store, { tenantRef, mailboxKey, kind, at }) {
  const found = [];
  const add = async (container, toEntry) => {
    for (const [itemKey, row] of await versionsAt(store, { tenantRef, container, at })) {
      found.push(toEntry(itemKey, await readJson(store, row.ref)));
    }
  };
  if (kind === 'mail') {
    await add(`${mailboxKey}/mail-folders`, (id, folder) => ({
      key: `mail:${id}`, kind, sourceId: id, name: folder.displayName ?? id, parentSourceId: folder.parentFolderId ?? null,
      itemsContainer: `${mailboxKey}/mail/${id}`,
    }));
  } else if (kind === 'calendar') {
    await add(`${mailboxKey}/calendars`, (id, calendar) => ({
      key: `calendar:${id}`, kind, sourceId: id, name: calendar.name ?? id, parentSourceId: null, itemsContainer: `${mailboxKey}/calendar/${id}`,
    }));
  } else if (kind === 'contacts') {
    found.push({ key: 'contacts:default', kind, sourceId: 'default', name: 'Contacts', parentSourceId: null, itemsContainer: `${mailboxKey}/contacts/default`, defaultFolder: true });
    const visit = async (container, depth) => {
      const before = found.length;
      await add(container, (id, folder) => ({
        key: `contacts:${id}`, kind, sourceId: id, name: folder.displayName ?? id, parentSourceId: folder.parentFolderId ?? null,
        itemsContainer: `${mailboxKey}/contacts/${id}`,
      }));
      if (depth >= 10) return;
      for (const entry of found.slice(before)) await visit(`${mailboxKey}/contact-folders/${entry.sourceId}`, depth + 1);
    };
    await visit(`${mailboxKey}/contact-folders`, 1);
  } else {
    await add(`${mailboxKey}/todo-lists`, (id, list) => ({
      key: `todo:${id}`, kind, sourceId: id, name: list.displayName ?? id, parentSourceId: null, itemsContainer: `${mailboxKey}/todo/${id}`,
    }));
  }
  const byId = new Map(found.map((entry) => [entry.sourceId, entry]));
  for (const entry of found) entry.parentKey = byId.get(entry.parentSourceId)?.key ?? null;
  return found;
}

function descendants(containers, rootKey) {
  const keep = new Set([rootKey]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of containers) {
      if (!keep.has(entry.key) && keep.has(entry.parentKey)) { keep.add(entry.key); grew = true; }
    }
  }
  return keep;
}

function notRestorable(kind, row) {
  const missing = row.metadata?.incomplete?.missing ?? [];
  if (kind === 'mail' && (row.metadata?.contentType !== 'message/rfc822' || missing.includes('mime'))) {
    return 'the backup holds this message without its MIME content';
  }
  return null;
}

/**
 * Plans a restore from the content store; reads nothing from Graph and writes nothing.
 * Returns { request, runId, containers, items, skipped }.
 */
export async function planMailRestore(store, rawRequest) {
  const request = normalizeMailRestoreRequest(rawRequest);
  const mailboxKey = `mailbox/${request.sourceMailboxId}`;
  const containers = [];
  const items = [];
  const skipped = [];
  for (const kind of request.kinds) {
    let found = await containersOf(store, { tenantRef: request.tenantRef, mailboxKey, kind, at: request.at });
    if (request.selection) {
      const rootKey = `${kind}:${request.selection.folderId}`;
      if (!found.some((entry) => entry.key === rootKey)) {
        throw new Error(`the backup of ${mailboxKey} holds no ${kind} folder ${request.selection.folderId} at ${request.at}`);
      }
      const keep = request.selection.itemKey ? new Set([rootKey]) : descendants(found, rootKey);
      found = found.filter((entry) => keep.has(entry.key));
      for (const entry of found) if (!keep.has(entry.parentKey)) entry.parentKey = null;
    }
    for (const entry of found) {
      const held = await versionsAt(store, { tenantRef: request.tenantRef, container: entry.itemsContainer, at: request.at });
      let rows = [...held.values()];
      if (request.selection?.itemKey) {
        rows = rows.filter((row) => row.itemKey === request.selection.itemKey);
        if (!rows.length) throw new Error(`the backup holds no item ${request.selection.itemKey} in that folder at ${request.at}`);
      }
      if (kind === 'contacts' && entry.defaultFolder && !rows.length && !request.selection) continue;
      containers.push(entry);
      for (const row of rows) {
        const why = notRestorable(kind, row);
        if (why) { skipped.push({ kind, container: entry.key, itemKey: row.itemKey, reason: why }); continue; }
        items.push({
          kind, containerKey: entry.key, itemKey: row.itemKey, ref: row.ref, version: row.version, sha256: row.sha256,
          internetMessageId: row.metadata?.internetMessageId ?? null, incomplete: row.metadata?.incomplete ?? null,
          ...(kind === 'mail' ? { receivedDateTime: row.metadata?.receivedDateTime ?? null, isDraft: row.metadata?.isDraft === true } : {}),
        });
      }
    }
  }
  // A container whose items and children are all empty still restores (an empty folder).
  return { request, runId: mailRestoreRunId(request), containers, items, skipped };
}

/** The default label for the containers a run creates. */
export const restoredLabel = (now) => `Restored ${new Date(now).toISOString().slice(0, 10)}`;

function eventPayload(event) {
  const payload = { ...pick(event, EVENT_FIELDS), responseRequested: false, isOnlineMeeting: false };
  const attendees = (event.attendees ?? [])
    .map((attendee) => attendee?.emailAddress?.address ?? attendee?.emailAddress?.name)
    .filter(Boolean);
  if (attendees.length) {
    const note = `Restored by Keel. Original attendees (not invited again): ${attendees.join('; ')}`;
    const body = payload.body ?? { contentType: 'text', content: '' };
    payload.body = body.contentType === 'html'
      ? { contentType: 'html', content: `${body.content ?? ''}<p>${note.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>` }
      : { contentType: 'text', content: `${body.content ? `${body.content}\n\n` : ''}${note}` };
  }
  return payload;
}

const quoteOdata = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Runs a planned restore. `target` is { id, names } (names are the mailbox's display name,
 * address and sign-in name, for the report). The caller has already checked the gate and
 * the target guard. Returns the report; the journal holds the same outcome per entry.
 */
export async function restoreMail({ store, transport, journal, plan, target, actor = null, approvedBy = null, now = () => new Date(), sleep = (ms) => new Promise((done) => { setTimeout(done, ms); }), logger = null }) {
  const { request } = plan;
  if (typeof transport !== 'function') throw new TypeError('a mail restore needs a content write transport');
  if (target?.id !== request.targetMailboxId) throw new Error('the checked target is not the mailbox the plan restores to');
  if (plan.runId !== mailRestoreRunId(request)) throw new Error('the plan does not match its run id');
  const owner = `/users/${seg(target.id)}`;
  const run = await journal.openRun({
    id: plan.runId, tenantRef: request.tenantRef, workload: MAIL_WORKLOAD, plan: request, label: restoredLabel(now()),
    requestedBy: actor, approvedBy,
  });
  const label = run.label;
  const report = { runId: plan.runId, label, restored: 0, kept: { unchanged: 0, newer: 0 }, alreadyDone: 0, notRestorable: plan.skipped.length, failed: 0, writes: 0, incomplete: [], errors: [] };

  const send = async (method, path, { body, headers } = {}) => {
    if (!path.startsWith(`${owner}/`)) throw new Error(`refused a request outside the target mailbox: ${path}`);
    for (let attempt = 0; ; attempt++) {
      if (method !== 'GET') report.writes++;
      const res = await transport(`${GRAPH_ROOT}${path}`, { method, ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) });
      if (!RETRY_STATUSES.has(res?.status) || attempt >= MAX_RETRIES) return res;
      const wait = Math.min(Number(res.headers?.['retry-after']) || 2 ** attempt, 60);
      await sleep(wait * 1000);
    }
  };
  const created = (res, what) => {
    if (res?.status >= 200 && res.status < 300 && typeof res.body?.id === 'string') return res.body.id;
    throw new Error(`${what} failed: ${res?.status ?? 'no answer'} ${res?.body?.error?.code ?? ''} ${res?.body?.error?.message ?? ''}`.trim());
  };
  const exists = async (path) => {
    const res = await send('GET', path);
    if (res?.status === 404) return null;
    if (res?.status >= 200 && res.status < 300) return res.body ?? {};
    throw new Error(`reading ${path} failed: ${res?.status ?? 'no answer'}`);
  };

  // Containers are created on first use; a journaled one is reused, never created twice.
  const byKey = new Map(plan.containers.map((entry) => [entry.key, entry]));
  const ready = new Map();
  const createContainer = async (kind, name, parentTarget) => {
    if (kind === 'mail') return created(await send('POST', parentTarget ? `${owner}/mailFolders/${seg(parentTarget)}/childFolders` : `${owner}/mailFolders`, { body: { displayName: name } }), `creating mail folder ${name}`);
    if (kind === 'contacts') return created(await send('POST', parentTarget ? `${owner}/contactFolders/${seg(parentTarget)}/childFolders` : `${owner}/contactFolders`, { body: { displayName: name } }), `creating contact folder ${name}`);
    if (kind === 'calendar') return created(await send('POST', `${owner}/calendars`, { body: { name } }), `creating calendar ${name}`);
    return created(await send('POST', `${owner}/todo/lists`, { body: { displayName: name } }), `creating To Do list ${name}`);
  };
  const originalPath = (entry) => ({
    mail: `${owner}/mailFolders/${seg(entry.sourceId)}?$select=id`,
    calendar: `${owner}/calendars/${seg(entry.sourceId)}?$select=id`,
    contacts: `${owner}/contactFolders/${seg(entry.sourceId)}?$select=id`,
    todo: `${owner}/todo/lists/${seg(entry.sourceId)}`,
  }[entry.kind]);

  const ensure = async (key) => {
    if (ready.has(key)) return ready.get(key);
    const journaled = await journal.entry(plan.runId, `container:${key}`);
    if (journaled?.status === 'restored') { ready.set(key, journaled.targetId); return journaled.targetId; }
    const kind = key.split(':')[0];
    let targetId;
    if (key.endsWith(`:${ROOT}`)) {
      targetId = await createContainer(kind, label, null);
    } else {
      const entry = byKey.get(key);
      if (request.into === 'original' && entry.defaultFolder) targetId = 'default';
      else if (request.into === 'original' && await exists(originalPath(entry))) targetId = entry.sourceId;
      else if (kind === 'calendar' || kind === 'todo') targetId = await createContainer(kind, `${label} - ${entry.name}`, null);
      else if (entry.defaultFolder) targetId = await ensure(`${kind}:${ROOT}`);
      else targetId = await createContainer(kind, entry.name, await ensure(entry.parentKey ?? `${kind}:${ROOT}`));
    }
    await journal.mark(plan.runId, `container:${key}`, { kind: `${kind}-container`, status: 'restored', targetId });
    ready.set(key, targetId);
    return targetId;
  };

  const livePath = (item, containerTarget) => ({
    mail: `${owner}/messages/${seg(item.itemKey)}?$select=id,changeKey`,
    calendar: `${owner}/events/${seg(item.itemKey)}?$select=id,changeKey`,
    contacts: `${owner}/contacts/${seg(item.itemKey)}?$select=id,changeKey`,
    todo: `${owner}/todo/lists/${seg(containerTarget)}/tasks/${seg(item.itemKey)}`,
  }[item.kind]);

  const write = async (item, containerTarget) => {
    if (item.kind === 'mail') {
      const mime = await readBytes(store, item.ref);
      const path = `${owner}/mailFolders/${seg(containerTarget)}/messages`;
      const rebuilt = item.isDraft ? null : receivedMessageFromMime(mime, { receivedDateTime: item.receivedDateTime, internetMessageId: item.internetMessageId });
      if (rebuilt?.payload) return created(await send('POST', path, { body: rebuilt.payload }), 'creating the message');
      const id = created(await send('POST', path, { body: mime.toString('base64'), headers: { 'content-type': 'text/plain' } }), 'creating the message');
      if (rebuilt?.keepMime) report.incomplete.push({ kind: item.kind, itemKey: item.itemKey, missing: ['received-state'], reason: `restored as a draft: ${rebuilt.keepMime}` });
      return id;
    }
    const json = await readJson(store, item.ref);
    if (item.kind === 'calendar') return created(await send('POST', `${owner}/calendars/${seg(containerTarget)}/events`, { body: eventPayload(json) }), 'creating the event');
    if (item.kind === 'contacts') {
      const path = containerTarget === 'default' ? `${owner}/contacts` : `${owner}/contactFolders/${seg(containerTarget)}/contacts`;
      return created(await send('POST', path, { body: pick(json, CONTACT_FIELDS) }), 'creating the contact');
    }
    return created(await send('POST', `${owner}/todo/lists/${seg(containerTarget)}/tasks`, { body: pick(json, TASK_FIELDS) }), 'creating the task');
  };

  // A message sent before an interrupted or failed attempt could journal it is found by its internet id.
  const findSent = async (item, containerTarget) => {
    if (item.kind !== 'mail' || !item.internetMessageId) return null;
    const filter = encodeURIComponent(`internetMessageId eq ${quoteOdata(item.internetMessageId)}`);
    const res = await send('GET', `${owner}/mailFolders/${seg(containerTarget)}/messages?$filter=${filter}&$select=id`);
    if (res?.status >= 200 && res.status < 300) return res.body?.value?.[0]?.id ?? null;
    return null;
  };

  // Empty folders in the plan are recreated too, in plan order (parents first).
  for (const entry of plan.containers) {
    try { await ensure(entry.key); } catch (error) {
      report.failed++;
      report.errors.push({ container: entry.key, error: String(error?.message ?? error) });
    }
  }

  for (const item of plan.items) {
    const sourceKey = item.ref;
    try {
      const held = await journal.entry(plan.runId, sourceKey);
      if (held?.status === 'restored' || held?.status === 'skipped') { report.alreadyDone++; continue; }
      const containerTarget = await ensure(item.containerKey);
      if (request.into === 'original') {
        const live = await exists(livePath(item, containerTarget));
        if (live) {
          const liveVersion = item.kind === 'todo' ? live['@odata.etag'] : live.changeKey;
          const unchanged = liveVersion !== undefined && liveVersion === item.version;
          await journal.mark(plan.runId, sourceKey, { kind: item.kind, status: 'skipped', targetId: item.itemKey, reason: unchanged ? 'unchanged' : 'newer live item kept' });
          report.kept[unchanged ? 'unchanged' : 'newer']++;
          continue;
        }
      }
      let targetId = held?.status === 'pending' || held?.status === 'failed' ? await findSent(item, containerTarget) : null;
      if (!targetId) {
        await journal.mark(plan.runId, sourceKey, { kind: item.kind, status: 'pending' });
        targetId = await write(item, containerTarget);
      }
      await journal.mark(plan.runId, sourceKey, { kind: item.kind, status: 'restored', targetId });
      report.restored++;
      if (item.incomplete) report.incomplete.push({ kind: item.kind, itemKey: item.itemKey, missing: item.incomplete.missing ?? [] });
    } catch (error) {
      report.failed++;
      report.errors.push({ itemKey: item.itemKey, kind: item.kind, error: String(error?.message ?? error) });
      await journal.mark(plan.runId, sourceKey, { kind: item.kind, status: 'failed', reason: String(error?.message ?? error).slice(0, 500) }).catch(() => {});
    }
  }
  report.status = report.failed === 0 ? 'completed' : report.restored + report.alreadyDone > 0 ? 'partial' : 'failed';
  await journal.finishRun(plan.runId, { status: report.status, report });
  logger?.log?.(`mail restore ${plan.runId}: ${report.status}, ${report.restored} restored, ${report.alreadyDone} already done, ${report.kept.unchanged + report.kept.newer} live items kept, ${report.failed} failed`);
  return report;
}
