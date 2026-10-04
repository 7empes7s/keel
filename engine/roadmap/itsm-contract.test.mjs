/**
 * Roadmap task-96 boundary tests: the canonical approval mirror and the ITSM adapter
 * contract. Exercises engine/itsm/bridge.mjs and engine/itsm/outbox.mjs over the real
 * seams — approval_request decisions (govern/approvals.mjs, with current grants and
 * task-90 eligibility), the job queue's idempotency, change intents (task-93), the
 * itsm_* tables in schema.sql and the evidence chain — against an isolated test
 * database, with an injected fixture adapter. No external system is contacted.
 *
 * Required mutation checks:
 *
 * - Authorize from external approved string alone.  (an unmapped, ungranted or
 *                                                     self-requesting external user is refused)
 * - Duplicate action on callback retry.              (a redelivered or resumed callback acts once:
 *                                                     one job, one decision, one outbound decision)
 * - Approve changed plan version.                    (a delayed callback for a re-planned record
 *                                                     cannot approve the new request)
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  ITSM_ADAPTER_CONTRACT, ITSM_CONFLICT_EVIDENCE_KIND, ItsmMirrorError, approvalDecision, assertAdapter, listMirror,
  mapExternalIdentity, mirrorApprovalRequest, mirrorChangeIntent, receiveCallback, reconcileRecord, runMirrorCycle,
} from '../itsm/bridge.mjs';
import { drainItsmOutbox, listItsmOutbox } from '../itsm/outbox.mjs';
import {
  ApprovalClosedError, ApprovalPlanChangedError, approvalPlanDigest, approveRequest, requestApproval,
} from '../govern/approvals.mjs';
import { verifyChain } from '../govern/evidence.mjs';
import { createChangeIntent } from '../policy/changeIntent.mjs';
import { canonicalDigest } from '../restore/dryRunArtifact.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
const other = await database.connect();
after(async () => {
  await client.end();
  await other.end();
  await database.cleanup();
});

const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
await client.query(schema);
await client.query(schema); // additive and retry-safe

const tenantRef = 'sha256:itsm-contract';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const REQUESTER = '22222222-2222-4222-8222-222222222222';
const APPROVER = '33333333-3333-4333-8333-333333333333';
const SECOND_APPROVER = '44444444-4444-4444-8444-444444444444';
const VIEWER = '55555555-5555-4555-8555-555555555555';
const LAPSED = '66666666-6666-4666-8666-666666666666';
const DISABLED = '77777777-7777-4777-8777-777777777777';
await client.query(
  `INSERT INTO principal (id, email, display_name, disabled_at) VALUES
     ($1, 'admin@example.com', 'Admin', NULL), ($2, 'requester@example.com', 'Requester', NULL),
     ($3, 'approver@example.com', 'Approver', NULL), ($4, 'second@example.com', 'Second approver', NULL),
     ($5, 'viewer@example.com', 'Viewer', NULL), ($6, 'lapsed@example.com', 'Lapsed approver', NULL),
     ($7, 'disabled@example.com', 'Disabled approver', now())`,
  [ADMIN, REQUESTER, APPROVER, SECOND_APPROVER, VIEWER, LAPSED, DISABLED],
);
await client.query(
  `INSERT INTO role_grant (principal_id, role, granted_by, reason, active_until) VALUES
     ($1, 'admin', 'test', 'mirror configuration', NULL), ($1, 'viewer', 'test', 'mirror reader', NULL),
     ($2, 'restorer', 'test', 'requests remediation', NULL), ($2, 'approver', 'test', 'also an approver', NULL),
     ($3, 'approver', 'test', 'change approver', NULL), ($4, 'approver', 'test', 'change approver', NULL),
     ($5, 'viewer', 'test', 'read only', NULL), ($6, 'approver', 'test', 'lapsed grant', now() - interval '1 hour'),
     ($7, 'approver', 'test', 'disabled person', NULL)`,
  [ADMIN, REQUESTER, APPROVER, SECOND_APPROVER, VIEWER, LAPSED, DISABLED],
);

const ADAPTER = 'fixture-itsm';
for (const [externalUser, principalId] of [
  ['amara', APPROVER], ['second', SECOND_APPROVER], ['viewer', VIEWER], ['lapsed', LAPSED],
  ['disabled', DISABLED], ['requester', REQUESTER],
]) {
  await mapExternalIdentity(client, { tenantRef, adapter: ADAPTER, externalUser, principalId, requestedBy: ADMIN });
}

/** A fixture adapter: records deliveries (deduplicating on event id, as the contract
 * requires), can fail a number of deliveries, and serves record state for polling. */
