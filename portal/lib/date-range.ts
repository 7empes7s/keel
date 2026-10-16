// Dates for the shared date picker: whole days as "YYYY-MM-DD" strings in UTC, the
// presets it offers, the month grid it draws, and how a chosen range reads.
export type Day = string;

export interface DayRange {
  from: Day;
  // Absent for a single day.
  to?: Day;
}

export type PresetId = "today" | "last-7" | "last-30" | "since-backup";

export interface Preset {
  id: PresetId;
  label: string;
  range: DayRange;
}

const DAY_MS = 86_400_000;

export function isDay(value: unknown): value is Day {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && toDay(new Date(`${value}T00:00:00Z`)) === value;
}

export function toDay(date: Date): Day {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: Day, count: number): Day {
  return toDay(new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS));
}

export function addMonths(day: Day, count: number): Day {
  const date = new Date(`${day}T00:00:00Z`);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), last));
  return toDay(target);
}

export function compareDays(a: Day, b: Day): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A range with its ends in order; a range whose ends match is one day. */
export function normalise(range: DayRange): DayRange {
  if (!range.to || range.to === range.from) return { from: range.from };
  return compareDays(range.from, range.to) <= 0 ? range : { from: range.to, to: range.from };
}

export function inRange(day: Day, range: DayRange | null): boolean {
  if (!range) return false;
  const { from, to } = normalise(range);
  return to ? compareDays(day, from) >= 0 && compareDays(day, to) <= 0 : day === from;
}

export function presets(today: Day, lastBackup?: Day | null): Preset[] {
  const list: Preset[] = [
    { id: "today", label: "Today", range: { from: today } },
    { id: "last-7", label: "Last 7 days", range: { from: addDays(today, -6), to: today } },
    { id: "last-30", label: "Last 30 days", range: { from: addDays(today, -29), to: today } },
  ];
  if (lastBackup && isDay(lastBackup) && compareDays(lastBackup, today) <= 0) {
    list.push({ id: "since-backup", label: "Since last backup", range: normalise({ from: lastBackup, to: today }) });
  }
  return list;
}

export function presetFor(range: DayRange | null, list: Preset[]): Preset | null {
  if (!range) return null;
  const want = normalise(range);
  return list.find((preset) => preset.range.from === want.from && preset.range.to === want.to) ?? null;
}

/** Six weeks of days around a month, Monday first, with whether each is in the month. */
export function monthGrid(month: Day): { day: Day; inMonth: boolean }[] {
  const first = `${month.slice(0, 7)}-01`;
  const weekday = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDays(first, -weekday);
  return Array.from({ length: 42 }, (_, index) => {
    const day = addDays(start, index);
    return { day, inMonth: day.slice(0, 7) === first.slice(0, 7) };
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function monthTitle(day: Day): string {
  return `${MONTH_NAMES[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/** "16 Oct" (same year as today) or "16 Oct 2025". */
export function shortDay(day: Day, today: Day): string {
  const text = `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
  return day.slice(0, 4) === today.slice(0, 4) ? text : `${text} ${day.slice(0, 4)}`;
}

/** The screen reader's name for a calendar day: "Friday 16 October 2026". */
export function longDay(day: Day): string {
  const date = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** What the closed picker shows: the preset's name and its days, or just the days. */
export function rangeLabel(range: DayRange | null, today: Day, list: Preset[] = []): string {
  if (!range) return "Any time";
  const { from, to } = normalise(range);
  const preset = presetFor(range, list);
  const days = to ? `${shortDay(from, today)} – ${shortDay(to, today)}` : shortDay(from, today);
  return preset ? `${preset.label} · ${days}` : days;
}

/** "2026-10-09..2026-10-16" in a URL, and back. */
export function rangeToParam(range: DayRange | null): string {
  if (!range) return "";
  const { from, to } = normalise(range);
  return to ? `${from}..${to}` : from;
}

export function rangeFromParam(value: string | null | undefined): DayRange | null {
  if (!value) return null;
  const [from, to] = value.split("..");
  if (!isDay(from)) return null;
  return to === undefined ? { from } : isDay(to) ? normalise({ from, to }) : null;
}
