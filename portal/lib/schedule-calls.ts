// The calls the Schedules page makes, kept apart from the page so the control-to-route
// boundary is tested without a browser. Saving, turning on or off and accepting a load
// warning post to /api/schedules (`configuration`); Run now posts to the job kind's own
// action route (`collect`). The server checks every grant again.
import { runNowRoute, scheduleErrorWords } from "@/lib/schedules-view";
import type { ForecastWarningCode, Schedule } from "@/lib/schedules";

export interface ScheduleCallResult {
  ok: boolean;
  status: number;
  // The refusal in words, or null when it worked.
  error: string | null;
  jobId: string | null;
}

export type ScheduleChange =
  | { cadence: Schedule["cadence"]; cron_override: string | null }
  | { enabled: boolean }
  | { acknowledgeForecast: ForecastWarningCode[] };

async function post(path: string, body: Record<string, unknown>, idempotent: boolean): Promise<ScheduleCallResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (idempotent) headers["idempotency-key"] = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    return { ok: false, status: 0, error: "Keel could not be reached. Try again.", jobId: null };
  }
  const payload = (await response.json().catch(() => null)) as { error?: unknown; job?: { id?: unknown } } | null;
  const jobId = typeof payload?.job?.id === "string" ? payload.job.id : null;
  return { ok: response.ok, status: response.status, error: response.ok ? null : scheduleErrorWords(response.status, payload?.error), jobId };
}

export function changeSchedule(id: string, change: ScheduleChange): Promise<ScheduleCallResult> {
  return post("/api/schedules", { id, ...change }, false);
}

export async function runScheduleNow(schedule: Schedule): Promise<ScheduleCallResult> {
  const route = runNowRoute(schedule);
  if (!route) return { ok: false, status: 400, error: "This schedule cannot be run by hand.", jobId: null };
  return post(route.path, route.body, true);
}