function fixtureAdapter({ failures = 0, permanent = false } = {}) {
  const received = new Map();
  const state = new Map();
  let remaining = failures;
  return {
    name: ADAPTER,
    received,
    state,
    attempts: 0,
    async deliver(event) {
      this.attempts += 1;
      if (remaining > 0) {
        remaining -= 1;
        throw Object.assign(new Error('connection reset'), { permanent });
      }
      received.set(event.eventId, event);
    },
    async fetchRecord(externalRef) {
      return state.get(externalRef) ?? null;
    },
  };
}

let sequence = 0;
async function pendingRequest(params = { driftIds: [`drift-${(sequence += 1)}`] }) {
  return requestApproval(client, { tenantRef, action: 'remediate', params, requestedBy: REQUESTER, justification: 'roll back' });
}

async function jobsFor(requestId) {
  const { rows } = await client.query('SELECT * FROM job WHERE idempotency_key = $1', [`approval:${requestId}`]);
  return rows;
}

async function requestRow(id) {
  const { rows: [row] } = await client.query('SELECT * FROM approval_request WHERE id = $1', [id]);
  return row;
}

async function decisionsFor(recordId) {
  const { rows } = await client.query('SELECT * FROM itsm_decision WHERE record_id = $1 ORDER BY version', [recordId]);
  return rows;
}

function callback(record, overrides = {}) {
  return {
    eventId: `evt-${(sequence += 1)}`, externalRef: record.external_ref, status: 'approved', externalUser: 'amara',
    version: record.version, planDigest: record.plan_digest, ...overrides,
  };
}

test('the adapter contract is explicit and checked', () => {
  assert.deepEqual([...ITSM_ADAPTER_CONTRACT.methods], ['deliver', 'fetchRecord']);
  assert.equal(ITSM_ADAPTER_CONTRACT.deliverySemantics, 'at-least-once');
  assert.throws(() => assertAdapter({ name: ADAPTER, deliver() {} }), /does not implement fetchRecord/);
  assert.throws(() => assertAdapter({ name: 'Bad Name', deliver() {}, fetchRecord() {} }), ItsmMirrorError);
  assert.equal(assertAdapter(fixtureAdapter()).name, ADAPTER);
});

test('portal and external approvals yield one decision and one action', async () => {
  // External first: the callback decides, the portal then finds the request closed.
  const request = await pendingRequest();
  const record = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0001', requestId: request.id, requestedBy: ADMIN });
  assert.equal(record.version, 1);
  assert.equal(record.plan_digest, approvalPlanDigest(request));

  const event = callback(record);
  const applied = await receiveCallback(client, { tenantRef, adapter: ADAPTER, event });
  assert.equal(applied.outcome, 'applied');
  assert.equal(applied.detail.principalId, APPROVER);
  assert.equal((await requestRow(request.id)).status, 'approved');
  assert.equal((await requestRow(request.id)).decided_by, APPROVER);
  await assert.rejects(approveRequest(client, { tenantRef, id: request.id, decidedBy: SECOND_APPROVER, enforceScope: true }), ApprovalClosedError);
  const again = await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(record, { externalUser: 'second' }) });
  assert.equal(again.outcome, 'already-decided');
  assert.equal((await jobsFor(request.id)).length, 1, 'one action');
  const [decision, ...extra] = await decisionsFor(record.id);
  assert.equal(extra.length, 0, 'one decision');
  assert.equal(decision.source, 'itsm');
  assert.equal(decision.outcome, 'approved');
  assert.equal(decision.decided_by, APPROVER);
  assert.equal(decision.external_event_id, event.eventId);
  assert.equal(decision.decision_digest, canonicalDigest(decision.decision));
  assert.equal(decision.decision.planDigest, record.plan_digest);
  assert.equal(decision.decision.version, 1);

  // Portal first: the mirror records the portal's decision; a later callback adds nothing.
  const second = await pendingRequest();
  const secondRecord = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0002', requestId: second.id, requestedBy: ADMIN });
  await approveRequest(client, { tenantRef, id: second.id, decidedBy: SECOND_APPROVER, enforceScope: true });
  const adapter = fixtureAdapter();
  const cycle = await runMirrorCycle(client, { tenantRef, adapter });
  assert.equal(cycle.recorded, 1);
  assert.equal(cycle.quarantined, 0);
  const late = await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(secondRecord) });
  assert.equal(late.outcome, 'already-decided');
  assert.equal((await jobsFor(second.id)).length, 1);
  const portalDecisions = await decisionsFor(secondRecord.id);
  assert.equal(portalDecisions.length, 1);
  assert.equal(portalDecisions[0].source, 'portal');
  assert.equal(portalDecisions[0].decided_by, SECOND_APPROVER);

  // The mirrored decision carries the canonical decision and its digest, unchanged.
  const mirrored = [...adapter.received.values()].find((event) => event.kind === 'decision' && event.externalRef === 'CHG0002');
  assert.ok(mirrored, 'the portal decision was mirrored out');
  assert.equal(mirrored.payload.decisionDigest, portalDecisions[0].decision_digest);
  assert.equal(mirrored.payload.eventId, String(portalDecisions[0].id), 'the decision row id is its immutable event id');
  assert.deepEqual(mirrored.payload.decision, approvalDecision({
    tenantRef, record: secondRecord, request: await requestRow(second.id), source: 'portal', externalEventId: null,
  }));
});

