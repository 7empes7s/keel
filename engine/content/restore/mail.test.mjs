import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { createMemoryContentStore } from '../store.mjs';
import { backupMailboxes } from '../mailboxes.mjs';
import { createMemoryRestoreJournal } from './journal.mjs';
import { mailRestoreRunId, normalizeMailRestoreRequest, planMailRestore, restoreMail } from './mail.mjs';
import { targetProblems } from './gate.mjs';

const TENANT = 'sha256:KEEL-RT-tenant';
const USER = 'u-keel-rt';
const MAILBOX = { key: `mailbox/${USER}`, kind: 'user', id: USER, name: 'KEEL-RT-mailbox@contoso.test', address: 'KEEL-RT-mailbox@contoso.test' };
const ROOT_FOLDER = 'msgfolderroot';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const RECEIVED = '2026-10-15T07:48:01.000Z';
const mime = (n, body = `Body ${n}`) => Buffer.from([
  `Message-ID: <KEEL-RT-${n}@contoso.test>`, 'From: KEEL-RT sender <sender@contoso.test>', 'To: KEEL-RT-mailbox@contoso.test',
  'Date: Wed, 15 Oct 2026 07:47:59 +0000', `Subject: KEEL-RT-${n}`, '', body, '',
].join('\r\n'));
/** The flags, received time and message id Exchange would show for a created message. */
const extended = (body, id) => body.singleValueExtendedProperties?.find((property) => property.id === id)?.value;

/**
 * One fixture mailbox behind both a Graph-reader-shaped fake (what the backup reads) and
 * a content-write-transport-shaped fake (what the restore writes). Every change moves the
 * object's changeKey.
 */
class FixtureMailbox {
  constructor() {
    this.seq = 0;
    this.folders = new Map();
    this.messages = new Map();
    this.calendars = new Map();
    this.events = new Map();
    this.contactFolders = new Map();
    this.contacts = new Map();
    this.lists = new Map();
    this.tasks = new Map();
    this.requests = [];
  }

  next(prefix) { this.seq++; return `${prefix}-${this.seq}`; }

  put(map, object) {
    const changeKey = this.next('ck');
    const held = { ...object, changeKey, '@odata.etag': `W/"${changeKey}"`, lastModifiedDateTime: new Date(Date.UTC(2026, 9, 1, 0, 0, this.seq)).toISOString() };
    map.set(object.id, held);
    return held;
  }

  addMessage(id, folderId, bytes, { isDraft = false } = {}) {
    const internetMessageId = /Message-ID: (\S+)/.exec(bytes.toString())?.[1] ?? null;
    return this.put(this.messages, { id, parentFolderId: folderId, internetMessageId, receivedDateTime: RECEIVED, isDraft, mime: bytes });
  }

  get writes() { return this.requests.filter((request) => request.method !== 'GET'); }

  reader() {
    const box = this;
    const page = (value, path) => ({ ok: true, status: 200, body: { value, '@odata.deltaLink': `https://graph.microsoft.com/v1.0${path}?$deltatoken=${box.seq}` } });
    const list = (value) => ({ ok: true, status: 200, body: { value } });
    const strip = ({ mime: _mime, ...rest }) => rest;
    return {
      async get(version, raw) {
        const url = new URL(raw.startsWith('http') ? raw : `https://graph.microsoft.com/${version}${raw}`);
        const full = url.pathname.replace(/^\/(v1\.0|beta)/, '');
        const path = full.replace(`/users/${USER}`, '');
        let m;
        if (path === '/mailFolders/delta') return page([...box.folders.values()], full);
        if ((m = /^\/mailFolders\/([^/]+)\/messages\/delta$/.exec(path))) {
          return page([...box.messages.values()].filter((message) => message.parentFolderId === m[1]).map(strip), full);
        }
        if (path === '/calendars') return list([...box.calendars.values()]);
        if ((m = /^\/calendars\/([^/]+)\/events$/.exec(path))) return list([...box.events.values()].filter((event) => event.calendarId === m[1]));
        if (path === '/contacts') return list([...box.contacts.values()].filter((contact) => contact.folderId === 'default'));
        if (path === '/contactFolders') return list([...box.contactFolders.values()].filter((folder) => !folder.parentFolderId));
        if ((m = /^\/contactFolders\/([^/]+)\/childFolders$/.exec(path))) return list([...box.contactFolders.values()].filter((folder) => folder.parentFolderId === m[1]));
        if ((m = /^\/contactFolders\/([^/]+)\/contacts$/.exec(path))) return list([...box.contacts.values()].filter((contact) => contact.folderId === m[1]));
        if (path === '/todo/lists/delta') return page([...box.lists.values()], full);
        if ((m = /^\/todo\/lists\/([^/]+)\/tasks\/delta$/.exec(path))) return page([...box.tasks.values()].filter((task) => task.listId === m[1]), full);
        return { ok: false, status: 404, code: 'ErrorItemNotFound' };
      },
      async getStream(version, path) {
        const id = /\/messages\/([^/]+)\/\$value$/.exec(path)?.[1];
        const message = box.messages.get(id);
        return message ? { ok: true, status: 200, bytes: message.mime } : { ok: false, status: 404 };
      },
    };
  }

