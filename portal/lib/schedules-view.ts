// The Schedules page in words (portal audit, one design). Pure helpers shared by the
// server page, the client body, the UI harness and the tests: groups, tiles, the status
// pill, the verdict, times in the business time zone, the editor's next-run preview and
// the engine's refusals in plain words. Codes, cron and ids stay in Technical details.
import type { IconName } from "@/components/shell/icons";
import type { BadgeTone } from "@/components/ui/badge";
import type { RiskTone } from "@/lib/menu-status";
import { ago, fromNow } from "@/lib/presentation";
import { scheduleName, TIERS } from "@/lib/protect-view";
import { loadVerdict, openWarnings } from "@/lib/schedule-forecast-view";
import type { Schedule, ScheduleForecast } from "@/lib/schedules";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNIT_MS = { hour: HOUR, day: DAY, week: 7 * DAY } as const;

// ---- Groups: what each schedule does ------------------------------------------------

export type ScheduleGroup = "backups" | "settings" | "checks" | "upkeep";

export const SCHEDULE_GROUPS: Record<ScheduleGroup, { label: string; icon: IconName; about: string }> = {
  backups: { label: "Backups", icon: "backup", about: "Settings backed up by tier" },
  settings: { label: "Settings and content backups", icon: "cloud", about: "Service settings, mail, files and Teams" },
  checks: { label: "Checks", icon: "search", about: "What the tenant holds and what Microsoft changed" },
  upkeep: { label: "Upkeep", icon: "settings", about: "Clean-up and the off-site copy" },
};
export const SCHEDULE_GROUP_ORDER: ScheduleGroup[] = ["backups", "settings", "checks", "upkeep"];

export function scheduleGroup(schedule: Pick<Schedule, "job_kind">): ScheduleGroup {
  if (schedule.job_kind === "collect" || schedule.job_kind === "backup") return "backups";
  if (schedule.job_kind === "workload-collect" || schedule.job_kind === "content-collect") return "settings";
  if (schedule.job_kind === "prune" || schedule.job_kind === "offsite") return "upkeep";
  return "checks";
}

export const KIND_ICONS: Record<ScheduleGroup, IconName> = { backups: "backup", settings: "cloud", checks: "search", upkeep: "settings" };

/** "Backup of Tier 1 (critical settings)": the tier's meaning goes in the title. */
export function scheduleTitle(schedule: Pick<Schedule, "job_kind" | "tier">): string | undefined {
  const tier = TIERS.find((entry) => entry.id === schedule.tier);
  return tier ? `${tier.label}: ${tier.description}` : undefined;
}

// ---- State of one schedule -------------------------------------------------------------

export type ScheduleState = "failed" | "partial" | "warning" | "running" | "off" | "fine" | "new";

export const STATE_WORDS: Record<ScheduleState, { label: string; tone: BadgeTone; icon: IconName }> = {
  failed: { label: "Failed", tone: "urgent", icon: "x-circle" },
  partial: { label: "Partly done", tone: "soon", icon: "alert" },
  warning: { label: "Heavy load", tone: "soon", icon: "clock" },
  running: { label: "Running", tone: "low", icon: "refresh" },
  off: { label: "Off", tone: "neutral", icon: "pause" },
  fine: { label: "On time", tone: "fine", icon: "check-circle" },
  new: { label: "Not run yet", tone: "neutral", icon: "info" },
};
export const STATE_ORDER: ScheduleState[] = ["failed", "partial", "warning", "running", "new", "fine", "off"];

export const forecastFor = (forecasts: ScheduleForecast[] | undefined, schedule: Pick<Schedule, "id">) =>
  forecasts?.find((forecast) => forecast.scheduleId === schedule.id);

export function scheduleState(schedule: Schedule, forecast: ScheduleForecast | undefined): ScheduleState {
  if (!schedule.enabled) return "off";
  if (schedule.last_status === "failed") return "failed";
  if (schedule.last_status === "partial") return "partial";
  if (openWarnings(forecast).length) return "warning";
  if (schedule.last_status === "running" || schedule.last_status === "queued") return "running";
  if (!schedule.last_status) return "new";
  return "fine";
}

export function scheduleTone(schedule: Schedule, forecast: ScheduleForecast | undefined): RiskTone | null {
  const state = scheduleState(schedule, forecast);
  return state === "failed" ? "urgent" : state === "warning" || state === "partial" ? "soon" : null;
}

