import assert from "node:assert/strict";
import { test } from "node:test";

import { changeSchedule, runScheduleNow } from "@/lib/schedule-calls";
import { forecastSentence } from "@/lib/schedule-forecast-view";
import type { Schedule, ScheduleForecast } from "@/lib/schedules";
import {
  cadenceWords, lastResult, loadChip, parseScheduleFilter, previewNextRun, runNowRoute, scheduleCounts, scheduleErrorWords,
  scheduleGroup, scheduleState, scheduleTone, schedulesStatus, schedulesVerdict, turnOffEffect, utcToZoned, zonedToUtc, zonedTime, zonedWithUtc,
} from "@/lib/schedules-view";
import { lastRunSentence } from "@/lib/protect-view";
import { renderSchedulesAt } from "./render-schedules";

const now = "2026-10-02T09:40:00Z";
const schedule = (id: string, job_kind: string, tier: string | null, extra: Partial<Schedule> = {}): Schedule => ({
  id, job_kind, tier, cadence: { every: "day", n: 1, atTime: "00:00" }, cron_override: null, enabled: true,
  next_due_at: "2026-10-03T00:00:00Z", last_job_id: null, last_run_at: null, last_status: null, last_error: null, ...extra,
});
const TIER1 = schedule("5c4e0000-0000-4000-8000-000000000001", "collect", "tier1", { cadence: { every: "hour", n: 1, atTime: null }, next_due_at: "2026-10-02T10:00:00Z", last_job_id: "a1", last_run_at: "2026-10-02T09:00:00Z", last_status: "succeeded" });
const TIER2 = schedule("5c4e0000-0000-4000-8000-000000000002", "collect", "tier2", { last_job_id: "a4", last_run_at: "2026-10-02T00:00:00Z", last_status: "failed", last_error: "Graph 429" });
const PRUNE = schedule("5c4e0000-0000-4000-8000-000000000004", "prune", null);
const OFFSITE = schedule("5c4e0000-0000-4000-8000-000000000005", "offsite", null, { enabled: false });
const DISCOVER = schedule("5c4e0000-0000-4000-8000-000000000009", "discover", null, { cron_override: "0 4 * * 1" });
const WARNING: ScheduleForecast = {
  scheduleId: TIER1.id, jobKind: "collect", tier: "tier1", advisory: true, guarantee: false, status: "warning", reason: null,
  samples: 12, minSamples: 3, unmeasuredRuns: 0, estimate: null,
  warnings: [{ code: "throttle-heavy", acknowledged: false, throttleRatio: 0.06, neededIntervalMs: 7_200_000 }],
  proposal: { cadence: { every: "hour", n: 2, atTime: null }, intervalMs: 7_200_000, floorMs: 900_000, unchanged: false, cappedAtMaximum: false },
  acknowledgement: null, presentation: null,
};

test("the engine's refusals read as plain words, never as codes", () => {
  assert.equal(scheduleErrorWords(400, "schedule_minimum_interval: collect requires at least 15 minutes"), "Backups can run at most every 15 minutes.");
  assert.equal(scheduleErrorWords(400, "schedule_minimum_interval: api-drift requires at least 1440 minutes"), "Microsoft API checks can run at most once a day.");
  assert.equal(scheduleErrorWords(400, "schedule_minimum_interval: content-collect requires at least 240 minutes"), "Content backups can run at most every 4 hours.");
  assert.equal(scheduleErrorWords(400, "invalid cron field"), "This custom timetable is not valid: check the five fields.");
  assert.equal(scheduleErrorWords(400, "cron requires five UTC fields"), "This custom timetable is not valid: check the five fields.");
  assert.equal(scheduleErrorWords(400, "invalid UTC atTime"), "Choose a time of day such as 02:30.");
  assert.equal(scheduleErrorWords(403, "forbidden"), "You need the right role for that, or your sign-in has ended.");
  assert.equal(scheduleErrorWords(404, "not_found"), "This schedule no longer exists. Reload the page.");
  for (const status of [400, 403, 404, 409, 500]) assert.doesNotMatch(scheduleErrorWords(status, "x_y: z"), /_/);
});

