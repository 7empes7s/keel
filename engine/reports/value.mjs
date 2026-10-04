/**
 * Roadmap task-100: verified outcome and executive value reporting.
 *
 * One tenant-scoped reader, loadValueReport(), and the pure functions behind it. It
 * reports three things for a period, each counted from canonical identities so a
 * retry, a re-claimed job or a repeated evaluation never counts twice:
 *
 * 1. Remediation outcomes. One outcome is one thing KEEL was asked to put back:
 *    - a restore plan promoted by `restore` jobs (identity `restore-plan:<plan id>`);
 *    - a detected change remediated by `remediate` jobs (identity `change:<drift id>`).
 *    Each job is one attempt, named by its task-77 correlation id (`job:<id>`), which
 *    survives an orphan re-claim. Further jobs for the same outcome are retries: they
 *    add attempts, never outcomes. Every outcome sits in exactly one state, so the
 *    states always add up to the total:
 *    - verified: a job succeeded AND the result was checked independently of the job.
 *      A restore plan needs the write journal's latest entry for every resource to be
 *      `succeeded` (written and read back) and every completion item verified. A
 *      remediated change needs a later complete collection to show the resource back
 *      at its baseline value (or absent, for an added resource).
 *    - reopened: it was verified, then a later collection showed it changed again.
 *    - unconfirmed: a job succeeded but nothing has verified the result yet.
 *    - queued: an attempt is waiting or running, and none has succeeded.
 *    - failed: every attempt failed or was cancelled.
 *    A queued, running, failed or cancelled job is never a verified outcome.
 * 2. Control findings (task-85 evaluations, task-87 compliance). A finding is resolved
 *    when its newest evaluation passes after a failure. A finding that fails again is
 *    open (reopened), not resolved; an evaluation that could not decide leaves it
 *    unchecked. An exception never resolves a finding. Editions and evaluator versions
 *    are separate findings, so an edition change is never read as a fix.
 * 3. Measured recovery (task-73): recovery-time samples in the period and the current
 *    freshness, straight from loadRecoveryMetrics. Nothing configured stands in for a
 *    measurement.
 *
 * Hours saved appear ONLY when an operator configured an estimate (minutes per verified
 * outcome, with written assumptions). They multiply verified outcomes only, never
 * attempts. Without a valid estimate the report carries no hours at all.
 *
 * The report states what KEEL did and checked. It makes no claim of compliance with
 * any regulation or framework.
 */
import { createHash } from 'node:crypto';

import { CENTRAL, ownershipOfResources, ownershipVisibleTo } from '../authz/entityScope.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { readCoverageOutcome } from '../coverage/snapshots.mjs';
import { loadRecoveryMetrics } from '../coverage/recoveryMetrics.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { canonicalJson, jobCorrelationId } from '../telemetry/events.mjs';

export const VALUE_REPORT_VERSION = 1;
/** Rows serialized per table; totals always count every row. */
export const MAX_REPORT_ROWS = 50;
/** Longest period one report may cover. */
export const MAX_PERIOD_DAYS = 366;
/** Source rows read per family; beyond this the report says it is incomplete. */
export const MAX_SOURCE_ROWS = 20000;
/** Collections checked after a remediation, per report. */
export const MAX_VERIFY_SNAPSHOTS = 500;
/** Longest per-outcome estimate accepted: one working week. */
export const MAX_ESTIMATE_MINUTES = 2400;

export const OUTCOME_STATES = Object.freeze(['verified', 'reopened', 'unconfirmed', 'queued', 'failed']);
export const FINDING_STATES = Object.freeze(['resolved', 'open', 'unchecked']);
export const ESTIMATE_FAMILIES = Object.freeze(['restore', 'remediation', 'finding']);

