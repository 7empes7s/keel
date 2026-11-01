import type { AlertItem } from "@/components/ui/alert-list";
import type { StatTile } from "@/components/ui/stat-tiles";
import { itemKindName, itemService, plainKind, typeService } from "@/lib/baselines-view";
import { itemKind } from "@/lib/type-groups";
import { fieldWords } from "@/lib/changes-view";
import { namedSubject } from "@/lib/job-names";
import { displayEnum, formatTimestamp, resourceTypeLabel } from "@/lib/presentation";
import { coverageSentence, HEALTH_BADGE, type BackupHealth } from "@/lib/protect-view";
import type { CoverageSummary } from "@/lib/types";

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
  // The settings catalog template family, when the change has one: an endpoint security
  // policy made in Intune is listed under Defender.
  templateFamily?: string | null;
  // The isBuiltIn flag, when the changed object has one (an Entra admin role).
  builtIn?: boolean | null;
  naturalKey: string;
  name: string | null;
  changeType: string;
  impact: string;
  decision: string | null;
  seenAt: string | null;
  // The settings that differ (modified changes only); moreFields when there were more.
  fields?: string[] | null;
  moreFields?: boolean;
  window: AnswerWindow;
  source: AnswerSource;
  // Who made it, from Microsoft's audit log (lib/ask-who.ts): set by the portal when the
  // question asks who; null when the audit log could not be read for it.
  who?: AskWho | null;
}

/** Who made a change, in words, as the Changes page says it (components/change-attribution.tsx). */
export interface AskWho {
  verdict: "exact" | "plausible" | "unknown";
  // "Confirmed", "Likely" or "Not known".
  label: string;
  // "Ada Admin, confirmed by the Microsoft Entra audit log." or why it is not known.
  text: string;
  // What to do when it is not known.
  detail: string | null;
}

export interface CoverageRecord {
  kind: "coverage";
  // settings: the Entra ID and Intune backup; service-settings: Exchange, SharePoint,
  // Teams, Purview and Power Platform settings; content: mail, files, sites, Teams, Planner.
  backup?: "settings" | "service-settings" | "content";
  id: string;
  resourceType: string;
  name?: string | null;
  service?: string | null;
  outcome: string;
  count: number | null;
  bytes?: number | null;
  lastGoodAt?: string | null;
  // Set by the portal from the shared coverage report (lib/ask-coverage.ts): the kind's
  // state as every other page counts it, and that state in words.
  health?: BackupHealth;
  note?: string;
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
  // Several kinds, when the question named a service or a broad word ("Teams policies").
  resourceTypes?: readonly string[] | null;
  // A name looked for, from a quoted phrase.
  name?: string | null;
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
  // Every matching change counted by kind, change and risk (changes only).
  // templateFamily: set for endpoint security policies made in Intune (Defender settings).
  summary?: { resourceType: string; templateFamily?: string | null; changeType: string; impact: string; count: number }[] | null;
  // Words of the question the reading did not use.
  ignored?: string[];
  // What the reading filled in or how it read a word: "period" when the question named
  // no period, else a sentence ("Read “MFA” as ...").
  assumed?: string[];
  // When KEEL next reads the kind asked about, from its backup schedule.
  nextRead?: { every: string | null; n: number; dueAt: string | null } | null;
  // Coverage only: the kinds asked about in the shared coverage buckets (lib/ask-coverage.ts),
  // the same count as Setup, What's protected and the Overview.
  coverage?: CoverageSummary | null;
  refusal?: { code: string; message: string };
  readBy?: "rules" | "helper" | "form";
  question?: string | null;
  // The named period the answer used ("this-week"); null when it used dates.
  period?: string | null;
  // The question asked who made each change ("Who changed MFA?"), or the form asked for it.
  asksWho?: boolean;
  // How many listed changes Keel looked up in the audit log (the newest first).
  whoChecked?: number;
  sentence: string;
  generatedAt: string;
}

