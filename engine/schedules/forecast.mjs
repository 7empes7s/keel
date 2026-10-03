// Roadmap task-110: measured schedule load warnings.
//
// Aggregates what collection runs actually cost in Microsoft Graph requests,
// throttles and duration, per tier and workload, and turns that into an ADVISORY
// estimate for each collect schedule: projected requests a day, a throttle-heavy or
// overlap warning, and a bounded slower cadence. Rules:
//
// 1. Requests are the Graph reader's own request counter per type (recorded in the
//    coverage digest by engine/collect/entraAdapter.mjs). The item count is a
//    resource count and never stands in for requests.
// 2. Fewer than MIN_SAMPLES measured runs in the window is "unknown": no estimate,
//    no warning, no proposal. Legacy runs without counters are counted as
//    unmeasured, never as zero-cost runs.
// 3. A forecast is an estimate, never a guarantee against Graph throttling.
//    Accepting (acknowledging) a warning changes nothing about how often a schedule
//    runs: the interval floor in validateSchedule() and the scheduler's runtime
//    check (cli/keel-scheduler.mjs) still apply on every save and every tick, and
//    acknowledgement needs the current configuration grant.
// 4. Scheduling stays UTC. The business-hours view converts upcoming UTC runs to a
//    time zone for display only and never feeds back into next_due_at.
import { can } from '../authz/can.mjs';
import { graphRequestObservation } from '../telemetry/events.mjs';
import { MINIMUM_INTERVAL_MS, nextDueAt, validateSchedule } from './cadence.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export const FORECAST_WINDOW_MS = 14 * DAY;
export const MIN_SAMPLES = 3;
// A run is throttle-heavy when at least 2% of its requests were told to back off,
// or when half the measured runs saw any back-off at all.
export const THROTTLE_WARN_RATIO = 0.02;
export const THROTTLED_RUN_SHARE = 0.5;
// A run whose slow (90th percentile) duration reaches 80% of the gap between runs
// will collide with the next one; the collection lock then defers it.
export const OVERLAP_RATIO = 0.8;
export const MAX_PROPOSED_INTERVAL_MS = WEEK;
export const FORECAST_WARNING_CODES = Object.freeze(['throttle-heavy', 'overlap']);
export const BUSINESS_HOURS = Object.freeze({ startHour: 8, endHour: 18, weekdays: Object.freeze([1, 2, 3, 4, 5]) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNAPSHOT_LINE = /snapshot ([0-9a-f-]{36}) complete/i;
const TIERS = new Set(['tier1', 'tier2', 'tier3']);

/** Graph throttles per service; the endpoint's root names the service it is billed to. */
export function workloadFor(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return 'unknown';
  const path = endpoint.replace(/^https:\/\/graph\.microsoft\.com\/(?:v1\.0|beta)/, '');
  if (/^\/(?:deviceManagement|deviceAppManagement)(?:\/|$)/.test(path)) return 'intune';
  if (/^\/identityGovernance(?:\/|$)/.test(path)) return 'identity-governance';
  return 'directory';
}

/** The tier a collection job ran: backup defaults to tier1, an untiered collect is a full run. */
export function jobTier(job) {
  const tier = job?.params?.tier;
  if (TIERS.has(tier)) return tier;
  return job?.kind === 'backup' && tier === undefined ? 'tier1' : 'all';
}

/** The snapshot a collection job persisted, as completions.mjs reads it. Never "latest". */
export function snapshotIdForJob(job) {
  const id = job?.result?.snapshotId ?? SNAPSHOT_LINE.exec(job?.result?.stdout ?? job?.error ?? '')?.[1];
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

/**
 * One collection run as a measured observation. `collect` and `backup` jobs run the
 * same collector, so both count toward the collect forecast of their tier.
 */
export function runObservation({ job, snapshot }) {
  const started = job?.started_at ? new Date(job.started_at).valueOf() : NaN;
  const finished = job?.finished_at ? new Date(job.finished_at).valueOf() : NaN;
  const base = {
    jobId: job?.id ?? null,
    jobKind: job?.kind ?? null,
    kind: 'collect',
    tier: jobTier(job),
    observedAt: iso(job?.finished_at),
    durationMs: Number.isFinite(started) && Number.isFinite(finished) && finished >= started ? finished - started : null,
  };
  const digest = snapshot?.coverage_digest;
  if (!digest || typeof digest !== 'object' || Array.isArray(digest)) return { ...base, measured: false, reason: 'no-snapshot' };
  let requests = 0;
  let throttles = 0;
  let requestedTypes = 0;
  const workloads = {};
  for (const [type, entry] of Object.entries(digest)) {
    if (entry?.outcome === 'not-requested') continue;
    requestedTypes += 1;
    const observed = graphRequestObservation(entry);
    if (!observed) return { ...base, measured: false, reason: 'unmeasured-type', type };
    requests += observed.requests;
    throttles += observed.throttles;
    const workload = workloadFor(entry.endpoint);
    workloads[workload] ??= { requests: 0, throttles: 0 };
    workloads[workload].requests += observed.requests;
    workloads[workload].throttles += observed.throttles;
  }
  if (requestedTypes === 0) return { ...base, measured: false, reason: 'empty-run' };
  return { ...base, measured: true, requests, throttles, workloads };
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function summarize(group) {
  const { samples } = group;
  const requests = samples.map((sample) => sample.requests);
  const totalRequests = requests.reduce((sum, value) => sum + value, 0);
  const totalThrottles = samples.reduce((sum, sample) => sum + sample.throttles, 0);
  const durations = samples.map((sample) => sample.durationMs).filter(Number.isFinite);
  const workloads = {};
  for (const sample of samples) {
    for (const [workload, counts] of Object.entries(sample.workloads)) {
      workloads[workload] ??= { requests: 0, throttles: 0, runs: 0 };
      workloads[workload].requests += counts.requests;
      workloads[workload].throttles += counts.throttles;
      workloads[workload].runs += 1;
    }
  }
  const observed = samples.map((sample) => sample.observedAt).sort();
  return {
    kind: group.kind,
    tier: group.tier,
    samples: samples.length,
    unmeasuredRuns: group.unmeasured,
    jobKinds: [...group.jobKinds].sort(),
    window: { from: group.from, to: group.to, firstSample: observed[0] ?? null, lastSample: observed.at(-1) ?? null },
    requestsPerRun: samples.length ? { median: percentile(requests, 0.5), p90: percentile(requests, 0.9), max: Math.max(...requests) } : null,
    totalRequests,
    totalThrottles,
    throttleRatio: totalRequests > 0 ? totalThrottles / totalRequests : 0,
    throttledRuns: samples.filter((sample) => sample.throttles > 0).length,
    durationMs: durations.length ? { median: percentile(durations, 0.5), p90: percentile(durations, 0.9) } : null,
    workloads,
  };
}

/** Group observations by kind and tier inside the sample window (from, now]. */
export function aggregateObservations(observations, { now = new Date(), windowMs = FORECAST_WINDOW_MS } = {}) {
  const to = new Date(now).valueOf();
  const from = to - windowMs;
  const groups = new Map();
  for (const observation of observations) {
    const at = Date.parse(observation?.observedAt ?? '');
    if (!(at > from && at <= to)) continue;
    const key = `${observation.kind}:${observation.tier}`;
    if (!groups.has(key)) {
      groups.set(key, { kind: observation.kind, tier: observation.tier, samples: [], unmeasured: 0,
        jobKinds: new Set(), from: new Date(from).toISOString(), to: new Date(to).toISOString() });
    }
    const group = groups.get(key);
    if (observation.jobKind) group.jobKinds.add(observation.jobKind);
    if (observation.measured) group.samples.push(observation);
    else group.unmeasured += 1;
  }
  return new Map([...groups].map(([key, group]) => [key, summarize(group)]));
}

/** How often a schedule fires, from its own cadence: runs a day, shortest gap, upcoming runs. */
export function cadenceTiming(schedule, now = new Date()) {
  validateSchedule(schedule);
  const due = new Date(schedule.next_due_at ?? now);
  let at = Number.isFinite(due.valueOf()) ? due : new Date(now);
  const end = at.valueOf() + WEEK;
  const runs = [];
  // The floor is 15 minutes, so a week holds at most 672 firings.
  while (at.valueOf() < end && runs.length <= 7 * 96) {
    runs.push(at);
    at = nextDueAt(schedule, at);
  }
  let intervalMs = Infinity;
  for (let i = 1; i < runs.length; i++) intervalMs = Math.min(intervalMs, runs[i] - runs[i - 1]);
  if (schedule.cron_override == null) {
    intervalMs = { hour: HOUR, day: DAY, week: WEEK }[schedule.cadence.every] * schedule.cadence.n;
  } else if (!Number.isFinite(intervalMs)) intervalMs = WEEK;
  return { runsPerDay: schedule.cron_override == null ? DAY / intervalMs : runs.length / 7, intervalMs, nextRuns: runs.slice(0, 5) };
}

function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { weekday, hour: Number(parts.hour), minute: Number(parts.minute), label: `${parts.weekday} ${parts.hour}:${parts.minute}` };
}

/**
 * Presentation only: where upcoming UTC runs fall in a time zone's business hours.
 * An unknown time zone falls back to UTC and says so; nothing here changes a due time.
 */
export function businessHoursPresentation(runs, timeZone = 'UTC', hours = BUSINESS_HOURS) {
  let zone = typeof timeZone === 'string' && timeZone ? timeZone : 'UTC';
  let fallback = false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); } catch { zone = 'UTC'; fallback = true; }
  const shown = runs.map((run) => {
    const local = zonedParts(run, zone);
    return {
      at: new Date(run).toISOString(),
      local: local.label,
      businessHours: hours.weekdays.includes(local.weekday) && local.hour >= hours.startHour && local.hour < hours.endHour,
    };
  });
  return {
    timeZone: zone,
    timeZoneFallback: fallback,
    scheduling: 'UTC',
    businessHours: { startHour: hours.startHour, endHour: hours.endHour, weekdays: [...hours.weekdays] },
    runs: shown,
    inBusinessHours: shown.filter((run) => run.businessHours).length,
  };
}

/** The cadence an acknowledgement was given for; any cadence change voids it. */
export function cadenceKey(schedule) {
  return JSON.stringify({ cadence: schedule.cadence ?? null, cron: schedule.cron_override ?? null });
}

/** Legacy-read: a missing or malformed stored acknowledgement is no acknowledgement. */
export function readAcknowledgement(schedule) {
  const ack = schedule?.forecast_acknowledgement;
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return null;
  if (!Array.isArray(ack.codes) || ack.codes.some((code) => !FORECAST_WARNING_CODES.includes(code))) return null;
  if (typeof ack.acknowledgedBy !== 'string' || typeof ack.acknowledgedAt !== 'string' || typeof ack.cadenceKey !== 'string') return null;
  return ack.cadenceKey === cadenceKey(schedule) ? ack : null;
}

/**
 * The slower cadence that would clear the warnings, rounded up to whole hours, days
 * or weeks, never faster than today, never below the job kind's interval floor and
 * never slower than a week. It is checked by validateSchedule() like any save.
 */
export function proposeCadence(schedule, neededMs, { currentIntervalMs } = {}) {
  const floorMs = MINIMUM_INTERVAL_MS[schedule.job_kind];
  const current = currentIntervalMs ?? cadenceTiming(schedule).intervalMs;
  const target = Math.min(Math.max(neededMs, floorMs, current), MAX_PROPOSED_INTERVAL_MS);
  let cadence;
  if (target <= DAY - HOUR) cadence = { every: 'hour', n: Math.ceil(target / HOUR), atTime: null };
  else if (target <= WEEK - DAY) {
    cadence = { every: 'day', n: Math.max(1, Math.ceil(target / DAY)), atTime: schedule.cadence?.atTime ?? '00:00' };
  } else cadence = { every: 'week', n: 1, atTime: schedule.cadence?.atTime ?? '00:00' };
  if (cadence.every === 'hour' && cadence.n >= 24) cadence = { every: 'day', n: 1, atTime: schedule.cadence?.atTime ?? '00:00' };
  validateSchedule({ ...schedule, cadence, cron_override: null });
  const intervalMs = { hour: HOUR, day: DAY, week: WEEK }[cadence.every] * cadence.n;
  return {
    cadence,
    intervalMs,
    floorMs,
    unchanged: intervalMs <= current && schedule.cron_override == null
      && cadence.every === schedule.cadence?.every && cadence.n === schedule.cadence?.n,
    cappedAtMaximum: neededMs > MAX_PROPOSED_INTERVAL_MS,
  };
}

function confidenceFor(samples) {
  if (samples >= 30) return 'high';
  if (samples >= 10) return 'medium';
  return 'low';
}

/**
 * The advisory forecast for one schedule. Only collect schedules call Microsoft
 * Graph; other kinds return null. Insufficient samples yield status "unknown".
 */
export function forecastSchedule(schedule, aggregates, { now = new Date(), timeZone = 'UTC', minSamples = MIN_SAMPLES } = {}) {
  if (schedule.job_kind !== 'collect') return null;
  const timing = cadenceTiming(schedule, now);
  const aggregate = aggregates.get(`collect:${schedule.tier}`) ?? null;
  const samples = aggregate?.samples ?? 0;
  const acknowledgement = readAcknowledgement(schedule);
  const base = {
    scheduleId: schedule.id,
    jobKind: schedule.job_kind,
    tier: schedule.tier,
    advisory: true,
    guarantee: false,
    floorMs: MINIMUM_INTERVAL_MS[schedule.job_kind],
    runsPerDay: timing.runsPerDay,
    intervalMs: timing.intervalMs,
    samples,
    minSamples,
    unmeasuredRuns: aggregate?.unmeasuredRuns ?? 0,
    window: aggregate?.window ?? null,
    presentation: businessHoursPresentation(timing.nextRuns, timeZone),
  };
  if (samples < minSamples) {
    return { ...base, status: 'unknown', reason: samples === 0 && base.unmeasuredRuns === 0 ? 'no-samples' : 'insufficient-samples',
      confidence: null, estimate: null, warnings: [], proposal: null, acknowledgement: null };
  }
  const estimate = {
    requestsPerRun: aggregate.requestsPerRun,
    projectedRequestsPerDay: Math.round(aggregate.requestsPerRun.p90 * timing.runsPerDay),
    throttleRatio: aggregate.throttleRatio,
    throttledRuns: aggregate.throttledRuns,
    durationMs: aggregate.durationMs,
    workloads: aggregate.workloads,
  };
  const warnings = [];
  if (aggregate.throttleRatio >= THROTTLE_WARN_RATIO || aggregate.throttledRuns / samples >= THROTTLED_RUN_SHARE) {
    warnings.push({ code: 'throttle-heavy', throttleRatio: aggregate.throttleRatio, throttledRuns: aggregate.throttledRuns,
      neededIntervalMs: timing.intervalMs * 2 });
  }
  const slow = aggregate.durationMs?.p90;
  if (Number.isFinite(slow) && slow >= timing.intervalMs * OVERLAP_RATIO) {
    warnings.push({ code: 'overlap', durationP90Ms: slow, neededIntervalMs: Math.ceil(slow * 2) });
  }
  const proposal = warnings.length
    ? proposeCadence(schedule, Math.max(...warnings.map((warning) => warning.neededIntervalMs)), { currentIntervalMs: timing.intervalMs })
    : null;
  const acknowledged = new Set(acknowledgement?.codes ?? []);
  return {
    ...base,
    status: warnings.length ? 'warning' : 'ok',
    reason: null,
    confidence: confidenceFor(samples),
    estimate,
    warnings: warnings.map((warning) => ({ ...warning, acknowledged: acknowledged.has(warning.code) })),
    proposal,
    acknowledgement: warnings.length && acknowledgement ? acknowledgement : null,
  };
}

/** Measured collection runs for one tenant inside the window: one query for jobs, one for snapshots. */
export async function loadCollectionObservations(client, { tenantRef, now = new Date(), windowMs = FORECAST_WINDOW_MS }) {
  const to = new Date(now);
  const from = new Date(to.valueOf() - windowMs);
  const { rows: jobs } = await client.query(
    `SELECT id, kind, status, params, result, error, started_at, finished_at FROM job
     WHERE kind IN ('collect', 'backup') AND status IN ('succeeded', 'failed')
     AND finished_at > $1 AND finished_at <= $2
     AND (params->>'tenantRef' IS NULL OR params->>'tenantRef' = $3)
     ORDER BY finished_at, id`, [from, to, tenantRef],
  );
  const ids = [...new Set(jobs.map(snapshotIdForJob).filter(Boolean))];
  const { rows: snapshots } = ids.length
    ? await client.query('SELECT id::text AS id, coverage_digest FROM snapshot WHERE id = ANY($1::uuid[]) AND tenant_ref = $2', [ids, tenantRef])
    : { rows: [] };
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  return jobs.flatMap((job) => {
    const snapshot = byId.get(snapshotIdForJob(job));
    // A job that names no tenant is attributed only through a snapshot of this tenant.
    if (!snapshot && job.params?.tenantRef !== tenantRef) return [];
    return [runObservation({ job, snapshot })];
  });
}

/**
 * Every collect schedule's forecast for the tenant. Checks the read grant server-side
 * and resolves the acknowledging person's email in one query.
 */
export async function loadScheduleForecasts(client, principal, { tenantRef, now = new Date(), windowMs = FORECAST_WINDOW_MS, timeZone = 'UTC' }) {
  // Authorization is always checked at the wall clock, never at the forecast instant.
  if (!(await can(client, principal, 'read'))) throw new Error('not authorized to read schedules');
  const { rows: schedules } = await client.query(
    'SELECT * FROM schedule WHERE tenant_ref = $1 ORDER BY job_kind, tier NULLS LAST, id', [tenantRef],
  );
  const aggregates = aggregateObservations(await loadCollectionObservations(client, { tenantRef, now, windowMs }), { now, windowMs });
  const forecasts = schedules.flatMap((schedule) => {
    try {
      const forecast = forecastSchedule(schedule, aggregates, { now, timeZone });
      return forecast ? [forecast] : [];
    } catch (error) {
      return [{ scheduleId: schedule.id, jobKind: schedule.job_kind, tier: schedule.tier, advisory: true, guarantee: false,
        status: 'unknown', reason: 'invalid-schedule', error: error.message, samples: 0, minSamples: MIN_SAMPLES,
        unmeasuredRuns: 0, estimate: null, warnings: [], proposal: null, acknowledgement: null, presentation: null }];
    }
  });
  const people = [...new Set(forecasts.map((forecast) => forecast.acknowledgement?.acknowledgedBy).filter((id) => UUID.test(id ?? '')))];
  const { rows: names } = people.length
    ? await client.query('SELECT id::text AS id, email FROM principal WHERE id = ANY($1::uuid[])', [people])
    : { rows: [] };
  const emailById = new Map(names.map((row) => [row.id, row.email]));
  for (const forecast of forecasts) {
    if (forecast.acknowledgement) {
      forecast.acknowledgement = { ...forecast.acknowledgement, acknowledgedByName: emailById.get(forecast.acknowledgement.acknowledgedBy) ?? null };
    }
  }
  return { generatedAt: new Date(now).toISOString(), windowMs, minSamples: MIN_SAMPLES, timeZone, forecasts };
}

/**
 * Accept a current warning without changing the cadence. Needs the configuration
 * grant at the moment of the call; only warnings the forecast raises right now can
 * be acknowledged; the acknowledgement is void once the cadence changes. Nothing
 * here touches cadence, enabled or next_due_at, so the floor still governs.
 */
export async function acknowledgeForecastWarning(client, principal, { tenantRef, scheduleId, codes, now = new Date(), windowMs = FORECAST_WINDOW_MS }) {
  // The grant is checked at the wall clock: a caller-chosen instant cannot revive it.
  if (!(await can(client, principal, 'configuration'))) throw new Error('not authorized to edit schedules');
  if (!Array.isArray(codes) || codes.length === 0 || new Set(codes).size !== codes.length
    || codes.some((code) => !FORECAST_WARNING_CODES.includes(code))) {
    throw new Error('invalid forecast warning codes');
  }
  await client.query('BEGIN');
  try {
    const { rows: [schedule] } = await client.query(
      'SELECT * FROM schedule WHERE id = $1 AND tenant_ref = $2 FOR UPDATE', [scheduleId, tenantRef],
    );
    if (!schedule) throw new Error('schedule not found');
    const aggregates = aggregateObservations(await loadCollectionObservations(client, { tenantRef, now, windowMs }), { now, windowMs });
    const forecast = forecastSchedule(schedule, aggregates, { now });
    const current = new Set((forecast?.warnings ?? []).map((warning) => warning.code));
    if (codes.some((code) => !current.has(code))) throw new Error('forecast_warning_not_current');
    const acknowledgement = {
      codes: [...codes].sort(),
      acknowledgedBy: principal.id,
      acknowledgedAt: new Date(now).toISOString(),
      cadenceKey: cadenceKey(schedule),
      samples: forecast.samples,
    };
    await client.query('UPDATE schedule SET forecast_acknowledgement = $2, updated_at = now() WHERE id = $1',
      [schedule.id, JSON.stringify(acknowledgement)]);
    await client.query('COMMIT');
    return acknowledgement;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
