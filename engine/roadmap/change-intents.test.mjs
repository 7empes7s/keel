/**
 * Roadmap task-93 boundary tests: time-bounded approved emergency deviations. Exercises
 * engine/policy/changeIntent.mjs over the real seams — the immutable change_intent and
 * change_intent_event tables (schema.sql), approver authorization (authz), the normal
 * policy path (evaluate.mjs evaluateDrift, execute.mjs executeAutoRemediation), the
 * remediate job's execution-time re-check (cli/keel-remediate.mjs runRemediate) and the
 * evidence chain — against an isolated test database.
 *
 * Required mutation checks:
 *
 * - Suppress whole resource instead of scoped field.   (an unrelated field change on the
 *                                                       same resource still queues a roll back)
 * - Ignore intent expiry.                              (at windowEnd the drift is rolled back
 *                                                       normally; a revoked intent stops at once)
 * - Apply expired inverse without reread.              (settlement of a resource already back at
 *                                                       its baseline queues nothing, and a
 *                                                       still-drifted one acts on the newest drift)
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  CHANGE_INTENT_EVIDENCE_KIND, ChangeIntentError, activeIntentsFor, assessDrift, changeIntentDecision,
  classifyDrift, createChangeIntent, getChangeIntent, intentActiveAt, listChangeIntents, revokeChangeIntent,
  settleChangeIntents,
} from '../policy/changeIntent.mjs';
import { createPolicy, evaluateDrift } from '../policy/evaluate.mjs';
import { AUTOMATION_EXECUTION_EVIDENCE_KIND, executeAutoRemediation } from '../policy/execute.mjs';
import { seedFromSnapshot } from '../govern/baseline.mjs';
import { verifyChain } from '../govern/evidence.mjs';
import { canonicalDigest } from '../restore/dryRunArtifact.mjs';
import { completeSnapshot, createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { OPEN_DRIFT_PREDICATE } from '../store/openDrift.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import { runRemediate } from '../../cli/keel-remediate.mjs';

const noopLogger = { log() {}, error() {} };
const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
const haltDirectory = mkdtempSync(join(tmpdir(), 'keel-change-intent-'));
const killSwitchPath = join(haltDirectory, 'AUTOMATION_DISABLED');
after(async () => {
  rmSync(haltDirectory, { recursive: true, force: true });
  await client.end();
  await database.cleanup();
});

const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
await client.query(schema);
await client.query(schema); // additive and retry-safe

const ADMIN = '11111111-1111-4111-8111-111111111111';
const RUN_AS = '22222222-2222-4222-8222-222222222222';
const APPROVER = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';
const SECOND_APPROVER = '55555555-5555-4555-8555-555555555555';
await client.query(
  `INSERT INTO principal (id, email, display_name) VALUES
     ($1, 'policy-admin@example.com', 'Policy admin'), ($2, 'svc-policy@example.com', 'Policy service'),
     ($3, 'approver@example.com', 'Amara Okafor'), ($4, 'oncall@example.com', 'On-call engineer'),
     ($5, 'second-approver@example.com', 'Second approver')`,
  [ADMIN, RUN_AS, APPROVER, OWNER, SECOND_APPROVER],
);
await client.query(
  `INSERT INTO role_grant (principal_id, role, granted_by, reason) VALUES
     ($1, 'admin', 'test', 'policy administrator'), ($2, 'restorer', 'test', 'policy run-as'),
     ($3, 'approver', 'test', 'change approver'), ($4, 'operator', 'test', 'on-call'),
     ($5, 'approver', 'test', 'change approver'), ($3, 'approver', 'test', 'duplicate grant is harmless')`,
  [ADMIN, RUN_AS, APPROVER, OWNER, SECOND_APPROVER],
);

const BASE = { displayName: 'Finance', mailNickname: 'Finance', visibility: 'Private' };
const HOUR = 60 * 60 * 1000;

async function seedTenant(tenantRef) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  for (const [key, payload] of [['group:Finance', BASE], ['group:Payroll', { ...BASE, displayName: 'Payroll', mailNickname: 'Payroll' }]]) {
    await insertResourceVersion(client, {
      snapshotId,
      resource: {
        naturalKey: key, resourceType: 'group', payload, payloadHash: canonicalDigest(payload),
        criticality: 'tier1', blastRadius: 'cosmetic', fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
  }
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: fullSuccessfulCoverageDigest() });
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId, setBy: ADMIN });
  const policy = await createPolicy(client, {
    tenantRef, name: 'Roll back group changes', resourceType: 'group', action: 'auto_remediate', enabled: true,
    maxBlastRadius: 'cosmetic', createdBy: ADMIN, runAsPrincipalId: RUN_AS,
  });
  return { baselineId, policy };
}

/** A new complete collection holding `payload` for the resource, and — unless
 * `detect` is false or it equals the baseline — the drift row detection would record. */
