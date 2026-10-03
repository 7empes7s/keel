// Roadmap task-110: the measured load estimate of a schedule, in words. Pure helpers
// shared by the Schedules page, the UI harness and the tests. Status and warning codes,
// counts and the raw sample window stay in the schedule's record layer.
import { ago, formatTimestamp } from "@/lib/presentation";
import { cadenceSentence, scheduleName } from "@/lib/protect-view";
import type { Schedule, ScheduleForecast } from "@/lib/schedules";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function count(value: number): string {
  return Math.round(value).toLocaleString("en-GB");
}

function percent(ratio: number): string {
  const value = Math.round(ratio * 1000) / 10;
  return `${value < 0.1 && ratio > 0 ? "under 0.1" : value}%`;
}

export function durationWords(ms: number): string {
  if (ms < HOUR) {
    const minutes = Math.max(1, Math.round(ms / MINUTE));
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (ms < 2 * DAY) {
    const hours = Math.round((ms / HOUR) * 10) / 10;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(ms / DAY);
  return `${days} days`;
}

function windowWords(forecast: ScheduleForecast): string {
  if (!forecast.window) return "recently";
  const days = Math.round((Date.parse(forecast.window.to) - Date.parse(forecast.window.from)) / DAY);
  return `in the last ${days} day${days === 1 ? "" : "s"}`;
}

/** What the schedule costs Microsoft, or why KEEL cannot say yet. */
export function forecastSentence(forecast: ScheduleForecast | undefined): string {
  if (!forecast) return "Does not call Microsoft.";
  if (forecast.status === "unknown") {
    if (forecast.reason === "invalid-schedule") return "KEEL cannot estimate the load of this timetable.";
    if (forecast.reason === "no-samples") return "No measured runs yet, so KEEL cannot estimate its load.";
    const older = forecast.unmeasuredRuns ? " Older runs were not measured." : "";
    return `${forecast.samples} of ${forecast.minSamples} measured runs so far; too few to estimate its load.${older}`;
  }
  const estimate = forecast.estimate!;
  const base = `About ${count(estimate.projectedRequestsPerDay)} Microsoft requests a day, from runs ${windowWords(forecast)}.`;
  // A throttle warning states the share itself; do not say it twice.
  if (forecast.warnings.some((warning) => warning.code === "throttle-heavy")) return base;
  return `${base} ${estimate.throttleRatio === 0 ? "Microsoft slowed none of them down." : `Microsoft slowed ${percent(estimate.throttleRatio)} of them down.`}`;
}

export function warningSentence(warning: ScheduleForecast["warnings"][number], forecast: ScheduleForecast): string {
  if (warning.code === "throttle-heavy") {
    return `Microsoft slowed down ${percent(warning.throttleRatio ?? 0)} of its requests ${windowWords(forecast)}.`;
  }
  return `A slow run takes ${durationWords(warning.durationP90Ms ?? 0)}, close to the ${durationWords(forecast.intervalMs ?? 0)} between runs.`;
}

export function proposalSentence(forecast: ScheduleForecast): string | null {
  const proposal = forecast.proposal;
  if (!proposal) return null;
  if (proposal.unchanged) return "Even the slowest schedule KEEL suggests may not avoid this.";
  const cadence = cadenceSentence({ cadence: proposal.cadence, cron_override: null });
  return `Suggested: ${cadence.charAt(0).toLowerCase()}${cadence.slice(1)}.`;
}

export function businessHoursSentence(forecast: ScheduleForecast | undefined): string | null {
  const presentation = forecast?.presentation;
  if (!presentation || presentation.runs.length === 0) return null;
  const zone = presentation.timeZone === "UTC" ? "UTC" : presentation.timeZone.replaceAll("_", " ");
  if (presentation.runs.length === 1) {
    return `The next run falls ${presentation.inBusinessHours ? "inside" : "outside"} business hours (${zone}).`;
  }
  return `${presentation.inBusinessHours} of the next ${presentation.runs.length} runs fall in business hours (${zone}).`;
}

export function acknowledgementSentence(forecast: ScheduleForecast, now: string): string | null {
  const ack = forecast.acknowledgement;
  if (!ack) return null;
  const who = ack.acknowledgedByName ?? "A person no longer readable";
  return `${who} accepted this warning ${ago(ack.acknowledgedAt, now)}; the schedule was not changed.`;
}

export const FORECAST_CAVEAT = "An estimate from past runs, not a promise that Microsoft will not slow KEEL down.";

/** Warnings nobody has accepted yet; acknowledged ones stay listed but stop driving the verdict. */
export function openWarnings(forecast: ScheduleForecast | undefined) {
  return (forecast?.warnings ?? []).filter((warning) => !warning.acknowledged);
}

/** The verdict clause for load warnings, or null when there is none to raise. */
export function loadVerdict(schedules: Schedule[], forecasts: ScheduleForecast[] | undefined): string | null {
  const warned = schedules.filter((schedule) => schedule.enabled
    && openWarnings(forecasts?.find((forecast) => forecast.scheduleId === schedule.id)).length > 0);
  if (warned.length === 0) return null;
  if (warned.length === 1) return `${scheduleName(warned[0])} puts heavy load on Microsoft; a slower schedule is suggested.`;
  return `${warned.length} backups put heavy load on Microsoft; slower schedules are suggested.`;
}

/** Record values: raw codes and numbers, labelled. */
export function forecastRecord(forecast: ScheduleForecast): [string, string][] {
  const fields: [string, string][] = [
    ["Load estimate status", `${forecast.status}${forecast.reason ? ` · ${forecast.reason}` : ""} · advisory, not a guarantee`],
    ["Measured runs", `${forecast.samples} measured · ${forecast.unmeasuredRuns} unmeasured · minimum ${forecast.minSamples}`],
  ];
  if (forecast.window) fields.push(["Sample window", `${forecast.window.from} to ${forecast.window.to}`]);
  if (forecast.confidence) fields.push(["Confidence", forecast.confidence]);
  if (forecast.estimate) {
    const { requestsPerRun, projectedRequestsPerDay, throttleRatio, throttledRuns, durationMs, workloads } = forecast.estimate;
    fields.push(["Graph requests per run", `median ${requestsPerRun.median} · p90 ${requestsPerRun.p90} · max ${requestsPerRun.max}`]);
    fields.push(["Projected requests a day", `${projectedRequestsPerDay} (p90 × ${forecast.runsPerDay?.toFixed(2)} runs a day)`]);
    fields.push(["Throttled", `${(throttleRatio * 100).toFixed(2)}% of requests · ${throttledRuns} runs with throttling`]);
    if (durationMs) fields.push(["Run duration", `median ${durationMs.median} ms · p90 ${durationMs.p90} ms`]);
    fields.push(["Requests by workload", JSON.stringify(workloads)]);
  }
  if (forecast.warnings.length) fields.push(["Warning codes", forecast.warnings.map((warning) => `${warning.code}${warning.acknowledged ? " (acknowledged)" : ""}`).join(", ")]);
  if (forecast.proposal) {
    fields.push(["Proposed cadence", `${JSON.stringify(forecast.proposal.cadence)} · interval ${forecast.proposal.intervalMs} ms · floor ${forecast.proposal.floorMs} ms${forecast.proposal.cappedAtMaximum ? " · capped at one week" : ""}`]);
  }
  if (forecast.acknowledgement) {
    fields.push(["Acknowledged by", `${forecast.acknowledgement.acknowledgedBy} at ${forecast.acknowledgement.acknowledgedAt} for ${forecast.acknowledgement.codes.join(", ")}`]);
  }
  if (forecast.presentation?.runs.length) {
    fields.push(["Upcoming runs", forecast.presentation.runs.map((run) => `${run.at} = ${run.local} ${forecast.presentation!.timeZone}`).join("; ")]);
  }
  return fields;
}

export function acknowledgedAtTitle(forecast: ScheduleForecast): string | undefined {
  return forecast.acknowledgement ? formatTimestamp(forecast.acknowledgement.acknowledgedAt) : undefined;
}
