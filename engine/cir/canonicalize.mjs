/**
 * Builds the CIR (spec §6) from raw Graph objects. Two passes: pass 1 assigns
 * natural keys to every self-contained object type and records a Graph-id ->
 * symbol lookup; pass 2 canonicalizes roleAssignment, whose own key is composed
 * from pass 1's symbols (spec §6.1's "qualify by parent scope"). Reference
 * classification reuses tenant-probe's classify()/buildIndex() verbatim — that
 * logic already carries the hard-won corrections from the 99.7% measurement
 * (SENTINEL fix, WELL_KNOWN app ids, built-in role templates) and must not be
 * re-derived here.
 */
import { classify, buildIndex, walkGuids, ownIdentifiers } from '../../tools/tenant-probe/references.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { naturalKeyFor } from './naturalKey.mjs';

export class NaturalKeyCollisionError extends Error {
  constructor(collisions) {
    super(`natural-key collision at collection: ${collisions.map((c) => c.naturalKey).join(', ')}`);
    this.collisions = collisions;
  }
}

/**
 * Wraps naturalKeyFor() with overrides for the two types the 2026-09-08
 * widening measurement found could not safely use naturalKey()'s default
 * `displayName ?? name ?? id` fallback (measured against the collector
 * tenant; see engine/collect/descriptors.mjs for the full per-type table):
 *
 *  - crossTenantAccessPolicyPartner objects carry NO id, displayName, or
 *    name at all — Graph identifies a partner tenant purely by `tenantId`.
 *    The bare fallback silently resolved to the literal value `undefined`
 *    for every partner, which collided as soon as the tenant had more than
 *    one (measured: 2 partners, 1 collision). `tenantId` is the partner
 *    organization's own stable, real-world identifier — not a
 *    randomly-assigned directory object id — so it is the correct natural
 *    key here, and it is a "foreign" tenant id by design (spec's
 *    foreignTenant reference class), not something that needs remapping.
 *  - adminConsentRequestPolicy is a true Graph singleton (catalog entry
 *    marks it `singleton: true`) with no id, displayName, or name either.
 *    A fixed key can never collide because there is structurally never a
 *    second object of this type, but naming the CIR resource "undefined"
 *    is needless — the type name itself is a stable, human-legible key.
 */
function keyFor(type, obj, ctx) {
  if (type === 'crossTenantAccessPolicyPartner') return obj.tenantId ?? naturalKeyFor(type, obj);
  if (type === 'adminConsentRequestPolicy') return 'adminConsentRequestPolicy';
  return naturalKeyFor(type, obj, ctx);
}

/**
 * Both types above also lack `id`, so the id->symbol map used to resolve
 * GUID references cannot be keyed off `obj.id` unconditionally — nothing
 * can ever reference either type by a GUID it doesn't have, so skipping the
 * mapping when `id` is absent is a safe no-op rather than a crash.
 */
function idKey(obj, type) {
  // Global templates can share ids with active role definitions. Collecting
  // the catalogue must not overwrite those tenant symbols or change existing
  // role-assignment keys. buildIndex already classifies templates as global.
  if (type === 'directoryRoleTemplate' || type === 'directorySettingTemplate') return null;
  return obj?.id != null ? String(obj.id).toLowerCase() : null;
}

// Fidelity is declared here — the catalog carries no fidelity field.
// engine/collect/descriptors.mjs reads this map; do not duplicate it.
//
// criticality / blastRadius are NOT declared here. The single source of truth
// for both is the tenant-probe catalog (tools/tenant-probe/catalog.mjs) —
// keeping a second copy here is what let `user` silently sit on tier2 while
// the catalog said tier1.
export const FIDELITY = {
  user: 'read-only',
  authenticationStrengthPolicy: 'read-only',
  group: 'full',
  roleAssignment: 'full',
  namedLocation: 'full',
  conditionalAccessPolicy: 'full',
};

const CATALOG_BY_TYPE = new Map(CATALOG.map((entry) => [entry.type, entry]));

const RESTORE_PRIORITY = {
  user: 200,
  group: 200,
  roleAssignment: 200,
  authenticationStrengthPolicy: 150,
  namedLocation: 150,
  conditionalAccessPolicy: 150,
};

// Preserve M1's stable break-glass symbol even when a scoped collection lacks
// role templates. Templates are global catalogues, not resources to recreate.
const GLOBAL_ROLE_SYMBOLS = new Map([
  ['62e90394-69f5-4237-9190-012177145e10', 'global:GlobalAdministrator'],
]);

