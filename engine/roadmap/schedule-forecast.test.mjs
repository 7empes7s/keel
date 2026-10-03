// Roadmap task-110: measured schedule load warnings.
//
// Boundary tests for engine/schedules/forecast.mjs against the real collector seam
// (collectWithOutcomes with a counting reader), the real job/snapshot/schedule tables
// in an isolated database, the real authorization check and the real scheduler tick.
//
// Acceptance: tier-scoped request counts determine the forecast; no samples yields
// unknown; throttle-heavy history warns; an advisory acknowledgement cannot bypass the
// minimum cadence floor or the current authorization.
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole, revokeRole } from '../authz/administration.mjs';
import { collectWithOutcomes, M1_TYPES } from '../collect/entraAdapter.mjs';
import { get } from '../collect/registry.mjs';
import { updateSchedule } from '../schedules/cadence.mjs';
import {
  acknowledgeForecastWarning, aggregateObservations, businessHoursPresentation, forecastSchedule,
  loadScheduleForecasts, MIN_SAMPLES, runObservation, workloadFor,
} from '../schedules/forecast.mjs';
import { seedSchedules } from '../store/scheduleSeed.mjs';
import { collectionCostMetrics, graphRequestObservation } from '../telemetry/events.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { tick } from '../../cli/keel-scheduler.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';

const PATH = new Map(CATALOG.map((entry) => [entry.type, entry.path]));

const HOUR = 3_600_000;
const NOW = new Date('2026-10-03T12:00:00Z');

/** A fake Graph reader with the same counters GraphReader keeps. */
function countingReader({ pages = 1, throttlesPerType = 0 } = {}) {
  const reader = {
    stats: { requests: 0, throttled: 0 },
    async collect() {
      reader.stats.requests += pages + throttlesPerType;
      reader.stats.throttled += throttlesPerType;
      return { items: Array.from({ length: 250 }, (_, i) => ({ id: `i-${i}`, displayName: `Item ${i}` })), pages, status: 200, error: null };
    },
  };
  return reader;
}

test('the collector records measured requests and throttles per type, separately from the item count', async () => {
  const { coverageDigest } = await collectWithOutcomes(countingReader({ pages: 3, throttlesPerType: 1 }), { tenantId: 'fixture', tier: 'tier1' });
  const tier1 = M1_TYPES.filter((type) => get(type).descriptor.criticality === 'tier1');
  for (const type of tier1) {
    assert.equal(coverageDigest[type].itemCount, 250);
    assert.equal(coverageDigest[type].requests, 4, `${type}: three pages plus one throttled retry`);
    assert.equal(coverageDigest[type].throttles, 1);
  }
  const cost = collectionCostMetrics(coverageDigest);
  assert.deepEqual(cost, { graphRequests: 4 * tier1.length, graphThrottles: tier1.length, measuredTypes: tier1.length, unmeasuredTypes: 0 });

  // A reader without counters leaves the fields out: unmeasured, never zero.
  const legacy = await collectWithOutcomes({ async collect() { return { items: [], pages: 1, status: 200, error: null }; } }, { tenantId: 'fixture', tier: 'tier1' });
  assert.equal('requests' in legacy.coverageDigest.organization, false);
  assert.equal(graphRequestObservation(legacy.coverageDigest.organization), null);
  assert.deepEqual(collectionCostMetrics(legacy.coverageDigest), { graphRequests: null, graphThrottles: null, measuredTypes: 0, unmeasuredTypes: tier1.length });
  // Malformed counts are not observations either.
  assert.equal(graphRequestObservation({ outcome: 'complete', requests: 2, throttles: 3 }), null);
  assert.equal(graphRequestObservation({ outcome: 'complete', requests: -1, throttles: 0 }), null);
});

test('workloads follow the Graph service the endpoint belongs to', () => {
  assert.equal(workloadFor('/deviceManagement/deviceConfigurations'), 'intune');
  assert.equal(workloadFor('https://graph.microsoft.com/beta/deviceAppManagement/mobileApps'), 'intune');
  assert.equal(workloadFor('/identityGovernance/accessReviews/definitions'), 'identity-governance');
  assert.equal(workloadFor('/identity/conditionalAccess/policies'), 'directory');
  assert.equal(workloadFor(null), 'unknown');
});

