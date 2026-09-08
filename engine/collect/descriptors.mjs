/**
 * ResourceTypeDescriptors (spec §7.1) for the resource types the collector
 * serves. One descriptor per type; the `adapter` field is the STATIC,
 * VERSIONED id of the serving adapter (spec §4.2) — it is a declaration, never
 * resolved at runtime, and there is deliberately no fallback mechanism.
 *
 * Only the six types collected today are seeded. The remaining catalog entries
 * are Phase 3 and require the consent pass first — do NOT add descriptors for
 * types we have not been granted consent to read.
 *
 * criticality / blastRadius / fidelity are imported from cir/canonicalize.mjs,
 * the single source of truth — duplicating those values here would create a
 * second source of truth.
 */
import { CRITICALITY, BLAST_RADIUS, FIDELITY } from '../cir/canonicalize.mjs';

function describe(type, { unsupportedFields = [], naturalKeyStrategy, remappable }) {
  return {
    type,
    fidelity: FIDELITY[type],
    unsupportedFields,
    criticality: CRITICALITY[type],
    blastRadius: BLAST_RADIUS[type],
    naturalKeyStrategy,
    remappable,
    adapter: `graph-native/${type}`,
  };
}

// Order is load-bearing: M1_TYPES derives from this array and callers compare
// against the historical collection order.
export const DESCRIPTORS = [
  // UPN is tenant-bound and passwords are never readable — a user cannot be
  // remapped into another tenant as the same principal.
  describe('user', {
    unsupportedFields: ['passwordProfile'],
    naturalKeyStrategy: 'userPrincipalName',
    remappable: false,
  }),
  describe('authenticationStrengthPolicy', {
    naturalKeyStrategy: 'displayName',
    remappable: true,
  }),
  describe('group', {
    naturalKeyStrategy: 'mailNickname',
    remappable: true,
  }),
  describe('roleAssignment', {
    naturalKeyStrategy: 'composed:roleDefinition@principal@directoryScope',
    remappable: true,
  }),
  describe('namedLocation', {
    naturalKeyStrategy: 'displayName',
    remappable: true,
  }),
  describe('conditionalAccessPolicy', {
    naturalKeyStrategy: 'displayName',
    remappable: true,
  }),
];
