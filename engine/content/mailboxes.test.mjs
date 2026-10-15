import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { backupMailboxes, discoverMailboxes } from './mailboxes.mjs';
import { readOnlyReader, syncMailboxMail, walkDelta } from './exchangeMail.mjs';

const GRAPH = 'https://graph.microsoft.com';
const PAGE = 2;
const TENANT = 'tenant-ref-1';

/**
 * A fixture tenant behind a Graph-reader-shaped fake. Collections are keyed by their
 * route (`/users/u1/mailFolders/f1/messages`); a route ending in /delta reads the same
 * collection as a delta query. Every change gets a sequence number, and a delta token is
 * the sequence it was issued at.
 */
class FixtureTenant {
  constructor() {
    this.seq = 0;
    this.collections = new Map();
    this.removed = new Map();
    this.mime = new Map();
    this.singletons = new Map();
    this.calls = [];
    this.failOnce = new Set();
    this.expired = new Set();
  }

  set(collection, object, { mime } = {}) {
    if (!this.collections.has(collection)) this.collections.set(collection, new Map());
    this.seq++;
    this.collections.get(collection).set(object.id, { object: { changeKey: `ck-${this.seq}`, ...object }, seq: this.seq });
    if (mime !== undefined) this.mime.set(`${collection.replace(/\/mailFolders\/[^/]+\/messages$/, '/messages')}/${object.id}`, Buffer.from(mime));
  }

  remove(collection, id) {
    this.collections.get(collection).delete(id);
    this.seq++;
    if (!this.removed.has(collection)) this.removed.set(collection, []);
    this.removed.get(collection).push({ id, seq: this.seq });
  }

  reader() {
    const tenant = this;
    return {
      async get(version, path) {
        tenant.calls.push({ method: 'get', version, path });
        return tenant.answer(version, path);
      },
      async getStream(version, path, { maxBytes }) {
        tenant.calls.push({ method: 'getStream', version, path });
        const bytes = tenant.mime.get(path.replace(/\/\$value$/, ''));
        if (!bytes) return { ok: false, status: 404, code: 'ErrorItemNotFound' };
        if (bytes.length > maxBytes) return { ok: true, status: 200, tooLarge: true };
        return { ok: true, status: 200, bytes };
      },
      async post() { throw new Error('a write was attempted'); },
    };
  }

  answer(version, rawPath) {
    const url = new URL(rawPath.startsWith('http') ? rawPath : `${GRAPH}/${version}${rawPath}`);
    const path = url.pathname.replace(/^\/(v1\.0|beta)/, '');
    if (this.failOnce.has(rawPath)) {
      this.failOnce.delete(rawPath);
      return { ok: false, status: 503, error: 'service unavailable' };
    }
    if (this.expired.has(url.searchParams.get('$deltatoken'))) return { ok: false, status: 410, code: 'SyncStateNotFound' };
    if (this.singletons.has(path)) {
      const value = this.singletons.get(path);
      return value.ok === false ? value : { ok: true, status: 200, body: value };
    }
    const isDelta = path.endsWith('/delta');
    const collection = isDelta ? path.slice(0, -'/delta'.length) : path;
    const entries = [...(this.collections.get(collection)?.values() ?? [])];
    const since = Number(url.searchParams.get('$deltatoken') ?? url.searchParams.get('since') ?? -1);
    let rows = entries.filter((entry) => !isDelta || entry.seq > since).map((entry) => entry.object);
    if (isDelta && since >= 0) {
      rows = rows.concat((this.removed.get(collection) ?? []).filter((r) => r.seq > since).map((r) => ({ id: r.id, '@removed': { reason: 'deleted' } })));
    }
    const skip = Number(url.searchParams.get('$skiptoken') ?? 0);
    const value = rows.slice(skip, skip + PAGE);
    const body = { value };
    const base = `${GRAPH}/${version}${collection}${isDelta ? '/delta' : ''}`;
    if (skip + PAGE < rows.length) {
      body['@odata.nextLink'] = `${base}?$skiptoken=${skip + PAGE}${isDelta ? `&since=${since}` : ''}`;
    } else if (isDelta) {
      body['@odata.deltaLink'] = `${base}?$deltatoken=${this.seq}`;
    }
    return { ok: true, status: 200, body };
  }