test('business hours are presentation only: UTC runs shown in a zone, unknown zones fall back to UTC', () => {
  const runs = [new Date('2026-10-05T07:00:00Z'), new Date('2026-10-05T17:00:00Z'), new Date('2026-10-04T09:00:00Z')];
  const paris = businessHoursPresentation(runs, 'Europe/Paris');
  assert.equal(paris.scheduling, 'UTC');
  assert.deepEqual(paris.runs.map((run) => [run.at, run.local, run.businessHours]), [
    ['2026-10-05T07:00:00.000Z', 'Mon 09:00', true],
    ['2026-10-05T17:00:00.000Z', 'Mon 19:00', false],
    ['2026-10-04T09:00:00.000Z', 'Sun 11:00', false],
  ]);
  assert.equal(paris.inBusinessHours, 1);
  const bad = businessHoursPresentation(runs, 'Not/AZone');
  assert.equal(bad.timeZone, 'UTC');
  assert.equal(bad.timeZoneFallback, true);
  assert.equal(bad.runs[0].local, 'Mon 07:00');
});

// ------------------------------------------------------------------ DB integration
const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const tenantRefOf = (id) => `sha256:${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;

function digestFor(tier, { requests = 10, throttles = 0, itemCount = 5000, legacy = false } = {}) {
  const digest = {};
  for (const type of M1_TYPES) {
    const { descriptor } = get(type);
    if (descriptor.criticality !== tier) { digest[type] = { outcome: 'not-requested', itemCount: null }; continue; }
    digest[type] = {
      outcome: 'complete', itemCount, pagesCompleted: requests - throttles, endpoint: PATH.get(type),
      ...(legacy ? {} : { requests, throttles }),
    };
  }
  return digest;
}

async function insertRun(client, { tenantRef, tier, kind = 'collect', finishedAt, durationMs = 5 * 60_000, digest, status = 'succeeded', jobTenantRef = tenantRef }) {
  const { rows: [snapshot] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, completed_at, coverage_digest) VALUES ($1, 'complete', $2, $3) RETURNING id::text AS id`,
    [tenantRef, finishedAt, JSON.stringify(digest)],
  );
  const stdout = `collecting graph-native types…\nsnapshot ${snapshot.id} complete\n`;
  await client.query(
    `INSERT INTO job (kind, params, status, requested_by, started_at, finished_at, result, error)
     VALUES ($1, $2, $3, 'scheduler', $4, $5, $6, $7)`,
    [kind, JSON.stringify({ tier, ...(jobTenantRef ? { tenantRef: jobTenantRef } : {}) }), status,
      new Date(new Date(finishedAt).valueOf() - durationMs), finishedAt,
      status === 'succeeded' ? JSON.stringify({ stdout, stderr: '', durationMs }) : null,
      status === 'failed' ? `exit code 1\nstdout: ${stdout}` : null],
  );
  return snapshot.id;
}

async function fixture(t, name) {
  const client = await database.connect();
  t.after(() => client.end());
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const tenantRef = tenantRefOf(`${name}-${randomUUID()}`);
  await seedSchedules(client, { tenantRef, now: NOW });
  const person = async (email, role) => {
    const { rows: [row] } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id::text AS id', [email]);
    const grant = role ? await grantRole(client, { principalId: row.id, role, grantedBy: row.id, activeFrom: '2026-01-01T00:00:00Z' }) : null;
    return { id: row.id, grantId: grant?.id ?? null };
  };
  const suffix = randomUUID().slice(0, 8);
  const viewer = await person(`viewer-${suffix}@contoso.com`, 'viewer');
  const admin = await person(`admin-${suffix}@contoso.com`, 'admin');
  await grantRole(client, { principalId: admin.id, role: 'viewer', grantedBy: admin.id, activeFrom: '2026-01-01T00:00:00Z' });
  const nobody = await person(`nobody-${suffix}@contoso.com`, null);
  const schedule = async (tier) => (await client.query(
    "SELECT * FROM schedule WHERE tenant_ref = $1 AND job_kind = 'collect' AND tier = $2", [tenantRef, tier])).rows[0];
  return { client, tenantRef, viewer, admin, nobody, schedule };
}

const at = (hoursAgo) => new Date(NOW.valueOf() - hoursAgo * HOUR).toISOString();
const byTier = (result, tier) => result.forecasts.find((forecast) => forecast.tier === tier);

