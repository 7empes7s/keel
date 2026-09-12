import { createHash } from 'node:crypto';

export function tenantRefFor(tenantId) {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('tenantId must be a non-empty string');
  }
  return `sha256:${createHash('sha256').update(tenantId).digest('hex').slice(0, 16)}`;
}
