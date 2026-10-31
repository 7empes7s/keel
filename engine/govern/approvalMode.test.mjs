import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import {
  APPROVAL_DECISION_EVIDENCE_KIND, ApprovalReasonRequiredError, SelfApprovalError, approveRequest, requestApproval, routeApproval,
} from './approvals.mjs';
import {
  APPROVAL_MODE_EVIDENCE_KIND, ApprovalModeError, getApprovalMode, selfApprovalAllowed, selfApprovalReasonProblem, setApprovalMode,
} from './approvalMode.mjs';
import { setApprovalPolicy } from './approvalPolicy.mjs';
import { assertDispositionApproval, DispositionApprovalError } from './dispositionReview.mjs';
import { grantRole } from '../authz/administration.mjs';
import { authorizeContentRestore, ContentRestoreRefusedError } from '../content/restore/gate.mjs';
import { ChangeIntentError, activeIntentsFor, createChangeIntent } from '../policy/changeIntent.mjs';
import { createDryRunArtifact, getDryRunArtifactById } from '../restore/dryRunArtifact.mjs';
import {
  ContentEffectApprovalError, approveContentEffects, assertContentEffectApproval, contentEffectsDigest,
} from '../safety/contentEffects.mjs';
import { createSnapshot } from '../store/db.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

// Approval mode: two-person (the default) refuses self-approval everywhere; solo lets the
// requester decide their own request, records it as self-approved, and every gate that
// runs the change later stops counting it once the mode is two-person again.
const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

const tenant = () => tenantRefFor(randomUUID());

// A business with one admin: the same person asks and approves.
async function principal(client) {
  const { rows } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id', [`${randomUUID()}@contoso.example`]);
  for (const role of ['admin', 'approver']) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id });
  return rows[0].id;
}

async function evidenceOf(client, tenantRef, kind) {
  const { rows } = await client.query(
    'SELECT subject, actor FROM evidence WHERE tenant_ref = $1 AND kind = $2 ORDER BY seq',
    [tenantRef, kind],
  );
  return rows;
}

const solo = (client, tenantRef, actor) => setApprovalMode(client, { tenantRef, mode: 'solo', actor, riskAcknowledged: true });
const twoPerson = (client, tenantRef, actor) => setApprovalMode(client, { tenantRef, mode: 'two-person', actor });
const ask = (client, tenantRef, requestedBy, extra = {}) => requestApproval(client, {
  tenantRef, action: 'baseline-activate', params: { baselineId: randomUUID() }, requestedBy, ...extra,
});

test('the mode is two-person until set; solo needs the risk confirmed; every change is in the audit record', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  assert.equal((await getApprovalMode(client, { tenantRef })).mode, 'two-person');
  assert.equal(await selfApprovalAllowed(client, { tenantRef }), false);
  await assert.rejects(setApprovalMode(client, { tenantRef, mode: 'solo', actor: admin }), ApprovalModeError);
  await assert.rejects(setApprovalMode(client, { tenantRef, mode: 'alone', actor: admin, riskAcknowledged: true }), ApprovalModeError);
  assert.equal((await getApprovalMode(client, { tenantRef })).mode, 'two-person', 'a refused change changes nothing');

  const switched = await solo(client, tenantRef, admin);
  assert.equal(switched.changed, true);
  assert.equal(switched.setting.mode, 'solo');
  assert.equal(String(switched.setting.updatedBy), String(admin));
  assert.equal((await solo(client, tenantRef, admin)).changed, false, 'setting the same mode again is a no-op');
  assert.equal((await twoPerson(client, tenantRef, admin)).setting.mode, 'two-person');

  const records = await evidenceOf(client, tenantRef, APPROVAL_MODE_EVIDENCE_KIND);
  assert.deepEqual(records.map((row) => row.subject), [
    { mode: 'solo', previous: 'two-person', riskAcknowledged: true },
    { mode: 'two-person', previous: 'solo' },
  ]);
  assert.equal((await getApprovalMode(client, { tenantRef: tenant() })).mode, 'two-person', 'per tenant');
});