async function observe(tenantRef, baselineId, payload, { naturalKey = 'group:Finance', base = BASE, detect = true } = {}) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey, resourceType: 'group', payload, payloadHash: canonicalDigest(payload),
      criticality: 'tier1', blastRadius: 'cosmetic', fidelity: 'full', provenance: { adapter: 'test' },
    },
  });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: fullSuccessfulCoverageDigest() });
  if (!detect || canonicalDigest(payload) === canonicalDigest(base)) return { snapshotId, drift: null };
  const { rows: [drift] } = await client.query(
    `INSERT INTO drift
       (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
        before_hash, after_hash, before_payload, after_payload, blast_radius)
     VALUES ($1,$2,$3,$4,'group','modified',$5,$6,$7,$8,'cosmetic')
     RETURNING *`,
    [tenantRef, baselineId, snapshotId, naturalKey, canonicalDigest(base), canonicalDigest(payload), base, payload],
  );
  return { snapshotId, drift };
}

const approve = (tenantRef, extra) => createChangeIntent(client, {
  tenantRef, approverPrincipalId: APPROVER, ownerPrincipalId: OWNER, reason: 'INC-4410: open the group to responders',
  externalChangeId: 'CHG0031337', ...extra,
});

async function jobsFor(driftId) {
  const { rows } = await client.query(
    `SELECT * FROM job WHERE kind = 'remediate' AND params->'driftIds' @> to_jsonb($1::text)`,
    [driftId],
  );
  return rows;
}

async function isOpen(driftId) {
  const { rows } = await client.query(`SELECT 1 FROM drift d WHERE d.id = $1 AND ${OPEN_DRIFT_PREDICATE}`, [driftId]);
  return rows.length === 1;
}