  routesCalled(method) {
    return this.calls.filter((call) => !method || call.method === method).map((call) => call.path);
  }
}

/** An in-memory content store with the Wave 1 interface, until the content store merges. */
function memoryStore() {
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
      blobs.set(sha256, bytes);
      const ref = `mem:${items.length + 1}`;
      items.push({ ref, sha256, tenantRef, workload, container, itemKey, version, metadata, at: items.length });
      return { ref, sha256, bytes: bytes.length, deduped };
    },
    async getItem(ref) {
      const item = items.find((entry) => entry.ref === ref);
      return Readable.from([blobs.get(item.sha256)]);
    },
    async listItems({ container, since = -1 }) {
      return items.filter((entry) => entry.container === container && entry.at > since);
    },
  };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

function fixture() {
  const tenant = new FixtureTenant();
  tenant.set('/users', { id: 'u1', displayName: 'KEEL-RT-Mail User', userPrincipalName: 'KEEL-RT-mail@contoso.test', mail: 'KEEL-RT-mail@contoso.test' });
  tenant.set('/users', { id: 'u2', displayName: 'KEEL-RT-Shared', userPrincipalName: 'KEEL-RT-shared@contoso.test', mail: 'KEEL-RT-shared@contoso.test' });
  tenant.set('/users', { id: 'u3', displayName: 'KEEL-RT-No Mailbox', userPrincipalName: 'KEEL-RT-nomail@contoso.test', mail: null });
  tenant.set('/users', { id: 'u4', displayName: 'Someone Else', userPrincipalName: 'someone@contoso.test', mail: 'someone@contoso.test' });
  tenant.singletons.set('/users/u1/mailboxSettings/userPurpose', { value: 'user' });
  tenant.singletons.set('/users/u2/mailboxSettings/userPurpose', { value: 'shared' });
  tenant.singletons.set('/users/u4/mailboxSettings/userPurpose', { value: 'user' });
  tenant.singletons.set('/users/u1/settings/exchange', { primaryMailboxId: 'p1', archiveMailboxId: 'a1' });
  tenant.singletons.set('/users/u2/settings/exchange', { primaryMailboxId: 'p2' });
  tenant.singletons.set('/users/u4/settings/exchange', { primaryMailboxId: 'p4' });
  tenant.set('/groups', { id: 'g1', displayName: 'KEEL-RT-Group', mail: 'KEEL-RT-group@contoso.test' });

  // u1: two folders, five messages in the inbox (three pages), one in archive-folder.
  tenant.set('/users/u1/mailFolders', { id: 'inbox', displayName: 'Inbox' });
  tenant.set('/users/u1/mailFolders', { id: 'sent', displayName: 'Sent Items' });
  for (let i = 1; i <= 5; i++) {
    tenant.set('/users/u1/mailFolders/inbox/messages', { id: `m${i}`, internetMessageId: `<m${i}@contoso.test>` }, { mime: `Subject: message ${i}\r\n\r\nbody ${i}` });
  }
  tenant.set('/users/u1/mailFolders/sent/messages', { id: 's1' }, { mime: 'Subject: sent\r\n\r\nsent body' });
  tenant.set('/users/u1/calendars', { id: 'cal1', name: 'Calendar' });
  tenant.set('/users/u1/calendars/cal1/events', { id: 'e1', subject: 'Standup', type: 'seriesMaster' });
  tenant.set('/users/u1/calendars/cal1/events', { id: 'e2', subject: 'Review', type: 'singleInstance', hasAttachments: false });
  tenant.set('/users/u1/contacts', { id: 'c1', displayName: 'KEEL-RT-Contact' });
  tenant.set('/users/u1/contactFolders', { id: 'cf1', displayName: 'Suppliers' });
  tenant.set('/users/u1/contactFolders/cf1/contacts', { id: 'c2', displayName: 'KEEL-RT-Supplier' });
  tenant.set('/users/u1/todo/lists', { id: 'l1', displayName: 'Tasks' });
  tenant.set('/users/u1/todo/lists/l1/tasks', { id: 't1', title: 'KEEL-RT-Task', hasAttachments: true });
  // u1 archive (beta mailbox API).
  tenant.set('/admin/exchange/mailboxes/a1/folders', { id: 'af1', displayName: 'Archive Inbox' });
  tenant.set('/admin/exchange/mailboxes/a1/folders/af1/items', { id: 'ai1' });
  // u2 shared mailbox: one folder, one message.
  tenant.set('/users/u2/mailFolders', { id: 'inbox2', displayName: 'Inbox' });
  tenant.set('/users/u2/mailFolders/inbox2/messages', { id: 'x1' }, { mime: 'Subject: shared\r\n\r\nshared body' });
  // g1 group calendar.
  tenant.set('/groups/g1/events', { id: 'ge1', subject: 'Group event' });
  return tenant;
}

