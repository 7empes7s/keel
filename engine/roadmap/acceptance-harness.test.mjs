/**
 * Roadmap task-112 boundary tests: six end-to-end journeys and the release
 * qualification ledger. The journeys (tools/release/journeys.mjs) drive the
 * production paths of their owner tasks against local fakes and an isolated
 * test database, including the worker entry (re-authorization at execution),
 * a lost acknowledgement with retry, and revoked authorization. The ledger
 * (tools/release/acceptanceLedger.mjs) is fed the checked-in qualification
 * records, which are all pending today.
 *
 * Required mutation checks:
 *
 * - Mark release ready with unknown qualification.  (a ledger with every fixture
 *                                                     passing but one gate unknown is
 *                                                     PENDING, never ready)
 * - Treat queued action as verified outcome.         (a journey whose terminal is a
 *                                                     queued roll back fails)
 * - Ignore missing cross-workstream evidence link.   (a claim without its evidence link,
 *                                                     or with a link from another journey,
 *                                                     fails)
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { revokeRole } from '../authz/administration.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import {
  JOURNEYS, UNVERIFIED_STATES, assessJourney, journeyFixtureRecord, runAllJourneys, runJourney,
} from '../../tools/release/journeys.mjs';
import {
  LIVE_ACCEPTANCE_GATES, RELEASE_OBJECTIVES, buildReleaseLedger, classifyLiveRecord, loadLiveRecords,
} from '../../tools/release/acceptanceLedger.mjs';
import { signEvidence } from '../../tools/release/qualification.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const workdir = mkdtempSync(join(tmpdir(), 'keel-acceptance-'));
const targets = [];
let client;
let ctx;
let results;

before(async () => {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  ctx = {
    dbUrl: database.url,
    workdir,
    createTargetDatabase: async () => {
      const target = await createIsolatedTestDatabase(`${import.meta.url}#target-${targets.length}`);
      targets.push(target);
      return target;
    },
  };
  results = await runAllJourneys(client, ctx);
});

after(async () => {
  await client?.end();
  for (const target of targets) await target.cleanup();
  await database.cleanup();
  rmSync(workdir, { recursive: true, force: true });
});

const byId = (id) => results.find((result) => result.journey === id);
// Forged queued jobs must not be claimed by a later journey's worker run.
const cancelQueuedJobs = () => client.query(`UPDATE job SET status = 'cancelled' WHERE status = 'queued'`);

// ------------------------------------------------------------------ journeys

test('every journey reaches its verified, user-visible terminal outcome through its evidence links', () => {
  assert.deepEqual(results.map((result) => result.journey), ['J1', 'J2', 'J3', 'J4', 'J5', 'J6']);
  for (const result of results) {
    assert.equal(result.ok, true, `${result.journey}: ${result.failures.join('; ')}`);
    assert.ok(!UNVERIFIED_STATES.includes(result.terminalState), `${result.journey} ended on ${result.terminalState}`);
    for (const [slot, state] of Object.entries(result.links)) assert.notEqual(state, 'unresolved', `${result.journey} ${slot}`);
  }
});

test('J1: setup stops at the missing prerequisite, survives a lost acknowledgement and resumes', () => {
  const steps = Object.fromEntries(byId('J1').steps.map((step) => [step.step, step]));
  assert.equal(steps['lost-acknowledgement'].outcome, 'uncertain');
  assert.equal(steps['missing-prerequisite'].outcome, 'pending-manual');
  assert.equal(steps['missing-prerequisite'].collectAllowed, false, 'collection stays blocked while a prerequisite is missing');
  assert.ok(steps['missing-prerequisite'].missing.length > 0, 'the missing prerequisite is named');
  assert.equal(steps['missing-prerequisite'].writes, 0, 'nothing is written while a prerequisite is missing');
  assert.equal(steps.resume.outcome, 'complete');
  assert.equal(steps.resume.writes, steps.resume.distinctWrites, 'the retry never repeats a write');
  assert.equal(byId('J1').terminalState, 'read-access-confirmed');
});

test('J2: detection runs through the worker and the investigation answer names the detected change', () => {
  const steps = Object.fromEntries(byId('J2').steps.map((step) => [step.step, step]));
  assert.equal(steps.detection.outcome, 'succeeded', steps.detection.error);
  assert.ok(steps.investigation.records >= 1);
  assert.equal(byId('J2').links['detection-job'], 'succeeded');
});

test('J3: the approved change is not rolled back in its window and settles on a fresh observation', () => {
  const steps = Object.fromEntries(byId('J3').steps.map((step) => [step.step, step]));
  assert.deepEqual([steps['in-window'].outcome, steps['in-window'].executed], ['change-intent-approved', false]);
  assert.deepEqual([steps.settlement.outcome, steps.settlement.remediations], ['matches-baseline', 0]);
});

test('J4: the compromised point is refused and the clean point restores with passing checks', () => {
  const steps = Object.fromEntries(byId('J4').steps.map((step) => [step.step, step]));
  assert.equal(steps['compromised-point'].outcome, 'refused');
  assert.equal(steps['restore-with-backdoor-live'].outcome, 'checks-failed', 'a live backdoor fails the recovery visibly');
  assert.equal(steps.review.outcome, 'completed');
  assert.deepEqual([steps.promote.outcome, steps.promote.restored], ['applied', 'Board']);
  assert.deepEqual(steps.promote.checks, ['passed', 'passed']);
});

test('J5: a recreate is only configuration-restored until people complete it; a revoked completer is refused', () => {
  const steps = Object.fromEntries(byId('J5').steps.map((step) => [step.step, step]));
  assert.equal(steps.restore.outcome, 'configuration-restored', 'never complete immediately');
  assert.equal(steps['revoked-completer'].outcome, 'refused');
  assert.equal(steps['human-completion'].outcome, 'verified-complete');
});

test('J6: an anonymous identity is refused; reconstruction is read-only and matches the checkpoint', () => {
  const steps = Object.fromEntries(byId('J6').steps.map((step) => [step.step, step]));
  assert.equal(steps['anonymous-identity'].outcome, 'refused');
  assert.deepEqual([steps.reconstruct.outcome, steps.reconstruct.readOnly], ['recovered', true]);
});

// ---------------------------------------- mutation: queued is not verified

test('a journey whose terminal outcome is only a queued action fails, whatever the runner claims', async () => {
  // Same J3 flow, but the owner never puts the setting back: settlement queues a roll back.
  const claim = await runJourney(client, 'J3', ctx);
  const { rows: [settlement] } = await client.query(
    `SELECT seq, record_hash, subject FROM evidence WHERE tenant_ref = $1 AND kind = 'change-intent' AND subject->>'outcome' = 'settled'`,
    [claim.tenantRef],
  );
  assert.equal(settlement.subject.currentState, 'matches-baseline');
  // Forge a still-drifted settlement: a fresh change keeps the resource drifted.
  const drifted = await runJourneyWithoutRevert(claim);
  const verdict = await assessJourney(client, drifted);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((failure) => /not matches-baseline|only/.test(failure)), verdict.failures.join('; '));
  await cancelQueuedJobs();
});

/** J3 variant: the deviation is still live at window end, so the settlement only queues a roll back. */
async function runJourneyWithoutRevert(base) {
  const { rows: [intentRow] } = await client.query(
    `SELECT i.id, i.source_drift_id, d.baseline_id, d.observed_snapshot FROM change_intent i JOIN drift d ON d.id = i.source_drift_id
      WHERE i.tenant_ref = $1`, [base.tenantRef],
  );
  const { createChangeIntent, settleChangeIntents } = await import('../policy/changeIntent.mjs');
  const { rows: [approver] } = await client.query(`SELECT principal_id FROM role_grant WHERE role = 'approver' ORDER BY id DESC LIMIT 1`);
  const { rows: [owner] } = await client.query(`SELECT principal_id FROM role_grant WHERE role = 'operator' ORDER BY id DESC LIMIT 1`);
  const t0 = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const end = new Date(t0.getTime() + 60 * 60 * 1000);
  const intent = await createChangeIntent(client, {
    tenantRef: base.tenantRef, approverPrincipalId: approver.principal_id, ownerPrincipalId: owner.principal_id,
    driftId: intentRow.source_drift_id, fields: ['visibility'], reason: 'second emergency', windowStart: t0, windowEnd: end, now: t0,
  });
  // Re-observe the deviation as current (newest collection + detected drift row).
  const { rows: [snap] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
     SELECT tenant_ref, status, now(), now(), coverage_digest FROM snapshot WHERE id = $1 RETURNING id`, [intentRow.observed_snapshot],
  );
  await client.query(
    `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, hash_version, criticality, blast_radius, fidelity, provenance)
     SELECT $2, natural_key, resource_type, payload, payload_hash, hash_version, criticality, blast_radius, fidelity, provenance
       FROM resource_version WHERE snapshot_id = $1`, [intentRow.observed_snapshot, snap.id],
  );
  await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, before_hash, after_hash, before_payload, after_payload, blast_radius)
     SELECT tenant_ref, baseline_id, $2, natural_key, resource_type, change_type, before_hash, after_hash, before_payload, after_payload, blast_radius
       FROM drift WHERE id = $1`, [intentRow.source_drift_id, snap.id],
  );
  const killSwitchPath = join(workdir, 'never-present');
  const [settled] = await settleChangeIntents(client, { tenantRef: base.tenantRef, now: end, killSwitchPath, intentIds: [intent.id] });
  assert.equal(settled.currentState, 'drifted');
  assert.deepEqual(settled.remediations.map((entry) => entry.outcome), ['queued'], 'only a queued roll back');
  const { rows: [row] } = await client.query(
    `SELECT seq, record_hash FROM evidence WHERE tenant_ref = $1 AND kind = 'change-intent' AND subject->>'intentId' = $2 AND subject->>'outcome' = 'settled'`,
    [base.tenantRef, String(intent.id)],
  );
  const ref = { seq: Number(row.seq), recordHash: row.record_hash };
  return { ...base, terminal: { ref }, links: { ...base.links, intent: { ref: intent.id }, settlement: { ref } } };
}

