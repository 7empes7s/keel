/**
 * Local-disk reference storage adapter (roadmap task-67, WS10).
 *
 * Implements the storage adapter contract (engine/storage/adapter.mjs) over a
 * single local directory tree. This adapter is the honest baseline, and its
 * capability claims are deliberately weak:
 *
 * - retentionLock: 'unsupported' and immutability: 'unsupported'. Local
 *   filesystem permissions (mode bits, ACLs, chattr flags) are revocable by
 *   any principal with write access to the same filesystem and do NOT
 *   constitute immutable storage. The contract module makes a stronger claim
 *   a construction error for this provider (mutation check: label local
 *   permissions immutable).
 * - publish is atomic (private temp file + rename(2) within one filesystem)
 *   and publish-once: an existing object name is refused rather than
 *   clobbered, so a recovery artifact is never silently replaced.
 * - Object names are bare relative names (no traversal, no absolute paths),
 *   and symlinked path components are rejected before anything is written —
 *   the same containment discipline as the configuration export.
 *
 * Local filesystem publication only. Offsite replication, provider-native
 * retention locks and immutability belong to remote adapters, not this one.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { sha256Hex } from '../export/manifest.mjs';
import { assertStorageAdapter, defineStorageCapabilities } from './adapter.mjs';

export const LOCAL_PROVIDER = 'local-disk';

export const RETENTION_LOCK_UNSUPPORTED_NOTE =
  'Local filesystem permissions (mode bits, ACLs, chattr flags) are revocable by any '
  + 'principal with write access and do not constitute a retention lock or immutable storage. '
  + 'Genuine retention requires a provider-native lock on a separate medium.';

// Bare relative object names only: dot-free path segments joined by '/', so a
// name can never traverse out of or anchor outside the storage root.
const OBJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function assertObjectName(name) {
  if (typeof name !== 'string' || !OBJECT_NAME_PATTERN.test(name)) {
    throw new TypeError(`unsafe storage object name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function localStorageCapabilities({ residency = {} } = {}) {
  return defineStorageCapabilities({
    provider: LOCAL_PROVIDER,
    residency: {
      region: residency.region ?? 'local',
      boundary: residency.boundary ?? 'single local filesystem',
      credentialBoundary:
        residency.credentialBoundary
        ?? 'none — local filesystem access only; no storage credentials exist for this adapter',
    },
    retentionLock: 'unsupported',
    immutability: 'unsupported',
    operations: {
      publish: 'fixture-tested',
      read: 'fixture-tested',
      list: 'fixture-tested',
      verify: 'fixture-tested',
      'retention-status': 'fixture-tested',
    },
  });
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Creates the local-disk adapter rooted at `root`. `dependencies.rename` exists
 * so tests can inject a failure at exactly the publish cutover.
 */
export function createLocalStorageAdapter({ root, residency, dependencies = {} } = {}) {
  const { rename = fsRename } = dependencies;
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('the local storage adapter requires a root directory');
  }
  const base = resolve(root);

  /** Resolves an object name to a target path, refusing escapes and symlinks. */
  async function resolveTarget(name) {
    assertObjectName(name);
    const rootStat = await lstatOrNull(base);
    if (rootStat?.isSymbolicLink()) {
      throw new Error(`storage root is a symlink, refusing to write through it: ${base}`);
    }
    const target = resolve(base, name);
    if (target !== base && !target.startsWith(`${base}${sep}`)) {
      throw new Error(`storage object path escape refused for ${JSON.stringify(name)}`);
    }
    // Every existing parent component below the root must be a real directory.
    let cursor = base;
    const relativeSegments = name.split('/').slice(0, -1);
    for (const segment of relativeSegments) {
      cursor = join(cursor, segment);
      const stat = await lstatOrNull(cursor);
      if (stat?.isSymbolicLink()) {
        throw new Error(`storage path component is a symlink, refusing to write through it: ${cursor}`);
      }
    }
    return target;
  }

  const adapter = {
    provider: LOCAL_PROVIDER,
    capabilities: localStorageCapabilities({ residency }),

    /** Publishes bytes under `name`, atomically and at most once. */
    async publish(name, bytes) {
      const target = await resolveTarget(name);
      if (await lstatOrNull(target)) {
        throw new Error(`storage object ${name} is already published — refusing to clobber it`);
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
        // One rename(2) is the whole cutover; a failure before this leaves
        // nothing visible under the object name.
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      return { name, path: target, sha256: sha256Hex(bytes), bytes: bytes.length };
    },

    /** Reads back the exact bytes published under `name`. */
    async read(name) {
      return readFile(await resolveTarget(name));
    },

    /** Lists published object names (sorted), optionally under a prefix. */
    async list(prefix = '') {
      if (prefix) assertObjectName(prefix);
      const out = [];
      async function walk(dir, rel) {
        const stat = await lstatOrNull(dir);
        if (!stat) return;
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue; // never follow links in the tree
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(join(dir, entry.name), childRel);
          else out.push(childRel);
        }
      }
      await walk(prefix ? join(base, prefix) : base, prefix || '');
      return out.sort();
    },

    /** Verifies a published object against a sha256 (and optional byte count). */
    async verify(name, { sha256, bytes: expectedBytes } = {}) {
      const failures = [];
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
        return { ok: false, failures: [`verify requires a sha256 for ${name}`] };
      }
      let bytes;
      try {
        bytes = await readFile(await resolveTarget(name));
      } catch {
        return { ok: false, failures: [`missing storage object ${name}`] };
      }
      if (sha256Hex(bytes) !== sha256) failures.push(`checksum mismatch for ${name}`);
      if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
        failures.push(`length mismatch for ${name}`);
      }
      return { ok: failures.length === 0, failures };
    },

    /**
     * The honest retention answer for a local filesystem: no retention lock,
     * no immutability. Filesystem permissions are access control, not
     * retention — anyone with write access can change or delete the bytes.
     */
    async retentionStatus() {
      return Object.freeze({
        provider: LOCAL_PROVIDER,
        retentionLock: 'unsupported',
        immutability: 'unsupported',
        note: RETENTION_LOCK_UNSUPPORTED_NOTE,
      });
    },
  };

  return assertStorageAdapter(adapter);
}
