/**
 * Wave 1 MAIL: finds every mailbox in the tenant and backs each one up into the content
 * store: user and shared mailboxes (mail, calendars, contacts, tasks), their online
 * archives, and Microsoft 365 Group mailboxes (calendar; Group conversations are the
 * PLANNER package's).
 *
 * The content store is the Wave 1 interface (putItem / getItem / listItems). This module
 * returns the sync state for the caller to persist and hand back on the next run, so a
 * second run reads only what changed.
 *
 * Rules:
 *  - Read-only: GET routes only (see exchangeMail.mjs).
 *  - Nothing readable is skipped. A user with no Exchange mailbox is reported as such, not
 *    dropped silently; an unreadable mailbox type or archive lookup is reported with the
 *    Graph answer.
 *  - `match` narrows a run to mailboxes whose name or address starts with a prefix (the
 *    operator's live check uses `KEEL-RT-`). Matching is on the prefix only.
 */
import { describe, readOnlyReader, seg, syncArchiveMailbox, syncMailboxMail } from './exchangeMail.mjs';
import { listAll, syncMailboxItems } from './exchangeItems.mjs';

export const MAILBOX_KINDS = Object.freeze(['user', 'shared', 'room', 'equipment', 'group', 'archive']);

function matches(prefix, ...names) {
  if (!prefix) return true;
  const wanted = prefix.toLowerCase();
  return names.some((name) => typeof name === 'string' && name.toLowerCase().startsWith(wanted));
}

const KIND_BY_PURPOSE = { user: 'user', shared: 'shared', room: 'room', equipment: 'equipment', linked: 'user' };

/**
 * Lists the mailboxes to back up. Returns { mailboxes, skipped, errors }:
 *  - mailboxes: { key, kind, id, name, address, archiveMailboxId? }
 *  - skipped: users without an Exchange mailbox, with the reason
 *  - errors: listings or lookups that failed, with the Graph answer
 */
export async function discoverMailboxes(rawReader, { match = null } = {}) {
  const reader = readOnlyReader(rawReader);
  const mailboxes = [];
  const skipped = [];
  const errors = [];

  const users = await listAll(reader, 'v1.0', '/users?$select=id,displayName,userPrincipalName,mail');
  if (!users.ok) errors.push({ route: 'users', error: users.error });
  for (const user of users.items) {
    if (!matches(match, user.displayName, user.userPrincipalName, user.mail)) continue;
    const name = user.userPrincipalName ?? user.displayName ?? user.id;
    if (!user.mail) {
      skipped.push({ id: user.id, name, reason: 'no mail address' });
      continue;
    }
    const settings = await reader.get('v1.0', `/users/${seg(user.id)}/mailboxSettings/userPurpose`);
    if (!settings?.ok) {
      if (settings?.code === 'MailboxNotEnabledForRESTAPI' || settings?.status === 404) {
        skipped.push({ id: user.id, name, reason: 'no Exchange Online mailbox' });
      } else {
        errors.push({ route: 'mailboxSettings', id: user.id, error: describe(settings) });
      }
      continue;
    }
    const purpose = settings.body?.value ?? settings.body?.userPurpose ?? 'user';
    const kind = KIND_BY_PURPOSE[purpose] ?? 'user';
    const mailbox = { key: `mailbox/${user.id}`, kind, id: user.id, name, address: user.mail };
    mailboxes.push(mailbox);

    const exchange = await reader.get('beta', `/users/${seg(user.id)}/settings/exchange`);
    if (exchange?.ok) {
      const archiveMailboxId = exchange.body?.archiveMailboxId;
      if (archiveMailboxId) {
        mailboxes.push({ key: `archive/${user.id}`, kind: 'archive', id: user.id, name, address: user.mail, archiveMailboxId });
      }
    } else if (exchange?.status !== 404) {
      errors.push({ route: 'settings/exchange', id: user.id, error: describe(exchange) });
    }
  }

  const groups = await listAll(reader, 'v1.0', "/groups?$filter=groupTypes/any(c:c eq 'Unified')&$select=id,displayName,mail");
  if (!groups.ok) errors.push({ route: 'groups', error: groups.error });
  for (const group of groups.items) {
    if (!matches(match, group.displayName, group.mail)) continue;
    mailboxes.push({ key: `group/${group.id}`, kind: 'group', id: group.id, name: group.displayName ?? group.id, address: group.mail ?? null });
  }
  return { mailboxes, skipped, errors };
}

/**
 * Backs up every mailbox discovered (or the ones given). `state` is the previous run's
 * returned state ({ [mailbox.key]: { mail, items } }). Returns { state, mailboxes, skipped,
 * errors, ok } with one report per mailbox.
 */
export async function backupMailboxes(rawReader, store, { tenantRef, state = {}, match = null, mailboxes = null, now } = {}) {
  if (!tenantRef) throw new TypeError('backupMailboxes needs a tenantRef');
  for (const method of ['putItem', 'getItem', 'listItems']) {
    if (typeof store?.[method] !== 'function') throw new TypeError(`the content store has no ${method}()`);
  }
  const reader = readOnlyReader(rawReader);
  const found = mailboxes ? { mailboxes, skipped: [], errors: [] } : await discoverMailboxes(reader, { match });
  const nextState = { ...state };
  const reports = [];
  for (const mailbox of found.mailboxes) {
    const previous = state[mailbox.key] ?? {};
    const options = { tenantRef, mailbox, now: now ?? (() => new Date().toISOString()) };
    const report = { key: mailbox.key, kind: mailbox.kind, name: mailbox.name };
    if (mailbox.kind === 'archive') {
      const mail = await syncArchiveMailbox(reader, store, { ...options, state: previous.mail });
      nextState[mailbox.key] = { mail: mail.state };
      Object.assign(report, { mail: mail.report, ok: mail.report.ok });
    } else if (mailbox.kind === 'group') {
      const items = await syncMailboxItems(reader, store, { ...options, state: previous.items });
      nextState[mailbox.key] = { items: items.state };
      Object.assign(report, { items: items.report, conversations: 'PLANNER', ok: items.report.ok });
    } else {
      const mail = await syncMailboxMail(reader, store, { ...options, state: previous.mail });
      const items = await syncMailboxItems(reader, store, { ...options, state: previous.items });
      nextState[mailbox.key] = { mail: mail.state, items: items.state };
      Object.assign(report, { mail: mail.report, items: items.report, ok: mail.report.ok && items.report.ok });
    }
    reports.push(report);
  }
  return {
    state: nextState,
    mailboxes: reports,
    skipped: found.skipped,
    errors: found.errors,
    ok: found.errors.length === 0 && reports.every((report) => report.ok),
  };
}