export const COUNTING_RULES = Object.freeze([
  'One outcome per restore plan or detected change; further jobs for it are retries.',
  'An attempt is one job, named by its correlation id; a re-claimed job is the same attempt.',
  'Verified needs a succeeded job and an independent check: the write journal and completion items, or a later collection.',
  'Queued, running, failed and cancelled jobs are never verified outcomes.',
  'A verified outcome changed again by a later collection is reopened, not verified.',
  'A finding is resolved only while its newest evaluation passes after a failure; an exception does not resolve it.',
  'Hours appear only from a configured estimate, multiplied by verified outcomes only.',
  'This report is not a statement of compliance with any regulation or framework.',
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function instant(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(value) {
  return instant(value)?.toISOString() ?? null;
}

const before = (value, limit) => {
  const at = instant(value);
  return at !== null && at < limit;
};
const within = (value, from, to) => {
  const at = instant(value);
  return at !== null && at >= from && at < to;
};

/**
 * The period a report covers, validated. `to` never runs past `now`; a period longer
 * than MAX_PERIOD_DAYS or ending before it starts is refused.
 */
export function reportPeriod({ from, to, now = new Date() }) {
  const at = instant(now) ?? new Date();
  const end = instant(to) ?? at;
  const start = instant(from);
  if (!start) throw new RangeError('period start is required');
  const capped = end > at ? at : end;
  if (!(start < capped)) throw new RangeError('period must start before it ends');
  if (capped.getTime() - start.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    throw new RangeError(`period may cover at most ${MAX_PERIOD_DAYS} days`);
  }
  return { from: start, to: capped };
}

/**
 * One job's status as of `to`: a job that finished after the period ended was still
 * running at its end, and a job requested after it is not part of it at all.
 */
function statusAsOf(job, to) {
  if (!before(job.created_at, to)) return null;
  if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
    return before(job.finished_at, to) ? job.status : 'running';
  }
  if (job.status === 'running' || job.status === 'queued') return job.status;
  return null;
}

function attemptsOf(jobs, to) {
  // One attempt per job row. The correlation id is the job's identity across
  // re-claims, so a row seen twice (for example through two joins) is still one.
  const byId = new Map();
  for (const job of jobs) {
    const status = statusAsOf(job, to);
    if (!status) continue;
    const eventId = jobCorrelationId(job);
    if (byId.has(eventId)) continue;
    byId.set(eventId, {
      eventId,
      jobId: String(job.id),
      kind: job.kind,
      status,
      requestedAt: iso(job.created_at),
      finishedAt: ['succeeded', 'failed', 'cancelled'].includes(status) ? iso(job.finished_at) : null,
    });
  }
  return [...byId.values()].sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)) || a.eventId.localeCompare(b.eventId));
}

function lifecycle(attempts) {
  const succeeded = attempts.filter((attempt) => attempt.status === 'succeeded');
  if (succeeded.length) return { stage: 'succeeded', success: succeeded[0] };
  if (attempts.some((attempt) => attempt.status === 'queued' || attempt.status === 'running')) return { stage: 'queued' };
  return { stage: 'failed' };
}

/**
 * A restore plan's outcome as of `to`. `journal` is the plan's write-journal rows
 * (restore_ref = plan id); `items` its completion items.
 *
 * @param {{ planId: string, jobs: any[], journal?: any[], items?: any[], to: Date | string }} input
 * @returns {any}
 */
export function classifyRestoreOutcome({ planId, jobs, journal = [], items = [], to }) {
  const end = instant(to);
  const attempts = attemptsOf(jobs, end);
  const base = { id: `restore-plan:${planId}`, family: 'restore', planId: String(planId), attempts };
  if (attempts.length === 0) return null;
  const { stage, success } = lifecycle(attempts);
  if (stage !== 'succeeded') return { ...base, state: stage, reason: stage === 'queued' ? 'attempt-pending' : 'all-attempts-failed', verifiedAt: null };
  // The newest journal entry per resource decides: a retry that wrote it again
  // replaces an earlier failed write of the same resource.
  const latest = new Map();
  for (const entry of journal) {
    if (!before(entry.recorded_at, end)) continue;
    const previous = latest.get(entry.natural_key);
    const key = (row) => `${iso(row.recorded_at)}|${row.id}`;
    if (!previous || key(entry) > key(previous)) latest.set(entry.natural_key, entry);
  }
  if (latest.size === 0) return { ...base, state: 'unconfirmed', reason: 'no-write-record', verifiedAt: null };
  if ([...latest.values()].some((entry) => entry.outcome !== 'succeeded' || !before(entry.outcome_at ?? entry.recorded_at, end))) {
    return { ...base, state: 'unconfirmed', reason: 'write-not-confirmed', verifiedAt: null };
  }
  const relevant = items.filter((item) => item.created_at === undefined || item.created_at === null || before(item.created_at, end));
  if (relevant.some((item) => item.state !== 'verified' || !before(item.closed_at, end))) {
    return { ...base, state: 'unconfirmed', reason: 'completion-pending', verifiedAt: null };
  }
  const times = [instant(success.finishedAt), ...relevant.map((item) => instant(item.closed_at)), ...[...latest.values()].map((entry) => instant(entry.outcome_at ?? entry.recorded_at))]
    .filter(Boolean).map(Number);
  return { ...base, state: 'verified', reason: 'journal-and-completion-verified', verifiedAt: new Date(Math.max(...times)).toISOString() };
}

/**
 * What one complete collection shows about a remediated change: `matches` (back at
 * the baseline value, or absent for an added resource), `differs`, `not-comparable`
 * (hashed under another hash version) or `unknown` (the type was not read completely).
 */
export function observationVerdict({ changeType, beforeHash, baselineHashVersion, version, covered }) {
  if (changeType === 'added') {
    if (version) return 'differs';
    return covered ? 'matches' : 'unknown';
  }
  if (!version) return covered ? 'differs' : 'unknown';
  if (Number(version.hash_version ?? 1) !== Number(baselineHashVersion ?? 1)) return 'not-comparable';
  return version.payload_hash === beforeHash ? 'matches' : 'differs';
}