export interface AskInput {
  question?: string;
  intent?: string;
  entity?: string;
  period?: string;
  from?: string;
  to?: string;
  resourceType?: string;
  resourceTypes?: string[];
  name?: string;
  changeType?: string;
  // The form asked who made each change.
  who?: boolean;
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
  { value: "last-month", label: "Last month" },
];

export const ASK_INTENTS: { value: AskIntent; label: string }[] = [
  { value: "changes", label: "What changed" },
  { value: "coverage", label: "What the latest backup holds" },
  { value: "failed-jobs", label: "Which jobs failed" },
];

const SEARCH_KEYS = ["q", "intent", "entity", "period", "from", "to", "type", "types", "name", "change", "who"] as const;

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
  // The form's kind picker sends several kinds as one comma-separated value, and its
  // period picker sends the dates a question named as "from/to".
  const typeValue = value("type");
  const listed = value("types") ?? (typeValue?.includes(",") ? typeValue : undefined);
  const types = listed?.split(",").map((type) => type.trim()).filter(Boolean);
  const periodValue = value("period");
  const dates = periodValue?.includes("/") ? periodValue.split("/") : null;
  const from = intent === "coverage" ? undefined : value("from") ?? (dates?.[0] || undefined);
  const who = intent === "changes" && value("who") === "1";
  return {
    intent,
    // Jobs have no owner: an owner left from a changes question is not sent with them.
    entity: intent === "failed-jobs" ? undefined : value("entity"),
    period: intent === "coverage" || from ? undefined : periodValue,
    from,
    to: from ? value("to") ?? (dates?.[1] || undefined) : undefined,
    resourceType: types?.length ? undefined : typeValue,
    resourceTypes: types?.length ? types : undefined,
    name: value("name"),
    changeType: intent === "changes" ? value("change") : undefined,
    ...(who ? { who } : {}),
  };
}

/** The "Or choose" form's starting values: the question just answered, so changing one
 *  picker and pressing Answer asks the same thing with that one change. */
export interface AskFormDefaults {
  intent: string;
  period: string;
  // The dates a question named, when they are not one of the named periods.
  datesOption: { value: string; label: string } | null;
  entity: string;
  type: string;
  // Kinds the question named that the kind picker does not list on its own ("Teams policies").
  typeOption: { value: string; label: string } | null;
  change: string;
  name: string;
  who: boolean;
}

export const ASK_CHANGES: { value: string; label: string }[] = [
  { value: "", label: "Any change" },
  { value: "added", label: "Added" },
  { value: "modified", label: "Changed" },
  { value: "removed", label: "Removed" },
];

