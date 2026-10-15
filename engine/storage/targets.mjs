/**
 * Storage target registry (Wave 2 STORE): one backup artifact (a DB dump,
 * content chunks, a bundle) ships to every configured target, and each copy is
 * read back and checksum-verified on its own target.
 *
 * Outcome per shipment:
 * - complete: every target holds a verified copy;
 * - partial: at least one target holds a verified copy and at least one does
 *   not; the failing targets are named with their reason, never dropped;
 * - failed: no target holds a verified copy.
 *
 * A local filesystem directory is the first-class target (kind local-disk):
 * plain files, readable with no Keel and no cloud account. Azure Blob is
 * available as a further kind. Configuration comes from the environment
 * (on the box: a git-ignored, mode-600 env file such as /etc/keel/offsite.env):
 *
 *   KEEL_STORAGE_TARGETS=mulinux,azure          target ids, comma separated
 *   KEEL_STORAGE_TARGET_<ID>_KIND=local-disk     or azure-blob
 *   local-disk:  _DIR=/mnt/keel-copy/keel-store  (absolute)
 *                _SEPARATE_FROM=/opt/backups     refuse the target when _DIR sits on this
 *                                                path's filesystem (default: none)
 *                _KEEP_DAYS=30                   dump copies kept by engine/schedules/offsite.mjs
 *   azure-blob:  _ACCOUNT, _CONTAINER, _PREFIX (optional), _SAS, _ENDPOINT (optional)
 *   any kind:    _REGION, _BOUNDARY (reference text only)
 *
 * <ID> is the target id upper-cased with '-' as '_'. Credentials (the SAS) are
 * read from the environment only and never reach a report, a log line or the
 * database.
 */
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { sha256Hex } from '../export/manifest.mjs';
import { assertStorageAdapter } from './adapter.mjs';
import { createAzureBlobAdapter, createAzureBlobRestClient } from './azureBlob.mjs';
import { assertObjectName, createLocalStorageAdapter } from './local.mjs';

export const TARGET_KINDS = Object.freeze(['local-disk', 'azure-blob']);
export const SHIPMENT_STATUSES = Object.freeze(['complete', 'partial', 'failed']);

const TARGET_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function storageTargetEnvKey(id, field) {
  return `KEEL_STORAGE_TARGET_${id.toUpperCase().replaceAll('-', '_')}_${field}`;
}

function reason(error) {
  return error?.message ?? String(error);
}

/**
 * Validates a list of { id, adapter, check? } entries. `check` is an optional
 * async precondition run before every use (for a local disk: "is the volume
 * really mounted?"); when it throws, that target is down for this shipment.
 */
export function defineStorageTargets(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('at least one storage target is required');
  const seen = new Set();
  return Object.freeze(entries.map(({ id, adapter, check = null }) => {
    if (typeof id !== 'string' || !TARGET_ID.test(id)) throw new TypeError(`invalid storage target id ${JSON.stringify(id)}`);
    if (seen.has(id)) throw new TypeError(`duplicate storage target id ${id}`);
    seen.add(id);
    assertStorageAdapter(adapter);
    if (check !== null && typeof check !== 'function') throw new TypeError(`target ${id}: check must be a function`);
    return Object.freeze({ id, adapter, check });
  }));
}

/** Refuses a local target that sits on the same filesystem as `separateFrom`. */
export function separateFilesystemCheck(dir, separateFrom, { statFn = stat } = {}) {
  return async () => {
    const parent = await statFn(dir).catch(() => null) ?? await statFn(dirname(dir)).catch(() => null);
    if (!parent) throw new Error(`${dir} and its parent do not exist — is the volume mounted?`);
    const other = await statFn(separateFrom);
    if (parent.dev === other.dev) {
      throw new Error(`${dir} is on the same filesystem as ${separateFrom} — the volume is not mounted`);
    }
  };
}

/**
 * Builds the registry from environment variables (see the header). Returns
 * null when KEEL_STORAGE_TARGETS is unset, so callers can keep a legacy path.
 */