const run = (tenant, store, state) => backupMailboxes(tenant.reader(), store, { tenantRef: TENANT, state, match: 'KEEL-RT-', now: () => '2026-10-14T00:00:00Z' });

test('discovery finds user, shared, archive and Group mailboxes, and reports users without one', async () => {
  const tenant = fixture();
  const found = await discoverMailboxes(tenant.reader(), { match: 'KEEL-RT-' });
  assert.deepEqual(found.mailboxes.map((m) => [m.key, m.kind]), [
    ['mailbox/u1', 'user'], ['archive/u1', 'archive'], ['mailbox/u2', 'shared'], ['group/g1', 'group'],
  ]);
  assert.deepEqual(found.skipped.map((s) => [s.id, s.reason]), [['u3', 'no mail address']]);
  assert.deepEqual(found.errors, []);
  // The prefix narrows the run: the other user is never read.
  assert.ok(!tenant.routesCalled().some((path) => path.includes('/users/u4/')));
  const all = await discoverMailboxes(fixture().reader());
  assert.ok(all.mailboxes.some((m) => m.key === 'mailbox/u4'));
});

test('a mailbox without Exchange Online is skipped with its reason, and other lookup errors are reported', async () => {
  const tenant = fixture();
  tenant.singletons.set('/users/u2/mailboxSettings/userPurpose', { ok: false, status: 404, code: 'MailboxNotEnabledForRESTAPI' });
  tenant.singletons.set('/users/u1/mailboxSettings/userPurpose', { ok: false, status: 403, code: 'ErrorAccessDenied', error: 'Access is denied' });
  const found = await discoverMailboxes(tenant.reader(), { match: 'KEEL-RT-' });
  assert.deepEqual(found.skipped.map((s) => s.id).sort(), ['u2', 'u3']);
  assert.deepEqual(found.errors.map((e) => [e.id, e.error]), [['u1', '403 ErrorAccessDenied Access is denied']]);
});

test('a fixture mailbox syncs: folders, every message as MIME, calendars, contacts and tasks', async () => {
  const tenant = fixture();
  const store = memoryStore();
  const result = await run(tenant, store, {});
  assert.equal(result.ok, true, JSON.stringify(result.mailboxes, null, 2));

  const user = result.mailboxes.find((m) => m.key === 'mailbox/u1');
  assert.equal(user.mail.messages.stored, 6);
  assert.equal(user.mail.messages.pages, 3 + 1); // inbox 5 messages over three pages, sent one page
  assert.equal(user.mail.folders.stored, 2);
  const inbox = await store.listItems({ container: 'mailbox/u1/mail/inbox' });
  assert.equal(inbox.length, 5);
  assert.equal(inbox[0].tenantRef, TENANT);
  assert.equal(inbox[0].workload, 'exchange-mail');
  assert.equal(inbox[0].metadata.contentType, 'message/rfc822');
  assert.equal(inbox[0].metadata.internetMessageId, '<m1@contoso.test>');
  assert.equal(await readAll(await store.getItem(inbox[0].ref)), 'Subject: message 1\r\n\r\nbody 1');

  assert.equal((await store.listItems({ container: 'mailbox/u1/calendar/cal1' })).length, 2);
  assert.equal((await store.listItems({ container: 'mailbox/u1/contacts/default' })).length, 1);
  assert.equal((await store.listItems({ container: 'mailbox/u1/contacts/cf1' })).length, 1);
  assert.equal((await store.listItems({ container: 'mailbox/u1/todo/l1' })).length, 1);

  const shared = result.mailboxes.find((m) => m.key === 'mailbox/u2');
  assert.equal(shared.kind, 'shared');
  assert.equal(shared.mail.messages.stored, 1);
});

