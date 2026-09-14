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
export async function listApprovalRequests(client, {
  statuses = APPROVAL_STATUSES,
  limit = DEFAULT_APPROVAL_LIST_LIMIT,
} = {}) {
  const { rows } = await client.query(
    `SELECT id, action, params, requested_by, justification, status,
            decided_by, decided_at, reason, created_at, expires_at,
            CASE
              WHEN status = 'pending' AND expires_at <= now() THEN 'expired'
              ELSE status
            END AS effective_status
     FROM approval_request
     WHERE CASE
             WHEN status = 'pending' AND expires_at <= now() THEN 'expired'
             ELSE status
           END = ANY($1::text[])
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [approvalStatuses(statuses), approvalListLimit(limit)],
  );
  return rows;
}

export async function requestApproval(client, {
  tenantRef, action, params, requestedBy, justification, ttlMs = DEFAULT_APPROVAL_TTL_MS,
}) {
  const { rows } = await client.query(
    `INSERT INTO approval_request (action, params, requested_by, justification, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 * interval '1 millisecond'))
     RETURNING *`,
    [action, params ?? {}, requestedBy, justification ?? null, ttlMs],
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
    },
    actor: requestedBy,
  });
  return request;
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

export async function approveRequest(client, { tenantRef, id, decidedBy }) {
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

    // The idempotency key pins the minted job to this request: even a retried or
    // duplicated approval can never mint a second job for the same request.
    const job = await enqueue(client, {
      kind: request.action,
      params: request.params,
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

export async function rejectRequest(client, { tenantRef, id, decidedBy, reason }) {
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
