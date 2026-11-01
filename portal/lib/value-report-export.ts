import { plainControlTitle } from "@/lib/compliance-view";
import {
  FAMILY_WORDS,
  FINDING_STATE_LABELS,
  HOURS_FAMILY_WORDS,
  NO_COMPLIANCE_CLAIM,
  OUTCOME_STATE_LABELS,
  OUTCOME_STATE_ORDER,
  findingTitle,
  isWithheld,
  orderOutcomes,
  outcomeName,
  outcomeWhen,
  reasonSentence,
  scopeSentence,
  type ValueReport,
} from "@/lib/value-report-view";
import { workbook, type Cell, type Sheet } from "@/lib/xlsx";

// The value report as an Excel workbook, in the page's own words: a summary sheet, one
// row per request, one per security check, and the time-saving estimate when one is
// set. Ids sit in their own last column, as on the page's Technical details.

const day = (value: string | null): string => (value ? value.slice(0, 10) : "");

export function valueReportSheets(report: ValueReport): Sheet[] {
  const { outcomes, findings, recovery, hoursSaved } = report;
  const summary: Cell[][] = [
    ["Value report", ""],
    ["Period", `${day(report.period.from)} to ${day(report.period.to)}`],
    ["Showing", scopeSentence(report)],
    ["Prepared", report.generatedAt],
    ["Requests", outcomes.total],
    ...OUTCOME_STATE_ORDER.map((state): Cell[] => [OUTCOME_STATE_LABELS[state], outcomes.states[state]]),
    ["Attempts", outcomes.attempts],
    ["Restores", outcomes.byFamily.restore.total],
    ["Undo changes", outcomes.byFamily.remediation.total],
  ];
  if (!isWithheld(findings)) {
    summary.push(["Security checks that failed in the period", findings.total]);
    for (const state of ["resolved", "open", "unchecked"] as const) summary.push([`Security checks: ${FINDING_STATE_LABELS[state].toLowerCase()}`, findings.states[state]]);
  }
  if (!isWithheld(recovery)) {
    summary.push(["Middle restore time (minutes)", recovery.recoveryTime.medianMs === null ? "Not measured" : Math.round(recovery.recoveryTime.medianMs / 60_000)]);
    summary.push(["Slowest restore time (minutes)", recovery.recoveryTime.worstMs === null ? "Not measured" : Math.round(recovery.recoveryTime.worstMs / 60_000)]);
    summary.push(["Oldest backup at the end (hours)", recovery.freshness.achievedRpoMs === null ? "Not measured" : Math.round(recovery.freshness.achievedRpoMs / 360_000) / 10]);
  }
  summary.push(["Time saved (hours, estimate)", hoursSaved ? hoursSaved.hours : "No estimate set"]);
  summary.push(["Every source read", report.provenance.complete ? "Yes" : "No, the counts are incomplete"]);
  summary.push(["Note", NO_COMPLIANCE_CLAIM]);
  summary.push(["Report digest", report.provenance.digest]);

  const requests: Cell[][] = [["What was asked", "Type", "Result", "Why", "Attempts", "First asked", "Last activity", "Job ID", "Outcome ID"]];
  for (const row of orderOutcomes(outcomes.rows)) {
    requests.push([outcomeName(row), FAMILY_WORDS[row.family].one, OUTCOME_STATE_LABELS[row.state], reasonSentence(row.reason), row.attempts, day(row.firstRequestedAt), day(outcomeWhen(row)), row.lastJobId ?? "", row.id]);
  }
  if (outcomes.rowsShown < outcomes.total) requests.push([`Showing ${outcomes.rowsShown} of ${outcomes.total}. The summary counts every request.`]);

  const sheets: Sheet[] = [{ name: "Summary", rows: summary }, { name: "Requests", rows: requests }];
  if (!isWithheld(findings)) {
    const checks: Cell[][] = [["Security check", "Result", "Failed again after a fix", "Failed on", "Fixed on", "Newest check", "Control ID"]];
    for (const row of findings.rows) checks.push([findingTitle(row, plainControlTitle), FINDING_STATE_LABELS[row.state], row.reopened ? "Yes" : "No", day(row.failedAt), day(row.resolvedAt), day(row.lastEvaluatedAt), row.controlId]);
    sheets.push({ name: "Security checks", rows: checks });
  }
  if (hoursSaved) {
    const hours: Cell[][] = [["What", "Count", "Minutes each", "Hours"]];
    for (const row of hoursSaved.byFamily) hours.push([HOURS_FAMILY_WORDS[row.family], row.verified, row.minutesEach, row.hours]);
    hours.push(["Total", "", "", hoursSaved.hours]);
    hours.push([]);
    hours.push(["Assumptions"]);
    for (const assumption of hoursSaved.assumptions) hours.push([assumption]);
    sheets.push({ name: "Time saved", rows: hours });
  }
  return sheets;
}

export function valueReportXlsx(report: ValueReport): Uint8Array {
  return workbook(valueReportSheets(report));
}
