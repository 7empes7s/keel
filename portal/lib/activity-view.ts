// The Activity page in words (portal audit, Activity, pick A: a timeline by day). Pure
// helpers shared by the server page, the client page and the tests: one row shape for
// a job and for an audit-record entry, what each is about (its kind), how it ended (its
// outcome), the counts behind the tiles, the status pill, the verdict, and the filters
// kept in the address. Ids never appear in anything these return.
import type { IconName } from "@/components/shell/icons";
import type { BadgeTone } from "@/components/ui/badge";
import { type Day, type DayRange, normalise, rangeFromParam } from "@/lib/date-range";
import type { ChainIntegrity, EvidenceEntry } from "@/lib/evidence";
import { jobDisplayStatus, jobErrorLine, type NamedKeys } from "@/lib/job-names";
import type { RiskTone } from "@/lib/menu-status";
import type { JobRecord } from "@/lib/portal-jobs";
import { displayEnum } from "@/lib/presentation";
import { type EngineRef, evidenceSentence, jobName, jobStatusSentence, personLabel } from "@/lib/sentences";
import { csvLine } from "@/lib/csv";

const DAY = 86_400_000;

/** What a row is about: the picker's choices under "What". */
export type ActivityKind = "backup" | "restore" | "rollback" | "setup" | "approval" | "policy" | "drill" | "copy" | "other";

export const ACTIVITY_KINDS: Record<ActivityKind, { label: string; one: string; icon: IconName; jobs: string[]; records: string[] }> = {
  backup: { label: "Backups", one: "Backup", icon: "backup", jobs: ["backup", "collect", "workload-collect", "content-collect", "prune", "discover"], records: ["collection.completed", "job.started"] },
  restore: { label: "Restores", one: "Restore", icon: "restore", jobs: ["restore", "restore-dry-run"], records: ["recovery-completion", "content-effect-approval", "incident-recovery", "incident-recovery-check"] },
  rollback: { label: "Roll backs", one: "Roll back", icon: "swap", jobs: ["remediate"], records: ["automation-execution"] },
  setup: { label: "Approved setups", one: "Approved setup", icon: "baselines", jobs: ["baseline-create", "baseline-activate", "dispose"], records: ["baseline-resnapshot"] },
  approval: { label: "Approvals", one: "Approval", icon: "check-circle", jobs: [], records: ["approval-request", "approval-decision", "approval-signoff", "approval.decided", "action-attempt", "restore-approval-setting"] },
  policy: { label: "Policy checks", one: "Policy check", icon: "automation", jobs: ["drift-detect", "policy-evaluate", "api-drift"], records: ["policy-evaluation", "benchmark-evaluation", "benchmark-exception", "scuba-config-list"] },
  drill: { label: "Drills", one: "Drill", icon: "play", jobs: [], records: ["fidelity-drill", "recovery-drill"] },
  copy: { label: "Off-site copies", one: "Off-site copy", icon: "cloud", jobs: ["offsite"], records: ["offsite-copy"] },
  other: { label: "Other", one: "Other", icon: "page", jobs: ["notify"], records: ["people-anonymity", "alert-action"] },
};
export const ACTIVITY_KIND_ORDER: ActivityKind[] = ["backup", "restore", "rollback", "setup", "approval", "policy", "drill", "copy", "other"];

export function kindOfJob(kind: string): ActivityKind {
  return ACTIVITY_KIND_ORDER.find((key) => ACTIVITY_KINDS[key].jobs.includes(kind)) ?? "other";
}

export function kindOfRecord(kind: string): ActivityKind {
  return ACTIVITY_KIND_ORDER.find((key) => ACTIVITY_KINDS[key].records.includes(kind)) ?? "other";
}

export function activityKind(value: string | null | undefined): ActivityKind | null {
  return value && value in ACTIVITY_KINDS ? (value as ActivityKind) : null;
}

