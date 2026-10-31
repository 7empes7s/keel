import type { BadgeTone } from "@/components/ui/badge";
import type { IconName } from "@/components/shell/icons";
import type { VerdictTone } from "@/components/verdict";
import { plainKind } from "@/lib/baselines-view";
import { addDays, isDay, shortDay, toDay, type Day, type DayRange } from "@/lib/date-range";
import type { RiskTone } from "@/lib/menu-status";
import { workloadLabel } from "@/lib/compare-view";
import { dependencyName, formatDuration } from "@/lib/resilience-view";

// Roadmap task-100: the value report in words. Every number comes from
// engine/reports/value.mjs; this file only turns it into sentences. Hours appear only
// when the report carries a configured estimate, and the page never states compliance
// with any regulation.

export type OutcomeState = "verified" | "reopened" | "unconfirmed" | "queued" | "failed";
export type FindingState = "resolved" | "open" | "unchecked";

export const OUTCOME_STATE_ORDER: OutcomeState[] = ["verified", "reopened", "unconfirmed", "queued", "failed"];
export const FINDING_STATE_ORDER: FindingState[] = ["resolved", "open", "unchecked"];

export interface OutcomeSummary {
  total: number;
  states: Record<OutcomeState, number>;
  attempts: number;
  retries: number;
  percentVerified: number | null;
}

export interface OutcomeRow {
  id: string;
  family: "restore" | "remediation";
  state: OutcomeState;
  reason: string;
  attempts: number;
  retries: number;
  firstRequestedAt: string | null;
  lastEventAt: string | null;
  verifiedAt: string | null;
  reopenedAt: string | null;
  resources: number | null;
  resourceType: string | null;
  changeType: string | null;
  planId: string | null;
  driftId: string | null;
  attemptEventIds: string[];
  // The newest attempt's job; absent on reports written before it was added.
  lastJobId?: string | null;
}

export interface FindingRow {
  id: string;
  controlId: string;
  // The control's title from the engine's registry, when it still holds the control.
  title?: string | null;
  framework: string;
  edition: string;
  profile: string;
  state: FindingState;
  reopened: boolean;
  resolvedAt: string | null;
  resolvedBy: { evaluationId: string; evidenceSeq: string | null } | null;
  failedAt: string | null;
  lastEvaluatedAt: string | null;
  lastVerdict: string;
  lastEvaluationId: string;
}

export type Withheld = { withheld: true };

export interface FindingsSection {
  withheld: false;
  total: number;
  states: Record<FindingState, number>;
  reopened: number;
  percentResolved: number | null;
  rows: FindingRow[];
  rowsShown: number;
}

export interface RecoverySection {
  withheld: false;
  recoveryTime: {
    state: "measured" | "unmeasured";
    samples: number;
    medianMs: number | null;
    worstMs: number | null;
    notCounted: number;
    drills: number;
    restores: number;
  };
  freshness: { state: "measured" | "gaps" | "unmeasured"; achievedRpoMs: number | null; gaps: number; asOf: string };
  recoverablePoint: { state: "measured" | "unmeasured"; ageMs: number | null; asOf: string };
}

/** One backed-up area (a workload) and how its runs in the period went. */
export type BackupAreaState = "good" | "partial" | "failed" | "not-run";
export interface BackupArea {
  workload: string;
  state: BackupAreaState;
  goodRuns: number;
  partialRuns: number;
  failedRuns: number;
  lastGoodAt: string | null;
}

/** One backup family's counts. The area breakdown is absent on reports made before it was counted. */
export interface BackupFamily {
  runs: number;
  workloads: number;
  expected: number;
  lastAt: string | null;
  partial?: number;
  failed?: number;
  notRun?: number;
  areas?: BackupArea[];
}

/** Backups that finished well in the period, per family (engine/reports/value.mjs). */
export interface BackupSection {
  withheld: false;
  // `partial`: settings backups that could not read some types in full. Absent on older reports.
  settings: { backups: number; partial?: number; lastAt: string | null };
  serviceSettings: BackupFamily;
  content: BackupFamily & { itemsStored: number; bytesStored: number };
}

