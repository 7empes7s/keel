/**
 * Who may run a content restore, and where it may write (Wave 2 MAILR; FILER uses the
 * same checks).
 *
 *  - The actor must hold the `content-restore` capability (engine/authz/can.mjs).
 *  - The run must carry an approved `content-restore` request for exactly this plan
 *    (params.runId is the plan digest), asked by the actor and decided by someone else.
 *  - On a test tenant, a restore writes only to targets named with the `KEEL-RT-` prefix.
 *    Matching is on the prefix only.
 */
import { can } from '../../authz/can.mjs';
import { findPrincipalById } from '../../authz/principals.mjs';

export const CONTENT_RESTORE_CAPABILITY = 'content-restore';
export const CONTENT_RESTORE_ACTION = 'content-restore';
export const TEST_FIXTURE_PREFIX = 'KEEL-RT-';

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
 * Checks the actor and the approval. Returns { actor, approvedBy, approvalId }; throws
 * ContentRestoreRefusedError with the reason otherwise. Nothing is written.
 */
export async function authorizeContentRestore(client, { actor, approvalId, runId, tenantRef, at = new Date(), canFn = can }) {
  if (typeof actor !== 'string' || !actor) throw new ContentRestoreRefusedError('a content restore needs --actor (the principal id running it)');
  const principal = await findPrincipalById(client, actor);
  if (!principal || principal.disabled_at) throw new ContentRestoreRefusedError(`actor ${actor} is not an enabled principal`);
  if (!(await canFn(client, principal, CONTENT_RESTORE_CAPABILITY, at))) {
    throw new ContentRestoreRefusedError(`actor ${actor} does not hold the ${CONTENT_RESTORE_CAPABILITY} capability`);
  }
  if (typeof approvalId !== 'string' || !approvalId) throw new ContentRestoreRefusedError('a content restore needs --approval-id (an approved content-restore request)');
  const { rows } = await client.query(
    `SELECT id, action, params, requested_by, decided_by, status FROM approval_request WHERE id::text = $1`,
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
  return { actor, approvedBy: request.decided_by, approvalId: request.id };
}