test('what a route does not return is flagged incomplete, never skipped', async () => {
  const tenant = fixture();
  const store = memoryStore();
  await run(tenant, store, {});
  const [series, single] = await store.listItems({ container: 'mailbox/u1/calendar/cal1' });
  assert.deepEqual(series.metadata.incomplete.missing, ['occurrenceExceptions']);
  assert.equal(single.metadata.incomplete, undefined);
  const [task] = await store.listItems({ container: 'mailbox/u1/todo/l1' });
  assert.deepEqual(task.metadata.incomplete.missing, ['attachments']);

  const [archived] = await store.listItems({ container: 'archive/u1/archive/af1' });
  assert.equal(archived.metadata.kind, 'archiveItem');
  assert.deepEqual(archived.metadata.incomplete.missing, ['content']);
  assert.equal(archived.metadata.incomplete.reason, 'binary-route');
});

test('a message larger than the MIME limit is stored as metadata and flagged incomplete', async () => {
  const tenant = fixture();
  tenant.set('/users/u1/mailFolders/sent/messages', { id: 'big' }, { mime: 'x'.repeat(64) });
  const limited = memoryStore();
  const synced = await syncMailboxMail(tenant.reader(), limited, { tenantRef: TENANT, mailbox: { key: 'mailbox/u1', id: 'u1' }, maxMimeBytes: 40 });
  assert.equal(synced.report.messages.incomplete, 1);
  const big = (await limited.listItems({ container: 'mailbox/u1/mail/sent' })).find((item) => item.itemKey === 'big');
  assert.deepEqual(big.metadata.incomplete, { missing: ['mime'], reason: 'too-large', detail: 'MIME is larger than 40 bytes' });
});

test('the second run fetches only the delta, and a deleted item stays in the backup', async () => {
  const tenant = fixture();
  const store = memoryStore();
  const first = await run(tenant, store, {});
  const storedAfterFirst = store.items.length;

  // Nothing changed: no MIME is read and nothing new is stored.
  tenant.calls.length = 0;
  const quiet = await run(tenant, store, first.state);
  assert.equal(quiet.ok, true);
  assert.deepEqual(tenant.routesCalled('getStream'), []);
  assert.equal(store.items.length, storedAfterFirst);
  const quietUser = quiet.mailboxes.find((m) => m.key === 'mailbox/u1');
  assert.equal(quietUser.mail.messages.stored, 0);
  assert.equal(quietUser.items.counts.stored, 0);
  assert.ok(quietUser.items.counts.unchanged >= 4);
  // Delta queries resume from the stored delta links, never from the start.
  assert.ok(tenant.routesCalled('get').filter((path) => path.includes('/delta')).every((path) => path.includes('$deltatoken=')));

  // One message changes, one arrives, one is deleted, an event is removed.
  const [deleted] = await store.listItems({ container: 'mailbox/u1/mail/inbox' });
  tenant.set('/users/u1/mailFolders/inbox/messages', { id: 'm2', internetMessageId: '<m2@contoso.test>' }, { mime: 'Subject: message 2 (edited)\r\n\r\nbody 2' });
  tenant.set('/users/u1/mailFolders/inbox/messages', { id: 'm6' }, { mime: 'Subject: message 6\r\n\r\nbody 6' });
  tenant.remove('/users/u1/mailFolders/inbox/messages', 'm1');
  tenant.mime.delete('/users/u1/messages/m1');
  tenant.remove('/users/u1/calendars/cal1/events', 'e2');

  tenant.calls.length = 0;
  const second = await run(tenant, store, quiet.state);
  assert.equal(second.ok, true);
  assert.deepEqual(tenant.routesCalled('getStream').sort(), ['/users/u1/messages/m2/$value', '/users/u1/messages/m6/$value']);
  const user = second.mailboxes.find((m) => m.key === 'mailbox/u1');
  assert.equal(user.mail.messages.stored, 2);
  assert.equal(user.mail.messages.removed, 1);
  assert.equal(user.items.counts.removed, 1);

  // The deleted message's MIME is still readable; a tombstone version marks the delete.
  assert.equal(await readAll(await store.getItem(deleted.ref)), 'Subject: message 1\r\n\r\nbody 1');
  const m1 = store.items.filter((item) => item.itemKey === 'm1');
  assert.deepEqual(m1.map((item) => item.metadata.removed === true), [false, true]);
  const e2 = store.items.filter((item) => item.itemKey === 'e2');
  assert.equal(e2.length, 2);
  assert.equal(e2[1].metadata.removed, true);
  assert.equal(await readAll(await store.getItem(e2[0].ref)).then((text) => JSON.parse(text).subject), 'Review');
});

