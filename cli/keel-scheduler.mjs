#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { connect } from '../engine/store/db.mjs';
import { enqueue } from '../engine/jobs/queue.mjs';
import { schedulerPrincipal } from '../engine/authz/systemPrincipal.mjs';
export { schedulerPrincipal } from '../engine/authz/systemPrincipal.mjs';
import { nextDueAt, validateSchedule } from '../engine/schedules/cadence.mjs';
import { processCollectionCompletions } from '../engine/schedules/completions.mjs';
import { noteUnreachable, recordRecovery } from '../engine/schedules/outage.mjs';
import { databaseUnreachableReason } from '../engine/store/unreachable.mjs';
import { parseCliArgs } from './args.mjs';

// Due instant is persisted, so an interrupted retry always addresses the same job.
export async function enqueueSchedule(client, row, requestedBy) {
  return enqueue(client, {
    kind: row.job_kind,
    params: { ...(row.tier ? { tier: row.tier } : {}), tenantRef: row.tenant_ref },
    requestedBy,
    idempotencyKey: `schedule:${row.id}:${new Date(row.next_due_at).toISOString()}`,
  });
}

export async function tick(client, { now = new Date(), afterEnqueue } = {}) {
  const principal = await schedulerPrincipal(client);
  const jobs = [];
  await client.query('BEGIN');
  try {
    const { rows } = await client.query(
      `SELECT * FROM schedule WHERE enabled AND next_due_at <= $1
       ORDER BY next_due_at, id FOR UPDATE SKIP LOCKED`, [now],
    );
    for (const row of rows) {
      // One invalid row must not roll back every other due schedule. It stays due and
      // is reported on each tick until an operator fixes or disables it.
      try { validateSchedule(row); } catch (error) {
        console.error(`scheduler: skipped schedule ${row.id} (${row.job_kind}): ${error.message}`);
        continue;
      }
      const job = await enqueueSchedule(client, row, principal.id);
      if (afterEnqueue) await afterEnqueue(job);
      await client.query(
        `UPDATE schedule SET next_due_at = $2, last_job_id = $3, updated_at = now() WHERE id = $1`,
        [row.id, nextDueAt(row, row.next_due_at), job.id],
      );
      jobs.push(job);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  await processCollectionCompletions(client, principal.id);
  return jobs;
}

// systemd's StateDirectory=keel-scheduler sets STATE_DIRECTORY; the gap file lives there.
export const DEFAULT_STATE_DIR = '/var/lib/keel-scheduler';

/**
 * One timer run. A database that can't be reached is recorded as "database unreachable"
 * (#1010): noted on the host now, written to the audit record once it answers again.
 */
export async function runOnce({ dbUrl, stateDir, connectFn = connect, now = () => new Date(), logger = console }) {
  let client;
  try {
    client = await connectFn(dbUrl);
    await recordRecovery(client, stateDir, { actor: (await schedulerPrincipal(client)).id, now: now() });
    logger.log(`scheduler: ${(await tick(client, { now: now() })).length} scheduled job(s)`);
  } catch (error) {
    const reason = databaseUnreachableReason(error);
    if (!reason) throw error;
    const outage = await noteUnreachable(stateDir, { reason, now: now() });
    logger.error(`scheduler: database unreachable (${reason}); no schedules checked (${outage.missedTicks} missed since ${outage.since})`);
    return { unreachable: reason };
  } finally {
    await client?.end().catch(() => {});
  }
  return { unreachable: null };
}

async function main() {
  if (parseCliArgs(process.argv.slice(2), { name: 'keel-scheduler', booleans: ['help'] }).values.help) {
    console.log('usage: keel-scheduler.mjs (with KEEL_DB_URL set)');
    return;
  }
  if (!process.env.KEEL_DB_URL) throw new Error('KEEL_DB_URL is required');
  const { unreachable } = await runOnce({ dbUrl: process.env.KEEL_DB_URL, stateDir: process.env.STATE_DIRECTORY ?? DEFAULT_STATE_DIR });
  if (unreachable) process.exitCode = 1;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