export interface HoursSaved {
  hours: number;
  byFamily: { family: "restore" | "remediation" | "finding"; verified: number; minutesEach: number; hours: number }[];
  notEstimated: ("restore" | "remediation" | "finding")[];
  assumptions: string[];
  owner: string;
  setAt: string | null;
  basis: "verified-outcomes-only";
}

export interface ValueReport {
  version: number;
  tenantRef: string;
  generatedAt: string;
  period: { from: string; to: string; days: number };
  scope: { central: boolean; entities: string[] };
  outcomes: OutcomeSummary & {
    byFamily: { restore: OutcomeSummary; remediation: OutcomeSummary };
    rows: OutcomeRow[];
    rowsShown: number;
    undoRunsExcluded: number | null;
  };
  findings: FindingsSection | Withheld;
  recovery: RecoverySection | Withheld;
  // Absent on a report made before every service was counted.
  backups?: BackupSection | Withheld;
  estimate: { state: "configured" | "not-configured" | "invalid"; source: string | null; problems?: string[] };
  hoursSaved: HoursSaved | null;
  complianceClaim: null;
  provenance: {
    reportVersion: number;
    countingRules: string[];
    sources: { restoreJobsRead: number; remediateJobsRead: number; collectionsChecked: number; evaluationsRead: number };
    complete: boolean;
    evidenceHead: { seq: string; hash: string; records: string } | null;
    digest: string;
  };
}

export interface ValueReportData {
  report: ValueReport;
  period: ReportWindow;
  // The owners the report is narrowed to; several add up (any of them). None: everyone.
  entities: string[];
  // Owner codes the reader may narrow to: every owner for a tenant-wide reader, their own otherwise.
  owners?: string[];
}

export const PERIODS = { "30d": { days: 30, label: "Last 30 days" }, "90d": { days: 90, label: "Last 90 days" }, "365d": { days: 365, label: "Last 12 months" } } as const;
export type PeriodKey = keyof typeof PERIODS;
export const DEFAULT_PERIOD: PeriodKey = "30d";
/** The engine's longest period (MAX_PERIOD_DAYS in engine/reports/value.mjs). */
export const MAX_REPORT_DAYS = 366;
const DAY_MS = 86_400_000;

export function parsePeriod(value: string | string[] | undefined | null): PeriodKey {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw in PERIODS ? (raw as PeriodKey) : DEFAULT_PERIOD;
}

/** The period a report covers: a preset ("30d", "90d", "365d") or whole days ("2026-09-01..2026-09-30"). */
export interface ReportWindow {
  // What goes back into the URL as `period=`.
  param: string;
  preset: PeriodKey | null;
  from: string;
  to: string;
}

/**
 * `period=` as a window ending at `now`. Old links (`30d`, `90d`, `365d`) keep working;
 * a custom range runs from the start of its first day to the end of its last (never past
 * now) and is cut to the engine's longest period. Anything else is the default preset.
 */
export function resolvePeriod(value: string | string[] | undefined | null, now: Date | string): ReportWindow {
  const raw = Array.isArray(value) ? value[0] : value;
  const end = new Date(now);
  if (raw && raw.includes("..")) {
    const [first, last] = raw.split("..");
    if (isDay(first) && isDay(last)) {
      const [a, b] = first <= last ? [first, last] : [last, first];
      const to = Math.min(end.getTime(), Date.parse(`${b}T00:00:00Z`) + DAY_MS);
      let from = Date.parse(`${a}T00:00:00Z`);
      if (from < to) {
        if (to - from > MAX_REPORT_DAYS * DAY_MS) from = to - MAX_REPORT_DAYS * DAY_MS;
        const fromDay = toDay(new Date(from));
        return { param: `${fromDay}..${b}`, preset: null, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
      }
    }
  }
  const preset = parsePeriod(raw);
  return { param: preset, preset, from: new Date(end.getTime() - PERIODS[preset].days * DAY_MS).toISOString(), to: end.toISOString() };
}

/** The picker's quick choices, as day ranges ending today. */
export function periodPresets(today: Day): { id: PeriodKey; label: string; range: DayRange }[] {
  return (Object.keys(PERIODS) as PeriodKey[]).map((key) => ({ id: key, label: PERIODS[key].label, range: { from: addDays(today, -PERIODS[key].days), to: today } }));
}

/** What the picker shows as chosen. */
export function periodRange(window: ReportWindow, today: Day): DayRange {
  if (window.preset) return periodPresets(today).find((preset) => preset.id === window.preset)!.range;
  const [from, to] = window.param.split("..");
  return { from, to };
}

/** A picked range back to `period=`: a preset key when it is one, else the days. */
export function periodParam(range: DayRange, today: Day): string {
  const to = range.to ?? range.from;
  const preset = periodPresets(today).find((entry) => entry.range.from === range.from && entry.range.to === to);
  return preset ? preset.id : `${range.from}..${to}`;
}

/** "Last 30 days · 2 Sep to 2 Oct" or "1 Sep to 30 Sep". */
export function periodWords(window: ReportWindow, today: Day): string {
  const from = shortDay(window.from.slice(0, 10), today);
  const lastDay = toDay(new Date(Date.parse(window.to) - (window.preset ? 0 : 1)));
  const days = `${from} to ${shortDay(lastDay, today)}`;
  return window.preset ? `${PERIODS[window.preset].label} · ${days}` : days;
}

export function parseEntity(value: string | string[] | undefined | null): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && /^[A-Z][A-Z0-9_]{1,31}$/.test(raw) ? raw : null;
}

