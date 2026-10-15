/**
 * Wave 1 MAIL: mail folders and messages of one mailbox, through Graph delta sync.
 *
 * Each folder's messages are walked with `messages/delta`. The first run reads every
 * message; later runs start from the stored delta link, so only what changed since is
 * fetched. Every new or changed message is stored as its MIME (`$value`) in the content
 * store. A message Graph reports as removed is never deleted from the store: a tombstone
 * version is added and the earlier versions stay restorable.
 *
 * Rules:
 *  - Read-only. Only `reader.get` and `reader.getStream` are called, and the Graph reader
 *    sends GET and nothing else. readOnlyReader() hands the sync nothing more.
 *  - Resumable. A failed page stops the walk and its URL is kept as the cursor, so the
 *    next run re-reads that page (items already stored dedupe in the store) instead of
 *    skipping what it never stored. An expired delta link (410) restarts that folder once.
 *  - Nothing readable is skipped. A message bigger than the MIME limit is stored as its
 *    metadata with an `incomplete` record naming what is missing and why.
 *  - The archive mailbox is read through the beta mailbox API. Its item content is only
 *    exported by a POST (`exportItems`), which the read-only transport never sends, so
 *    archive items are stored as metadata and flagged incomplete.
 */
import { Readable } from 'node:stream';

export const MAIL_WORKLOAD = 'exchange-mail';
export const DEFAULT_MAX_MIME_BYTES = 150 * 1024 * 1024;

const MESSAGE_SELECT = [
  'id', 'changeKey', 'parentFolderId', 'internetMessageId', 'receivedDateTime',
  'lastModifiedDateTime', 'hasAttachments', 'isDraft',
].join(',');
const MESSAGE_META = ['changeKey', 'parentFolderId', 'internetMessageId', 'receivedDateTime', 'lastModifiedDateTime', 'hasAttachments', 'isDraft'];

/** The reader a sync is given: GET routes only, whatever else the reader carries. */
export function readOnlyReader(reader) {
  if (typeof reader?.get !== 'function') throw new TypeError('a Graph reader with get() is required');
  return Object.freeze({
    get: (version, path, options) => reader.get(version, path, options),
    getStream: (version, path, options) => {
      if (typeof reader.getStream !== 'function') throw new TypeError('the Graph reader has no getStream()');
      return reader.getStream(version, path, options);
    },
  });
}

export const seg = (value) => encodeURIComponent(String(value));

const isExpired = (res) => res?.status === 410
  || /syncstate(notfound|invalid)|resyncrequired/i.test(String(res?.code ?? ''));

/**
 * Walks one delta query to its delta link. `onItems(items)` returns the number of items
 * it could not store; any failure stops the walk on that page so it is read again.
 * Returns { ok, deltaLink, cursor, pages, error, resynced }.
 */
export async function walkDelta(reader, version, { initial, cursor }, onItems) {
  let next = cursor ?? initial;
  let pages = 0;
  let resynced = false;
  while (next) {
    const res = await reader.get(version, next);
    if (!res?.ok) {
      if (isExpired(res) && next !== initial && !resynced) {
        resynced = true;
        next = initial;
        continue;
      }
      return { ok: false, cursor: next, pages, resynced, error: describe(res) };
    }
    pages++;
    const failed = await onItems(Array.isArray(res.body?.value) ? res.body.value : []);
    if (failed > 0) return { ok: false, cursor: next, pages, resynced, error: `${failed} item(s) not stored` };
    const nextLink = res.body?.['@odata.nextLink'];
    if (nextLink) { next = nextLink; continue; }
    const deltaLink = res.body?.['@odata.deltaLink'];
    if (!deltaLink) return { ok: false, cursor: initial, pages, resynced, error: 'delta walk ended without a delta link' };
    return { ok: true, cursor: deltaLink, pages, resynced, error: null };
  }
  return { ok: false, cursor: initial, pages, resynced, error: 'no delta cursor' };
}

export function describe(res) {
  if (!res) return 'no answer';
  return [res.status, res.code, res.error].filter((part) => part !== undefined && part !== null && part !== '').join(' ');
}

