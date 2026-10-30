/**
 * Who may run a content restore, and where it may write (Wave 2 MAILR; FILER uses the
 * same checks).
 *
 *  - The actor must hold the `content-restore` capability (engine/authz/can.mjs).
 *  - The run must carry an approved `content-restore` request for exactly this plan
 *    (params.runId is the plan digest), asked by the actor and decided by someone else.
 *  - The approval must cover the restore's approval-policy class: a restore to another
 *    location needs a request filed as `content-restore-other-location`, so the tenant's
 *    two-person rule for that class applied when it was approved.
 *  - A request the customer's restore approval settings approved (content restores and
 *    the workload's service both off) runs only while they are still off.
 *  - The run must start within CONTENT_RESTORE_EXECUTION_WINDOW_MS of the decision, and a
 *    run that already completed is never started again: a new restore needs a new request.
 *  - On a test tenant, a restore writes only to targets named with the `KEEL-RT-` prefix.
 *    Matching is on the prefix only.
 */
import { can } from '../../authz/can.mjs';
import { findPrincipalById } from '../../authz/principals.mjs';
import { RESTORE_APPROVALS_OFF_DECIDER, contentRestoreNeedsApproval } from '../../govern/restoreApprovalSettings.mjs';

export const CONTENT_RESTORE_CAPABILITY = 'content-restore';
export const CONTENT_RESTORE_ACTION = 'content-restore';
export const TEST_FIXTURE_PREFIX = 'KEEL-RT-';
export const CONTENT_RESTORE_OTHER_LOCATION = 'content-restore-other-location';
// How long after its decision an approved content restore may start.
export const CONTENT_RESTORE_EXECUTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export class ContentRestoreRefusedError extends Error {}

/**
 * Problems with a restore target, empty when it may be written. `names` are the
 * target's display name, address and sign-in name (or a site or drive name for FILER).
 */
export function targetProblems({ tenantRef, names, testTenantRefs }) {
  if (!Array.isArray(testTenantRefs)) throw new TypeError('targetProblems needs the test tenant list');
  if (!testTenantRefs.includes(tenantRef)) return [];
  const wanted = TEST_FIXTURE_PREFIX.toLowerCase();
  const named = (names ?? []).filter((name) => typeof name === 'string' && name);
  if (named.some((name) => name.toLowerCase().startsWith(wanted)
    || name.toLowerCase().split('@')[0].startsWith(wanted))) return [];
  return [`on the test tenant a restore writes only to ${TEST_FIXTURE_PREFIX} targets; ${named[0] ?? 'this target'} is not one`];
}

/**
 * Checks the actor and the approval. `policyActions` are the approval-policy classes this
 * restore is (CONTENT_RESTORE_OTHER_LOCATION for a restore to another place); the approval
 * must have been filed as each of them. Returns { actor, approvedBy, approvalId,
 * policyActions }; throws ContentRestoreRefusedError with the reason otherwise. Nothing is
 * written.
 */
export async function authorizeContentRestore(client, {
  actor, approvalId, runId, tenantRef, at = new Date(), canFn = can, policyActions = [],
  executionWindowMs = CONTENT_RESTORE_EXECUTION_WINDOW_MS,
}) {
  if (typeof actor !== 'string' || !actor) throw new ContentRestoreRefusedError('a content restore needs --actor (the principal id running it)');
  const principal = await findPrincipalById(client, actor);
  if (!principal || principal.disabled_at) throw new ContentRestoreRefusedError(`actor ${actor} is not an enabled principal`);
  if (!(await canFn(client, principal, CONTENT_RESTORE_CAPABILITY, at))) {
    throw new ContentRestoreRefusedError(`actor ${actor} does not hold the ${CONTENT_RESTORE_CAPABILITY} capability`);
  }
  if (typeof approvalId !== 'string' || !approvalId) throw new ContentRestoreRefusedError('a content restore needs --approval-id (an approved content-restore request)');
  const { rows } = await client.query(
    `SELECT id, action, params, requested_by, decided_by, decided_at, status, policy_actions FROM approval_request WHERE id::text = $1`,
    [approvalId],
  );
  const request = rows[0];
  if (!request) throw new ContentRestoreRefusedError(`approval request ${approvalId} was not found`);
  if (request.action !== CONTENT_RESTORE_ACTION) throw new ContentRestoreRefusedError(`approval request ${approvalId} is not a content restore`);
  if (request.status !== 'approved') throw new ContentRestoreRefusedError(`approval request ${approvalId} is ${request.status}, not approved`);
  if (request.params?.runId !== runId || request.params?.tenantRef !== tenantRef) {
    throw new ContentRestoreRefusedError(`approval request ${approvalId} approved another restore plan`);
  }
  if (request.requested_by !== actor) throw new ContentRestoreRefusedError(`approval request ${approvalId} was asked by someone else`);
  if (!request.decided_by || request.decided_by === request.requested_by) {
    throw new ContentRestoreRefusedError(`approval request ${approvalId} was not decided by someone other than the requester`);
  }
  if (request.decided_by === RESTORE_APPROVALS_OFF_DECIDER
    && (await contentRestoreNeedsApproval(client, { tenantRef, workload: request.params?.workload })).required) {
    throw new ContentRestoreRefusedError(`approval request ${approvalId} was approved because restore approvals were off, and they are on again; file a new request`);
  }
  const filedAs = Array.isArray(request.policy_actions) ? request.policy_actions : [];
  const missing = policyActions.filter((actionClass) => !filedAs.includes(actionClass));
  if (missing.length) {
    throw new ContentRestoreRefusedError(`approval request ${approvalId} was not filed as ${missing.join(', ')}; file a new request for this restore`);
  }
  const decidedAt = request.decided_at ? new Date(request.decided_at).valueOf() : NaN;
  if (!Number.isFinite(decidedAt) || new Date(at).valueOf() - decidedAt > executionWindowMs) {
    throw new ContentRestoreRefusedError(`approval request ${approvalId} was approved more than ${Math.round(executionWindowMs / 3600000)} hours ago; file a new request`);
  }
  const { rows: [run] } = await client.query('SELECT status FROM content_restore_run WHERE id = $1', [runId]);
  if (run?.status === 'completed') {
    throw new ContentRestoreRefusedError(`restore run ${runId} already completed; to restore again, file a new request for another point in time (--at)`);
  }
  return { actor, approvedBy: request.decided_by, approvalId: request.id, policyActions: filedAs };
}

/**
 * Refuses a point in time after the request is made: the approved plan must never grow
 * with backups taken after it was reviewed.
 */
export function refuseFuturePointInTime(at, now = new Date()) {
  if (at !== null && at !== undefined && new Date(at).valueOf() > now.valueOf()) {
    throw new ContentRestoreRefusedError(`the point in time ${new Date(at).toISOString()} is after now; a restore request can only name a past point in time`);
  }
}

/** Refuses when an authorized restore was not approved as this approval-policy class. */
export function requireContentPolicyAction(authorized, actionClass) {
  if (actionClass === CONTENT_RESTORE_ACTION) return authorized;
  if (!authorized.policyActions.includes(actionClass)) {
    throw new ContentRestoreRefusedError(`approval request ${authorized.approvalId} was not filed as ${actionClass}; file a new request for this restore`);
  }
  return authorized;
}
