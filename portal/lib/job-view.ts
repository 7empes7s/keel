import type { IconName } from "@/components/shell/icons";
import type { AlertItem } from "@/components/ui/alert-list";
import type { StatTile } from "@/components/ui/stat-tiles";
import { typeService } from "@/lib/baselines-view";
import { workloadLabel } from "@/lib/compare-view";
import { CONTENT_WORKLOADS, holdsObjectId, incompleteTypeLabel, jobIncompleteTypes } from "@/lib/job-names";
import { typeName } from "@/lib/protect-view";
import { serviceFor, serviceOrder } from "@/lib/services";
import { kindParts, type KindPart } from "@/lib/type-groups";
import type { JobRecord } from "@/lib/portal-jobs";
import { ago } from "@/lib/presentation";

// The Job page as alerts and tiles. A failed job leads with a plain cause and one next
// step; the engine's own error text waits behind "Show details".

type Cause = Pick<AlertItem, "tone" | "icon"> & { title: string; todo: string; action: AlertItem["action"] };

const RESTORE_KINDS = new Set(["restore", "remediate"]);

/** The plain cause of a failed job and what to do about it, from its error text. */
export function jobErrorCause(job: Pick<JobRecord, "kind" | "error" | "params">): Cause {
  const error = String(job.error ?? "");
  const params = (job.params ?? {}) as Record<string, unknown>;
  const artifact = typeof params.artifactId === "string" ? params.artifactId : null;
  const again = RESTORE_KINDS.has(job.kind) ? "Run the restore again" : "Run it again";
  if (/blocked-content-effect/.test(error)) {
    return {
      tone: "soon", icon: "clock", title: "Waiting for approval of what it does to content",
      todo: `Someone must approve its effect on files, mail or messages. ${again} after that.`,
      action: artifact ? { label: "Review content effects", href: `/approvals/content-effects/${encodeURIComponent(artifact)}` } : null,
    };
  }
  if (/\b429\b|throttl/i.test(error)) {
    return {
      tone: "soon", icon: "clock", title: "Microsoft 365 slowed Keel down",
      todo: "The next scheduled run tries again. If this keeps happening, space the schedules further apart.",
      action: { label: "Open schedules", href: "/schedules" },
    };
  }
  if (/\b40[13]\b|Authorization_RequestDenied|Insufficient privileges|forbidden|unauthori[sz]ed/i.test(error)) {
    return {
      tone: "urgent", icon: "person", title: "Keel is missing a permission in Microsoft 365",
      todo: `Check Keel's permissions on the Setup page. ${again} once they are granted.`,
      action: { label: "Open setup", href: "/setup" },
    };
  }
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|\b50[234]\b/i.test(error)) {
    return {
      tone: "soon", icon: "cloud", title: "Keel could not reach Microsoft 365",
      todo: `${again} in a few minutes.`, action: null,
    };
  }
  if (/interrupted|shut ?down|restart|lease (?:lost|expired)|worker (?:died|lost)/i.test(error)) {
    return { tone: "soon", icon: "refresh", title: "The job was interrupted before it finished", todo: `${again}.`, action: null };
  }
  if (/\b4\d\d\b|rejected|BadRequest|invalid/i.test(error)) {
    return {
      tone: "urgent", icon: "x-circle", title: "Microsoft 365 refused the change",
      todo: RESTORE_KINDS.has(job.kind) ? "Check what was sent in the dry run, then try again or make the change by hand." : `${again}. If it fails the same way, check Show details.`,
      action: null,
    };
  }
  return { tone: "urgent", icon: "alert", title: "The job stopped with an error", todo: `${again}. If it fails the same way, check Show details.`, action: null };
}

