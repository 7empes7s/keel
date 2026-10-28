// engine/govern/approvals.mjs
//
// §3.3, plan task 14: approvals. Requesting a `requiresApproval` action creates an
// approval_request row, never a job. Only `approveRequest` mints the job, and only
// when the deciding principal differs from the requester — self-approval is refused
// here, server-side, however powerful the approver's roles. `rejectRequest` closes
// the request without minting anything. Both the request and the decision are
// written to the evidence chain (evidence.mjs) so the whole exchange is provable
// later. Requests carry a configurable TTL and expire *closed*: the first decision
// attempted against a stale request marks it 'expired' and is refused, so an
// approval can never be granted against stale parameters.

import { isDeepStrictEqual } from 'node:util';
import { enqueue } from '../jobs/queue.mjs';
import { appendEvidence } from './evidence.mjs';
import { refuseSameContentDriftIds } from '../store/openDrift.mjs';
import { canonicalDigest, getDryRunArtifact, validateArtifactForApproval } from '../restore/dryRunArtifact.mjs';
import { resolveRowReferences } from './references.mjs';
import { SCOPE_VERSION, approvalEligibility, approvalInboxPredicate, rereadApprovalOwnership } from '../authz/entityScope.mjs';
import { can, capabilityScope } from '../authz/can.mjs';
import { capabilityForJobKind } from '../authz/jobCapabilities.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { classifyApprovalActions, requiredApprovalsFor, standingPolicyRefusal } from './approvalPolicy.mjs';

export const APPROVAL_REQUEST_EVIDENCE_KIND = 'approval-request';
export const APPROVAL_DECISION_EVIDENCE_KIND = 'approval-decision';
// Wave 2 RBAC: the first of two approvals a two-person request needs.
export const APPROVAL_SIGNOFF_EVIDENCE_KIND = 'approval-signoff';
export const APPROVAL_STATUSES = Object.freeze([
  'pending', 'approved', 'rejected', 'expired',
]);
// Gap B11: who carries out an approved request. 'worker' (the default, and every
// request made before B11): approval mints the job and the worker runs it. 'cli': an
// operator runs it with the CLI (`keel-restore --artifact <id> --enforce`), so approval
// mints no job — a second, worker-run copy of the same restore would be wrong. Only a
// restore may be CLI-executed.
export const APPROVAL_EXECUTORS = Object.freeze(['worker', 'cli']);
// Wave 2: actions an operator carries out with the CLI. A content restore (mail or
// files, `keel-content-restore`) is not a worker job kind, so it is CLI-only.
export const CLI_EXECUTED_ACTIONS = Object.freeze(['restore', 'content-restore']);
const CLI_ONLY_ACTIONS = Object.freeze(['content-restore']);
// The capability a requester must still hold for an action that is not a job kind.
const NON_JOB_ACTION_CAPABILITIES = Object.freeze({ 'content-restore': 'content-restore' });

function requesterCapabilityFor(action) {
  return capabilityForJobKind(action) ?? NON_JOB_ACTION_CAPABILITIES[action] ?? null;
}
export const DEFAULT_APPROVAL_LIST_LIMIT = 100;
export const MAX_APPROVAL_LIST_LIMIT = 100;

// Requests default to a day to find an approver; the portal passes its configured
// TTL (KEEL_APPROVAL_TTL_MS) instead, so the operator controls the window.
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export class ApprovalNotFoundError extends Error {}
export class ApprovalClosedError extends Error {}
export class ApprovalExpiredError extends Error {}
export class ApprovalReasonRequiredError extends Error {}
export class SelfApprovalError extends Error {}
// Gap B11: the requester does not resolve to an enabled principal (for example a CLI
// artifact's `unknown`), or the executor is not one this action allows. Nothing is
// created: a request whose job could never pass the worker's requester check is
// refused when it is made, not after it is approved.
export class ApprovalRequestRefusedError extends Error {}
// Plan task 8: a restore approval references a completed dry-run artifact rather than
// repeating mutable restore parameters. Promotion fails closed — this error, never a
// silent mint — if that artifact is absent, incomplete, refused, or failed.
export class PromotionRefusedError extends Error {}
// Task 90: the decider is outside the request's entity scope. The request stays
// pending for an eligible (often central) approver; `handoff` says who that is.
export class ApprovalScopeError extends Error {
  constructor(message, { reason, handoff = null } = {}) {
    super(message);
    this.reason = reason;
    this.handoff = handoff;
  }
}
// Task 90: the request's resources changed owner, or its requester lost the grant it
// was made under. The request is closed as expired, so it can never be decided on the
// ownership it was made under; the requester must ask again.
export class ApprovalInvalidatedError extends ApprovalExpiredError {
  constructor(message, { reason } = {}) {
    super(message);
    this.reason = reason;
  }
}

