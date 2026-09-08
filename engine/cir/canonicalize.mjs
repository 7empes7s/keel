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
import { naturalKeyFor } from './naturalKey.mjs';

export class NaturalKeyCollisionError extends Error {
  constructor(collisions) {
    super(`natural-key collision at collection: ${collisions.map((c) => c.naturalKey).join(', ')}`);
    this.collisions = collisions;
  }
}

// Exported: engine/collect/descriptors.mjs reads these as the single source of
// truth for per-type criticality / blastRadius / fidelity. Do not duplicate
// these maps elsewhere.
export const FIDELITY = {
  user: 'read-only',
  authenticationStrengthPolicy: 'read-only',
  group: 'full',
  roleAssignment: 'full',
  namedLocation: 'full',
  conditionalAccessPolicy: 'full',
};

export const BLAST_RADIUS = {
  user: 'access-affecting',
  authenticationStrengthPolicy: 'tenant-lockout',
  group: 'access-affecting',
  roleAssignment: 'tenant-lockout',
  namedLocation: 'tenant-lockout',
  conditionalAccessPolicy: 'tenant-lockout',
};

const RESTORE_PRIORITY = {
  user: 200,
  group: 200,
  roleAssignment: 200,
  authenticationStrengthPolicy: 150,
  namedLocation: 150,
  conditionalAccessPolicy: 150,
};

export const CRITICALITY = { user: 'tier2', authenticationStrengthPolicy: 'tier1', group: 'tier1',
  roleAssignment: 'tier1', namedLocation: 'tier1', conditionalAccessPolicy: 'tier1' };

// M1 deliberately does not collect directory role templates: they are
// Microsoft-global catalog entries, not tenant resources to recreate. Resolve
// the one role template that M1's break-glass invariant needs into the same
// stable symbol used by role-assignment natural keys.
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
    idToSymbol.set(obj.id.toLowerCase(), key);
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
      const key = `${type}:${naturalKeyFor(type, obj)}`;
      selfContained.push({ type, obj, key });
      idToSymbol.set(obj.id.toLowerCase(), key);
    }
  }

  // Pass 1b: materialize the self-contained resources.
  for (const { type, obj, key } of selfContained) addResource(type, obj, key);

  // Pass 2: roleAssignment, using pass 1's symbol lookup.
  const resolveSymbol = (guid) =>
    idToSymbol.get(guid.toLowerCase()) ?? GLOBAL_ROLE_SYMBOLS.get(guid.toLowerCase()) ?? null;
  const roleAssignments = collected.find(([t]) => t === 'roleAssignment')?.[1] ?? [];
  for (const obj of roleAssignments) {
    const key = naturalKeyFor('roleAssignment', obj, { resolveSymbol });
    addResource('roleAssignment', obj, key);
  }

  if (collisions.length) throw new NaturalKeyCollisionError(collisions);
  return resources;
}

function buildResource(type, obj, key, index, idToSymbol) {
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
    criticality: CRITICALITY[type],
    blastRadius: BLAST_RADIUS[type],
    restorePriority: RESTORE_PRIORITY[type],
    provenance: {
      adapter: 'keel/entra@0.1.0',
      collectedAt: new Date().toISOString(),
      fidelity: FIDELITY[type],
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
  if (classified.klass === 'unresolvable' && resolvedSymbol) {
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