test('two-person refuses self-approval; solo allows it and records it as self-approved', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);

  const refused = await ask(client, tenantRef, admin);
  await assert.rejects(approveRequest(client, { tenantRef, id: refused.id, decidedBy: admin }), SelfApprovalError);

  await solo(client, tenantRef, admin);
  const decided = await approveRequest(client, { tenantRef, id: refused.id, decidedBy: admin, reason: 'Restore the KEEL-RT- policy changed by mistake' });
  assert.equal(decided.request.status, 'approved');
  assert.equal(decided.request.self_approved, true);
  assert.ok(decided.job, 'the approved job is minted as usual');

  // Another person's approval is never marked self-approved.
  const other = await principal(client);
  const theirs = await ask(client, tenantRef, other);
  assert.equal((await approveRequest(client, { tenantRef, id: theirs.id, decidedBy: admin })).request.self_approved, false);

  const decisions = (await evidenceOf(client, tenantRef, APPROVAL_DECISION_EVIDENCE_KIND)).map((row) => row.subject);
  assert.equal(decisions[0].selfApproved, true);
  assert.equal(decisions[0].approvalMode, 'solo');
  assert.equal(decisions[1].selfApproved, undefined);

  // Back to two-person: refused again.
  await twoPerson(client, tenantRef, admin);
  const later = await ask(client, tenantRef, admin);
  await assert.rejects(approveRequest(client, { tenantRef, id: later.id, decidedBy: admin }), SelfApprovalError);
});

test('solo has no two-person exceptions, but never lets a standing policy self-approve', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  await solo(client, tenantRef, admin);
  await setApprovalPolicy(client, { tenantRef, actionClass: 'delete', twoPerson: true, actor: admin });
  const twoNeeded = await ask(client, tenantRef, admin, { policyActions: ['delete'] });
  assert.equal(twoNeeded.required_approvals, 2);
  const decided = await approveRequest(client, { tenantRef, id: twoNeeded.id, decidedBy: admin, reason: 'Restore the KEEL-RT- policy changed by mistake' });
  assert.equal(decided.request.status, 'approved', 'a self-approval decides even a two-person-rule request in solo');
  assert.equal(decided.request.self_approved, true);
  assert.ok(decided.job);

  // Someone else's approval of a two-person-rule request is still a sign-off only.
  const other = await principal(client);
  const theirs = await ask(client, tenantRef, other, { policyActions: ['delete'] });
  assert.equal((await approveRequest(client, { tenantRef, id: theirs.id, decidedBy: admin })).job, null);

  const standing = await ask(client, tenantRef, admin);
  await assert.rejects(
    approveRequest(client, { tenantRef, id: standing.id, decidedBy: admin, standingPolicy: 'operator-test-tenant', reason: 'Restore the KEEL-RT- policy changed by mistake' }),
    SelfApprovalError,
  );
});

test('a self-approval needs a reason that says why', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  await solo(client, tenantRef, admin);
  const request = await ask(client, tenantRef, admin);
  for (const reason of [undefined, '', '   ', 'ok', 'test', 'xxxxxxxxxxxx', 'approved.', 'shortone']) {
    await assert.rejects(approveRequest(client, { tenantRef, id: request.id, decidedBy: admin, reason }), ApprovalReasonRequiredError, `refused: ${JSON.stringify(reason)}`);
  }
  const { rows: [still] } = await client.query('SELECT status FROM approval_request WHERE id = $1', [request.id]);
  assert.equal(still.status, 'pending');
  const decided = await approveRequest(client, { tenantRef, id: request.id, decidedBy: admin, reason: 'Restore the KEEL-RT- policy changed by mistake' });
  assert.equal(decided.request.reason, 'Restore the KEEL-RT- policy changed by mistake');
  const [decision] = (await evidenceOf(client, tenantRef, APPROVAL_DECISION_EVIDENCE_KIND)).map((row) => row.subject);
  assert.equal(decision.reason, 'Restore the KEEL-RT- policy changed by mistake');
  assert.equal(decision.selfApproved, true);

  assert.equal(selfApprovalReasonProblem('Restore the deleted policy'), null);
  assert.match(selfApprovalReasonProblem('n/a'), /reason/);
});

test('routing counts the requester as an approver only in solo mode', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  const before = await routeApproval(client, { tenantRef, entityScope: null, requesterId: admin });
  assert.ok(!before.approvers.includes(admin));
  await solo(client, tenantRef, admin);
  const now = await routeApproval(client, { tenantRef, entityScope: null, requesterId: admin });
  assert.ok(now.approvers.includes(admin));
});