async function refused(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ChangeIntentError, `expected a change intent refusal, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test('an approved field change stays visible and is not rolled back in its window; any other change still is', async () => {
  const tenantRef = 'sha256:intent-scope';
  const { baselineId, policy } = await seedTenant(tenantRef);
  const t0 = new Date();
  const { drift: emergency } = await observe(tenantRef, baselineId, { ...BASE, visibility: 'Public' });
  const intent = await approve(tenantRef, { driftId: emergency.id, fields: ['visibility'], windowStart: t0, windowEnd: new Date(t0.getTime() + HOUR), now: t0 });
  assert.deepEqual(intent.transitions, [{ field: 'visibility', before: { present: true, value: 'Private' }, after: { present: true, value: 'Public' } }]);
  assert.equal(intent.owner.name, 'On-call engineer');
  assert.equal(intent.approver.name, 'Amara Okafor');
  assert.equal(intent.sourceDriftId, emergency.id);

  const inWindow = new Date(t0.getTime() + 10 * 60 * 1000);
  // Visible: the policy still matches and its evaluation is recorded; the drift stays open.
  const evaluation = await evaluateDrift(client, { tenantRef, drift: emergency });
  assert.deepEqual(evaluation.matches.map((match) => match.outcome), ['auto_remediate']);
  const suppressed = await executeAutoRemediation(client, { tenantRef, drift: emergency, policyId: policy.id, killSwitchPath, now: inWindow });
  assert.deepEqual(suppressed, { executed: false, outcome: 'change-intent-approved' });
  assert.equal((await jobsFor(emergency.id)).length, 0, 'no roll back was queued');
  assert.equal(await isOpen(emergency.id), true, 'the approved change is still an open change');
  const { rows: [refusal] } = await client.query(
    `SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = $2 AND subject->>'driftId' = $3`,
    [tenantRef, AUTOMATION_EXECUTION_EVIDENCE_KIND, emergency.id],
  );
  assert.deepEqual([refusal.subject.outcome, refusal.subject.intentIds, refusal.subject.approvedFields], ['change-intent-approved', [intent.id], ['visibility']]);

  // A concurrent unrelated field change on the same resource is not approved: it rolls back.
  const { drift: mixed } = await observe(tenantRef, baselineId, { ...BASE, visibility: 'Public', displayName: 'Finance (all staff)' });
  assert.deepEqual(await assessDrift(client, { tenantRef, drift: mixed, now: inWindow }), {
    state: 'unapproved', reason: 'unapproved field change', approvedFields: ['visibility'], unapprovedFields: ['displayName'], intentIds: [intent.id],
  });
  const mixedOutcome = await executeAutoRemediation(client, { tenantRef, drift: mixed, policyId: policy.id, killSwitchPath, now: inWindow });
  assert.equal(mixedOutcome.outcome, 'queued', 'an unrelated field change still triggers its roll back');
  const { rows: [queued] } = await client.query(
    `SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = $2 AND subject->>'driftId' = $3 AND subject->>'outcome' = 'queued'`,
    [tenantRef, AUTOMATION_EXECUTION_EVIDENCE_KIND, mixed.id],
  );
  assert.deepEqual(queued.subject.changeIntent, { applied: false, reason: 'unapproved field change', approvedFields: ['visibility'], unapprovedFields: ['displayName'] });

  // A changed transition cannot reuse the approval: same field, a different after value.
  const { drift: further } = await observe(tenantRef, baselineId, { ...BASE, visibility: 'HiddenMembership' });
  assert.equal((await executeAutoRemediation(client, { tenantRef, drift: further, policyId: policy.id, killSwitchPath, now: inWindow })).outcome, 'queued');
  // The same transition on another resource is not approved either.
  const payrollBase = { ...BASE, displayName: 'Payroll', mailNickname: 'Payroll' };
  const { drift: payroll } = await observe(tenantRef, baselineId, { ...payrollBase, visibility: 'Public' }, { naturalKey: 'group:Payroll', base: payrollBase });
  assert.equal((await executeAutoRemediation(client, { tenantRef, drift: payroll, policyId: policy.id, killSwitchPath, now: inWindow })).outcome, 'queued');
  // The intent of one tenant never covers another tenant's change.
  assert.deepEqual(await activeIntentsFor(client, { tenantRef: 'sha256:intent-elsewhere', naturalKeys: ['group:Finance'], now: inWindow }), []);
  assert.equal(await getChangeIntent(client, { tenantRef: 'sha256:intent-elsewhere', intentId: intent.id }), null);
  assert.equal((await verifyChain(client, { tenantRef })).ok, true);
});

test('window boundaries are half-open and a revocation takes effect at its instant', async () => {
  const tenantRef = 'sha256:intent-clock';
  const { baselineId, policy } = await seedTenant(tenantRef);
  const t0 = new Date(Date.now() + 1000);
  const end = new Date(t0.getTime() + HOUR);
  const { drift } = await observe(tenantRef, baselineId, { ...BASE, visibility: 'Public' });
  const intent = await approve(tenantRef, { driftId: drift.id, fields: ['visibility'], windowStart: t0, windowEnd: end, now: new Date(t0.getTime() - 500) });

  const at = (ms) => new Date(ms);
  assert.equal(intentActiveAt(intent, at(t0.getTime() - 1)), false, 'not before windowStart');
  assert.equal(intentActiveAt(intent, t0), true, 'active at windowStart');
  assert.equal(intentActiveAt(intent, at(end.getTime() - 1)), true, 'active up to the last instant');
  assert.equal(intentActiveAt(intent, end), false, 'ended at windowEnd');
  assert.equal(classifyDrift(drift, [intent], at(t0.getTime() - 1)).state, 'none', 'a scheduled intent does not cover the change yet');
  assert.equal((await listChangeIntents(client, { tenantRef, now: at(t0.getTime() - 1) }))[0].state, 'scheduled');

  // Through the execution path: refused one instant before windowEnd, rolled back at it.
  const last = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id, killSwitchPath, now: at(end.getTime() - 1) });
  assert.equal(last.outcome, 'change-intent-approved');
  const expired = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id, killSwitchPath, now: end });
  assert.equal(expired.outcome, 'queued', 'an expired approval no longer holds the roll back back');
  assert.equal((await listChangeIntents(client, { tenantRef, now: end }))[0].state, 'ended');

  // Revocation: only an approver may revoke; it ends the window at the recorded instant.
  const { drift: second } = await observe(tenantRef, baselineId, { ...BASE, visibility: 'Public', mailNickname: 'FinanceOps' });
  const start2 = new Date(end.getTime() + 1000);
  const revocable = await approve(tenantRef, {
    driftId: second.id, fields: ['mailNickname', 'visibility'], windowStart: start2, windowEnd: new Date(start2.getTime() + HOUR), now: end,
  });
  const revokeAt = new Date(start2.getTime() + 5 * 60 * 1000);
  await refused(revokeChangeIntent(client, { tenantRef, intentId: revocable.id, revokedBy: OWNER, reason: 'done', now: revokeAt, killSwitchPath }), 'approver-not-authorized');
  assert.equal((await assessDrift(client, { tenantRef, drift: second, now: new Date(revokeAt.getTime() - 1) })).state, 'approved');
  const { intent: revoked } = await revokeChangeIntent(client, {
    tenantRef, intentId: revocable.id, revokedBy: SECOND_APPROVER, reason: 'emergency over', now: revokeAt, killSwitchPath,
  });
  assert.equal(revoked.revokedAt, revokeAt.toISOString());
  assert.equal(revoked.revokeReason, 'emergency over');
  assert.equal(revoked.revokedBy.name, 'Second approver');
  assert.equal((await assessDrift(client, { tenantRef, drift: second, now: revokeAt })).state, 'none', 'revoked at its instant');
  assert.equal(intentActiveAt(revoked, revokeAt), false);
  assert.equal((await listChangeIntents(client, { tenantRef, now: revokeAt })).find((entry) => entry.id === revocable.id).state, 'revoked');
  await refused(revokeChangeIntent(client, { tenantRef, intentId: revocable.id, revokedBy: SECOND_APPROVER, reason: 'again', now: revokeAt, killSwitchPath }), 'already-ended');
  await refused(revokeChangeIntent(client, { tenantRef, intentId: intent.id, revokedBy: SECOND_APPROVER, reason: 'late', now: end, killSwitchPath }), 'already-ended');
});

test('when the window ends KEEL re-reads the resource and evaluates its current state, never the approved inverse', async () => {
  const tenantRef = 'sha256:intent-expiry';
  const { baselineId, policy } = await seedTenant(tenantRef);
  const t0 = new Date();
  const end = new Date(t0.getTime() + HOUR);
  const { drift: emergency } = await observe(tenantRef, baselineId, { ...BASE, visibility: 'Public' });
  const intent = await approve(tenantRef, { driftId: emergency.id, fields: ['visibility'], windowStart: t0, windowEnd: end, now: t0 });

  // Not ended yet: nothing is settled.
  assert.deepEqual(await settleChangeIntents(client, { tenantRef, now: new Date(end.getTime() - 1), killSwitchPath }), []);

  // The owner already put the setting back during the window: the newest collection
  // matches the baseline, so nothing is rolled back — not even the old open drift.
  await observe(tenantRef, baselineId, BASE);
  const [settled] = await settleChangeIntents(client, { tenantRef, now: end, killSwitchPath });
  assert.equal(settled.intentId, intent.id);
  assert.equal(settled.currentState, 'matches-baseline');
  assert.deepEqual(settled.remediations, []);
  assert.equal((await jobsFor(emergency.id)).length, 0, 'the approved transition is never reversed blindly');
  assert.deepEqual(await settleChangeIntents(client, { tenantRef, now: new Date(end.getTime() + HOUR), killSwitchPath }), [], 'settled once');
  const settledIntent = await getChangeIntent(client, { tenantRef, intentId: intent.id });
  assert.equal(settledIntent.settlement.currentState, 'matches-baseline');
  assert.equal(settledIntent.settledAt, end.toISOString());

  // Still drifted at expiry: the newest drift row is evaluated through the normal path.
  const t1 = new Date(end.getTime() + 1000);
  const end1 = new Date(t1.getTime() + HOUR);
  const { drift: again } = await observe(tenantRef, baselineId, { ...BASE, visibility: 'Public' });
  const second = await approve(tenantRef, { driftId: again.id, fields: ['visibility'], windowStart: t1, windowEnd: end1, now: t1 });
  const { drift: newest } = await observe(tenantRef, baselineId, { ...BASE, visibility: 'Public', displayName: 'Finance responders' });
  const [resumed] = await settleChangeIntents(client, { tenantRef, now: end1, killSwitchPath });
  assert.equal(resumed.intentId, second.id);
  assert.equal(resumed.currentState, 'drifted');
  assert.equal(resumed.driftId, newest.id, 'the newest observation, not the change the approval was made from');
  assert.deepEqual(resumed.remediations.map((entry) => [entry.policyId, entry.outcome]), [[policy.id, 'queued']]);
  assert.equal((await jobsFor(newest.id)).length, 1);
  assert.equal((await jobsFor(again.id)).length, 0);

  // Collected but not yet detected: nothing acts until detection records the drift.
  const t2 = new Date(end1.getTime() + 1000);
  const { drift: third } = await observe(tenantRef, baselineId, { ...BASE, visibility: 'Public', mailNickname: 'FinanceX' });
  const pending = await approve(tenantRef, { driftId: third.id, fields: ['mailNickname', 'visibility'], windowStart: t2, windowEnd: new Date(t2.getTime() + HOUR), now: t2 });
  await observe(tenantRef, baselineId, { ...BASE, visibility: 'Public' }, { detect: false });
  const [waiting] = await settleChangeIntents(client, { tenantRef, now: new Date(t2.getTime() + HOUR), killSwitchPath });
  assert.equal(waiting.intentId, pending.id);
  assert.equal(waiting.currentState, 'awaiting-detection');
  assert.deepEqual(waiting.remediations, []);
  assert.equal((await jobsFor(third.id)).length, 0);

  const { rows: settlements } = await client.query(
    `SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = $2 AND subject->>'outcome' = 'settled' ORDER BY seq`,
    [tenantRef, CHANGE_INTENT_EVIDENCE_KIND],
  );
  assert.deepEqual(settlements.map((row) => row.subject.currentState), ['matches-baseline', 'drifted', 'awaiting-detection']);
  assert.equal((await verifyChain(client, { tenantRef })).ok, true);
});

test('an approval is immutable, separates owner and approver, is bounded, and binds one decision', async () => {
  const tenantRef = 'sha256:intent-record';
  const { baselineId } = await seedTenant(tenantRef);
  const t0 = new Date();
  const end = new Date(t0.getTime() + 2 * HOUR);
  const { drift } = await observe(tenantRef, baselineId, { ...BASE, visibility: 'Public' });

  await refused(approve(tenantRef, { driftId: drift.id, fields: ['visibility'], ownerPrincipalId: APPROVER, windowEnd: end, now: t0 }), 'owner-is-approver');
  await refused(approve(tenantRef, { driftId: drift.id, fields: ['visibility'], approverPrincipalId: OWNER, ownerPrincipalId: APPROVER, windowEnd: end, now: t0 }), 'approver-not-authorized');
  await refused(approve(tenantRef, { driftId: drift.id, fields: ['visibility'], windowEnd: new Date(t0.getTime() + 8 * 24 * HOUR), now: t0 }), 'window-invalid');
  await refused(approve(tenantRef, { driftId: drift.id, fields: ['visibility'], windowStart: new Date(t0.getTime() - 1), windowEnd: end, now: t0 }), 'window-invalid');
  await refused(approve(tenantRef, { driftId: drift.id, fields: ['visibility'], windowStart: end, windowEnd: end, now: t0 }), 'window-invalid');
  await refused(approve(tenantRef, { driftId: drift.id, fields: ['displayName'], windowEnd: end, now: t0 }), 'field-not-changed');
  await refused(approve('sha256:intent-elsewhere', { driftId: drift.id, fields: ['visibility'], windowEnd: end, now: t0 }), 'not-found');
  await refused(approve(tenantRef, { driftId: drift.id, fields: ['visibility'], externalChangeId: 'CHG 1; DROP', windowEnd: end, now: t0 }), 'invalid');
  const { rows: [added] } = await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, after_payload, blast_radius)
     VALUES ($1,$2,$3,'group:New','group','added',$4,'cosmetic') RETURNING *`,
    [tenantRef, baselineId, drift.observed_snapshot, BASE],
  );
  await refused(approve(tenantRef, { driftId: added.id, fields: ['visibility'], windowEnd: end, now: t0 }), 'drift-not-modified');

  // Approved ahead of the change, from explicit transitions (a missing key is an absent field).
  const ahead = await approve(tenantRef, {
    naturalKey: 'group:Finance', resourceType: 'group', windowEnd: end, now: t0, externalChangeId: null,
    transitions: [{ field: 'visibility', before: 'Private', after: 'Public' }, { field: 'description', after: 'Emergency responders' }],
  });
  assert.deepEqual(ahead.transitions.map((entry) => [entry.field, entry.before.present, entry.after.value]), [['description', false, 'Emergency responders'], ['visibility', true, 'Public']]);
  assert.equal(ahead.externalChangeId, null);
  assert.equal((await assessDrift(client, { tenantRef, drift, now: t0 })).state, 'approved', 'a pre-approved transition covers the change when it appears');
  const { drift: withDescription } = await observe(tenantRef, baselineId, { ...BASE, visibility: 'Public', description: 'Emergency responders' });
  assert.equal((await assessDrift(client, { tenantRef, drift: withDescription, now: t0 })).state, 'approved');
  await refused(approve(tenantRef, { naturalKey: 'group:Finance', resourceType: 'group', windowEnd: end, now: t0, transitions: [{ field: 'visibility', before: 'Private', after: 'Private' }] }), 'invalid');

  const intent = await approve(tenantRef, { driftId: drift.id, fields: ['visibility'], windowEnd: end, now: t0 });
  // The decision a future ITSM mirror carries is the stored digest of exactly this approval.
  const decision = changeIntentDecision({
    tenantRef, naturalKey: 'group:Finance', resourceType: 'group', transitions: intent.transitions,
    ownerPrincipalId: OWNER, approverPrincipalId: APPROVER, reason: 'INC-4410: open the group to responders',
    externalChangeId: 'CHG0031337', windowStart: intent.windowStart, windowEnd: intent.windowEnd, approvedAt: intent.approvedAt,
  });
  assert.equal(intent.decisionDigest, canonicalDigest(decision));
  assert.notEqual(intent.decisionDigest, ahead.decisionDigest);
  const { rows: [approvedEvidence] } = await client.query(
    `SELECT subject, actor FROM evidence WHERE tenant_ref = $1 AND kind = $2 AND subject->>'intentId' = $3`,
    [tenantRef, CHANGE_INTENT_EVIDENCE_KIND, intent.id],
  );
  assert.deepEqual([approvedEvidence.subject.outcome, approvedEvidence.subject.decisionDigest, approvedEvidence.subject.externalChangeId, approvedEvidence.actor],
    ['approved', intent.decisionDigest, 'CHG0031337', APPROVER]);

  // Immutable: no edit of the approved transition, window or decision, and no deletion.
  await assert.rejects(client.query(`UPDATE change_intent SET transitions = '[{"field":"visibility"}]' WHERE id = $1`, [intent.id]), /append-only/);
  await assert.rejects(client.query('UPDATE change_intent SET window_end = window_end + interval \'1 day\' WHERE id = $1', [intent.id]), /append-only/);
  await assert.rejects(client.query('DELETE FROM change_intent WHERE id = $1', [intent.id]), /append-only/);
  await revokeChangeIntent(client, { tenantRef, intentId: intent.id, revokedBy: APPROVER, reason: 'done', now: new Date(t0.getTime() + 1000), killSwitchPath });
  await assert.rejects(client.query("DELETE FROM change_intent_event WHERE intent_id = $1", [intent.id]), /append-only/);
  assert.equal((await verifyChain(client, { tenantRef })).ok, true);
});