/** A comma list of kinds from the address, in their usual order, unknowns dropped. */
export function kindsOf(value: string | null | undefined): ActivityKind[] {
  const picked = (value ?? "").split(",");
  return ACTIVITY_KIND_ORDER.filter((key) => picked.includes(key));
}

/** A comma list of accounts from the address ("Who"), as recorded, in the order given. */
export function actorsOf(value: string | null | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))];
}

/** How a row ended: the picker's choices under "Outcome", and the chip on each row. */
export type Outcome = "failed" | "partial" | "refused" | "running" | "waiting" | "finished" | "recorded" | "cancelled";

export const OUTCOMES: Record<Outcome, { label: string; plural: string; tone: BadgeTone; icon: IconName; jobStatuses: string[] }> = {
  failed: { label: "Failed", plural: "Failed", tone: "urgent", icon: "x-circle", jobStatuses: ["failed"] },
  // A finished backup that could not read some types in full: a warning, never "Finished".
  // The engine stores it as succeeded; the job list filters on the status a person reads,
  // so "partial" finds every partly done run and "succeeded" only the gap-free ones.
  partial: { label: "Partly done", plural: "Partly done", tone: "soon", icon: "alert", jobStatuses: ["partial"] },
  refused: { label: "Refused", plural: "Refused", tone: "soon", icon: "alert", jobStatuses: [] },
  running: { label: "Running", plural: "Running", tone: "low", icon: "play", jobStatuses: ["running"] },
  waiting: { label: "Waiting", plural: "Waiting to start", tone: "low", icon: "clock", jobStatuses: ["queued"] },
  finished: { label: "Finished", plural: "Finished", tone: "fine", icon: "check-circle", jobStatuses: ["succeeded"] },
  recorded: { label: "Recorded", plural: "Recorded", tone: "neutral", icon: "audit", jobStatuses: [] },
  cancelled: { label: "Cancelled", plural: "Cancelled", tone: "neutral", icon: "pause", jobStatuses: ["cancelled"] },
};
export const OUTCOME_ORDER: Outcome[] = ["failed", "partial", "refused", "running", "waiting", "finished", "recorded", "cancelled"];

export function outcomeOf(value: string | null | undefined): Outcome | null {
  return value && value in OUTCOMES ? (value as Outcome) : null;
}

/** A comma list of outcomes from the address, in their usual order, unknowns dropped. */
export function outcomesOf(value: string | null | undefined): Outcome[] {
  const picked = (value ?? "").split(",");
  return OUTCOME_ORDER.filter((key) => picked.includes(key));
}

/** A job's outcome from the status a person reads (`jobDisplayStatus`): "partial" is its own. */
export function jobOutcome(status: string): Outcome {
  if (status === "partial") return "partial";
  return OUTCOME_ORDER.find((key) => OUTCOMES[key].jobStatuses.includes(status)) ?? "recorded";
}

/** An audit-record entry's outcome: a refusal, a failed check or drill, else "recorded". */
export function recordOutcome(entry: Pick<EvidenceEntry, "kind" | "subject">): Outcome {
  const subject = (entry.subject ?? {}) as Record<string, unknown>;
  if (entry.kind === "action-attempt" && subject.decision === "denied") return "refused";
  if (entry.kind === "approval-decision" && (subject.decision === "reject" || subject.status === "rejected")) return "refused";
  if (entry.kind === "recovery-drill" && subject.mode === "live" && subject.outcome !== "passed") return "failed";
  if (entry.kind === "offsite-copy" && !((subject.verification as { ok?: unknown } | undefined)?.ok === true && subject.remoteSha256 === subject.dumpSha256)) return "failed";
  if (entry.kind === "automation-execution" && subject.outcome !== "executed") return "failed";
  if (entry.kind === "incident-recovery-check" && subject.outcome === "unsafe") return "failed";
  return "recorded";
}

export type RowTone = RiskTone | null;

