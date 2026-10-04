/**
 * Roadmap task-100 boundary tests: verified outcome and executive value reporting.
 * Exercises the production engine/reports/value.mjs reader and
 * cli/keel-value-report.mjs against the isolated test database, with real restore
 * plans, jobs, write-journal rows, completion items, detected changes, collections,
 * control evaluations, ownership evidence and the evidence chain.
 *
 * Required mutation checks:
 * - Count enqueue as verified repair.
 * - Count retry as new outcome.
 * - Invent fixed hours per event.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { main as valueReportCli } from '../../cli/keel-value-report.mjs';
import { appendEvidence } from '../govern/evidence.mjs';
import {
  COUNTING_RULES, MAX_PERIOD_DAYS, OUTCOME_STATES, classifyChangeRemediation, classifyControlFinding,
  classifyRestoreOutcome, estimateHours, loadValueReport, readEstimate, reportPeriod, summarizeOutcomes,
  valueReportCsv,
} from '../reports/value.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const NOW = new Date('2026-10-03T12:00:00.000Z');
const FROM = new Date('2026-09-03T12:00:00.000Z');
const silent = () => {};

let database;
let client;

before(async () => {
  database = await createIsolatedTestDatabase(import.meta.url);
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

const ok = (count = 1) => ({ outcome: 'complete', itemCount: count });

async function snapshot(tenantRef, { completedAt, digest = { group: ok(), user: ok() } }) {
  const { rows: [row] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
     VALUES ($1, $2::timestamptz - interval '5 minutes', $2, 'complete', $3) RETURNING id`,
    [tenantRef, completedAt, digest],
  );
  return row.id;
}

async function version(snapshotId, { naturalKey, resourceType = 'group', hash, hashVersion = 1 }) {
  const { rows: [row] } = await client.query(
    `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, hash_version,
       criticality, blast_radius, fidelity, provenance)
     VALUES ($1, $2, $3, '{}', $4, $5, 'normal', 'local', 'full', '{}') RETURNING id`,
    [snapshotId, naturalKey, resourceType, hash, hashVersion],
  );
  return row.id;
}

async function plan(tenantRef, { closureKeys = ['group:finance'], undo = false, snapshotId = null } = {}) {
  const source = snapshotId ?? await snapshot(tenantRef, { completedAt: '2026-08-01T00:00:00Z' });
  const { rows: [row] } = await client.query(
    `INSERT INTO restore_dry_run (tenant_ref, snapshot_id, selection, closure_keys, target_tenant_id, collector_config_path,
       target_config_path, waves, patches, results, current_state_fingerprint, digest, status, requested_by, compensation)
     VALUES ($1, $2, '[]', $3, 'fixture', '/c', '/t', '[]', '[]', '[]', 'f', 'd', 'completed', 'operator', $4) RETURNING id`,
    [tenantRef, source, JSON.stringify(closureKeys), undo ? { compensates: 'x' } : null],
  );
  return { planId: row.id, snapshotId: source };
}

async function job(kind, { params, status, createdAt, startedAt = createdAt, finishedAt = null }) {
  const { rows: [row] } = await client.query(
    `INSERT INTO job (kind, params, status, requested_by, created_at, started_at, finished_at)
     VALUES ($1, $2, $3, 'operator', $4, $5, $6) RETURNING id`,
    [kind, params, status, createdAt, ['queued'].includes(status) ? null : startedAt, finishedAt],
  );
  return row.id;
}

const restoreJob = (planId, options) => job('restore', { params: { artifactId: planId, mode: 'enforce' }, ...options });
const remediateJob = (driftIds, options) => job('remediate', { params: { driftIds }, ...options });

async function journal(planId, { naturalKey = 'group:finance', outcome, at }) {
  await client.query(
    `INSERT INTO rollback_entry (run_id, natural_key, prior_state, restore_ref, resource_type, operation, outcome, outcome_at, recorded_at)
     VALUES ('run', $1, '{}', $2, 'group', 'update', $3, $4, $4)`,
    [naturalKey, planId, outcome, at],
  );
}

async function completionItem(tenantRef, planId, { state = 'pending', closedAt = null } = {}) {
  await client.query(
    `INSERT INTO recovery_completion_item (tenant_ref, restore_ref, natural_key, resource_type, mechanism, kind, requirement, description, state, closed_at, created_at)
     VALUES ($1, $2, 'group:finance', 'group', 'update', 'service-validation', $3, 'check', $4, $5, '2026-09-01T00:00:00Z')`,
    [tenantRef, planId, `validate-${Math.random()}`, state, closedAt],
  );
}

/** A baseline holding one resource, and a detected change of it. */
async function change(tenantRef, { naturalKey, changeType = 'modified', baselineHash = 'base', detectedAt = '2026-09-10T00:00:00Z', resourceType = 'group', digest }) {
  const source = await snapshot(tenantRef, { completedAt: '2026-08-15T00:00:00Z' });
  const baselineVersion = await version(source, { naturalKey, resourceType, hash: baselineHash });
  const { rows: [baseline] } = await client.query(
    `INSERT INTO baseline (tenant_ref, set_by, active) VALUES ($1, 'operator', false) RETURNING id`,
    [tenantRef],
  );
  if (changeType !== 'added') {
    await client.query('INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) VALUES ($1, $2, $3)', [baseline.id, naturalKey, baselineVersion]);
  }
  const observed = await snapshot(tenantRef, { completedAt: detectedAt, digest });
  const { rows: [row] } = await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, before_hash, after_hash, blast_radius, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'drifted', 'local', $8) RETURNING id`,
    [tenantRef, baseline.id, observed, naturalKey, resourceType, changeType, changeType === 'added' ? null : baselineHash, detectedAt],
  );
  return row.id;
}

async function evaluation(tenantRef, { controlId, verdict, at, edition = '1.0.0', evaluatorVersion = 1 }) {
  const { rows: [row] } = await client.query(
    `INSERT INTO benchmark_evaluation (tenant_ref, control_id, framework, edition, profile, evaluator_version, verdict, evaluated_at)
     VALUES ($1, $2, 'keel-custom', $3, 'default', $4, $5, $6) RETURNING id`,
    [tenantRef, controlId, edition, evaluatorVersion, verdict, at],
  );
  return row.id;
}

function report(tenantRef, options = {}) {
  return loadValueReport(client, { tenantRef, from: FROM, to: NOW, now: NOW, requiredTypes: ['group'], ...options });
}

function assertConsistent(summary) {
  const sum = OUTCOME_STATES.reduce((total, state) => total + summary.states[state], 0);
  assert.equal(sum, summary.total, 'states add up to the total');
  assert.equal(summary.retries, summary.attempts - summary.total, 'retries are attempts beyond one per outcome');
  assert.ok(summary.retries >= 0);
  if (summary.total === 0) assert.equal(summary.percentVerified, null);
  else assert.equal(summary.percentVerified, Math.round((summary.states.verified / summary.total) * 1000) / 10);
}

test('a retried restore and a retried remediation each count once', async () => {
  const tenantRef = 'sha256:value-retry';
  // Restore plan: the first job failed, the retry succeeded and was verified.
  const { planId } = await plan(tenantRef);
  await restoreJob(planId, { status: 'failed', createdAt: '2026-09-20T10:00:00Z', finishedAt: '2026-09-20T10:01:00Z' });
  await journal(planId, { outcome: 'failed', at: '2026-09-20T10:00:30Z' });
  await restoreJob(planId, { status: 'succeeded', createdAt: '2026-09-20T11:00:00Z', finishedAt: '2026-09-20T11:02:00Z' });
  // The retry wrote the same resource again, and read it back: the newer row decides.
  await journal(planId, { outcome: 'succeeded', at: '2026-09-20T11:01:00Z' });
  await completionItem(tenantRef, planId, { state: 'verified', closedAt: '2026-09-20T11:30:00Z' });

  // Remediation: one change, two remediate jobs (the first failed), then a collection
  // shows the resource back at its baseline value.
  const driftId = await change(tenantRef, { naturalKey: 'group:sales' });
  await remediateJob([driftId], { status: 'failed', createdAt: '2026-09-21T09:00:00Z', finishedAt: '2026-09-21T09:00:10Z' });
  await remediateJob([driftId], { status: 'succeeded', createdAt: '2026-09-21T10:00:00Z', finishedAt: '2026-09-21T10:05:00Z' });
  const later = await snapshot(tenantRef, { completedAt: '2026-09-22T00:00:00Z' });
  await version(later, { naturalKey: 'group:sales', hash: 'base' });

  const value = await report(tenantRef);
  assert.equal(value.outcomes.total, 2, 'two outcomes, not four jobs');
  assert.equal(value.outcomes.states.verified, 2);
  assert.equal(value.outcomes.attempts, 4);
  assert.equal(value.outcomes.retries, 2);
  assertConsistent(value.outcomes);
  const restoreRow = value.outcomes.rows.find((row) => row.family === 'restore');
  assert.equal(restoreRow.id, `restore-plan:${planId}`);
  assert.equal(restoreRow.attempts, 2);
  assert.equal(restoreRow.retries, 1);
  assert.equal(restoreRow.verifiedAt, '2026-09-20T11:30:00.000Z', 'verified when the last completion item closed');
  assert.ok(restoreRow.attemptEventIds.every((id) => id.startsWith('job:')), 'attempts carry their canonical correlation ids');
  const changeRow = value.outcomes.rows.find((row) => row.family === 'remediation');
  assert.equal(changeRow.id, `change:${driftId}`);
  assert.equal(changeRow.verifiedAt, '2026-09-22T00:00:00.000Z');

  // A job re-claimed after an orphan reset is the same row, so the same attempt.
  const pure = classifyRestoreOutcome({
    planId: 'p',
    jobs: [
      { id: 'j1', kind: 'restore', status: 'succeeded', created_at: '2026-09-01T00:00:00Z', finished_at: '2026-09-01T00:01:00Z' },
      { id: 'j1', kind: 'restore', status: 'succeeded', created_at: '2026-09-01T00:00:00Z', finished_at: '2026-09-01T00:01:00Z' },
    ],
    journal: [{ id: 'e1', natural_key: 'k', outcome: 'succeeded', recorded_at: '2026-09-01T00:00:30Z' }],
    to: NOW,
  });
  assert.equal(pure.attempts.length, 1);
  assert.equal(summarizeOutcomes([pure, pure].slice(0, 1)).total, 1);

  // One remediate job covering two changes is two outcomes from one attempt each.
  const a = await change(tenantRef, { naturalKey: 'group:a' });
  const b = await change(tenantRef, { naturalKey: 'group:b' });
  await remediateJob([a, b], { status: 'failed', createdAt: '2026-09-25T00:00:00Z', finishedAt: '2026-09-25T00:00:05Z' });
  const both = await report(tenantRef);
  assert.equal(both.outcomes.total, 4);
  assert.equal(both.outcomes.states.failed, 2);
  assert.equal(both.outcomes.attempts, 6);
  assertConsistent(both.outcomes);
});

test('queued, running, failed and unconfirmed jobs never inflate verified outcomes', async () => {
  const tenantRef = 'sha256:value-unverified';
  // Restore plans that never reach verified.
  const queued = (await plan(tenantRef)).planId;
  await restoreJob(queued, { status: 'queued', createdAt: '2026-09-10T00:00:00Z' });
  const running = (await plan(tenantRef)).planId;
  await restoreJob(running, { status: 'running', createdAt: '2026-09-10T01:00:00Z' });
  const failed = (await plan(tenantRef)).planId;
  await restoreJob(failed, { status: 'failed', createdAt: '2026-09-10T02:00:00Z', finishedAt: '2026-09-10T02:01:00Z' });
  const cancelled = (await plan(tenantRef)).planId;
  await restoreJob(cancelled, { status: 'cancelled', createdAt: '2026-09-10T03:00:00Z', finishedAt: '2026-09-10T03:00:01Z' });
  const uncertain = (await plan(tenantRef)).planId;
  await restoreJob(uncertain, { status: 'succeeded', createdAt: '2026-09-10T04:00:00Z', finishedAt: '2026-09-10T04:01:00Z' });
  await journal(uncertain, { outcome: 'uncertain', at: '2026-09-10T04:00:30Z' });
  const unrecorded = (await plan(tenantRef)).planId;
  await restoreJob(unrecorded, { status: 'succeeded', createdAt: '2026-09-10T05:00:00Z', finishedAt: '2026-09-10T05:01:00Z' });
  const awaiting = (await plan(tenantRef)).planId;
  await restoreJob(awaiting, { status: 'succeeded', createdAt: '2026-09-10T06:00:00Z', finishedAt: '2026-09-10T06:01:00Z' });
  await journal(awaiting, { outcome: 'succeeded', at: '2026-09-10T06:00:30Z' });
  await completionItem(tenantRef, awaiting);
  // A dry-run job (not an enforced restore) and an undo run are not outcomes.
  const dry = (await plan(tenantRef)).planId;
  await job('restore', { params: { artifactId: dry, mode: 'dry-run' }, status: 'succeeded', createdAt: '2026-09-10T07:00:00Z', finishedAt: '2026-09-10T07:00:01Z' });
  const undo = (await plan(tenantRef, { undo: true })).planId;
  await restoreJob(undo, { status: 'succeeded', createdAt: '2026-09-10T08:00:00Z', finishedAt: '2026-09-10T08:00:01Z' });
  await journal(undo, { outcome: 'succeeded', at: '2026-09-10T08:00:00.5Z' });

  // Remediations that never reach verified.
  const queuedChange = await change(tenantRef, { naturalKey: 'group:q' });
  await remediateJob([queuedChange], { status: 'queued', createdAt: '2026-09-11T00:00:00Z' });
  // These two live in their own tenant so their collections stay apart from the rest.
  const lateTenant = 'sha256:value-unverified-late';
  // (That collection read users only, so it says nothing about group:early below.)
  const noCollection = await change(lateTenant, { naturalKey: 'group:none', detectedAt: '2026-10-03T10:00:00Z', digest: { user: ok() } });
  await remediateJob([noCollection], { status: 'succeeded', createdAt: '2026-10-03T10:10:00Z', finishedAt: '2026-10-03T10:20:00Z' });
  const stillDiffers = await change(tenantRef, { naturalKey: 'group:still' });
  await remediateJob([stillDiffers], { status: 'succeeded', createdAt: '2026-09-12T00:00:00Z', finishedAt: '2026-09-12T00:05:00Z' });
  const otherHash = await change(tenantRef, { naturalKey: 'group:rehashed' });
  await remediateJob([otherHash], { status: 'succeeded', createdAt: '2026-09-12T01:00:00Z', finishedAt: '2026-09-12T01:05:00Z' });
  const added = await change(tenantRef, { naturalKey: 'user:new', resourceType: 'user', changeType: 'added' });
  await remediateJob([added], { status: 'succeeded', createdAt: '2026-09-12T02:00:00Z', finishedAt: '2026-09-12T02:05:00Z' });
  // The collection after them: still drifted, hashed under another version, and the
  // added user absent but users were not read completely.
  const after = await snapshot(tenantRef, { completedAt: '2026-09-13T00:00:00Z', digest: { group: ok(), user: { outcome: 'partial', itemCount: 1 } } });
  await version(after, { naturalKey: 'group:still', hash: 'drifted' });
  await version(after, { naturalKey: 'group:rehashed', hash: 'base', hashVersion: 2 });
  // A collection BEFORE the remediation finished cannot verify it.
  const tooEarly = await change(lateTenant, { naturalKey: 'group:early', detectedAt: '2026-09-14T00:00:00Z' });
  const early = await snapshot(lateTenant, { completedAt: '2026-09-14T12:00:00Z' });
  await version(early, { naturalKey: 'group:early', hash: 'base' });
  await remediateJob([tooEarly], { status: 'succeeded', createdAt: '2026-09-14T13:00:00Z', finishedAt: '2026-09-14T13:05:00Z' });

  const value = await report(tenantRef);
  const late = await report(lateTenant);
  assert.equal(value.outcomes.states.verified + late.outcomes.states.verified, 0, 'nothing here was verified');
  assert.equal(value.outcomes.total, 11);
  assert.equal(value.outcomes.states.queued, 3);
  assert.equal(value.outcomes.states.failed, 2);
  assert.equal(value.outcomes.states.unconfirmed, 6);
  assert.equal(late.outcomes.states.unconfirmed, 2);
  assert.equal(value.outcomes.undoRunsExcluded, 1);
  assert.equal(value.outcomes.percentVerified, 0);
  assertConsistent(value.outcomes);
  assertConsistent(late.outcomes);
  const reasons = [...value.outcomes.rows, ...late.outcomes.rows].map((row) => row.reason).sort();
  assert.deepEqual(reasons, [
    'all-attempts-failed', 'all-attempts-failed', 'attempt-pending', 'attempt-pending', 'attempt-pending',
    'collection-still-differs', 'completion-pending', 'no-later-collection', 'no-later-collection', 'no-later-collection',
    'no-later-collection', 'no-write-record', 'write-not-confirmed',
  ]);

  // The pure classifier: a queued job alone is never a verified repair, whatever the
  // journal says.
  const pure = classifyRestoreOutcome({
    planId: 'p',
    jobs: [{ id: 'q', kind: 'restore', status: 'queued', created_at: '2026-09-01T00:00:00Z' }],
    journal: [{ id: 'e', natural_key: 'k', outcome: 'succeeded', recorded_at: '2026-09-01T00:00:01Z' }],
    to: NOW,
  });
  assert.equal(pure.state, 'queued');
  const pureChange = classifyChangeRemediation({
    driftId: 'd',
    jobs: [{ id: 'q', kind: 'remediate', status: 'queued', created_at: '2026-09-01T00:00:00Z' }],
    observations: [{ snapshotId: 's', completedAt: '2026-09-02T00:00:00Z', verdict: 'matches' }],
    to: NOW,
  });
  assert.equal(pureChange.state, 'queued', 'a collection that happens to match does not verify a queued job');
  // A job that finished only after the period ended was still running at its end.
  const lateJob = classifyRestoreOutcome({
    planId: 'p',
    jobs: [{ id: 'l', kind: 'restore', status: 'succeeded', created_at: '2026-10-03T11:00:00Z', finished_at: '2026-10-04T00:00:00Z' }],
    journal: [{ id: 'e', natural_key: 'k', outcome: 'succeeded', recorded_at: '2026-10-03T11:30:00Z' }],
    to: NOW,
  });
  assert.equal(lateJob.state, 'queued');
});

test('a reopened change or finding is not permanently closed', async () => {
  const tenantRef = 'sha256:value-reopened';
  const driftId = await change(tenantRef, { naturalKey: 'group:ops' });
  await remediateJob([driftId], { status: 'succeeded', createdAt: '2026-09-15T00:00:00Z', finishedAt: '2026-09-15T00:05:00Z' });
  const fixed = await snapshot(tenantRef, { completedAt: '2026-09-16T00:00:00Z' });
  await version(fixed, { naturalKey: 'group:ops', hash: 'base' });
  let value = await report(tenantRef);
  assert.equal(value.outcomes.states.verified, 1);

  // A later collection shows it changed again.
  const again = await snapshot(tenantRef, { completedAt: '2026-09-20T00:00:00Z' });
  await version(again, { naturalKey: 'group:ops', hash: 'drifted-again' });
  value = await report(tenantRef);
  assert.equal(value.outcomes.states.verified, 0);
  assert.equal(value.outcomes.states.reopened, 1);
  assert.equal(value.outcomes.rows[0].reopenedAt, '2026-09-20T00:00:00.000Z');
  // ...and a report that ended before the change came back still shows it verified then.
  const earlier = await loadValueReport(client, { tenantRef, from: FROM, to: new Date('2026-09-18T00:00:00Z'), now: NOW, requiredTypes: ['group'] });
  assert.equal(earlier.outcomes.states.verified, 1);

  // Control findings: fail, pass, fail again is open and reopened, not resolved.
  await evaluation(tenantRef, { controlId: 'mfa', verdict: 'fail', at: '2026-09-05T00:00:00Z' });
  await evaluation(tenantRef, { controlId: 'mfa', verdict: 'pass', at: '2026-09-10T00:00:00Z' });
  await evaluation(tenantRef, { controlId: 'mfa', verdict: 'pass', at: '2026-09-11T00:00:00Z' });
  await evaluation(tenantRef, { controlId: 'mfa', verdict: 'fail', at: '2026-09-25T00:00:00Z' });
  // Fail then pass, twice passing: one resolution, by the first passing evaluation.
  await evaluation(tenantRef, { controlId: 'owners', verdict: 'fail', at: '2026-09-05T00:00:00Z' });
  const resolving = await evaluation(tenantRef, { controlId: 'owners', verdict: 'pass', at: '2026-09-12T00:00:00Z' });
  await evaluation(tenantRef, { controlId: 'owners', verdict: 'pass', at: '2026-09-19T00:00:00Z' });
  // Fail, then the evaluator could not decide: unchecked, not resolved.
  await evaluation(tenantRef, { controlId: 'guests', verdict: 'fail', at: '2026-09-05T00:00:00Z' });
  await evaluation(tenantRef, { controlId: 'guests', verdict: 'unknown', at: '2026-09-15T00:00:00Z' });
  // A fail under one edition and a pass under the next is not a fix.
  await evaluation(tenantRef, { controlId: 'legacy', verdict: 'fail', at: '2026-09-05T00:00:00Z', edition: '1.0.0' });
  await evaluation(tenantRef, { controlId: 'legacy', verdict: 'pass', at: '2026-09-15T00:00:00Z', edition: '2.0.0' });
  // Always passing is not a finding at all.
  await evaluation(tenantRef, { controlId: 'clean', verdict: 'pass', at: '2026-09-05T00:00:00Z' });
  // Resolved before the period: belongs to an earlier report.
  await evaluation(tenantRef, { controlId: 'old', verdict: 'fail', at: '2026-07-01T00:00:00Z' });
  await evaluation(tenantRef, { controlId: 'old', verdict: 'pass', at: '2026-07-02T00:00:00Z' });

  value = await report(tenantRef);
  const { findings } = value;
  assert.equal(findings.withheld, false);
  assert.equal(findings.total, 4);
  assert.deepEqual(findings.states, { resolved: 1, open: 2, unchecked: 1 });
  assert.equal(findings.reopened, 1);
  assert.equal(findings.percentResolved, 25);
  const mfa = findings.rows.find((row) => row.controlId === 'mfa');
  assert.equal(mfa.state, 'open');
  assert.equal(mfa.reopened, true);
  const owners = findings.rows.find((row) => row.controlId === 'owners');
  assert.equal(owners.resolvedBy.evaluationId, resolving, 'the resolving evaluation is the canonical identity');
  assert.equal(owners.resolvedAt, '2026-09-12T00:00:00.000Z');
  const legacy = findings.rows.find((row) => row.controlId === 'legacy');
  assert.equal(legacy.state, 'open', 'the old edition still fails; the new one never failed');

  // The pure classifier: pass after reopen resolves again, once.
  const finding = classifyControlFinding([
    { id: '1', control_id: 'c', framework: 'f', edition: 'e', profile: 'p', evaluator_version: 1, verdict: 'fail', evaluated_at: '2026-09-01T00:00:00Z' },
    { id: '2', control_id: 'c', framework: 'f', edition: 'e', profile: 'p', evaluator_version: 1, verdict: 'pass', evaluated_at: '2026-09-02T00:00:00Z' },
    { id: '3', control_id: 'c', framework: 'f', edition: 'e', profile: 'p', evaluator_version: 1, verdict: 'fail', evaluated_at: '2026-09-03T00:00:00Z' },
  ], { to: NOW });
  assert.equal(finding.state, 'open');
  assert.equal(finding.reopened, true);
  assert.equal(finding.resolvedBy, null);
});

test('without a configured estimate there are no hours; with one, only verified outcomes count', async () => {
  const tenantRef = 'sha256:value-estimate';
  const { planId } = await plan(tenantRef);
  await restoreJob(planId, { status: 'succeeded', createdAt: '2026-09-20T10:00:00Z', finishedAt: '2026-09-20T10:01:00Z' });
  await journal(planId, { outcome: 'succeeded', at: '2026-09-20T10:00:30Z' });
  // Plenty of attempts that verified nothing.
  for (let i = 0; i < 5; i += 1) {
    const other = (await plan(tenantRef)).planId;
    await restoreJob(other, { status: 'failed', createdAt: `2026-09-21T0${i}:00:00Z`, finishedAt: `2026-09-21T0${i}:01:00Z` });
  }

  const none = await report(tenantRef);
  assert.equal(none.hoursSaved, null);
  assert.equal(none.estimate.state, 'not-configured');
  assert.doesNotMatch(JSON.stringify(none), /"hours"/);
  assert.doesNotMatch(valueReportCsv(none), /hours/);
  assert.equal(estimateHours(readEstimate(null), { restore: 6 }), null, 'no estimate, no figure');

  // An estimate without written assumptions, an owner or valid minutes is not used.
  for (const raw of [
    { minutesPerVerifiedOutcome: { restore: 60 }, owner: 'ops lead' },
    { minutesPerVerifiedOutcome: { restore: 60 }, assumptions: ['  '], owner: 'ops lead' },
    { minutesPerVerifiedOutcome: { restore: 60 }, assumptions: ['manual restore takes an hour'] },
    { minutesPerVerifiedOutcome: { restore: -5 }, assumptions: ['x'], owner: 'ops lead' },
    { minutesPerVerifiedOutcome: {}, assumptions: ['x'], owner: 'ops lead' },
    { minutesPerVerifiedOutcome: { everything: 60 }, assumptions: ['x'], owner: 'ops lead' },
  ]) {
    const invalid = await report(tenantRef, { estimate: raw });
    assert.equal(invalid.hoursSaved, null, JSON.stringify(raw));
    assert.equal(invalid.estimate.state, 'invalid');
    assert.ok(invalid.estimate.problems.length > 0);
  }

  const estimate = {
    minutesPerVerifiedOutcome: { restore: 90, finding: 30 },
    assumptions: ['A manual restore of one group takes about 90 minutes.', 'Figures are the IT lead\'s estimate, not measured.'],
    owner: 'IT lead',
    setAt: '2026-09-01T00:00:00Z',
  };
  const configured = await report(tenantRef, { estimate, estimateSource: '/etc/keel/value-estimate.json' });
  assert.equal(configured.outcomes.total, 6);
  assert.equal(configured.outcomes.states.verified, 1);
  assert.equal(configured.hoursSaved.hours, 1.5, 'one verified restore at 90 minutes; failed attempts add nothing');
  assert.deepEqual(configured.hoursSaved.assumptions, estimate.assumptions);
  assert.equal(configured.hoursSaved.owner, 'IT lead');
  assert.deepEqual(configured.hoursSaved.notEstimated, ['remediation']);
  assert.equal(configured.hoursSaved.basis, 'verified-outcomes-only');
  const csv = valueReportCsv(configured);
  assert.match(csv, /# hours_saved_estimate,1.5/);
  assert.match(csv, /# estimate_assumption,A manual restore of one group takes about 90 minutes\./);
});

test('totals, percentages and periods stay consistent, and every export carries provenance', async () => {
  const tenantRef = 'sha256:value-consistent';
  await appendEvidence(client, { tenantRef, kind: 'fixture', subject: { n: 1 }, actor: 'test', eventSink: silent });
  // Verified in August (previous period) and in September (this period).
  const august = (await plan(tenantRef)).planId;
  await restoreJob(august, { status: 'succeeded', createdAt: '2026-08-20T00:00:00Z', finishedAt: '2026-08-20T00:01:00Z' });
  await journal(august, { outcome: 'succeeded', at: '2026-08-20T00:00:30Z' });
  const september = (await plan(tenantRef)).planId;
  await restoreJob(september, { status: 'succeeded', createdAt: '2026-09-20T00:00:00Z', finishedAt: '2026-09-20T00:01:00Z' });
  await journal(september, { outcome: 'succeeded', at: '2026-09-20T00:00:30Z' });
  const pending = (await plan(tenantRef)).planId;
  await restoreJob(pending, { status: 'queued', createdAt: '2026-07-01T00:00:00Z' });
  const oldFailure = (await plan(tenantRef)).planId;
  await restoreJob(oldFailure, { status: 'failed', createdAt: '2026-07-01T00:00:00Z', finishedAt: '2026-07-01T00:00:01Z' });
  // Another tenant's verified work never joins.
  const foreign = (await plan('sha256:value-foreign')).planId;
  await restoreJob(foreign, { status: 'succeeded', createdAt: '2026-09-20T00:00:00Z', finishedAt: '2026-09-20T00:01:00Z' });
  await journal(foreign, { outcome: 'succeeded', at: '2026-09-20T00:00:30Z' });

  const current = await report(tenantRef);
  assert.equal(current.outcomes.total, 2, 'September verified + still-queued; the August result and July failure belong to earlier periods');
  assert.equal(current.outcomes.states.verified, 1);
  assert.equal(current.outcomes.states.queued, 1);
  assert.equal(current.outcomes.percentVerified, 50);
  assertConsistent(current.outcomes);
  for (const family of ['restore', 'remediation']) assertConsistent(current.outcomes.byFamily[family]);
  assert.equal(current.outcomes.byFamily.restore.total + current.outcomes.byFamily.remediation.total, current.outcomes.total);
  assert.equal(current.outcomes.byFamily.restore.attempts + current.outcomes.byFamily.remediation.attempts, current.outcomes.attempts);

  // Adjacent periods: each verified outcome counts in exactly one of them.
  const previous = await loadValueReport(client, { tenantRef, from: new Date('2026-08-04T12:00:00Z'), to: FROM, now: NOW, requiredTypes: ['group'] });
  assert.equal(previous.outcomes.states.verified + current.outcomes.states.verified, 2);

  // Provenance: period, scope, rules, the evidence chain head and a stable digest.
  assert.equal(current.period.from, FROM.toISOString());
  assert.equal(current.period.to, NOW.toISOString());
  assert.deepEqual(current.scope, { central: true, entities: [] });
  assert.deepEqual(current.provenance.countingRules, COUNTING_RULES);
  assert.equal(current.provenance.complete, true);
  assert.ok(current.provenance.evidenceHead.hash.match(/^[0-9a-f]{64}$/));
  assert.match(current.provenance.digest, /^[0-9a-f]{64}$/);
  assert.equal(current.complianceClaim, null);
  const again = await loadValueReport(client, { tenantRef, from: FROM, to: NOW, now: new Date(NOW.getTime() + 60_000), requiredTypes: ['group'] });
  assert.equal(again.outcomes.total, current.outcomes.total);

  // The CSV says the same thing as the JSON.
  const csv = valueReportCsv(current);
  assert.match(csv, new RegExp(`# digest,${current.provenance.digest}`));
  assert.match(csv, /# outcomes_total,2\n/);
  assert.match(csv, /# outcomes_verified,1\n/);
  assert.match(csv, /# compliance_claim,none/);
  assert.equal(csv.split('\n').filter((line) => line.startsWith('outcome,')).length, current.outcomes.rowsShown);

  // Periods are validated.
  assert.throws(() => reportPeriod({ from: NOW, to: FROM, now: NOW }), RangeError);
  assert.throws(() => reportPeriod({ from: new Date(NOW.getTime() - (MAX_PERIOD_DAYS + 1) * 86_400_000), to: NOW, now: NOW }), RangeError);
  assert.equal(reportPeriod({ from: FROM, to: new Date('2027-01-01T00:00:00Z'), now: NOW }).to.toISOString(), NOW.toISOString(), 'a period never runs into the future');
  await assert.rejects(loadValueReport(client, { tenantRef: 'raw-tenant-id', from: FROM, to: NOW, now: NOW }), TypeError);
});

test('an entity-scoped reader sees only its own outcomes; tenant-wide sections are withheld', async () => {
  const tenantRef = 'sha256:value-entities';
  const source = await snapshot(tenantRef, { completedAt: '2026-08-01T00:00:00Z' });
  await version(source, { naturalKey: 'group:finance', hash: 'h' });
  await version(source, { naturalKey: 'group:hr', hash: 'h' });
  for (const [key, entity] of [['group:finance', 'FIN'], ['group:hr', 'HR']]) {
    const { rows: [lineage] } = await client.query(
      `INSERT INTO resource_lineage (tenant_ref, resource_type, source_id) VALUES ($1, 'group', $2) RETURNING id`,
      [tenantRef, key],
    );
    await client.query(
      `INSERT INTO resource_lineage_alias (lineage_id, natural_key, valid_from) VALUES ($1, $2, '2026-01-01T00:00:00Z')`,
      [lineage.id, key],
    );
    await client.query(
      `INSERT INTO resource_ownership_evidence (tenant_ref, lineage_id, state, entity_code, source, reason, observed_at, expires_at, recorded_by)
       VALUES ($1, $2, 'owned', $3, 'cmdb', 'fixture', '2026-09-01T00:00:00Z', '2027-01-01T00:00:00Z', 'test')`,
      [tenantRef, lineage.id, entity],
    );
  }
  const finance = (await plan(tenantRef, { closureKeys: ['group:finance'], snapshotId: source })).planId;
  await restoreJob(finance, { status: 'succeeded', createdAt: '2026-09-20T00:00:00Z', finishedAt: '2026-09-20T00:01:00Z' });
  await journal(finance, { outcome: 'succeeded', at: '2026-09-20T00:00:30Z' });
  const hr = (await plan(tenantRef, { closureKeys: ['group:hr'], snapshotId: source })).planId;
  await restoreJob(hr, { status: 'succeeded', createdAt: '2026-09-21T00:00:00Z', finishedAt: '2026-09-21T00:01:00Z' });
  await journal(hr, { outcome: 'succeeded', at: '2026-09-21T00:00:30Z', naturalKey: 'group:hr' });
  const both = (await plan(tenantRef, { closureKeys: ['group:finance', 'group:hr'], snapshotId: source })).planId;
  await restoreJob(both, { status: 'failed', createdAt: '2026-09-22T00:00:00Z', finishedAt: '2026-09-22T00:01:00Z' });
  await evaluation(tenantRef, { controlId: 'mfa', verdict: 'fail', at: '2026-09-05T00:00:00Z' });

  const central = await report(tenantRef);
  assert.equal(central.outcomes.total, 3);
  assert.equal(central.findings.total, 1);

  const fin = await report(tenantRef, { scope: { central: false, entities: ['FIN'] } });
  assert.equal(fin.outcomes.total, 1, 'only the plan wholly inside FIN');
  assert.equal(fin.outcomes.rows[0].planId, finance);
  assert.deepEqual(fin.findings, { withheld: true });
  assert.deepEqual(fin.recovery, { withheld: true });
  assert.equal(fin.outcomes.undoRunsExcluded, null);
  assertConsistent(fin.outcomes);

  const nobody = await report(tenantRef, { scope: { central: false, entities: [] } });
  assert.equal(nobody.outcomes.total, 0);
  assert.equal(nobody.outcomes.percentVerified, null);
});

test('measured recovery comes from the recovery metrics, and the CLI prints JSON and CSV', async () => {
  const tenantRef = 'sha256:value-cli';
  const { planId } = await plan(tenantRef);
  await restoreJob(planId, { status: 'succeeded', createdAt: '2026-09-20T10:00:00Z', startedAt: '2026-09-20T10:00:00Z', finishedAt: '2026-09-20T10:04:00Z' });
  await journal(planId, { outcome: 'succeeded', at: '2026-09-20T10:03:00Z' });
  const value = await report(tenantRef);
  assert.equal(value.recovery.recoveryTime.state, 'measured');
  assert.equal(value.recovery.recoveryTime.samples, 1);
  assert.equal(value.recovery.recoveryTime.medianMs, 4 * 60 * 1000);
  const empty = await report('sha256:value-empty');
  assert.equal(empty.recovery.recoveryTime.state, 'unmeasured');
  assert.equal(empty.recovery.recoveryTime.medianMs, null);
  assert.equal(empty.outcomes.total, 0);
  assert.equal(empty.findings.total, 0);
  assert.equal(empty.findings.percentResolved, null);

  const lines = [];
  const logger = { log: (line) => lines.push(line) };
  const run = (argv) => valueReportCli({ argv, logger, env: { KEEL_DB_URL: database.url }, now: () => NOW });
  assert.equal(await run(['--tenant-ref', tenantRef, '--days', '30']), 0);
  const printed = JSON.parse(lines.pop());
  assert.equal(printed.outcomes.states.verified, 1);
  assert.equal(printed.hoursSaved, null);
  assert.equal(await run(['--tenant-ref', tenantRef, '--format', 'csv']), 0);
  assert.match(lines.pop(), /^# report,keel-value-report/);
  assert.equal(await run(['--tenant-ref', tenantRef, '--format', 'xml']), 2);
});
