import { createHash } from 'node:crypto';

const TENANT_REF_PATTERN = /^sha256:\S+$/;

export function tenantRefFor(tenantId) {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('tenantId must be a non-empty string');
  }
  return `sha256:${createHash('sha256').update(tenantId).digest('hex').slice(0, 16)}`;
}

/**
 * Validates a value that must be an already-derived tenant reference. Diagnosis
 * and report joins take tenant_ref on every evidence object (Global Constraint
 * #4); this is the boundary that refuses an empty or raw (unhashed) tenant id
 * before it can anchor a cross-tenant comparison.
 */
export function assertTenantRef(tenantRef, name = 'tenantRef') {
  if (typeof tenantRef !== 'string' || !TENANT_REF_PATTERN.test(tenantRef)) {
    throw new TypeError(`${name} must be a derived tenant reference (sha256:…), got ${JSON.stringify(tenantRef)}`);
  }
  return tenantRef;
}
