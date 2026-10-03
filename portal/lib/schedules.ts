import { loadScheduleForecasts } from "../../engine/schedules/forecast.mjs";
import { guarded, type GuardDeps } from "@/lib/action";
import { businessTimeZone } from "@/lib/runtime-config";

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
  forecast_acknowledgement?: unknown;
}

export type ForecastWarningCode = "throttle-heavy" | "overlap";

// Roadmap task-110: the advisory load estimate for one collect schedule, as returned
// by engine/schedules/forecast.mjs. An estimate from measured runs, never a guarantee.
export interface ScheduleForecast {
  scheduleId: string;
  jobKind: string;
  tier: string | null;
  advisory: true;
  guarantee: false;
  status: "unknown" | "ok" | "warning";
  reason: "no-samples" | "insufficient-samples" | "invalid-schedule" | null;
  floorMs?: number;
  runsPerDay?: number;
  intervalMs?: number;
  samples: number;
  minSamples: number;
  unmeasuredRuns: number;
  window?: { from: string; to: string; firstSample: string | null; lastSample: string | null } | null;
  confidence?: "low" | "medium" | "high" | null;
  estimate: null | {
    requestsPerRun: { median: number; p90: number; max: number };
    projectedRequestsPerDay: number;
    throttleRatio: number;
    throttledRuns: number;
    durationMs: { median: number; p90: number } | null;
    workloads: Record<string, { requests: number; throttles: number; runs: number }>;
  };
  warnings: { code: ForecastWarningCode; acknowledged: boolean; throttleRatio?: number; throttledRuns?: number; durationP90Ms?: number; neededIntervalMs: number }[];
  proposal: null | {
    cadence: Schedule["cadence"];
    intervalMs: number;
    floorMs: number;
    unchanged: boolean;
    cappedAtMaximum: boolean;
  };
  acknowledgement: null | { codes: ForecastWarningCode[]; acknowledgedBy: string; acknowledgedByName: string | null; acknowledgedAt: string; samples: number };
  presentation: null | {
    timeZone: string;
    timeZoneFallback: boolean;
    scheduling: "UTC";
    runs: { at: string; local: string; businessHours: boolean }[];
    inBusinessHours: number;
  };
}

export interface SchedulesData {
  schedules: Schedule[];
  deferrals: { id: string; error: string; finished_at: string | null }[];
  forecasts?: ScheduleForecast[];
  generatedAt: string;
}

export function guardedScheduleList(deps: GuardDeps = {}) {
  return guarded({ action: "schedules:list", capability: "read" }, async ({ client, tenantRef, principalId }) => {
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
    // The engine checks the read grant again and aggregates measured collection runs.
    let forecasts: ScheduleForecast[];
    try {
      ({ forecasts } = await loadScheduleForecasts(client, { id: principalId }, { tenantRef, timeZone: businessTimeZone() }));
    } catch (error) {
      if (error instanceof Error && error.message === "not authorized to read schedules") {
        return Response.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
      }
      throw error;
    }
    return Response.json({ schedules, deferrals, forecasts, generatedAt: new Date().toISOString() },
      { headers: { "cache-control": "no-store" } });
  }, deps);
}
