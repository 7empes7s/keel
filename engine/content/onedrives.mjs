/**
 * Every user's OneDrive, backed up through the drive sync (./drive.mjs). Lists the
 * tenant's users, finds each one's drive (GET /users/{id}/drive) and syncs it, keeping
 * each drive's delta state in the content sync state between runs.
 *
 * - A user without a OneDrive (Graph answers 404), or whose OneDrive Microsoft 365 has
 *   locked (423: an admin lock, or a lapsed licence leaving it read-only or pending
 *   deletion), is reported as skipped, not failed. Keel cannot read either.
 * - `namePrefix` narrows the run to users whose display name, sign-in name or mail
 *   starts with it (the operator's live check uses `KEEL-RT-`). Matching is on the prefix only.
 * - Read-only: every request goes through the GET-only content transport.
 */
import { DriveSyncError, resolveUserDrive, syncDrive } from './drive.mjs';
import { driveTransport, GRAPH_ORIGIN } from './collectorTransports.mjs';

export const ONEDRIVE_WORKLOAD = 'onedrive';
const USERS_URL = `${GRAPH_ORIGIN}/v1.0/users?$select=id,displayName,userPrincipalName,mail&$top=999`;
const DEFAULT_MAX_PAGES = 1000;
const DEFAULT_MAX_RETRIES = 5;

function matches(prefix, ...names) {
  if (!prefix) return true;
  const wanted = prefix.toLowerCase();
  return names.some((name) => typeof name === 'string' && name.toLowerCase().startsWith(wanted));
}

const errorText = (error) => String(error?.message ?? error);

async function listUsers(send, { sleep, maxPages, maxRetries }) {
  const users = [];
  let next = USERS_URL;
  for (let pages = 0; next; pages += 1) {
    if (pages >= maxPages) return { users, error: `more than ${maxPages} pages of users; the rest was not read` };
    if (new URL(next).origin !== GRAPH_ORIGIN) return { users, error: 'the user listing pointed outside Microsoft Graph' };
    let response;
    for (let attempt = 0; ; attempt += 1) {
      response = await send({ method: 'GET', url: next });
      if (![429, 503].includes(response?.status) || attempt >= maxRetries) break;
      const seconds = Number(response.headers?.['retry-after']);
      await sleep(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempt * 1000);
    }
    if (!(response?.status >= 200 && response.status < 300)) {
      return { users, error: `listing users answered HTTP ${response?.status}${response?.body?.error?.code ? ` ${response.body.error.code}` : ''}` };
    }
    users.push(...(response.body?.value ?? []));
    next = response.body?.['@odata.nextLink'] ?? null;
  }
  return { users, error: null };
}

/**
 * Returns { outcome: 'succeeded' | 'partial' | 'failed', drives, skipped, errors }.
 * syncState: { load({ tenantRef, workload, key }), save({ ..., state }) } (./syncState.mjs).
 */
export async function backupOneDrives({
  transport, store, tenantRef, syncState, namePrefix = null,
  sleep = async () => {}, now = () => new Date(), maxPages = DEFAULT_MAX_PAGES, maxRetries = DEFAULT_MAX_RETRIES,
}) {
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('tenantRef is required');
  if (typeof syncState?.load !== 'function' || typeof syncState?.save !== 'function') throw new TypeError('syncState is required');
  const send = driveTransport(transport);
  const listed = await listUsers(send, { sleep, maxPages, maxRetries });
  const drives = [];
  const skipped = [];
  const errors = listed.error ? [{ step: 'users', error: listed.error }] : [];

  for (const user of listed.users) {
    if (!matches(namePrefix, user.displayName, user.userPrincipalName, user.mail)) continue;
    const name = user.userPrincipalName ?? user.displayName ?? user.id;
    let drive;
    try {
      drive = await resolveUserDrive({ transport: send, userId: user.id, sleep, maxRetries });
    } catch (error) {
      if (error instanceof DriveSyncError && error.status === 404) skipped.push({ userId: user.id, name, reason: 'no OneDrive' });
      else if (error instanceof DriveSyncError && error.status === 423) skipped.push({ userId: user.id, name, reason: 'OneDrive locked in Microsoft 365', locked: true });
      else errors.push({ userId: user.id, name, step: 'drive', error: errorText(error) });
      continue;
    }
    const ref = { tenantRef, workload: ONEDRIVE_WORKLOAD, key: `drive:${drive.driveId}` };
    try {
      const { stats } = await syncDrive({
        transport: send, store, driveId: drive.driveId, tenantRef, workload: ONEDRIVE_WORKLOAD,
        state: await syncState.load(ref),
        checkpoint: (state) => syncState.save({ ...ref, state }),
        sleep, now,
      });
      drives.push({ userId: user.id, name, driveId: drive.driveId, outcome: stats.warnings.length ? 'partial' : 'succeeded', stats });
    } catch (error) {
      drives.push({ userId: user.id, name, driveId: drive.driveId, outcome: 'failed', error: errorText(error) });
      errors.push({ userId: user.id, name, step: 'sync', error: errorText(error) });
    }
  }

  // Every OneDrive found is locked: nothing was read, which is not a success.
  const locked = skipped.filter((drive) => drive.locked).length;
  if (locked > 0 && drives.length === 0 && errors.length === 0) {
    errors.push({ step: 'drive', name: 'OneDrives', error: `all ${locked} OneDrive(s) found are locked in Microsoft 365; nothing was read` });
  }
  let outcome = 'succeeded';
  const synced = drives.filter((drive) => drive.outcome !== 'failed').length;
  if ((listed.error && listed.users.length === 0) || (errors.length > 0 && synced === 0)) outcome = 'failed';
  else if (errors.length > 0 || drives.some((drive) => drive.outcome !== 'succeeded')) outcome = 'partial';
  return { outcome, drives, skipped, errors };
}
