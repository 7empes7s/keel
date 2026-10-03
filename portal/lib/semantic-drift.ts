// Roadmap task-98: the words for semantic drift and its linked records. Server and
// client components share these; nothing here reads data.
import type { ChangeEvidence, DriftRecord, EvidenceApproval, EvidenceLinkState, SemanticChange } from "@/lib/types";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function semanticSummarySentence(change: SemanticChange, changeType: DriftRecord["changeType"]): string {
  if (change.state === "added") return "This exists in the tenant but not in the baseline.";
  if (change.state === "removed") return "This is in the baseline but no longer exists in the tenant.";
  if (change.state === "unknown-before") {
    return "KEEL did not keep the baseline's copy of this, so the earlier values are not known. Nothing is shown as removed.";
  }
  if (change.state === "unknown-after") return "KEEL did not keep the current copy of this, so the new values are not known.";
  if (change.total === 0) {
    return change.cosmetic > 0
      ? "Only settings Microsoft manages itself differ. Nothing that changes behaviour was changed."
      : changeType === "modified" ? "No setting KEEL compares differs from the baseline." : "Nothing to compare.";
  }
  return `${plural(change.total, "setting differs", "settings differ")} from the baseline in a way that changes behaviour.`;
}

export function cosmeticSentence(change: SemanticChange): string | null {
  if (change.cosmetic === 0) return null;
  return `${plural(change.cosmetic, "setting Microsoft manages itself also differs", "settings Microsoft manages itself also differ")}. They do not change behaviour and are not shown.`;
}

export const IMPACT_HEADINGS: Record<"fixed" | "behaviour" | "unknown-before", string> = {
  fixed: "Cannot be changed back in place",
  behaviour: "Changes behaviour",
  "unknown-before": "Earlier value not known",
};

// The collection that saw the change, and the baseline's backup copy.
const SEEN_WORDS: Record<EvidenceLinkState, string> = {
  matches: "The backup that found this change holds exactly what it recorded.",
  mismatch: "The backup that found this change holds something different from what it recorded.",
  missing: "The backup that found this change is no longer stored.",
  unchecked: "The backup that found this change is stored, but the change did not record what it saw, so KEEL cannot check it.",
  "not-in-baseline": "The backup that found this change is stored.",
};

const BASELINE_WORDS: Record<EvidenceLinkState, string> = {
  matches: "The baseline's copy matches what this change compares against.",
  mismatch: "The baseline's copy differs from what this change compares against.",
  missing: "The baseline holds no copy of this, so KEEL cannot check what it compared against.",
  unchecked: "The baseline holds a copy, but the change did not record what it compared against, so KEEL cannot check it.",
  "not-in-baseline": "This is not in the baseline, so there is no earlier copy.",
};

export function seenSentence(evidence: ChangeEvidence): string {
  return SEEN_WORDS[evidence.observation.state];
}

export function baselineSentence(evidence: ChangeEvidence): string {
  return BASELINE_WORDS[evidence.backup.state];
}

export function ownerSentence(ownership: ChangeEvidence["ownership"]): string {
  switch (ownership.state) {
    case "owned":
      return ownership.entityCode ? `Owned by ${ownership.entityCode}.` : "Owned by an entity outside yours.";
    case "shared": {
      const named = ownership.sharedWith.join(" and ");
      if (!named) return "Shared between entities outside yours.";
      return ownership.othersWithheld ? `Shared by ${named} and other entities.` : `Shared by ${named}.`;
    }
    case "stale":
      return "Its owner record is out of date, so KEEL does not say who owns it.";
    default:
      return "KEEL does not know who owns this.";
  }
}

export function findingSentence(finding: ChangeEvidence["findings"][number]): string {
  const title = finding.title ?? "A compliance check KEEL no longer has";
  const state = finding.verdict === "fail" ? (finding.exposed ? "fails" : "fails under an approved exception")
    : finding.verdict === "pass" ? "passes" : finding.verdict === "unknown" ? "could not be checked" : "does not apply";
  return finding.link === "linked"
    ? `${title} ${state}, checked against the same backup that found this change.`
    : `${title} ${state}, but it was checked against a different backup, so it is not linked to this change.`;
}

const APPROVAL_STATUS: Record<string, string> = {
  pending: "waiting for a decision",
  approved: "approved",
  rejected: "rejected",
  expired: "expired without a decision",
};

const JOB_STATUS: Record<string, string> = {
  queued: "queued, not yet run",
  running: "running",
  succeeded: "finished",
  failed: "failed",
  cancelled: "cancelled",
};

export function approvalSentence(approval: EvidenceApproval): string {
  const what = approval.action === "remediate" ? "A roll-back request" : "A restore request";
  const status = APPROVAL_STATUS[approval.status] ?? "in an unknown state";
  const job = approval.job ? ` Its job is ${JOB_STATUS[approval.job.status] ?? "in an unknown state"}.` : "";
  const others = approval.othersWithheld
    ? " It also covers other changes."
    : approval.others ? ` It also covers ${plural(approval.others, "other change", "other changes")}.` : "";
  return `${what} is ${status}.${job}${others}`;
}

const OUTCOME_WORDS: Record<string, string> = {
  succeeded: "KEEL wrote it back and checked the result.",
  failed: "Microsoft refused the write.",
  uncertain: "KEEL cannot tell whether the write landed.",
  pending: "The write was interrupted before it finished.",
};

export function planSentence(plan: ChangeEvidence["plans"][number]): string {
  const source = plan.link === "linked"
    ? "It puts back the baseline's copy."
    : plan.link === "mismatch"
      ? "It restores from a different backup than the baseline's, so it is not linked to this change."
      : "KEEL cannot tell which backup the baseline came from.";
  const status = plan.status === "completed" ? "A roll-back plan is ready." : plan.status === "refused" ? "A roll-back plan was refused." : "A roll-back plan failed to build.";
  const outcome = plan.outcome ? ` Result: ${OUTCOME_WORDS[plan.outcome.state] ?? "not recorded."}` : " No result is recorded yet.";
  const others = plan.othersWithheld ? " It also covers other resources." : plan.others ? ` It also covers ${plural(plan.others, "other resource", "other resources")}.` : "";
  return `${status} ${source}${outcome}${others}`;
}
