/**
 * File and list restore (Wave 2, package FILER): put backed-up OneDrive and SharePoint
 * content back, at a chosen point in time or version, to where it was or to another
 * place.
 *
 * What it restores, from what the Wave 1 collectors stored (engine/content/drive.mjs,
 * engine/content/sharepointSites.mjs):
 *  - A file, a folder, or a whole library or OneDrive: the drive records
 *    (`metadata.kind = 'drive-record'`) give each item's name, parent and stored content
 *    versions; the content comes from the store by ref. Each file is restored at the
 *    version that was current at `at` (or the `version` asked for, for one file), under
 *    the name it had then, so a file renamed since comes back under its old name.
 *  - A list: its columns (custom ones the target lacks are added) and its items' field
 *    values, as they were at `at`.
 *
 * Never overwrites newer work unless asked. `conflict` decides what happens when the
 * target already holds something different at the same path (or item id):
 *  - 'copy' (default): the restored file goes next to it as
 *    "<name> (restored <yyyy-mm-dd>)<ext>", dated by the restored version, and a list
 *    item is added as a new item. The live one is never touched.
 *  - 'replace': replaced only when the live one is not newer than what is restored;
 *    a newer live one is kept and the restore falls back to a copy.
 *  - 'replace-newer': replaced even when newer (an explicit ask).
 * Something identical to what would be written is skipped (files compare by size and
 * Graph's quickXorHash of the restored bytes; list items by their writable field values),
 * so a second run of the same restore writes nothing.
 *
 * Writes only after two checks:
 *  - The target guard. By default ('test-tenant') the target site, library or drive
 *    must carry the KEEL-RT- prefix; another rule has to be passed in as a function.
 *  - The gate: `gate({ capability: 'content-restore', action, runKey, summary })` must
 *    resolve to an approval ({ approvalId }); it throws or returns nothing to refuse.
 *    The action is 'content-restore', or 'content-restore-other-location' when the
 *    target is not the original place (the approval policy can ask two people for it).
 * A dry run plans with GETs only and needs neither.
 *
 * Sharing permissions are restored only with `permissions: true`, and only direct
 * grants to users and groups that still exist; inherited grants, owners and sharing
 * links are reported, not recreated. No invitation mail is sent.
 *
 * Resuming. `runKey` is a hash of the request, so the same request has the same key and
 * opens the same journal run (./journal.mjs). Each step is marked pending before its write
 * and restored, skipped or failed after; a rerun skips steps the journal holds as restored
 * or skipped and re-plans the rest against the live target, so nothing is written twice.
 *
 * Interfaces (injected):
 *   store:         the content store (engine/content/store.mjs): getItem(ref), listItems(...).
 *   transport:     the content write transport (./transport.mjs):
 *                  transport(url, { method, body, headers }) -> { status, headers, body }.
 *                  It also sends the chunks of an upload session it opened: bytes with a
 *                  Content-Range, PUT to the SharePoint uploadUrl, with no token.
 *   journal:       the content restore journal (./journal.mjs).
 */
import { createHash } from 'node:crypto';

export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const GRAPH = `${GRAPH_ORIGIN}/v1.0`;
export const TEST_TARGET_PREFIX = 'KEEL-RT-';
export const CONFLICT_MODES = Object.freeze(['copy', 'replace', 'replace-newer']);
export const FILE_WORKLOADS = Object.freeze(['onedrive', 'sharepoint', 'sharepoint-sites']);
export const LIST_WORKLOAD = 'sharepoint-sites';
// Graph's simple upload takes up to 4 MiB; anything larger goes through an upload
// session, in chunks that must be a multiple of 320 KiB.
export const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 10 * 320 * 1024;
export const DEFAULT_MAX_RETRIES = 5;

const RETRY_STATUSES = new Set([429, 503, 504]);
// List fields that are not the user's data: SharePoint keeps and sets these itself.
const SYSTEM_FIELDS = new Set([
  'id', 'ContentType', 'Modified', 'Created', 'Attachments', 'Edit', 'LinkTitle', 'LinkTitleNoMenu', 'DocIcon',
  'ItemChildCount', 'FolderChildCount', 'FileLeafRef', 'FileRef', 'FileDirRef', 'FileSizeDisplay', 'ContentTypeId',
]);
// Column kinds whose values are ids that mean nothing in another list or site.
const UNPORTABLE_COLUMN_KINDS = ['lookup', 'personOrGroup', 'calculated', 'term', 'thumbnail', 'contentApprovalStatus'];
const COLUMN_KINDS = ['text', 'number', 'choice', 'boolean', 'dateTime', 'currency', 'hyperlinkOrPicture'];
const COLUMN_FIELDS = ['name', 'displayName', 'description', 'enforceUniqueValues', 'hidden', 'indexed', 'required', 'defaultValue'];

export class FilesRestoreError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'FilesRestoreError';
    this.status = status;
    this.url = url;
  }
}

/** A refusal: the target guard, the gate, or a request outside what may be restored. */
export class FilesRestoreRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'FilesRestoreRefused';
  }
}

/**
 * Graph's quickXorHash (the hash OneDrive and SharePoint report in file.hashes): a
 * 160-bit value where each byte is XORed in 11 bits after the previous one, wrapping
 * round, with the length XORed into the last 64 bits. Returned base64, as Graph does.
 */
