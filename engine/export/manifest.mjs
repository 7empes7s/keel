/**
 * Export manifest build + verification (roadmap task-56).
 *
 * A manifest is the only volatile part of an export: resource file bytes are a
 * pure function of the redacted payload values, while collection times,
 * observation windows and the export instant live here. The manifest maps
 * HASHED filenames (sha256 of the persisted natural key) back to the natural
 * key, resource type and a checksum over the actual file bytes — a filename is
 * never constructed from the natural key itself, so a slash-containing or
 * absolute-path key cannot influence where bytes land.
 *
 * Per-type completeness mirrors the snapshot's coverage digest: a type whose
 * enumeration completed (complete / complete-empty) is exported with
 * absenceMeansDeletion: true — a missing resource file then does mean the
 * resource is gone. A partial or failed enumeration is exported as explicit
 * unknown/missing (absenceMeansDeletion: false, resources null when nothing
 * was read), never as an empty type directory implying "no resources".
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { assertTenantRef } from '../store/tenantRef.mjs';

export const MANIFEST_VERSION = 1;

// Resource filenames are always a bare sha256 hex digest — nothing derived
// from a natural key can ever contain a path separator or traversal segment.
export const RESOURCE_FILENAME_PATTERN = /^[0-9a-f]{64}\.json$/;

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The ONLY sanctioned derivation from natural key to filename. Callers must
 * never join a natural key into a path directly (mutation check: construct
 * filename directly from natural key).
 */
export function filenameForKey(naturalKey) {
  if (typeof naturalKey !== 'string' || naturalKey.length === 0) {
    throw new TypeError('a resource requires a non-empty natural key');
  }
  return `${sha256Hex(naturalKey)}.json`;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

/**
 * Deterministic JSON: recursively sorted keys, fixed indentation, trailing
 * newline. Same values in, byte-identical bytes out — resource files carry no
 * timestamps, so two snapshots of unchanged values export identical bytes.
 */
export function stableJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function asIso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Builds the versioned manifest document. `types` is an object keyed by
 * resource type whose entries are produced by the caller (configExport.mjs):
 * { resourceType, outcome, itemCount, enumeration, absenceMeansDeletion,
 *   observation, resources } — with resources either null (enumeration not
 * complete; nothing readable) or a map of hashed filename -> metadata.
 * Volatile times (snapshot window, exportedAt, observation windows) belong
 * here and only here.
 */
export function buildManifest({ tenantRef, snapshot, types, exportedAt = new Date().toISOString() }) {
  assertTenantRef(tenantRef);
  if (typeof snapshot?.id !== 'string' || snapshot.id.length === 0) {
    throw new TypeError('manifest requires the source snapshot id');
  }
  if (!types || typeof types !== 'object') {
    throw new TypeError('manifest requires a per-type completeness map');
  }
  return {
    manifestVersion: MANIFEST_VERSION,
    tenantRef,
    snapshot: {
      id: snapshot.id,
      startedAt: asIso(snapshot.startedAt),
      completedAt: asIso(snapshot.completedAt),
    },
    exportedAt,
    types,
  };
}

/**
 * Verifies a manifest against the actual bytes on disk in `dir`. Every
 * declared resource file must exist, carry a filename that is a bare hash
 * (anything else is a path-escape attempt and fails closed), and match its
 * recorded sha256 and byte length. The optional tenant pin refuses a manifest
 * written for another tenant. Returns { ok, failures } — never throws on
 * malformed input, so a partial or tampered export reads as failed, not as a
 * crash.
 */
export async function verifyManifest(manifest, dir, { expectedTenantRef } = {}) {
  const failures = [];
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, failures: ['manifest is not an object'] };
  }
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    failures.push(`unsupported manifestVersion: ${JSON.stringify(manifest.manifestVersion)}`);
  }
  if (typeof manifest.tenantRef !== 'string' || manifest.tenantRef.length === 0) {
    failures.push('manifest lacks a tenant_ref');
  } else if (expectedTenantRef !== undefined && manifest.tenantRef !== expectedTenantRef) {
    failures.push(`tenant pin mismatch: manifest is for ${manifest.tenantRef}, not ${expectedTenantRef}`);
  }
  if (typeof manifest.snapshot?.id !== 'string' || manifest.snapshot.id.length === 0) {
    failures.push('manifest lacks a snapshot id');
  }
  const root = resolve(dir);
  const types = manifest.types && typeof manifest.types === 'object' ? manifest.types : {};
  for (const [type, entry] of Object.entries(types)) {
    const resources = entry?.resources;
    if (resources == null) continue; // explicit unknown/missing: nothing to verify
    for (const [filename, meta] of Object.entries(resources)) {
      if (!RESOURCE_FILENAME_PATTERN.test(filename)) {
        failures.push(`unsafe resource filename for ${type}: ${JSON.stringify(filename)}`);
        continue;
      }
      const target = resolve(root, type, filename);
      if (!target.startsWith(`${root}${sep}`)) {
        failures.push(`path escape for ${type}: ${JSON.stringify(filename)}`);
        continue;
      }
      let bytes;
      try {
        bytes = await readFile(target);
      } catch {
        failures.push(`missing resource file ${type}/${filename}`);
        continue;
      }
      if (meta?.resourceType !== undefined && meta.resourceType !== type) {
        failures.push(`resource type mismatch for ${type}/${filename}`);
      }
      if (sha256Hex(bytes) !== meta?.sha256) {
        failures.push(`checksum mismatch for ${type}/${filename}`);
      }
      if (meta?.bytes !== bytes.length) {
        failures.push(`length mismatch for ${type}/${filename}`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
}
