/**
 * Wave 1 MAIL: calendars, contacts and tasks of one mailbox, and a Group mailbox's
 * calendar.
 *
 *  - Tasks (Microsoft To Do lists and tasks) sync through Graph delta, like mail.
 *  - Calendars and contacts have no folder-wide delta in Graph v1.0 (calendarView delta
 *    needs a fixed window and expands occurrences). They are listed in full, and only an
 *    item whose changeKey moved is stored again. An item missing from a complete listing
 *    gets a tombstone; its earlier versions stay in the store. A listing that fails part
 *    way removes nothing.
 *  - Nothing readable is skipped. What these routes do not return is flagged incomplete
 *    on the item: attachments of events and tasks (separate routes) and the changed or
 *    cancelled occurrences of a recurring series (they need a dated instances window).
 *  - Group conversations belong to the PLANNER package; this module reads a Group
 *    mailbox's calendar only.
 *  - Read-only, as exchangeMail.mjs: GET routes only.
 */
import { MAIL_WORKLOAD, describe, putJson, putTombstone, readOnlyReader, seg, walkDelta } from './exchangeMail.mjs';

export const ITEMS_WORKLOAD = MAIL_WORKLOAD;
const MAX_FOLDER_DEPTH = 10;

/** Every page of a list route, or the error that stopped it. */
export async function listAll(reader, version, path) {
  const items = [];
  let next = path;
  while (next) {
    const res = await reader.get(version, next);
    if (!res?.ok) return { ok: false, items, error: describe(res) };
    if (Array.isArray(res.body?.value)) items.push(...res.body.value);
    next = res.body?.['@odata.nextLink'] ?? null;
  }
  return { ok: true, items, error: null };
}

function eventIncomplete(event) {
  const missing = [];
  if (event.hasAttachments) missing.push('attachments');
  if (event.type === 'seriesMaster') missing.push('occurrenceExceptions');
  if (!missing.length) return null;
  return { missing, reason: 'binary-route', detail: 'attachments and changed occurrences are on separate routes not read in this pass' };
}

function taskIncomplete(task) {
  return task.hasAttachments ? { missing: ['attachments'], reason: 'binary-route', detail: 'task attachments are on a separate route not read in this pass' } : null;
}

function counts() {
  return { stored: 0, unchanged: 0, removed: 0, incomplete: 0 };
}

/**
 * Stores what changed in one fully listed container. `previous` maps itemKey to the
 * version stored last time. Returns the new map, or the old one when the listing failed.
 */
async function syncListed(reader, store, { base, container, version, path, kind, incomplete, previous = {}, now, report }) {
  const listed = await listAll(reader, version, path);
  if (!listed.ok) {
    report.errors.push({ container, error: listed.error });
    return { versions: previous, items: listed.items, ok: false };
  }
  const versions = {};
  for (const item of listed.items) {
    const itemVersion = item.changeKey ?? item.lastModifiedDateTime ?? null;
    if (itemVersion !== null && previous[item.id] === itemVersion) {
      versions[item.id] = itemVersion;
      report.counts.unchanged++;
      continue;
    }
    const flag = incomplete?.(item) ?? null;
    try {
      await putJson(store, { ...base, container, itemKey: item.id }, item, {
        version: itemVersion ?? `seen@${now()}`,
        metadata: { kind, ...(flag ? { incomplete: flag } : {}) },
      });
      versions[item.id] = itemVersion ?? `seen@${now()}`;
      report.counts.stored++;
      if (flag) report.counts.incomplete++;
    } catch (error) {
      // Not recorded as stored, so the next run tries it again.
      report.errors.push({ container, itemKey: item.id, error: String(error?.message ?? error) });
    }
  }
  for (const itemKey of Object.keys(previous)) {
    if (itemKey in versions) continue;
    try {
      await putTombstone(store, { ...base, container, itemKey }, { at: now() });
      report.counts.removed++;
    } catch (error) {
      versions[itemKey] = previous[itemKey];
      report.errors.push({ container, itemKey, error: String(error?.message ?? error) });
    }
  }
  return { versions, items: listed.items, ok: true };
}

/** Calendars of a user, shared or Group mailbox, then each calendar's events. */
async function syncCalendars(reader, store, { base, mailbox, owner, state, now, report }) {
  const next = {};
  if (mailbox.kind === 'group') {
    // A Group mailbox has one calendar.
    const container = `${mailbox.key}/calendar/group`;
    next[container] = (await syncListed(reader, store, {
      base, container, version: 'v1.0', path: `${owner}/events`, kind: 'event', incomplete: eventIncomplete, previous: state[container], now, report,
    })).versions;
    return next;
  }
  const calendarsContainer = `${mailbox.key}/calendars`;
  const calendars = await syncListed(reader, store, {
    base, container: calendarsContainer, version: 'v1.0', path: `${owner}/calendars`, kind: 'calendar', previous: state[calendarsContainer], now, report,
  });
  next[calendarsContainer] = calendars.versions;
  const ids = calendars.ok ? calendars.items.map((calendar) => calendar.id) : Object.keys(calendars.versions);
  for (const id of ids) {
    const container = `${mailbox.key}/calendar/${id}`;
    next[container] = (await syncListed(reader, store, {
      base, container, version: 'v1.0', path: `${owner}/calendars/${seg(id)}/events`, kind: 'event', incomplete: eventIncomplete, previous: state[container], now, report,
    })).versions;
  }
  return next;
}

