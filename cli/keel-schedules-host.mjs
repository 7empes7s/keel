#!/usr/bin/env node
// /opt/keel/cli/keel-schedules-host.mjs
//
// node keel-schedules-host.mjs preflight|run-now|health --tenant-config /etc/keel/tenant.json [--db-url $KEEL_DB_URL]
// node keel-schedules-host.mjs cancel --job ID --reason TEXT [--db-url $KEEL_DB_URL]
//
// Host checks around installing keel-worker and keel-scheduler (issue #91):
//   preflight  read-only. Lists what a worker would pick up the moment it starts: queued or
//              running jobs (none has ever run on a host without a worker), enabled
//              auto-remediate policies (a collection triggers drift detection), and enabled
//              schedule rows for another tenant. Exits 1 when any of those exist.
//   run-now    enqueues one collect job per tier as the scheduler principal, so every tier
//              runs once without waiting for its cadence. Idempotent per tenant, tier and day.
//   health     per tier: the schedule row is enabled and due in the future, and the newest
//              collect job for that tier succeeded with full coverage and queued its drift
//              detection. Exits 1 unless all three tiers pass.
//   cancel     withdraws one queued job that preflight listed, so a stale backlog never runs
//              when the worker starts. Running and finished jobs are left alone. Exits 1 when
//              the job was not queued.
// It prints JSON only: counts, ids, kinds and times, never job params or results.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect } from '../engine/store/db.mjs';
import { enqueue, cancelQueued } from '../engine/jobs/queue.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { snapshotHasFullCoverage } from '../engine/schedules/completions.mjs';
import { snapshotIdForJob } from '../engine/schedules/forecast.mjs';
import { schedulerPrincipal } from './keel-scheduler.mjs';

export const TIERS = Object.freeze(['tier1', 'tier2', 'tier3']);

export async function preflight(client, { tenantRef }) {
  const { rows: backlog } = await client.query(
    `SELECT kind, status, count(*)::int AS count, min(created_at) AS oldest
     FROM job WHERE status IN ('queued', 'running') GROUP BY kind, status ORDER BY kind, status`,
  );
  const { rows: [{ count: autoRemediatePolicies }] } = await client.query(
    `SELECT count(*)::int AS count FROM policy WHERE enabled AND action = 'auto_remediate'`,
  );
  const { rows: schedules } = await client.query(
    `SELECT job_kind, tier, enabled, next_due_at, tenant_ref = $1 AS this_tenant
     FROM schedule ORDER BY tenant_ref = $1 DESC, job_kind, tier`, [tenantRef],
  );
  const blockers = [];
  if (backlog.length > 0) blockers.push('jobs are queued or running; a new worker would run them');
  if (autoRemediatePolicies > 0) blockers.push('auto-remediate policies are enabled; scheduled collections would feed them');
  if (schedules.some((row) => row.enabled && !row.this_tenant)) blockers.push('enabled schedules exist for another tenant');
  return {
    tenantRef,
    backlog: backlog.map((row) => ({ ...row, oldest: row.oldest.toISOString() })),
    autoRemediatePolicies,
    schedules: schedules.map((row) => ({ ...row, next_due_at: row.next_due_at.toISOString() })),
    blockers,
    ok: blockers.length === 0,
  };
}

export async function runNow(client, { tenantRef, now = new Date() }) {
  const principal = await schedulerPrincipal(client);
  const day = now.toISOString().slice(0, 10);
  const jobs = [];
  for (const tier of TIERS) {
    const job = await enqueue(client, {
      kind: 'collect',
      params: { tier, tenantRef },
      requestedBy: principal.id,
      idempotencyKey: `install-run:${tenantRef}:${tier}:${day}`,
    });
    jobs.push({ tier, jobId: job.id, status: job.status });
  }
  return { tenantRef, jobs };
}

export async function cancel(client, { jobId, reason }) {
  if (!jobId) throw new Error('--job is required');
  const job = await cancelQueued(client, { id: jobId, reason });
  if (job) return { jobId, kind: job.kind, status: job.status, ok: true };
  const { rows: [current] } = await client.query('SELECT kind, status FROM job WHERE id = $1', [jobId]);
  return { jobId, kind: current?.kind ?? null, status: current?.status ?? 'not found', ok: false };
}

async function tierHealth(client, { tenantRef, tier, now }) {
  const { rows: [schedule] } = await client.query(
    `SELECT enabled, next_due_at FROM schedule
     WHERE tenant_ref = $1 AND job_kind = 'collect' AND tier = $2`, [tenantRef, tier],
  );
  const { rows: [job] } = await client.query(
    `SELECT * FROM job WHERE kind = 'collect' AND params->>'tier' = $1 AND params->>'tenantRef' = $2
     AND status IN ('succeeded', 'failed') ORDER BY finished_at DESC, id LIMIT 1`, [tier, tenantRef],
  );
  const snapshotId = job ? snapshotIdForJob(job) : null;
  const snapshot = snapshotId ? (await client.query('SELECT * FROM snapshot WHERE id = $1', [snapshotId])).rows[0] : null;
  const failedTypes = snapshot?.coverage_digest
    ? Object.entries(snapshot.coverage_digest)
      .filter(([, entry]) => !['complete', 'complete-empty', 'not-requested'].includes(entry?.outcome))
      .map(([type, entry]) => `${type}: ${entry?.outcome ?? 'unknown'}`)
    : [];
  const checks = {
    scheduled: Boolean(schedule?.enabled) && schedule.next_due_at > now,
    lastRunSucceeded: job?.status === 'succeeded',
    fullCoverage: snapshotHasFullCoverage(snapshot) && snapshot.tenant_ref === tenantRef,
    driftQueued: job?.result?.driftTrigger?.status === 'queued',
  };
  return {
    tier,
    ok: Object.values(checks).every(Boolean),
    checks,
    nextDueAt: schedule?.next_due_at?.toISOString() ?? null,
    lastJob: job ? { id: job.id, status: job.status, finishedAt: job.finished_at?.toISOString() ?? null, snapshotId } : null,
    failedTypes,
  };
}

export async function health(client, { tenantRef, now = new Date() }) {
  const tiers = [];
  for (const tier of TIERS) tiers.push(await tierHealth(client, { tenantRef, tier, now }));
  return { tenantRef, tiers, ok: tiers.every((tier) => tier.ok) };
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const commands = { preflight, 'run-now': runNow, health, cancel };
  if (!commands[command]) {
    console.error('usage: keel-schedules-host.mjs preflight|run-now|health --tenant-config FILE [--db-url URL]\n'
      + '       keel-schedules-host.mjs cancel --job ID --reason TEXT [--db-url URL]');
    return 2;
  }
  const options = command === 'cancel'
    ? { jobId: arg(argv, 'job'), reason: arg(argv, 'reason') }
    : { tenantRef: tenantRefFor(JSON.parse(readFileSync(arg(argv, 'tenant-config', '/etc/keel/tenant.json'), 'utf8')).tenantId) };
  const dbUrl = arg(argv, 'db-url', process.env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const client = await connect(dbUrl);
  try {
    const result = await commands[command](client, options);
    console.log(JSON.stringify(result, null, 2));
    return result.ok === false ? 1 : 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 1; });
}