test("times show in the business time zone with UTC alongside; saving converts back to UTC", () => {
  assert.equal(zonedTime("2026-10-02T10:00:00Z", "Europe/Paris"), "Fri 12:00 Paris");
  assert.equal(zonedWithUtc("2026-10-02T10:00:00Z", "Europe/Paris"), "Fri 12:00 Paris (10:00 UTC)");
  assert.equal(zonedWithUtc("2026-10-02T10:00:00Z", "UTC"), "Fri 10:00 UTC");
  assert.equal(zonedTime("2026-10-02T10:00:00Z", "America/New_York"), "Fri 06:00 New York");
  // Summer and winter in Paris; a time that crosses midnight.
  assert.equal(zonedToUtc("02:00", "Europe/Paris", new Date("2026-07-15T12:00:00Z")), "00:00");
  assert.equal(zonedToUtc("02:00", "Europe/Paris", new Date("2026-01-15T12:00:00Z")), "01:00");
  assert.equal(zonedToUtc("00:30", "Europe/Paris", new Date("2026-01-15T12:00:00Z")), "23:30");
  assert.equal(utcToZoned("23:30", "Europe/Paris", new Date("2026-01-15T12:00:00Z")), "00:30");
  assert.equal(zonedToUtc("21:30", "UTC"), "21:30");
  assert.equal(cadenceWords(TIER2, "Europe/Paris"), "Every day at 02:00 Paris");
  assert.equal(cadenceWords(TIER2, "UTC"), "Every day at 00:00 UTC");
  assert.equal(cadenceWords(TIER1, "Europe/Paris"), "Every hour");
  assert.equal(cadenceWords(DISCOVER, "Europe/Paris"), "On a custom timetable");
  // The next-run preview follows the engine: n units from now, then the stored UTC time.
  assert.equal(previewNextRun({ every: "day", n: 1, atTime: "05:00" }, new Date(now))?.toISOString(), "2026-10-03T05:00:00.000Z");
  assert.equal(previewNextRun({ every: "hour", n: 2, atTime: null }, new Date(now))?.toISOString(), "2026-10-02T11:40:00.000Z");
  assert.equal(previewNextRun({ every: "day", n: 0, atTime: null }, new Date(now)), null);
});

test("groups, chips, counts, the status pill and the verdict", () => {
  assert.deepEqual([TIER1, PRUNE, DISCOVER, schedule("x", "content-collect", null)].map(scheduleGroup), ["backups", "upkeep", "checks", "settings"]);
  assert.equal(lastResult(TIER2, now).label, "Failed 9 hours ago");
  assert.equal(lastResult(TIER1, now).label, "Finished 40 minutes ago");
  assert.equal(loadChip(TIER1, WARNING).label, "Heavy load");
  assert.equal(loadChip(PRUNE, undefined).label, "No Microsoft calls");
  assert.equal(loadChip(DISCOVER, undefined).label, "Load not measured");
  // Only the clean-up and the off-site copy stay away from Microsoft.
  assert.equal(forecastSentence(undefined, "prune"), "Does not call Microsoft.");
  assert.equal(forecastSentence(undefined, "discover"), "Reads Microsoft; its load is not measured for this kind yet.");
  const all = [TIER1, TIER2, PRUNE, OFFSITE, DISCOVER];
  const counts = scheduleCounts(all, [WARNING]);
  assert.deepEqual({ on: counts.on, failed: counts.failed, warnings: counts.warnings, next: counts.next?.id }, { on: 4, failed: 1, warnings: 1, next: TIER1.id });
  assert.deepEqual(schedulesStatus(counts), { tone: "urgent", label: "1 failed" });
  assert.deepEqual(schedulesStatus(scheduleCounts([TIER1], [WARNING])), { tone: "soon", label: "Load warning" });
  assert.deepEqual(schedulesStatus(scheduleCounts([TIER1], [])), { tone: "fine", label: "All on time" });
  assert.equal(schedulesVerdict(all, now, [WARNING]).text, "Backup of Tier 2 failed on its last run.");
  assert.equal(schedulesVerdict([TIER1, PRUNE], now, []).text, "2 of 2 schedules are on; Backup of Tier 1 runs next, in 20 minutes.");
  assert.equal(parseScheduleFilter("failed", null), "failed");
  assert.equal(parseScheduleFilter("anything", "warning"), "warning");
  assert.equal(parseScheduleFilter("anything", null), null);
  assert.equal(turnOffEffect([TIER1]), "Backup of Tier 1 will stop backing up until you turn it on again.");
  assert.equal(turnOffEffect([TIER1, PRUNE]), "2 schedules stop running until you turn them on again; 1 of them is a backup.");
});

test("Run now is offered for backups and checks, never for clean-up, the off-site copy or the API check", () => {
  assert.deepEqual(runNowRoute(TIER1), { path: "/api/actions/collect", body: { tier: "tier1" } });
  assert.deepEqual(runNowRoute(DISCOVER), { path: "/api/actions/discover", body: {} });
  assert.deepEqual(runNowRoute(schedule("w", "workload-collect", null)), { path: "/api/actions/workload-collect", body: {} });
  assert.deepEqual(runNowRoute(schedule("c", "content-collect", null)), { path: "/api/actions/content-collect", body: {} });
  for (const kind of ["prune", "offsite", "api-drift"]) assert.equal(runNowRoute(schedule("k", kind, null)), null);
});

