/** Task 86: rights-gated packs referencing the existing authored-control registry.
 * No licensed benchmark text ships here. No arbitrary predicates are imported. */
import { can } from '../authz/can.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { controlFor } from './registry.mjs';
import { evaluateControl } from './evaluate.mjs';
import { sourceDigest, validateLicense, nistPackInput } from '../../tools/qualification/benchmarkLicense.mjs';

const imported = new WeakSet();
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function text(value) { return typeof value === 'string' && value.trim().length > 0; }
async function authorize({ client, principal, tenantRef }, capability) {
  assertTenantRef(tenantRef);
  if (!await can(client, principal, capability)) throw new Error('forbidden');
}

/** Server integration seam: caller supplies trusted, reviewed grants separately from source.
 * The existing configuration capability gates imports, read gates evaluation. */
export async function importPack({ source, rights, grants, use = 'tenant-only', ...context }) {
  await authorize(context, 'configuration');
  const manifest = validateLicense({ source, rights, grants, use, tenantRef: context.tenantRef });
  const doc = JSON.parse(source);
  if (![doc.packId, doc.version, doc.edition, doc.profile].every(text)
    || !Array.isArray(doc.controls) || !doc.controls.length || doc.controls.length > 1000) {
    throw new TypeError('pack identity and bounded controls are required');
  }
  const seen = new Set();
  const controls = doc.controls.map(entry => {
    if (seen.has(entry?.controlId)) throw new TypeError('duplicate authored control');
    seen.add(entry?.controlId);
    const control = controlFor(entry?.controlId);
    if (!control || control.provenance.source !== 'original') {
      throw new TypeError('pack must reference a registered authored control');
    }
    if (entry.evaluatorVersion !== control.evaluatorVersion) throw new TypeError('control evaluator version mismatch');
    const refs = entry.frameworkRefs ?? control.frameworkRefs;
    if (!Array.isArray(refs) || refs.length > 100) throw new TypeError('invalid framework references');
    const frameworkRefs = refs.map(ref => {
      if (!text(ref?.framework) || !text(ref?.ref)
        || (ref.edition != null && !text(ref.edition)) || (ref.profile != null && !text(ref.profile))) {
        throw new TypeError('framework references require reference codes');
      }
      return { framework: ref.framework, ref: ref.ref, edition: ref.edition ?? null,
        profile: ref.profile ?? null, relationship: 'evidence-link' };
    });
    return { controlId: control.controlId, evaluatorVersion: control.evaluatorVersion,
      framework: control.framework, edition: control.edition, profile: control.profile, frameworkRefs };
  });
  const pack = freeze({ contractVersion: 1, tenantRef: context.tenantRef, packId: doc.packId,
    version: doc.version, edition: doc.edition, profile: doc.profile, rights: manifest, controls });
  imported.add(pack);
  return pack;
}

function currentPack(pack) {
  if (!imported.has(pack)) throw new TypeError('pack requires rights-validated import');
  for (const entry of pack.controls) {
    const current = controlFor(entry.controlId);
    if (!current || ['framework', 'edition', 'profile', 'evaluatorVersion'].some(key => current[key] !== entry[key])) {
      throw new TypeError('pack control version mismatch');
    }
  }
}
function cacheKey(pack) { return sourceDigest(JSON.stringify(pack)); }

/** Compatibility only, NOT freshness validation or authorization to serve cached data.
 * Legacy results lack this versioned identity and must be recomputed. */
export function packCacheMatches(pack, cached) {
  currentPack(pack);
  return cached?.contractVersion === 1 && cached.tenantRef === pack.tenantRef
    && cached.packCacheKey === cacheKey(pack);
}

export async function evaluatePack({ pack, observations = {}, now = new Date(), ...context }) {
  await authorize(context, 'read');
  currentPack(pack);
  if (pack.tenantRef !== context.tenantRef) throw new Error('pack tenant mismatch');
  // Always re-evaluate observations: a matching pack version alone proves no freshness.
  const results = pack.controls.map(entry => evaluateControl({ controlId: entry.controlId,
    tenantRef: context.tenantRef, observations, now }));
  const evidenceLinks = pack.controls.flatMap(entry => entry.frameworkRefs.map(ref => ({
    controlId: entry.controlId, ...ref,
  })));
  return freeze({ contractVersion: 1, tenantRef: context.tenantRef, packCacheKey: cacheKey(pack),
    results, evidenceLinks, qualification: 'fixture-tested' });
}

/** Task 119: reviewed public-domain catalog, existing authorization/evaluation seam. */
export async function importNistPack(context) {
  await authorize(context, 'configuration');
  return importPack({ ...context, ...nistPackInput(context.tenantRef) });
}