test('a restore claim whose terminal is the queued restore job, not its verified result, fails', async () => {
  const claim = await runJourney(client, 'J5', ctx);
  const { enqueue } = await import('../jobs/queue.mjs');
  const { rows: [operator] } = await client.query(`SELECT principal_id FROM role_grant WHERE role = 'restorer' ORDER BY id LIMIT 1`);
  const job = await enqueue(client, { kind: 'restore', params: { artifactId: claim.links['restore-artifact'].ref }, requestedBy: operator.principal_id });
  // The runner points the restore-artifact link at the queued job instead of the artifact.
  const forged = { ...claim, links: { ...claim.links, 'restore-artifact': { ref: job.id } } };
  const verdict = await assessJourney(client, forged);
  assert.equal(verdict.ok, false);
  // And a restore that never got past configuration is not complete.
  const { rows: items } = await client.query(
    `SELECT id FROM recovery_completion_item WHERE tenant_ref = $1 AND restore_ref = $2`, [claim.tenantRef, claim.terminal.ref],
  );
  await client.query(`UPDATE recovery_completion_item SET state = 'pending' WHERE id = $1`, [items[0].id]);
  const reopened = await assessJourney(client, claim);
  assert.equal(reopened.ok, false);
  assert.match(reopened.failures.join('; '), /only (configuration-restored|service-validation-pending)/);
  await cancelQueuedJobs();
});