  transport() {
    const box = this;
    const ok = (body, status = 201) => ({ status, headers: {}, body });
    const missing = { status: 404, headers: {}, body: { error: { code: 'ErrorItemNotFound' } } };
    return async (url, { method = 'GET', body, headers } = {}) => {
      box.requests.push({ method, url, body, headers });
      const parsed = new URL(url);
      assert.equal(parsed.hostname, 'graph.microsoft.com');
      const path = decodeURIComponent(parsed.pathname).replace(/^\/v1\.0/, '').replace(`/users/${USER}`, '');
      let m;
      const created = (map, object) => {
        return ok(box.put(map, { id: box.next('new'), ...object }));
      };
      if (method === 'GET') {
        if ((m = /^\/mailFolders\/([^/]+)\/messages$/.exec(path))) {
          const wanted = /internetMessageId eq '(.*)'/.exec(parsed.searchParams.get('$filter') ?? '')?.[1]?.replace(/''/g, "'");
          return ok({ value: [...box.messages.values()].filter((message) => message.parentFolderId === m[1] && message.internetMessageId === wanted).map(({ id }) => ({ id })) }, 200);
        }
        const lookups = [
          [/^\/mailFolders\/([^/]+)$/, box.folders], [/^\/messages\/([^/]+)$/, box.messages], [/^\/calendars\/([^/]+)$/, box.calendars],
          [/^\/events\/([^/]+)$/, box.events], [/^\/contactFolders\/([^/]+)$/, box.contactFolders], [/^\/contacts\/([^/]+)$/, box.contacts],
          [/^\/todo\/lists\/([^/]+)$/, box.lists], [/^\/todo\/lists\/[^/]+\/tasks\/([^/]+)$/, box.tasks],
        ];
        for (const [route, map] of lookups) {
          if ((m = route.exec(path))) return map.has(m[1]) ? ok(map.get(m[1]), 200) : missing;
        }
        return missing;
      }
      assert.equal(method, 'POST', 'a restore only ever creates');
      if (path === '/mailFolders') return created(box.folders, { displayName: body.displayName, parentFolderId: ROOT_FOLDER });
      if ((m = /^\/mailFolders\/([^/]+)\/childFolders$/.exec(path))) return created(box.folders, { displayName: body.displayName, parentFolderId: m[1] });
      if ((m = /^\/mailFolders\/([^/]+)\/messages$/.exec(path))) {
        if (typeof body === 'string') {
          // Graph stores a message created from MIME as a draft, dated now.
          assert.equal(headers?.['content-type'], 'text/plain');
          const bytes = Buffer.from(body, 'base64');
          const internetMessageId = /Message-ID: (\S+)/.exec(bytes.toString())?.[1] ?? null;
          return created(box.messages, { parentFolderId: m[1], internetMessageId, isDraft: true, receivedDateTime: 'now', mime: bytes });
        }
        const flags = extended(body, 'Integer 0x0E07');
        return created(box.messages, {
          parentFolderId: m[1], payload: body, subject: body.subject,
          isDraft: flags === undefined || (Number(flags) & 8) !== 0,
          receivedDateTime: extended(body, 'SystemTime 0x0E06') ?? 'now',
          internetMessageId: extended(body, 'String 0x1035') ?? null,
        });
      }
      if (path === '/calendars') return created(box.calendars, { name: body.name });
      if ((m = /^\/calendars\/([^/]+)\/events$/.exec(path))) return created(box.events, { ...body, calendarId: m[1] });
      if (path === '/contacts') return created(box.contacts, { ...body, folderId: 'default' });
      if (path === '/contactFolders') return created(box.contactFolders, { displayName: body.displayName, parentFolderId: null });
      if ((m = /^\/contactFolders\/([^/]+)\/childFolders$/.exec(path))) return created(box.contactFolders, { displayName: body.displayName, parentFolderId: m[1] });
      if ((m = /^\/contactFolders\/([^/]+)\/contacts$/.exec(path))) return created(box.contacts, { ...body, folderId: m[1] });
      if (path === '/todo/lists') return created(box.lists, { displayName: body.displayName });
      if ((m = /^\/todo\/lists\/([^/]+)\/tasks$/.exec(path))) return created(box.tasks, { ...body, listId: m[1] });
      throw new Error(`unexpected write ${method} ${path}`);
    };
  }
}