/** Stores a JSON body (a folder, event, contact or task) as one item version. */
export async function putJson(store, ref, body, { version, metadata = {} }) {
  const bytes = Buffer.from(JSON.stringify(body));
  return store.putItem(Readable.from([bytes]), { ...ref, version, metadata: { contentType: 'application/json', ...metadata } });
}

/** Adds the tombstone version for an item Graph reports as removed. Earlier versions stay. */
export async function putTombstone(store, ref, { at, reason }) {
  return store.putItem(Readable.from([Buffer.alloc(0)]), {
    ...ref,
    version: `removed@${at}`,
    metadata: { removed: true, removedAt: at, ...(reason ? { reason } : {}) },
  });
}

const pick = (body, keys) => Object.fromEntries(keys.filter((key) => body?.[key] !== undefined).map((key) => [key, body[key]]));

function emptyCounts() {
  return { stored: 0, removed: 0, incomplete: 0, deduped: 0, pages: 0 };
}

/**
 * Syncs a folder tree: the folder delta first (it names every folder and the removed
 * ones), then each folder's own item delta. A failed folder walk does not stop the item
 * walks of the folders already known. Folders seen before a failure are kept in the state
 * with a null cursor, so a resumed folder walk never loses them.
 */
async function syncFolderTree(reader, store, { version, base, foldersContainer, folderKind, foldersPath, itemsPath, itemsContainer, state, now, storeItem }) {
  const report = { folders: emptyCounts(), messages: emptyCounts(), errors: [] };
  const items = { ...state.messages };
  const folderWalk = await walkDelta(reader, version, { initial: foldersPath, cursor: state.folders?.cursor }, async (page) => {
    let failed = 0;
    for (const folder of page) {
      const ref = { ...base, container: foldersContainer, itemKey: folder.id };
      try {
        if (folder['@removed']) {
          await putTombstone(store, ref, { at: now(), reason: folder['@removed'].reason });
          delete items[folder.id];
          report.folders.removed++;
        } else {
          countPut(report.folders, await putJson(store, ref, folder, { version: folder.changeKey ?? `seen@${now()}`, metadata: { kind: folderKind } }));
          if (!(folder.id in items)) items[folder.id] = null;
        }
      } catch (error) {
        failed++;
        report.errors.push({ container: foldersContainer, itemKey: folder.id, error: errorText(error) });
      }
    }
    return failed;
  });
  report.folders.pages = folderWalk.pages;
  if (folderWalk.resynced) report.folders.resynced = true;
  if (!folderWalk.ok) report.errors.push({ container: foldersContainer, error: folderWalk.error });

  for (const folderId of Object.keys(items)) {
    const container = itemsContainer(folderId);
    const walk = await walkDelta(reader, version, { initial: itemsPath(folderId), cursor: items[folderId] }, async (page) => {
      let failed = 0;
      for (const item of page) {
        const ref = { ...base, container, itemKey: item.id };
        try {
          if (item['@removed']) {
            await putTombstone(store, ref, { at: now(), reason: item['@removed'].reason });
            report.messages.removed++;
          } else {
            await storeItem(ref, item, report.messages);
          }
        } catch (error) {
          failed++;
          report.errors.push({ container, itemKey: item.id, error: errorText(error) });
        }
      }
      return failed;
    });
    report.messages.pages += walk.pages;
    if (walk.resynced) report.messages.resynced = (report.messages.resynced ?? 0) + 1;
    items[folderId] = walk.cursor;
    if (!walk.ok) report.errors.push({ container, error: walk.error });
  }
  return {
    state: { folders: { cursor: folderWalk.cursor }, messages: items },
    report: { ...report, ok: report.errors.length === 0 },
  };
}

const errorText = (error) => String(error?.message ?? error);

function countPut(counts, put) {
  counts.stored++;
  if (put?.deduped) counts.deduped++;
}