test('a detection job that only reached queued, or failed un-run after revocation, does not pass J2', async () => {
  const claim = await runJourney(client, 'J2', ctx);
  const { enqueue } = await import('../jobs/queue.mjs');
  const { rows: [grant] } = await client.query(`SELECT id, principal_id FROM role_grant WHERE role = 'operator' ORDER BY id DESC LIMIT 1`);
  const queued = await enqueue(client, { kind: 'drift-detect', params: { snapshotId: claim.links.collection.ref, tenantRef: claim.tenantRef }, requestedBy: grant.principal_id });
  const queuedVerdict = await assessJourney(client, { ...claim, links: { ...claim.links, 'detection-job': { ref: queued.id } } });
  assert.equal(queuedVerdict.ok, false);
  assert.match(queuedVerdict.failures.join('; '), /detection-job is only queued/);

  // Revocation between enqueue and execution: the worker fails the job un-run.
  const { claimNext } = await import('../jobs/queue.mjs');
  const { runJob } = await import('../../cli/keel-worker.mjs');
  const { rows: [{ principal_id: revokedId }] } = await client.query(
    `INSERT INTO principal (email) VALUES ('revoked-' || gen_random_uuid() || '@journeys.example') RETURNING id AS principal_id`,
  );
  const { grantRole } = await import('../authz/administration.mjs');
  const revokedGrant = await grantRole(client, { principalId: revokedId, role: 'operator', grantedBy: revokedId });
  await client.query(`UPDATE job SET status = 'cancelled' WHERE id = $1`, [queued.id]);
  const job = await enqueue(client, { kind: 'drift-detect', params: { snapshotId: claim.links.collection.ref, tenantRef: claim.tenantRef }, requestedBy: revokedId });
  await revokeRole(client, { principalId: revokedId, grantId: revokedGrant.id, revokedBy: grant.principal_id });
  const claimed = await claimNext(client, { workerId: 'revocation-check', eventSink: () => {} });
  assert.equal(String(claimed.id), String(job.id));
  await runJob(client, claimed, { dbUrl: database.url, onInFlightChange() {}, eventSink: () => {} });
  const revokedVerdict = await assessJourney(client, { ...claim, links: { ...claim.links, 'detection-job': { ref: job.id } } });
  assert.equal(revokedVerdict.ok, false);
  assert.match(revokedVerdict.failures.join('; '), /detection-job is failed/);
});

