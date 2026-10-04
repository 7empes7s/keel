// One-time timer migration. Re-running preserves operator edits and persisted due times.
// Host timers run in Etc/UTC: hourly at :00, daily at midnight, weekly Monday midnight.
export function initialSchedules(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) throw new Error('invalid seed time');
  const hourly = new Date(now);
  hourly.setUTCMinutes(0, 0, 0);
  hourly.setUTCHours(hourly.getUTCHours() + 1);
  const daily = new Date(now);
  daily.setUTCHours(0, 0, 0, 0);
  daily.setUTCDate(daily.getUTCDate() + 1);
  const weekly = new Date(daily);
  weekly.setUTCDate(weekly.getUTCDate() + (8 - weekly.getUTCDay()) % 7);
  const offsite = new Date(now);
  offsite.setUTCHours(5, 0, 0, 0);
  if (offsite <= now) offsite.setUTCDate(offsite.getUTCDate() + 1);
  // Task 62: official Graph metadata drifts slowly; a weekly comparison is the
  // default cadence, operator-tunable through the schedule row like every other kind.
  const weeklyMetadata = new Date(weekly);
  weeklyMetadata.setUTCHours(3, 0, 0, 0);
  return [
    { jobKind: 'collect', tier: 'tier1', cadence: { every: 'hour', n: 1, atTime: null }, nextDueAt: hourly },
    { jobKind: 'collect', tier: 'tier2', cadence: { every: 'day', n: 1, atTime: '00:00' }, nextDueAt: daily },
    { jobKind: 'collect', tier: 'tier3', cadence: { every: 'week', n: 1, atTime: '00:00' }, cronOverride: '0 0 * * 1', nextDueAt: weekly },
    { jobKind: 'prune', tier: null, cadence: { every: 'day', n: 1, atTime: '00:00' }, nextDueAt: daily },
    { jobKind: 'offsite', tier: null, cadence: { every: 'day', n: 1, atTime: '05:00' }, nextDueAt: offsite },
    { jobKind: 'api-drift', tier: null, cadence: { every: 'week', n: 1, atTime: '03:00' }, cronOverride: '0 3 * * 1', nextDueAt: weeklyMetadata },
  ];
}

// jobKinds limits the seed to those kinds, so a host can turn on collection before
// prune and offsite are ready; a later run with the remaining kinds adds them.
export async function seedSchedules(client, { tenantRef, now = new Date(), jobKinds }) {
  if (typeof tenantRef !== 'string' || !tenantRef.trim()) throw new Error('tenantRef is required');
  let schedules = initialSchedules(now);
  if (jobKinds !== undefined) {
    const known = new Set(schedules.map((row) => row.jobKind));
    if (!Array.isArray(jobKinds) || jobKinds.length === 0 || jobKinds.some((kind) => !known.has(kind))) {
      throw new Error(`jobKinds must be a non-empty list of: ${[...known].join(', ')}`);
    }
    schedules = schedules.filter((row) => jobKinds.includes(row.jobKind));
  }
  await client.query('BEGIN');
  try {
    for (const row of schedules) {
      await client.query(
        `INSERT INTO schedule (tenant_ref, job_kind, tier, cadence, cron_override, next_due_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_ref, job_kind, (COALESCE(tier, ''))) DO NOTHING`,
        [tenantRef, row.jobKind, row.tier, row.cadence, row.cronOverride ?? null, row.nextDueAt],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