export function createQuickXorHash() {
  const cells = new Uint8Array(20);
  let shift = 0;
  let length = 0;
  return {
    update(data) {
      const bytes = typeof data === 'string' ? Buffer.from(data) : data;
      for (let k = 0; k < bytes.length; k += 1) {
        const value = bytes[k];
        if (value) {
          const index = shift >> 3;
          const offset = shift & 7;
          cells[index] ^= (value << offset) & 0xff;
          if (offset) cells[(index + 1) % 20] ^= value >> (8 - offset);
        }
        shift = (shift + 11) % 160;
      }
      length += bytes.length;
      return this;
    },
    digest() {
      const out = Buffer.from(cells);
      let rest = BigInt(length);
      for (let k = 0; k < 8; k += 1) {
        out[12 + k] ^= Number(rest & 0xffn);
        rest >>= 8n;
      }
      return out.toString('base64');
    },
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonical(value[name])]));
  }
  return value;
}

const hashOf = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** The stable key of one restore request: the same ask resumes the same run. */
export function restoreRunKey(request) {
  return `files:${hashOf(request).slice(0, 32)}`;
}

const isoOrNull = (at) => {
  if (at === null || at === undefined || at === '') return null;
  const time = new Date(at);
  if (!Number.isFinite(time.valueOf())) throw new TypeError('at must be a date');
  return time.toISOString();
};

/** A file restore request in its one canonical shape; its run key is restoreRunKey(request). */
export function filesRestoreRequest({ source, scope, at = null, version = null, target = null, conflict = 'copy', permissions = false }) {
  return {
    kind: 'files',
    source: { tenantRef: source?.tenantRef ?? null, workload: source?.workload ?? null, container: source?.container ?? null, driveId: source?.driveId ?? null },
    scope: scope?.kind === 'drive' ? { kind: 'drive' } : { kind: scope?.kind ?? null, itemId: scope?.itemId ?? null },
    at: isoOrNull(at),
    version: version ?? null,
    target: target ? { driveId: target.driveId ?? null, folderPath: target.folderPath ?? null } : null,
    conflict,
    permissions: Boolean(permissions),
  };
}

/** A list restore request in its one canonical shape. */
export function listRestoreRequest({ source, at = null, target = null, itemIds = null, conflict = 'copy' }) {
  return {
    kind: 'list',
    source: { tenantRef: source?.tenantRef ?? null, siteId: source?.siteId ?? null, listId: source?.listId ?? null },
    at: isoOrNull(at),
    target: target ? { siteId: target.siteId ?? null, listId: target.listId ?? null, listName: target.listName ?? null } : null,
    itemIds: itemIds ? [...new Set(itemIds.map(String))].sort() : null,
    conflict,
  };
}

const enc = encodeURIComponent;
const encPath = (path) => path.split('/').filter(Boolean).map(enc).join('/');
const parentOf = (path) => path.split('/').filter(Boolean).slice(0, -1).join('/');
const joinPath = (...parts) => parts.flatMap((part) => String(part ?? '').split('/')).filter(Boolean).join('/');

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** "report.docx" restored from 2026-10-12 -> "report (restored 2026-10-12).docx". */
export function copyName(name, date, attempt = 1) {
  const day = (date ? new Date(date) : null)?.toISOString?.().slice(0, 10) ?? 'backup';
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  return `${base} (restored ${day}${attempt > 1 ? ` ${attempt}` : ''})${ext}`;
}

/** Throttling-aware Graph calls over the injected transport. */
function graphClient(transport, { sleep, maxRetries, stats }) {
  if (typeof transport !== 'function') throw new TypeError('transport must be a function');
  async function send(method, url, { headers = {}, body, upload = false } = {}) {
    if (!upload && !url.startsWith(`${GRAPH_ORIGIN}/`)) throw new FilesRestoreRefused(`refused a request outside Graph: ${url}`);
    for (let attempt = 0; ; attempt += 1) {
      const options = { method, headers };
      if (body !== undefined) options.body = body;
      const response = await transport(url, options);
      if (method !== 'GET') stats.writes += 1;
      if (!RETRY_STATUSES.has(response?.status)) return response;
      stats.throttled += 1;
      if (attempt >= maxRetries) throw new FilesRestoreError(`still throttled after ${maxRetries} retries`, { status: response.status, url });
      const seconds = Number(response.headers?.['retry-after']);
      await sleep(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempt * 1000);
    }
  }
  const ok = (response, url) => {
    if (response?.status >= 200 && response.status < 300) return response.body ?? {};
    const code = response?.body?.error?.code;
    throw new FilesRestoreError(`HTTP ${response?.status}${code ? ` ${code}` : ''} for ${url.split('?')[0]}`, { status: response?.status ?? null, url });
  };
  return {
    send,
    async get(url) { return ok(await send('GET', url), url); },
    // null when the thing does not exist.
    async find(url) {
      const response = await send('GET', url);
      if (response?.status === 404) return null;
      return ok(response, url);
    },
    async json(method, url, body) {
      return ok(await send(method, url, { body }), url);
    },
    async all(url) {
      const values = [];
      const base = new URL(url).pathname.toLowerCase();
      for (let link = url; link;) {
        if (new URL(link).pathname.toLowerCase() !== base) throw new FilesRestoreRefused(`refused a next page outside ${base}`);
        const page = await this.get(link);
        values.push(...(page.value ?? []));
        link = page['@odata.nextLink'] ?? null;
      }
      return values;
    },
    ok,
  };
}