test('a failed page is read again on the next run, and nothing on it is lost', async () => {
  const tenant = fixture();
  const store = memoryStore();
  const first = await run(tenant, store, {});
  for (let i = 7; i <= 10; i++) tenant.set('/users/u1/mailFolders/inbox/messages', { id: `m${i}` }, { mime: `Subject: message ${i}` });
  // The second page of the inbox delta fails once.
  const cursor = first.state['mailbox/u1'].mail.messages.inbox;
  const since = new URL(cursor).searchParams.get('$deltatoken');
  tenant.failOnce.add(`${GRAPH}/v1.0/users/u1/mailFolders/inbox/messages/delta?$skiptoken=2&since=${since}`);

  const interrupted = await run(tenant, store, first.state);
  assert.equal(interrupted.ok, false);
  const user = interrupted.mailboxes.find((m) => m.key === 'mailbox/u1');
  assert.equal(user.mail.messages.stored, 2);
  assert.match(user.mail.errors[0].error, /^503/);
  assert.match(interrupted.state['mailbox/u1'].mail.messages.inbox, /\$skiptoken=2/);

  const resumed = await run(tenant, store, interrupted.state);
  assert.equal(resumed.ok, true);
  const keys = new Set(store.items.filter((item) => item.container === 'mailbox/u1/mail/inbox').map((item) => item.itemKey));
  for (const i of [1, 2, 3, 4, 5, 7, 8, 9, 10]) assert.ok(keys.has(`m${i}`), `m${i}`);
});

test('an expired delta link restarts that folder from a full read once', async () => {
  const tenant = fixture();
  const store = memoryStore();
  const first = await run(tenant, store, {});
  const cursor = first.state['mailbox/u1'].mail.messages.sent;
  tenant.expired.add(new URL(cursor).searchParams.get('$deltatoken'));
  tenant.calls.length = 0;
  const again = await run(tenant, store, first.state);
  const user = again.mailboxes.find((m) => m.key === 'mailbox/u1');
  assert.equal(user.mail.messages.resynced >= 1, true);
  assert.ok(tenant.routesCalled('getStream').includes('/users/u1/messages/s1/$value'));
  // The re-read message has the same content, so the store keeps one blob for it.
  const s1 = store.items.filter((item) => item.itemKey === 's1');
  assert.equal(new Set(s1.map((item) => item.sha256)).size, 1);
});

test('a Group mailbox backs up its calendar and leaves conversations to the Planner package', async () => {
  const tenant = fixture();
  const store = memoryStore();
  const result = await run(tenant, store, {});
  const group = result.mailboxes.find((m) => m.key === 'group/g1');
  assert.equal(group.conversations, 'PLANNER');
  assert.equal(group.items.counts.stored, 1);
  assert.equal((await store.listItems({ container: 'group/g1/calendar/group' }))[0].itemKey, 'ge1');
  assert.ok(!tenant.routesCalled().some((path) => path.startsWith('/groups/g1/') && !path.startsWith('/groups/g1/events')));
});

