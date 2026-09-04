import { createHash } from 'node:crypto';

export const HASH_VERSION = 2;
// Measured 2026-09-04 from out/volatility-20260904T223648Z.json.
export const VOLATILE_FIELDS = new Map([
  ['user', new Set()],
  ['authenticationStrengthPolicy', new Set()],
  ['group', new Set()],
  ['roleAssignment', new Set()],
  ['namedLocation', new Set()],
  ['conditionalAccessPolicy', new Set()],
]);

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