test('acceptance: tier-scoped measured request counts determine the forecast, never the resource count (mutation: resource count as requests)', async (t) => {
  const { client, tenantRef, viewer } = await fixture(t, 'tier-scoped');
  // Tier 1: 40 requests per type per run while each type holds 5,000 resources.
  for (const hoursAgo of [1, 2, 3, 4]) await insertRun(client, { tenantRef, tier: 'tier1', finishedAt: at(hoursAgo), digest: digestFor('tier1', { requests: 40 }) });
  // Tier 2 runs are far heavier; they must not leak into tier 1.
  for (const hoursAgo of [5, 29, 53]) await insertRun(client, { tenantRef, tier: 'tier2', finishedAt: at(hoursAgo), digest: digestFor('tier2', { requests: 900 }) });
  // Another tenant's tier 1 runs (both by job and by snapshot) are invisible here.
  const other = tenantRefOf('other-tenant');
  for (const hoursAgo of [1, 2, 3]) await insertRun(client, { tenantRef: other, tier: 'tier1', finishedAt: at(hoursAgo), digest: digestFor('tier1', { requests: 7000 }) });
  await insertRun(client, { tenantRef: other, jobTenantRef: null, tier: 'tier1', finishedAt: at(1.5), digest: digestFor('tier1', { requests: 7000 }) });

  const result = await loadScheduleForecasts(client, { id: viewer.id }, { tenantRef, now: NOW });
  const tier1Types = M1_TYPES.filter((type) => get(type).descriptor.criticality === 'tier1').length;
  const tier1 = byTier(result, 'tier1');
  assert.equal(tier1.status, 'ok');
  assert.equal(tier1.samples, 4);
  assert.equal(tier1.advisory, true);
  assert.equal(tier1.guarantee, false);
  assert.deepEqual(tier1.estimate.requestsPerRun, { median: 40 * tier1Types, p90: 40 * tier1Types, max: 40 * tier1Types });
  assert.equal(tier1.runsPerDay, 24, 'tier 1 is seeded hourly');
  assert.equal(tier1.estimate.projectedRequestsPerDay, 40 * tier1Types * 24);
  assert.equal(tier1.confidence, 'low');
  assert.ok(tier1.estimate.workloads.directory.requests > 0);

  const tier2 = byTier(result, 'tier2');
  const tier2Types = M1_TYPES.filter((type) => get(type).descriptor.criticality === 'tier2').length;
  assert.equal(tier2.samples, 3);
  assert.equal(tier2.estimate.projectedRequestsPerDay, 900 * tier2Types);
  // Only collect schedules call Microsoft; prune, offsite and api-drift have no forecast.
  assert.deepEqual(result.forecasts.map((forecast) => forecast.jobKind), ['collect', 'collect', 'collect']);
  assert.ok(result.forecasts.every((forecast) => forecast.presentation.scheduling === 'UTC'));
});

test('acceptance: no samples yields unknown; legacy runs without counters and too few runs stay unknown (mutation: invent an estimate)', async (t) => {
  const { client, tenantRef, viewer } = await fixture(t, 'unknown');
  // Tier 2: legacy digests (no counters) — counted as unmeasured, never as cheap runs.
  for (const hoursAgo of [2, 26, 50, 74]) await insertRun(client, { tenantRef, tier: 'tier2', finishedAt: at(hoursAgo), digest: digestFor('tier2', { legacy: true }) });
  // Tier 3: one measured run inside the window and three outside it.
  await insertRun(client, { tenantRef, tier: 'tier3', finishedAt: at(10), digest: digestFor('tier3', { requests: 5 }) });
  for (const hoursAgo of [15 * 24, 16 * 24, 20 * 24]) await insertRun(client, { tenantRef, tier: 'tier3', finishedAt: at(hoursAgo), digest: digestFor('tier3', { requests: 5 }) });

  const result = await loadScheduleForecasts(client, { id: viewer.id }, { tenantRef, now: NOW });
  const tier1 = byTier(result, 'tier1');
  assert.equal(tier1.status, 'unknown');
  assert.equal(tier1.reason, 'no-samples');
  assert.equal(tier1.samples, 0);
  assert.equal(tier1.estimate, null);
  assert.equal(tier1.confidence, null);
  assert.deepEqual(tier1.warnings, []);
  assert.equal(tier1.proposal, null);

  const tier2 = byTier(result, 'tier2');
  assert.equal(tier2.status, 'unknown');
  assert.equal(tier2.reason, 'insufficient-samples');
  assert.equal(tier2.samples, 0);
  assert.equal(tier2.unmeasuredRuns, 4);
  assert.equal(tier2.estimate, null);

  const tier3 = byTier(result, 'tier3');
  assert.equal(tier3.status, 'unknown');
  assert.equal(tier3.samples, 1);
  assert.ok(tier3.samples < MIN_SAMPLES);
  assert.equal(tier3.estimate, null);
});

