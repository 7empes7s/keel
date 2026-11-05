// Issue #1010: a scheduler tick that can't reach the database can't write anything to it,
// so the gap is kept in a small file on the host (no secrets in it) and written to the
// audit record, per tenant with schedules, on the first tick that reaches the database
// again. Activity then shows "the scheduler couldn't reach the database" instead of
// silence (the 2026-11-04 outage, #1005, went 16 hours unnoticed).
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendEvidence } from '../govern/evidence.mjs';

export const OUTAGE_FILE = 'database-unreachable.json';

async function readOutage(stateDir) {
  try {
    return JSON.parse(await readFile(join(stateDir, OUTAGE_FILE), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** One missed tick: starts the gap, or extends it. Returns the gap so far. */
export async function noteUnreachable(stateDir, { reason, now = new Date() }) {
  const previous = await readOutage(stateDir);
  const outage = {
    since: previous?.since ?? now.toISOString(),
    lastAt: now.toISOString(),
    reason: String(reason),
    missedTicks: (previous?.missedTicks ?? 0) + 1,
  };
  const path = join(stateDir, OUTAGE_FILE);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, `${JSON.stringify(outage)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  return outage;
}

/**
 * The database answers again: one audit entry per tenant with an enabled schedule, saying
 * how long the scheduler couldn't reach it and how many of that tenant's schedules fell
 * due meanwhile (the next ticks run them, late). Clears the file only after every entry
 * is written, so a failure part way retries on the next tick.
 */
export async function recordRecovery(client, stateDir, { actor, now = new Date() }) {
  const outage = await readOutage(stateDir);
  if (!outage) return [];
  const { rows } = await client.query(
    `SELECT tenant_ref, count(*) FILTER (WHERE next_due_at <= $1)::int AS late
       FROM schedule WHERE enabled GROUP BY tenant_ref ORDER BY tenant_ref`, [now],
  );
  const records = [];
  for (const { tenant_ref: tenantRef, late } of rows) {
    records.push(await appendEvidence(client, {
      tenantRef,
      kind: 'scheduler.database-unreachable',
      actor,
      subject: { since: outage.since, until: now.toISOString(), reason: outage.reason, missedTicks: outage.missedTicks, lateSchedules: late },
    }));
  }
  await rm(join(stateDir, OUTAGE_FILE), { force: true });
  return records;
}
