#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { connect } from '../engine/store/db.mjs';
import { enqueue } from '../engine/jobs/queue.mjs';
import { capabilitiesForPrincipal } from '../engine/authz/principals.mjs';
import { nextDueAt, validateSchedule } from '../engine/schedules/cadence.mjs';
import { processCollectionCompletions } from '../engine/schedules/completions.mjs';

export async function schedulerPrincipal(client) {
  const { rows: [principal] } = await client.query(
    `INSERT INTO principal (email, display_name, system_kind)
     VALUES ('scheduler@keel.internal', 'KEEL scheduler', 'scheduler')
     ON CONFLICT (lower(email)) DO UPDATE SET email = principal.email RETURNING *`,
  );
  const capabilities = await capabilitiesForPrincipal(client, principal);
  if (principal.system_kind !== 'scheduler' || capabilities.length !== 2
      || !capabilities.includes('collect') || !capabilities.includes('configuration')) {
    throw new Error('scheduler principal must hold exactly collect + configuration');
  }
  return principal;
}

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
      validateSchedule(row);
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

async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: keel-scheduler.mjs (with KEEL_DB_URL set)');
    return;
  }
  if (!process.env.KEEL_DB_URL) throw new Error('KEEL_DB_URL is required');
  const client = await connect(process.env.KEEL_DB_URL);
  try { console.log(`scheduler: ${ (await tick(client)).length } scheduled job(s)`); }
  finally { await client.end(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
