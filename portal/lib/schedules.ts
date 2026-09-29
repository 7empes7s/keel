import { guarded, type GuardDeps } from "@/lib/action";

export interface Schedule {
  id: string;
  job_kind: string;
  tier: string | null;
  cadence: { every: "hour" | "day" | "week"; n: number; atTime: string | null };
  cron_override: string | null;
  enabled: boolean;
  next_due_at: string;
  last_job_id: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
}

export interface SchedulesData {
  schedules: Schedule[];
  deferrals: { id: string; error: string; finished_at: string | null }[];
  generatedAt: string;
}

export function guardedScheduleList(deps: GuardDeps = {}) {
  return guarded({ action: "schedules:list", capability: "read" }, async ({ client, tenantRef }) => {
    const { rows: schedules } = await client.query(
      `SELECT s.*, j.started_at AS last_run_at, j.status AS last_status, j.error AS last_error
       FROM schedule s LEFT JOIN job j ON j.id = s.last_job_id AND j.params->>'tenantRef' = s.tenant_ref
       WHERE s.tenant_ref = $1 ORDER BY s.job_kind, s.tier NULLS LAST, s.id`, [tenantRef],
    );
    const { rows: deferrals } = await client.query(
      `SELECT id, error, finished_at FROM job
       WHERE kind = 'drift-detect' AND status = 'failed' AND params->>'tenantRef' = $1
       AND error LIKE 'drift-detect deferred:%'
       AND NOT (COALESCE(result, '{}'::jsonb) ? 'retriedByJobId')
       ORDER BY finished_at DESC, id`, [tenantRef],
    );
    return Response.json({ schedules, deferrals, generatedAt: new Date().toISOString() },
      { headers: { "cache-control": "no-store" } });
  }, deps);
}
