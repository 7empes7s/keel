// The approved setup's match percentage over time, for the Approved setup page. Pure:
// the points come from engine/govern/baselineScore.mjs (one after each backup and each
// run of service reads); this file only picks, orders and words them.
import { scoreTone } from "@/lib/compliance-view";
import { serviceFor, serviceOrder, type CloudService } from "@/lib/services";

export interface ScoreCount {
  matching: number;
  judged: number;
  percent: number | null;
}

export interface ScorePoint extends ScoreCount {
  id: string;
  baselineId: string;
  recordedAt: string;
  trigger: "backup" | "service-read";
  sourceId: string | null;
  // The same count per service code (Entra, Intune, Exchange…).
  services: Record<string, ScoreCount>;
}

export type HistoryTone = "fine" | "soon" | "urgent" | "neutral";

export const OVERALL = "overall";
export const HISTORY_RANGES = [
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "all", label: "All", days: null },
] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number]["value"];
export const DEFAULT_RANGE: HistoryRange = "30";

export function readRange(value: string): HistoryRange {
  return HISTORY_RANGES.some((range) => range.value === value) ? (value as HistoryRange) : DEFAULT_RANGE;
}

/** The colour of a percentage: the same bands as the rings (90 and 60). */
export function percentTone(percent: number | null): HistoryTone {
  return scoreTone({ passed: 0, evaluated: 0, excepted: 0, percent });
}

export const TRIGGER_WORDS: Record<ScorePoint["trigger"], string> = {
  backup: "Backup",
  "service-read": "Service read",
};

/** Every service the points name, in Microsoft's order. */
export function historyServices(points: readonly ScorePoint[]): CloudService[] {
  const codes = new Set(points.flatMap((point) => Object.keys(point.services)));
  return [...codes].map((code) => serviceFor(code)).sort((a, b) => serviceOrder(a.code) - serviceOrder(b.code) || a.name.localeCompare(b.name));
}

/** One point's count for the line shown: overall, or one service (null when it had none). */
export function countFor(point: ScorePoint, line: string): ScoreCount | null {
  if (line === OVERALL) return point;
  return point.services[line] ?? null;
}

/** The points inside the range, oldest first, that have a percentage for the line. */
export function seriesFor(points: readonly ScorePoint[], line: string, range: HistoryRange, now: string): { at: string; percent: number; point: ScorePoint }[] {
  const days = HISTORY_RANGES.find((entry) => entry.value === range)?.days ?? null;
  const from = days === null ? Number.NEGATIVE_INFINITY : Date.parse(now) - days * 86_400_000;
  return [...points]
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))
    .filter((point) => Date.parse(point.recordedAt) >= from)
    .flatMap((point) => {
      const count = countFor(point, line);
      return count?.percent === null || count?.percent === undefined ? [] : [{ at: point.recordedAt, percent: count.percent, point }];
    });
}

export interface HistorySummary {
  latest: number;
  // Change since the first point in the range, in percentage points; null with one point.
  change: number | null;
  lowest: { percent: number; at: string };
  highest: { percent: number; at: string };
  points: number;
}

export function historySummary(series: readonly { at: string; percent: number }[]): HistorySummary | null {
  if (!series.length) return null;
  const latest = series[series.length - 1];
  const lowest = series.reduce((best, entry) => (entry.percent < best.percent ? entry : best), series[0]);
  const highest = series.reduce((best, entry) => (entry.percent > best.percent ? entry : best), series[0]);
  return {
    latest: latest.percent,
    change: series.length > 1 ? latest.percent - series[0].percent : null,
    lowest: { percent: lowest.percent, at: lowest.at },
    highest: { percent: highest.percent, at: highest.at },
    points: series.length,
  };
}

/** "+3 points", "−2 points", "No change". */
export function changeWords(change: number): string {
  if (change === 0) return "No change";
  const size = Math.abs(change);
  return `${change > 0 ? "+" : "−"}${size} ${size === 1 ? "point" : "points"}`;
}

/** Rising is good, falling needs a look. */
export function changeTone(change: number | null): "fine" | "urgent" | "neutral" {
  if (!change) return "neutral";
  return change > 0 ? "fine" : "urgent";
}

export interface HistoryRow {
  point: ScorePoint;
  // Overall change since the point before it, in percentage points; null for the first.
  change: number | null;
  // Each service's count, in Microsoft's order, with its change since the point before.
  services: { service: CloudService; count: ScoreCount; change: number | null }[];
  // A new approved setup was put in use since the point before.
  newSetup: boolean;
}

/** Every point newest first, each compared with the one before it. */
export function historyRows(points: readonly ScorePoint[]): HistoryRow[] {
  const ordered = [...points].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  const diff = (now: number | null | undefined, before: number | null | undefined) =>
    now === null || now === undefined || before === null || before === undefined ? null : now - before;
  return ordered.map((point, index) => {
    const before = index > 0 ? ordered[index - 1] : null;
    const services = Object.entries(point.services)
      .map(([code, count]) => ({ service: serviceFor(code), count, change: diff(count.percent, before?.services[code]?.percent) }))
      .sort((a, b) => serviceOrder(a.service.code) - serviceOrder(b.service.code));
    return { point, change: diff(point.percent, before?.percent), services, newSetup: Boolean(before && before.baselineId !== point.baselineId) };
  }).reverse();
}

// The chart's floor: 10 points under the lowest value, in tens, never above 50, so the
// bands stay visible and a small dip is not flattened against a 0–100 scale.
export function chartFloor(lowest: number): number {
  return Math.max(0, Math.min(50, Math.floor((lowest - 10) / 10) * 10));
}