// ------------------------------------- mutation: missing evidence link

test('a claim missing a cross-workstream evidence link, or carrying another journey\'s link, fails', async () => {
  const claim = await runJourney(client, 'J4', ctx);
  assert.equal((await assessJourney(client, claim)).ok, true);

  const { 'post-restore-check': dropped, ...rest } = claim.links;
  const missing = await assessJourney(client, { ...claim, links: rest });
  assert.equal(missing.ok, false);
  assert.ok(missing.failures.includes('missing evidence link: post-restore-check'));

  // Another restore's check (a different artifact) breaks the ancestry.
  const other = await runJourney(client, 'J4', ctx);
  const crossed = await assessJourney(client, { ...claim, links: { ...claim.links, 'restore-artifact': other.links['restore-artifact'] } });
  assert.equal(crossed.ok, false);
  assert.ok(crossed.failures.some((failure) => /does not resolve|ancestry/.test(failure)), crossed.failures.join('; '));

  // A tampered record hash does not resolve.
  const tampered = { ...dropped.ref, recordHash: '0'.repeat(64) };
  const forged = await assessJourney(client, { ...claim, links: { ...claim.links, 'post-restore-check': { ref: tampered } } });
  assert.equal(forged.ok, false);

  // Evidence from another tenant does not resolve for this one.
  const foreign = await assessJourney(client, { ...claim, tenantRef: other.tenantRef });
  assert.equal(foreign.ok, false);
});

test('J1 without the observed manual step, or J6 with a checkpoint that does not match, fails', async () => {
  const j1 = await runJourney(client, 'J1', ctx);
  const { 'manual-step-observed': _, ...links } = j1.links;
  assert.equal((await assessJourney(client, { ...j1, links })).ok, false);

  const j6 = await runJourney(client, 'J6', ctx);
  try {
    const wrong = { ...j6.terminal.ref.checkpoint, headHash: 'f'.repeat(64) };
    const verdict = await assessJourney(client, { ...j6, terminal: { ref: { ...j6.terminal.ref, checkpoint: wrong } } });
    assert.equal(verdict.ok, false);
    assert.match(verdict.failures.join('; '), /checkpoint-mismatch/);
  } finally {
    await j6.terminal.ref.result.access?.client.end();
  }
});