/** What needs the reader on this job, worst first: the failure, then any gaps. */
export function jobAlerts(job: JobRecord): AlertItem[] {
  const alerts: AlertItem[] = [];
  if (job.status === "failed" && job.error !== null && job.error !== undefined) {
    const cause = jobErrorCause(job);
    const lines = String(job.error).split("\n").map((line) => line.trim()).filter(Boolean);
    alerts.push({ key: "error", ...cause, more: lines.length ? lines.slice(0, 12) : [] });
  }
  const typeAlert = typeProblemsAlert(jobTypeRows(job, job.finishedAt ?? new Date().toISOString()));
  if (typeAlert) alerts.push(typeAlert);
  const gaps = typeAlert ? [] : jobIncompleteTypes(job);
  if (gaps.length) {
    alerts.push({
      key: "gaps", tone: "soon", icon: "backup",
      title: `${gaps.length === 1 ? "1 kind" : `${gaps.length} kinds`} could not be backed up in full`,
      todo: "The rest was saved. The next backup tries these again.",
      more: gaps.map((type) => incompleteTypeLabel(type).replace(/^./, (letter) => letter.toUpperCase())),
      action: { label: "Open backups", href: "/protect" },
    });
  }
  const rank = { urgent: 0, soon: 1, low: 2 } as const;
  return alerts.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

/** "3 minutes", or null when either end is missing. */
export function jobGap(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from || !to) return null;
  const seconds = Math.round((new Date(to).valueOf() - new Date(from).valueOf()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(minutes / 60)} hours`;
}

/** What a restore or undo wrote, from its result: changes written and changes skipped. */
export function jobResultTiles(job: Pick<JobRecord, "kind" | "result" | "status">): StatTile[] {
  if (!RESTORE_KINDS.has(job.kind) || !job.result || typeof job.result !== "object") return [];
  const result = job.result as Record<string, unknown>;
  const applied = Number.isSafeInteger(result.applied) ? Number(result.applied) : null;
  const skipped = Number.isSafeInteger(result.skipped) ? Number(result.skipped) : null;
  const tiles: StatTile[] = [];
  if (applied !== null) tiles.push({ key: "applied", label: "Changes written", icon: "restore", value: applied.toLocaleString("en-GB"), about: "put back in Microsoft 365", tone: applied ? "fine" : "neutral" });
  if (skipped !== null) tiles.push({ key: "skipped", label: "Left alone", icon: "hide", value: skipped.toLocaleString("en-GB"), about: skipped ? "already matched or not allowed" : "none", tone: skipped ? "low" : "neutral" });
  return tiles;
}

/** Three timing tiles: when it was asked for, how long it waited, how long it ran. */
export function jobTiles(job: JobRecord, now: string): StatTile[] {
  const waited = jobGap(job.createdAt, job.startedAt);
  const ran = jobGap(job.startedAt, job.finishedAt ?? (job.status === "running" ? now : null));
  const status = job.status === "failed" ? "urgent" : job.status === "succeeded" ? "fine" : job.status === "running" ? "soon" : "neutral";
  return [
    { key: "asked", label: "Asked for", icon: "calendar", value: ago(job.createdAt ?? null, now), about: "when it was queued", tone: "neutral" },
    { key: "waited", label: "Waited", icon: "clock", value: job.startedAt ? (waited ?? "Unknown") : "Not started", about: job.startedAt ? "before it started" : "still in the queue", tone: job.startedAt ? "neutral" : "low" },
    {
      key: "ran", label: job.finishedAt ? "Ran for" : "Running for", icon: "play",
      value: job.startedAt ? (ran ?? "Unknown") : "—",
      about: job.finishedAt ? (job.status === "failed" ? "then it failed" : "then it ended") : job.startedAt ? "so far" : "not started yet",
      tone: job.finishedAt ? status : job.startedAt ? "soon" : "neutral",
    },
  ];
}

// ---------------------------------------------------------------------------------
// A backup job's progress by type (Job page redesign): every kind it reads, grouped by
// service and kind, with a coloured state, the count saved, how long it took, and a
// plain cause for any problem. Written live while the job runs.

export type ReadTone = "urgent" | "soon" | "low" | "fine" | "neutral";

const READ_STATES: Record<string, { label: string; tone: ReadTone; done: boolean; problem: boolean }> = {
  waiting: { label: "Waiting", tone: "neutral", done: false, problem: false },
  reading: { label: "Reading now", tone: "low", done: false, problem: false },
  complete: { label: "Backed up", tone: "fine", done: true, problem: false },
  "complete-empty": { label: "Backed up, none found", tone: "fine", done: true, problem: false },
  partial: { label: "Partly read", tone: "soon", done: true, problem: true },
  failed: { label: "Failed", tone: "urgent", done: true, problem: true },
  unavailable: { label: "Not in this tenant's licence", tone: "neutral", done: true, problem: false },
  disabled: { label: "Switched off", tone: "neutral", done: true, problem: false },
  stopped: { label: "Stopped before it finished", tone: "urgent", done: true, problem: true },
};

export interface TypeRow {
  type: string;
  name: string;
  state: string;
  label: string;
  tone: ReadTone;
  count: number | null;
  took: string | null;
  problem: string | null;
  // The engine's own error text, shown only when asked for.
  raw: string | null;
  // Content backups: each mailbox, OneDrive or site that could not be read in full.
  items: GapItem[];
  // How many there were in all ("10 OneDrives"); the list holds at most 50.
  itemTotal: number;
  itemsLabel: string | null;
}

/** One thing a content backup could not read: its name, a plain cause, and the raw text. */
export interface GapItem { name: string; why: string; tone: ReadTone; raw: string }

// The plain cause of one item a content backup could not read, from its reason text.
const ITEM_CAUSES: Array<[RegExp, string, ReadTone]> = [
  [/\b423\b|locked|notAllowed/i, "Locked by Microsoft", "soon"],
  [/\b429\b|throttl/i, "Microsoft 365 slowed Keel down", "soon"],
  [/\b40[13]\b|AccessDenied|forbidden|unauthori[sz]ed|Insufficient privileges/i, "Access refused", "urgent"],
  [/\b404\b|not ?found/i, "Not found: deleted or moved during the backup", "soon"],
  [/timed? ?out|ETIMEDOUT|ECONNRESET|fetch failed|socket hang up|\b50[0234]\b/i, "Microsoft 365 did not answer", "soon"],
  [/file warning/i, "Some files could not be read", "soon"],
  [/than one run reads/i, "Too many to read in one run", "soon"],
];

/** A site's address as a name: its last path part ("hr" from …/sites/hr), else its host. */
function nameFromUrl(text: string): string {
  try {
    const url = new URL(text);
    const last = url.pathname.split("/").filter(Boolean).at(-1);
    return last ? decodeURIComponent(last) : url.hostname;
  } catch {
    return text;
  }
}

/** "Ann Lee: HTTP 423 …" as an item: the name before the first ": ", and a plain cause
 *  read from the text after it, so a name holding "403" never sets the cause. */
export function contentGapItem(reason: string): GapItem {
  const index = reason.indexOf(": ");
  const head = index > 0 ? reason.slice(0, index).trim() : "";
  const rest = index > 0 ? reason.slice(index + 2) : reason;
  const [, why, tone] = ITEM_CAUSES.find(([pattern]) => pattern.test(rest)) ?? [null, "Could not be read in full", "soon" as ReadTone];
  // A name, never an object id or an API path.
  const plain = /^https?:\/\//i.test(head) ? nameFromUrl(head) : head;
  const name = !plain || plain.startsWith("/") ? "Part of this backup" : holdsObjectId(plain) ? "Unnamed item" : plain.replace(/^./, (letter) => letter.toUpperCase());
  return { name, why, tone, raw: reason };
}

/** "10 OneDrives": how many items of a content workload could not be read. */
function itemsLabel(workload: string, total: number): string {
  const [one, many] = CONTENT_WORKLOADS[workload]?.item ?? ["item", "items"];
  return `${total.toLocaleString("en-GB")} ${total === 1 ? one : many}`;
}

/** A content row's problem in words: "10 OneDrives could not be read in full: locked by Microsoft". */
function itemsProblem(label: string, items: GapItem[]): string {
  const causes = [...new Set(items.map((item) => item.why))];
  const cause = causes.length === 1 ? `: ${causes[0].replace(/^./, (letter) => letter.toLowerCase())}` : "";
  return `${label} could not be read in full${cause}`;
}

export interface TypeGroup { key: string; name: string; icon: IconName; parts: KindPart<TypeRow>[]; rows: TypeRow[]; problems: number; done: number }

/** A plain cause for one kind's problem: a recognised error, else what the state means. */
function readProblem(state: string, raw: string | null): string {
  if (state === "stopped") return "The job ended while this was being read";
  const cause = raw ? jobErrorCause({ kind: "backup", error: raw, params: {} }) : null;
  if (cause && cause.title !== "The job stopped with an error") return cause.title;
  return state === "partial" ? "Only part of it could be read" : "Keel could not read it";
}

/** A row's key as a kind and its name: a setting type, a service workload or content. */
function readName(key: string): { type: string; name: string } {
  if (key.startsWith("workload:")) { const workload = key.slice("workload:".length); return { type: workload, name: workloadLabel(workload) }; }
  if (key.startsWith("content:")) {
    const workload = key.slice("content:".length);
    return { type: key, name: CONTENT_WORKLOADS[workload]?.name ?? workloadLabel(workload) };
  }
  return { type: key, name: typeName(key) };
}

/** The service a row sits under. */
function rowService(type: string): string {
  if (type.startsWith("content:")) return CONTENT_WORKLOADS[type.slice("content:".length)]?.service ?? "other";
  return typeService(type).code;
}

/** One row per kind the job reads. A kind still "reading" on a job that ended stopped there. */
export function jobTypeRows(job: Pick<JobRecord, "status" | "progress">, now: string): TypeRow[] {
  const types = job.progress?.types ?? {};
  const active = job.status === "running" || job.status === "queued";
  return Object.entries(types).map(([key, entry]) => {
    const { type, name } = readName(key);
    const state = entry.outcome === "reading" && !active ? "stopped" : READ_STATES[entry.outcome] ? entry.outcome : "failed";
    const look = READ_STATES[state];
    const raw = entry.error ?? (entry.httpStatus && entry.httpStatus >= 400 ? `HTTP ${entry.httpStatus}` : null);
    // A content workload read in part names each item it could not read: from the list
    // the job wrote, else from its error text, one item per line. That text is cut at 500
    // characters, so a last line cut short is left out. A workload that failed outright
    // keeps its one plain cause.
    const errorLines = (entry.error ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    if ((entry.error ?? "").length >= 500 && errorLines.length > 1) errorLines.pop();
    const reasons = state !== "partial" || !key.startsWith("content:") ? []
      : entry.reasons?.length ? entry.reasons : errorLines;
    const items = reasons.map(contentGapItem);
    const total = Math.max(items.length, entry.reasonCount ?? 0);
    const label = items.length ? itemsLabel(key.slice("content:".length), total) : null;
    return {
      type,
      name,
      state,
      label: look.label,
      tone: look.tone,
      count: entry.itemCount ?? null,
      took: state === "reading" ? jobGap(entry.startedAt, now) : jobGap(entry.startedAt, entry.completedAt),
      problem: look.problem ? (label ? itemsProblem(label, items) : readProblem(state, raw)) : null,
      raw: look.problem && !items.length ? raw : null,
      items,
      itemTotal: total,
      itemsLabel: label,
    };
  });
}

/** The rows by service (Microsoft's order), then by kind inside each service. */
export function jobTypeGroups(rows: TypeRow[]): TypeGroup[] {
  const services = new Map<string, TypeRow[]>();
  for (const row of rows) {
    const code = rowService(row.type);
    services.set(code, [...(services.get(code) ?? []), row]);
  }
  return [...services.entries()]
    .sort(([a], [b]) => serviceOrder(a) - serviceOrder(b))
    .map(([code, list]) => {
      const service = serviceFor(code);
      return {
        key: code, name: service.name, icon: service.icon,
        parts: kindParts(list, (row) => row.type, code),
        rows: list,
        problems: list.filter((row) => READ_STATES[row.state].problem).length,
        done: list.filter((row) => READ_STATES[row.state].done).length,
      };
    });
}

/** Four tiles for a backup: how far it got, what it saved, problems, and the time taken. */
export function jobProgressTiles(job: JobRecord, rows: TypeRow[], now: string): StatTile[] {
  const done = rows.filter((row) => READ_STATES[row.state].done).length;
  const problems = rows.filter((row) => READ_STATES[row.state].problem).length;
  const saved = rows.reduce((sum, row) => sum + (READ_STATES[row.state].done && row.count ? row.count : 0), 0);
  const reading = rows.find((row) => row.state === "reading");
  const running = job.status === "running";
  const ran = jobGap(job.startedAt, job.finishedAt ?? (running ? now : null));
  return [
    {
      key: "progress", label: "Progress", icon: "backup",
      value: `${done} of ${rows.length}`,
      about: reading ? `Reading ${reading.name.toLowerCase()}` : running ? "kinds read so far" : "kinds read",
      tone: problems ? "soon" : done === rows.length ? "fine" : "low",
    },
    { key: "saved", label: "Items saved", icon: "save", value: saved.toLocaleString("en-GB"), about: running ? "so far" : "in this backup", tone: "neutral" },
    { key: "problems", label: "Problems", icon: "alert", value: String(problems), about: problems ? `${problems === 1 ? "kind" : "kinds"} not read in full` : "none", tone: problems ? (rows.some((row) => row.tone === "urgent") ? "urgent" : "soon") : "fine" },
    {
      key: "ran", label: running ? "Running for" : "Took", icon: "clock",
      value: job.startedAt ? (ran ?? "Unknown") : "Not started",
      about: job.startedAt ? `waited ${jobGap(job.createdAt, job.startedAt) ?? "a moment"} to start` : "still in the queue",
      tone: job.status === "failed" ? "urgent" : running ? "low" : "neutral",
    },
  ];
}

/** Share of kinds finished, 0 to 100, for the progress bar. */
export function jobProgressPercent(rows: TypeRow[]): number {
  if (!rows.length) return 0;
  return Math.round((rows.filter((row) => READ_STATES[row.state].done).length / rows.length) * 100);
}

/** One alert for the kinds a backup could not read in full, worst first inside. */
export function typeProblemsAlert(rows: TypeRow[]): AlertItem | null {
  const problems = rows.filter((row) => READ_STATES[row.state].problem);
  if (!problems.length) return null;
  const failed = problems.filter((row) => row.tone === "urgent").length;
  return {
    key: "types", tone: failed ? "urgent" : "soon", icon: "backup",
    title: `${problems.length === 1 ? "1 kind was" : `${problems.length} kinds were`} not backed up in full`,
    todo: "The rest was saved. The next backup tries these again. The list below shows why.",
    more: problems.map((row) => `${row.name}: ${row.problem}`),
    action: problems.some((row) => row.items.length) ? { label: "See what was not read", href: "#job-gaps" } : { label: "See the list", href: "#job-types" },
  };
}
