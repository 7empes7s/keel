import { displayEnum, formatTimestamp, resourceLabel, resourceTypeLabel } from "@/lib/presentation";

// Roadmap task-99: the shapes engine/query/execute.mjs returns, and the words the Ask
// page shows for them. Sentences are built from counts and dates only; a record's own
// text (a name, an error) is shown as that record's data, never folded into a sentence.

export type AnswerStatus = "answered" | "partial" | "unknown" | "refused";
export type AskIntent = "changes" | "coverage" | "failed-jobs";

export interface AnswerWindow {
  from: string | null;
  to: string | null;
}

export interface AnswerGap {
  from: string;
  to: string;
  reason: "no-history" | "before-history" | "not-compared-yet";
}

export interface AnswerSource {
  kind: "change" | "collection" | "job";
  id: string;
  href: string;
  collectionId?: string | null;
}

export interface ChangeRecord {
  kind: "change";
  id: string;
  resourceType: string;
  naturalKey: string;
  name: string | null;
  changeType: string;
  impact: string;
  decision: string | null;
  seenAt: string | null;
  window: AnswerWindow;
  source: AnswerSource;
}

export interface CoverageRecord {
  kind: "coverage";
  id: string;
  resourceType: string;
  outcome: string;
  count: number | null;
  window: AnswerWindow;
  source: AnswerSource;
}

export interface JobRecord {
  kind: "job";
  id: string;
  jobKind: string;
  error: string | null;
  window: AnswerWindow;
  source: AnswerSource;
}

export type AnswerRecord = ChangeRecord | CoverageRecord | JobRecord;

export interface AnswerPlanParams {
  entity: string | null;
  from: string | null;
  to: string | null;
  resourceType: string | null;
  changeType: string | null;
  limit: number;
}

export interface GroundedAnswer {
  version: number;
  status: AnswerStatus;
  intent: AskIntent | null;
  plan: { intent: AskIntent; params: AnswerPlanParams } | null;
  understood: string | null;
  scope: { central: boolean; entities: string[] };
  window: { from: string; to: string } | null;
  known: { from: string | null; to: string | null } | null;
  gaps: AnswerGap[];
  total: number;
  shown: number;
  truncated: boolean;
  records: AnswerRecord[];
  refusal?: { code: string; message: string };
  readBy?: "rules" | "helper" | "form";
  question?: string | null;
  sentence: string;
  generatedAt: string;
}

export interface AskInput {
  question?: string;
  intent?: string;
  entity?: string;
  period?: string;
  resourceType?: string;
  changeType?: string;
}

export interface AskData {
  generatedAt: string;
  answer: GroundedAnswer | null;
  // The entities this reader may ask about (central: every entity KEEL knows).
  entities: string[];
  scope: { central: boolean; entities: string[] };
}

export const ASK_PERIODS: { value: string; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this-week", label: "This week" },
  { value: "last-week", label: "Last week" },
  { value: "last-7-days", label: "Last 7 days" },
  { value: "last-30-days", label: "Last 30 days" },
  { value: "this-month", label: "This month" },
];

export const ASK_INTENTS: { value: AskIntent; label: string }[] = [
  { value: "changes", label: "What changed" },
  { value: "coverage", label: "What the latest backup holds" },
  { value: "failed-jobs", label: "Which jobs failed" },
];

const SEARCH_KEYS = ["q", "intent", "entity", "period", "type", "change"] as const;