test('an evidence chain edited in place fails every journey that links into it', async () => {
  const claim = await runJourney(client, 'J5', ctx);
  assert.equal((await assessJourney(client, claim)).ok, true);
  await client.query(
    `UPDATE evidence SET subject = jsonb_set(subject, '{note}', '"edited"') WHERE tenant_ref = $1 AND seq = (SELECT min(seq) FROM evidence WHERE tenant_ref = $1)`,
    [claim.tenantRef],
  );
  const verdict = await assessJourney(client, claim);
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join('; '), /evidence chain broken/);
});

// ---------------------------------------------------------------- ledger

const HMAC_KEY = 'task-112-fixture-key-not-a-secret';

function passingFixture() {
  return journeyFixtureRecord(JOURNEYS.map((journey) => ({
    journey: journey.id, title: journey.title, owners: journey.owners, ok: true, terminalState: 'verified', failures: [], links: {},
  })));
}

test('the checked-in qualification records keep readiness pending and report fixtures separately', () => {
  const live = loadLiveRecords();
  const ledger = buildReleaseLedger({ fixture: journeyFixtureRecord(results), live, hmacKey: null });
  assert.equal(ledger.readiness.label, 'pending');
  assert.notEqual(ledger.readiness.label, 'ready');
  assert.equal(ledger.fixture.evidenceLevel, 'fixture-tested');
  assert.ok(ledger.fixture.journeys.every((journey) => journey.outcome === 'passed'));
  // Every required live gate is listed, none is qualified, and pending stays pending.
  assert.deepEqual(ledger.live.map((gate) => gate.task).sort(), LIVE_ACCEPTANCE_GATES.map((gate) => gate.task).sort());
  assert.ok(ledger.live.every((gate) => gate.status !== 'live-qualified'), JSON.stringify(ledger.live));
  assert.ok(ledger.live.filter((gate) => gate.status === 'pending').length >= 9);
  // Task-123's record is a pending placeholder once it lands; before that it is missing. Neither qualifies.
  assert.ok(['missing', 'pending'].includes(ledger.live.find((gate) => gate.gate === 'onedrive-purview-live-acceptance').status));
  // Fixture results never stand in for a live record.
  assert.ok(ledger.readiness.reasons.some((reason) => /deployed-acceptance/.test(reason)));
});

test('mutation check: release is never ready while any qualification is unknown', () => {
  const live = LIVE_ACCEPTANCE_GATES.map((gate) => ({ gate: gate.gate, task: gate.task, status: 'live-qualified', failures: [] }));
  const allQualified = buildReleaseLedger({ fixture: passingFixture(), live, hmacKey: null, objectiveGapsAllowed: true });
  assert.equal(allQualified.readiness.label, 'ready', 'the ready label exists only when everything qualifies');

  for (const status of ['missing', 'pending', 'unverified']) {
    const unknown = live.map((entry, index) => (index === 0 ? { ...entry, status } : entry));
    const ledger = buildReleaseLedger({ fixture: passingFixture(), live: unknown, hmacKey: null, objectiveGapsAllowed: true });
    assert.equal(ledger.readiness.label, 'pending', status);
  }
  // A gate absent from the supplied records is unknown, not qualified.
  const ledger = buildReleaseLedger({ fixture: passingFixture(), live: live.slice(1), hmacKey: null, objectiveGapsAllowed: true });
  assert.equal(ledger.readiness.label, 'pending');
  // No fixture record at all is unknown too.
  assert.equal(buildReleaseLedger({ fixture: null, live, hmacKey: null, objectiveGapsAllowed: true }).readiness.label, 'pending');
  // Objective gaps also keep it pending unless explicitly reported as accepted gaps by the caller.
  assert.equal(buildReleaseLedger({ fixture: passingFixture(), live, hmacKey: null }).readiness.label, 'pending');
});