/**
 * A detected change's remediation outcome as of `to`. `observations` are the
 * collections completed after the change was detected, each { snapshotId,
 * completedAt, verdict } (observationVerdict). Only collections completed after the
 * first successful attempt finished can verify it.
 *
 * @param {{ driftId: string, jobs: any[], observations?: any[], to: Date | string }} input
 * @returns {any}
 */
export function classifyChangeRemediation({ driftId, jobs, observations = [], to }) {
  const end = instant(to);
  const attempts = attemptsOf(jobs, end);
  const base = { id: `change:${driftId}`, family: 'remediation', driftId: String(driftId), attempts };
  if (attempts.length === 0) return null;
  const { stage, success } = lifecycle(attempts);
  if (stage !== 'succeeded') return { ...base, state: stage, reason: stage === 'queued' ? 'attempt-pending' : 'all-attempts-failed', verifiedAt: null };
  const after = instant(success.finishedAt);
  const decisive = observations
    .filter((observation) => instant(observation.completedAt) > after && before(observation.completedAt, end))
    .filter((observation) => observation.verdict === 'matches' || observation.verdict === 'differs')
    .sort((a, b) => String(iso(a.completedAt)).localeCompare(String(iso(b.completedAt))));
  if (decisive.length === 0) return { ...base, state: 'unconfirmed', reason: 'no-later-collection', verifiedAt: null };
  const newest = decisive.at(-1);
  if (newest.verdict === 'matches') {
    // Verified from the first match of the final unbroken run of matches.
    let first = decisive.length - 1;
    while (first > 0 && decisive[first - 1].verdict === 'matches') first -= 1;
    return { ...base, state: 'verified', reason: 'collection-shows-baseline', verifiedAt: iso(decisive[first].completedAt), verifiedBy: decisive[first].snapshotId };
  }
  const matched = decisive.find((observation) => observation.verdict === 'matches');
  if (matched) return { ...base, state: 'reopened', reason: 'changed-again', verifiedAt: null, verifiedBy: matched.snapshotId, reopenedAt: iso(newest.completedAt), reopenedBy: newest.snapshotId };
  return { ...base, state: 'unconfirmed', reason: 'collection-still-differs', verifiedAt: null };
}

function lastEventAt(outcome) {
  const times = [
    ...outcome.attempts.flatMap((attempt) => [attempt.requestedAt, attempt.finishedAt]),
    outcome.verifiedAt, outcome.reopenedAt,
  ].map(instant).filter(Boolean).map(Number);
  return times.length ? new Date(Math.max(...times)) : null;
}

/**
 * Whether an outcome belongs to the period. A verified outcome belongs to the period it
 * was verified in, so adjacent periods never both count it. Any other outcome belongs
 * to a period in which something happened to it.
 */
export function outcomeInPeriod(outcome, { from, to }) {
  if (!outcome) return false;
  if (outcome.state === 'verified') return within(outcome.verifiedAt, from, to);
  const events = [
    ...outcome.attempts.flatMap((attempt) => [attempt.requestedAt, attempt.finishedAt]),
    outcome.reopenedAt,
  ];
  if (events.some((at) => within(at, from, to))) return true;
  // Still waiting at the end of the period: it stays visible until it resolves.
  return outcome.state === 'queued';
}