test('acceptance: throttle-heavy history warns with a bounded, slower proposal at or above the floor', async (t) => {
  const { client, tenantRef, viewer } = await fixture(t, 'throttle');
  // 10 of every 100 requests were told to back off.
  for (const hoursAgo of [1, 2, 3]) await insertRun(client, { tenantRef, tier: 'tier1', finishedAt: at(hoursAgo), digest: digestFor('tier1', { requests: 100, throttles: 10 }) });
  // Tier 2 runs take 23 hours on a daily cadence: they will collide with the next run.
  for (const hoursAgo of [1, 25, 49]) await insertRun(client, { tenantRef, tier: 'tier2', finishedAt: at(hoursAgo), durationMs: 23 * HOUR, digest: digestFor('tier2', { requests: 20 }) });

  const result = await loadScheduleForecasts(client, { id: viewer.id }, { tenantRef, now: NOW });
  const tier1 = byTier(result, 'tier1');
  assert.equal(tier1.status, 'warning');
  assert.deepEqual(tier1.warnings.map((warning) => warning.code), ['throttle-heavy']);
  assert.ok(Math.abs(tier1.estimate.throttleRatio - 0.1) < 1e-9);
  assert.deepEqual(tier1.proposal.cadence, { every: 'hour', n: 2, atTime: null });
  assert.ok(tier1.proposal.intervalMs >= tier1.floorMs);
  assert.ok(tier1.proposal.intervalMs > tier1.intervalMs, 'a proposal never runs more often than today');

  const tier2 = byTier(result, 'tier2');
  assert.deepEqual(tier2.warnings.map((warning) => warning.code), ['overlap']);
  assert.deepEqual(tier2.proposal.cadence, { every: 'day', n: 2, atTime: '00:00' });

  // The same history without throttles does not warn.
  const calm = aggregateObservations([1, 2, 3].map((hoursAgo) => runObservation({
    job: { id: `j${hoursAgo}`, kind: 'collect', params: { tier: 'tier1' }, started_at: at(hoursAgo + 0.1), finished_at: at(hoursAgo) },
    snapshot: { coverage_digest: digestFor('tier1', { requests: 100 }) },
  })), { now: NOW });
  const schedule = { id: 's', job_kind: 'collect', tier: 'tier1', cadence: { every: 'hour', n: 1, atTime: null }, cron_override: null, next_due_at: NOW };
  assert.equal(forecastSchedule(schedule, calm, { now: NOW }).status, 'ok');
  // A proposal for a throttled weekly schedule is capped at a week, never "never".
  const weekly = forecastSchedule({ ...schedule, cadence: { every: 'week', n: 1, atTime: '00:00' } },
    aggregateObservations([1, 2, 3].map((hoursAgo) => runObservation({
      job: { id: `w${hoursAgo}`, kind: 'collect', params: { tier: 'tier1' }, started_at: at(hoursAgo + 0.1), finished_at: at(hoursAgo) },
      snapshot: { coverage_digest: digestFor('tier1', { requests: 100, throttles: 50 }) },
    })), { now: NOW }), { now: NOW });
  assert.equal(weekly.proposal.cappedAtMaximum, true);
  assert.equal(weekly.proposal.unchanged, true);
});

