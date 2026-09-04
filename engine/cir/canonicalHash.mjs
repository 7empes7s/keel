import { createHash } from 'node:crypto';
import { fieldClass } from './serverOwned.mjs';

export const HASH_VERSION = 2;

export function canonicalize(value, resourceType, path = '') {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, resourceType, path));
  }
  if (value && typeof value === 'object') {
    const canonical = {};
    for (const key of Object.keys(value).sort()) {
      const dottedPath = path ? `${path}.${key}` : key;
      if (fieldClass(dottedPath, resourceType) === 'serverOwned') continue;
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
