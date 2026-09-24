/**
 * Atomic redacted configuration file exports (roadmap task-56).
 *
 * Publishes a tenant/snapshot/type tree of deterministic JSON resource files
 * under a local export root:
 *
 *   <exportRoot>/<tenantDir>/<snapshotId>/<resourceType>/<sha256(naturalKey)>.json
 *   <exportRoot>/<tenantDir>/<snapshotId>/manifest.json
 *   <exportRoot>/<tenantDir>/latest  ->  <snapshotId>   (symlink)
 *
 * Rules enforced here, non-negotiably:
 *
 * 1. Resource bytes are a pure function of the redacted payload values
 *    (exportProjection from engine/contracts/fieldProjection.mjs, serialized
 *    with stableJson). No snapshot times, no observation times, no provenance
 *    timestamps in resource files — volatile times live in the manifest only.
 *    Sensitive fields (user.onPremisesImmutableId, group.securityIdentifier,
 *    ...) never appear in any exported file.
 * 2. Filenames are filenameForKey() hashes, never derived from natural keys,
 *    and every write target is re-resolved against its type directory so a
 *    hostile key cannot escape. Symlinked path components (export root,
 *    tenant dir, snapshot dir) are rejected — the only symlink in the tree is
 *    the `latest` pointer itself, which is never written through.
 * 3. Publication is atomic: everything is staged in a private 0700 staging
 *    directory inside the tenant dir, the manifest is built and its checksums
 *    verified against the staged bytes, then the staging directory is
 *    renamed into place in a single rename(2). The `latest` symlink advances
 *    — via a create-temp-link-then-rename swap — only AFTER that rename and a
 *    second verification of the published bytes. An interrupted export
 *    removes its staging directory and leaves the previous `latest` pointing
 *    at the last fully verified export (mutation check: advance latest before
 *    rename).
 * 4. Per-type completeness comes from the snapshot's persisted coverage
 *    digest, read through the observation contract. Only a complete
 *    enumeration carries absenceMeansDeletion: true; partial and failed types
 *    are explicit unknown/missing, never empty directories. A complete type
 *    whose digest itemCount disagrees with the persisted row count aborts the
 *    whole export rather than publishing a quietly incomplete enumeration.
 *
 * Local filesystem publication only — storage/offsite policy belongs to WS10.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, rename as fsRename, rm, symlink as fsSymlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { exportProjection } from '../contracts/fieldProjection.mjs';
import { readObservation } from '../contracts/observation.mjs';
import { getLatestSnapshot, getResourceVersions } from '../store/db.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import {
  buildManifest, filenameForKey, sha256Hex, stableJson, verifyManifest,
} from './manifest.mjs';

// Resource type names are registered catalog types (camelCase). Anything else
// in a stored row is refused rather than allowed to shape a directory name.
const TYPE_DIRECTORY_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Filesystem-safe directory name for a derived tenant reference. */
export function tenantDirectoryName(tenantRef) {
  assertTenantRef(tenantRef);
  return tenantRef.replaceAll(/[^A-Za-z0-9._-]/g, '-');
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNotSymlink(path, label) {
  const stat = await lstatOrNull(path);
  if (stat?.isSymbolicLink()) {
    throw new Error(`export path component is a symlink, refusing to write through it: ${label}`);
  }
  return stat;
}

/**
 * Resolves the snapshot to export, always scoped to the tenant (Global
 * Constraint #4): an explicit snapshotId must belong to tenantRef and be a
 * completed run, otherwise the tenant's latest completed snapshot is used.
 */
export async function resolveExportSnapshot(client, { tenantRef, snapshotId }) {
  assertTenantRef(tenantRef);
  if (snapshotId !== undefined) {
    const { rows } = await client.query(
      `SELECT * FROM snapshot
       WHERE id = $1 AND tenant_ref = $2 AND status = 'complete' AND completed_at IS NOT NULL`,
      [snapshotId, tenantRef],
    );
    if (!rows[0]) {
      throw new Error(`no completed snapshot ${snapshotId} for tenant ${tenantRef}`);
    }
    return rows[0];
  }
  const latest = await getLatestSnapshot(client, { tenantRef });
  if (!latest) throw new Error(`no completed snapshot for tenant ${tenantRef}`);
  return latest;
}

function enumerationFor(completeness) {
  if (completeness === 'complete') return 'complete';
  if (completeness === 'partial') return 'partial';
  return 'unknown';
}

async function stageExport(stagingDir, snapshot, rows, tenantRef) {
  const stagedByType = new Map();
  for (const row of rows) {
    if (!TYPE_DIRECTORY_PATTERN.test(row.resource_type)) {
      throw new Error(`unsafe resource type name in stored row: ${JSON.stringify(row.resource_type)}`);
    }
    // Redaction is unconditional: the export projection, never the raw payload
    // (mutation check: skip sensitive-field exclusion).
    const bytes = stableJson(exportProjection(row.payload, row.resource_type));
    const filename = filenameForKey(row.natural_key);
    const typeDir = join(stagingDir, row.resource_type);
    await mkdir(typeDir, { recursive: true, mode: 0o700 });
    const target = resolve(typeDir, filename);
    if (!target.startsWith(`${resolve(typeDir)}${sep}`)) {
      throw new Error(`export path escape refused for natural key ${JSON.stringify(row.natural_key)}`);
    }
    await writeFile(target, bytes, { mode: 0o600 });
    const resources = stagedByType.get(row.resource_type) ?? {};
    resources[filename] = {
      naturalKey: row.natural_key,
      resourceType: row.resource_type,
      sha256: sha256Hex(bytes),
      bytes: Buffer.byteLength(bytes),
    };
    stagedByType.set(row.resource_type, resources);
  }

  const digest = snapshot.coverage_digest ?? {};
  const typeNames = [...new Set([...Object.keys(digest), ...stagedByType.keys()])].sort();
  const types = {};
  for (const type of typeNames) {
    const observation = readObservation(digest[type] ?? null, {
      tenantRef,
      observationId: `${snapshot.id}:${type}`,
      resourceType: type,
      snapshotWindow: { startedAt: snapshot.started_at, endedAt: snapshot.completed_at },
    });
    const enumeration = enumerationFor(observation.completeness);
    const staged = stagedByType.get(type);
    const rowCount = staged ? Object.keys(staged).length : 0;
    if (
      enumeration === 'complete'
      && Number.isSafeInteger(observation.itemCount)
      && observation.itemCount !== rowCount
    ) {
      throw new Error(
        `coverage/export count mismatch for ${type}: digest observed ${observation.itemCount}, snapshot persists ${rowCount}`,
      );
    }
    types[type] = {
      resourceType: type,
      outcome: typeof digest[type] === 'object' && digest[type] !== null
        ? digest[type].outcome ?? 'unknown'
        : (typeof digest[type] === 'number' ? 'legacy-count' : 'unknown'),
      itemCount: observation.itemCount ?? null,
      enumeration,
      // Deletion is representable only within a successful complete
      // enumeration; for partial/failed types absence says nothing.
      absenceMeansDeletion: enumeration === 'complete',
      observation,
      // A complete enumeration of zero resources is an empty map — a genuine
      // empty read. An incomplete enumeration is explicit null: unknown/missing,
      // never an empty directory implying "no resources".
      resources: enumeration === 'unknown' && !staged ? null : (staged ?? {}),
    };
  }

  const manifest = buildManifest({
    tenantRef,
    snapshot: { id: snapshot.id, startedAt: snapshot.started_at, completedAt: snapshot.completed_at },
    types,
  });
  await writeFile(join(stagingDir, 'manifest.json'), stableJson(manifest), { mode: 0o600 });
  return manifest;
}

/**
 * Exports one snapshot for one tenant into the local export root. Local
 * publication only. `dependencies.rename` / `dependencies.symlink` exist so
 * tests can inject failures at exact points of the publish sequence.
 */
export async function exportSnapshot(client, { tenantRef, snapshotId, exportRoot, dependencies = {} }) {
  const { rename = fsRename, symlink = fsSymlink } = dependencies;
  assertTenantRef(tenantRef);
  if (typeof exportRoot !== 'string' || exportRoot.length === 0) {
    throw new TypeError('exportSnapshot requires an export root');
  }

  const snapshot = await resolveExportSnapshot(client, { tenantRef, snapshotId });
  const rows = await getResourceVersions(client, { snapshotId: snapshot.id });

  const root = resolve(exportRoot);
  await mkdir(root, { recursive: true });
  await assertNotSymlink(root, 'export root');
  const tenantDir = join(root, tenantDirectoryName(tenantRef));
  await mkdir(tenantDir, { recursive: true, mode: 0o700 });
  await assertNotSymlink(tenantDir, 'tenant directory');
  const finalDir = join(tenantDir, snapshot.id);
  if (await assertNotSymlink(finalDir, 'snapshot directory')) {
    throw new Error(`snapshot ${snapshot.id} is already exported at ${finalDir}`);
  }

  const stagingDir = join(tenantDir, `.staging-${randomUUID()}`);
  await mkdir(stagingDir, { mode: 0o700 });
  try {
    const manifest = await stageExport(stagingDir, snapshot, rows, tenantRef);
    const staged = await verifyManifest(manifest, stagingDir, { expectedTenantRef: tenantRef });
    if (!staged.ok) {
      throw new Error(`staged export failed manifest verification: ${staged.failures.join('; ')}`);
    }
    // The atomic cutover: one rename(2) moves the fully verified tree into
    // place. `latest` must not advance before this completes.
    await rename(stagingDir, finalDir);
    const published = await verifyManifest(manifest, finalDir, { expectedTenantRef: tenantRef });
    if (!published.ok) {
      throw new Error(`published export failed manifest verification: ${published.failures.join('; ')}`);
    }
    // Only now does latest advance — a temp symlink swapped in by rename, so a
    // reader never observes a half-written pointer.
    const latestPath = join(tenantDir, 'latest');
    const tmpLink = join(tenantDir, `.latest-${randomUUID()}`);
    await symlink(snapshot.id, tmpLink);
    await rename(tmpLink, latestPath);
    return { snapshotId: snapshot.id, exportDir: finalDir, latestPath, manifest };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

/** Reads and verifies the export a tenant's `latest` pointer names. */
export async function readLatestExport(exportRoot, { tenantRef }) {
  assertTenantRef(tenantRef);
  const tenantDir = join(resolve(exportRoot), tenantDirectoryName(tenantRef));
  const latestPath = join(tenantDir, 'latest');
  const stat = await lstatOrNull(latestPath);
  if (!stat?.isSymbolicLink()) return null;
  const exportDir = join(tenantDir, await readlink(latestPath));
  const manifest = JSON.parse(await readFile(join(exportDir, 'manifest.json'), 'utf8'));
  const verification = await verifyManifest(manifest, exportDir, { expectedTenantRef: tenantRef });
  return { snapshotId: manifest.snapshot.id, exportDir, manifest, verification };
}