/** The last result chip: what happened on the last run. */
export function lastResult(schedule: Schedule, now: string): { label: string; tone: BadgeTone; icon: IconName; title: string } {
  if (!schedule.last_status || !schedule.last_run_at) return { label: "Not run yet", tone: "neutral", icon: "info", title: "It has not run yet." };
  const when = ago(schedule.last_run_at, now);
  if (schedule.last_status === "failed") return { label: `Failed ${when}`, tone: "urgent", icon: "x-circle", title: "Open the run to see why." };
  if (schedule.last_status === "running" || schedule.last_status === "queued") return { label: "Running now", tone: "low", icon: "refresh", title: `Started ${when}.` };
  if (schedule.last_status === "partial") return { label: `Partly done ${when}`, tone: "soon", icon: "alert", title: "Some types were not backed up. Open the run to see which." };
  if (schedule.last_status === "cancelled") return { label: `Cancelled ${when}`, tone: "neutral", icon: "info", title: "Someone stopped the last run." };
  return { label: `Finished ${when}`, tone: "fine", icon: "check-circle", title: "The last run finished." };
}

/** The load chip: how hard the schedule works Microsoft. */
export function loadChip(schedule: Pick<Schedule, "job_kind">, forecast: ScheduleForecast | undefined): { label: string; tone: BadgeTone; icon: IconName } {
  if (!forecast) return schedule.job_kind === "prune" || schedule.job_kind === "offsite"
    ? { label: "No Microsoft calls", tone: "neutral", icon: "info" }
    : { label: "Load not measured", tone: "neutral", icon: "info" };
  if (openWarnings(forecast).length) return { label: "Heavy load", tone: "soon", icon: "clock" };
  if (forecast.status === "unknown") return { label: "Load not measured", tone: "neutral", icon: "info" };
  if (forecast.status === "warning") return { label: "Heavy load, accepted", tone: "neutral", icon: "check" };
  return { label: "Light load", tone: "fine", icon: "check-circle" };
}

// ---- Times in the business time zone ----------------------------------------------------

/** "Paris" from "Europe/Paris"; "UTC" stays. */
export function zoneName(timeZone: string): string {
  if (!timeZone || timeZone === "UTC" || timeZone === "Etc/UTC") return "UTC";
  return timeZone.split("/").at(-1)!.replaceAll("_", " ");
}

const isUtc = (timeZone: string) => zoneName(timeZone) === "UTC";

function parts(at: Date, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  return { weekday: values.weekday, year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute) };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "Fri 12:00 Paris" (or "Fri 10:00 UTC"). */
export function zonedTime(iso: string, timeZone: string, withDay = true): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.valueOf())) return "at an unknown time";
  const zone = isUtc(timeZone) ? "UTC" : timeZone;
  const local = parts(at, zone);
  return `${withDay ? `${local.weekday} ` : ""}${pad(local.hour)}:${pad(local.minute)} ${zoneName(zone)}`;
}

/** The UTC value, for a tooltip: "Fri 10:00 UTC". */
export function utcTime(iso: string, withDay = true): string {
  return zonedTime(iso, "UTC", withDay);
}

/** "Fri 12:00 Paris (10:00 UTC)"; just "Fri 10:00 UTC" when the business zone is UTC. */
export function zonedWithUtc(iso: string, timeZone: string): string {
  if (isUtc(timeZone)) return utcTime(iso);
  return `${zonedTime(iso, timeZone)} (${utcTime(iso, false)})`;
}

