// engine/authz/can.mjs
//
// The single capability check (§3.2): can(principal, capability, at). It consults only
// grants whose [active_from, active_until) window contains `at`, treating a null
// active_until as open-ended, and it grants a disabled principal nothing even with live
// grants. The window logic lives in capabilitiesForPrincipal so the check and the
// portal's identity resolution can never disagree.
//
// Task 90: without an entity, `can` asks the tenant-wide question and only a central
// (scope `*`) grant answers it. With { entityCode }, a grant scoped to that entity
// answers too. Which entity a resource belongs to is never the caller's claim alone:
// entityScope.mjs derives it from current task-89 ownership evidence.
import { scopedCapabilitiesForPrincipal } from './principals.mjs';

export async function can(client, principal, capability, at = new Date(), { entityCode = null } = {}) {
  const scoped = await scopedCapabilitiesForPrincipal(client, principal, at);
  if (scoped.central.includes(capability)) return true;
  return entityCode != null && (scoped.entities[entityCode] ?? []).includes(capability);
}

/**
 * Where a principal holds `capability` at `at`:
 *   { central: true }                        - tenant-wide, every entity
 *   { central: false, entities: [CODE, ...] } - only those entities' resources
 * An empty entity list means no scope at all; it never means "everything".
 */
export async function capabilityScope(client, principal, capability, at = new Date()) {
  const scoped = await scopedCapabilitiesForPrincipal(client, principal, at);
  if (scoped.central.includes(capability)) return { central: true, entities: [] };
  return {
    central: false,
    entities: Object.entries(scoped.entities).filter(([, caps]) => caps.includes(capability)).map(([code]) => code).sort(),
  };
}
