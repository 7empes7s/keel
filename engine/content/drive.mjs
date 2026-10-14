/**
 * Drive backup (plan Wave 1, package DRIVE): one OneDrive, or one SharePoint document
 * library, synced through Graph drive delta into the content store.
 *
 * What a sync keeps, per drive item, keyed by the item's Graph id (never its path):
 *  - Content: each file version Graph lists (newest `maxVersions`), stored once per
 *    version id. A rename or a move changes the item's name or parent, not its id or
 *    its content tag, so it writes a new record and fetches no content: the history
 *    stays under the same key.
 *  - A record: name, parent, path at the time, facets, hashes, sharing permissions
 *    and the list of stored content versions. A new record is written only when it
 *    differs from the last one, so a rerun with no change writes nothing.
 *  - Deletions: an item the delta reports deleted gets a record with `deleted: true`.
 *    Nothing already stored is removed.
 *
 * Resuming. The sync state is plain JSON the caller persists. After each delta page
 * is fully stored, `checkpoint(state)` is awaited with the next page link; a run that
 * stops part way resumes from the last checkpoint and replays at most one page, which
 * writes nothing new because stored versions and records are skipped. When Graph
 * answers a delta link with 410 (resync required), the sync starts a full pass and
 * marks deleted whatever that pass no longer sees.
 *
 * Read-only. Every request is a GET to graph.microsoft.com under this drive's own
 * path (or `/users/{id}/drive` to find a OneDrive). A page link that leaves the
 * drive's delta path is refused, not followed.
 *
 * Transport contract (supplied by the content collector, which owns the identity):
 *   transport({ method: 'GET', url, headers }) -> { status, headers, body }
 * A JSON answer has a parsed `body`. A content answer has `body` as a Readable,
 * Buffer, Uint8Array or string. The transport follows Graph's download redirect.
 *
 * Store contract (plan section 2, owned by CONT):
 *   putItem(stream, { tenantRef, workload, container, itemKey, version, metadata })
 *     -> { ref, sha256, bytes, deduped }
 * Content goes under itemKey `<itemId>` with the Graph version id as `version`;
 * records go under `<itemId>` with version `record:<hash>`. `metadata.kind` tells
 * them apart ('drive-content' or 'drive-record').
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const GRAPH_VERSION = 'v1.0';
export const DRIVE_STATE_VERSION = 1;
export const DEFAULT_MAX_VERSIONS = 10;
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_MAX_PAGES = 100_000;
// Ask delta to report deletions as deleted items, cross permission gaps and report
// sharing changes, so a permission change alone brings the item back.
export const DELTA_PREFER = 'deltashowremovedasdeleted, deltatraversepermissiongaps, deltashowsharingchanges';

const RETRY_STATUSES = new Set([429, 503, 504]);
// A single file that is gone or locked between the delta page and the download is
// reported and skipped; the next delta brings it back if it still exists.
const SKIPPABLE_CONTENT_STATUSES = new Set([404, 410, 423]);

export class DriveScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriveScopeError';
  }
}

export class DriveSyncError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'DriveSyncError';
    this.status = status;
    this.url = url;
  }
}

const drivePath = (driveId) => `/${GRAPH_VERSION}/drives/${encodeURIComponent(driveId)}`;

/** The first delta request for a drive. */
export function deltaUrl(driveId) {
  return `${GRAPH_ORIGIN}${drivePath(driveId)}/root/delta`;
}

/**
 * Throws DriveScopeError unless `url` is a Graph URL under this drive (or, with
 * `userDrive`, exactly `/users/{id}/drive`). Returns the parsed URL.
 */
export function assertDriveUrl(url, { driveId = null, userId = null } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new DriveScopeError(`not a URL: ${url}`);
  }
  if (parsed.origin !== GRAPH_ORIGIN) throw new DriveScopeError(`refused a request outside Graph: ${parsed.origin}`);
  const path = decodeURIComponent(parsed.pathname).toLowerCase();
  if (userId !== null) {
    if (path !== `/${GRAPH_VERSION}/users/${userId}/drive`.toLowerCase()) throw new DriveScopeError(`refused ${parsed.pathname}: not this user's drive`);
    return parsed;
  }
  if (typeof driveId !== 'string' || !driveId) throw new TypeError('driveId is required');
  const prefix = `/${GRAPH_VERSION}/drives/${driveId}/`.toLowerCase();
  if (!path.startsWith(prefix)) throw new DriveScopeError(`refused ${parsed.pathname}: outside drive ${driveId}`);
  return parsed;
}