export function askFormDefaults(answer: GroundedAnswer | null, typeValues: readonly string[] = []): AskFormDefaults {
  const fallback: AskFormDefaults = { intent: "changes", period: "this-week", datesOption: null, entity: "", type: "", typeOption: null, change: "", name: "", who: false };
  const plan = answer?.plan;
  if (!answer || !plan) return answer?.intent ? { ...fallback, intent: answer.intent } : fallback;
  const { intent, params } = plan;
  let period = fallback.period;
  let datesOption: AskFormDefaults["datesOption"] = null;
  if (answer.period && ASK_PERIODS.some((entry) => entry.value === answer.period)) period = answer.period;
  else if (intent !== "coverage" && params.from && params.to) {
    period = `${params.from}/${params.to}`;
    datesOption = { value: period, label: `${shortTime(params.from)} to ${shortTime(params.to)}` };
  }
  let type = "";
  let typeOption: AskFormDefaults["typeOption"] = null;
  if (params.resourceTypes?.length) {
    type = params.resourceTypes.join(",");
    if (params.resourceTypes.length > 1 || !typeValues.includes(type)) typeOption = { value: type, label: kindsWords(params.resourceTypes) };
  } else if (params.resourceType) {
    type = params.resourceType;
    if (!typeValues.includes(type)) typeOption = { value: type, label: plainKind(type) };
  }
  return {
    intent, period, datesOption, entity: params.entity ?? "", type, typeOption,
    change: intent === "changes" ? params.changeType ?? "" : "", name: params.name ?? "",
    who: intent === "changes" && answer.asksWho === true,
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
  if (answer.intent === "coverage" && answer.coverage) {
    const late = answer.coverage.failed + (answer.coverage.partial ?? 0) + answer.coverage.stale + answer.coverage.neverCollected;
    return { text: coverageSentence(answer.coverage), tone: late ? "attention" : "good" };
  }
  const noun = answer.intent === "failed-jobs" ? "failed job" : answer.intent === "coverage" ? "kind of backup" : "matching change";
  const found = answer.total === 0 ? `No ${noun}s found` : `${plural(answer.total, noun)} found`;
  if (answer.status === "partial") return { text: `${found}, but part of this period is not known yet.`, tone: "attention" };
  if (answer.intent === "failed-jobs" && answer.total > 0) return { text: `${found} in this period.`, tone: "critical" };
  return { text: answer.intent === "coverage" ? `${found} across the latest backups of every service.` : `${found} in this period.`, tone: answer.total > 0 && answer.intent === "changes" ? "attention" : "good" };
}

/** "Understood as" in words, from the validated plan. */
export function understoodAs(answer: GroundedAnswer): string | null {
  if (!answer.plan) return null;
  const { intent, params } = answer.plan;
  const owner = params.entity ? ` owned by ${params.entity}` : "";
  const type = params.resourceType ? plainKind(params.resourceType).toLowerCase()
    : params.resourceTypes?.length ? kindsWords(params.resourceTypes).toLowerCase() : null;
  if (intent === "coverage") {
    return type || owner
      ? `What the latest complete backup holds${type ? ` for each ${type}` : ""}${owner}.`
      : "What the latest backups of every service hold: settings and content.";
  }
  const period = `from ${formatTimestamp(params.from)} to ${formatTimestamp(params.to)}`;
  if (intent === "failed-jobs") return `Jobs that failed ${period}.`;
  const kind = params.changeType ? `${displayEnum("changeType", params.changeType).toLowerCase()} ` : "";
  const name = params.name ? ` named like “${params.name}”` : "";
  return `Changes${kind ? ` (${kind.trim()})` : ""}${type ? ` to ${params.resourceTypes?.length ? "" : "a "}${type}` : ""}${name}${owner}, seen ${period}.`;
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
    case "change": return namedSubject(record.naturalKey, { [record.naturalKey]: { name: record.name, resourceType: record.resourceType } }, record.resourceType);
    case "coverage": {
      const label = record.name ?? resourceTypeLabel(record.resourceType);
      const title = `${label[0].toUpperCase()}${label.slice(1)}`;
      if (record.backup === "content") return `${title} (content)`;
      if (record.backup === "service-settings") return `${title} (settings)`;
      return title;
    }
    default: return displayEnum("jobKind", record.jobKind);
  }
}

const OUTCOME_LABEL: Record<string, string> = {
  complete: "Read completely",
  "complete-empty": "Read completely, none exist",
  partial: "Read only in part",
  failed: "Could not be read",
  "not-requested": "Not part of this backup",
  unavailable: "Not available on this tenant",
  "not-recorded": "Not recorded",
  succeeded: "Backed up",
  disabled: "Switched off until a live check passes",
};

