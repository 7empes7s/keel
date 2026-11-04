// What earns each alarm level, defined once for the whole portal (UI audit 31 Oct, E1).
// Red means "a person must act today or something stays broken"; it is not a way to say
// "important". Pages pick their colour through these helpers, so the same situation is
// the same colour on Approvals, Alerts, Setup, the Overview and the menu. No imports, so
// any page or client component can use it.
//
//   Urgent (red)       Something is broken or exposed now and will not fix itself, or a
//                      deadline falls within the hour.
//   Check soon (amber) Needs a person this week. Nothing is lost yet, or Keel will retry
//                      by itself.
//   Low risk (blue)    Worth knowing. Nothing to do now.
//   Fine (green)       Working as it should.

export type Severity = "urgent" | "soon" | "low" | "fine";

export const SEVERITY_WORDS: Record<Severity, string> = { urgent: "Urgent", soon: "Check soon", low: "Low risk", fine: "Fine" };

/** The rule behind each level, in the words the portal shows when asked "why red?". */
export const SEVERITY_RULES: Record<Severity, string> = {
  urgent: "Something is broken or exposed now and will not fix itself, or a deadline falls within the hour.",
  soon: "Needs a person this week. Nothing is lost yet, or Keel will retry by itself.",
  low: "Worth knowing. Nothing to do now.",
  fine: "Working as it should.",
};

// ---- Approvals ----------------------------------------------------------------
// A waiting request changes nothing until someone approves it, and a lapsed one can be
// asked again. So waiting is amber, and only a request about to lapse is red. What the
// request would change (for example "Could lock out admins") is shown as its own badge,
// never as urgency.

/** A waiting request turns red when it lapses within this many hours. */
export const APPROVAL_URGENT_HOURS = 1;
/** And is listed as "expiring soon" (amber) within this many hours. */
export const APPROVAL_SOON_HOURS = 4;

export function approvalSeverity(hoursLeft: number | null): Severity {
  if (hoursLeft !== null && hoursLeft > 0 && hoursLeft <= APPROVAL_URGENT_HOURS) return "urgent";
  return "soon";
}

// ---- Alerts -------------------------------------------------------------------
// Critical is urgent and Warning is check soon (lib/alerts-view.ts SEVERITY). A Critical
// alert should always have someone chasing it: with no escalation rule it has no
// deadline, which is a gap in the setup and is shown as one.

/** How fast each alert severity should be acknowledged; null means no target. */
export const ACK_TARGET_HOURS: Record<"critical" | "warning" | "notice", number | null> = { critical: 4, warning: 24, notice: null };

// ---- Backups ------------------------------------------------------------------
// A failed kind is red only when a person must fix something (a missing permission or
// admin role). A failure Keel expects to clear on the next run (Microsoft slow, busy or
// briefly unavailable) is amber. Partly done and out of date are amber.

// backupFailureSeverity and failedNeedingFix live in lib/backup-failure.ts, beside the
// reasons they read.

/**
 * The colour of a "N failed" count. `needsFix` is how many of them need a person; when
 * it is not known, every failure counts as needing one, so nothing is played down.
 */
export function failedSeverity(failed: number, needsFix: number | undefined): Severity | null {
  if (failed <= 0) return null;
  return (needsFix ?? failed) > 0 ? "urgent" : "soon";
}