/** Every item the store holds for a container, oldest first. */
async function* storedItems(store, { container, tenantRef, workload }) {
  let after = null;
  for (;;) {
    const page = await store.listItems({ container, tenantRef, workload, after, limit: 1000 });
    for (const item of page) yield item;
    if (page.length < 1000) return;
    after = page[page.length - 1];
  }
}

const timeOf = (value) => {
  const time = value ? new Date(value).valueOf() : NaN;
  return Number.isFinite(time) ? time : null;
};

function asOf(at) {
  if (at === null || at === undefined) return Infinity;
  const time = timeOf(at);
  if (time === null) throw new TypeError('at must be a date');
  return time;
}

/**
 * The drive as the backup saw it at `at`: per item, the last record observed at or
 * before `at` (a deleted item's record keeps its last name, place and versions).
 */
export async function loadDriveBackup({ store, tenantRef, workload, container, driveId, at = null }) {
  const limit = asOf(at);
  const latest = new Map();
  for await (const item of storedItems(store, { container, tenantRef, workload })) {
    const meta = item.metadata ?? {};
    if (meta.kind !== 'drive-record' || meta.driveId !== driveId) continue;
    const when = timeOf(meta.observedAt) ?? timeOf(item.createdAt) ?? 0;
    if (when > limit) continue;
    const held = latest.get(item.itemKey);
    if (!held || when >= held.when) latest.set(item.itemKey, { when, ref: item.ref });
  }
  const records = new Map();
  for (const [itemId, { ref, when }] of latest) {
    const record = JSON.parse((await readAll(await store.getItem(ref))).toString('utf8'));
    records.set(itemId, { ...record, observedAt: new Date(when).toISOString() });
  }
  // Paths from the parent chain as of `at`: a child's own record can predate a rename
  // of its folder. A parent the backup does not hold is the drive root, or a folder
  // only the record's own path still names.
  const pathOf = (id, seen = new Set()) => {
    const record = records.get(id);
    if (!record || seen.has(id)) return '';
    seen.add(id);
    const parent = records.has(record.parentId) ? pathOf(record.parentId, seen) : parentOf(record.path ?? '');
    return joinPath(parent, record.name ?? id);
  };
  for (const [id, record] of records) record.restorePath = pathOf(id);
  return { driveId, records };
}

/**
 * The list as the backup saw it at `at`: the list itself, its columns and each item's
 * fields (an item deleted by then is left out).
 */
export async function loadListBackup({ store, tenantRef, siteId, listId, at = null }) {
  const limit = asOf(at);
  const container = `site:${siteId}`;
  const latest = new Map();
  const wanted = (key) => key === `list/${listId}` || key === `list/${listId}/columns` || key.startsWith(`list/${listId}/item/`);
  for await (const item of storedItems(store, { container, tenantRef, workload: LIST_WORKLOAD })) {
    if (!wanted(item.itemKey)) continue;
    const when = timeOf(item.createdAt) ?? 0;
    if (when > limit) continue;
    const held = latest.get(item.itemKey);
    if (!held || when >= held.when) latest.set(item.itemKey, { when, ref: item.ref });
  }
  const read = async (key) => (latest.has(key) ? JSON.parse((await readAll(await store.getItem(latest.get(key).ref))).toString('utf8')) : null);
  const list = await read(`list/${listId}`);
  if (!list) throw new FilesRestoreError(`the backup holds no list ${listId} in site ${siteId} at that time`);
  const columns = (await read(`list/${listId}/columns`)) ?? [];
  const items = new Map();
  for (const key of latest.keys()) {
    if (!key.startsWith(`list/${listId}/item/`)) continue;
    const item = await read(key);
    if (item && !item.deleted) items.set(String(item.id), item);
  }
  return { list, columns: Array.isArray(columns) ? columns : columns.value ?? [], items };
}

/** The default target guard: on the test tenant only KEEL-RT- sites and drives. */
export function testTenantGuard({ site = null, drive = null }) {
  const named = (value) => typeof value === 'string' && value.startsWith(TEST_TARGET_PREFIX);
  return [site?.name, site?.displayName, drive?.name, drive?.owner?.user?.displayName].some(named);
}

function resolveGuard(guard) {
  if (guard === 'test-tenant') return testTenantGuard;
  if (typeof guard === 'function') return guard;
  throw new TypeError("guard must be 'test-tenant' or a function");
}

async function approve(gate, request) {
  if (typeof gate !== 'function') throw new FilesRestoreRefused('content restore needs a gate (capability and approval check)');
  let approval;
  try {
    approval = await gate({ capability: 'content-restore', ...request });
  } catch (error) {
    throw new FilesRestoreRefused(`content restore not approved: ${error.message}`);
  }
  if (!approval) throw new FilesRestoreRefused('content restore not approved');
  return typeof approval === 'object' ? approval : { approvalId: String(approval) };
}

function options({ conflict, sleep, maxRetries }) {
  if (!CONFLICT_MODES.includes(conflict)) throw new TypeError(`conflict must be one of ${CONFLICT_MODES.join(', ')}`);
  return { sleep: sleep ?? (async () => {}), maxRetries: maxRetries ?? DEFAULT_MAX_RETRIES };
}

/**
 * This run in the content restore journal (./journal.mjs): opened under the request's
 * key, so asking again resumes it. A step whose entry is restored or skipped is done.
 */
