// engine/authz/can.mjs
//
// The single capability check (§3.2): can(principal, capability, at). It consults only
// grants whose [active_from, active_until) window contains `at`, treating a null
// active_until as open-ended, and it grants a disabled principal nothing even with live
// grants. The window logic lives in capabilitiesForPrincipal so the check and the
// portal's identity resolution can never disagree.
import { capabilitiesForPrincipal } from './principals.mjs';

export async function can(client, principal, capability, at = new Date()) {
  return (await capabilitiesForPrincipal(client, principal, at)).includes(capability);
}