test('every request is a GET: the sync is handed get and getStream only', async () => {
  const tenant = fixture();
  await run(tenant, memoryStore(), {});
  assert.ok(tenant.calls.length > 0);
  assert.deepEqual([...new Set(tenant.calls.map((call) => call.method))].sort(), ['get', 'getStream']);
  const guarded = readOnlyReader(tenant.reader());
  assert.deepEqual(Object.keys(guarded).sort(), ['get', 'getStream']);
  assert.equal(guarded.post, undefined);
  assert.throws(() => readOnlyReader({}), /get\(\)/);
});

test('backupMailboxes needs a tenant and a store with the content store interface', async () => {
  const tenant = fixture();
  await assert.rejects(backupMailboxes(tenant.reader(), memoryStore(), {}), /tenantRef/);
  await assert.rejects(backupMailboxes(tenant.reader(), { putItem() {} }, { tenantRef: TENANT }), /getItem/);
});

test('a delta walk that ends without a delta link is not treated as complete', async () => {
  const reader = { get: async () => ({ ok: true, status: 200, body: { value: [] } }) };
  const walk = await walkDelta(reader, 'v1.0', { initial: '/x/delta' }, async () => 0);
  assert.equal(walk.ok, false);
  assert.equal(walk.cursor, '/x/delta');
});

test('a saved query an older build wrote is dropped for the current query (#268)', async () => {
  // Before #267 a failed first page saved its own request as the cursor, and every later
  // run replayed that rejected $select.
  const stale = '/x/delta?$select=id,wellKnownName';
  const paths = [];
  const reader = {
    get: async (version, path) => {
      paths.push(path);
      if (path === stale) return { ok: false, status: 400, code: 'BadRequest', error: 'Could not find a property named wellKnownName' };
      return { ok: true, status: 200, body: { value: [], '@odata.deltaLink': `${GRAPH}/v1.0/x/delta?$deltatoken=1` } };
    },
  };
  const walk = await walkDelta(reader, 'v1.0', { initial: '/x/delta?$select=id', cursor: stale }, async () => 0);
  assert.equal(walk.ok, true);
  assert.deepEqual(paths, ['/x/delta?$select=id']);
  assert.equal(walk.cursor, `${GRAPH}/v1.0/x/delta?$deltatoken=1`);
});

test('a stored Graph link that Graph rejects restarts the walk from the current query once', async () => {
  const bad = `${GRAPH}/v1.0/x/delta?$deltatoken=old`;
  const paths = [];
  const reader = {
    get: async (version, path) => {
      paths.push(path);
      if (path === bad) return { ok: false, status: 400, code: 'BadRequest' };
      return { ok: true, status: 200, body: { value: [], '@odata.deltaLink': `${GRAPH}/v1.0/x/delta?$deltatoken=2` } };
    },
  };
  const walk = await walkDelta(reader, 'v1.0', { initial: '/x/delta', cursor: bad }, async () => 0);
  assert.equal(walk.ok, true);
  assert.equal(walk.resynced, true);
  assert.deepEqual(paths, [bad, '/x/delta']);
});

test('a 400 on the current query is reported, not retried', async () => {
  let calls = 0;
  const reader = { get: async () => { calls++; return { ok: false, status: 400, code: 'BadRequest' }; } };
  const walk = await walkDelta(reader, 'v1.0', { initial: '/x/delta' }, async () => 0);
  assert.equal(walk.ok, false);
  assert.equal(walk.cursor, '/x/delta');
  assert.equal(calls, 1);
});

test('a mailbox whose saved folder cursor is an old query reads its folders again (#268)', async () => {
  const tenant = fixture();
  const store = memoryStore();
  const first = await run(tenant, store, {});
  const state = structuredClone(first.state);
  state['mailbox/u1'].mail = { folders: { cursor: '/users/u1/mailFolders/delta?$select=id,displayName,parentFolderId,wellKnownName,totalItemCount' }, messages: {} };
  tenant.calls.length = 0;
  const again = await run(tenant, store, state);
  assert.equal(again.ok, true);
  assert.ok(!tenant.routesCalled('get').some((path) => path.includes('wellKnownName')));
  assert.match(again.state['mailbox/u1'].mail.folders.cursor, /^https:\/\/.*\$deltatoken=/);
});