async function openRun(journal, { runKey, tenantRef, workload, request, summary, approval, now }) {
  for (const name of ['openRun', 'entry', 'mark', 'finishRun']) {
    if (typeof journal?.[name] !== 'function') throw new TypeError('content restore needs the restore journal');
  }
  await journal.openRun({
    id: runKey, tenantRef, workload, plan: { request, summary }, label: `Restored ${now().toISOString().slice(0, 10)}`,
    requestedBy: approval.actor ?? null, approvedBy: approval.approvedBy ?? null,
  });
  return {
    async done(step) {
      const held = await journal.entry(runKey, step.itemKey);
      return held && ['restored', 'skipped'].includes(held.status) ? held : null;
    },
    async mark(step, { status, targetId = null, reason = null }) {
      await journal.mark(runKey, step.itemKey, { kind: step.kind, status, targetId, reason: reason ? String(reason).slice(0, 500) : null });
    },
    async finish(stats, plan) {
      const status = stats.failed === 0 ? 'completed' : stats.written + stats.skipped > 0 ? 'partial' : 'failed';
      const report = { stats, steps: plan.map(({ itemKey, kind, path, action, outcome, targetRef, reason, error }) => ({ itemKey, kind, path, action, outcome, targetRef, reason, error })) };
      await journal.finishRun(runKey, { status, report });
      return status;
    },
  };
}

const newStats = () => ({ planned: 0, written: 0, skipped: 0, copies: 0, keptNewer: 0, failed: 0, bytes: 0, writes: 0, throttled: 0 });

/**
 * Restores a file, a folder or a whole drive (OneDrive or document library).
 *
 *   source:  { tenantRef, workload, container, driveId }   workload onedrive | sharepoint | sharepoint-sites;
 *            container as the collector stored it (drive:<id>, or site:<siteId> for a library).
 *   scope:   { kind: 'file' | 'folder', itemId } | { kind: 'drive' }
 *   at:      the point in time (default: the latest backup); version: a version id (file scope only).
 *   target:  { driveId, folderPath } (default: the original drive and place).
 * Returns { runKey, approvalId, plan, stats }; each plan step has its outcome.
 */