// Wave 2 RBAC: under the two-person rule, the same person tried to approve a request
// they already approved. Nothing changes; the request waits for someone else.
export class DuplicateApproverError extends Error {}
// Wave 2 RBAC: a decision made under a standing policy the request is outside of (for
// the operator's standing approval: anything that is not a test-tenant restore).
export class StandingPolicyRefusedError extends Error {}

// Task 96: the decision named a plan that is no longer the request's plan. Nothing is
// decided; the request stays as it was.
export class ApprovalPlanChangedError extends Error {}
// The job key `approval:<request id>` already belongs to a job this approval did not mint
// (another kind of job, another requester, or other params). Approving fails closed: the
// request stays pending and no foreign job is reported as the approved one.
export class ApprovalJobConflictError extends Error {}

/** Task 96: the digest of the plan a request asks to approve: its action and its
 * immutable params (for a restore, the dry-run artifact reference). An external mirror
 * carries it, and a decision made against another digest is refused. */
export function approvalPlanDigest(request) {
  return canonicalDigest({ action: request.action, params: request.params ?? {} });
}

function approvalStatuses(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    throw new TypeError('approval statuses must be a non-empty array');
  }
  if (statuses.some((status) => !APPROVAL_STATUSES.includes(status))) {
    throw new RangeError('approval statuses must be pending, approved, rejected, or expired');
  }
  return [...new Set(statuses)];
}

function approvalListLimit(limit) {
  if (!Number.isFinite(limit)) {
    throw new TypeError('approval list limit must be finite');
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_APPROVAL_LIST_LIMIT);
}