test('a delayed callback cannot approve a newer plan', async () => {
  const params = { driftIds: ['drift-replan'] };
  const first = await pendingRequest(params);
  const v1 = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0003', requestId: first.id, requestedBy: ADMIN });
  const delayed = callback(v1);

  // Re-plan with IDENTICAL params: only the version tells the plans apart.
  const replanned = await pendingRequest(params);
  const v2 = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0003', requestId: replanned.id, requestedBy: ADMIN });
  assert.equal(v2.version, 2);
  assert.equal(v2.id, v1.id, 'the same external record');
  assert.equal(v2.plan_digest, v1.plan_digest);
  assert.equal((await requestRow(first.id)).status, 'expired', 'the replaced request is superseded');
  assert.match((await requestRow(first.id)).reason, /^superseded: /);

  const stale = await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: delayed });
  assert.equal(stale.outcome, 'stale-version');
  assert.equal(stale.detail.currentVersion, 2);
  assert.equal((await requestRow(replanned.id)).status, 'pending', 'the new plan is not approved by the old callback');
  assert.equal((await jobsFor(replanned.id)).length, 0);
  assert.equal((await jobsFor(first.id)).length, 0);

  // A version from the future, or a digest of another plan, is refused too.
  assert.equal((await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(v2, { version: 3 }) })).outcome, 'stale-version');
  assert.equal((await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(v2, { planDigest: 'sha256:other' }) })).outcome, 'stale-plan');
  assert.equal((await requestRow(replanned.id)).status, 'pending');

  // Re-planned with different params, the digest changes as well; under the request's
  // row lock a decision for another digest is refused, whoever makes it.
  const changed = await pendingRequest({ driftIds: ['drift-replan', 'drift-extra'] });
  const v3 = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0003', requestId: changed.id, requestedBy: ADMIN });
  assert.equal(v3.version, 3);
  assert.notEqual(v3.plan_digest, v2.plan_digest);
  assert.equal((await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(v3, { planDigest: v2.plan_digest }) })).outcome, 'stale-plan');
  await assert.rejects(
    approveRequest(client, { tenantRef, id: changed.id, decidedBy: APPROVER, enforceScope: true, expectedPlanDigest: v2.plan_digest }),
    ApprovalPlanChangedError,
  );
  assert.equal((await requestRow(changed.id)).status, 'pending');

  // The callback for the current version and plan decides it.
  const current = await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(v3) });
  assert.equal(current.outcome, 'applied');
  assert.equal((await jobsFor(changed.id)).length, 1);
  const decisions = await decisionsFor(v3.id);
  assert.deepEqual(decisions.map((row) => [row.version, String(row.approval_request_id)]), [[3, changed.id]]);

  // A decided record is not re-planned; every bound version stays provable.
  const later = await pendingRequest(params);
  await assert.rejects(
    mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0003', requestId: later.id, requestedBy: ADMIN }),
    (error) => error instanceof ItsmMirrorError && /already decided/.test(error.message),
  );
  const [view] = (await listMirror(client, { tenantRef, principalId: ADMIN })).filter((row) => row.externalRef === 'CHG0003');
  assert.deepEqual(view.versions.map((row) => [row.version, row.approvalRequestId]), [[1, first.id], [2, replanned.id], [3, changed.id]]);
  assert.deepEqual(view.refusedCallbacks.map((row) => row.outcome).sort(), ['stale-plan', 'stale-plan', 'stale-version', 'stale-version']);
});