/** The default contacts folder, then every contact folder and its child folders. */
async function syncContacts(reader, store, { base, mailbox, owner, state, now, report }) {
  const next = {};
  const defaultContainer = `${mailbox.key}/contacts/default`;
  next[defaultContainer] = (await syncListed(reader, store, {
    base, container: defaultContainer, version: 'v1.0', path: `${owner}/contacts`, kind: 'contact', previous: state[defaultContainer], now, report,
  })).versions;

  const visit = async (foldersPath, foldersContainer, depth) => {
    const folders = await syncListed(reader, store, {
      base, container: foldersContainer, version: 'v1.0', path: foldersPath, kind: 'contactFolder', previous: state[foldersContainer], now, report,
    });
    next[foldersContainer] = folders.versions;
    const ids = folders.ok ? folders.items.map((folder) => folder.id) : Object.keys(folders.versions);
    for (const id of ids) {
      const container = `${mailbox.key}/contacts/${id}`;
      next[container] = (await syncListed(reader, store, {
        base, container, version: 'v1.0', path: `${owner}/contactFolders/${seg(id)}/contacts`, kind: 'contact', previous: state[container], now, report,
      })).versions;
      if (depth < MAX_FOLDER_DEPTH) await visit(`${owner}/contactFolders/${seg(id)}/childFolders`, `${mailbox.key}/contact-folders/${id}`, depth + 1);
    }
  };
  await visit(`${owner}/contactFolders`, `${mailbox.key}/contact-folders`, 1);
  return next;
}

/** To Do lists through lists/delta, then each list's tasks through tasks/delta. */
async function syncTasks(reader, store, { base, mailbox, owner, state, now, report }) {
  const listsContainer = `${mailbox.key}/todo-lists`;
  const tasks = { ...state.tasks };
  const storeEach = (container, kind, incomplete, onRemoved, onSeen) => async (page) => {
    let failed = 0;
    for (const item of page) {
      const ref = { ...base, container, itemKey: item.id };
      try {
        if (item['@removed']) {
          await putTombstone(store, ref, { at: now(), reason: item['@removed'].reason });
          onRemoved?.(item.id);
          report.counts.removed++;
        } else {
          const flag = incomplete?.(item) ?? null;
          await putJson(store, ref, item, {
            version: item['@odata.etag'] ?? item.lastModifiedDateTime ?? `seen@${now()}`,
            metadata: { kind, ...(flag ? { incomplete: flag } : {}) },
          });
          onSeen?.(item.id);
          report.counts.stored++;
          if (flag) report.counts.incomplete++;
        }
      } catch (error) {
        failed++;
        report.errors.push({ container, itemKey: item.id, error: String(error?.message ?? error) });
      }
    }
    return failed;
  };
  const lists = await walkDelta(reader, 'v1.0', { initial: `${owner}/todo/lists/delta`, cursor: state.lists }, storeEach(
    listsContainer, 'todoList', null,
    (id) => { delete tasks[id]; },
    (id) => { if (!(id in tasks)) tasks[id] = null; },
  ));
  if (!lists.ok) report.errors.push({ container: listsContainer, error: lists.error });
  for (const listId of Object.keys(tasks)) {
    const container = `${mailbox.key}/todo/${listId}`;
    const walk = await walkDelta(reader, 'v1.0', { initial: `${owner}/todo/lists/${seg(listId)}/tasks/delta`, cursor: tasks[listId] }, storeEach(container, 'todoTask', taskIncomplete));
    tasks[listId] = walk.cursor;
    if (!walk.ok) report.errors.push({ container, error: walk.error });
  }
  return { lists: lists.cursor, tasks };
}

/**
 * Syncs calendars, contacts and tasks of one mailbox. A Group mailbox has its calendar
 * only. `state` is this mailbox's previous items state; returns { state, report }.
 */
export async function syncMailboxItems(rawReader, store, { tenantRef, mailbox, state = {}, now = () => new Date().toISOString() }) {
  const reader = readOnlyReader(rawReader);
  const base = { tenantRef, workload: ITEMS_WORKLOAD };
  const owner = mailbox.kind === 'group' ? `/groups/${seg(mailbox.id)}` : `/users/${seg(mailbox.id)}`;
  const report = { counts: counts(), errors: [] };
  const context = { base, mailbox, owner, now, report };
  const next = { calendars: await syncCalendars(reader, store, { ...context, state: state.calendars ?? {} }) };
  if (mailbox.kind !== 'group') {
    next.contacts = await syncContacts(reader, store, { ...context, state: state.contacts ?? {} });
    next.tasks = await syncTasks(reader, store, { ...context, state: state.tasks ?? {} });
  }
  return { state: next, report: { ...report, ok: report.errors.length === 0 } };
}