export async function restoreFiles({
  store, transport, journal = null, gate = null, guard = 'test-tenant',
  source, scope, at = null, version = null, target = null,
  conflict = 'copy', permissions = false, dryRun = false,
  sleep, maxRetries, now = () => new Date(), logger = null,
}) {
  const request = filesRestoreRequest({ source, scope, at, version, target, conflict, permissions });
  const runKey = restoreRunKey(request);
  ({ scope, at, version, target } = request);
  const { tenantRef, workload, container, driveId } = request.source;
  if (!FILE_WORKLOADS.includes(workload)) throw new TypeError(`source.workload must be one of ${FILE_WORKLOADS.join(', ')}`);
  for (const [name, value] of Object.entries({ tenantRef, container, driveId })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`source.${name} is required`);
  }
  if (!['file', 'folder', 'drive'].includes(scope?.kind)) throw new TypeError("scope.kind must be 'file', 'folder' or 'drive'");
  if (scope.kind !== 'drive' && !scope.itemId) throw new TypeError('scope.itemId is required');
  if (version !== null && scope.kind !== 'file') throw new TypeError('a version can only be chosen for one file');
  const opts = options({ conflict, sleep, maxRetries });
  const isGuarded = resolveGuard(guard);
  const stats = newStats();
  const graph = graphClient(transport, { ...opts, stats });

  // 1. What the backup held.
  const backup = await loadDriveBackup({ store, tenantRef, workload, container, driveId, at });
  const root = scope.kind === 'drive' ? null : backup.records.get(scope.itemId);
  if (scope.kind !== 'drive' && !root) throw new FilesRestoreError(`the backup holds no item ${scope.itemId} at that time`);
  if (scope.kind === 'file' && root.kind !== 'file') throw new TypeError(`item ${scope.itemId} is a ${root.kind}, not a file`);
  if (scope.kind === 'folder' && root.kind !== 'folder') throw new TypeError(`item ${scope.itemId} is a ${root.kind}, not a folder`);
  // Items deleted by `at` stay deleted, unless the folder asked for went with them.
  const includeDeleted = Boolean(root?.deleted);
  const prefix = root ? parentOf(root.restorePath) : '';
  const selected = [...backup.records.values()].filter((record) => {
    if (!['file', 'folder'].includes(record.kind)) return false;
    if (record.deleted && !includeDeleted && record !== root) return false;
    if (!root) return true;
    return record === root || (scope.kind === 'folder' && record.restorePath.startsWith(`${root.restorePath}/`));
  });

  // 2. Where it goes, and whether that place may be written.
  const toDrive = target?.driveId ?? driveId;
  const otherLocation = Boolean(target) && (toDrive !== driveId || target.folderPath !== null);
  const base = otherLocation ? joinPath(target.folderPath ?? '') : prefix;
  const driveBase = `${GRAPH}/drives/${enc(toDrive)}`;
  const drive = await graph.get(`${driveBase}?$select=id,name,driveType,owner,sharePointIds`);
  const site = drive.sharePointIds?.siteId
    ? await graph.find(`${GRAPH}/sites/${enc(drive.sharePointIds.siteId)}?$select=id,name,displayName,webUrl`)
    : null;
  if (!(await isGuarded({ kind: 'drive', drive, site, tenantRef }))) {
    throw new FilesRestoreRefused(`target drive ${drive.name ?? toDrive} is outside the restore guard (test tenant: ${TEST_TARGET_PREFIX} sites and drives only)`);
  }

  // 3. The plan, from GETs only.
  const byPath = (path) => (path ? `${driveBase}/root:/${encPath(path)}` : `${driveBase}/root`);
  const liveAt = (path) => graph.find(`${byPath(path)}?$select=id,name,size,file,folder,lastModifiedDateTime,eTag,cTag`);
  const versionOf = (record) => {
    const wantedId = version ?? record.currentVersion;
    const found = (record.versions ?? []).find((held) => held.versionId === wantedId);
    if (!found && version) throw new FilesRestoreError(`the backup holds no version ${version} of ${record.name}`);
    return found ?? null;
  };
  const sameContent = async (live, held) => {
    if (!live?.file || Number(live.size) !== held.bytes) return false;
    const liveHash = live.file.hashes?.quickXorHash;
    if (!liveHash) return false;
    const hash = createQuickXorHash();
    for await (const chunk of await store.getItem(held.ref)) hash.update(chunk);
    return hash.digest() === liveHash;
  };

  const plan = [];
  const relative = (record) => (prefix ? record.restorePath.slice(prefix.length + 1) : record.restorePath);
  const ordered = selected.sort((a, b) => a.restorePath.split('/').length - b.restorePath.split('/').length || a.restorePath.localeCompare(b.restorePath));
  for (const record of ordered) {
    const path = joinPath(base, relative(record));
    const step = { itemKey: record.id, kind: record.kind, source: record.restorePath, path, action: null, reason: null };
    plan.push(step);
    if (record.kind === 'folder') {
      const live = await liveAt(path);
      if (live?.folder) Object.assign(step, { action: 'skip', reason: 'folder exists', targetRef: live.id });
      else if (live) Object.assign(step, { action: 'failed', reason: 'a file holds the folder\'s place' });
      else step.action = 'create-folder';
      continue;
    }
    const held = versionOf(record);
    if (!held) {
      Object.assign(step, { action: 'failed', reason: 'the backup holds no content for this version' });
      continue;
    }
    Object.assign(step, { versionId: held.versionId, ref: held.ref, bytes: held.bytes, versionDate: held.lastModifiedDateTime ?? record.lastModifiedDateTime ?? null });
    const live = await liveAt(path);
    if (!live) { step.action = 'create'; continue; }
    if (await sameContent(live, held)) { Object.assign(step, { action: 'skip', reason: 'identical', targetRef: live.id }); continue; }
    const liveNewer = (timeOf(live.lastModifiedDateTime) ?? 0) > (timeOf(step.versionDate) ?? 0);
    if (conflict === 'replace-newer' || (conflict === 'replace' && !liveNewer)) {
      Object.assign(step, { action: 'replace', targetRef: live.id });
      continue;
    }
    if (conflict === 'replace' && liveNewer) step.reason = 'the live file is newer; restored as a copy';
    // As a copy, next to the live one. An identical earlier copy means it is done.
    for (let attempt = 1; ; attempt += 1) {
      if (attempt > 20) throw new FilesRestoreError(`no free copy name for ${path}`);
      const candidate = joinPath(parentOf(path), copyName(record.name, step.versionDate, attempt));
      const existing = await liveAt(candidate);
      if (!existing) { Object.assign(step, { action: 'create-copy', path: candidate }); break; }
      if (await sameContent(existing, held)) { Object.assign(step, { action: 'skip', reason: 'restored copy exists', path: candidate, targetRef: existing.id }); break; }
    }
  }
  const grants = permissions ? planGrants(selected) : new Map();
  for (const step of plan) step.grants = grants.get(step.itemKey) ?? [];
  stats.planned = plan.length;
  const writes = plan.filter((step) => ['create-folder', 'create', 'create-copy', 'replace'].includes(step.action) || step.grants.length);
  const summary = {
    workload, drive: drive.name ?? toDrive, site: site?.displayName ?? null, otherLocation, conflict, permissions,
    at, version, items: plan.length, writes: writes.length, bytes: writes.reduce((sum, step) => sum + (step.bytes ?? 0), 0),
  };
  if (dryRun) return { runKey, approvalId: null, dryRun: true, summary, plan, stats };

  // 4. Approval, then the writes.
  const approval = writes.length
    ? await approve(gate, { action: otherLocation ? 'content-restore-other-location' : 'content-restore', runKey, summary })
    : { approvalId: null };
  const run = await openRun(journal, { runKey, tenantRef, workload, request, summary, approval, now });
  const folders = new Map();
  const ensureFolder = async (path) => {
    if (!path) return (await graph.get(`${driveBase}/root?$select=id`)).id;
    if (folders.has(path)) return folders.get(path);
    const live = await liveAt(path);
    let id = live?.folder ? live.id : null;
    if (live && !live.folder) throw new FilesRestoreError(`a file holds the folder's place at /${path}`);
    if (!id) {
      const parentId = await ensureFolder(parentOf(path));
      const name = path.split('/').pop();
      const url = `${driveBase}/items/${enc(parentId)}/children`;
      const response = await graph.send('POST', url, { body: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' } });
      // Created meanwhile (a resumed run): use it.
      id = response?.status === 409 ? (await liveAt(path))?.id : graph.ok(response, url).id;
      if (!id) throw new FilesRestoreError(`could not create folder /${path}`);
    }
    folders.set(path, id);
    return id;
  };

  for (const step of plan) {
    if (step.action === 'failed') {
      stats.failed += 1;
      await run.mark(step, { status: 'failed', reason: step.reason });
      continue;
    }
    const done = await run.done(step);
    if (done) { step.outcome = 'done-earlier'; step.targetRef = done.targetId; stats.skipped += 1; continue; }
    try {
      if (step.action === 'skip') {
        stats.skipped += 1;
        step.outcome = 'skipped';
        // Content already in place; its sharing grants may still be missing.
        if (step.grants.length && step.targetRef) step.granted = await restoreGrants(step);
        await run.mark(step, { status: 'skipped', targetId: step.targetRef ?? null, reason: step.reason });
        continue;
      }
      await run.mark(step, { status: 'pending' });
      if (step.action === 'create-folder') {
        step.targetRef = await ensureFolder(step.path);
        step.outcome = 'written';
        stats.written += 1;
      } else {
        const item = await upload(step);
        step.targetRef = item.id;
        step.outcome = 'written';
        stats.written += 1;
        stats.bytes += step.bytes;
        if (step.action === 'create-copy') stats.copies += 1;
        if (step.reason?.includes('newer')) stats.keptNewer += 1;
      }
      if (step.grants.length && step.targetRef) step.granted = await restoreGrants(step);
      await run.mark(step, { status: 'restored', targetId: step.targetRef ?? null, reason: step.reason });
    } catch (error) {
      if (error instanceof FilesRestoreRefused) throw error;
      step.outcome = 'failed';
      step.error = error.message;
      stats.failed += 1;
      logger?.warn?.(`restore of /${step.path} failed: ${error.message}`);
      await run.mark(step, { status: 'failed', reason: error.message });
    }
  }
  const status = await run.finish(stats, plan);
  return { runKey, status, approvalId: approval.approvalId ?? null, summary, plan, stats };

  async function upload(step) {
    const parentId = await ensureFolder(parentOf(step.path));
    const name = step.path.split('/').pop();
    const behavior = step.action === 'replace' ? 'replace' : 'fail';
    const itemPath = `${driveBase}/items/${enc(parentId)}:/${enc(name)}:`;
    const hash = createQuickXorHash();
    let item;
    if (step.bytes <= SIMPLE_UPLOAD_LIMIT) {
      const bytes = await readAll(await store.getItem(step.ref));
      hash.update(bytes);
      const url = `${itemPath}/content?@microsoft.graph.conflictBehavior=${behavior}`;
      item = graph.ok(await graph.send('PUT', url, { headers: { 'content-type': 'application/octet-stream' }, body: bytes }), url);
    } else {
      const session = await graph.json('POST', `${itemPath}/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': behavior, name } });
      if (typeof session.uploadUrl !== 'string') throw new FilesRestoreError('Graph returned no upload URL');
      let offset = 0;
      let pending = [];
      let pendingBytes = 0;
      const sendChunk = async (chunk) => {
        const end = offset + chunk.length - 1;
        // The upload URL is the tenant's SharePoint host, pre-authorized: the transport
        // sends it no token, and only to the URL its own createUploadSession answer named.
        const response = await graph.send('PUT', session.uploadUrl, {
          upload: true, headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${offset}-${end}/${step.bytes}` }, body: chunk,
        });
        if (![200, 201, 202].includes(response?.status)) {
          throw new FilesRestoreError(`upload chunk ${offset}-${end} answered HTTP ${response?.status}`, { status: response?.status ?? null });
        }
        offset = end + 1;
        if (response.status !== 202) item = response.body;
      };
      for await (const piece of await store.getItem(step.ref)) {
        const buffer = Buffer.from(piece);
        hash.update(buffer);
        pending.push(buffer);
        pendingBytes += buffer.length;
        while (pendingBytes >= UPLOAD_CHUNK_BYTES) {
          const joined = Buffer.concat(pending);
          await sendChunk(joined.subarray(0, UPLOAD_CHUNK_BYTES));
          pending = [joined.subarray(UPLOAD_CHUNK_BYTES)];
          pendingBytes = pending[0].length;
        }
      }
      if (pendingBytes) await sendChunk(Buffer.concat(pending));
      if (offset !== step.bytes) throw new FilesRestoreError(`uploaded ${offset} bytes of ${step.bytes}`);
    }
    if (!item?.id) throw new FilesRestoreError('Graph returned no item for the upload');
    // Graph's own hash of what it stored must be the hash of what the backup held.
    if (item.size !== undefined && Number(item.size) !== step.bytes) throw new FilesRestoreError(`Graph stored ${item.size} bytes, the backup holds ${step.bytes}`);
    const stored = item.file?.hashes?.quickXorHash;
    if (stored && stored !== hash.digest()) throw new FilesRestoreError('Graph\'s hash of the restored file does not match the backup');
    return item;
  }

  async function restoreGrants(step) {
    const url = `${driveBase}/items/${enc(step.targetRef)}/permissions`;
    const live = await graph.all(url);
    const held = (grant) => live.some((permission) => {
      const who = permission.grantedToV2?.[grant.type] ?? permission.grantedTo?.[grant.type] ?? null;
      return who?.id === grant.principalId && grant.roles.every((role) => (permission.roles ?? []).includes(role));
    });
    const results = [];
    for (const grant of step.grants) {
      if (grant.skip) { results.push({ ...grant, outcome: 'not-restored' }); continue; }
      if (held(grant)) { results.push({ ...grant, outcome: 'present' }); continue; }
      const exists = await graph.find(`${GRAPH}/${grant.type === 'group' ? 'groups' : 'users'}/${enc(grant.principalId)}?$select=id`);
      if (!exists) { results.push({ ...grant, outcome: 'principal-missing' }); continue; }
      await graph.json('POST', `${driveBase}/items/${enc(step.targetRef)}/invite`, {
        recipients: [{ objectId: grant.principalId }], roles: grant.roles, requireSignIn: true, sendInvitation: false,
      });
      results.push({ ...grant, outcome: 'granted' });
    }
    return results;
  }
}