/** A mailbox with a folder tree, two messages, an event with an attendee, contacts and a task. */
function seeded() {
  const box = new FixtureMailbox();
  box.put(box.folders, { id: 'f-inbox', displayName: 'Inbox', parentFolderId: ROOT_FOLDER });
  box.put(box.folders, { id: 'f-projects', displayName: 'Projects', parentFolderId: 'f-inbox' });
  box.addMessage('m-1', 'f-inbox', mime(1));
  box.addMessage('m-2', 'f-projects', mime(2));
  box.put(box.calendars, { id: 'c-1', name: 'Calendar' });
  box.put(box.events, {
    id: 'e-1', calendarId: 'c-1', subject: 'KEEL-RT-meeting', body: { contentType: 'html', content: '<p>Agenda</p>' },
    start: { dateTime: '2026-10-20T09:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-10-20T10:00:00', timeZone: 'UTC' },
    attendees: [{ emailAddress: { address: 'someone@contoso.test' }, type: 'required' }], iCalUId: 'ical-1', webLink: 'https://outlook',
  });
  box.put(box.contacts, { id: 'p-1', folderId: 'default', displayName: 'KEEL-RT-Ada', givenName: 'Ada', emailAddresses: [{ address: 'ada@contoso.test' }] });
  box.put(box.contactFolders, { id: 'cf-1', displayName: 'Suppliers', parentFolderId: null });
  box.put(box.contacts, { id: 'p-2', folderId: 'cf-1', displayName: 'KEEL-RT-Bob', givenName: 'Bob' });
  box.put(box.lists, { id: 'l-1', displayName: 'Tasks' });
  box.put(box.tasks, { id: 't-1', listId: 'l-1', title: 'KEEL-RT-task', status: 'notStarted' });
  return box;
}

function clock(start = Date.UTC(2026, 9, 15, 8, 0, 0)) {
  let at = start;
  return { now: () => new Date(at), advance: (ms) => { at += ms; }, iso: () => new Date(at).toISOString() };
}

async function backup(box, store, time) {
  const result = await backupMailboxes(box.reader(), store, { tenantRef: TENANT, mailboxes: [MAILBOX], now: () => time.iso() });
  assert.equal(result.ok, true, JSON.stringify(result.mailboxes));
  return result;
}

async function runRestore(box, store, journal, request, time) {
  const plan = await planMailRestore(store, { tenantRef: TENANT, sourceMailboxId: USER, ...request });
  const report = await restoreMail({
    store, transport: box.transport(), journal, plan, target: { id: plan.request.targetMailboxId, names: [MAILBOX.address] },
    now: time.now, sleep: async () => {},
  });
  return { plan, report };
}