export function outcomeTone(outcome: Outcome): RowTone {
  const tone = OUTCOMES[outcome].tone;
  return tone === "neutral" ? null : tone;
}

/** One row of the timeline, whichever it came from. */
export interface ActivityRow {
  id: string;
  type: "job" | "record";
  at: string | null;
  kind: ActivityKind;
  outcome: Outcome;
  title: string;
  // One plain line under the title: what kind of thing it is and how it went.
  line: string;
  // Who did it or asked for it; null when Keel itself did and no account is named.
  person: EngineRef | null;
  // The key the "Who" filter matches: the account as the engine named it.
  who: string | null;
  job: JobRecord | null;
  entry: EvidenceEntry | null;
}

export interface ActivityPeople {
  [actor: string]: EngineRef | undefined;
}

function capital(text: string): string {
  return text.replace(/^./, (letter) => letter.toUpperCase());
}

/** The actor's name for a sentence: resolved person, else a general word. */
export function actorName(actor: string, people: ActivityPeople): string {
  const ref = people[actor];
  return ref ? capital(personLabel(ref)) : "Someone";
}

export function jobRow(job: JobRecord, now: string): ActivityRow {
  const at = job.finishedAt ?? job.startedAt ?? job.createdAt ?? null;
  const kind = kindOfJob(job.kind);
  const outcome = jobOutcome(jobDisplayStatus(job));
  const person = job.references?.people.requested_by ?? null;
  const went = job.status === "failed" && job.error ? jobErrorLine(job.error) : capital(jobStatusSentence(job, now));
  return {
    id: `job:${job.id}`, type: "job", at, kind, outcome,
    title: jobName(job),
    line: `${ACTIVITY_KINDS[kind].one} · ${went}`,
    person, who: person?.id ?? job.requestedBy ?? null, job, entry: null,
  };
}

export function recordRow(entry: EvidenceEntry, people: ActivityPeople, names: NamedKeys = {}): ActivityRow {
  const kind = kindOfRecord(entry.kind);
  const outcome = recordOutcome(entry);
  const person = people[entry.actor] ?? null;
  return {
    id: `record:${entry.seq}`, type: "record", at: entry.occurred_at, kind, outcome,
    title: evidenceSentence(entry, actorName(entry.actor, people), names),
    line: `Audit record · ${recordKindWords(entry.kind)}`,
    person, who: person?.id ?? entry.actor, job: null, entry,
  };
}

/** The kind of audit entry, in the singular: "Approval decision", "Policy check". */
export function recordKindWords(kind: string): string {
  const words: Record<string, string> = {
    "approval-request": "Approval request",
    "approval-decision": "Approval decision",
    "approval-signoff": "Approval sign-off",
    "approval.decided": "Approval decision",
    "action-attempt": "Action started or refused",
    "policy-evaluation": "Policy check",
    "automation-execution": "Automatic roll back",
    "content-effect-approval": "Content-effect approval",
    "restore-approval-setting": "Restore approval setting",
    "scuba-config-list": "ScubaGear list",
    "recovery-completion": "Restore follow-up",
    "incident-recovery": "Incident recovery",
    "incident-recovery-check": "Check after an incident restore",
    "fidelity-drill": "Test restore",
    "recovery-drill": "Recovery drill",
    "offsite-copy": "Off-site copy",
    "baseline-resnapshot": "Approved setup re-captured",
    "benchmark-evaluation": "Control check",
    "benchmark-exception": "Control exception",
    "collection.completed": "Backup finished",
    "job.started": "Job started",
    "alert-action": "Alert",
  };
  return words[kind] ?? displayEnum("eventKind", kind);
}

/** Jobs and audit-record entries as one list, newest first. */
export function activityRows(jobs: JobRecord[], entries: EvidenceEntry[], people: ActivityPeople, names: NamedKeys, now: string): ActivityRow[] {
  return [...jobs.map((job) => jobRow(job, now)), ...entries.map((entry) => recordRow(entry, people, names))]
    .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
}