export function recordSentence(record: AnswerRecord): string {
  switch (record.kind) {
    case "change": {
      const what = displayEnum("changeType", record.changeType);
      const decided = record.decision ? ` Decision: ${displayEnum("decision", record.decision).toLowerCase()}.` : "";
      return `${what}. ${displayEnum("blastRadius", record.impact)}.${decided}`;
    }
    case "coverage": {
      if (record.health && record.note) return `${HEALTH_BADGE[record.health].label}. ${record.note}`;
      const outcome = OUTCOME_LABEL[record.outcome] ?? "Not recorded";
      if (record.backup === "content") {
        return record.count === null ? `${outcome}. Nothing is stored yet.` : `${outcome}. ${plural(record.count, "item")} stored.`;
      }
      if (record.backup === "service-settings") {
        if (record.count === null) return `${outcome}. No read has finished yet.`;
        const older = record.outcome !== "complete" && record.outcome !== "complete-empty" && record.lastGoodAt ? ` from the last good read, ${formatTimestamp(record.lastGoodAt)}` : "";
        return `${outcome}. ${plural(record.count, "setting")}${older}.`;
      }
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
  if (record.kind === "coverage") {
    if (!record.window.from && !record.window.to) return "No backup time recorded.";
    if (!record.window.from) return `Backup finished ${formatTimestamp(record.window.to)}.`;
    return `Backup from ${formatTimestamp(record.window.from)} to ${formatTimestamp(record.window.to)}.`;
  }
  return `Ran from ${formatTimestamp(record.window.from)} to ${formatTimestamp(record.window.to)}.`;
}

export function sourceLabel(record: AnswerRecord): string {
  switch (record.source.kind) {
    case "change": return "Open the Changes page";
    case "collection": return "Open Protect";
    default: return "Open this job";
  }
}

// The redesigned answer: a status badge, what is not known first as alert rows, three
// tiles, then the records as one table with a coloured state on every row.

export type AskTone = "urgent" | "soon" | "low" | "fine" | "neutral";

export function answerBadge(answer: GroundedAnswer): { tone: AskTone; label: string } {
  switch (answer.status) {
    case "answered": return { tone: "fine", label: "Answered" };
    case "partial": return { tone: "soon", label: "Partly known" };
    case "unknown": return { tone: "soon", label: "Not known" };
    default: return { tone: "soon", label: "Not run" };
  }
}

/** What the reader must know before trusting the answer: a refusal, missing history,
 *  periods not known, and a narrowed scope. */
const GAP_TODO: Record<AnswerGap["reason"], string> = {
  "not-compared-yet": "KEEL has not compared a backup since then. Wait for the next one, or ask about an earlier period.",
  "before-history": "KEEL had not compared a backup yet. Ask about a later period.",
  "no-history": "KEEL has no record for this period. Ask about a later one.",
};

const EVERY_WORDS: Record<string, [string, string]> = { hour: ["once an hour", "hours"], day: ["once a day", "days"], week: ["once a week", "weeks"] };

/** "KEEL reads users once a day. The next read is due 24 Oct 2026, 00:00 UTC." */
function nextReadTodo(answer: GroundedAnswer): string | null {
  const next = answer.nextRead;
  const type = answer.plan?.params.resourceType;
  if (!next || !type) return null;
  const kind = `${plainKind(type).toLowerCase()}s`;
  const due = next.dueAt ? ` The next one is due ${formatTimestamp(next.dueAt)}.` : "";
  if (!next.every || !EVERY_WORDS[next.every]) return due ? `This part is known after the next backup of ${kind}.${due}` : null;
  const [once, many] = EVERY_WORDS[next.every];
  const how = next.n > 1 ? `every ${next.n} ${many}` : once;
  return `KEEL backs up ${kind} ${how}, so this part is known after the next backup.${due}`;
}

export function askAlerts(answer: GroundedAnswer): AlertItem[] {
  const items: AlertItem[] = [];
  if (answer.refusal) {
    items.push({ key: "refused", tone: "soon", icon: "x-circle", title: "KEEL did not run this question", todo: answer.refusal.message, action: null });
  }
  if (answer.status === "unknown" && answer.intent) {
    items.push({
      key: "unknown", tone: "soon", icon: "alert", title: "KEEL has no record for this, so it cannot say whether anything happened",
      todo: "This is not the same as nothing happening. Ask about a period KEEL has backups for.", action: null,
    });
  } else if (answer.status === "unknown") {
    items.push({ key: "unsupported", tone: "soon", icon: "info", title: "KEEL cannot answer this question", todo: "Ask about changes, backup coverage or failed jobs, or choose below.", action: null });
  }
  if (answer.assumed?.includes("period") && answer.plan?.params.from) {
    items.push({
      key: "assumed-period", tone: "low", icon: "calendar", title: "No period was named, so KEEL answered for this week",
      todo: "Name a period to change it, for example \"this month\" or \"since 17 Oct\".", action: null,
    });
  }
  if (answer.status !== "unknown") {
    answer.gaps.forEach((gap, index) => items.push({
      key: `gap-${index}`, tone: "soon", icon: "clock", title: `Not known from ${formatTimestamp(gap.from)} to ${formatTimestamp(gap.to)}`,
      todo: gap.reason === "not-compared-yet" ? nextReadTodo(answer) ?? GAP_TODO[gap.reason] : GAP_TODO[gap.reason] ?? GAP_TODO["not-compared-yet"],
      action: null,
    }));
  }
  const readings = (answer.assumed ?? []).filter((line) => line !== "period");
  if (readings.length) {
    items.push({
      key: "assumed-reading", tone: "low", icon: "info", title: "How KEEL read this question",
      todo: readings.join(" "), action: null,
    });
  }
  if (answer.ignored?.length) {
    const quoted = answer.ignored.map((word) => `“${word}”`).join(", ");
    items.push({
      key: "ignored", tone: "soon", icon: "info", title: `Not understood: ${quoted}`,
      todo: "KEEL left these words out. Name a service or kind of setting, or put a name in quotes.", action: null,
    });
  }
  const who = whoAlert(answer);
  if (who) items.push(who);
  if (!answer.scope.central) {
    items.push({
      key: "scope", tone: "low", icon: "info", title: `Only resources owned by ${answer.scope.entities.join(" and ")} are included`,
      todo: "Ask a central administrator about the rest of this tenant.", action: null,
    });
  }
  return items;
}

/** Who made the listed changes, counted: shown when the question asked who. */
function whoAlert(answer: GroundedAnswer): AlertItem | null {
  if (!answer.asksWho || answer.intent !== "changes" || answer.status === "refused") return null;
  const changes = answer.records.filter((record): record is ChangeRecord => record.kind === "change");
  if (!changes.length) return null;
  const looked = changes.filter((record) => record.who !== undefined);
  const count = (verdict: AskWho["verdict"]) => looked.filter((record) => record.who?.verdict === verdict).length;
  const failed = looked.filter((record) => record.who === null).length;
  const parts = [`${count("exact")} confirmed`, `${count("plausible")} likely`, `${count("unknown") + failed} not known`];
  const rest = changes.length - looked.length;
  const todo = [
    "Keel reads who made each change from the Microsoft Entra and Intune audit logs, and lists it in the Who made it column.",
    "Changes in Exchange, SharePoint, Teams, Purview, Power Platform and Defender show Not known until Keel reads the Purview audit log.",
    rest > 0 ? `Keel looked up the newest ${looked.length.toLocaleString("en-GB")} changes; narrow the question to look up the other ${rest.toLocaleString("en-GB")}.` : null,
    failed ? "Keel could not read the audit log for some changes just now; ask again in a moment." : null,
  ].filter(Boolean).join(" ");
  return { key: "who", tone: failed ? "soon" : "low", icon: "person", title: `Who made these changes: ${parts.join(", ")}`, todo, action: null };
}

function shortTime(value: string | null): string {
  return value ? formatTimestamp(value).replace(/ UTC$/, "") : "the start";
}

export function askTiles(answer: GroundedAnswer): StatTile[] {
  const noun = answer.intent === "failed-jobs" ? "failed job" : answer.intent === "coverage" ? "kind of backup" : "change";
  const found = answer.status === "unknown" || answer.status === "refused" ? "Not known" : answer.total.toLocaleString("en-GB");
  if (answer.coverage) {
    // The kinds in the shared buckets, as the verdict counts them; content backups are rows, not kinds.
    const kinds = answer.coverage.total;
    const content = answer.records.filter((record) => record.kind === "coverage" && !record.health).length;
    const [, ...rest] = askTiles({ ...answer, coverage: null });
    return [{ key: "found", label: "Found", icon: "search", value: kinds.toLocaleString("en-GB"),
      about: `${kinds === 1 ? "kind of backup" : "kinds of backup"}${content ? `, and ${plural(content, "other backup")}` : ""}`, tone: "neutral" },
    { ...rest[0], value: "Latest reads", about: "Each kind's newest backup" }, ...rest.slice(1)];
  }
  const window = answer.plan?.params.from || answer.plan?.params.to ? { from: answer.plan.params.from, to: answer.plan.params.to } : answer.window;
  return [
    { key: "found", label: "Found", icon: "search", value: found,
      about: found === "Not known" ? "No record covers this" : answer.total ? `${answer.intent === "coverage" ? (answer.total === 1 ? "kind of backup" : "kinds of backup") : `${noun}${answer.total === 1 ? "" : "s"}`}${answer.truncated ? `, newest ${answer.shown} shown` : ""}` : `No ${noun}s in what KEEL knows`,
      tone: found === "Not known" ? "soon" : answer.intent === "failed-jobs" && answer.total ? "urgent" : "neutral" },
    { key: "period", label: "Period", icon: "calendar", value: window ? shortTime(window.from).split(",")[0] : "Latest backup",
      about: window ? `${shortTime(window.from)} to ${shortTime(window.to)}` : "The newest complete copy", tone: "neutral" },
    { key: "unknown", label: "Not known", icon: "clock", value: answer.gaps.length ? `${answer.gaps.length} period${answer.gaps.length === 1 ? "" : "s"}` : "None",
      about: answer.gaps.length ? "KEEL has no comparison there" : "KEEL has records for all of it", tone: answer.gaps.length ? "soon" : "fine" },
    { key: "scope", label: "Owned by", icon: "person", value: answer.scope.central ? (answer.plan?.params.entity ?? "Anyone") : answer.scope.entities.join(", "),
      about: answer.scope.central ? "The whole tenant you may see" : "Only what you may see", tone: answer.scope.central ? "neutral" : "low" },
  ];
}

const CHANGE_TONES: Record<string, AskTone> = { added: "low", modified: "soon", removed: "urgent" };
const IMPACT_TONES: Record<string, AskTone> = { "tenant-lockout": "urgent", "access-affecting": "soon", cosmetic: "neutral" };
const OUTCOME_TONES: Record<string, AskTone> = { complete: "fine", "complete-empty": "fine", succeeded: "fine", partial: "soon", failed: "urgent" };

/** Each record's state as one or two badges: what changed and how much it matters. */
export function recordBadges(record: AnswerRecord): { tone: AskTone; label: string }[] {
  switch (record.kind) {
    case "change": return [
      { tone: CHANGE_TONES[record.changeType] ?? "neutral", label: displayEnum("changeType", record.changeType) },
      { tone: IMPACT_TONES[record.impact] ?? "neutral", label: displayEnum("blastRadius", record.impact) },
    ];
    case "coverage": return record.health
      ? [HEALTH_BADGE[record.health]]
      : [{ tone: OUTCOME_TONES[record.outcome] ?? "neutral", label: OUTCOME_LABEL[record.outcome] ?? "Not recorded" }];
    default: return [{ tone: "urgent", label: "Failed" }];
  }
}

/** The row's tone: the worst of its badges. */
export function recordTone(record: AnswerRecord): AskTone {
  const order: AskTone[] = ["urgent", "soon", "low", "fine", "neutral"];
  return recordBadges(record).map((badge) => badge.tone).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? "neutral";
}

/** The short line under a record's badges: a decision, how much a backup holds. */
export function recordNote(record: AnswerRecord): string {
  switch (record.kind) {
    case "change": return record.decision ? `Decision: ${displayEnum("decision", record.decision).toLowerCase()}` : "No decision yet";
    case "coverage": {
      const sentence = recordSentence(record);
      return sentence.slice(sentence.indexOf(".") + 1).trim();
    }
    default: return "";
  }
}

/** "Teams policies (2 kinds)" for a set of kinds, or the list when it is short. */
export function kindsWords(types: readonly string[]): string {
  const services = [...new Set(types.map((type) => typeService(type).name))];
  if (types.length <= 2) return types.map((type) => plainKind(type)).join(" or ");
  return `${types.length} kinds${services.length === 1 ? ` in ${services[0]}` : ""}`;
}

export interface UnderstoodFilter {
  key: "intent" | "period" | "entity" | "kind" | "change" | "name";
  label: string;
  value: string;
  // The page asked again without this filter; null when it cannot be left out.
  removeHref: string | null;
}

const INTENT_WORDS: Record<AskIntent, string> = { changes: "What changed", coverage: "What the backup holds", "failed-jobs": "Failed jobs" };

/** The plan as form fields, for links that ask again without one of them. */
function planQuery(plan: NonNullable<GroundedAnswer["plan"]>, without: UnderstoodFilter["key"] | null): string {
  const { intent, params } = plan;
  const query = new URLSearchParams({ intent });
  if (intent !== "coverage" && params.from && params.to) { query.set("from", params.from); query.set("to", params.to); }
  if (params.entity && without !== "entity") query.set("entity", params.entity);
  if (without !== "kind") {
    if (params.resourceType) query.set("type", params.resourceType);
    if (params.resourceTypes?.length) query.set("types", params.resourceTypes.join(","));
  }
  if (params.changeType && without !== "change") query.set("change", params.changeType);
  if (params.name && without !== "name") query.set("name", params.name);
  return `/ask?${query.toString()}`;
}

/** What the question was read as, one badge per filter, each removable but the topic and period. */
export function understoodFilters(answer: GroundedAnswer): UnderstoodFilter[] {
  if (!answer.plan) return [];
  const { intent, params } = answer.plan;
  const filters: UnderstoodFilter[] = [{ key: "intent", label: "Topic", value: INTENT_WORDS[intent], removeHref: null }];
  if (intent !== "coverage" && params.from && params.to) {
    filters.push({ key: "period", label: "Period", value: `${formatTimestamp(params.from).replace(/ UTC$/, "")} to ${formatTimestamp(params.to).replace(/ UTC$/, "")}`, removeHref: null });
  }
  if (params.entity) filters.push({ key: "entity", label: "Owned by", value: params.entity, removeHref: planQuery(answer.plan, "entity") });
  if (params.resourceType) filters.push({ key: "kind", label: "Kind", value: plainKind(params.resourceType), removeHref: planQuery(answer.plan, "kind") });
  else if (params.resourceTypes?.length) filters.push({ key: "kind", label: "Kinds", value: kindsWords(params.resourceTypes), removeHref: planQuery(answer.plan, "kind") });
  if (params.changeType) filters.push({ key: "change", label: "Change", value: displayEnum("changeType", params.changeType), removeHref: planQuery(answer.plan, "change") });
  if (params.name) filters.push({ key: "name", label: "Name", value: `“${params.name}”`, removeHref: planQuery(answer.plan, "name") });
  return filters;
}

export interface SummaryRow { key: string; label: string; count: number; tone: AskTone; icon?: string }

/** Every matching change counted by service, kind, risk and change: from the engine's
 *  summary of all matches, or from the listed records when it has none. */
export function answerSummary(answer: GroundedAnswer): { services: SummaryRow[]; kinds: SummaryRow[]; risks: SummaryRow[]; changes: SummaryRow[] } | null {
  if (answer.intent !== "changes") return null;
  const rows = answer.summary?.length ? answer.summary
    : answer.records.flatMap((record) => record.kind === "change" ? [{ resourceType: record.resourceType, templateFamily: record.templateFamily ?? null, changeType: record.changeType, impact: record.impact, count: 1 }] : []);
  if (!rows.length) return null;
  const add = (map: Map<string, SummaryRow>, key: string, make: () => Omit<SummaryRow, "count">, count: number) => {
    const row = map.get(key) ?? { ...make(), count: 0 };
    row.count += count;
    map.set(key, row);
  };
  const services = new Map<string, SummaryRow>();
  const kinds = new Map<string, SummaryRow>();
  const risks = new Map<string, SummaryRow>();
  const changes = new Map<string, SummaryRow>();
  for (const row of rows) {
    const service = itemService(row);
    const kind = itemKind(row);
    add(services, service.code, () => ({ key: service.code, label: service.name, tone: "neutral", icon: service.icon }), row.count);
    add(kinds, kind, () => ({ key: kind, label: plainKind(kind), tone: "neutral" }), row.count);
    add(risks, row.impact, () => ({ key: row.impact, label: displayEnum("blastRadius", row.impact), tone: IMPACT_TONES[row.impact] ?? "neutral" }), row.count);
    add(changes, row.changeType, () => ({ key: row.changeType, label: displayEnum("changeType", row.changeType), tone: CHANGE_TONES[row.changeType] ?? "neutral" }), row.count);
  }
  const byCount = (a: SummaryRow, b: SummaryRow) => b.count - a.count || a.label.localeCompare(b.label);
  const RISK_ORDER = ["tenant-lockout", "access-affecting", "cosmetic"];
  const CHANGE_ORDER = ["removed", "modified", "added"];
  return {
    services: [...services.values()].sort(byCount),
    kinds: [...kinds.values()].sort(byCount),
    risks: [...risks.values()].sort((a, b) => RISK_ORDER.indexOf(a.key) - RISK_ORDER.indexOf(b.key)),
    changes: [...changes.values()].sort((a, b) => CHANGE_ORDER.indexOf(a.key) - CHANGE_ORDER.indexOf(b.key)),
  };
}

const STATE_ROWS: { key: string; label: string; tone: AskTone; count: (summary: CoverageSummary) => number }[] = [
  { key: "failed", label: "Failed", tone: "urgent", count: (summary) => summary.failed },
  { key: "partial", label: "Partly done", tone: "soon", count: (summary) => summary.partial ?? 0 },
  { key: "late", label: "Out of date or never", tone: "soon", count: (summary) => summary.stale + summary.neverCollected },
  { key: "backed-up", label: "Backed up", tone: "fine", count: (summary) => summary.covered },
  { key: "not-collected", label: "Not backed up by Keel yet", tone: "neutral", count: (summary) => summary.notCovered },
  { key: "unavailable", label: "Not on this tenant", tone: "neutral", count: (summary) => summary.unavailable },
];

/** A coverage answer's kinds by state (the shared buckets, worst first) and by service. */
export function coverageAnswerSummary(answer: GroundedAnswer): { states: SummaryRow[]; services: SummaryRow[]; total: number } | null {
  if (answer.intent !== "coverage" || !answer.coverage) return null;
  const summary = answer.coverage;
  const states = STATE_ROWS.map((row) => ({ key: row.key, label: row.label, tone: row.tone, count: row.count(summary) })).filter((row) => row.count > 0);
  const services = new Map<string, SummaryRow>();
  for (const record of answer.records) {
    if (record.kind !== "coverage" || !record.health) continue;
    const service = recordService(record);
    const row = services.get(service.code) ?? { key: service.code, label: service.name, tone: "neutral", icon: service.icon, count: 0 };
    row.count += 1;
    services.set(service.code, row);
  }
  return { states, services: [...services.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)), total: summary.total };
}

/** Where a record sits: its service. */
export function recordService(record: AnswerRecord): { code: string; name: string; icon: string } {
  if (record.kind === "job") return { code: "keel", name: "Keel", icon: "service-keel" };
  if (record.kind === "change") return itemService(record);
  return typeService(record.resourceType); // kind-level: a coverage row is one whole kind
}

/** The kind of a record in words, for sorting and grouping. */
export function recordKind(record: AnswerRecord): string {
  if (record.kind === "job") return displayEnum("jobKind", record.jobKind);
  return record.kind === "change" ? itemKindName(record) : plainKind(record.resourceType);
}

/** A record's time, for sorting: when it was seen or when its window ended. */
export function recordTime(record: AnswerRecord): string {
  return (record.kind === "change" ? record.seenAt : null) ?? record.window.to ?? "";
}

/** The settings a change touched, in words: "Account enabled, Department and more". */
export function recordFields(record: AnswerRecord): string {
  if (record.kind !== "change" || !record.fields?.length) return "";
  const list = record.fields.map(fieldWords).join(", ");
  return record.moreFields ? `${list} and more` : list;
}