const childNamed = (box, map, name, parent) => [...map.values()].find((entry) => entry.displayName === name && (parent === undefined || entry.parentFolderId === parent));

test('round trip: back up, delete, restore into "Restored <date>"; messages come back received, not drafts', async () => {
  const box = seeded();
  const time = clock();
  const store = createMemoryContentStore({ now: time.now });
  await backup(box, store, time);
  time.advance(60_000);
  const at = time.iso();
  for (const map of [box.messages, box.events, box.contacts, box.tasks]) map.clear();

  const journal = createMemoryRestoreJournal();
  const { report } = await runRestore(box, store, journal, { at }, time);
  assert.equal(report.status, 'completed', JSON.stringify(report.errors));
  assert.equal(report.restored, 6);

  const restored = childNamed(box, box.folders, 'Restored 2026-10-15', ROOT_FOLDER);
  assert.ok(restored, 'a "Restored <date>" mail folder is created at the root');
  const inbox = childNamed(box, box.folders, 'Inbox', restored.id);
  const projects = childNamed(box, box.folders, 'Projects', inbox.id);
  assert.ok(inbox && projects, 'the folder tree is recreated under it');
  const inFolder = (folderId) => [...box.messages.values()].filter((message) => message.parentFolderId === folderId);
  const shape = (message) => ({
    subject: message.subject, isDraft: message.isDraft, receivedDateTime: message.receivedDateTime, internetMessageId: message.internetMessageId,
    from: message.payload.from, body: message.payload.body.content.trim(),
  });
  const from = { emailAddress: { name: 'KEEL-RT sender', address: 'sender@contoso.test' } };
  assert.deepEqual(inFolder(inbox.id).map(shape), [{ subject: 'KEEL-RT-1', isDraft: false, receivedDateTime: RECEIVED, internetMessageId: '<KEEL-RT-1@contoso.test>', from, body: 'Body 1' }]);
  assert.deepEqual(inFolder(projects.id).map(shape), [{ subject: 'KEEL-RT-2', isDraft: false, receivedDateTime: RECEIVED, internetMessageId: '<KEEL-RT-2@contoso.test>', from, body: 'Body 2' }]);
  assert.equal(extended(inFolder(inbox.id)[0].payload, 'SystemTime 0x0039'), '2026-10-15T07:47:59.000Z', 'the sent time is kept');

  const [event] = box.events.values();
  assert.equal(event.subject, 'KEEL-RT-meeting');
  assert.equal(event.attendees, undefined, 'no attendee is invited again');
  assert.match(event.body.content, /Original attendees \(not invited again\): someone@contoso\.test/);
  assert.equal(event.iCalUId, undefined, 'read-only fields are not sent');
  assert.equal(box.calendars.get(event.calendarId).name, 'Restored 2026-10-15 - Calendar');

  const contactsRoot = childNamed(box, box.contactFolders, 'Restored 2026-10-15', null);
  const suppliers = childNamed(box, box.contactFolders, 'Suppliers', contactsRoot.id);
  const contacts = [...box.contacts.values()];
  assert.deepEqual(contacts.map((contact) => [contact.displayName, contact.folderId]).sort(), [['KEEL-RT-Ada', contactsRoot.id], ['KEEL-RT-Bob', suppliers.id]]);

  const [task] = box.tasks.values();
  assert.equal(task.title, 'KEEL-RT-task');
  assert.equal(box.lists.get(task.listId).displayName, 'Restored 2026-10-15 - Tasks');
  assert.ok(box.writes.every((request) => request.url.startsWith(`https://graph.microsoft.com/v1.0/users/${USER}/`)));
});