// The inbox is deliberately a narrow projection rather than SELECT *. Approval params
// are the immutable action payload an approver must review; credential material belongs
// to neither this table nor this reader. Pending rows become effectively expired at read
// time, so an inbox can never present a stale request as actionable.
// Task 90: `approverScope` (from can.mjs#capabilityScope for 'approve') limits the inbox
// in SQL, so an entity approver never receives another entity's request, nor a count
// that includes one. Omitted, the reader is the central (pre-task-90) inbox.
export async function listApprovalRequests(client, {
  statuses = APPROVAL_STATUSES,
  limit = DEFAULT_APPROVAL_LIST_LIMIT,
  approverScope = { central: true },
} = {}) {
  const scope = approvalInboxPredicate(approverScope, { nextParam: 3 });
  const { rows } = await client.query(
    `SELECT id, action, params, requested_by, justification, status, executor,
            decided_by, decided_at, reason, created_at, expires_at, entity_scope, route,
            required_approvals,
            CASE
              WHEN status = 'pending' AND expires_at <= now() THEN 'expired'
              ELSE status
            END AS effective_status,
            -- Two-person progress: who has signed so far, oldest first. The inbox shows
            -- "1 of 2 approvals recorded" and names them; one approver sees nothing more.
            (SELECT COALESCE(array_agg(s.approver ORDER BY s.signed_at, s.approver), '{}')
               FROM approval_signoff s WHERE s.request_id = approval_request.id) AS signoffs
     FROM approval_request
     WHERE CASE
             WHEN status = 'pending' AND expires_at <= now() THEN 'expired'
             ELSE status
           END = ANY($1::text[])
       AND ${scope.sql}
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [approvalStatuses(statuses), approvalListLimit(limit), ...scope.values],
  );
  return rows;
}

// Task 90: `entityScope` is entityScope.mjs#captureApprovalScope's server-side capture
// of the resources this request concerns. Omitted, the request is central-only.
// Wave 2 RBAC: `policyActions` are the approval-policy actions the caller knows this
// request is (approvalPolicy.mjs#APPROVAL_POLICY_ACTIONS); a restore's dry run adds the
// ones it records. They and the approvers needed under the current policy are kept on
// the request, so turning the rule off later never lowers what a request needs.
/** @param {any} client
 * @param {{ tenantRef: string, action: string, params?: any, requestedBy: string, justification?: string | null, ttlMs?: number, entityScope?: any, executor?: 'worker' | 'cli', policyActions?: string[] }} options
 */
export async function requestApproval(client, {
  tenantRef, action, params, requestedBy, justification, ttlMs = DEFAULT_APPROVAL_TTL_MS, entityScope = null,
  executor = 'worker', policyActions = [],
}) {
  // Gap B11: checked before anything is written. The worker re-checks the requester
  // again at execution; this only stops a request that could never run.
  if (!APPROVAL_EXECUTORS.includes(executor)) {
    throw new ApprovalRequestRefusedError(`executor must be one of ${APPROVAL_EXECUTORS.join(', ')}`);
  }
  if (executor === 'cli' && !CLI_EXECUTED_ACTIONS.includes(action)) {
    throw new ApprovalRequestRefusedError('only a restore or a content restore can be carried out with the CLI');
  }
  if (executor !== 'cli' && CLI_ONLY_ACTIONS.includes(action)) {
    throw new ApprovalRequestRefusedError(`a ${action} is carried out with the CLI only`);
  }
  // A roll back of a change whose row records no change (only a stored fingerprint
  // differed) would put back what is already there: refused before it waits.
  if (action === 'remediate') await refuseSameContentDriftIds(client, params?.driftIds);
  const requester = await findPrincipalById(client, requestedBy);
  if (!requester || requester.disabled_at) {
    throw new ApprovalRequestRefusedError(`requester does not resolve to an enabled principal: ${requestedBy}`);
  }
  // Task 91: where the request goes, from current ownership at request time. Advisory
  // for the inbox and the evidence; eligibility is still decided afresh at decision time.
  const route = await routeApproval(client, { tenantRef, entityScope, requesterId: requestedBy });
  const artifact = await restoreArtifact(client, { tenantRef, action, params });
  const classes = classifyApprovalActions({ action, artifact, declared: policyActions });
  const requiredApprovals = await requiredApprovalsFor(client, { tenantRef, classes });
  const { rows } = await client.query(
    `INSERT INTO approval_request (action, params, requested_by, justification, expires_at, entity_scope, route, executor,
                                   policy_actions, required_approvals)
     VALUES ($1,$2,$3,$4, now() + ($5 * interval '1 millisecond'), $6, $7, $8, $9, $10)
     RETURNING *`,
    [action, params ?? {}, requestedBy, justification ?? null, ttlMs, entityScope, route, executor,
      JSON.stringify(classes), requiredApprovals],
  );
  const request = rows[0];

  await appendEvidence(client, {
    tenantRef,
    kind: APPROVAL_REQUEST_EVIDENCE_KIND,
    subject: {
      requestId: request.id,
      action: request.action,
      params: request.params,
      requestedBy,
      route,
      executor,
      policyActions: classes,
      requiredApprovals,
    },
    actor: requestedBy,
  });
  return request;
}

async function restoreArtifact(client, { tenantRef, action, params }) {
  const artifactId = params?.artifactId;
  if (action !== 'restore' || typeof artifactId !== 'string' || artifactId.length === 0) return null;
  return getDryRunArtifact(client, { id: artifactId, tenantRef });
}

// Wave 2 RBAC: approvers needed now. A policy turned on since the request was made
// raises it; one turned off never lowers it below what the request was made with.
async function requiredApprovalsNow(client, { tenantRef, request }) {
  const current = await requiredApprovalsFor(client, { tenantRef, classes: request.policy_actions ?? [] });
  return Math.max(request.required_approvals ?? 1, current);
}

// Wave 2 RBAC: record this approver's sign-off and return every sign-off that still
// counts: the decider's own, and earlier ones whose approver still holds `approve`.
async function signOff(client, { request, decidedBy, standingPolicy }) {
  const { rows: inserted } = await client.query(
    `INSERT INTO approval_signoff (request_id, approver, standing_policy) VALUES ($1,$2,$3)
     ON CONFLICT (request_id, approver) DO NOTHING RETURNING approver`,
    [request.id, decidedBy, standingPolicy],
  );
  if (!inserted.length) {
    throw new DuplicateApproverError('this approver already approved the request; a second, different approver must approve it');
  }
  const { rows } = await client.query(
    `SELECT approver FROM approval_signoff WHERE request_id = $1 ORDER BY signed_at, approver`,
    [request.id],
  );
  const counted = [];
  for (const { approver } of rows) {
    if (approver === request.requested_by) continue;
    if (approver === decidedBy) { counted.push(approver); continue; }
    const principal = await findPrincipalById(client, approver);
    if (principal && await can(client, principal, 'approve')) counted.push(approver);
  }
  return counted;
}

const MAX_ROUTE_APPROVERS = 500;

/**
 * Task 91: who should decide a request, from CURRENT ownership and CURRENT grants.
 *
 *   { route: 'entity', entityCode, approvers }   every resource is owned by that one
 *                                                entity and it has an eligible approver
 *   { route: 'central', reason, approvers }      explicit central handoff: no captured
 *                                                scope, shared/unknown/unresolved
 *                                                ownership, resources of several entities
 *                                                ('cross-entity'), expired ownership, or
 *                                                no eligible entity approver
 *   { route: 'refused', reason }                 a resource changed owner since the
 *                                                request's scope was captured; the
 *                                                request must be made again
 *
 * A cross-entity request is never routed to one of its entities, and a changed owner
 * is never followed to the new owner on the old request: routing never widens who may
 * decide. `approvers` excludes the requester (self-approval is refused anyway) and
 * lists principal ids in a stable order; entity approvers are those whose `approve`
 * covers that entity, central ones those who hold it tenant-wide.
 * `approverCache` (a Map) may be shared by one reader across calls at the same `at`.
 *
 * @param {any} client
 * @param {{ tenantRef: string, entityScope: any, requesterId?: string | null, at?: Date, approverCache?: Map<string, string[]> | null }} options
 */
export async function routeApproval(client, { tenantRef, entityScope, requesterId = null, at = new Date(), approverCache = null }) {
  // A reader routing many changes at once may share one cache across calls.
  const approvers = async (entityCode) => {
    const key = `${entityCode ?? '*'}|${requesterId ?? ''}`;
    if (approverCache?.has(key)) return approverCache.get(key);
    const ids = await eligibleApprovers(entityCode);
    approverCache?.set(key, ids);
    return ids;
  };
  const eligibleApprovers = async (entityCode) => {
    const { rows } = await client.query(
      `SELECT id, system_kind, disabled_at FROM principal WHERE disabled_at IS NULL ORDER BY id LIMIT ${MAX_ROUTE_APPROVERS}`,
    );
    const ids = [];
    for (const principal of rows) {
      if (principal.id === requesterId) continue;
      const scope = await capabilityScope(client, principal, 'approve', at);
      if (entityCode ? !scope.central && scope.entities.includes(entityCode) : scope.central) ids.push(principal.id);
    }
    return ids;
  };
  const central = async (reason) => ({ route: 'central', reason, approvers: await approvers(null), routedAt: at.toISOString() });
  if (!entityScope) return central('no-captured-scope');
  if (entityScope.version !== SCOPE_VERSION || !Array.isArray(entityScope.resources)) return { route: 'refused', reason: 'scope-unreadable', routedAt: at.toISOString() };
  const current = await rereadApprovalOwnership(client, { tenantRef, entityScope, at });
  if (current.changed) return { route: 'refused', reason: 'ownership-changed', routedAt: at.toISOString() };
  if (current.expired) return central('ownership-expired');
  if (current.centralOnly) return central('shared-or-unattributed');
  if (current.entities.length !== 1) return central('cross-entity');
  const [entityCode] = current.entities;
  const entityApprovers = await approvers(entityCode);
  if (!entityApprovers.length) return central('no-entity-approver');
  return { route: 'entity', entityCode, approvers: entityApprovers, routedAt: at.toISOString() };
}

async function lockRequest(client, id) {
  const { rows } = await client.query(
    `SELECT * FROM approval_request WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

// A pending request past its TTL expires *closed*: the row is marked 'expired' before
// the decision is refused, so a retry can never find it pending again.
// Task 90: eligibility is checked inside the decision transaction, on current grants
// and current ownership. It runs whenever the request carries a captured scope, and
// for every request when the caller asks (`enforceScope`, which the portal always
// does). An invalidated request is closed as expired and that is committed before
// the refusal, exactly like a TTL expiry.
async function checkEligibility(client, { tenantRef, request, decidedBy, enforceScope, approverScope }) {
  if (!enforceScope && request.entity_scope == null) return null;
  const verdict = await approvalEligibility(client, {
    tenantRef,
    entityScope: request.entity_scope,
    approverId: decidedBy,
    approverScope,
    requesterId: request.requested_by,
    requesterCapability: requesterCapabilityFor(request.action),
  });
  if (verdict.eligible) return null;
  if (verdict.invalidate) {
    await client.query(
      `UPDATE approval_request SET status = 'expired', decided_at = now(), reason = $2 WHERE id = $1`,
      [request.id, `invalidated: ${verdict.reason}`],
    );
    return new ApprovalInvalidatedError(`approval request invalidated: ${verdict.reason}`, { reason: verdict.reason });
  }
  return new ApprovalScopeError(`approver is not eligible: ${verdict.reason}`, verdict);
}

async function closeIfExpired(client, request) {
  if (request.status === 'pending' && new Date(request.expires_at) <= new Date()) {
    const { rows } = await client.query(
      `UPDATE approval_request SET status = 'expired', decided_at = now()
       WHERE id = $1
       RETURNING *`,
      [request.id],
    );
    return rows[0];
  }
  return request;
}

// Task 96: `expectedPlanDigest`, when given, must equal the locked request's plan digest
// (approvalPlanDigest); a mirror callback passes the digest the external approver saw.
// Wave 2 RBAC: `standingPolicy` names the standing policy this decision is made under
// (approvalPolicy.mjs#STANDING_POLICIES); a request it does not cover is refused. When
// the request needs two approvers, the first approval is a sign-off: the request stays
// pending, no job is minted, and `{ request, job: null, signoffs, requiredApprovals }`
// comes back. The second, different approver's approval decides it. `testTenantRefs`
// replaces the committed test-tenant list in tests only; the portal never passes it.
// A pending request has never minted a job (the mint commits with the approval), so any
// job already found under its key must be the one this approval just inserted: same
// kind, same requester, same params. Anything else was planted under the key.
function jobMatchesApproval(job, { kind, requestedBy, params }) {
  return job.kind === kind
    && String(job.requested_by) === String(requestedBy)
    && isDeepStrictEqual(job.params, JSON.parse(JSON.stringify(params ?? {})));
}

/** @param {any} client
 * @param {{ tenantRef: string, id: string, decidedBy: string, enforceScope?: boolean, approverScope?: any, expectedPlanDigest?: string | null, standingPolicy?: string | null, testTenantRefs?: readonly string[] }} options
 */
export async function approveRequest(client, {
  tenantRef, id, decidedBy, enforceScope = false, approverScope = null, expectedPlanDigest = null, standingPolicy = null,
  testTenantRefs = undefined,
}) {
  let decided;
  await client.query('BEGIN');
  let committed = false;
  try {
    const locked = await lockRequest(client, id);
    if (!locked) throw new ApprovalNotFoundError(`approval request not found: ${id}`);

    const request = await closeIfExpired(client, locked);
    if (request.status === 'expired') {
      // Expire *closed*: the expiry is committed before the refusal, so a retry can
      // never find the request pending again.
      await client.query('COMMIT');
      committed = true;
      throw new ApprovalExpiredError(`approval request expired: ${id}`);
    }
    if (request.status !== 'pending') {
      throw new ApprovalClosedError(`approval request already ${request.status}: ${id}`);
    }
    if (expectedPlanDigest != null && expectedPlanDigest !== approvalPlanDigest(request)) {
      throw new ApprovalPlanChangedError(`approval request ${id} is for another plan than the one decided`);
    }
    // Self-approval is refused server-side, always: the approver principal must
    // differ from the requester.
    if (decidedBy === request.requested_by) {
      throw new SelfApprovalError('an approver can never approve their own request');
    }
    const ineligible = await checkEligibility(client, { tenantRef, request, decidedBy, enforceScope, approverScope });
    if (ineligible instanceof ApprovalInvalidatedError) {
      await client.query('COMMIT');
      committed = true;
    }
    if (ineligible) throw ineligible;

    // Plan task 8: a restore promotion is never minted from the request's own params —
    // it references a completed dry-run artifact, checked fresh, inside this same
    // transaction. Absent, refused, failed, or otherwise incomplete fails closed. The
    // fresh recompute-and-compare against the target (digest, current-state
    // fingerprint) happens later, at execution — this check is deliberately DB-only.
    //
    // Every mutable restore parameter (snapshot, selection, closure, target) comes
    // from the artifact's own stored state, never from the request. Once artifactId is
    // present, nothing else in request.params is read, validated, or compared against
    // the artifact — it is discarded outright. An approval row may have been created
    // by an older caller or an administrative repair tool that put other fields
    // alongside artifactId, matching or not; there is no shape for such a caller to
    // get right or wrong, because those fields are never looked at, so there is no
    // longer a param path for a future caller to find into this defect.
    let jobParams = request.params;
    const artifact = await restoreArtifact(client, { tenantRef, action: request.action, params: request.params });
    if (standingPolicy != null) {
      const refusal = standingPolicyRefusal({ policy: standingPolicy, tenantRef, request, artifact, testTenantRefs });
      if (refusal) throw new StandingPolicyRefusedError(refusal);
    }
    if (request.action === 'restore') {
      const validation = validateArtifactForApproval(artifact);
      if (!validation.ok) throw new PromotionRefusedError(validation.reason);
      // The approval row has only an artifact reference.  The job's restore scope is
      // reconstructed entirely from that immutable row: not one snapshot, selection,
      // closure, target, or credential-config path is read from request.params after
      // artifactId has selected the artifact.  The worker deliberately ignores these
      // copied values and invokes the artifact-only CLI path; carrying this
      // artifact-derived scope on the job makes its audit record explicit while the
      // persisted artifact remains the sole execution authority.
      jobParams = {
        mode: 'enforce',
        artifactId: artifact.id,
        snapshotId: artifact.snapshotId,
        selection: artifact.selection,
        closureKeys: artifact.closureKeys,
        targetTenantId: artifact.targetTenantId,
        collectorConfigPath: artifact.collectorConfigPath,
        targetConfigPath: artifact.targetConfigPath,
        reconciliationResources: artifact.reconciliationResources,
      };
    }

    // A request made before its change was found to hold the same content is refused
    // at decision time too: approving it would roll back nothing.
    if (request.action === 'remediate') await refuseSameContentDriftIds(client, request.params?.driftIds);

    // Wave 2 RBAC: the two-person rule. Below the approvers it needs, this approval is a
    // sign-off only: committed, evidenced, and the request stays pending.
    const requiredApprovals = await requiredApprovalsNow(client, { tenantRef, request });
    let approvers = [decidedBy];
    if (requiredApprovals > 1) {
      approvers = await signOff(client, { request, decidedBy, standingPolicy });
      if (approvers.length < requiredApprovals) {
        await client.query('COMMIT');
        committed = true;
        await appendEvidence(client, {
          tenantRef,
          kind: APPROVAL_SIGNOFF_EVIDENCE_KIND,
          subject: {
            requestId: request.id, action: request.action, signoffs: approvers.length, requiredApprovals,
            policyActions: request.policy_actions ?? [], standingPolicy,
          },
          actor: decidedBy,
        });
        return { request, job: null, signoffs: approvers.length, requiredApprovals };
      }
    }

    // The idempotency key pins the minted job to this request: even a retried or
    // duplicated approval can never mint a second job for the same request.
    // Gap B11: a CLI-executed request mints no job at all; the operator runs the
    // approved artifact with the CLI. Everything above (expiry, self-approval,
    // eligibility, the artifact check) still applies to it.
    const job = request.executor === 'cli' ? null : await enqueue(client, {
      kind: request.action,
      params: jobParams,
      requestedBy: request.requested_by,
      idempotencyKey: `approval:${request.id}`,
    });
    if (job && !jobMatchesApproval(job, { kind: request.action, requestedBy: request.requested_by, params: jobParams })) {
      throw new ApprovalJobConflictError(`job key for approval request ${id} is held by another job`);
    }
    const { rows } = await client.query(
      `UPDATE approval_request
       SET status = 'approved', decided_by = $2, decided_at = now(), standing_policy = $3
       WHERE id = $1
       RETURNING *`,
      [id, decidedBy, standingPolicy],
    );
    decided = { request: rows[0], job, approvers, requiredApprovals };
    await client.query('COMMIT');
    committed = true;
  } finally {
    if (!committed) await client.query('ROLLBACK');
  }

  await appendEvidence(client, {
    tenantRef,
    kind: APPROVAL_DECISION_EVIDENCE_KIND,
    subject: {
      requestId: decided.request.id,
      action: decided.request.action,
      decision: 'approved',
      executor: decided.request.executor,
      jobId: decided.job?.id ?? null,
      ...(decided.requiredApprovals > 1 ? { approvers: decided.approvers, requiredApprovals: decided.requiredApprovals } : {}),
      ...(standingPolicy != null ? { standingPolicy } : {}),
    },
    actor: decidedBy,
  });
  return decided;
}

/** @param {any} client
 * @param {{ tenantRef: string, id: string, decidedBy: string, reason?: any, enforceScope?: boolean, approverScope?: any, expectedPlanDigest?: string | null }} options
 */
export async function rejectRequest(client, {
  tenantRef, id, decidedBy, reason, enforceScope = false, approverScope = null, expectedPlanDigest = null,
}) {
  let rejected;
  await client.query('BEGIN');
  let committed = false;
  try {
    const locked = await lockRequest(client, id);
    if (!locked) throw new ApprovalNotFoundError(`approval request not found: ${id}`);

    const request = await closeIfExpired(client, locked);
    if (request.status === 'expired') {
      await client.query('COMMIT');
      committed = true;
      throw new ApprovalExpiredError(`approval request expired: ${id}`);
    }
    if (request.status !== 'pending') {
      throw new ApprovalClosedError(`approval request already ${request.status}: ${id}`);
    }
    if (expectedPlanDigest != null && expectedPlanDigest !== approvalPlanDigest(request)) {
      throw new ApprovalPlanChangedError(`approval request ${id} is for another plan than the one decided`);
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new ApprovalReasonRequiredError('a rejection reason is required');
    }
    const ineligible = await checkEligibility(client, { tenantRef, request, decidedBy, enforceScope, approverScope });
    if (ineligible instanceof ApprovalInvalidatedError) {
      await client.query('COMMIT');
      committed = true;
    }
    if (ineligible) throw ineligible;
    const { rows } = await client.query(
      `UPDATE approval_request
       SET status = 'rejected', decided_by = $2, decided_at = now(), reason = $3
       WHERE id = $1
       RETURNING *`,
      [id, decidedBy, reason],
    );
    rejected = rows[0];
    await client.query('COMMIT');
    committed = true;
  } finally {
    if (!committed) await client.query('ROLLBACK');
  }

  await appendEvidence(client, {
    tenantRef,
    kind: APPROVAL_DECISION_EVIDENCE_KIND,
    subject: {
      requestId: rejected.id,
      action: rejected.action,
      decision: 'rejected',
      reason: rejected.reason,
    },
    actor: decidedBy,
  });
  return rejected;
}

/**
 * Gap B11: who carries out the restore that promotes this dry-run artifact. An
 * artifact a worker job planned (the portal's dry run or undo plan) is carried out by
 * the worker, as before; an artifact planned with the CLI is carried out with the CLI,
 * so approving it mints no worker job. A promotion job (mode 'enforce', minted by an
 * earlier approval) is not a dry run and never counts.
 */
export async function restoreExecutorForArtifact(client, { artifactId }) {
  const { rows } = await client.query(
    `SELECT 1 FROM job
      WHERE kind = 'restore'
        AND params->>'artifactId' = $1
        AND NOT (params ? 'mode')
        AND (params ? 'snapshotId' OR params ? 'compensates' OR params ? 'complianceFix')
      LIMIT 1`,
    [artifactId],
  );
  return rows.length > 0 ? 'worker' : 'cli';
}

/**
 * Task 96: re-planning. A pending request whose plan was replaced by `supersededBy` is
 * closed as expired (reason `superseded: <id>`), so no decision, from the portal or a
 * mirror, can approve the replaced plan. Returns the closed row, or null when the
 * request was no longer pending (nothing to close).
 */
export async function supersedeRequest(client, { tenantRef, id, supersededBy, actor }) {
  const { rows: [closed] } = await client.query(
    `UPDATE approval_request SET status = 'expired', decided_at = now(), reason = $2
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id, `superseded: ${supersededBy}`],
  );
  if (!closed) return null;
  await appendEvidence(client, {
    tenantRef,
    kind: APPROVAL_DECISION_EVIDENCE_KIND,
    subject: { requestId: closed.id, action: closed.action, decision: 'superseded', supersededBy: String(supersededBy) },
    actor,
  });
  return closed;
}

/**
 * Roadmap task-130: what each request concerns, resolved to names in one query per
 * kind — requester and decider, the dry run (plan) a restore promotes or an undo
 * reverses, the baseline an activation sets, the changes a roll-back reverts. A
 * reference that cannot be read comes back readable: false, never as a bare id.
 */
export async function summarizeApprovalRequests(client, { tenantRef, requests }) {
  return resolveRowReferences(client, { tenantRef, rows: requests, people: ['requested_by', 'decided_by'] });
}