test('a roll back queued before the approval stops at execution, before any dry run or write', async () => {
  const tenantRef = 'sha256:intent-execution';
  const { baselineId, policy } = await seedTenant(tenantRef);
  const { drift } = await observe(tenantRef, baselineId, { ...BASE, visibility: 'Public' });
  const queued = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id, killSwitchPath });
  assert.equal(queued.outcome, 'queued');
  const now = new Date();
  await approve(tenantRef, { driftId: drift.id, fields: ['visibility'], windowEnd: new Date(now.getTime() + HOUR), now });

  const restoreCalls = [];
  await assert.rejects(runRemediate({
    driftIds: [drift.id], mode: 'enforce', requestedBy: RUN_AS, dbUrl: database.url, logger: noopLogger,
    dependencies: { runRestore: async (options) => { restoreCalls.push(options); return {}; } },
  }), /change-intent-approved/);
  assert.equal(restoreCalls.length, 0, 'no dry run, so no write');

  // A human-requested roll back (no automatic execution row) is the operator's decision.
  const humanTenant = 'sha256:intent-human';
  const human = await seedTenant(humanTenant);
  const { drift: humanDrift } = await observe(humanTenant, human.baselineId, { ...BASE, visibility: 'Public' });
  await approve(humanTenant, { driftId: humanDrift.id, fields: ['visibility'], windowEnd: new Date(now.getTime() + HOUR), now });
  await runRemediate({
    driftIds: [humanDrift.id], mode: 'enforce', requestedBy: ADMIN, dbUrl: database.url, logger: noopLogger,
    dependencies: { runRestore: async (options) => { restoreCalls.push(options); return { artifactId: options.persistArtifactId }; } },
  });
  assert.ok(restoreCalls.length > 0, 'an operator can still roll an approved change back on purpose');
});

test('legacy read: before the tables exist there are no intents and nothing is suppressed', async () => {
  const legacy = await createIsolatedTestDatabase(`${import.meta.url}#legacy`);
  const legacyClient = await legacy.connect();
  try {
    assert.deepEqual(await activeIntentsFor(legacyClient, { tenantRef: 'sha256:legacy', naturalKeys: ['group:Finance'] }), []);
    assert.deepEqual(await listChangeIntents(legacyClient, { tenantRef: 'sha256:legacy' }), []);
    assert.deepEqual(await settleChangeIntents(legacyClient, { tenantRef: 'sha256:legacy' }), []);
    assert.equal(await getChangeIntent(legacyClient, { tenantRef: 'sha256:legacy', intentId: ADMIN }), null);
  } finally {
    await legacyClient.end();
    await legacy.cleanup();
  }
});