test('a second run of the same restore writes nothing', async () => {
  const box = seeded();
  const time = clock();
  const store = createMemoryContentStore({ now: time.now });
  await backup(box, store, time);
  time.advance(60_000);
  const at = time.iso();
  box.messages.clear();
  const journal = createMemoryRestoreJournal();
  const first = await runRestore(box, store, journal, { at }, time);
  assert.equal(first.report.status, 'completed');
  const writes = box.writes.length;
  time.advance(24 * 60 * 60_000);
  const second = await runRestore(box, store, journal, { at }, time);
  assert.equal(second.plan.runId, first.plan.runId, 'the same request resumes the same run');
  assert.equal(box.writes.length, writes, 'no write on the second run');
  assert.equal(second.report.restored, 0);
  assert.equal(second.report.alreadyDone, first.report.restored);
  assert.equal(second.report.label, 'Restored 2026-10-15', 'the resumed run keeps its first label');
});

test('into the original folders, a newer live item is left untouched and a deleted one comes back', async () => {
  const box = seeded();
  const time = clock();
  const store = createMemoryContentStore({ now: time.now });
  await backup(box, store, time);
  time.advance(60_000);
  const at = time.iso();
  const newer = box.addMessage('m-1', 'f-inbox', mime(1, 'edited after the backup'));
  box.messages.delete('m-2');

  const journal = createMemoryRestoreJournal();
  const { report } = await runRestore(box, store, journal, { at, into: 'original', kinds: ['mail'] }, time);
  assert.equal(report.status, 'completed', JSON.stringify(report.errors));
  assert.equal(report.kept.newer, 1);
  assert.equal(report.restored, 1);
  assert.deepEqual(box.messages.get('m-1'), newer, 'the newer live message is unchanged');
  const back = [...box.messages.values()].filter((message) => message.parentFolderId === 'f-projects');
  assert.equal(back.length, 1, 'the deleted message is back in its original folder');
  assert.equal(back[0].subject, 'KEEL-RT-2');
  assert.equal(back[0].isDraft, false);
  assert.equal(back[0].receivedDateTime, RECEIVED);
  assert.equal(box.writes.length, 1, 'only the missing message is written; no folder is created');
  assert.equal(childNamed(box, box.folders, 'Restored 2026-10-15'), undefined);
});

test('into the original folders, an unchanged live item is reported unchanged', async () => {
  const box = seeded();
  const time = clock();
  const store = createMemoryContentStore({ now: time.now });
  await backup(box, store, time);
  time.advance(60_000);
  const { report } = await runRestore(box, store, createMemoryRestoreJournal(), { at: time.iso(), into: 'original', kinds: ['contacts'] }, time);
  assert.equal(report.kept.unchanged, 2);
  assert.equal(box.writes.length, 0);
});

test('a message whose response was lost is found by its internet id on resume, not written twice', async () => {
  const box = seeded();
  const time = clock();
  const store = createMemoryContentStore({ now: time.now });
  await backup(box, store, time);
  time.advance(60_000);
  const at = time.iso();
  box.messages.clear();
  const journal = createMemoryRestoreJournal();

  const plan = await planMailRestore(store, { tenantRef: TENANT, sourceMailboxId: USER, at, kinds: ['mail'] });
  const send = box.transport();
  let lost = false;
  const flaky = async (url, options) => {
    const res = await send(url, options);
    if (!lost && options?.method === 'POST' && /\/messages$/.test(url)) { lost = true; throw new Error('connection reset'); }
    return res;
  };
  const interrupted = await restoreMail({ store, transport: flaky, journal, plan, target: { id: USER }, now: time.now, sleep: async () => {} });
  assert.equal(interrupted.failed, 1);
  assert.equal(interrupted.status, 'partial');
  const writes = box.writes.length;
  const resumed = await restoreMail({ store, transport: box.transport(), journal, plan, target: { id: USER }, now: time.now, sleep: async () => {} });
  assert.equal(resumed.status, 'completed');
  assert.equal(box.messages.size, 2, 'each message exists once');
  assert.equal(box.writes.length, writes, 'the resume found the sent message instead of writing it again');
  assert.equal(resumed.restored, 1);
  assert.equal(resumed.alreadyDone, 1);
});