test('one failed critical gate blocks the ready label but leaves every other result reported', () => {
  const live = LIVE_ACCEPTANCE_GATES.map((gate) => ({ gate: gate.gate, task: gate.task, status: 'live-qualified', failures: [] }));
  live[2] = { ...live[2], status: 'failed', failures: ['runner signature mismatch'] };
  const ledger = buildReleaseLedger({ fixture: passingFixture(), live, hmacKey: null, objectiveGapsAllowed: true });
  assert.equal(ledger.readiness.label, 'blocked');
  assert.equal(ledger.live.filter((gate) => gate.status === 'live-qualified').length, live.length - 1, 'independent results stay reported');
  assert.ok(ledger.fixture.journeys.every((journey) => journey.outcome === 'passed'), 'fixture development is not blocked');
  assert.ok(ledger.readiness.reasons.some((reason) => reason.includes(live[2].gate)));

  const failedJourney = passingFixture();
  failedJourney.journeys[3] = { ...failedJourney.journeys[3], outcome: 'failed', failures: ['terminal outcome is only queued'] };
  const withFailedJourney = buildReleaseLedger({ fixture: failedJourney, live: live.map((entry) => ({ ...entry, status: 'live-qualified' })), hmacKey: null, objectiveGapsAllowed: true });
  assert.equal(withFailedJourney.readiness.label, 'blocked');
});

test('a pending or synthetic record never classifies as live-qualified; a signed live record verifies only with its key', () => {
  const dir = mkdtempSync(join(workdir, 'records-'));
  const pending = { gate: 'deployed-acceptance', status: 'pending', evidenceLevel: 'fixture-tested', synthetic: true };
  assert.equal(classifyLiveRecord({ gate: 'deployed-acceptance' }, pending, { hmacKey: HMAC_KEY }).status, 'pending');
  assert.equal(classifyLiveRecord({ gate: 'deployed-acceptance' }, null, { hmacKey: HMAC_KEY }).status, 'missing');

  // A well-formed fixture record signed by the fixture runner is refused by --require-live.
  const fixtureRecord = signEvidence({
    contractVersion: 1, gate: 'storage-live-acceptance', tenantRef: 'sha256:x', build: 'b', operation: 'o', credentialMode: 'c',
    observedAt: new Date().toISOString(), evidenceLevel: 'fixture-tested', synthetic: true, subject: {},
  }, HMAC_KEY, 'keel-fixture-runner');
  writeFileSync(join(dir, 'storage.json'), JSON.stringify(fixtureRecord));
  const classified = classifyLiveRecord({ gate: 'storage-live-acceptance' }, fixtureRecord, { hmacKey: HMAC_KEY, tenantRef: 'sha256:x', build: 'b', evidenceDir: dir });
  assert.equal(classified.status, 'failed');
  assert.ok(classified.failures.some((failure) => /require-live/.test(failure)));
  // Without the verification key nothing can be confirmed live.
  assert.equal(classifyLiveRecord({ gate: 'storage-live-acceptance' }, { ...fixtureRecord, synthetic: false, evidenceLevel: 'live-qualified' }, { hmacKey: null }).status, 'unverified');
});

test('every D1-D10 and G1-G8 objective maps to an owner, test and evidence, or an explicit qualification gap', () => {
  const ids = RELEASE_OBJECTIVES.map((objective) => objective.id);
  assert.deepEqual(ids, [...Array.from({ length: 10 }, (_, i) => `D${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `G${i + 1}`)]);
  const ledger = buildReleaseLedger({ fixture: journeyFixtureRecord(results), live: loadLiveRecords(), hmacKey: null });
  for (const objective of ledger.objectives) {
    const mapped = objective.owners.length > 0 && objective.tests.length > 0 && objective.evidence.length > 0;
    assert.ok(mapped || objective.gap, `${objective.id} is neither mapped nor an explicit gap`);
    if (objective.status === 'qualified') assert.equal(objective.gap, null);
    for (const test of objective.tests) assert.ok(readFileSync(new URL(`../../${test}`, import.meta.url)), `${objective.id}: ${test} exists`);
  }
  // A gap is never reported as qualified, and a pending live gate keeps its objective open.
  assert.ok(ledger.objectives.every((objective) => objective.status !== 'qualified'), 'nothing is live-qualified today');
  const d6 = ledger.objectives.find((objective) => objective.id === 'D6');
  assert.equal(d6.status, 'pending');
  assert.ok(d6.evidence.includes('servicenow-live-acceptance'));
});