/**
 * Syncs the mail of one user or shared mailbox. `state` is this mailbox's previous mail
 * state ({ folders: { cursor }, messages: { [folderId]: cursor } }), or undefined on a
 * first run. Returns { state, report }; the caller persists `state`.
 */
export async function syncMailboxMail(rawReader, store, { tenantRef, mailbox, state = {}, now = () => new Date().toISOString(), maxMimeBytes = DEFAULT_MAX_MIME_BYTES }) {
  const reader = readOnlyReader(rawReader);
  const user = `/users/${seg(mailbox.id)}`;
  return syncFolderTree(reader, store, {
    version: 'v1.0',
    base: { tenantRef, workload: MAIL_WORKLOAD },
    foldersContainer: `${mailbox.key}/mail-folders`,
    folderKind: 'mailFolder',
    // v1.0 only: wellKnownName is a beta-only mailFolder property and v1.0 rejects the whole $select (#263).
    foldersPath: `${user}/mailFolders/delta?$select=id,displayName,parentFolderId,totalItemCount`,
    itemsPath: (folderId) => `${user}/mailFolders/${seg(folderId)}/messages/delta?$select=${MESSAGE_SELECT}`,
    itemsContainer: (folderId) => `${mailbox.key}/mail/${folderId}`,
    state,
    now,
    storeItem: (ref, message, counts) => storeMessage(reader, store, ref, message, { user, now, maxMimeBytes, counts }),
  });
}

async function storeMessage(reader, store, ref, message, { user, now, maxMimeBytes, counts }) {
  const version = message.changeKey ?? message.lastModifiedDateTime ?? `seen@${now()}`;
  const metadata = { kind: 'message', ...pick(message, MESSAGE_META) };
  const mime = await reader.getStream('v1.0', `${user}/messages/${seg(message.id)}/$value`, { maxBytes: maxMimeBytes });
  if (!mime?.ok) {
    // A message deleted between the delta page and this read is gone, not failed:
    // the next delta reports its removal.
    if (mime?.status === 404) return;
    throw new Error(`MIME read failed: ${describe(mime)}`);
  }
  if (mime.tooLarge) {
    countPut(counts, await putJson(store, ref, message, {
      version,
      metadata: { ...metadata, incomplete: { missing: ['mime'], reason: 'too-large', detail: `MIME is larger than ${maxMimeBytes} bytes` } },
    }));
    counts.incomplete++;
    return;
  }
  countPut(counts, await store.putItem(Readable.from([mime.bytes ?? Buffer.alloc(0)]), {
    ...ref,
    version,
    metadata: { ...metadata, contentType: 'message/rfc822' },
  }));
}

/**
 * Syncs an online archive mailbox through the beta mailbox API (folders/delta and
 * items/delta, both GET). Item content needs `exportItems`, a POST the read-only
 * transport never sends, so each item is stored as metadata and flagged incomplete.
 */
export async function syncArchiveMailbox(rawReader, store, { tenantRef, mailbox, state = {}, now = () => new Date().toISOString() }) {
  const reader = readOnlyReader(rawReader);
  const root = `/admin/exchange/mailboxes/${seg(mailbox.archiveMailboxId)}`;
  return syncFolderTree(reader, store, {
    version: 'beta',
    base: { tenantRef, workload: MAIL_WORKLOAD },
    foldersContainer: `${mailbox.key}/archive-folders`,
    folderKind: 'archiveFolder',
    foldersPath: `${root}/folders/delta`,
    itemsPath: (folderId) => `${root}/folders/${seg(folderId)}/items/delta`,
    itemsContainer: (folderId) => `${mailbox.key}/archive/${folderId}`,
    state,
    now,
    storeItem: async (ref, item, counts) => {
      countPut(counts, await putJson(store, ref, item, {
        version: item.changeKey ?? item.lastModifiedDateTime ?? `seen@${now()}`,
        metadata: {
          kind: 'archiveItem',
          incomplete: { missing: ['content'], reason: 'binary-route', detail: 'archive item content is exported only by exportItems, a POST the read-only transport never sends' },
        },
      }));
      counts.incomplete++;
    },
  });
}
