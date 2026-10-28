/**
 * Gap register D1: whether a tenant-lockout delete (a role assignment, a named
 * location, a Conditional Access policy, ...) may be sent.
 *
 * The What If simulation needs delegated credentials KEEL does not hold, so the
 * decision is derived from evidence KEEL already has, evaluated against the
 * state AFTER the delete:
 *
 *  1. Break-glass readiness (engine/safety/lockoutGate.mjs): every registered
 *     break-glass account stays ready with the object (and any lockout delete
 *     planned before it in the same run) removed from the newest collection.
 *  2. The sign-in path gate (engine/safety/signInPathGate.mjs): the sign-in path
 *     read at the start of the run, replayed without the object, must
 *       - still hold the object before the delete (a Conditional Access policy),
 *       - no longer name the object anywhere (a policy that uses a named
 *         location, a role assignment that a protected account holds), and
 *       - differ from the state before only in the section the delete removes
 *         (`conditionalAccessPolicies` for a Conditional Access policy; nothing
 *         for any other type).
 *
 * Every input is required. A missing or unknown input refuses the delete, and the
 * refusal names the input. The function never calls Microsoft.
 */
import { compareSignInPaths } from './signInPathGate.mjs';

const PREFIX = 'refusing to delete tenant-lockout resource';

// The sign-in path section a delete of each type is expected to change.
const EXPECTED_SECTIONS = Object.freeze({
  conditionalAccessPolicy: Object.freeze(['conditionalAccessPolicies']),
  namedLocation: Object.freeze(['namedLocations']),
});

/**
 * Returns null when the delete may be sent, otherwise the refusal reason.
 *
 * - `lockoutGate`: breakGlassLockoutGate() (or closedLockoutGate()); null when not loaded.
 * - `signInPath`: recordSignInPath()'s result for this run; null when the gate was not given.
 * - `earlierDeletes`: lockout deletes planned before this one in the same run,
 *   each { resourceType, naturalKey, targetId }.
 */
export async function lockoutDeleteRefusal({ resourceType, naturalKey, targetId }, { lockoutGate = null, signInPath = null, earlierDeletes = [] } = {}) {
  if (targetId == null || targetId === '') {
    return `${PREFIX}: the object's id in the target tenant is unknown, so the state after the delete cannot be evaluated`;
  }
  if (!lockoutGate || typeof lockoutGate.evaluate !== 'function') {
    return `${PREFIX}: break-glass readiness was not loaded for this run, so the state after the delete cannot be checked`;
  }
  let readiness;
  try {
    readiness = lockoutGate.evaluate({ operation: 'delete', resourceType, naturalKey, targetId, earlierDeletes });
  } catch (error) {
    readiness = { allowed: false, reason: `the check could not finish (${error.message})` };
  }
  if (readiness?.allowed !== true) {
    return `${PREFIX}: break-glass readiness after the delete is not established: ${readiness?.reason ?? 'no verdict'}`;
  }

  if (!signInPath || typeof signInPath.without !== 'function') {
    return `${PREFIX}: the sign-in path gate was not available for this run, so the sign-in path after the delete cannot be checked`;
  }
  if (resourceType === 'conditionalAccessPolicy' && !signInPath.holds(targetId)) {
    return `${PREFIX}: the policy is not in the sign-in path read, so the sign-in path after the delete cannot be evaluated`;
  }
  const gone = earlierDeletes.map((entry) => entry.targetId).filter((id) => id != null);
  const users = signInPath.usersOf(targetId, gone);
  if (users.length > 0) {
    return `${PREFIX}: the sign-in path still uses this object after the delete (${users.join(', ')})`;
  }
  let compared;
  try {
    const before = await signInPath.without(gone);
    const after = await signInPath.without([...gone, targetId]);
    compared = compareSignInPaths(before, after, { intendedSections: EXPECTED_SECTIONS[resourceType] ?? [] });
  } catch (error) {
    return `${PREFIX}: the sign-in path after the delete could not be evaluated (${error.message})`;
  }
  if (!compared.allowed) {
    return `${PREFIX}: the delete changes the sign-in path of a protected account (${compared.changed.join(', ')})`;
  }
  return null;
}
