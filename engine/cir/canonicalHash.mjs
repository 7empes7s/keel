import { createHash } from 'node:crypto';
import { fieldClass } from './serverOwned.mjs';
import { classifyForOperation } from '../contracts/fieldProjection.mjs';

// HASH_VERSION is unchanged by roadmap task-51: comparison's field exclusion
// (classifyForOperation('comparison', ...)) is defined to equal fieldClass()
// unchanged for every resource type, registered or not, so no payload hashes
// differently than before. Bump this only when a comparison rule actually
// changes which fields participate in the hash.
export const HASH_VERSION = 2;

export function canonicalize(value, resourceType, path = '') {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, resourceType, path));
  }
  if (value && typeof value === 'object') {
    const canonical = {};
    for (const key of Object.keys(value).sort()) {
      const dottedPath = path ? `${path}.${key}` : key;
      if (classifyForOperation('comparison', dottedPath, resourceType) === 'serverOwned') continue;
      canonical[key] = canonicalize(value[key], resourceType, dottedPath);
    }
    return canonical;
  }
  return value;
}

export function canonicalHash(payload, resourceType) {
  // Validate the type even for an empty payload: unknown types must never receive
  // a hash that later makes their server-owned fields look writable.
  fieldClass('', resourceType);
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload, resourceType)))
    .digest('hex');
}

/**
 * Compares two recorded resource-version rows that may have been hashed under
 * different HASH_VERSIONs (spec M2.3 / roadmap task-51). Equal versions
 * compare hashes directly — exactly what every caller in this codebase
 * already does. Different versions are never compared directly: an old
 * hash's string value reflects rules that may no longer apply, so a raw
 * string comparison could manufacture a changed (or hidden) verdict purely
 * from a classification-rule edit shipping between the two reads, not from
 * anything the tenant did. When both raw payloads are available, both are
 * reprojected under the current rules (canonicalHash always applies the
 * current fieldClass, so this is just calling it again) and that comparison
 * is real. When a payload is missing — only a legacy hash string survives —
 * the verdict is 'unknown', never a guess (mutation check: hash old and new
 * projection versions as comparable).
 */
export function compareAcrossHashVersions(previous, next, resourceType) {
  if (!Number.isInteger(previous?.hashVersion) || !Number.isInteger(next?.hashVersion)) {
    throw new TypeError('compareAcrossHashVersions requires an explicit hashVersion on both sides');
  }
  if (previous.hashVersion === next.hashVersion) {
    const previousHash = previous.hash ?? canonicalHash(previous.payload, resourceType);
    const nextHash = next.hash ?? canonicalHash(next.payload, resourceType);
    return Object.freeze({ comparable: true, changed: previousHash !== nextHash, method: 'direct' });
  }
  if (previous.payload !== undefined && next.payload !== undefined) {
    return Object.freeze({
      comparable: true,
      changed: canonicalHash(previous.payload, resourceType) !== canonicalHash(next.payload, resourceType),
      method: 'reprojected',
    });
  }
  return Object.freeze({ comparable: false, changed: null, method: 'unknown' });
}