export function canonicalizeAll(collected) {
  const index = buildIndex(collected);
  const idToSymbol = new Map();
  const resources = [];
  const byKey = new Map();
  const collisions = [];

  const addResource = (type, obj, key) => {
    const existing = byKey.get(key);
    if (existing) {
      collisions.push({ type, naturalKey: key, ids: [existing.sourceId, obj.id] });
      return;
    }
    const idk = idKey(obj, type);
    if (idk) idToSymbol.set(idk, key);
    const resource = buildResource(type, obj, key, index, idToSymbol);
    byKey.set(key, resource);
    resources.push(resource);
  };

  // Pass 1a: assign every self-contained key before extracting references, so
  // references are independent of the input collection's ordering.
  const selfContained = [];
  for (const [type, objects] of collected) {
    if (type === 'roleAssignment') continue;
    for (const obj of objects) {
      const key = `${type}:${keyFor(type, obj)}`;
      selfContained.push({ type, obj, key });
      const idk = idKey(obj, type);
      if (idk) idToSymbol.set(idk, key);
    }
  }

  // Pass 1b: materialize the self-contained resources.
  for (const { type, obj, key } of selfContained) addResource(type, obj, key);

  // Pass 2: roleAssignment, using pass 1's symbol lookup.
  const resolveSymbol = (guid) =>
    idToSymbol.get(guid.toLowerCase()) ?? GLOBAL_ROLE_SYMBOLS.get(guid.toLowerCase()) ?? null;
  const roleAssignments = collected.find(([t]) => t === 'roleAssignment')?.[1] ?? [];
  for (const obj of roleAssignments) {
    const key = keyFor('roleAssignment', obj, { resolveSymbol });
    addResource('roleAssignment', obj, key);
  }

  if (collisions.length) throw new NaturalKeyCollisionError(collisions);
  return resources;
}

function buildResource(type, obj, key, index, idToSymbol) {
  const catalogEntry = CATALOG_BY_TYPE.get(type);
  const ownIds = ownIdentifiers(type, obj);
  const references = [];
  const seen = new Set();
  for (const { path, guid } of referenceValues(obj, idToSymbol)) {
    if (seen.has(path)) continue;
    seen.add(path);
    const c = classifyCanonicalReference({
      path, guid, ownIds, index, resolvedSymbol: idToSymbol.get(guid.toLowerCase()),
    });
    if (c.klass === 'identity' || c.klass === 'nonReference') continue;
    references.push({ field: path, symbol: symbolFor(c, guid), required: true, klass: c.klass });
  }
  return {
    naturalKey: key,
    resourceType: type,
    payload: obj,
    references,
    criticality: catalogEntry?.criticality,
    blastRadius: catalogEntry?.blastRadius,
    restorePriority: RESTORE_PRIORITY[type],
    provenance: {
      adapter: 'keel/entra@0.1.0',
      collectedAt: new Date().toISOString(),
      // `?? 'read-only'` here is not a second source of truth: FIDELITY above
      // is still the only place fidelity values are declared. This is the
      // same default engine/collect/descriptors.mjs applies at its own point
      // of use (describe(): `FIDELITY[type] ?? 'read-only'`) — descriptors.mjs
      // imports FIDELITY from this file, so this file cannot import back from
      // descriptors.mjs (circular import), which is why the default is
      // duplicated at these two use sites instead of centralized in one
      // resolver function. If this default ever changes, change it in both
      // places. Understating fidelity ('read-only') is safe; a wrong 'full'
      // is a product defect, so unknown types must default to 'read-only'.
      fidelity: FIDELITY[type] ?? 'read-only',
    },
    sourceId: obj.id,
  };
}

function* referenceValues(node, idToSymbol, path = '') {
  yield* walkGuids(node, path);
  yield* walkKnownSymbolValues(node, idToSymbol, path);
}

function* walkKnownSymbolValues(node, idToSymbol, path) {
  if (typeof node === 'string') {
    if (idToSymbol.has(node.toLowerCase())) yield { path, guid: node };
    return;
  }
  if (Array.isArray(node)) {
    for (const [i, value] of node.entries()) {
      yield* walkKnownSymbolValues(value, idToSymbol, `${path}[${i}]`);
    }
    return;
  }
  if (node && typeof node === 'object') {
    for (const [field, value] of Object.entries(node)) {
      yield* walkKnownSymbolValues(value, idToSymbol, path ? `${path}.${field}` : field);
    }
  }
}

function classifyCanonicalReference({ path, guid, ownIds, index, resolvedSymbol }) {
  const classified = classify({ path, guid, ownIds, index });
  const globalRoleSymbol = GLOBAL_ROLE_SYMBOLS.get(guid);
  if (classified.klass === 'unresolvable' && globalRoleSymbol) {
    return { klass: 'globalConstant', key: globalRoleSymbol.slice('global:'.length) };
  }
  if ((classified.klass === 'unresolvable' || classified.klass === 'resolvable') && resolvedSymbol) {
    return { klass: 'resolvable', symbol: resolvedSymbol };
  }
  return classified;
}

function symbolFor(c, guid) {
  if (c.symbol) return c.symbol;
  if (c.klass === 'globalConstant') return `global:${c.key ?? guid}`;
  if (c.klass === 'foreignTenant') return `foreignTenant:${guid}`;
  if (c.klass === 'readOnly') return `readOnly:${guid}`;
  if (c.klass === 'unresolvable') return null;
  return `${c.kind}:${c.key ?? guid}`; // resolvable
}