function percent(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

/**
 * State counts that always add up to the total, with attempts and retries.
 *
 * @param {any[]} outcomes
 */
export function summarizeOutcomes(outcomes) {
  const states = Object.fromEntries(OUTCOME_STATES.map((state) => [state, 0]));
  let attempts = 0;
  for (const outcome of outcomes) {
    states[outcome.state] += 1;
    attempts += outcome.attempts.length;
  }
  const total = outcomes.length;
  return {
    total,
    states,
    attempts,
    retries: attempts - total,
    percentVerified: percent(states.verified, total),
  };
}

const evaluationGroup = (row) => [row.framework, row.edition, row.profile, row.control_id, row.evaluator_version].join('|');

/**
 * One control's finding, from its evaluations (one framework, edition, profile and
 * evaluator version) up to `to`. Returns null when the control never failed: a
 * control that always passed is not a finding.
 */
export function classifyControlFinding(evaluations, { to }) {
  const end = instant(to);
  const ordered = evaluations
    .filter((row) => before(row.evaluated_at, end))
    .sort((a, b) => String(iso(a.evaluated_at)).localeCompare(String(iso(b.evaluated_at))) || String(a.id).localeCompare(String(b.id)));
  let state = null;
  let resolvedBy = null;
  let failedBy = null;
  let resolutions = 0;
  let reopened = false;
  for (const row of ordered) {
    if (row.verdict === 'fail') {
      if (state === 'resolved' || resolutions > 0) reopened = true;
      state = 'open';
      failedBy = row;
      resolvedBy = null;
    } else if (row.verdict === 'pass') {
      if (state === 'open' || state === 'unchecked') {
        state = 'resolved';
        resolvedBy = row;
        resolutions += 1;
      }
    } else if (state !== null) {
      // Unknown or not applicable: a failing control is not shown to be fixed, and a
      // fixed one is no longer shown to stay fixed.
      state = 'unchecked';
      resolvedBy = null;
    }
  }
  if (state === null) return null;
  const last = ordered.at(-1);
  return {
    id: `finding:${evaluationGroup(last)}`,
    controlId: last.control_id,
    framework: last.framework,
    edition: last.edition,
    profile: last.profile,
    state,
    reopened: state !== 'resolved' && reopened,
    resolvedAt: resolvedBy ? iso(resolvedBy.evaluated_at) : null,
    resolvedBy: resolvedBy ? { evaluationId: String(resolvedBy.id), evidenceSeq: resolvedBy.evidence_seq === null || resolvedBy.evidence_seq === undefined ? null : String(resolvedBy.evidence_seq) } : null,
    failedAt: failedBy ? iso(failedBy.evaluated_at) : null,
    lastEvaluatedAt: iso(last.evaluated_at),
    lastVerdict: last.verdict,
    lastEvaluationId: String(last.id),
  };
}

/** Whether a finding belongs to the period: resolved in it, or not resolved at its end. */
export function findingInPeriod(finding, { from, to }) {
  if (!finding) return false;
  if (finding.state === 'resolved') return within(finding.resolvedAt, from, to);
  return true;
}

export function summarizeFindings(findings) {
  const states = Object.fromEntries(FINDING_STATES.map((state) => [state, 0]));
  for (const finding of findings) states[finding.state] += 1;
  return {
    total: findings.length,
    states,
    reopened: findings.filter((finding) => finding.reopened).length,
    percentResolved: percent(states.resolved, findings.length),
  };
}

/**
 * A configured time-saving estimate, validated. Only `configured` produces hours.
 * Shape: { minutesPerVerifiedOutcome: { restore?, remediation?, finding? },
 *          assumptions: [text, ...], owner, setAt? }
 *
 * @param {unknown} raw
 * @param {{ source?: string | null }} [options]
 * @returns {any}
 */
export function readEstimate(raw, { source = null } = {}) {
  if (raw === null || raw === undefined) return { state: 'not-configured', source };
  const problems = [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return { state: 'invalid', source, problems: ['not-an-object'] };
  const minutes = raw.minutesPerVerifiedOutcome;
  const per = {};
  if (!minutes || typeof minutes !== 'object' || Array.isArray(minutes)) problems.push('no-minutes');
  else {
    for (const [family, value] of Object.entries(minutes)) {
      if (!ESTIMATE_FAMILIES.includes(family)) { problems.push(`unknown-family:${family}`); continue; }
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_ESTIMATE_MINUTES) {
        problems.push(`bad-minutes:${family}`);
        continue;
      }
      per[family] = value;
    }
    if (Object.keys(per).length === 0 && !problems.length) problems.push('no-minutes');
  }
  const assumptions = Array.isArray(raw.assumptions)
    ? raw.assumptions.filter((text) => typeof text === 'string' && text.trim().length > 0).map((text) => text.trim())
    : [];
  if (assumptions.length === 0) problems.push('no-assumptions');
  const owner = typeof raw.owner === 'string' && raw.owner.trim() ? raw.owner.trim() : null;
  if (!owner) problems.push('no-owner');
  if (problems.length) return { state: 'invalid', source, problems };
  return {
    state: 'configured',
    source,
    minutesPerVerifiedOutcome: per,
    assumptions,
    owner,
    setAt: iso(raw.setAt),
  };
}

/**
 * Hours saved from a configured estimate and VERIFIED counts only. Returns null
 * whenever the estimate is not configured: no fallback figure exists.
 *
 * @param {any} estimate
 * @param {Record<string, number>} verified
 * @returns {any}
 */
export function estimateHours(estimate, verified) {
  if (estimate?.state !== 'configured') return null;
  const byFamily = [];
  for (const family of ESTIMATE_FAMILIES) {
    const minutesEach = estimate.minutesPerVerifiedOutcome[family];
    if (minutesEach === undefined) continue;
    const count = Number(verified[family] ?? 0);
    byFamily.push({ family, verified: count, minutesEach, hours: Math.round((count * minutesEach) / 6) / 10 });
  }
  const totalMinutes = byFamily.reduce((sum, row) => sum + row.verified * row.minutesEach, 0);
  return {
    hours: Math.round(totalMinutes / 6) / 10,
    byFamily,
    notEstimated: ESTIMATE_FAMILIES.filter((family) => estimate.minutesPerVerifiedOutcome[family] === undefined),
    assumptions: estimate.assumptions,
    owner: estimate.owner,
    setAt: estimate.setAt,
    basis: 'verified-outcomes-only',
  };
}

function digestOf(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function capped(rows, limit = MAX_REPORT_ROWS) {
  return { rows: rows.slice(0, limit), shown: Math.min(rows.length, limit), total: rows.length };
}

function normalizedScope(scope) {
  if (!scope || scope.central === true) return CENTRAL;
  const entities = Array.isArray(scope.entities) ? [...new Set(scope.entities.filter((code) => typeof code === 'string' && code))].sort() : [];
  return { central: false, entities };
}

// ---------------------------------------------------------------- loaders

async function loadRestoreOutcomes(client, { tenantRef, to }) {
  const { rows: jobs } = await client.query(
    `SELECT j.id, j.kind, j.status, j.params, j.created_at, j.started_at, j.finished_at,
            rd.id::text AS plan_id, rd.compensation IS NOT NULL AS is_undo, rd.snapshot_id::text AS snapshot_id,
            rd.closure_keys, rd.created_at AS plan_created_at
       FROM job j
       JOIN restore_dry_run rd ON rd.id::text = j.params ->> 'artifactId'
      WHERE j.kind = 'restore' AND rd.tenant_ref = $1 AND j.created_at < $2
      ORDER BY j.created_at, j.id
      LIMIT $3`,
    [tenantRef, to, MAX_SOURCE_ROWS + 1],
  );
  const bounded = jobs.length > MAX_SOURCE_ROWS;
  const enforced = jobs.slice(0, MAX_SOURCE_ROWS).filter((job) => job.params?.mode === 'enforce'
    || (Object.keys(job.params ?? {}).length === 1 && typeof job.params?.artifactId === 'string'));
  const undo = new Set(enforced.filter((job) => job.is_undo).map((job) => job.plan_id));
  const forward = enforced.filter((job) => !job.is_undo);
  const planIds = [...new Set(forward.map((job) => job.plan_id))];
  if (planIds.length === 0) return { outcomes: [], plans: new Map(), undoPlans: undo.size, bounded, jobsRead: jobs.length };
  const { rows: journal } = await client.query(
    `SELECT id, restore_ref, natural_key, outcome, outcome_at, recorded_at
       FROM rollback_entry WHERE restore_ref = ANY($1::text[]) AND recorded_at < $2`,
    [planIds, to],
  );
  const { rows: items } = await client.query(
    `SELECT restore_ref, state, closed_at, created_at FROM recovery_completion_item
      WHERE tenant_ref = $1 AND restore_ref = ANY($2::text[])`,
    [tenantRef, planIds],
  );
  const plans = new Map();
  const outcomes = [];
  for (const planId of planIds) {
    const planJobs = forward.filter((job) => job.plan_id === planId);
    const first = planJobs[0];
    plans.set(planId, { snapshotId: first.snapshot_id, closureKeys: Array.isArray(first.closure_keys) ? first.closure_keys : [], createdAt: first.plan_created_at });
    const outcome = classifyRestoreOutcome({
      planId,
      jobs: planJobs,
      journal: journal.filter((row) => row.restore_ref === planId),
      items: items.filter((row) => row.restore_ref === planId),
      to,
    });
    if (outcome) outcomes.push({ ...outcome, resources: plans.get(planId).closureKeys.length });
  }
  return { outcomes, plans, undoPlans: undo.size, bounded, jobsRead: jobs.length };
}

async function loadChangeRemediations(client, { tenantRef, to }) {
  const { rows: jobs } = await client.query(
    `SELECT j.id, j.kind, j.status, j.created_at, j.started_at, j.finished_at, d.id::text AS drift_id
       FROM job j
       CROSS JOIN LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(j.params -> 'driftIds') = 'array' THEN j.params -> 'driftIds' ELSE '[]'::jsonb END) AS ids(drift_id)
       JOIN drift d ON d.id::text = ids.drift_id
      WHERE j.kind = 'remediate' AND d.tenant_ref = $1 AND j.created_at < $2
      ORDER BY j.created_at, j.id
      LIMIT $3`,
    [tenantRef, to, MAX_SOURCE_ROWS + 1],
  );
  const bounded = jobs.length > MAX_SOURCE_ROWS;
  const kept = jobs.slice(0, MAX_SOURCE_ROWS);
  const driftIds = [...new Set(kept.map((job) => job.drift_id))];
  if (driftIds.length === 0) return { outcomes: [], drifts: new Map(), bounded, jobsRead: jobs.length, snapshotsChecked: 0 };
  const { rows: drifts } = await client.query(
    `SELECT d.id::text AS id, d.natural_key, d.resource_type, d.change_type, d.before_hash, d.detected_at,
            d.baseline_id::text AS baseline_id, COALESCE(brv.hash_version, 1) AS baseline_hash_version
       FROM drift d
       LEFT JOIN baseline_resource br ON br.baseline_id = d.baseline_id AND br.natural_key = d.natural_key
       LEFT JOIN resource_version brv ON brv.id = br.resource_version_id
      WHERE d.tenant_ref = $1 AND d.id = ANY($2::uuid[])`,
    [tenantRef, driftIds],
  );
  const byId = new Map(drifts.map((row) => [row.id, row]));
  // Collections that could verify: complete, finished after the earliest success and
  // before the period end. Newest first, bounded.
  const successes = kept.filter((job) => job.status === 'succeeded' && job.finished_at).map((job) => instant(job.finished_at));
  let snapshots = [];
  let versions = [];
  if (successes.length) {
    const earliest = new Date(Math.min(...successes.map(Number)));
    ({ rows: snapshots } = await client.query(
      `SELECT id::text AS id, completed_at, coverage_digest FROM snapshot
        WHERE tenant_ref = $1 AND status = 'complete' AND completed_at > $2 AND completed_at < $3
        ORDER BY completed_at DESC, id DESC LIMIT $4`,
      [tenantRef, earliest, to, MAX_VERIFY_SNAPSHOTS],
    ));
    if (snapshots.length) {
      ({ rows: versions } = await client.query(
        `SELECT snapshot_id::text AS snapshot_id, natural_key, payload_hash, hash_version
           FROM resource_version
          WHERE snapshot_id = ANY($1::uuid[]) AND natural_key = ANY($2::text[])`,
        [snapshots.map((row) => row.id), [...new Set(drifts.map((row) => row.natural_key))]],
      ));
    }
  }
  const versionOf = new Map(versions.map((row) => [`${row.snapshot_id}|${row.natural_key}`, row]));
  const outcomes = [];
  for (const driftId of driftIds) {
    const drift = byId.get(driftId);
    if (!drift) continue;
    const observations = snapshots
      .filter((snapshot) => instant(snapshot.completed_at) > instant(drift.detected_at))
      .map((snapshot) => {
        const digest = snapshot.coverage_digest && typeof snapshot.coverage_digest === 'object' ? snapshot.coverage_digest : {};
        return {
          snapshotId: snapshot.id,
          completedAt: iso(snapshot.completed_at),
          verdict: observationVerdict({
            changeType: drift.change_type,
            beforeHash: drift.before_hash,
            baselineHashVersion: drift.baseline_hash_version,
            version: versionOf.get(`${snapshot.id}|${drift.natural_key}`) ?? null,
            covered: readCoverageOutcome(digest[drift.resource_type]).covered,
          }),
        };
      });
    const outcome = classifyChangeRemediation({ driftId, jobs: kept.filter((job) => job.drift_id === driftId), observations, to });
    if (outcome) outcomes.push({ ...outcome, resourceType: drift.resource_type, changeType: drift.change_type, resources: 1 });
  }
  return { outcomes, drifts: byId, bounded, jobsRead: jobs.length, snapshotsChecked: snapshots.length };
}

async function loadFindings(client, { tenantRef, to }) {
  const { rows } = await client.query(
    `SELECT id::text AS id, control_id, framework, edition, profile, evaluator_version, verdict, evidence_seq, evaluated_at
       FROM benchmark_evaluation
      WHERE tenant_ref = $1 AND evaluated_at < $2
      ORDER BY evaluated_at, id
      LIMIT $3`,
    [tenantRef, to, MAX_SOURCE_ROWS + 1],
  );
  const bounded = rows.length > MAX_SOURCE_ROWS;
  const groups = new Map();
  for (const row of rows.slice(0, MAX_SOURCE_ROWS)) {
    const key = evaluationGroup(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const findings = [...groups.values()].map((group) => classifyControlFinding(group, { to })).filter(Boolean);
  return { findings, bounded, evaluationsRead: Math.min(rows.length, MAX_SOURCE_ROWS) };
}

/**
 * Which outcomes an entity-scoped reader may see: a restore plan only when every
 * resource it covers is owned by (or shared with) one of the reader's entities; a
 * remediated change when its resource is. Anything unattributable is central-only.
 */
async function visibleOutcomes(client, { tenantRef, scope, restore, change, at }) {
  if (scope.central) return [...restore.outcomes, ...change.outcomes];
  const visible = [];
  for (const outcome of change.outcomes) {
    const drift = change.drifts.get(outcome.driftId);
    const [answer] = await ownershipOfResources(client, {
      tenantRef, resources: [{ resourceType: drift.resource_type, naturalKey: drift.natural_key, asOf: drift.detected_at }],
    });
    if (ownershipVisibleTo(scope, answer, at)) visible.push(outcome);
  }
  for (const outcome of restore.outcomes) {
    const plan = restore.plans.get(outcome.planId);
    if (!plan || plan.closureKeys.length === 0) continue;
    const { rows: types } = await client.query(
      `SELECT natural_key, resource_type FROM resource_version WHERE snapshot_id = $1 AND natural_key = ANY($2::text[])`,
      [plan.snapshotId, plan.closureKeys],
    );
    if (types.length !== plan.closureKeys.length) continue;
    const answers = await ownershipOfResources(client, {
      tenantRef, resources: types.map((row) => ({ resourceType: row.resource_type, naturalKey: row.natural_key, asOf: plan.createdAt })),
    });
    if (answers.every((answer) => ownershipVisibleTo(scope, answer, at))) visible.push(outcome);
  }
  return visible;
}

function recoverySection(metrics, { from, to }) {
  const attempts = (metrics.recoveryTime?.attempts ?? []).filter((attempt) => within(attempt.at, from, to));
  const samples = attempts.filter((attempt) => attempt.counts).map((attempt) => attempt.elapsedMs).sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  const median = samples.length === 0 ? null : (samples.length % 2 ? samples[middle] : Math.round((samples[middle - 1] + samples[middle]) / 2));
  return {
    withheld: false,
    recoveryTime: {
      state: samples.length ? 'measured' : 'unmeasured',
      samples: samples.length,
      medianMs: median,
      worstMs: samples.length ? samples.at(-1) : null,
      notCounted: attempts.length - samples.length,
      drills: attempts.filter((attempt) => attempt.counts && attempt.source === 'drill').length,
      restores: attempts.filter((attempt) => attempt.counts && attempt.source === 'restore').length,
    },
    freshness: {
      state: metrics.freshness?.state ?? 'unmeasured',
      achievedRpoMs: metrics.freshness?.achievedRpoMs ?? null,
      gaps: (metrics.freshness?.gaps ?? []).length,
      asOf: metrics.generatedAt,
    },
    recoverablePoint: {
      state: metrics.recoverablePoint?.state ?? 'unmeasured',
      ageMs: metrics.recoverablePoint?.ageMs ?? null,
      asOf: metrics.generatedAt,
    },
  };
}

function outcomeRow(outcome) {
  return {
    id: outcome.id,
    family: outcome.family,
    state: outcome.state,
    reason: outcome.reason,
    attempts: outcome.attempts.length,
    retries: Math.max(0, outcome.attempts.length - 1),
    firstRequestedAt: outcome.attempts[0]?.requestedAt ?? null,
    lastEventAt: iso(lastEventAt(outcome)),
    verifiedAt: outcome.verifiedAt ?? null,
    reopenedAt: outcome.reopenedAt ?? null,
    resources: outcome.resources ?? null,
    resourceType: outcome.resourceType ?? null,
    changeType: outcome.changeType ?? null,
    planId: outcome.planId ?? null,
    driftId: outcome.driftId ?? null,
    attemptEventIds: outcome.attempts.map((attempt) => attempt.eventId),
  };
}

const STATE_ORDER = Object.fromEntries(OUTCOME_STATES.map((state, index) => [state, index]));
const FINDING_ORDER = { open: 0, unchecked: 1, resolved: 2 };

/**
 * The value report for one tenant and period.
 * - scope: { central: true } or { central: false, entities: [codes] } (task-90).
 *   Findings and recovery are tenant-wide, so an entity-scoped report withholds them.
 * - estimate: the raw configured estimate (readEstimate validates it), or null.
 *
 * @param {any} client
 * @param {{ tenantRef: string, from: Date | string, to?: Date | string,
 *   scope?: { central: boolean, entities?: string[] }, estimate?: unknown,
 *   estimateSource?: string | null, now?: Date, requiredTypes?: string[] }} options
 */
export async function loadValueReport(client, {
  tenantRef, from, to, scope = CENTRAL, estimate = null, estimateSource = null,
  now = new Date(), requiredTypes = DESCRIPTORS.map((descriptor) => descriptor.type),
}) {
  assertTenantRef(tenantRef);
  const generatedAt = instant(now) ?? new Date();
  const period = reportPeriod({ from, to, now: generatedAt });
  const reader = normalizedScope(scope);

  const restore = await loadRestoreOutcomes(client, { tenantRef, to: period.to });
  const change = await loadChangeRemediations(client, { tenantRef, to: period.to });
  const visible = await visibleOutcomes(client, { tenantRef, scope: reader, restore, change, at: generatedAt });
  const outcomes = visible.filter((outcome) => outcomeInPeriod(outcome, period))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]
      || String(iso(lastEventAt(b))).localeCompare(String(iso(lastEventAt(a)))) || a.id.localeCompare(b.id));
  const summary = summarizeOutcomes(outcomes);
  const byFamily = {
    restore: summarizeOutcomes(outcomes.filter((outcome) => outcome.family === 'restore')),
    remediation: summarizeOutcomes(outcomes.filter((outcome) => outcome.family === 'remediation')),
  };

  let findings = { withheld: true };
  let recovery = { withheld: true };
  let findingsBounded = false;
  let evaluationsRead = 0;
  if (reader.central) {
    const loaded = await loadFindings(client, { tenantRef, to: period.to });
    findingsBounded = loaded.bounded;
    evaluationsRead = loaded.evaluationsRead;
    const inPeriod = loaded.findings.filter((finding) => findingInPeriod(finding, period))
      .sort((a, b) => FINDING_ORDER[a.state] - FINDING_ORDER[b.state] || String(b.lastEvaluatedAt).localeCompare(String(a.lastEvaluatedAt)) || a.id.localeCompare(b.id));
    const table = capped(inPeriod);
    findings = { withheld: false, ...summarizeFindings(inPeriod), rows: table.rows, rowsShown: table.shown };
    const metrics = await loadRecoveryMetrics(client, { tenantRef, requiredTypes, now: period.to });
    recovery = recoverySection(metrics, period);
  }

  const verified = {
    restore: byFamily.restore.states.verified,
    remediation: byFamily.remediation.states.verified,
    finding: findings.withheld ? 0 : findings.states.resolved,
  };
  const configured = readEstimate(estimate, { source: estimateSource });
  const hoursSaved = estimateHours(configured, verified);

  const { rows: [head] } = await client.query(
    'SELECT head_seq, head_hash, record_count FROM evidence_head WHERE tenant_ref = $1',
    [tenantRef],
  );

  const table = capped(outcomes.map(outcomeRow));
  const report = {
    version: VALUE_REPORT_VERSION,
    tenantRef,
    generatedAt: generatedAt.toISOString(),
    period: { from: period.from.toISOString(), to: period.to.toISOString(), days: Math.round(((period.to - period.from) / DAY_MS) * 10) / 10 },
    scope: reader,
    outcomes: { ...summary, byFamily, rows: table.rows, rowsShown: table.shown, undoRunsExcluded: reader.central ? restore.undoPlans : null },
    findings,
    recovery,
    estimate: configured.state === 'configured'
      ? { state: 'configured', source: configured.source }
      : { state: configured.state, source: configured.source, problems: configured.problems ?? [] },
    hoursSaved,
    complianceClaim: null,
    provenance: {
      reportVersion: VALUE_REPORT_VERSION,
      countingRules: COUNTING_RULES,
      sources: {
        restoreJobsRead: restore.jobsRead,
        remediateJobsRead: change.jobsRead,
        collectionsChecked: change.snapshotsChecked,
        evaluationsRead,
      },
      complete: !(restore.bounded || change.bounded || findingsBounded),
      evidenceHead: head ? { seq: String(head.head_seq), hash: head.head_hash, records: String(head.record_count) } : null,
    },
  };
  report.provenance.digest = digestOf({ ...report, generatedAt: undefined, provenance: { ...report.provenance, digest: undefined } });
  return report;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join(' ') : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The report as CSV: a provenance header block, then one row per outcome and per
 * finding shown. Hours appear only when the report carries a configured estimate.
 */
export function valueReportCsv(report) {
  const lines = [];
  const meta = [
    ['report', 'keel-value-report'],
    ['version', report.version],
    ['tenant', report.tenantRef],
    ['generated', report.generatedAt],
    ['period_from', report.period.from],
    ['period_to', report.period.to],
    ['scope', report.scope.central ? 'tenant-wide' : `entities ${report.scope.entities.join(' ')}`],
    ['digest', report.provenance.digest],
    ['evidence_head', report.provenance.evidenceHead ? `${report.provenance.evidenceHead.seq}:${report.provenance.evidenceHead.hash}` : ''],
    ['complete', report.provenance.complete],
    ['outcomes_total', report.outcomes.total],
    ...OUTCOME_STATES.map((state) => [`outcomes_${state}`, report.outcomes.states[state]]),
    ['attempts', report.outcomes.attempts],
    ['retries', report.outcomes.retries],
  ];
  if (!report.findings.withheld) {
    meta.push(['findings_total', report.findings.total]);
    for (const state of FINDING_STATES) meta.push([`findings_${state}`, report.findings.states[state]]);
    meta.push(['findings_reopened', report.findings.reopened]);
  }
  if (report.hoursSaved) {
    meta.push(['hours_saved_estimate', report.hoursSaved.hours]);
    meta.push(['estimate_owner', report.hoursSaved.owner]);
    for (const assumption of report.hoursSaved.assumptions) meta.push(['estimate_assumption', assumption]);
  }
  meta.push(['compliance_claim', 'none']);
  for (const [key, value] of meta) lines.push(`# ${key},${csvCell(value)}`);
  lines.push('record,id,family,state,reason,attempts,retries,first_requested,last_event,verified_or_resolved,attempt_event_ids');
  for (const row of report.outcomes.rows) {
    lines.push(['outcome', row.id, row.family, row.state, row.reason, row.attempts, row.retries, row.firstRequestedAt, row.lastEventAt, row.verifiedAt, row.attemptEventIds].map(csvCell).join(','));
  }
  if (!report.findings.withheld) {
    for (const row of report.findings.rows) {
      lines.push(['finding', row.id, row.framework, row.state, row.reopened ? 'reopened' : '', '', '', row.failedAt, row.lastEvaluatedAt, row.resolvedAt, row.resolvedBy ? `evaluation:${row.resolvedBy.evaluationId}` : ''].map(csvCell).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}