/** Where a row leads: the job's page, or what an audit entry is about. */
export function rowHref(row: ActivityRow): string | null {
  if (row.job) return `/jobs/${encodeURIComponent(row.job.id)}`;
  const subject = (row.entry?.subject ?? {}) as Record<string, unknown>;
  if (typeof subject.jobId === "string" && subject.jobId) return `/jobs/${encodeURIComponent(subject.jobId)}`;
  if (row.entry?.kind === "policy-evaluation" && typeof subject.naturalKey === "string") return `/drift?q=${encodeURIComponent(subject.naturalKey.replace(/^[^:]+:/, ""))}`;
  if (row.entry?.kind === "approval-request" || row.entry?.kind === "approval-decision" || row.entry?.kind === "approval-signoff") return "/approvals?show=decided";
  if (row.entry?.kind === "recovery-drill" || row.entry?.kind === "fidelity-drill") return "/resilience";
  if (row.entry?.kind === "offsite-copy") return "/integrations";
  if (row.entry?.kind === "benchmark-evaluation" || row.entry?.kind === "benchmark-exception") return "/benchmarks";
  if (row.entry?.kind === "alert-action" && typeof subject.alertId === "string" && subject.alertId) return `/alerts?open=${encodeURIComponent(subject.alertId)}`;
  return null;
}

export function rowHrefLabel(row: ActivityRow): string {
  if (row.job) return "Open the job page";
  const href = rowHref(row);
  if (!href) return "";
  if (href.startsWith("/jobs/")) return "Open the job it is about";
  if (href.startsWith("/drift")) return "Show the change it checked";
  if (href.startsWith("/approvals")) return "Show decided approvals";
  if (href.startsWith("/resilience")) return "Show recovery readiness";
  if (href.startsWith("/integrations")) return "Show off-site copy settings";
  if (href.startsWith("/alerts")) return "Open the alert";
  return "Show the control checks";
}

/** What a failed job's row offers: run a backup again, or plan a restore or roll back again. */
export type Retry = { kind: "backup"; tier: string | null } | { kind: "collect" } | { kind: "plan"; href: string; label: string } | null;

export function retryOf(job: Pick<JobRecord, "kind" | "status" | "params"> | null): Retry {
  if (!job || job.status !== "failed") return null;
  const params = (job.params ?? {}) as Record<string, unknown>;
  if (job.kind === "backup") return { kind: "backup", tier: typeof params.tier === "string" ? params.tier : null };
  if (job.kind === "collect") return { kind: "collect" };
  if (job.kind === "restore" || job.kind === "restore-dry-run") return { kind: "plan", href: "/restore", label: "Plan it again" };
  if (job.kind === "remediate") return { kind: "plan", href: "/drift", label: "Plan it again" };
  return null;
}

/** "Tier 1" from a tier code; "every tier" without one. */
export function tierWords(tier: string | null): string {
  const match = tier ? /^tier(\d)$/.exec(tier) : null;
  return match ? `Tier ${match[1]}` : "every tier";
}

export interface ActivityCounts {
  jobsDay: number;
  failedDay: number;
  failedWeek: number;
  // Finished, but some types were not read in full: counted apart, never as fine.
  partialDay: number;
  partialWeek: number;
  running: number;
  waiting: number;
  // Seven days, oldest first: all jobs that day, how many failed and how many were partly done.
  days: { day: Day; jobs: number; failed: number; partial: number }[];
  newestFailed: JobRecord | null;
}

export function dayKey(value: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "unknown" : date.toISOString().slice(0, 10);
}

/** "Today", "Yesterday", "Monday 28 September". */
export function dayLabel(value: string | null, now: string): string {
  if (!value) return "Unknown day";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown day";
  const today = new Date(now);
  const days = Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(date);
}

/** "09:34" in UTC, the portal's clock. */
export function clockWords(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date);
}