/** Direct user and group grants from the backed-up records; the rest is reported. */
function planGrants(records) {
  const grants = new Map();
  for (const record of records) {
    const planned = [];
    for (const permission of record.permissions ?? []) {
      const roles = (permission.roles ?? []).filter((role) => role !== 'owner');
      const to = permission.grantedToV2 ?? permission.grantedTo ?? null;
      const type = to?.user?.id ? 'user' : to?.group?.id ? 'group' : null;
      let skip = null;
      if (permission.inheritedFrom) skip = 'inherited';
      else if (permission.link) skip = 'sharing link';
      else if (!roles.length) skip = 'owner';
      else if (!type) skip = 'not a user or group';
      if (skip === 'inherited') continue;
      planned.push({ principalId: type ? to[type].id : null, type, name: type ? to[type].displayName ?? null : null, roles, skip });
    }
    if (planned.length) grants.set(record.id, planned);
  }
  return grants;
}

const isUnportable = (column) => UNPORTABLE_COLUMN_KINDS.some((kind) => column[kind]);

/** The field names a list restore writes: the user's columns, never system ones. */
export function writableFields(columns) {
  const names = new Set(['Title']);
  for (const column of columns) {
    if (column.readOnly || isUnportable(column) || SYSTEM_FIELDS.has(column.name)) continue;
    names.add(column.name);
  }
  return names;
}

