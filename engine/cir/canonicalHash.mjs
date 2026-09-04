import { createHash } from 'node:crypto';

export const HASH_VERSION = 2;
export const VOLATILE_FIELDS = new Map();

export function canonicalize(value, volatileFields, path = '') {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, volatileFields, path));
  }
  if (value && typeof value === 'object') {
    const canonical = {};
    for (const key of Object.keys(value).sort()) {
      const dottedPath = path ? `${path}.${key}` : key;
      if (volatileFields.has(dottedPath) || key.startsWith('@odata.')) continue;
      canonical[key] = canonicalize(value[key], volatileFields, dottedPath);
    }
    return canonical;
  }
  return value;
}

export function canonicalHash(payload, resourceType) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload, VOLATILE_FIELDS.get(resourceType) ?? new Set())))
    .digest('hex');
}