const isPartial = (job: JobRecord) => jobDisplayStatus(job) === "partial";

/** Counts by `createdAt`, the same window the verdict uses, so the numbers agree. */
export function activityCounts(jobs: JobRecord[], now: string): ActivityCounts {
  const end = new Date(now).valueOf();
  const since = end - DAY;
  const created = (job: JobRecord) => (job.createdAt ? new Date(job.createdAt).valueOf() : Number.NaN);
  const recent = jobs.filter((job) => created(job) >= since && created(job) <= end);
  const week = jobs.filter((job) => created(job) >= end - 7 * DAY);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(end - (6 - index) * DAY).toISOString().slice(0, 10);
    const own = jobs.filter((job) => dayKey(job.createdAt) === day);
    return { day, jobs: own.length, failed: own.filter((job) => job.status === "failed").length, partial: own.filter(isPartial).length };
  });
  const failed = [...jobs].filter((job) => job.status === "failed").sort((a, b) => String(b.finishedAt ?? b.createdAt ?? "").localeCompare(String(a.finishedAt ?? a.createdAt ?? "")));
  return {
    jobsDay: recent.length,
    failedDay: recent.filter((job) => job.status === "failed").length,
    failedWeek: week.filter((job) => job.status === "failed").length,
    partialDay: recent.filter(isPartial).length,
    partialWeek: week.filter(isPartial).length,
    running: jobs.filter((job) => job.status === "running").length,
    waiting: jobs.filter((job) => job.status === "queued").length,
    days,
    newestFailed: failed[0] ?? null,
  };
}

export type IntegrityState = "intact" | "unchecked" | "broken" | "unknown";

/** The audit record's integrity as a word, a sentence and a tone. */
export function integrityWords(integrity: ChainIntegrity | null): { state: IntegrityState; label: string; sentence: string; tone: BadgeTone } {
  if (integrity === null) return { state: "unknown", label: "Not checked", sentence: "The audit record's integrity could not be checked right now.", tone: "neutral" };
  if (integrity.ok) {
    const pending = integrity.unanchoredRecords ?? 0;
    return { state: "intact", label: "Intact", tone: "fine", sentence: `Verified against the off-site copy${pending ? `. ${pending} newer ${pending === 1 ? "entry waits" : "entries wait"} for the next copy` : ""}.` };
  }
  if (integrity.status === "unanchored") return { state: "unchecked", label: "Not copied yet", tone: "soon", sentence: "No off-site copy exists yet, so the record cannot be verified." };
  return { state: "broken", label: "Check failed", tone: "urgent", sentence: "The record failed its integrity check. Investigate before trusting who did what." };
}

export function activityStatus(counts: ActivityCounts): { tone: RiskTone; label: string } {
  if (counts.failedDay) return { tone: "urgent", label: `${counts.failedDay} failed today` };
  if (counts.partialDay) return { tone: "soon", label: `${counts.partialDay} partly done today` };
  const active = counts.running + counts.waiting;
  if (active) return { tone: "low", label: counts.running ? `${counts.running} running` : `${counts.waiting} waiting` };
  if (counts.jobsDay) return { tone: "fine", label: "All finished" };
  return { tone: "fine", label: "Nothing ran today" };
}