test('acceptance: acknowledging a warning cannot bypass the floor or current authorization (mutation: disable runtime floor after accepting)', async (t) => {
  const { client, tenantRef, viewer, admin, nobody, schedule } = await fixture(t, 'acknowledge');
  for (const hoursAgo of [1, 2, 3]) await insertRun(client, { tenantRef, tier: 'tier1', finishedAt: at(hoursAgo), digest: digestFor('tier1', { requests: 100, throttles: 10 }) });
  const before = await schedule('tier1');

  // Reading needs the read grant; acknowledging needs the configuration grant.
  await assert.rejects(loadScheduleForecasts(client, { id: nobody.id }, { tenantRef, now: NOW }), /not authorized to read schedules/);
  await assert.rejects(acknowledgeForecastWarning(client, { id: viewer.id }, { tenantRef, scheduleId: before.id, codes: ['throttle-heavy'], now: NOW }),
    /not authorized to edit schedules/);
  // Only a warning the forecast raises right now can be acknowledged.
  await assert.rejects(acknowledgeForecastWarning(client, { id: admin.id }, { tenantRef, scheduleId: before.id, codes: ['overlap'], now: NOW }),
    /forecast_warning_not_current/);
  await assert.rejects(acknowledgeForecastWarning(client, { id: admin.id }, { tenantRef, scheduleId: before.id, codes: ['anything'], now: NOW }),
    /invalid forecast warning codes/);
  // A schedule of another tenant is not found.
  await assert.rejects(acknowledgeForecastWarning(client, { id: admin.id }, { tenantRef: tenantRefOf('elsewhere'), scheduleId: before.id, codes: ['throttle-heavy'], now: NOW }),
    /schedule not found/);

  const ack = await acknowledgeForecastWarning(client, { id: admin.id }, { tenantRef, scheduleId: before.id, codes: ['throttle-heavy'], now: NOW });
  assert.equal(ack.acknowledgedBy, admin.id);
  const acknowledged = await schedule('tier1');
  // Acknowledging changes nothing about when the schedule runs.
  assert.deepEqual(acknowledged.cadence, before.cadence);
  assert.equal(acknowledged.cron_override, before.cron_override);
  assert.equal(acknowledged.enabled, before.enabled);
  assert.equal(acknowledged.next_due_at.toISOString(), before.next_due_at.toISOString());

  const shown = byTier(await loadScheduleForecasts(client, { id: viewer.id }, { tenantRef, now: NOW }), 'tier1');
  assert.equal(shown.status, 'warning', 'an acknowledged warning is still a warning');
  assert.equal(shown.warnings[0].acknowledged, true);
  assert.match(shown.acknowledgement.acknowledgedByName, /^admin-/);

  // The interval floor still applies on save after acknowledging.
  await assert.rejects(updateSchedule(client, { id: admin.id }, before.id, { cron_override: '*/5 * * * *' }), /schedule_minimum_interval/);
  await assert.rejects(updateSchedule(client, { id: admin.id }, before.id, { cadence: { every: 'hour', n: 0, atTime: null } }), /invalid structured cadence/);

  // The runtime governor still applies on every tick, even to an acknowledged row that
  // was forced below the floor outside the save path.
  await client.query("UPDATE schedule SET cron_override = '*/5 * * * *', next_due_at = $2 WHERE id = $1", [before.id, at(1)]);
  await assert.rejects(tick(client, { now: NOW }), /schedule_minimum_interval/);
  const { rows: [{ count }] } = await client.query("SELECT count(*)::int AS count FROM job WHERE params->>'tenantRef' = $1 AND status = 'queued'", [tenantRef]);
  assert.equal(count, 0, 'no job is enqueued for a schedule below the floor');
  // The forced cadence also voids the acknowledgement, which was given for another cadence.
  const voided = byTier(await loadScheduleForecasts(client, { id: viewer.id }, { tenantRef, now: NOW }), 'tier1');
  assert.equal(voided.acknowledgement, null);
  await client.query('UPDATE schedule SET cron_override = $2, next_due_at = $3 WHERE id = $1', [before.id, before.cron_override, before.next_due_at]);

  // Authorization is checked at the moment of the next call, not at acknowledgement.
  await revokeRole(client, { principalId: admin.id, grantId: admin.grantId, revokedBy: admin.id });
  await assert.rejects(updateSchedule(client, { id: admin.id }, before.id, { cadence: { every: 'hour', n: 2, atTime: null } }), /not authorized to edit schedules/);
  await assert.rejects(acknowledgeForecastWarning(client, { id: admin.id }, { tenantRef, scheduleId: before.id, codes: ['throttle-heavy'], now: NOW }),
    /not authorized to edit schedules/);
});

test('legacy-read: a malformed stored acknowledgement reads as none, and failed partial collections still count as measured runs', async (t) => {
  const { client, tenantRef, viewer, schedule } = await fixture(t, 'legacy');
  for (const hoursAgo of [1, 2]) await insertRun(client, { tenantRef, tier: 'tier1', finishedAt: at(hoursAgo), digest: digestFor('tier1', { requests: 100, throttles: 30 }) });
  await insertRun(client, { tenantRef, tier: 'tier1', status: 'failed', finishedAt: at(3), digest: digestFor('tier1', { requests: 100, throttles: 30 }) });
  const row = await schedule('tier1');
  await client.query('UPDATE schedule SET forecast_acknowledgement = $2 WHERE id = $1', [row.id, JSON.stringify({ codes: 'throttle-heavy' })]);
  const tier1 = byTier(await loadScheduleForecasts(client, { id: viewer.id }, { tenantRef, now: NOW }), 'tier1');
  assert.equal(tier1.samples, 3);
  assert.equal(tier1.status, 'warning');
  assert.equal(tier1.acknowledgement, null);
  assert.equal(tier1.warnings[0].acknowledged, false);
});
