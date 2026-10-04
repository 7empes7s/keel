import type { VerdictTone } from "@/components/verdict";
import { formatDuration } from "@/lib/resilience-view";
import { resourceTypeLabel } from "@/lib/presentation";

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
}

export interface FindingRow {
  id: string;
  controlId: string;
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
  period: PeriodKey;
  entity: string | null;
}

export const PERIODS = { "30d": { days: 30, label: "Last 30 days" }, "90d": { days: 90, label: "Last 90 days" }, "365d": { days: 365, label: "Last 12 months" } } as const;
export type PeriodKey = keyof typeof PERIODS;
export const DEFAULT_PERIOD: PeriodKey = "30d";

export function parsePeriod(value: string | string[] | undefined | null): PeriodKey {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw in PERIODS ? (raw as PeriodKey) : DEFAULT_PERIOD;
}

export function parseEntity(value: string | string[] | undefined | null): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && /^[A-Z][A-Z0-9_]{1,31}$/.test(raw) ? raw : null;
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
  "attempt-pending": "a try is waiting or running",
  "all-attempts-failed": "every try failed or was cancelled",
};

export function outcomeReason(reason: string): string {
  return REASONS[reason] ?? "the result could not be confirmed";
}

/** What an outcome was, without codes: "Restore of 3 settings" or "Group change put back". */
export function outcomeName(row: OutcomeRow): string {
  if (row.family === "restore") return `Restore of ${plural(row.resources ?? 0, "setting")}`;
  const type = row.resourceType ? resourceTypeLabel(row.resourceType) : "setting";
  const what = row.changeType === "added" ? "added" : row.changeType === "removed" ? "removed" : "changed";
  return `Undo a ${type} that was ${what}`;
}

export function percentText(value: number | null): string {
  return value === null ? "no outcomes" : `${value}%`;
}

export function outcomeSentence(outcomes: OutcomeSummary): string {
  if (outcomes.total === 0) return "KEEL was not asked to put anything back in this period.";
  const verified = outcomes.states.verified;
  const head = verified
    ? `KEEL put back and checked ${plural(verified, "item")} of ${outcomes.total} it was asked to (${percentText(outcomes.percentVerified)}).`
    : `KEEL was asked to put back ${plural(outcomes.total, "item")}; none is checked yet.`;
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
    return "Backup age: not measured, because some settings have never been backed up successfully.";
  }
  return `Backup age at the end of the period: the oldest setting was last backed up ${formatDuration(recovery.freshness.achievedRpoMs)} before.`;
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

export function hoursSentence(hours: HoursSaved): string {
  return `About ${hours.hours} hours saved, using the estimate set by ${hours.owner}. It counts checked results only, never tries.`;
}

export function hoursRow(row: HoursSaved["byFamily"][number]): string {
  return `${plural(row.verified, FAMILY_NAMES[row.family], `${FAMILY_NAMES[row.family]}s`)} × ${row.minutesEach} minutes = ${row.hours} hours`;
}

export function scopeSentence(report: ValueReport): string {
  if (report.scope.central) return "Showing the whole tenant.";
  if (report.scope.entities.length === 0) return "Showing nothing: you do not own any part of the tenant.";
  return `Showing only what ${report.scope.entities.join(", ")} own${report.scope.entities.length === 1 ? "s" : ""}.`;
}

export function valueVerdict(report: ValueReport): { headline: string; text: string; tone: VerdictTone } {
  const { outcomes } = report;
  const open = outcomes.states.reopened + outcomes.states.failed;
  if (outcomes.total === 0) {
    return { headline: "Nothing to report yet", text: "No restores or undo requests in this period.", tone: "good" };
  }
  const text = `${outcomes.states.verified} of ${outcomes.total} put back and checked; ${open ? `${open} failed or changed again.` : "none failed."}`;
  if (outcomes.states.reopened || outcomes.states.failed) return { headline: `${percentText(outcomes.percentVerified)} checked`, text, tone: "attention" };
  return { headline: `${percentText(outcomes.percentVerified)} checked`, text, tone: "good" };
}

export const NO_COMPLIANCE_CLAIM = "This report shows what KEEL did and checked. It is not a statement of compliance with any regulation or framework.";