function pickFields(fields, names) {
  const picked = {};
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (!names.has(name) || name.startsWith('@') || name.startsWith('_') || SYSTEM_FIELDS.has(name)) continue;
    if (value === null || value === undefined) continue;
    picked[name] = value;
  }
  return picked;
}

/** A column definition Graph accepts on create, or null for kinds that can't move. */
export function columnDefinition(column) {
  if (column.readOnly || isUnportable(column)) return null;
  const kind = COLUMN_KINDS.find((name) => column[name]);
  if (!kind) return null;
  const definition = { [kind]: column[kind] };
  for (const name of COLUMN_FIELDS) if (column[name] !== undefined && column[name] !== null) definition[name] = column[name];
  return definition;
}

/**
 * Restores a SharePoint list: missing custom columns, then item field values.
 *
 *   source: { tenantRef, siteId, listId }
 *   target: { siteId, listId } or { siteId, listName } (created when missing); default the original list.
 *   itemIds: restore only these items (default: every item the list held at `at`).
 */
export async function restoreList({
  store, transport, journal = null, gate = null, guard = 'test-tenant',
  source, at = null, target = null, itemIds = null, conflict = 'copy', dryRun = false,
  sleep, maxRetries, now = () => new Date(), logger = null,
}) {
  const request = listRestoreRequest({ source, at, target, itemIds, conflict });
  const runKey = restoreRunKey(request);
  ({ at, target, itemIds } = request);
  const { tenantRef, siteId, listId } = request.source;
  for (const [name, value] of Object.entries({ tenantRef, siteId, listId })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`source.${name} is required`);
  }
  const opts = options({ conflict, sleep, maxRetries });
  const isGuarded = resolveGuard(guard);
  const stats = newStats();
  const graph = graphClient(transport, { ...opts, stats });
  const workload = LIST_WORKLOAD;

  const backup = await loadListBackup({ store, tenantRef, siteId, listId, at });
  const toSite = target?.siteId ?? siteId;
  const site = await graph.get(`${GRAPH}/sites/${enc(toSite)}?$select=id,name,displayName,webUrl`);
  if (!(await isGuarded({ kind: 'site', site, tenantRef }))) {
    throw new FilesRestoreRefused(`target site ${site.displayName ?? toSite} is outside the restore guard (test tenant: ${TEST_TARGET_PREFIX} sites only)`);
  }
  const siteBase = `${GRAPH}/sites/${enc(toSite)}`;
  let toList = target?.listId ?? (target?.listName ? null : listId);
  if (!toList && target?.listName) {
    const lists = await graph.all(`${siteBase}/lists?$select=id,displayName`);
    toList = lists.find((list) => list.displayName === target.listName)?.id ?? null;
  }
  const otherLocation = toSite !== siteId || toList !== listId;
  const listBase = toList ? `${siteBase}/lists/${enc(toList)}` : null;
  if (listBase && !(await graph.find(`${listBase}?$select=id`))) {
    if (!otherLocation) throw new FilesRestoreError(`list ${listId} no longer exists; restore it to a new list with target.listName`);
    throw new FilesRestoreError(`target list ${toList} does not exist`);
  }

  // The plan: columns the target lacks, then items whose values it does not hold.
  const names = writableFields(backup.columns);
  const liveColumns = listBase ? await graph.all(`${listBase}/columns`) : [];
  const liveNames = new Set(liveColumns.map((column) => column.name));
  const plan = [];
  if (!listBase) plan.push({ itemKey: 'list', kind: 'list', action: 'create-list', name: target.listName, template: backup.list.list?.template ?? 'genericList' });
  for (const column of backup.columns) {
    if (liveNames.has(column.name) || column.readOnly || SYSTEM_FIELDS.has(column.name)) continue;
    const definition = columnDefinition(column);
    if (!definition) {
      if (!column.hidden && isUnportable(column)) plan.push({ itemKey: `column:${column.name}`, kind: 'column', name: column.name, action: 'not-restored', reason: 'its values are ids from the original site' });
      continue;
    }
    plan.push({ itemKey: `column:${column.name}`, kind: 'column', name: column.name, action: 'create-column', definition });
  }
  const live = listBase ? await graph.all(`${listBase}/items?$expand=fields`) : [];
  const liveById = new Map(live.map((item) => [String(item.id), item]));
  const liveHashes = new Set(live.map((item) => hashOf(pickFields(item.fields, names))));
  const wanted = itemIds ? new Set(itemIds.map(String)) : null;
  for (const [id, item] of backup.items) {
    if (wanted && !wanted.has(id)) continue;
    const fields = pickFields(item.fields, names);
    const step = { itemKey: `item:${id}`, kind: 'item', sourceId: id, fields, action: null };
    plan.push(step);
    if (liveHashes.has(hashOf(fields))) { Object.assign(step, { action: 'skip', reason: 'identical' }); continue; }
    const current = otherLocation ? null : liveById.get(id);
    if (!current) { step.action = 'create'; continue; }
    const liveNewer = (timeOf(current.lastModifiedDateTime) ?? 0) > (timeOf(item.lastModifiedDateTime) ?? 0);
    if (conflict === 'replace-newer' || (conflict === 'replace' && !liveNewer)) Object.assign(step, { action: 'replace', targetRef: id });
    else Object.assign(step, { action: 'create', reason: liveNewer && conflict === 'replace' ? 'the live item is newer; added as a new item' : 'added as a new item next to the live one' });
  }
  if (wanted) for (const id of wanted) if (!backup.items.has(id)) plan.push({ itemKey: `item:${id}`, kind: 'item', sourceId: id, action: 'failed', reason: 'not in the backup at that time' });
  stats.planned = plan.length;
  const writes = plan.filter((step) => ['create-list', 'create-column', 'create', 'replace'].includes(step.action));
  const summary = { workload, site: site.displayName ?? toSite, list: backup.list.displayName ?? listId, otherLocation, conflict, at, items: plan.length, writes: writes.length };
  if (dryRun) return { runKey, approvalId: null, dryRun: true, summary, plan, stats };

  const approval = writes.length
    ? await approve(gate, { action: otherLocation ? 'content-restore-other-location' : 'content-restore', runKey, summary })
    : { approvalId: null };
  let base = listBase;
  const run = await openRun(journal, { runKey, tenantRef, workload, request, summary, approval, now });
  for (const step of plan) {
    if (step.action === 'failed' || step.action === 'not-restored') {
      if (step.action === 'failed') stats.failed += 1;
      step.outcome = step.action;
      await run.mark(step, { status: step.action === 'failed' ? 'failed' : 'skipped', reason: step.reason });
      continue;
    }
    const done = await run.done(step);
    if (done) {
      step.outcome = 'done-earlier';
      if (step.kind === 'list') base = `${siteBase}/lists/${enc(done.targetId)}`;
      stats.skipped += 1;
      continue;
    }
    try {
      if (step.action === 'skip') {
        step.outcome = 'skipped';
        stats.skipped += 1;
        await run.mark(step, { status: 'skipped', reason: step.reason });
        continue;
      }
      await run.mark(step, { status: 'pending' });
      if (step.action === 'create-list') {
        const created = await graph.json('POST', `${siteBase}/lists`, { displayName: step.name, list: { template: step.template } });
        base = `${siteBase}/lists/${enc(created.id)}`;
        step.targetRef = created.id;
      } else if (step.action === 'create-column') {
        step.targetRef = (await graph.json('POST', `${base}/columns`, step.definition)).id ?? null;
      } else if (step.action === 'create') {
        step.targetRef = (await graph.json('POST', `${base}/items`, { fields: step.fields })).id ?? null;
      } else if (step.action === 'replace') {
        await graph.json('PATCH', `${base}/items/${enc(step.targetRef)}/fields`, step.fields);
      }
      step.outcome = 'written';
      stats.written += 1;
      await run.mark(step, { status: 'restored', targetId: step.targetRef ?? null, reason: step.reason ?? null });
    } catch (error) {
      if (error instanceof FilesRestoreRefused) throw error;
      step.outcome = 'failed';
      step.error = error.message;
      stats.failed += 1;
      logger?.warn?.(`list restore step ${step.itemKey} failed: ${error.message}`);
      await run.mark(step, { status: 'failed', reason: error.message });
      // Without the list, the items can't be written.
      if (step.kind === 'list') {
        await run.finish(stats, plan);
        throw error;
      }
    }
  }
  const status = await run.finish(stats, plan);
  return { runKey, status, approvalId: approval.approvalId ?? null, summary, plan, stats };
}
