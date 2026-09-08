/**
 * ResourceTypeDescriptors (spec §7.1) for every resource type in the
 * tenant-probe catalog. One descriptor per type; the `adapter` field is the
 * STATIC, VERSIONED id of the serving adapter (spec §4.2) — it is a
 * declaration, never resolved at runtime, and there is deliberately no
 * fallback mechanism.
 *
 * criticality / blastRadius come from the tenant-probe CATALOG, the single
 * source of truth — duplicating those values here is what let `user` sit on
 * tier2 while the catalog said tier1. fidelity comes from cir/canonicalize.mjs
 * (the catalog has no fidelity field), defaulting to 'read-only': a type is
 * 'full' only where engine/restore/applyEngine.mjs's pathFor() has a write
 * path for it. Understating fidelity is safe; overstating it is a product
 * defect.
 *
 * DESCRIPTORS vs ALL_DESCRIPTORS: ALL_DESCRIPTORS covers all 52 catalog types
 * — the registry KNOWS about every type. DESCRIPTORS is exactly the six M1
 * types, in historical collection order, and is what entraAdapter.mjs
 * registers and derives M1_TYPES from. The new types are deliberately NOT
 * wired into collectM1 yet; turning collection on is a later change.
 */

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { FIDELITY } from '../cir/canonicalize.mjs';

const CATALOG_BY_TYPE = new Map(CATALOG.map((entry) => [entry.type, entry]));

// Per-type descriptor details the catalog does not carry. Only non-default
// values are listed:
//   naturalKeyStrategy — how naturalKeyFor() keys the type. Default
//     'displayName' is naturalKey()'s fallback branch (displayName ?? name ??
//     id), used by every type without a named case there.
//   remappable — default false. True only where the type's references can be
//     remapped at apply time; when unsure, understate.
const DETAILS = {
  // UPN is tenant-bound and passwords are never readable — a user cannot be
  // remapped into another tenant as the same principal.
  user: {
    naturalKeyStrategy: 'userPrincipalName',
    remappable: false,
    unsupportedFields: ['passwordProfile'],
  },
  authenticationStrengthPolicy: { naturalKeyStrategy: 'displayName', remappable: true },
  group: { naturalKeyStrategy: 'mailNickname', remappable: true },
  roleAssignment: {
    naturalKeyStrategy: 'composed:roleDefinition@principal@directoryScope',
    remappable: true,
  },
  namedLocation: { naturalKeyStrategy: 'displayName', remappable: true },
  conditionalAccessPolicy: { naturalKeyStrategy: 'displayName', remappable: true },
  domain: { naturalKeyStrategy: 'id' },
  subscribedSku: { naturalKeyStrategy: 'skuPartNumber' },
  application: { naturalKeyStrategy: 'appId' },
  servicePrincipal: { naturalKeyStrategy: 'appId' },
  roleDefinition: { naturalKeyStrategy: 'roleTemplateId' },
  directoryRole: { naturalKeyStrategy: 'roleTemplateId' },
};

function describe(type) {
  const entry = CATALOG_BY_TYPE.get(type);
  if (!entry) throw new Error(`no catalog entry for resource type ${type}`);
  const details = DETAILS[type] ?? {};
  return {
    type,
    fidelity: FIDELITY[type] ?? 'read-only',
    unsupportedFields: details.unsupportedFields ?? [],
    criticality: entry.criticality,
    blastRadius: entry.blastRadius,
    naturalKeyStrategy: details.naturalKeyStrategy ?? 'displayName',
    remappable: details.remappable ?? false,
    adapter: `graph-native/${type}`,
  };
}

// The six types collected today, in historical collection order. Order is
// load-bearing: entraAdapter.mjs derives M1_TYPES from this array and callers
// compare against the historical collection order.
export const DESCRIPTORS = [
  'user',
  'authenticationStrengthPolicy',
  'group',
  'roleAssignment',
  'namedLocation',
  'conditionalAccessPolicy',
].map(describe);

// Every catalog type, M1 first (the same descriptor objects as DESCRIPTORS),
// then the rest in catalog order. NOT wired into collection — see header.
export const ALL_DESCRIPTORS = [
  ...DESCRIPTORS,
  ...CATALOG.filter((entry) => !DESCRIPTORS.some((d) => d.type === entry.type)).map((entry) =>
    describe(entry.type),
  ),
];