/** `entity=FIN,HR`: the owners picked, valid codes only, repeats dropped. An old
 * single-owner link reads as one. */
export function parseEntities(value: string | string[] | undefined | null): string[] {
  const raw = Array.isArray(value) ? value[0] : value;
  return [...new Set((raw ?? "").split(",").map((entry) => parseEntity(entry.trim())).filter((entry): entry is string => entry !== null))].slice(0, 50);
}

export function isWithheld<T extends object>(section: T | Withheld): section is Withheld {
  return (section as Withheld).withheld === true;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export const OUTCOME_STATE_LABELS: Record<OutcomeState, string> = {
  verified: "Put back and checked",
  reopened: "Changed again",
  unconfirmed: "Done, not yet checked",
  queued: "Waiting or running",
  failed: "Failed",
};

export const FINDING_STATE_LABELS: Record<FindingState, string> = {
  resolved: "Fixed",
  open: "Still failing",
  unchecked: "Could not be checked",
};

const REASONS: Record<string, string> = {
  "journal-and-completion-verified": "every setting was read back after writing, and every follow-up task was checked",
  "collection-shows-baseline": "a later backup shows the setting back at its approved value",
  "changed-again": "a later backup shows it changed again",
  "no-write-record": "the restore finished but left no record of each setting being read back",
  "write-not-confirmed": "at least one setting was not confirmed after writing",
  "completion-pending": "follow-up tasks after the restore are still open",
  "no-later-collection": "no backup since then could confirm the setting",
  "collection-still-differs": "the latest backup still shows the change",
  "attempt-pending": "an attempt is waiting or running",
  "all-attempts-failed": "every attempt failed or was cancelled",
};

export function outcomeReason(reason: string): string {
  return REASONS[reason] ?? "the result could not be confirmed";
}

/** What an outcome was, without codes: "Restore of 3 settings" or "Group change put back". */
export function outcomeName(row: OutcomeRow): string {
  if (row.family === "restore") return `Restore of ${plural(row.resources ?? 0, "setting")}`;
  const type = row.resourceType ? plainKind(row.resourceType).toLowerCase() : "setting";
  if (row.changeType === "added") return `Undo a ${type} that was added`;
  if (row.changeType === "removed") return `Undo a ${type} that was removed`;
  return `Undo a change to a ${type}`;
}

export function percentText(value: number | null): string {
  return value === null ? "no outcomes" : `${value}%`;
}

export function outcomeSentence(outcomes: OutcomeSummary): string {
  if (outcomes.total === 0) return "Keel was not asked to put anything back in this period.";
  const verified = outcomes.states.verified;
  const head = verified
    ? `Keel put back and checked ${plural(verified, "item")} of ${outcomes.total} it was asked to (${percentText(outcomes.percentVerified)}).`
    : `Keel was asked to put back ${plural(outcomes.total, "item")}; none is checked yet.`;
  const retries = outcomes.retries ? ` ${plural(outcomes.retries, "retry", "retries")} counted once each.` : "";
  return `${head}${retries}`;
}

export function findingSentence(findings: FindingsSection | Withheld): string {
  if (isWithheld(findings)) return "Control findings cover the whole tenant, so they are shown only to people who can read all of it.";
  if (findings.total === 0) return "No control was failing in this period.";
  const parts = [`${plural(findings.states.resolved, "failing control")} fixed`, `${findings.states.open} still failing`];
  if (findings.states.unchecked) parts.push(`${findings.states.unchecked} could not be checked`);
  const reopened = findings.reopened ? ` ${plural(findings.reopened, "control")} failed again after being fixed, so ${findings.reopened === 1 ? "it is" : "they are"} counted as failing.` : "";
  return `${parts.join(", ")}.${reopened}`;
}

export function recoverySentence(recovery: RecoverySection | Withheld): string {
  if (isWithheld(recovery)) return "Recovery measurements cover the whole tenant, so they are shown only to people who can read all of it.";
  const time = recovery.recoveryTime;
  if (time.state === "unmeasured") return "Recovery time: not measured in this period. No checked drill or restore finished.";
  return `Recovery time: measured ${plural(time.samples, "time")}; the middle one took ${formatDuration(time.medianMs)} and the slowest ${formatDuration(time.worstMs)}.`;
}

export function freshnessSentence(recovery: RecoverySection): string {
  if (recovery.freshness.state !== "measured" || recovery.freshness.achievedRpoMs === null) {
    return "Backup age: not measured, because something Keel backs up has never been backed up successfully.";
  }
  return `Backup age at the end of the period: the oldest backup of any service was ${formatDuration(recovery.freshness.achievedRpoMs)} old.`;
}

function bytesShort(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

// The backups card (pick: stat tiles, problems first, one compact table of areas).
export const BACKUP_AREA_WORDS: Record<BackupAreaState, { label: string; badge: BadgeTone; icon: IconName; rank: number }> = {
  failed: { label: "Failed", badge: "urgent", icon: "x-circle", rank: 0 },
  partial: { label: "Backed up in part", badge: "soon", icon: "alert", rank: 1 },
  "not-run": { label: "Did not run", badge: "soon", icon: "clock", rank: 2 },
  good: { label: "Backed up", badge: "fine", icon: "check-circle", rank: 3 },
};

export type BackupFamilyKey = "settings" | "service-settings" | "content";

export interface BackupTile {
  key: BackupFamilyKey;
  label: string;
  icon: IconName;
  count: number | null;
  of: number | null;
  word: string | null;
  detail: string;
  problem: string | null;
  problemTone: BadgeTone;
  tone: BadgeTone;
  meter: { tone: string; value: number }[] | null;
}

export interface BackupAreaRow extends BackupArea {
  family: Exclude<BackupFamilyKey, "settings">;
  name: string;
}

export interface BackupAreaGroup {
  family: Exclude<BackupFamilyKey, "settings">;
  label: string;
  rows: BackupAreaRow[];
}

export type BackupView =
  | { state: "missing" | "withheld"; text: string }
  | { state: "shown"; tiles: BackupTile[]; groups: BackupAreaGroup[]; needsLook: number; headline: { text: string; tone: BadgeTone }; note: string | null };

const FAMILY_LABELS: Record<Exclude<BackupFamilyKey, "settings">, string> = { "service-settings": "Service settings", content: "Content" };

function areaName(family: Exclude<BackupFamilyKey, "settings">, workload: string): string {
  if (family === "content") return CONTENT_AREA_NAMES[workload] ?? dependencyName(`content:${workload}`).replace(/ \(content\)$/, "");
  return workloadLabel(workload);
}

// Content areas as Microsoft names them (engine/content/collectors.mjs).
const CONTENT_AREA_NAMES: Record<string, string> = {
  "exchange-mail": "Mail, calendars and contacts",
  "group-conversations": "Group conversations",
  onedrive: "OneDrive files",
  sharepoint: "SharePoint document libraries",
  "sharepoint-sites": "SharePoint sites, lists and files",
  teams: "Teams, channels and tabs",
  planner: "Planner plans and tasks",
};

function familyCounts(family: BackupFamily) {
  const partial = family.partial ?? 0;
  const failed = family.failed ?? 0;
  const notRun = family.notRun ?? Math.max(0, family.expected - family.workloads - partial - failed);
  return { partial, failed, notRun };
}

function familyProblem(family: BackupFamily): string | null {
  const { partial, failed, notRun } = familyCounts(family);
  const parts = [];
  if (failed) parts.push(`${failed} failed`);
  if (partial) parts.push(`${partial} in part`);
  if (notRun) parts.push(`${notRun} did not run`);
  return parts.length ? parts.join(" · ") : null;
}

function problemTone(family: BackupFamily): BadgeTone {
  return familyCounts(family).failed ? "urgent" : "soon";
}

function familyTone(family: BackupFamily): BadgeTone {
  if (!family.expected) return "neutral";
  const { partial, failed, notRun } = familyCounts(family);
  if (failed || family.workloads === 0) return "urgent";
  return partial || notRun ? "soon" : "fine";
}

function familyMeter(family: BackupFamily): BackupTile["meter"] {
  if (!family.expected) return null;
  const { partial, failed } = familyCounts(family);
  return [{ tone: "fine", value: family.workloads }, { tone: "soon", value: partial }, { tone: "urgent", value: failed }];
}

/** What the backups card shows: three tiles, then every area grouped by family with problems first. */
export function backupView(backups: BackupSection | Withheld | undefined): BackupView {
  if (!backups) return { state: "missing", text: "This report was made before backups of every service were counted." };
  if (isWithheld(backups)) return { state: "withheld", text: "Backups cover the whole tenant, so they are shown only to people who can read all of it." };
  const { settings, serviceSettings, content } = backups;
  const settingsPartial = settings.partial ?? 0;
  const tiles: BackupTile[] = [
    {
      key: "settings", label: "Entra ID and Intune", icon: "service-entra", count: settings.backups, of: null, word: null,
      detail: settings.backups === 1 ? "complete backup" : "complete backups",
      problem: !settings.backups ? `No complete backup in this period${settingsPartial ? `; ${settingsPartial} only partly done` : ""}`
        : settingsPartial ? `${settingsPartial} more only partly done` : null,
      problemTone: settings.backups ? "soon" : "urgent",
      tone: !settings.backups ? "urgent" : settingsPartial ? "soon" : "fine", meter: null,
    },
    {
      key: "service-settings", label: "Service settings", icon: "settings",
      count: serviceSettings.expected ? serviceSettings.workloads : null, of: serviceSettings.expected || null,
      word: serviceSettings.expected ? null : "None yet",
      detail: serviceSettings.expected ? `areas backed up · ${plural(serviceSettings.runs, "good run")}` : "No service settings backup is switched on yet",
      problem: familyProblem(serviceSettings), problemTone: problemTone(serviceSettings), tone: familyTone(serviceSettings), meter: familyMeter(serviceSettings),
    },
    {
      key: "content", label: "Content", icon: "cloud",
      count: content.expected ? content.workloads : null, of: content.expected || null,
      word: content.expected ? null : "None yet",
      detail: content.expected || content.itemsStored
        ? `areas backed up · ${plural(content.itemsStored, "new item")} stored (${bytesShort(content.bytesStored)})`
        : "No content backup has run yet",
      problem: familyProblem(content), problemTone: problemTone(content), tone: familyTone(content), meter: familyMeter(content),
    },
  ];
  const groups = (["service-settings", "content"] as const)
    .map((family): BackupAreaGroup => {
      const source = family === "content" ? content : serviceSettings;
      const rows = (source.areas ?? [])
        .map((area) => ({ ...area, family, name: areaName(family, area.workload) }))
        .sort((a, b) => BACKUP_AREA_WORDS[a.state].rank - BACKUP_AREA_WORDS[b.state].rank || a.name.localeCompare(b.name));
      return { family, label: FAMILY_LABELS[family], rows };
    })
    .filter((group) => group.rows.length > 0)
    .sort((a, b) => worstRank(a) - worstRank(b));
  const needsLook = [serviceSettings, content].reduce((sum, family) => { const c = familyCounts(family); return sum + c.partial + c.failed + c.notRun; }, 0)
    + (settings.backups && !settingsPartial ? 0 : 1);
  const urgent = !settings.backups || [serviceSettings, content].some((family) => familyTone(family) === "urgent");
  const headline = needsLook
    ? { text: `${plural(needsLook, "area needs", "areas need")} a look`, tone: urgent ? "urgent" as const : "soon" as const }
    : { text: "Everything backed up", tone: "fine" as const };
  const note = content.itemsStored && familyCounts(content).partial
    ? "New items count everything stored in the period, including items from areas backed up only in part."
    : null;
  return { state: "shown", tiles, groups, needsLook, headline, note };
}

function worstRank(group: BackupAreaGroup): number {
  return Math.min(...group.rows.map((row) => BACKUP_AREA_WORDS[row.state].rank));
}

const ESTIMATE_PROBLEMS: Record<string, string> = {
  "not-an-object": "the estimate file could not be read",
  "no-minutes": "no minutes per checked result",
  "no-assumptions": "no written assumptions",
  "no-owner": "no owner",
};

export function estimateNote(report: ValueReport): string {
  if (report.estimate.state === "configured") return "";
  if (report.estimate.state === "not-configured") return "No time-saving estimate is set, so this report shows no hours saved.";
  const problems = (report.estimate.problems ?? []).map((problem) => ESTIMATE_PROBLEMS[problem] ?? "a value that is not allowed");
  return `The time-saving estimate is incomplete (${[...new Set(problems)].join(", ")}), so this report shows no hours saved.`;
}

const FAMILY_NAMES = { restore: "checked restore", remediation: "checked undo of a change", finding: "fixed control" } as const;

/** Who set the estimate, as written, unless it is an email address. */
export function estimateOwner(hours: HoursSaved): string {
  return hours.owner.includes("@") ? "the estimate owner" : hours.owner;
}

export function hoursSentence(hours: HoursSaved): string {
  return `About ${hours.hours} hours saved, using the estimate set by ${estimateOwner(hours)}. It counts checked results only, never attempts.`;
}

export function hoursRow(row: HoursSaved["byFamily"][number]): string {
  return `${plural(row.verified, FAMILY_NAMES[row.family], `${FAMILY_NAMES[row.family]}s`)} × ${row.minutesEach} minutes = ${row.hours} hours`;
}

/** An owner code in plain case: "FIN" reads "Fin", "IT_OPS" reads "It ops". No name table exists for owners. */
export function ownerName(code: string): string {
  const words = code.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function scopeSentence(report: ValueReport): string {
  if (report.scope.central) return "Showing the whole tenant.";
  if (report.scope.entities.length === 0) return "Showing nothing: you do not own any part of the tenant.";
  const names = report.scope.entities.map(ownerName);
  return `Showing only what ${names.join(", ")} own${names.length === 1 ? "s" : ""}.`;
}

/** Failed or changed again: the requests that need someone to look. */
export function needsLook(outcomes: OutcomeSummary): number {
  return outcomes.states.failed + outcomes.states.reopened;
}

export function valueVerdict(report: ValueReport): { text: string; detail?: string; tone: VerdictTone } {
  const { outcomes } = report;
  if (outcomes.total === 0) return { text: "Nothing to report yet: no restores or undo requests in this period.", tone: "good" };
  const open = needsLook(outcomes);
  const text = `${outcomes.states.verified} of ${plural(outcomes.total, "request")} put back and checked; ${open ? `${open} failed or changed again.` : "none failed."}`;
  return { text, tone: open ? "attention" : "good" };
}

/** The page header's pill. */
export function valueStatus(report: ValueReport): { tone: RiskTone; label: string } {
  const { outcomes } = report;
  const open = needsLook(outcomes);
  if (open) return { tone: "soon", label: `${open} need${open === 1 ? "s" : ""} a look` };
  if (outcomes.total === 0) return { tone: "fine", label: "Nothing to report" };
  const waiting = outcomes.total - outcomes.states.verified;
  return waiting ? { tone: "low", label: `${waiting} not checked yet` } : { tone: "fine", label: "All checked" };
}

export const OUTCOME_WORDS: Record<OutcomeState, { badge: BadgeTone; tone: RiskTone | null; icon: IconName; rank: number; swatch: string }> = {
  failed: { badge: "urgent", tone: "urgent", icon: "x-circle", rank: 0, swatch: "urgent" },
  reopened: { badge: "soon", tone: "soon", icon: "alert", rank: 1, swatch: "soon" },
  queued: { badge: "neutral", tone: null, icon: "play", rank: 2, swatch: "neutral" },
  unconfirmed: { badge: "low", tone: "low", icon: "clock", rank: 3, swatch: "low" },
  verified: { badge: "fine", tone: "fine", icon: "check-circle", rank: 4, swatch: "fine" },
};

/** The chart's order: good first, worst last, as in the mockup legend. */
export const CHART_ORDER: OutcomeState[] = ["verified", "unconfirmed", "queued", "reopened", "failed"];

export const FINDING_WORDS: Record<FindingState, { badge: BadgeTone; icon: IconName }> = {
  open: { badge: "urgent", icon: "x-circle" },
  unchecked: { badge: "neutral", icon: "info" },
  resolved: { badge: "fine", icon: "check-circle" },
};

export const FAMILY_WORDS = { restore: { label: "Restores", one: "Restore", icon: "restore" as IconName }, remediation: { label: "Undo changes", one: "Undo a change", icon: "refresh" as IconName } } as const;

/** Failed and changed again first, then waiting, then not checked, then checked; newest first inside each. */
export function orderOutcomes(rows: OutcomeRow[]): OutcomeRow[] {
  return [...rows].sort((a, b) => OUTCOME_WORDS[a.state].rank - OUTCOME_WORDS[b.state].rank
    || String(outcomeWhen(b) ?? "").localeCompare(String(outcomeWhen(a) ?? "")) || a.id.localeCompare(b.id));
}

export function outcomeWhen(row: OutcomeRow): string | null {
  return row.verifiedAt ?? row.reopenedAt ?? row.lastEventAt;
}

/** The line under a request's name: "Restore · 10 Sep" or "Sign-in rule · 28 Sep". */
export function outcomeMeta(row: OutcomeRow, today: Day): string {
  const kind = row.family === "restore" ? "Restore" : row.resourceType ? plainKind(row.resourceType) : "Undo a change";
  const when = outcomeWhen(row);
  return when ? `${kind} · ${shortDay(when.slice(0, 10), today)}` : kind;
}

/** Where a request's row goes: its newest job, or Activity for a report without job ids. */
export function outcomeHref(row: OutcomeRow): string {
  return row.lastJobId ? `/jobs/${encodeURIComponent(row.lastJobId)}` : "/activity";
}

export function attemptsWord(count: number): string {
  return plural(count, "attempt");
}

/** The request's reason, as a sentence. */
export function reasonSentence(reason: string): string {
  const text = outcomeReason(reason);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** "Groups have at least two owners": the portal's own plain title, else the registry's, never the code. */
export function findingTitle(row: FindingRow, plainTitle: (controlId: string) => string | null = () => null): string {
  return plainTitle(row.controlId) ?? row.title ?? "A security check Keel no longer holds";
}

/** The line under a security check's result. */
export function findingLine(row: FindingRow, today: Day): string {
  const day = (value: string | null) => (value ? shortDay(value.slice(0, 10), today) : null);
  if (row.state === "resolved") return row.resolvedAt ? `Passing since ${day(row.resolvedAt)}` : "Passing on the newest check";
  if (row.state === "unchecked") return "Keel could not read what this check needs";
  return row.reopened ? `Failed again on ${day(row.failedAt) ?? "a later check"} after being fixed` : `Failing since ${day(row.failedAt) ?? "the start of the period"}`;
}

/** Durations for the recovery card: "14 min", "5 h". */
export function shortDuration(ms: number | null): string {
  if (ms === null) return "Not measured";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "Under 1 min";
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export const HOURS_FAMILY_WORDS = { restore: "Checked restores", remediation: "Checked undo of a change", finding: "Fixed security checks" } as const;

/** "~2 h" on the tile; "About 1.5 hours" in the card. */
export function hoursShort(hours: number): string {
  return `~${hours} h`;
}

export const NO_COMPLIANCE_CLAIM = "This report shows what Keel did and checked. It is not a statement of compliance with any regulation or framework.";