test('a point in time restores the version held then, and leaves out what did not exist yet', async () => {
  const box = seeded();
  const time = clock();
  const store = createMemoryContentStore({ now: time.now });
  await backup(box, store, time);
  time.advance(60_000);
  const at = time.iso();
  time.advance(60_000);
  box.put(box.contacts, { ...box.contacts.get('p-1'), displayName: 'KEEL-RT-Ada renamed' });
  box.put(box.contacts, { id: 'p-3', folderId: 'default', displayName: 'KEEL-RT-Later' });
  await backup(box, store, time);
  box.contacts.clear();

  const { report } = await runRestore(box, store, createMemoryRestoreJournal(), { at, kinds: ['contacts'], selection: { kind: 'contacts', folderId: 'default' } }, time);
  assert.equal(report.status, 'completed');
  assert.deepEqual([...box.contacts.values()].map((contact) => contact.displayName), ['KEEL-RT-Ada']);
});

test('one item restores alone', async () => {
  const box = seeded();
  const time = clock();
  const store = createMemoryContentStore({ now: time.now });
  await backup(box, store, time);
  time.advance(60_000);
  box.messages.clear();
  const { report } = await runRestore(box, store, createMemoryRestoreJournal(), { at: time.iso(), selection: { kind: 'mail', folderId: 'f-projects', itemKey: 'm-2' } }, time);
  assert.equal(report.restored, 1);
  const restored = childNamed(box, box.folders, 'Restored 2026-10-15', ROOT_FOLDER);
  const projects = childNamed(box, box.folders, 'Projects', restored.id);
  assert.ok(projects, 'the item goes under "Restored <date>/<its folder>"');
  assert.deepEqual([...box.messages.values()].map((message) => message.parentFolderId), [projects.id]);
});

test('a backed-up draft is restored from its MIME as is, and stays a draft', async () => {
  const box = seeded();
  box.addMessage('m-3', 'f-inbox', mime(3), { isDraft: true });
  const time = clock();
  const store = createMemoryContentStore({ now: time.now });
  await backup(box, store, time);
  time.advance(60_000);
  box.messages.clear();
  const { report } = await runRestore(box, store, createMemoryRestoreJournal(), { at: time.iso(), kinds: ['mail'] }, time);
  assert.equal(report.status, 'completed', JSON.stringify(report.errors));
  const restored = [...box.messages.values()];
  assert.deepEqual(restored.map((message) => [message.internetMessageId, message.isDraft]).sort(), [
    ['<KEEL-RT-1@contoso.test>', false], ['<KEEL-RT-2@contoso.test>', false], ['<KEEL-RT-3@contoso.test>', true],
  ]);
  assert.equal(sha(restored.find((message) => message.isDraft).mime), sha(mime(3)), 'the draft keeps its MIME byte for byte');
  assert.deepEqual(report.incomplete, [], 'a draft restored as a draft is not a gap');
});

test('a signed message keeps its MIME and is reported as restored as a draft', async () => {
  const box = new FixtureMailbox();
  box.put(box.folders, { id: 'f-inbox', displayName: 'Inbox', parentFolderId: ROOT_FOLDER });
  box.addMessage('m-s', 'f-inbox', Buffer.from('Message-ID: <KEEL-RT-s@contoso.test>\r\nContent-Type: multipart/signed; boundary="b"; protocol="application/pkcs7-signature"\r\n\r\n--b\r\n\r\nhi\r\n--b--\r\n'));
  const time = clock();
  const store = createMemoryContentStore({ now: time.now });
  await backup(box, store, time);
  time.advance(60_000);
  box.messages.clear();
  const { report } = await runRestore(box, store, createMemoryRestoreJournal(), { at: time.iso(), kinds: ['mail'] }, time);
  assert.equal(report.restored, 1);
  assert.deepEqual(report.incomplete, [{ kind: 'mail', itemKey: 'm-s', missing: ['received-state'], reason: 'restored as a draft: signed or encrypted' }]);
  assert.equal([...box.messages.values()][0].isDraft, true);
});