/** Minutes the zone is ahead of UTC at that instant. */
function offsetMinutes(at: Date, timeZone: string): number {
  const local = parts(at, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return Math.round((asUtc - Math.floor(at.valueOf() / MINUTE) * MINUTE) / MINUTE);
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A stored UTC "HH:MM" as the business zone shows it on that date. */
export function utcToZoned(time: string, timeZone: string, onDate: Date = new Date()): string {
  const match = TIME.exec(time);
  if (!match || isUtc(timeZone)) return time;
  const at = new Date(Date.UTC(onDate.getUTCFullYear(), onDate.getUTCMonth(), onDate.getUTCDate(), Number(match[1]), Number(match[2])));
  const local = parts(at, timeZone);
  return `${pad(local.hour)}:${pad(local.minute)}`;
}

/** A business-zone "HH:MM" as the UTC "HH:MM" the server stores, on that date. */
export function zonedToUtc(time: string, timeZone: string, onDate: Date = new Date()): string {
  const match = TIME.exec(time);
  if (!match) throw new Error("invalid time of day");
  if (isUtc(timeZone)) return time;
  const minutes = Number(match[1]) * 60 + Number(match[2]) - offsetMinutes(onDate, timeZone);
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/** "Every day at 02:00 Paris"; the UTC form is the tooltip (`cadenceUtc`). */
export function cadenceWords(schedule: Pick<Schedule, "cadence" | "cron_override" | "next_due_at">, timeZone: string): string {
  if (schedule.cron_override !== null) return "On a custom timetable";
  const { n, every, atTime } = schedule.cadence;
  const unit = n === 1 ? `Every ${every}` : `Every ${n} ${every}s`;
  if (!atTime) return unit;
  if (every === "hour") return `${unit}, at ${atTime.slice(3)} minutes past`;
  const on = new Date(schedule.next_due_at);
  const day = Number.isFinite(on.valueOf()) ? on : new Date();
  return `${unit} at ${utcToZoned(atTime, timeZone, day)} ${zoneName(timeZone)}`;
}

export function cadenceUtc(schedule: Pick<Schedule, "cadence" | "cron_override">): string {
  if (schedule.cron_override !== null) return "A custom timetable, worked out in UTC";
  const { every, atTime } = schedule.cadence;
  if (!atTime) return "Counted from the last run";
  return every === "hour" ? `At ${atTime.slice(3)} minutes past each hour` : `At ${atTime} UTC`;
}

export function nextRunWords(schedule: Pick<Schedule, "enabled" | "next_due_at">, now: string): string {
  if (!schedule.enabled) return "Turned off";
  const due = fromNow(schedule.next_due_at, now);
  return due === "already passed" ? "Due now" : `Next run ${due}`;
}

/** When a structured cadence saved now would run next (mirrors the engine's nextDueAt). */
export function previewNextRun(cadence: Schedule["cadence"], now: Date): Date | null {
  const unit = UNIT_MS[cadence.every];
  if (!unit || !Number.isSafeInteger(cadence.n) || cadence.n < 1 || cadence.n > 10_000) return null;
  const next = new Date(now.valueOf() + cadence.n * unit);
  if (cadence.atTime) {
    const match = TIME.exec(cadence.atTime);
    if (!match) return null;
    if (cadence.every === "hour") next.setUTCMinutes(Number(match[2]), 0, 0);
    else next.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
    if (next <= now) return null;
  }
  return next;
}

// ---- The page: counts, filter, pill, verdict --------------------------------------------

export type ScheduleFilter = "on" | "off" | "failed" | "warning";

export function parseScheduleFilter(status: string | null | undefined, load: string | null | undefined): ScheduleFilter | null {
  if (load === "warning") return "warning";
  return status === "on" || status === "off" || status === "failed" ? status : null;
}

export const FILTER_WORDS: Record<ScheduleFilter, string> = {
  on: "schedules that are on",
  off: "schedules that are off",
  failed: "schedules whose last run failed",
  warning: "schedules with a load warning",
};

export function scheduleMatches(schedule: Schedule, forecast: ScheduleForecast | undefined, filter: ScheduleFilter | null): boolean {
  if (!filter) return true;
  if (filter === "on") return schedule.enabled;
  if (filter === "off") return !schedule.enabled;
  if (filter === "failed") return schedule.last_status === "failed";
  return schedule.enabled && openWarnings(forecast).length > 0;
}

export interface ScheduleCounts { total: number; on: number; failed: number; warnings: number; next: Schedule | null }

export function scheduleCounts(schedules: Schedule[], forecasts: ScheduleForecast[] | undefined): ScheduleCounts {
  const on = schedules.filter((schedule) => schedule.enabled);
  return {
    total: schedules.length,
    on: on.length,
    failed: schedules.filter((schedule) => schedule.last_status === "failed").length,
    warnings: on.filter((schedule) => openWarnings(forecastFor(forecasts, schedule)).length > 0).length,
    next: on.length ? on.reduce((soonest, schedule) => (schedule.next_due_at < soonest.next_due_at ? schedule : soonest)) : null,
  };
}

export function schedulesStatus(counts: ScheduleCounts): { tone: RiskTone; label: string } {
  if (counts.failed) return { tone: "urgent", label: `${counts.failed} failed` };
  if (counts.warnings) return { tone: "soon", label: counts.warnings === 1 ? "Load warning" : `${counts.warnings} load warnings` };
  if (counts.total === 0) return { tone: "soon", label: "Nothing scheduled" };
  if (counts.on === 0) return { tone: "soon", label: "All off" };
  return { tone: "fine", label: "All on time" };
}

/** "8 of 10 schedules are on; Backup of Tier 1 runs next, in 20 minutes." */
export function schedulesVerdict(schedules: Schedule[], now: string, forecasts?: ScheduleForecast[]): { text: string; tone: "good" | "attention" } {
  if (schedules.length === 0) return { text: "Nothing runs on a schedule; backups happen only on demand.", tone: "attention" };
  const failed = schedules.filter((schedule) => schedule.last_status === "failed");
  if (failed.length === 1) return { text: `${scheduleName(failed[0])} failed on its last run.`, tone: "attention" };
  if (failed.length) return { text: `${failed.length} schedules failed on their last run.`, tone: "attention" };
  const load = loadVerdict(schedules, forecasts);
  if (load) return { text: load, tone: "attention" };
  const { on, next } = scheduleCounts(schedules, forecasts);
  if (!next) return { text: "Every schedule is turned off; nothing runs on its own.", tone: "attention" };
  const due = fromNow(next.next_due_at, now);
  return { text: `${on} of ${schedules.length} schedules are on; ${scheduleName(next)} runs next, ${due === "already passed" ? "now" : due}.`, tone: "good" };
}

// ---- Turning schedules on and off --------------------------------------------------------

export function turnOffEffect(schedules: Schedule[]): string {
  const on = schedules.filter((schedule) => schedule.enabled);
  if (on.length === 0) return "They are already off; nothing changes.";
  if (on.length === 1) {
    const one = on[0];
    return scheduleGroup(one) === "backups"
      ? `${scheduleName(one)} will stop backing up until you turn it on again.`
      : `${scheduleName(one)} will stop running until you turn it on again.`;
  }
  const backups = on.filter((schedule) => scheduleGroup(schedule) === "backups").length;
  return `${on.length} schedules stop running until you turn them on again${backups ? `; ${backups === 1 ? "1 of them is a backup" : `${backups} of them are backups`}` : ""}.`;
}

export function turnOnEffect(schedules: Schedule[]): string {
  const off = schedules.filter((schedule) => !schedule.enabled);
  if (off.length === 0) return "They are already on; nothing changes.";
  return off.length === 1
    ? `${scheduleName(off[0])} runs again on its timetable.`
    : `${off.length} schedules run again on their timetables.`;
}

// ---- Run now -----------------------------------------------------------------------------

// The route that starts one run of a schedule, or null when Run now is not offered:
// clean-up deletes old backups, the off-site copy target is unreachable, and the
// Microsoft API check runs once per period.
export function runNowRoute(schedule: Pick<Schedule, "job_kind" | "tier" | "enabled">): { path: string; body: Record<string, string> } | null {
  if (schedule.job_kind === "collect" && schedule.tier) return { path: "/api/actions/collect", body: { tier: schedule.tier } };
  if (schedule.job_kind === "discover") return { path: "/api/actions/discover", body: {} };
  if (schedule.job_kind === "workload-collect") return { path: "/api/actions/workload-collect", body: {} };
  if (schedule.job_kind === "content-collect") return { path: "/api/actions/content-collect", body: {} };
  return null;
}

/** The Activity filter (`what=`) that lists this schedule's runs. */
export function runsFilter(schedule: Pick<Schedule, "job_kind">): "backup" | "policy" | "copy" {
  if (schedule.job_kind === "offsite") return "copy";
  if (schedule.job_kind === "api-drift" || schedule.job_kind === "drift-detect") return "policy";
  return "backup";
}

// ---- The engine's answers in plain words ------------------------------------------------

const KIND_PLURAL: Record<string, string> = {
  collect: "Backups", backup: "Backups", prune: "Clean-ups", offsite: "Off-site copies",
  "workload-collect": "Settings backups", "content-collect": "Content backups",
  "api-drift": "Microsoft API checks", discover: "Checks of what the tenant holds",
};

function gapWords(minutes: number): string {
  if (minutes < 60) return `every ${minutes} minutes`;
  if (minutes === 60) return "once an hour";
  if (minutes < 1440) return `every ${minutes / 60} hours`;
  if (minutes === 1440) return "once a day";
  return `every ${Math.round(minutes / 1440)} days`;
}

/** A refusal from POST /api/schedules (or a run-now route), in words. */
export function scheduleErrorWords(status: number, error: unknown): string {
  const message = typeof error === "string" ? error : "";
  const floor = /^schedule_minimum_interval: (\S+) requires at least (\d+) minutes$/.exec(message);
  if (floor) return `${KIND_PLURAL[floor[1]] ?? "This schedule"} can run at most ${gapWords(Number(floor[2]))}.`;
  if (/cron/.test(message)) return "This custom timetable is not valid: check the five fields.";
  if (message === "invalid structured cadence") return "Choose a whole number from 1 to 10,000.";
  if (message === "invalid UTC atTime" || message === "cadence atTime does not advance the due instant") return "Choose a time of day such as 02:30.";
  if (message === "forecast_warning_not_current") return "This warning has changed since the page loaded. Reload to see the current estimate.";
  if (message === "setup_incomplete") return "Finish setup first: Keel has not connected to the tenant yet.";
  if (status === 403) return "You need the right role for that, or your sign-in has ended.";
  if (status === 404) return "This schedule no longer exists. Reload the page.";
  if (status === 400) return "Keel could not save that timetable. Check the values and try again.";
  return "Keel could not save that. Try again.";
}

/** "1 change check is waiting for a full backup." */
export function waitingSentence(count: number): string {
  return count === 1
    ? "The change check is waiting for a backup in which every type succeeds; it runs again after that."
    : `${count} change checks are waiting for a backup in which every type succeeds; they run again after that.`;
}
