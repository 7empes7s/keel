import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  APPROVAL_DECISION_EVIDENCE_KIND,
  APPROVAL_REQUEST_EVIDENCE_KIND,
  ApprovalClosedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalReasonRequiredError,
  ApprovalRequestRefusedError,
  PromotionRefusedError,
  SelfApprovalError,
  approveRequest,
  listApprovalRequests,
  rejectRequest,
  requestApproval,
  restoreExecutorForArtifact,
} from './approvals.mjs';
import { enqueue } from '../jobs/queue.mjs';
import { createDryRunArtifact } from '../restore/dryRunArtifact.mjs';
import { createSnapshot } from '../store/db.mjs';
import { verifyChain } from './evidence.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

try {
  client = await database.connect();
  await client.query(schemaSql());

  const tenantRef = 'sha256:approvals-test';
  // Gap B11: a request's requester must resolve to an enabled principal.
  const { rows: [{ id: restorer }] } = await client.query(
    `INSERT INTO principal (email, display_name) VALUES ('restorer@approvals.test', 'Restorer') RETURNING id::text AS id`,
  );

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

  // Requesting a requiresApproval action creates a request, never a job. This
  // generic mechanism test deliberately avoids action: 'restore' — plan task 8 gives
  // restore promotion its own artifact-backed validation, so a plain, params-only
  // approval-gated action exercises the generic request/approve/reject/expire
  // machinery without tripping that restore-specific gate.
  const request = await requestApproval(client, {
    tenantRef,
    action: 'baseline-activate',
    params: { naturalKey: 'group:alpha' },
    requestedBy: restorer,
    justification: 'change ticket 42',
  });
  assert.equal(request.status, 'pending');
  assert.equal(request.action, 'baseline-activate');
  assert.deepEqual(request.params, { naturalKey: 'group:alpha' });
  assert.equal(request.requested_by, restorer);
  assert.equal(request.justification, 'change ticket 42');
  assert.ok(new Date(request.expires_at) > new Date(), 'a fresh request is not expired');
  assert.equal((await jobRows()).length, 0, 'a request must never create a job');

  // Self-approval is refused server-side: the approver principal must differ from
  // the requester.
  await assert.rejects(
    approveRequest(client, {
      tenantRef,
      id: request.id,
      decidedBy: restorer,
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
  assert.equal(job.kind, 'baseline-activate');
  assert.deepEqual(job.params, { naturalKey: 'group:alpha' });
  assert.equal(job.requested_by, restorer);
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
    action: 'baseline-activate',
    params: { naturalKey: 'group:stale' },
    requestedBy: restorer,
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
    requestedBy: restorer,
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

  const missingReason = await requestApproval(client, {
    tenantRef,
    action: 'remediate',
    params: { naturalKey: 'group:missing-rejection-reason' },
    requestedBy: restorer,
    justification: 'requires a visible rejection reason',
  });
  await assert.rejects(
    rejectRequest(client, {
      tenantRef,
      id: missingReason.id,
      decidedBy: 'principal-approver',
    }),
    (error) => error instanceof ApprovalReasonRequiredError,
    'a rejection reason is required by the engine path, not only the inbox UI',
  );
  assert.equal(
    (await requestRow(missingReason.id)).status,
    'pending',
    'a missing rejection reason cannot close the request',
  );

  // The approval inbox reads a deliberately narrow review projection. Its filters use
  // effective status, so a stale pending row appears in expired history without being
  // presented as actionable, and its newest-first ordering has an id tie-breaker.
  const inboxPending = await requestApproval(client, {
    tenantRef,
    action: 'restore',
    params: { target: 'group:inbox-pending' },
    requestedBy: restorer,
    justification: 'pending inbox review',
  });
  const inboxExpired = await requestApproval(client, {
    tenantRef,
    action: 'restore',
    params: { target: 'group:inbox-expired' },
    requestedBy: restorer,
    justification: 'expired inbox review',
    ttlMs: -1000,
  });
  const olderHistory = await requestApproval(client, {
    tenantRef,
    action: 'remediate',
    params: { target: 'group:older-history' },
    requestedBy: restorer,
    justification: 'older history review',
  });
  await rejectRequest(client, {
    tenantRef,
    id: olderHistory.id,
    decidedBy: 'principal-approver',
    reason: 'older decision',
  });
  const newerHistory = await requestApproval(client, {
    tenantRef,
    action: 'remediate',
    params: { target: 'group:newer-history' },
    requestedBy: restorer,
    justification: 'newer history review',
  });
  await rejectRequest(client, {
    tenantRef,
    id: newerHistory.id,
    decidedBy: 'principal-approver',
    reason: 'newer decision',
  });

  const pending = await listApprovalRequests(client, {
    statuses: ['pending'],
    limit: 1,
  });
  assert.equal(pending.length, 1, 'status filtering and limit are explicit');
  assert.equal(pending[0].id, inboxPending.id);
  assert.equal(pending[0].effective_status, 'pending');
  assert.equal(pending[0].action, 'restore');
  assert.deepEqual(pending[0].params, { target: 'group:inbox-pending' });
  assert.equal(pending[0].requested_by, restorer);
  assert.equal(pending[0].justification, 'pending inbox review');
  assert.ok(pending[0].created_at);
  assert.ok(pending[0].expires_at);

  const expired = await listApprovalRequests(client, {
    statuses: ['expired'],
  });
  const effectiveExpired = expired.find((request) => request.id === inboxExpired.id);
  assert.equal(effectiveExpired?.status, 'pending', 'the stored row remains immutable');
  assert.equal(effectiveExpired?.effective_status, 'expired');

  const history = await listApprovalRequests(client, {
    statuses: ['approved', 'rejected', 'expired'],
  });
  assert.ok(
    history.findIndex((request) => request.id === newerHistory.id)
      < history.findIndex((request) => request.id === olderHistory.id),
    'decided history is newest-first',
  );
  const newest = history.find((request) => request.id === newerHistory.id);
  assert.equal(newest?.decided_by, 'principal-approver');
  assert.equal(newest?.reason, 'newer decision');
  assert.ok(newest?.decided_at);

  // Newest-first ordering has an explicit id DESC tie-breaker for rows sharing a
  // created_at. Real inserts almost always differ by at least a microsecond, so a
  // timing-based fixture would not expose a dropped tie-breaker; this test instead
  // forces two rows to share created_at and assigns the earlier-inserted row the
  // lexicographically smaller id. If `, id DESC` is dropped, nothing but scan order
  // distinguishes the tie, which for these fixtures resolves to insertion order --
  // the opposite of what is asserted below -- so this cannot pass by accident.
  const tieOlder = await requestApproval(client, {
    tenantRef,
    action: 'remediate',
    params: { target: 'group:tie-older' },
    requestedBy: restorer,
    justification: 'tie-break ordering: older insert, smaller id',
  });
  const tieNewer = await requestApproval(client, {
    tenantRef,
    action: 'remediate',
    params: { target: 'group:tie-newer' },
    requestedBy: restorer,
    justification: 'tie-break ordering: newer insert, larger id',
  });
  const TIE_SMALL_ID = '00000000-0000-4000-8000-0000000000aa';
  const TIE_LARGE_ID = '00000000-0000-4000-8000-0000000000bb';
  const tieCreatedAt = (await requestRow(tieOlder.id)).created_at;
  await client.query(
    `UPDATE approval_request SET id = $2, created_at = $3 WHERE id = $1`,
    [tieOlder.id, TIE_SMALL_ID, tieCreatedAt],
  );
  await client.query(
    `UPDATE approval_request SET id = $2, created_at = $3 WHERE id = $1`,
    [tieNewer.id, TIE_LARGE_ID, tieCreatedAt],
  );
  const tied = await listApprovalRequests(client, { statuses: ['pending'] });
  const tieOrder = tied
    .map((request) => request.id)
    .filter((id) => id === TIE_SMALL_ID || id === TIE_LARGE_ID);
  assert.deepEqual(
    tieOrder,
    [TIE_LARGE_ID, TIE_SMALL_ID],
    'rows sharing created_at must tie-break by id DESC, not scan order',
  );

  // Unknown requests are not found, for approve and reject alike.
  await assert.rejects(
    approveRequest(client, { tenantRef, id: randomUUID(), decidedBy: 'principal-approver' }),
    (error) => error instanceof ApprovalNotFoundError,
  );
  await assert.rejects(
    rejectRequest(client, {
      tenantRef,
      id: randomUUID(),
      decidedBy: 'principal-approver',
      reason: 'missing request',
    }),
    (error) => error instanceof ApprovalNotFoundError,
  );

  // --- plan task 8: restore promotion fails closed without a completed artifact ---
  const restoreRequestWithNoArtifact = await requestApproval(client, {
    tenantRef,
    action: 'restore',
    params: {},
    requestedBy: restorer,
  });
  await assert.rejects(
    approveRequest(client, { tenantRef, id: restoreRequestWithNoArtifact.id, decidedBy: 'principal-approver' }),
    (error) => error instanceof PromotionRefusedError,
    'a restore approval with no artifactId must be refused, not minted',
  );
  assert.equal((await requestRow(restoreRequestWithNoArtifact.id)).status, 'pending');

  const restoreSnapshotId = await createSnapshot(client, { tenantRef });
  const completedArtifact = await createDryRunArtifact(client, {
    id: randomUUID(),
    tenantRef,
    snapshotId: restoreSnapshotId,
    selection: ['group:Admins'],
    closureKeys: ['group:Admins'],
    targetTenantId: 'target-tenant',
    collectorConfigPath: '/etc/keel/tenant-target.json',
    targetConfigPath: '/etc/keel/restorer.json',
    reconciliationResources: null,
    waves: [['group:Admins']],
    patches: [],
    guardRefusals: [],
    results: { applied: [{ naturalKey: 'group:Admins', targetId: null }], skipped: [], failed: [], notRemediable: [] },
    currentStateFingerprint: 'fingerprint-completed',
    digest: 'digest-completed',
    status: 'completed',
    requestedBy: restorer,
  });
  const artifactDerivedJobParams = {
    mode: 'enforce',
    artifactId: completedArtifact.id,
    snapshotId: completedArtifact.snapshotId,
    selection: completedArtifact.selection,
    closureKeys: completedArtifact.closureKeys,
    targetTenantId: completedArtifact.targetTenantId,
    collectorConfigPath: completedArtifact.collectorConfigPath,
    targetConfigPath: completedArtifact.targetConfigPath,
    reconciliationResources: completedArtifact.reconciliationResources,
  };

  // This must use a completed artifact. A refused artifact masks the derivation check
  // because it is rejected for the wrong reason; this fixture proves the minted job
  // uses the ARTIFACT's own values, never the request's, even when the request's
  // other params are present and actively disagree with what the artifact recorded —
  // snapshot, selection, and target alike. Nothing here is validated against the
  // artifact and rejected on mismatch; it is simply never read, so there is no
  // param shape left for a future caller to smuggle a mutable restore parameter
  // through.
  const mismatchedSnapshotId = await createSnapshot(client, { tenantRef });
  const restoreRequestWithMismatchedParams = await requestApproval(client, {
    tenantRef,
    action: 'restore',
    params: {
      artifactId: completedArtifact.id,
      snapshotId: mismatchedSnapshotId,
      selection: ['group:Everyone'],
      targetConfigPath: '/etc/keel/a-different-restorer.json',
    },
    requestedBy: restorer,
  });
  const { job: mismatchedParamsJob } = await approveRequest(client, {
    tenantRef, id: restoreRequestWithMismatchedParams.id, decidedBy: 'principal-approver',
  });
  assert.equal(mismatchedParamsJob.kind, 'restore');
  assert.deepEqual(
    mismatchedParamsJob.params,
    artifactDerivedJobParams,
    'the minted job scope must be derived from the artifact — the mismatched snapshot/selection/target on the request must never reach it',
  );
  assert.equal(
    (await requestRow(restoreRequestWithMismatchedParams.id)).status,
    'approved',
    'a valid artifactId promotes even when other request params disagree with the artifact — they are discarded, not compared',
  );

  const restoreRequestWithCompletedArtifact = await requestApproval(client, {
    tenantRef,
    action: 'restore',
    params: { artifactId: completedArtifact.id },
    requestedBy: restorer,
  });
  const { job: restoreJob } = await approveRequest(client, {
    tenantRef, id: restoreRequestWithCompletedArtifact.id, decidedBy: 'principal-approver',
  });
  assert.equal(restoreJob.kind, 'restore');
  assert.deepEqual(restoreJob.params, artifactDerivedJobParams);
  assert.equal(restoreRequestWithCompletedArtifact.executor, 'worker', 'a request is carried out by the worker unless it says otherwise');

  // Gap B11: the requester is validated when the request is made. A CLI artifact's
  // `unknown`, a missing requester, an id with no principal and a disabled principal
  // are all refused, and nothing is written — so no approval can ever mint a job the
  // worker would then fail with "requester no longer resolves to a principal".
  const { rows: [{ id: disabledPrincipal }] } = await client.query(
    `INSERT INTO principal (email, disabled_at) VALUES ('gone@approvals.test', now()) RETURNING id::text AS id`,
  );
  const requestCountBefore = (await client.query(`SELECT count(*)::int AS n FROM approval_request`)).rows[0].n;
  for (const requestedBy of ['unknown', undefined, '', randomUUID(), disabledPrincipal]) {
    await assert.rejects(
      requestApproval(client, { tenantRef, action: 'restore', params: { artifactId: completedArtifact.id }, requestedBy }),
      (error) => error instanceof ApprovalRequestRefusedError && /enabled principal/.test(error.message),
      `requester ${String(requestedBy)} must be refused`,
    );
  }
  // Only the CLI or the worker carries out a request, and the CLI only a restore.
  await assert.rejects(
    requestApproval(client, { tenantRef, action: 'restore', params: { artifactId: completedArtifact.id }, requestedBy: restorer, executor: 'portal' }),
    ApprovalRequestRefusedError,
  );
  await assert.rejects(
    requestApproval(client, { tenantRef, action: 'baseline-activate', params: { naturalKey: 'group:alpha' }, requestedBy: restorer, executor: 'cli' }),
    /only a restore or a content restore can be carried out with the CLI/,
  );
  // Wave 2: a content restore is not a worker job kind, so it is CLI-only.
  await assert.rejects(
    requestApproval(client, { tenantRef, action: 'content-restore', params: { mailbox: 'KEEL-RT-mail' }, requestedBy: restorer }),
    /carried out with the CLI only/,
  );
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM approval_request`)).rows[0].n, requestCountBefore, 'a refused request writes nothing');

  // Gap B11: a CLI-executed restore. Approval checks the artifact like any restore,
  // closes the request and records the decision, but mints no worker job: the
  // operator runs the approved artifact with the CLI.
  const jobsBeforeCliApproval = (await jobRows()).length;
  const cliRequest = await requestApproval(client, {
    tenantRef, action: 'restore', params: { artifactId: completedArtifact.id }, requestedBy: restorer, executor: 'cli',
  });
  assert.equal(cliRequest.executor, 'cli');
  const cliDecision = await approveRequest(client, { tenantRef, id: cliRequest.id, decidedBy: 'principal-approver' });
  assert.equal(cliDecision.job, null, 'a CLI-executed approval mints no job');
  assert.equal(cliDecision.request.status, 'approved');
  assert.equal(cliDecision.request.executor, 'cli');
  assert.equal((await jobRows()).length, jobsBeforeCliApproval, 'no worker restore is queued for a CLI-executed approval');
  assert.equal(
    (await listApprovalRequests(client, { statuses: ['approved'] })).find((row) => row.id === cliRequest.id)?.executor,
    'cli',
    'the inbox shows who carries the request out',
  );
  // Self-approval and the artifact gate still apply to a CLI-executed request.
  const cliSelf = await requestApproval(client, {
    tenantRef, action: 'restore', params: { artifactId: completedArtifact.id }, requestedBy: restorer, executor: 'cli',
  });
  await assert.rejects(approveRequest(client, { tenantRef, id: cliSelf.id, decidedBy: restorer }), SelfApprovalError);
  const cliMissingArtifact = await requestApproval(client, {
    tenantRef, action: 'restore', params: { artifactId: randomUUID() }, requestedBy: restorer, executor: 'cli',
  });
  await assert.rejects(approveRequest(client, { tenantRef, id: cliMissingArtifact.id, decidedBy: 'principal-approver' }), PromotionRefusedError);

  // Wave 2: a content restore (keel-content-restore mail or files) files a CLI-executed
  // approval. Approving it closes the request and mints no job; self-approval is refused.
  const jobsBeforeContentRestore = (await jobRows()).length;
  const contentRequest = await requestApproval(client, {
    tenantRef, action: 'content-restore', params: { kind: 'mail', mailbox: 'KEEL-RT-mail' }, requestedBy: restorer, executor: 'cli',
  });
  assert.equal(contentRequest.executor, 'cli');
  assert.equal(contentRequest.action, 'content-restore');
  await assert.rejects(approveRequest(client, { tenantRef, id: contentRequest.id, decidedBy: restorer }), SelfApprovalError);
  const contentDecision = await approveRequest(client, { tenantRef, id: contentRequest.id, decidedBy: 'principal-approver' });
  assert.equal(contentDecision.request.status, 'approved');
  assert.equal(contentDecision.job, null, 'a content restore approval mints no job');
  assert.equal((await jobRows()).length, jobsBeforeContentRestore);

  // Who carries out a restore follows how its dry run was planned: a worker dry-run
  // job (the portal's dry run or undo plan) means the worker; none means the CLI.
  assert.equal(await restoreExecutorForArtifact(client, { artifactId: completedArtifact.id }), 'cli');
  const workerPlannedId = randomUUID();
  await enqueue(client, {
    kind: 'restore',
    params: { snapshotId: restoreSnapshotId, selection: ['group:Admins'], collectorConfig: '/etc/keel/tenant.json', targetConfig: '/etc/keel/restorer.json', artifactId: workerPlannedId },
    requestedBy: restorer,
  });
  assert.equal(await restoreExecutorForArtifact(client, { artifactId: workerPlannedId }), 'worker');
  const undoPlanId = randomUUID();
  await enqueue(client, { kind: 'restore', params: { compensates: completedArtifact.id, artifactId: undoPlanId }, requestedBy: restorer });
  assert.equal(await restoreExecutorForArtifact(client, { artifactId: undoPlanId }), 'worker');
  // The worker job an approval mints (mode enforce) is not a dry run: it never makes
  // a CLI-planned artifact look worker-planned.
  assert.equal(await restoreExecutorForArtifact(client, { artifactId: completedArtifact.id }), 'cli');

  // The evidence chain contains both the request and the decision, and verifies.
  const { rows: evidenceRows } = await client.query(
    `SELECT kind, subject, actor FROM evidence WHERE tenant_ref = $1 ORDER BY seq`,
    [tenantRef],
  );
  const requests = evidenceRows.filter((row) => row.kind === APPROVAL_REQUEST_EVIDENCE_KIND);
  const decisions = evidenceRows.filter((row) => row.kind === APPROVAL_DECISION_EVIDENCE_KIND);
  assert.ok(
    requests.some(
      (row) => row.subject.requestId === request.id && row.actor === restorer,
    ),
    'the evidence chain must contain the request',
  );
  assert.ok(
    decisions.some(
      (row) => row.subject.requestId === request.id
        && row.subject.decision === 'approved'
        && row.subject.jobId === job.id
        && row.subject.executor === 'worker'
        && row.actor === 'principal-approver',
    ),
    'the evidence chain must contain the approval decision',
  );
  assert.ok(
    requests.some((row) => row.subject.requestId === cliRequest.id && row.subject.executor === 'cli'),
    'the request evidence records who carries it out',
  );
  assert.ok(
    decisions.some(
      (row) => row.subject.requestId === cliRequest.id
        && row.subject.decision === 'approved'
        && row.subject.executor === 'cli'
        && row.subject.jobId === null,
    ),
    'a CLI-executed approval is recorded with no job',
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