/** A GET-only client bound to the injected transport, with throttling handled. */
function graphReader(transport, { sleep, maxRetries, observed }) {
  if (typeof transport !== 'function') throw new TypeError('transport must be a function');
  return async function get(url, { headers = {} } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await transport({ method: 'GET', url, headers });
      if (!RETRY_STATUSES.has(response?.status)) return response;
      observed.throttled += 1;
      if (attempt >= maxRetries) throw new DriveSyncError(`still throttled after ${maxRetries} retries`, { status: response.status, url });
      const seconds = Number(response.headers?.['retry-after']);
      const waitMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempt * 1000;
      observed.waitedMs += waitMs;
      await sleep(waitMs);
    }
  };
}

function ensureOk(response, url) {
  if (response?.status >= 200 && response.status < 300) return response;
  const code = response?.body?.error?.code;
  throw new DriveSyncError(`HTTP ${response?.status}${code ? ` ${code}` : ''} for ${new URL(url).pathname}`, { status: response?.status ?? null, url });
}

function toReadable(body) {
  if (body instanceof Readable) return body;
  if (typeof body === 'string' || body instanceof Uint8Array) return Readable.from([Buffer.from(body)]);
  if (body && typeof body[Symbol.asyncIterator] === 'function') return Readable.from(body);
  throw new DriveSyncError('content answer has no readable body');
}

/** Finds a user's OneDrive: GET /users/{id}/drive. */
export async function resolveUserDrive({ transport, userId, sleep = async () => {}, maxRetries = DEFAULT_MAX_RETRIES }) {
  if (typeof userId !== 'string' || !userId) throw new TypeError('userId is required');
  const url = `${GRAPH_ORIGIN}/${GRAPH_VERSION}/users/${encodeURIComponent(userId)}/drive`;
  assertDriveUrl(url, { userId });
  const get = graphReader(transport, { sleep, maxRetries, observed: { throttled: 0, waitedMs: 0 } });
  const { body } = ensureOk(await get(url), url);
  return { driveId: body.id, driveType: body.driveType ?? null, owner: body.owner ?? null, webUrl: body.webUrl ?? null };
}

/** A fresh sync state for one drive. */
export function newDriveState(driveId) {
  return { version: DRIVE_STATE_VERSION, driveId, nextLink: null, deltaLink: null, fullPass: null, items: {} };
}

