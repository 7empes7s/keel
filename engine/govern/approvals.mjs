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

import { enqueue } from '../jobs/queue.mjs';
import { appendEvidence } from './evidence.mjs';
import { getDryRunArtifact, validateArtifactForApproval } from '../restore/dryRunArtifact.mjs';
import { resolveRowReferences } from './references.mjs';
import { SCOPE_VERSION, approvalEligibility, approvalInboxPredicate, rereadApprovalOwnership } from '../authz/entityScope.mjs';
import { capabilityScope } from '../authz/can.mjs';
import { capabilityForJobKind } from '../authz/jobCapabilities.mjs';

export const APPROVAL_REQUEST_EVIDENCE_KIND = 'approval-request';
export const APPROVAL_DECISION_EVIDENCE_KIND = 'approval-decision';
export const APPROVAL_STATUSES = Object.freeze([
  'pending', 'approved', 'rejected', 'expired',
]);
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
    `SELECT id, action, params, requested_by, justification, status,
            decided_by, decided_at, reason, created_at, expires_at, entity_scope, route,
            CASE
              WHEN status = 'pending' AND expires_at <= now() THEN 'expired'
              ELSE status
            END AS effective_status
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
/** @param {any} client
 * @param {{ tenantRef: string, action: string, params?: any, requestedBy: string, justification?: string | null, ttlMs?: number, entityScope?: any }} options
 */
export async function requestApproval(client, {
  tenantRef, action, params, requestedBy, justification, ttlMs = DEFAULT_APPROVAL_TTL_MS, entityScope = null,
}) {
  // Task 91: where the request goes, from current ownership at request time. Advisory
  // for the inbox and the evidence; eligibility is still decided afresh at decision time.
  const route = await routeApproval(client, { tenantRef, entityScope, requesterId: requestedBy });
  const { rows } = await client.query(
    `INSERT INTO approval_request (action, params, requested_by, justification, expires_at, entity_scope, route)
     VALUES ($1,$2,$3,$4, now() + ($5 * interval '1 millisecond'), $6, $7)
     RETURNING *`,
    [action, params ?? {}, requestedBy, justification ?? null, ttlMs, entityScope, route],
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
    },
    actor: requestedBy,
  });
  return request;
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
 */
export async function routeApproval(client, { tenantRef, entityScope, requesterId = null, at = new Date() }) {
  const approvers = async (entityCode) => {
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
    requesterCapability: capabilityForJobKind(request.action),
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

/** @param {any} client
 * @param {{ tenantRef: string, id: string, decidedBy: string, enforceScope?: boolean, approverScope?: any }} options
 */
export async function approveRequest(client, { tenantRef, id, decidedBy, enforceScope = false, approverScope = null }) {
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
    if (request.action === 'restore') {
      const artifactId = request.params?.artifactId;
      const artifact = typeof artifactId === 'string' && artifactId.length > 0
        ? await getDryRunArtifact(client, { id: artifactId, tenantRef })
        : null;
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

    // The idempotency key pins the minted job to this request: even a retried or
    // duplicated approval can never mint a second job for the same request.
    const job = await enqueue(client, {
      kind: request.action,
      params: jobParams,
      requestedBy: request.requested_by,
      idempotencyKey: `approval:${request.id}`,
    });
    const { rows } = await client.query(
      `UPDATE approval_request
       SET status = 'approved', decided_by = $2, decided_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, decidedBy],
    );
    decided = { request: rows[0], job };
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
      jobId: decided.job.id,
    },
    actor: decidedBy,
  });
  return decided;
}

/** @param {any} client
 * @param {{ tenantRef: string, id: string, decidedBy: string, reason?: any, enforceScope?: boolean, approverScope?: any }} options
 */
export async function rejectRequest(client, { tenantRef, id, decidedBy, reason, enforceScope = false, approverScope = null }) {
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
 * Roadmap task-130: what each request concerns, resolved to names in one query per
 * kind — requester and decider, the dry run (plan) a restore promotes or an undo
 * reverses, the baseline an activation sets, the changes a roll-back reverts. A
 * reference that cannot be read comes back readable: false, never as a bare id.
 */
export async function summarizeApprovalRequests(client, { tenantRef, requests }) {
  return resolveRowReferences(client, { tenantRef, rows: requests, people: ['requested_by', 'decided_by'] });
}
