/** Offline rights qualification. Grants must come from operator-reviewed evidence,
 * never from an uploaded pack. This validates that evidence, not legal entitlement. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { assertTenantRef } from '../../engine/store/tenantRef.mjs';

export function sourceDigest(source) {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

export function validateLicense({ source, rights, grants = [], tenantRef, use = 'tenant-only' }) {
  assertTenantRef(tenantRef);
  if (typeof source !== 'string' || !source.length || source.length > 1024 * 1024) {
    throw new TypeError('license source must be bounded JSON');
  }
  const document = JSON.parse(source);
  const fields = ['edition', 'profile', 'sourceDigest', 'redistributionScope', 'rightsEvidence', 'tenantRef'];
  if (!rights || fields.some(key => typeof rights[key] !== 'string' || !rights[key].trim())) {
    throw new TypeError('rights manifest is required');
  }
  if (!['tenant-only', 'embedded'].includes(use)
    || !['tenant-only', 'embedded'].includes(rights.redistributionScope)
    || (use === 'embedded' && rights.redistributionScope !== 'embedded')) {
    throw new TypeError('rights redistribution scope is inadequate');
  }
  if (rights.tenantRef !== tenantRef || rights.edition !== document.edition || rights.profile !== document.profile) {
    throw new TypeError('rights tenant/edition/profile mismatch');
  }
  if (rights.sourceDigest !== sourceDigest(source)) throw new TypeError('rights source digest mismatch');
  if (!Array.isArray(grants) || !grants.some(grant => fields.every(key => grant?.[key] === rights[key]))) {
    throw new TypeError('license rights have no matching reviewed grant');
  }
  return Object.freeze(Object.fromEntries(fields.map(key => [key, rights[key]])));
}

// Local evidence files only; no network, credentials, tenant writes or service control.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage');
    const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const rights = validateLicense(input);
    console.log(JSON.stringify({ status: 'fixture-tested', sourceDigest: rights.sourceDigest,
      redistributionScope: rights.redistributionScope, liveQualified: false }));
  } catch {
    console.error('license validation failed');
    process.exitCode = 1;
  }
}