/** The item's path from the drive root, as far as the state knows its parents. */
export function itemPath(state, id) {
  const names = [];
  const visited = new Set();
  let current = state.items[id];
  while (current && !current.root && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name ?? current.id);
    current = current.parentId ? state.items[current.parentId] : null;
  }
  return `/${names.join('/')}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const recordHash = (record) => createHash('sha256').update(JSON.stringify(canonical(record))).digest('hex');

function kindOf(item) {
  if (item.deleted) return 'deleted';
  if (item.root) return 'root';
  if (item.file) return item.remoteItem ? 'remote' : 'file';
  if (item.remoteItem) return 'remote';
  return 'folder';
}

/**
 * Syncs one drive. Returns `{ state, stats }`; `state` is a new object, the input is
 * never changed. `container` defaults to `drive:<driveId>`; `workload` to 'onedrive'
 * (SharePoint libraries pass 'sharepoint').
 */
export async function syncDrive({
  transport,
  store,
  driveId,
  tenantRef,
  workload = 'onedrive',
  container = null,
  state = null,
  checkpoint = async () => {},
  sleep = async () => {},
  now = () => new Date(),
  maxVersions = DEFAULT_MAX_VERSIONS,
  permissions = true,
  maxRetries = DEFAULT_MAX_RETRIES,
  maxPages = DEFAULT_MAX_PAGES,
}) {
  if (typeof driveId !== 'string' || !driveId) throw new TypeError('driveId is required');
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('tenantRef is required');
  if (!store || typeof store.putItem !== 'function') throw new TypeError('store.putItem is required');
  if (!Number.isInteger(maxVersions) || maxVersions < 1) throw new TypeError('maxVersions must be a positive integer');
  const current = state ? structuredClone(state) : newDriveState(driveId);
  if (current.version !== DRIVE_STATE_VERSION) throw new TypeError(`unsupported drive state version ${current.version}`);
  if (current.driveId !== driveId) throw new TypeError(`state belongs to drive ${current.driveId}, not ${driveId}`);
  const where = container ?? `drive:${driveId}`;
  const stats = {
    pages: 0, items: 0, files: 0, folders: 0, deleted: 0, records: 0,
    versionsFetched: 0, bytesFetched: 0, deduped: 0, resyncs: 0, throttled: 0, waitedMs: 0, warnings: [],
  };
  const get = graphReader(transport, { sleep, maxRetries, observed: stats });
  const base = `${GRAPH_ORIGIN}${drivePath(driveId)}`;
  const itemUrl = (id, rest = '') => `${base}/items/${encodeURIComponent(id)}${rest}`;

  async function getJson(url, headers) {
    assertDriveUrl(url, { driveId });
    return ensureOk(await get(url, { headers }), url).body ?? {};
  }

  async function storeContent(id, versionId, url, meta) {
    assertDriveUrl(url, { driveId });
    const response = await get(url);
    if (SKIPPABLE_CONTENT_STATUSES.has(response?.status)) {
      stats.warnings.push({ itemId: id, versionId, warning: 'content-unavailable', status: response.status });
      return null;
    }
    ensureOk(response, url);
    const stored = await store.putItem(toReadable(response.body), {
      tenantRef, workload, container: where, itemKey: id, version: versionId,
      metadata: { kind: 'drive-content', driveId, itemId: id, versionId, ...meta },
    });
    stats.versionsFetched += 1;
    stats.bytesFetched += stored.bytes;
    if (stored.deduped) stats.deduped += 1;
    return { ref: stored.ref, sha256: stored.sha256, bytes: stored.bytes, lastModifiedDateTime: meta.lastModifiedDateTime ?? null };
  }

  // Fetches the file versions not stored yet. Skipped when the content tag is the one
  // already stored: a rename, a move or a permission change touches no content.
  async function syncContent(item, known) {
    const versions = { ...(known?.versions ?? {}) };
    if (known?.cTag && known.cTag === item.cTag && Object.keys(versions).length) return { versions, currentVersion: known.currentVersion };
    let listed;
    try {
      listed = (await getJson(itemUrl(item.id, '/versions'))).value ?? [];
    } catch (error) {
      // Some drives and file kinds keep no version list; fall back to the current content.
      if (!(error instanceof DriveSyncError) || ![400, 404, 405].includes(error.status)) throw error;
      listed = [];
    }
    if (listed.length === 0) {
      const versionId = item.cTag ?? item.eTag;
      if (!versions[versionId]) {
        const stored = await storeContent(item.id, versionId, itemUrl(item.id, '/content'), { name: item.name, lastModifiedDateTime: item.lastModifiedDateTime ?? null });
        if (stored) versions[versionId] = stored;
      }
      if (item.size !== undefined && versions[versionId] && versions[versionId].bytes !== item.size) {
        stats.warnings.push({ itemId: item.id, versionId, warning: 'size-mismatch', expected: item.size, stored: versions[versionId].bytes });
      }
      return { versions, currentVersion: versionId };
    }
    // Graph lists versions newest first; the first is the current content.
    for (const [index, version] of listed.slice(0, maxVersions).entries()) {
      if (versions[version.id]) continue;
      const url = index === 0 ? itemUrl(item.id, '/content') : itemUrl(item.id, `/versions/${encodeURIComponent(version.id)}/content`);
      const stored = await storeContent(item.id, version.id, url, { name: item.name, lastModifiedDateTime: version.lastModifiedDateTime ?? null });
      if (stored) versions[version.id] = stored;
    }
    return { versions, currentVersion: listed[0].id };
  }

  async function writeRecord(id, record) {
    const hash = recordHash(record);
    if (current.items[id]?.recordHash === hash) return;
    await store.putItem(Readable.from([Buffer.from(JSON.stringify(record))]), {
      tenantRef, workload, container: where, itemKey: id, version: `record:${hash.slice(0, 32)}`,
      metadata: { kind: 'drive-record', driveId, itemId: id, name: record.name, path: record.path, deleted: record.deleted, observedAt: now().toISOString() },
    });
    current.items[id].recordHash = hash;
    stats.records += 1;
  }

  async function processItem(item) {
    stats.items += 1;
    if (current.fullPass) current.fullPass.seen[item.id] = true;
    const known = current.items[item.id];
    const kind = kindOf(item);
    if (kind === 'deleted') {
      if (!known || known.deleted) return;
      stats.deleted += 1;
      current.items[item.id] = { ...known, deleted: true };
      await writeRecord(item.id, { ...known.record, deleted: true });
      return;
    }
    const entry = {
      ...(known ?? {}),
      id: item.id,
      name: item.name ?? known?.name ?? null,
      parentId: item.parentReference?.id ?? known?.parentId ?? null,
      root: kind === 'root',
      deleted: false,
    };
    current.items[item.id] = entry;
    if (kind === 'root') return;
    let content = { versions: known?.versions ?? {}, currentVersion: known?.currentVersion ?? null };
    if (kind === 'file') {
      stats.files += 1;
      content = await syncContent(item, known);
      entry.cTag = item.cTag ?? null;
      entry.versions = content.versions;
      entry.currentVersion = content.currentVersion;
    } else if (kind === 'folder') {
      stats.folders += 1;
    }
    const granted = permissions && kind !== 'remote' ? ((await getJson(itemUrl(item.id, '/permissions'))).value ?? []) : null;
    const record = {
      kind,
      driveId,
      id: item.id,
      name: entry.name,
      parentId: entry.parentId,
      path: itemPath(current, item.id),
      size: item.size ?? null,
      createdDateTime: item.createdDateTime ?? null,
      lastModifiedDateTime: item.lastModifiedDateTime ?? null,
      createdBy: item.createdBy ?? null,
      lastModifiedBy: item.lastModifiedBy ?? null,
      file: item.file ? { mimeType: item.file.mimeType ?? null, hashes: item.file.hashes ?? null } : null,
      folder: item.folder ? { childCount: item.folder.childCount ?? null } : null,
      package: item.package ?? null,
      remoteItem: item.remoteItem ? { id: item.remoteItem.id, driveId: item.remoteItem.parentReference?.driveId ?? null } : null,
      shared: item.shared ?? null,
      permissions: granted,
      currentVersion: content.currentVersion,
      versions: Object.entries(content.versions)
        .map(([versionId, value]) => ({ versionId, ref: value.ref, sha256: value.sha256, bytes: value.bytes, lastModifiedDateTime: value.lastModifiedDateTime }))
        .sort((a, b) => String(a.lastModifiedDateTime).localeCompare(String(b.lastModifiedDateTime)) || a.versionId.localeCompare(b.versionId)),
      deleted: false,
    };
    entry.record = record;
    await writeRecord(item.id, record);
  }

  // At the end of a full pass, whatever it did not see is gone from the drive.
  async function closeFullPass() {
    for (const [id, known] of Object.entries(current.items)) {
      if (current.fullPass.seen[id] || known.deleted || known.root) continue;
      stats.deleted += 1;
      current.items[id] = { ...known, deleted: true };
      if (known.record) await writeRecord(id, { ...known.record, deleted: true });
    }
    current.fullPass = null;
  }

  const headers = { Prefer: DELTA_PREFER };
  const startFullPass = () => {
    current.nextLink = null;
    current.deltaLink = null;
    current.fullPass = { seen: {} };
    return deltaUrl(driveId);
  };
  let link = current.nextLink ?? current.deltaLink;
  if (!link) link = startFullPass();
  const expectedDelta = `${drivePath(driveId)}/root/delta`.toLowerCase();
  while (link) {
    if (stats.pages >= maxPages) throw new DriveSyncError(`more than ${maxPages} delta pages`);
    const parsed = assertDriveUrl(link, { driveId });
    if (decodeURIComponent(parsed.pathname).toLowerCase() !== decodeURIComponent(expectedDelta)) {
      throw new DriveScopeError(`refused a page link outside the drive's delta: ${parsed.pathname}`);
    }
    const response = await get(link, { headers });
    if (response?.status === 410) {
      // The saved link expired or the drive needs a resync: one full pass per run.
      if (stats.resyncs >= 1) throw new DriveSyncError('Graph asked for a second resync in one run', { status: 410, url: link });
      stats.resyncs += 1;
      link = startFullPass();
      continue;
    }
    const body = ensureOk(response, link).body ?? {};
    stats.pages += 1;
    for (const item of body.value ?? []) await processItem(item);
    if (body['@odata.nextLink']) {
      current.nextLink = body['@odata.nextLink'];
      link = current.nextLink;
    } else {
      if (current.fullPass) await closeFullPass();
      current.nextLink = null;
      current.deltaLink = body['@odata.deltaLink'] ?? null;
      if (!current.deltaLink) throw new DriveSyncError('the last delta page carried no delta link', { url: link });
      link = null;
    }
    await checkpoint(structuredClone(current));
  }
  return { state: current, stats };
}