export interface ActivityVerdict {
  text: string;
  detail?: string;
  tone: RiskTone;
  // The one action: run the newest failed backup again.
  retry: Retry;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One sentence of at most 25 words: how many jobs ran, and what failed. */
export function activityVerdict(counts: ActivityCounts, showJobs: boolean, integrity: ChainIntegrity | null): ActivityVerdict {
  const integrityState = integrityWords(integrity);
  if (!showJobs) {
    return integrityState.state === "broken"
      ? { text: "The audit record failed its integrity check; investigate before trusting it.", tone: "urgent", retry: null }
      : { text: "Showing the audit record: who did what, newest first.", tone: "fine", retry: null };
  }
  const failed = counts.newestFailed;
  const failedDayOf = counts.failedDay && failed ? failed : null;
  if (failedDayOf) {
    const name = jobName(failedDayOf).replace(/^./, (letter) => letter.toLowerCase());
    const retry = retryOf(failedDayOf);
    return {
      text: `Keel ran ${plural(counts.jobsDay, "job")} in the last day; the ${name} failed${counts.failedDay > 1 ? `, and ${counts.failedDay - 1} more` : ""}.`,
      detail: failedDayOf.error ? jobErrorLine(failedDayOf.error) : undefined,
      tone: "urgent",
      retry,
    };
  }
  if (integrityState.state === "broken") {
    return { text: "The audit record failed its integrity check; investigate before trusting it.", tone: "urgent", retry: null };
  }
  if (counts.jobsDay === 0) {
    return { text: `Keel ran no jobs in the last day${counts.running || counts.waiting ? `; ${plural(counts.running + counts.waiting, "job is", "jobs are")} running or waiting` : ""}.`, tone: "fine", retry: null };
  }
  const active = counts.running + counts.waiting;
  if (counts.partialDay) {
    return {
      text: `Keel ran ${plural(counts.jobsDay, "job")} in the last day; none failed, but ${counts.partialDay} ${counts.partialDay === 1 ? "was" : "were"} only partly done${active ? `; ${plural(active, "is", "are")} still running or waiting` : ""}.`,
      detail: "Some types were not backed up. Open a partly done run to see which.",
      tone: "soon",
      retry: null,
    };
  }
  return {
    text: `Keel ran ${plural(counts.jobsDay, "job")} in the last day, none failed${active ? `; ${plural(active, "is", "are")} still running or waiting` : ""}.`,
    tone: active ? "low" : "fine",
    retry: null,
  };
}

/** The filters kept in the address, parsed once for the server page and the client. */
export interface ActivityFilters {
  show: "all" | "jobs" | "records";
  range: DayRange | null;
  // Each filter takes several values, and they add up: `outcome=failed,running` shows
  // either, `who=a,b` either account, `what=backup,restore` either kind.
  who: string[];
  what: ActivityKind[];
  outcomes: Outcome[];
}

export function parseFilters(get: (key: string) => string | null): ActivityFilters {
  const show = get("show");
  return {
    show: show === "jobs" || show === "records" ? show : "all",
    range: rangeFromParam(get("range")),
    who: actorsOf(get("who")),
    what: kindsOf(get("what")),
    outcomes: outcomesOf(get("outcome")),
  };
}

/** A day range as the from and to the evidence API takes: whole UTC days. */
export function rangeBounds(range: DayRange | null): { from: string; to: string } | null {
  if (!range) return null;
  const { from, to } = normalise(range);
  return { from: `${from}T00:00:00.000Z`, to: `${to ?? from}T23:59:59.999Z` };
}

export function rowMatches(row: ActivityRow, filters: ActivityFilters): boolean {
  if (filters.show === "jobs" && row.type !== "job") return false;
  if (filters.show === "records" && row.type !== "record") return false;
  if (filters.what.length && !filters.what.includes(row.kind)) return false;
  if (filters.outcomes.length && !filters.outcomes.includes(row.outcome)) return false;
  if (filters.who.length && !(row.who && filters.who.includes(row.who))) return false;
  if (filters.range) {
    const bounds = rangeBounds(filters.range)!;
    const at = row.at ?? "";
    if (!at || at < bounds.from || at > bounds.to) return false;
  }
  return true;
}

/** "failed backups by Amara Okafor, today": the filters as one phrase, for the note. */
export function filterWords(filters: ActivityFilters, people: ActivityPeople, today: Day): string {
  const parts: string[] = [];
  if (filters.outcomes.length) parts.push(filters.outcomes.map((key) => OUTCOMES[key].plural.toLowerCase()).join(" or "));
  parts.push(filters.what.length ? filters.what.map((key) => ACTIVITY_KINDS[key].label.toLowerCase()).join(" or ") : filters.show === "jobs" ? "jobs" : filters.show === "records" ? "audit entries" : "entries");
  if (filters.who.length) parts.push(`by ${filters.who.map((who) => whoName(who, people)).join(" or ")}`);
  if (filters.range) {
    const { from, to } = normalise(filters.range);
    parts.push(!to && from === today ? "today" : to ? `from ${shortDate(from)} to ${shortDate(to)}` : `on ${shortDate(from)}`);
  }
  return parts.join(" ");
}

/** Each filter on as a removable chip: its words and the address change that drops it. */
export function filterChips(filters: ActivityFilters, people: ActivityPeople, today: Day): { key: string; label: string; clear: Record<string, string | null> }[] {
  const chips: { key: string; label: string; clear: Record<string, string | null> }[] = [];
  for (const key of filters.outcomes) {
    const rest = filters.outcomes.filter((entry) => entry !== key);
    chips.push({ key: `outcome:${key}`, label: OUTCOMES[key].plural, clear: { outcome: rest.join(",") || null } });
  }
  if (filters.show !== "all") chips.push({ key: "show", label: filters.show === "jobs" ? "Jobs only" : "Audit record only", clear: { show: null } });
  for (const key of filters.what) chips.push({ key: `what:${key}`, label: ACTIVITY_KINDS[key].label, clear: { what: filters.what.filter((entry) => entry !== key).join(",") || null } });
  for (const who of filters.who) chips.push({ key: `who:${who}`, label: `By ${whoName(who, people)}`, clear: { who: filters.who.filter((entry) => entry !== who).join(",") || null } });
  if (filters.range) {
    const { from, to } = normalise(filters.range);
    chips.push({ key: "range", label: !to && from === today ? "Today" : to ? `${shortDate(from)} to ${shortDate(to)}` : `On ${shortDate(from)}`, clear: { range: null } });
  }
  return chips;
}

function whoName(who: string, people: ActivityPeople): string {
  const ref = personFor(who, people);
  return ref ? capital(personLabel(ref)) : "one account";
}

/** The account behind a "Who" value: keyed by the actor as recorded, or by its id. */
function personFor(who: string, people: ActivityPeople): EngineRef | null {
  return people[who] ?? Object.values(people).find((ref) => ref?.id === who) ?? null;
}

function shortDate(day: Day): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

/** A CSV of the chosen rows: the sentence, who, when and the outcome; ids in extra columns. */
export function activityCsv(rows: ActivityRow[]): string {
  const lines = [["When", "What", "Kind", "Outcome", "Who", "Source", "Job ID", "Audit sequence", "Account"].join(",")];
  for (const row of rows) {
    lines.push(csvLine([
      row.at ?? "", row.title, ACTIVITY_KINDS[row.kind].one, OUTCOMES[row.outcome].label,
      row.person ? capital(personLabel(row.person)) : "", row.type === "job" ? "Job" : "Audit record",
      row.job?.id ?? "", row.entry?.seq ?? "", row.who ?? "",
    ], { always: true }));
  }
  return lines.join("\n");
}

/** The people seen in the rows, for the "Who" picker: each once, named, people first. */
export function peopleIn(rows: ActivityRow[], people: ActivityPeople, chosen: readonly string[]): { id: string; name: string; system: boolean }[] {
  const seen = new Map<string, EngineRef>();
  for (const row of rows) if (row.who && row.person && !seen.has(row.who)) seen.set(row.who, row.person);
  for (const who of chosen) {
    const ref = personFor(who, people);
    if (ref && !seen.has(who)) seen.set(who, ref);
  }
  return [...seen.entries()]
    .map(([id, ref]) => ({ id, name: capital(personLabel(ref)), system: Boolean(ref.system) }))
    .sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name));
}
