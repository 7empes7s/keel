// engine/govern/dispositionReview.mjs
//
// Security audit run 2, finding 3: one operator could accept a weakened sign-in setting
// (a Conditional Access policy, a named location, an admin role) into the approved
// setup, or ignore it with no end date. Both stop Keel from flagging or undoing it.
//
// Two rules close that:
//   1. A decision on a change that can lock people out of the tenant or change who holds
//      admin rights needs a second person. The decision becomes an approval request
//      (action 'dispose'); a different person approves it, and only then does the
//      worker apply it, as the person who asked. Every other change is still decided by
//      one person, as before.
//   2. An ignore always ends, at most MAX_IGNORE_DAYS from now.
//
// Both are enforced here, in the engine, so every caller (portal, keel-govern, worker)
// gets them; the portal only turns the refusal into an approval request.
import { gateBlastRadius } from '../safety/blastRadius.mjs';

export const DISPOSE_APPROVAL_ACTION = 'dispose';
export const MAX_IGNORE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// Service settings whose changes are admin-role changes: the same weight as an Entra
// role assignment, which is rated tenant-lockout.
export const PRIVILEGED_SERVICE_WORKLOADS = Object.freeze(['exchange-role-groups']);

export class DispositionReviewRequiredError extends Error {
  constructor(message = 'this change can affect sign-in or admin access; a second person must approve the decision') {
    super(message);
    this.name = 'DispositionReviewRequiredError';
  }
}
export class DispositionApprovalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DispositionApprovalError';
  }
}
export class IgnoreExpiryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IgnoreExpiryError';
  }
}

/**
 * The end of an ignore, checked: a real date, in the future, and at most
 * MAX_IGNORE_DAYS away. 'infinity' and any unparseable value are refused.
 */
export function ignoreExpiry(expiresAt, now = new Date()) {
  if (expiresAt == null) throw new IgnoreExpiryError('ignore disposition requires expiresAt (an end date)');
  const value = expiresAt instanceof Date ? expiresAt : (typeof expiresAt === 'string' ? new Date(expiresAt) : new Date(NaN));
  if (!Number.isFinite(value.valueOf())) throw new IgnoreExpiryError('the end date of an ignore must be a real date');
  if (value.valueOf() <= now.valueOf()) throw new IgnoreExpiryError('the end date of an ignore must be in the future');
  if (value.valueOf() > now.valueOf() + MAX_IGNORE_DAYS * DAY_MS) {
    throw new IgnoreExpiryError(`an ignore can last at most ${MAX_IGNORE_DAYS} days`);
  }
  return value;
}

/**
 * Whether a decision on this Entra change needs a second person. The gate rating keeps
 * the type's rating as a floor (a Conditional Access policy stays tenant-lockout even
 * when its own rules rate lower), and an unrecognised rating counts as the strictest.
 */
export function driftNeedsReview({ resourceType, blastRadius }) {
  const rating = gateBlastRadius(resourceType, blastRadius ?? null) ?? 'tenant-lockout';
  return rating !== 'cosmetic' && rating !== 'access-affecting';
}

/** The same rule for a service setting change: an admin-role service, or a rating that
 * is neither of the two lower ones. A rename (cosmetic) never needs one. */
export function serviceChangeNeedsReview({ workload, blastRadius }) {
  if (blastRadius === 'cosmetic') return false;
  if (PRIVILEGED_SERVICE_WORKLOADS.includes(workload)) return true;
  return blastRadius !== 'access-affecting';
}

/**
 * The approval that lets this decision run, checked, or a refusal. It must be an
 * approved 'dispose' request, made by the person now acting, decided by someone else,
 * and for exactly this decision (`matches` compares its params).
 */
export async function assertDispositionApproval(client, { approvalId, actor, matches }) {
  if (typeof approvalId !== 'string' || approvalId.length === 0) throw new DispositionReviewRequiredError();
  const { rows: [request] } = await client.query(
    `SELECT id, action, params, requested_by, decided_by, status FROM approval_request
      WHERE id::text = $1`,
    [approvalId],
  );
  if (!request || request.action !== DISPOSE_APPROVAL_ACTION) throw new DispositionApprovalError('no such decision approval');
  if (request.status !== 'approved') throw new DispositionApprovalError(`the decision approval is ${request.status}, not approved`);
  if (request.requested_by !== actor) throw new DispositionApprovalError('the decision approval was asked for by someone else');
  if (!request.decided_by || request.decided_by === request.requested_by) {
    throw new DispositionApprovalError('the decision approval was not made by a second person');
  }
  if (!matches(request.params ?? {})) throw new DispositionApprovalError('the decision approval is for another decision');
  return request;
}
