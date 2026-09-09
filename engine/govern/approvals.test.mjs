import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  APPROVAL_DECISION_EVIDENCE_KIND,
  APPROVAL_REQUEST_EVIDENCE_KIND,
  ApprovalClosedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  SelfApprovalError,
  approveRequest,
  rejectRequest,
  requestApproval,
} from './approvals.mjs';
import { verifyChain } from './evidence.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

try {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));

  const tenantRef = 'sha256:approvals-test';

  async function jobRows() {
    const { rows } = await client.query(`SELECT * FROM job`);
    return rows;
  }

  async function requestRow(id) {
    const { rows } = await client.query(
      `SELECT * FROM approval_request WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  // Requesting a requiresApproval action creates a request, never a job.
  const request = await requestApproval(client, {
    tenantRef,
    action: 'restore',
    params: { naturalKey: 'group:alpha' },
    requestedBy: 'principal-restorer',
    justification: 'change ticket 42',
  });
  assert.equal(request.status, 'pending');
  assert.equal(request.action, 'restore');
  assert.deepEqual(request.params, { naturalKey: 'group:alpha' });
  assert.equal(request.requested_by, 'principal-restorer');
  assert.equal(request.justification, 'change ticket 42');
  assert.ok(new Date(request.expires_at) > new Date(), 'a fresh request is not expired');
  assert.equal((await jobRows()).length, 0, 'a request must never create a job');

  // Self-approval is refused server-side: the approver principal must differ from
  // the requester.
  await assert.rejects(
    approveRequest(client, {
      tenantRef,
      id: request.id,
      decidedBy: 'principal-restorer',
    }),
    (error) => error instanceof SelfApprovalError,
  );
  assert.equal((await requestRow(request.id)).status, 'pending', 'a refused approval leaves the request pending');
  assert.equal((await jobRows()).length, 0, 'a refused approval mints no job');

  // Approval by a different principal mints exactly one job with the requested
  // action and params, and closes the request.
  const { request: approved, job } = await approveRequest(client, {
    tenantRef,
    id: request.id,
    decidedBy: 'principal-approver',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decided_by, 'principal-approver');
  assert.ok(approved.decided_at, 'the decision is timestamped');
  assert.equal(job.kind, 'restore');
  assert.deepEqual(job.params, { naturalKey: 'group:alpha' });
  assert.equal(job.requested_by, 'principal-restorer');
  assert.equal(job.status, 'queued');
  assert.equal((await jobRows()).length, 1, 'approval mints exactly one job');

  // A decided request cannot be decided again — and a repeated decision mints no
  // second job.
  await assert.rejects(
    approveRequest(client, {
      tenantRef,
      id: request.id,
      decidedBy: 'principal-approver',
    }),
    (error) => error instanceof ApprovalClosedError,
  );
  assert.equal((await jobRows()).length, 1, 'a repeated approval mints no second job');

  // An expired request cannot be approved: it expires *closed* and stays closed.
  const stale = await requestApproval(client, {
    tenantRef,
    action: 'restore',
    params: { naturalKey: 'group:stale' },
    requestedBy: 'principal-restorer',
    justification: 'stale parameters',
    ttlMs: -1000,
  });
  await assert.rejects(
    approveRequest(client, {
      tenantRef,
      id: stale.id,
      decidedBy: 'principal-approver',
    }),
    (error) => error instanceof ApprovalExpiredError,
  );
  assert.equal(
    (await requestRow(stale.id)).status,
    'expired',
    'an expired request expires closed',
  );
  assert.equal((await jobRows()).length, 1, 'an expired request mints no job');
  await assert.rejects(
    approveRequest(client, {
      tenantRef,
      id: stale.id,
      decidedBy: 'principal-approver',
    }),
    (error) => error instanceof ApprovalExpiredError,
    'an expired request stays closed',
  );

  // Reject closes the request, records the reason, and mints nothing.
  const declined = await requestApproval(client, {
    tenantRef,
    action: 'remediate',
    params: { naturalKey: 'group:beta' },
    requestedBy: 'principal-restorer',
    justification: 'remediate beta',
  });
  const rejected = await rejectRequest(client, {
    tenantRef,
    id: declined.id,
    decidedBy: 'principal-approver',
    reason: 'out of change window',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.decided_by, 'principal-approver');
  assert.equal(rejected.reason, 'out of change window');
  assert.equal((await jobRows()).length, 1, 'a rejection mints no job');

  // Unknown requests are not found, for approve and reject alike.
  await assert.rejects(
    approveRequest(client, { tenantRef, id: randomUUID(), decidedBy: 'principal-approver' }),
    (error) => error instanceof ApprovalNotFoundError,
  );
  await assert.rejects(
    rejectRequest(client, { tenantRef, id: randomUUID(), decidedBy: 'principal-approver' }),
    (error) => error instanceof ApprovalNotFoundError,
  );

  // The evidence chain contains both the request and the decision, and verifies.
  const { rows: evidenceRows } = await client.query(
    `SELECT kind, subject, actor FROM evidence WHERE tenant_ref = $1 ORDER BY seq`,
    [tenantRef],
  );
  const requests = evidenceRows.filter((row) => row.kind === APPROVAL_REQUEST_EVIDENCE_KIND);
  const decisions = evidenceRows.filter((row) => row.kind === APPROVAL_DECISION_EVIDENCE_KIND);
  assert.ok(
    requests.some(
      (row) => row.subject.requestId === request.id && row.actor === 'principal-restorer',
    ),
    'the evidence chain must contain the request',
  );
  assert.ok(
    decisions.some(
      (row) => row.subject.requestId === request.id
        && row.subject.decision === 'approved'
        && row.subject.jobId === job.id
        && row.actor === 'principal-approver',
    ),
    'the evidence chain must contain the approval decision',
  );
  assert.ok(
    decisions.some(
      (row) => row.subject.requestId === declined.id
        && row.subject.decision === 'rejected'
        && row.actor === 'principal-approver',
    ),
    'the evidence chain must contain the rejection decision',
  );
  assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: true });
} finally {
  await client?.end();
  await database.cleanup();
}
console.log('approvals.test.mjs — all assertions passed');
