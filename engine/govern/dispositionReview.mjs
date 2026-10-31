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
import { MAX_IGNORE_DAYS } from '../store/openDrift.mjs';
import { selfApprovalAllowed } from './approvalMode.mjs';

export const DISPOSE_APPROVAL_ACTION = 'dispose';
export { MAX_IGNORE_DAYS };
const DAY_MS = 24 * 60 * 60 * 1000;

// Service settings whose changes are admin-role changes: the same weight as an Entra
// role assignment, which is rated tenant-lockout.
export const PRIVILEGED_SERVICE_WORKLOADS = Object.freeze(['exchange-role-groups']);

// Entra and other admin-role and sign-in-trust types the catalog rates only
// access-affecting: who holds an admin role in Exchange, Intune, Defender or access
// packages, the rules that gate a PIM activation, and which other tenants and
// identity providers sign-ins are trusted from. A decision on any of them needs a
// second person, whatever their rating.
export const PRIVILEGED_DRIFT_TYPES = Object.freeze([
  'defenderRoleAssignment', 'defenderRoleDefinition',
  'deviceManagementRoleAssignment', 'deviceManagementRoleDefinition',
  'entitlementManagementRoleAssignment',
  'exchangeRoleAssignment', 'exchangeRoleDefinition',
  'privilegedAccessGroupResource', 'unifiedRoleManagementPolicyAssignment',
  'crossTenantAccessPolicy', 'crossTenantAccessPolicyConfigurationDefault', 'crossTenantAccessPolicyPartner',
  'externalDomainFederation', 'identityProvider', 'certificateBasedApplicationConfiguration',
]);


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
  if (PRIVILEGED_DRIFT_TYPES.includes(resourceType)) return true;
  const rating = gateBlastRadius(resourceType, blastRadius ?? null) ?? 'tenant-lockout';
  return rating !== 'cosmetic' && rating !== 'access-affecting';
}

/** The same rule for a service setting change: any change to an admin-role service
 * except a rename of an existing item (an added role group is rated cosmetic, but it
 * can hold admin rights), or a rating that is neither of the two lower ones. */
export function serviceChangeNeedsReview({ workload, blastRadius, changeType }) {
  if (PRIVILEGED_SERVICE_WORKLOADS.includes(workload)) return !(changeType === 'modified' && blastRadius === 'cosmetic');
  return blastRadius !== 'cosmetic' && blastRadius !== 'access-affecting';
}

/**
 * The approval that lets this decision run, checked, or a refusal. It must be an
 * approved 'dispose' request, made by the person now acting, decided by someone else
 * (or self-approved while `tenantRef`'s approval mode is solo, approvalMode.mjs), and
 * for exactly this decision (`matches` compares its params).
 */
export async function assertDispositionApproval(client, { approvalId, actor, matches, tenantRef = null }) {
  if (typeof approvalId !== 'string' || approvalId.length === 0) throw new DispositionReviewRequiredError();
  const { rows: [request] } = await client.query(
    `SELECT id, action, params, requested_by, decided_by, status, created_at, self_approved FROM approval_request
      WHERE id::text = $1`,
    [approvalId],
  );
  if (!request || request.action !== DISPOSE_APPROVAL_ACTION) throw new DispositionApprovalError('no such decision approval');
  if (request.status !== 'approved') throw new DispositionApprovalError(`the decision approval is ${request.status}, not approved`);
  if (request.requested_by !== actor) throw new DispositionApprovalError('the decision approval was asked for by someone else');
  if (!request.decided_by) throw new DispositionApprovalError('the decision approval was not made by a second person');
  if (request.decided_by === request.requested_by
    && !(request.self_approved === true && await selfApprovalAllowed(client, { tenantRef }))) {
    throw new DispositionApprovalError(request.self_approved === true
      ? 'the decision approval was self-approved, and approvals need two people again; ask again'
      : 'the decision approval was not made by a second person');
  }
  if (!matches(request.params ?? {})) throw new DispositionApprovalError('the decision approval is for another decision');
  return request;
}

/**
 * A dispose request still waiting for the same decision on the same change: driftId with
 * this action, or serviceChangeId (accept only). Asking again returns this one, so a
 * second click or a retried send never puts a second request in front of an approver.
 * Only the same person's request counts: another person asking stays their own request.
 * Callers use it for accept only; an ignore carries its own end date, so two are not the same.
 * @param {{ query: Function }} client
 * @param {{ driftId?: string | null, serviceChangeId?: string | null, action: string, requestedBy: string }} change
 */
export async function pendingDisposeRequest(client, { driftId = null, serviceChangeId = null, action, requestedBy }) {
  const match = driftId != null
    ? { sql: "params->'driftIds' = jsonb_build_array($2::text)", value: String(driftId) }
    : { sql: "params->>'serviceChangeId' = $2", value: String(serviceChangeId) };
  const { rows: [request] } = await client.query(
    `SELECT * FROM approval_request
      WHERE action = $1 AND status = 'pending' AND expires_at > now()
        AND ${match.sql} AND params->>'action' = $3 AND requested_by = $4
      ORDER BY created_at LIMIT 1`,
    [DISPOSE_APPROVAL_ACTION, match.value, action, String(requestedBy)],
  );
  return request ?? null;
}

/** Whether this drift row already has an accept recorded. */
export async function driftAlreadyAccepted(client, { driftId }) {
  const { rows } = await client.query(
    "SELECT 1 FROM disposition WHERE drift_id::text = $1 AND action = 'accept' LIMIT 1",
    [String(driftId)],
  );
  return rows.length > 0;
}
