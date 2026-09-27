/** Offline rights qualification. Grants must come from operator-reviewed evidence,
 * never from an uploaded pack. This validates that evidence, not legal entitlement. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { assertTenantRef } from '../../engine/store/tenantRef.mjs';

export function sourceDigest(source) {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

const publicDomainManifests = new WeakSet();
export const NIST_MAPPINGS = Object.freeze([
  ['keel-custom.role-assignment.admin-count-at-most', 'ac-6'],
  ['keel-custom.named-location.no-untrusted-all-countries', 'ac-3'],
  ['keel-custom.group.role-assignable-not-synced', 'ac-2'],
].map(Object.freeze));

/** Trust only the repository's reviewed pin; hash bytes before parsing controls. */
export function loadNistProfile({ catalogBytes } = {}) {
  const pin = JSON.parse(readFileSync(new URL('../../docs/roadmap/benchmark-content/nist-sp800-53-rev5-pin.json', import.meta.url)));
  if (!['public domain', 'public-domain'].includes(pin.licensing?.status)
    || pin.licensing.commercialUseRestricted !== false || pin.catalogVersion !== '5.2.0'
    || !Number.isFinite(Date.parse(pin.retrievedAt))
    || pin.sourceRepo !== 'https://github.com/usnistgov/oscal-content') throw new Error('NIST prerequisite pin invalid');
  const bytes = catalogBytes ?? readFileSync(pin.localPath);
  if (sourceDigest(bytes) !== `sha256:${pin.sha256}`) throw new Error('NIST catalog digest mismatch');
  const catalog = JSON.parse(bytes).catalog;
  if (catalog.metadata.version !== pin.catalogVersion) throw new Error('NIST catalog version mismatch');
  const controls = catalog.groups.filter(g => ['ac', 'ia', 'au', 'cm'].includes(g.id)).flatMap(g => g.controls);
  for (const [, id] of NIST_MAPPINGS) {
    if (!controls.some(c => c.id === id)) throw new Error('NIST mapped control missing');
  }
  return { pin, controls };
}

export function nistPackInput(tenantRef) {
  const { pin } = loadNistProfile();
  const document = { packId: 'nist-sp800-53', version: pin.catalogVersion, edition: pin.catalogVersion,
    profile: 'AC-IA-AU-CM', controls: NIST_MAPPINGS.map(([controlId, ref]) => ({ controlId,
      evaluatorVersion: 1, frameworkRefs: [{ framework: 'NIST SP 800-53', edition: pin.catalogVersion,
        profile: 'AC-IA-AU-CM', ref: ref.toUpperCase() }] })) };
  const source = JSON.stringify(document);
  const rights = Object.freeze({ edition: document.edition, profile: document.profile,
    sourceDigest: sourceDigest(source), redistributionScope: 'embedded', tenantRef,
    rightsEvidence: pin.sourceUrl, licensing: Object.freeze({ status: 'public-domain' }),
    catalogDigest: pin.sha256 });
  publicDomainManifests.add(rights);
  return { source, rights };
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
  if (!publicDomainManifests.has(rights)
    && (!Array.isArray(grants) || !grants.some(grant => fields.every(key => grant?.[key] === rights[key])))) {
    throw new TypeError('license rights have no matching reviewed grant');
  }
  return Object.freeze({ ...Object.fromEntries(fields.map(key => [key, rights[key]])),
    ...(publicDomainManifests.has(rights) ? { licensing: rights.licensing, catalogDigest: rights.catalogDigest } : {}) });
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