test('a self-approved content restore runs only while the mode is still solo', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  const canFn = async () => true;
  const runId = randomUUID();
  const request = await requestApproval(client, {
    tenantRef, action: 'content-restore', params: { runId, tenantRef, workload: 'mail', request: {} }, requestedBy: admin, executor: 'cli',
  });
  await assert.rejects(approveRequest(client, { tenantRef, id: request.id, decidedBy: admin }), SelfApprovalError);
  await solo(client, tenantRef, admin);
  await approveRequest(client, { tenantRef, id: request.id, decidedBy: admin, reason: 'Restore the KEEL-RT- policy changed by mistake' });
  await authorizeContentRestore(client, { actor: admin, approvalId: request.id, runId, tenantRef, canFn });
  await twoPerson(client, tenantRef, admin);
  await assert.rejects(
    authorizeContentRestore(client, { actor: admin, approvalId: request.id, runId, tenantRef, canFn }),
    (error) => error instanceof ContentRestoreRefusedError && /self-approved/.test(error.message),
  );
});

test('a self-approved accept or ignore counts only while the mode is still solo', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  await solo(client, tenantRef, admin);
  const request = await requestApproval(client, {
    tenantRef, action: 'dispose', params: { driftIds: ['d-1'], action: 'accept' }, requestedBy: admin,
    justification: 'Accept the KEEL-RT- sharing change we made on purpose',
  });
  // The request's own reason is enough when no new one is given.
  await approveRequest(client, { tenantRef, id: request.id, decidedBy: admin });
  const check = () => assertDispositionApproval(client, { approvalId: request.id, actor: admin, tenantRef, matches: () => true });
  assert.equal((await check()).self_approved, true);
  await twoPerson(client, tenantRef, admin);
  await assert.rejects(check(), (error) => error instanceof DispositionApprovalError && /self-approved/.test(error.message));
});

test('content effects: self-approval only in solo mode, and the gate stops counting it after', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  const contentEffects = [{ naturalKey: 'group:KEEL-RT-1', resourceType: 'microsoft.graph.group', field: 'expirationDateTime', effect: 'retention-reducing' }];
  const created = await createDryRunArtifact(client, {
    id: randomUUID(), tenantRef, snapshotId: await createSnapshot(client, { tenantRef }), selection: ['group:KEEL-RT-1'], closureKeys: ['group:KEEL-RT-1'],
    targetTenantId: randomUUID(), collectorConfigPath: '/etc/keel/tenant.json', targetConfigPath: '/etc/keel/restorer.json',
    waves: [], patches: [], guardRefusals: [], results: {}, currentStateFingerprint: 'f', digest: 'd', status: 'completed',
    requestedBy: admin, contentEffects,
  });
  const artifact = await getDryRunArtifactById(client, { id: created.id });
  const approve = () => approveContentEffects(client, {
    tenantRef, artifactId: artifact.id, approverId: admin, effectsDigest: contentEffectsDigest(contentEffects), justification: 'KEEL-RT- test',
  });
  await assert.rejects(approve(), ContentEffectApprovalError);
  await solo(client, tenantRef, admin);
  await assert.rejects(approveContentEffects(client, {
    tenantRef, artifactId: artifact.id, approverId: admin, effectsDigest: contentEffectsDigest(contentEffects), justification: 'ok',
  }), (error) => error instanceof ContentEffectApprovalError && /reason/.test(error.message));
  assert.equal((await approve()).self_approved, true);
  assert.ok(await assertContentEffectApproval(client, { artifact, effects: contentEffects }));
  await twoPerson(client, tenantRef, admin);
  await assert.rejects(assertContentEffectApproval(client, { artifact, effects: contentEffects }), ContentEffectApprovalError);
});

test('emergency changes: the owner approves their own only in solo mode, recorded as self-approved', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  const intent = (reason = 'KEEL-RT- outage') => createChangeIntent(client, {
    tenantRef, approverPrincipalId: admin, ownerPrincipalId: admin, reason,
    naturalKey: 'group:KEEL-RT-2', resourceType: 'microsoft.graph.group',
    transitions: [{ field: 'visibility', before: 'Private', after: 'Public' }],
    windowEnd: new Date(Date.now() + 60 * 60 * 1000),
  });
  await assert.rejects(intent(), (error) => error instanceof ChangeIntentError && error.code === 'owner-is-approver');
  await solo(client, tenantRef, admin);
  await assert.rejects(intent('fix'), (error) => error instanceof ChangeIntentError && error.code === 'reason-required');
  const made = await intent();
  assert.equal(made.selfApproved, true);
  const active = () => activeIntentsFor(client, { tenantRef, naturalKeys: ['group:KEEL-RT-2'] });
  assert.deepEqual((await active()).map((entry) => entry.id), [made.id]);
  // Back to two-person: a self-approved emergency change no longer holds off a roll back.
  await twoPerson(client, tenantRef, admin);
  assert.deepEqual(await active(), []);
});