/** The page's query string as an engine request: a question, or a structured form. */
export function askInputFrom(params: Record<string, string | string[] | undefined>): AskInput | null {
  const value = (key: (typeof SEARCH_KEYS)[number]) => {
    const raw = params[key];
    const text = Array.isArray(raw) ? raw[0] : raw;
    return typeof text === "string" && text.trim() ? text.trim().slice(0, 500) : undefined;
  };
  const question = value("q");
  if (question) return { question };
  const intent = value("intent");
  if (!intent) return null;
  return {
    intent,
    entity: value("entity"),
    period: intent === "coverage" ? undefined : value("period"),
    resourceType: value("type"),
    changeType: intent === "changes" ? value("change") : undefined,
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The verdict: one plain sentence, at most 25 words, no ids. */
export function askVerdict(answer: GroundedAnswer | null): { text: string; tone: "good" | "attention" | "critical" } {
  if (!answer) return { text: "Ask about changes, backup coverage or failed jobs. Answers come only from KEEL's own records.", tone: "good" };
  if (answer.status === "refused") return { text: "KEEL did not run this question. The reason is below.", tone: "attention" };
  if (answer.status === "unknown") {
    return answer.intent
      ? { text: "Not known: KEEL has no record covering this, so it cannot say either way.", tone: "attention" }
      : { text: "KEEL cannot answer this question. It answers questions about changes, coverage and failed jobs.", tone: "attention" };
  }
  const noun = answer.intent === "failed-jobs" ? "failed job" : answer.intent === "coverage" ? "kind of resource" : "matching change";
  const found = answer.total === 0 ? `No ${noun}s found` : `${plural(answer.total, noun)} found`;
  if (answer.status === "partial") return { text: `${found}, but part of this period is not known yet.`, tone: "attention" };
  if (answer.intent === "failed-jobs" && answer.total > 0) return { text: `${found} in this period.`, tone: "critical" };
  return { text: answer.intent === "coverage" ? `${found} in the latest complete backup.` : `${found} in this period.`, tone: answer.total > 0 && answer.intent === "changes" ? "attention" : "good" };
}

/** "Understood as" in words, from the validated plan. */
export function understoodAs(answer: GroundedAnswer): string | null {
  if (!answer.plan) return null;
  const { intent, params } = answer.plan;
  const owner = params.entity ? ` owned by ${params.entity}` : "";
  const type = params.resourceType ? resourceTypeLabel(params.resourceType) : null;
  if (intent === "coverage") return `What the latest complete backup holds${type ? ` for each ${type}` : ""}${owner}.`;
  const period = `from ${formatTimestamp(params.from)} to ${formatTimestamp(params.to)}`;
  if (intent === "failed-jobs") return `Jobs that failed ${period}.`;
  const kind = params.changeType ? `${displayEnum("changeType", params.changeType).toLowerCase()} ` : "";
  return `Changes${kind ? ` (${kind.trim()})` : ""}${type ? ` to a ${type}` : ""}${owner}, seen ${period}.`;
}

export function gapSentence(gap: AnswerGap): string {
  const span = `${formatTimestamp(gap.from)} to ${formatTimestamp(gap.to)}`;
  switch (gap.reason) {
    case "no-history": return `Not known from ${span}: KEEL has no record for this period.`;
    case "before-history": return `Not known from ${span}: KEEL had not compared a backup yet.`;
    default: return `Not known from ${span}: KEEL has not compared a backup since then.`;
  }
}

export function recordTitle(record: AnswerRecord): string {
  switch (record.kind) {
    case "change": return resourceLabel(record.naturalKey, record.name);
    case "coverage": return `${resourceTypeLabel(record.resourceType)[0].toUpperCase()}${resourceTypeLabel(record.resourceType).slice(1)}`;
    default: return displayEnum("jobKind", record.jobKind);
  }
}

const OUTCOME_LABEL: Record<string, string> = {
  complete: "Read completely",
  "complete-empty": "Read completely, none exist",
  partial: "Read only in part",
  failed: "Could not be read",
  "not-requested": "Not part of this backup",
  "not-recorded": "Not recorded",
};

export function recordSentence(record: AnswerRecord): string {
  switch (record.kind) {
    case "change": {
      const what = displayEnum("changeType", record.changeType);
      const decided = record.decision ? ` Decision: ${displayEnum("decision", record.decision).toLowerCase()}.` : "";
      return `${what}. ${displayEnum("blastRadius", record.impact)}.${decided}`;
    }
    case "coverage": {
      const outcome = OUTCOME_LABEL[record.outcome] ?? "Not recorded";
      return record.count === null ? `${outcome}. How many exist is not known.` : `${outcome}. ${plural(record.count, "resource")} you may see.`;
    }
    default: return `Failed ${formatTimestamp(record.window.to)}.`;
  }
}

export function windowSentence(record: AnswerRecord): string {
  if (record.kind === "change") {
    return record.window.from
      ? `Happened between ${formatTimestamp(record.window.from)} and ${formatTimestamp(record.window.to)}.`
      : `Happened before ${formatTimestamp(record.window.to)}; the earlier backup is not known.`;
  }
  if (record.kind === "coverage") return `Backup from ${formatTimestamp(record.window.from)} to ${formatTimestamp(record.window.to)}.`;
  return `Ran from ${formatTimestamp(record.window.from)} to ${formatTimestamp(record.window.to)}.`;
}

export function sourceLabel(record: AnswerRecord): string {
  switch (record.source.kind) {
    case "change": return "Open the Changes page";
    case "collection": return "Open Protect";
    default: return "Open this job";
  }
}