test('a duplicate, resumed or reconciled callback acts once', async () => {
  const request = await pendingRequest();
  const record = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0004', requestId: request.id, requestedBy: ADMIN });
  const event = callback(record);
  const first = await receiveCallback(client, { tenantRef, adapter: ADAPTER, event });
  assert.equal(first.outcome, 'applied');
  const retry = await receiveCallback(client, { tenantRef, adapter: ADAPTER, event });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.outcome, 'applied', 'a retry returns the first outcome');
  assert.equal(retry.inboxId, first.inboxId);
  assert.equal((await jobsFor(request.id)).length, 1);
  assert.equal((await decisionsFor(record.id)).length, 1);
  const outbound = (await listItsmOutbox(client, { tenantRef, recordId: record.id })).filter((row) => row.kind === 'decision');
  assert.equal(outbound.length, 1, 'one outbound decision');
  const { rows: callbacks } = await client.query(
    "SELECT count(*)::int AS n FROM evidence WHERE kind = 'itsm-callback' AND subject->>'externalEventId' = $1",
    [event.eventId],
  );
  assert.equal(callbacks[0].n, 1, 'the retry adds no evidence of a second action');

  // The handler stopped after deciding but before recording (inbox left 'applying'):
  // the redelivery resumes, records the decision once, and mints nothing new.
  const crashed = await pendingRequest();
  const crashedRecord = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0005', requestId: crashed.id, requestedBy: ADMIN });
  const crashEvent = callback(crashedRecord);
  await client.query(
    `INSERT INTO itsm_inbox (tenant_ref, adapter, external_event_id, external_ref, event, record_id, approval_request_id, principal_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenantRef, ADAPTER, crashEvent.eventId, crashEvent.externalRef, JSON.stringify(crashEvent), crashedRecord.id, crashed.id, APPROVER],
  );
  await approveRequest(client, { tenantRef, id: crashed.id, decidedBy: APPROVER, enforceScope: true, expectedPlanDigest: crashedRecord.plan_digest });
  const resumed = await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: crashEvent });
  assert.equal(resumed.outcome, 'already-decided');
  assert.equal(resumed.duplicate, false);
  assert.equal((await jobsFor(crashed.id)).length, 1);
  const [resumedDecision, ...more] = await decisionsFor(crashedRecord.id);
  assert.equal(more.length, 0);
  assert.equal(resumedDecision.source, 'itsm', 'the decision is attributed to the callback that made it');
  assert.equal(resumedDecision.external_event_id, crashEvent.eventId);
  assert.equal((await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: crashEvent })).duplicate, true);

  // A lost callback is recovered by polling; polling again, or the late original
  // callback, acts no further.
  const lost = await pendingRequest();
  const lostRecord = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0006', requestId: lost.id, requestedBy: ADMIN });
  const adapter = fixtureAdapter();
  adapter.state.set('CHG0006', { status: 'approved', externalUser: 'second', version: 1, planDigest: lostRecord.plan_digest });
  assert.equal((await reconcileRecord(client, { tenantRef, adapter, externalRef: 'CHG0006' })).outcome, 'applied');
  const repoll = await reconcileRecord(client, { tenantRef, adapter, externalRef: 'CHG0006' });
  assert.equal(repoll.duplicate, true);
  assert.equal((await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(lostRecord, { externalUser: 'second' }) })).outcome, 'already-decided');
  assert.equal((await jobsFor(lost.id)).length, 1);
  assert.equal((await decisionsFor(lostRecord.id)).length, 1);
  assert.equal((await reconcileRecord(client, { tenantRef, adapter, externalRef: 'CHG-missing' })).outcome, 'not-found');
});

test('an external approval without a current grant is refused', async () => {
  const request = await pendingRequest();
  const record = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0007', requestId: request.id, requestedBy: ADMIN });
  const cases = [
    [{ externalUser: null }, 'unmapped-identity'],
    [{ externalUser: 'stranger' }, 'unmapped-identity'],
    [{ externalUser: 'disabled' }, 'unmapped-identity'],
    [{ externalUser: 'viewer' }, 'refused-not-eligible'],
    [{ externalUser: 'lapsed' }, 'refused-not-eligible'],
    [{ externalUser: 'requester' }, 'refused-self-approval'],
    [{ status: 'in-review' }, 'ignored-status'],
  ];
  for (const [overrides, expected] of cases) {
    const result = await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(record, overrides) });
    assert.equal(result.outcome, expected, JSON.stringify(overrides));
  }
  assert.equal((await requestRow(request.id)).status, 'pending', 'the external "approved" status alone decided nothing');
  assert.equal((await jobsFor(request.id)).length, 0);
  assert.equal((await decisionsFor(record.id)).length, 0);

  // A grant that lapses after mapping is re-read at decision time.
  await client.query("UPDATE role_grant SET active_until = now() - interval '1 second' WHERE principal_id = $1", [SECOND_APPROVER]);
  try {
    assert.equal((await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(record, { externalUser: 'second' }) })).outcome, 'refused-not-eligible');
  } finally {
    await client.query('UPDATE role_grant SET active_until = NULL WHERE principal_id = $1', [SECOND_APPROVER]);
  }
  assert.equal((await requestRow(request.id)).status, 'pending');

  // An unknown record, or one belonging to another tenant, decides nothing.
  assert.equal((await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(record, { externalRef: 'CHG-unknown' }) })).outcome, 'unknown-record');
  assert.equal((await receiveCallback(client, { tenantRef: 'sha256:other-tenant', adapter: ADAPTER, event: callback(record) })).outcome, 'unknown-record');
  assert.equal((await requestRow(request.id)).status, 'pending');
  assert.deepEqual(await listMirror(client, { tenantRef: 'sha256:other-tenant', principalId: ADMIN }), []);
  await assert.rejects(listMirror(client, { tenantRef, principalId: REQUESTER }), (error) => error.code === 'not-authorized');
  await assert.rejects(
    mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0099', requestId: request.id, requestedBy: VIEWER }),
    (error) => error.code === 'not-authorized',
  );
});

test('conflicting decisions are resolved deterministically and stay visible', async () => {
  const request = await pendingRequest();
  const record = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0008', requestId: request.id, requestedBy: ADMIN });
  await approveRequest(client, { tenantRef, id: request.id, decidedBy: APPROVER, enforceScope: true });
  const rejected = await receiveCallback(client, {
    tenantRef, adapter: ADAPTER, event: callback(record, { status: 'rejected', externalUser: 'second', reason: 'not now' }),
  });
  assert.equal(rejected.outcome, 'conflict');
  assert.equal(rejected.detail.canonicalOutcome, 'approved');
  assert.equal((await requestRow(request.id)).status, 'approved', 'the first committed decision stands');
  assert.equal((await jobsFor(request.id)).length, 1);
  const [decision, ...extra] = await decisionsFor(record.id);
  assert.equal(extra.length, 0);
  assert.equal(decision.source, 'portal');
  assert.equal(decision.outcome, 'approved');
  const conflictEvents = (await listItsmOutbox(client, { tenantRef, recordId: record.id })).filter((row) => row.kind === 'conflict');
  assert.equal(conflictEvents.length, 1, 'the external record is told the canonical decision');
  assert.equal(conflictEvents[0].payload.canonicalOutcome, 'approved');
  assert.equal(conflictEvents[0].payload.decisionDigest, decision.decision_digest);
  const { rows: evidence } = await client.query('SELECT subject FROM evidence WHERE kind = $1', [ITSM_CONFLICT_EVIDENCE_KIND]);
  assert.ok(evidence.some((row) => row.subject.recordId === String(record.id) && row.subject.externalStatus === 'rejected'));
  const [view] = (await listMirror(client, { tenantRef, principalId: ADMIN })).filter((row) => row.externalRef === 'CHG0008');
  assert.equal(view.conflicts.length, 1);
  assert.equal(view.conflicts[0].externalStatus, 'rejected');
  assert.equal(view.conflicts[0].canonicalOutcome, 'approved');
  assert.equal(view.decisions.length, 1);

  // Simultaneous: a portal approval and an external rejection race on two connections.
  // Exactly one decides; the other is refused or recorded as the conflict, and the
  // mirror's decision equals the request's.
  const raced = await pendingRequest();
  const racedRecord = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0009', requestId: raced.id, requestedBy: ADMIN });
  const [portal, external] = await Promise.allSettled([
    approveRequest(other, { tenantRef, id: raced.id, decidedBy: APPROVER, enforceScope: true }),
    receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(racedRecord, { status: 'rejected', externalUser: 'second', reason: 'risk' }) }),
  ]);
  assert.equal(external.status, 'fulfilled');
  const final = await requestRow(raced.id);
  if (portal.status === 'fulfilled') {
    assert.equal(final.status, 'approved');
    assert.equal(external.value.outcome, 'conflict');
  } else {
    assert.ok(portal.reason instanceof ApprovalClosedError);
    assert.equal(final.status, 'rejected');
    assert.equal(external.value.outcome, 'applied');
  }
  await runMirrorCycle(client, { tenantRef, adapter: fixtureAdapter() });
  const racedDecisions = await decisionsFor(racedRecord.id);
  assert.equal(racedDecisions.length, 1);
  assert.equal(racedDecisions[0].outcome, final.status);
  assert.equal((await jobsFor(raced.id)).length, final.status === 'approved' ? 1 : 0);
});

test('an emergency change mirror carries the canonical decision digest', async () => {
  const now = new Date();
  const intent = await createChangeIntent(client, {
    tenantRef, approverPrincipalId: APPROVER, ownerPrincipalId: REQUESTER,
    naturalKey: 'group:finance', resourceType: 'group',
    transitions: [{ field: 'visibility', before: 'Private', after: 'Public' }],
    reason: 'incident 7', externalChangeId: 'CHG0010', windowEnd: new Date(now.getTime() + 60 * 60 * 1000), now,
  });
  const record = await mirrorChangeIntent(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0010', intentId: intent.id, requestedBy: ADMIN });
  const [decision] = await decisionsFor(record.id);
  assert.equal(decision.decision_digest, intent.decisionDigest);
  assert.equal(decision.source, 'keel');
  const adapter = fixtureAdapter();
  await drainItsmOutbox(client, { tenantRef, adapter });
  const mirrored = adapter.received.get(`keel:decision:${decision.id}`);
  assert.equal(mirrored.payload.decisionDigest, intent.decisionDigest);
  assert.equal(mirrored.payload.decision.decisionDigest, intent.decisionDigest);
  // An external callback never decides (or re-decides) an emergency change.
  assert.equal((await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(record, { status: 'rejected' }) })).outcome, 'not-decidable');
  assert.equal((await mirrorChangeIntent(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0010', intentId: intent.id, requestedBy: ADMIN })).id, record.id);
});

test('lost deliveries are retried; a poison event is quarantined; the decision never rolls back', async () => {
  const request = await pendingRequest();
  const record = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0011', requestId: request.id, requestedBy: ADMIN });
  await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(record) });
  const flaky = fixtureAdapter({ failures: 1 });
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const firstDrain = await drainItsmOutbox(client, { tenantRef, adapter: flaky, now: start });
  assert.ok(firstDrain.retried >= 1);
  let events = await listItsmOutbox(client, { tenantRef, recordId: record.id });
  assert.ok(events.some((row) => row.status === 'pending' && row.last_error === 'connection reset'));
  await drainItsmOutbox(client, { tenantRef, adapter: flaky, now: new Date(start.getTime() + 10 * 60 * 1000) });
  events = await listItsmOutbox(client, { tenantRef, recordId: record.id });
  assert.ok(events.every((row) => row.status === 'delivered'), JSON.stringify(events.map((row) => row.status)));
  assert.ok(flaky.received.has(`keel:${record.id}:v1:record`));

  const poison = await pendingRequest();
  const poisonRecord = await mirrorApprovalRequest(client, { tenantRef, adapter: ADAPTER, externalRef: 'CHG0012', requestId: poison.id, requestedBy: ADMIN });
  await receiveCallback(client, { tenantRef, adapter: ADAPTER, event: callback(poisonRecord) });
  await drainItsmOutbox(client, { tenantRef, adapter: fixtureAdapter({ failures: 99, permanent: true }), now: new Date(start.getTime() + 20 * 60 * 1000) });
  const poisoned = await listItsmOutbox(client, { tenantRef, recordId: poisonRecord.id });
  assert.ok(poisoned.every((row) => row.status === 'quarantined' && row.quarantine_reason === 'rejected by adapter'));
  assert.equal((await requestRow(poison.id)).status, 'approved', 'a failed mirror never rolls back the canonical decision');
  assert.equal((await jobsFor(poison.id)).length, 1);
  await assert.rejects(client.query('UPDATE itsm_decision SET outcome = $1', ['rejected']), /append-only/);
  assert.equal((await verifyChain(client, { tenantRef })).ok, true);
});