test('a message held without MIME is reported, not restored', async () => {
  const box = seeded();
  const time = clock();
  const store = createMemoryContentStore({ now: time.now });
  const tooBig = box.reader();
  const reader = { ...tooBig, getStream: async (version, path) => (path.includes('m-1') ? { ok: true, status: 200, tooLarge: true } : tooBig.getStream(version, path)) };
  await backupMailboxes(reader, store, { tenantRef: TENANT, mailboxes: [MAILBOX], now: () => time.iso() });
  time.advance(60_000);
  const plan = await planMailRestore(store, { tenantRef: TENANT, sourceMailboxId: USER, at: time.iso(), kinds: ['mail'] });
  assert.deepEqual(plan.skipped.map((skip) => skip.itemKey), ['m-1']);
  assert.deepEqual(plan.items.map((item) => item.itemKey), ['m-2']);
});

test('throttled writes wait and retry', async () => {
  const box = seeded();
  const time = clock();
  const store = createMemoryContentStore({ now: time.now });
  await backup(box, store, time);
  time.advance(60_000);
  box.messages.clear();
  const send = box.transport();
  let throttled = 0;
  const waits = [];
  const transport = async (url, options) => {
    if (options?.method === 'POST' && throttled < 2) { throttled++; return { status: 429, headers: { 'retry-after': '3' }, body: null }; }
    return send(url, options);
  };
  const plan = await planMailRestore(store, { tenantRef: TENANT, sourceMailboxId: USER, at: time.iso(), kinds: ['mail'] });
  const report = await restoreMail({ store, transport, journal: createMemoryRestoreJournal(), plan, target: { id: USER }, now: time.now, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(report.status, 'completed');
  assert.deepEqual(waits, [3000, 3000]);
});

test('a restore never writes outside the planned target', async () => {
  const box = seeded();
  const time = clock();
  const store = createMemoryContentStore({ now: time.now });
  await backup(box, store, time);
  time.advance(60_000);
  const plan = await planMailRestore(store, { tenantRef: TENANT, sourceMailboxId: USER, at: time.iso() });
  await assert.rejects(restoreMail({ store, transport: box.transport(), journal: createMemoryRestoreJournal(), plan, target: { id: 'someone-else' }, now: time.now }), /not the mailbox the plan restores to/);
  const tampered = { ...plan, request: { ...plan.request, targetMailboxId: 'someone-else' } };
  await assert.rejects(restoreMail({ store, transport: box.transport(), journal: createMemoryRestoreJournal(), plan: tampered, target: { id: 'someone-else' }, now: time.now }), /does not match its run id/);
  assert.equal(box.writes.length, 0);
});

test('requests are checked and their run id is stable', () => {
  const base = { tenantRef: TENANT, sourceMailboxId: USER, at: '2026-10-15T08:00:00.000Z' };
  assert.equal(mailRestoreRunId(base), mailRestoreRunId({ ...base, kinds: ['todo', 'contacts', 'calendar', 'mail'] }));
  assert.notEqual(mailRestoreRunId(base), mailRestoreRunId({ ...base, targetMailboxId: 'u-other' }));
  assert.throws(() => normalizeMailRestoreRequest({ ...base, into: 'original', targetMailboxId: 'u-other' }), /must target the source mailbox/);
  assert.throws(() => normalizeMailRestoreRequest({ ...base, at: undefined }), /point in time/);
  assert.throws(() => normalizeMailRestoreRequest({ ...base, kinds: ['files'] }), /kinds/);
});

test('on the test tenant, only KEEL-RT- mailboxes are restore targets', () => {
  const testTenantRefs = [TENANT];
  assert.deepEqual(targetProblems({ tenantRef: TENANT, names: ['KEEL-RT-mailbox@contoso.test'], testTenantRefs }), []);
  assert.deepEqual(targetProblems({ tenantRef: TENANT, names: ['Alex', 'keel-rt-alex@contoso.test'], testTenantRefs }), []);
  assert.match(targetProblems({ tenantRef: TENANT, names: ['Alex Wilber', 'alexw@contoso.test'], testTenantRefs })[0], /only to KEEL-RT- targets/);
  assert.deepEqual(targetProblems({ tenantRef: 'sha256:other', names: ['Alex Wilber'], testTenantRefs }), []);
});