export function loadStorageTargets(env = process.env, { fetchFn = globalThis.fetch, statFn = stat } = {}) {
  const list = (env.KEEL_STORAGE_TARGETS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (list.length === 0) return null;
  return defineStorageTargets(list.map((id) => {
    if (!TARGET_ID.test(id)) throw new TypeError(`invalid storage target id ${JSON.stringify(id)}`);
    const get = (field) => env[storageTargetEnvKey(id, field)];
    const kind = get('KIND') ?? 'local-disk';
    const residency = {
      ...(get('REGION') ? { region: get('REGION') } : {}),
      ...(get('BOUNDARY') ? { boundary: get('BOUNDARY') } : {}),
    };
    if (kind === 'local-disk') {
      const dir = get('DIR');
      if (!dir || !isAbsolute(dir)) throw new TypeError(`${storageTargetEnvKey(id, 'DIR')} must be an absolute directory`);
      const separateFrom = get('SEPARATE_FROM');
      return {
        id,
        adapter: createLocalStorageAdapter({ root: dir, residency: { region: 'local', boundary: `local directory ${dir}`, ...residency } }),
        check: separateFrom ? separateFilesystemCheck(dir, separateFrom, { statFn }) : null,
      };
    }
    if (kind === 'azure-blob') {
      const account = get('ACCOUNT');
      const container = get('CONTAINER');
      if (!get('SAS')) throw new TypeError(`${storageTargetEnvKey(id, 'SAS')} is required for an azure-blob target`);
      if (!account && !get('ENDPOINT')) throw new TypeError(`${storageTargetEnvKey(id, 'ACCOUNT')} or ${storageTargetEnvKey(id, 'ENDPOINT')} is required`);
      const endpoint = get('ENDPOINT') ?? `https://${account}.blob.core.windows.net`;
      const client = createAzureBlobRestClient({ endpoint, sas: get('SAS'), fetchFn });
      return {
        id,
        adapter: createAzureBlobAdapter({
          container,
          prefix: get('PREFIX') ?? '',
          client,
          residency: { ...residency, credentialBoundary: `SAS token from env ${storageTargetEnvKey(id, 'SAS')} (reference only)` },
        }),
      };
    }
    throw new TypeError(`${storageTargetEnvKey(id, 'KIND')} must be one of ${TARGET_KINDS.join(', ')}, got ${JSON.stringify(kind)}`);
  }));
}

async function shipToTarget(target, name, bytes, sha256) {
  const base = { targetId: target.id, provider: target.adapter.capabilities.provider, immutability: target.adapter.capabilities.immutability };
  try {
    if (target.check) await target.check();
    let published = 'published';
    try {
      await target.adapter.publish(name, bytes);
    } catch (error) {
      // Publish-once adapters refuse an existing name. A retry after a partial
      // shipment lands here: the existing copy counts only if it verifies.
      if (!/already published/.test(reason(error))) throw error;
      published = 'already-present';
    }
    const verification = await target.adapter.verify(name, { sha256, bytes: bytes.length });
    return Object.freeze({
      ...base,
      published,
      verified: verification.ok === true,
      failures: Object.freeze([...(verification.failures ?? [])]),
    });
  } catch (error) {
    return Object.freeze({ ...base, published: 'error', verified: false, failures: Object.freeze([reason(error)]) });
  }
}

/**
 * Ships one artifact to every target and verifies each copy. Never throws for
 * a target failure: the report says which targets hold a verified copy.
 */
export async function shipArtifact(targets, { name, bytes, now = () => new Date() }) {
  assertObjectName(name);
  if (!Buffer.isBuffer(bytes)) throw new TypeError('artifact bytes must be a Buffer');
  const sha256 = sha256Hex(bytes);
  const copies = [];
  for (const target of targets) copies.push(await shipToTarget(target, name, bytes, sha256));
  const verified = copies.filter((copy) => copy.verified).length;
  const status = verified === copies.length ? 'complete' : verified === 0 ? 'failed' : 'partial';
  return Object.freeze({ name, sha256, bytes: bytes.length, status, shippedAt: now().toISOString(), copies: Object.freeze(copies) });
}

/** Read-only reachability check for a dry run: precondition plus a list call. */
export async function probeTargets(targets) {
  const results = [];
  for (const target of targets) {
    try {
      if (target.check) await target.check();
      await target.adapter.list();
      results.push(Object.freeze({ targetId: target.id, usable: true }));
    } catch (error) {
      results.push(Object.freeze({ targetId: target.id, usable: false, reason: reason(error) }));
    }
  }
  return Object.freeze(results);
}

/** One line per copy, for logs and the systemd journal. */
export function describeShipment(report) {
  const lines = [`${report.name} sha256 ${report.sha256}: ${report.status}`];
  for (const copy of report.copies) {
    lines.push(`  ${copy.targetId} (${copy.provider}): ${copy.verified ? 'verified' : 'NOT verified'}, ${copy.published}`
      + (copy.failures.length ? ` — ${copy.failures.join('; ')}` : ''));
  }
  return lines.join('\n');
}

/** Records a shipment in storage_copy (schema.d/34-storage-targets.sql), one row per target. */
export async function recordShipment(client, report) {
  for (const copy of report.copies) {
    await client.query(
      `INSERT INTO storage_copy (artifact_name, artifact_sha256, artifact_bytes, target_id, provider, shipment_status,
         verified, published, immutability, failures, shipped_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [report.name, report.sha256, report.bytes, copy.targetId, copy.provider, report.status,
        copy.verified, copy.published, copy.immutability, JSON.stringify(copy.failures), report.shippedAt],
    );
  }
}