test("each control posts the one request its route expects", async () => {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const original = globalThis.fetch;
  let answer: Response = Response.json({ schedule: {} });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return answer;
  }) as typeof fetch;
  try {
    assert.equal((await changeSchedule(TIER1.id, { cadence: { every: "hour", n: 2, atTime: null }, cron_override: null })).error, null);
    assert.deepEqual(calls.at(-1)?.body, { id: TIER1.id, cadence: { every: "hour", n: 2, atTime: null }, cron_override: null });
    await changeSchedule(TIER1.id, { enabled: false });
    assert.deepEqual(calls.at(-1)?.body, { id: TIER1.id, enabled: false });
    await changeSchedule(TIER1.id, { acknowledgeForecast: ["throttle-heavy"] });
    assert.deepEqual(calls.at(-1)?.body, { id: TIER1.id, acknowledgeForecast: ["throttle-heavy"] });
    assert.ok(calls.every((call) => call.url === "/api/schedules"));
    answer = Response.json({ job: { id: "j1" } }, { status: 202 });
    const run = await runScheduleNow(TIER1);
    assert.deepEqual([run.ok, run.jobId], [true, "j1"]);
    assert.deepEqual([calls.at(-1)?.url, calls.at(-1)?.body], ["/api/actions/collect", { tier: "tier1" }]);
    assert.ok(calls.at(-1)?.headers["idempotency-key"], "a run carries an idempotency key");
    answer = Response.json({ error: "schedule_minimum_interval: collect requires at least 15 minutes" }, { status: 400 });
    assert.equal((await changeSchedule(TIER1.id, { cadence: TIER1.cadence, cron_override: "*/10 * * * *" })).error, "Backups can run at most every 15 minutes.");
    const before = calls.length;
    assert.equal((await runScheduleNow(PRUNE)).error, "This schedule cannot be run by hand.");
    assert.equal(calls.length, before, "no request for a kind without Run now");
  } finally {
    globalThis.fetch = original;
  }
});

test("the page body: tiles filter by address, rows open their panel, ids stay in the record", async () => {
  const props = { schedules: [TIER1, TIER2, PRUNE, OFFSITE, DISCOVER], deferrals: [], forecasts: [WARNING], now, timeZone: "Europe/Paris", canEdit: true, canRun: true };
  const html = await renderSchedulesAt("", props);
  assert.match(html, /href="\/schedules\?status=failed"/);
  assert.match(html, /href="\/schedules\?status=warning"/, "load warnings are one of the status tiles");
  assert.match(html, /href="\/schedules\?status=on"/);
  assert.match(html, new RegExp(`href="/schedules\\?open=${TIER1.id}"`));
  assert.match(html, /href="\/jobs\/a4"/);
  assert.ok(html.includes("Fri 12:00 Paris"));
  assert.ok(html.includes("Every day at 02:00 Paris"));
  const visible = html.split('data-layer="record"')[0]
    .replace(/(data-row-id|href|title|id|for|aria-labelledby|aria-controls|value)="[^"]*"/g, "");
  assert.doesNotMatch(visible, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.doesNotMatch(visible, /\b[a-z]+(?:_[a-z0-9]+)+\b/);

  const failed = await renderSchedulesAt("status=failed", props);
  assert.match(failed, /Showing <b>1<\/b> of 5 schedules/);
  assert.ok(failed.includes(`href="/schedules?status=failed%2Cwarning"`), "Load warnings adds to Failed");
  const old = await renderSchedulesAt("load=warning", props);
  assert.match(old, /Showing <b>1<\/b> of 5 schedules/, "an old load=warning link still works");
  const viewer = await renderSchedulesAt("", { ...props, canEdit: false, canRun: false });
  assert.ok(!viewer.includes("sel-check"));
  assert.ok(!viewer.includes("Review the load warning"));
});

test("a backup that could not read some types reads as partly done, not finished or failed (#447)", () => {
  const partial = { ...TIER1, last_status: "partial" };
  assert.equal(scheduleState(partial, undefined), "partial");
  assert.equal(scheduleTone(partial, undefined), "soon");
  assert.deepEqual(
    { label: lastResult(partial, now).label, tone: lastResult(partial, now).tone },
    { label: "Partly done 40 minutes ago", tone: "soon" },
  );
  assert.equal(lastRunSentence(partial, now), "Last run partly done 40 minutes ago: some types were not backed up.");
  assert.equal(scheduleCounts([partial], undefined).failed, 0, "partial is not counted as failed");
});
