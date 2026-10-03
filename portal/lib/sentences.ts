// Roadmap task-130 (portal experience contract, identification rules): the generated
// names and status sentences of objects that have no name column of their own — jobs,
// approval requests, audit-record entries — built from their own fields and the
// references the engine resolved. One module, so every page says the same thing the
// same way. Raw codes and ids never appear in these strings; they live in the record.
import { ago, displayEnum, formatTimestamp, resourceLabel, resourceTypeLabel, words } from "@/lib/presentation";

export interface EngineRef {
  kind: string;
  id: string;
  name: string | null;
  readable: boolean;
  email?: string | null;
  system?: boolean;
}

export interface PlanRef extends EngineRef {
  status?: string;
  undo?: boolean;
  resources?: number;
  snapshotAt?: string | null;
  dryRunJobId?: string | null;
}

export interface ChangeRef extends EngineRef {
  naturalKey?: string;
  changeType?: string;
  blastRadius?: string;
}

export interface SnapshotRef extends EngineRef {
  takenAt?: string | null;
}

export interface RowReferences {
  people: Record<string, EngineRef | undefined>;
  baseline: (EngineRef & { setAt?: string | null; active?: boolean }) | null;
  plan: PlanRef | null;
  undoes: PlanRef | null;
  changes: (ChangeRef | undefined)[];
  snapshot: SnapshotRef | null;
}

export const EMPTY_REFERENCES: RowReferences = { people: {}, baseline: null, plan: null, undoes: null, changes: [], snapshot: null };

const KIND_WORDS: Record<string, string> = {
  person: "Account",
  baseline: "Baseline",
  "dry-run": "Dry run",
  change: "Change",
  snapshot: "Snapshot",
  policy: "Policy",
  channel: "Channel",
};

/** A reference as a name; one that cannot be read keeps its kind and a short id. */
export function refLabel(ref: EngineRef | null | undefined, fallback = "someone"): string {
  if (!ref) return fallback;
  if (ref.readable && ref.name) return ref.name;
  return `${KIND_WORDS[ref.kind] ?? words(ref.kind)} ${ref.id.slice(0, 8)} (no longer readable)`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

function when(value: string | null | undefined): string {
  return value ? formatTimestamp(value) : "an unknown time";
}

function planPhrase(plan: PlanRef | null | undefined): string {
  if (!plan || !plan.readable) return "a dry run that is no longer readable";
  return `${plural(plan.resources ?? 0, "resource")} from the snapshot of ${when(plan.snapshotAt)}`;
}

function changesPhrase(changes: (ChangeRef | undefined)[]): string {
  const known = changes.filter((change): change is ChangeRef => Boolean(change));
  const first = known.find((change) => change.readable && change.naturalKey);
  const count = plural(known.length, "change");
  return first?.naturalKey ? `${count}, including ${resourceLabel(first.naturalKey)}` : count;
}

function tierPhrase(tier: unknown): string {
  if (typeof tier !== "string" || !tier) return "every tier";
  const match = /^tier(\d)$/.exec(tier);
  return match ? `Tier ${match[1]}` : words(tier);
}

interface JobLike {
  kind: string;
  status: string;
  params: unknown;
  createdAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  references?: RowReferences;
}

/** A job's name: what it does, in words, with the things it acts on named. */
export function jobName(job: JobLike): string {
  const params = (job.params ?? {}) as Record<string, unknown>;
  const refs = job.references ?? EMPTY_REFERENCES;
  switch (job.kind) {
    case "collect": return "Backup of every configuration type";
    case "backup": return `Backup of ${tierPhrase(params.tier)}`;
    case "restore": {
      if (typeof params.compensates === "string") return `Dry run of an undo of the restore of ${planPhrase(refs.undoes)}`;
      if (params.mode === "enforce") return refs.plan?.undo ? "Undo of a restore" : `Restore of ${planPhrase(refs.plan)}`;
      const selected = Array.isArray(params.selection) ? params.selection.length : 0;
      return `Dry run of a restore of ${plural(selected, "selected resource")} from the snapshot of ${when(refs.snapshot?.readable ? refs.snapshot.takenAt : null)}`;
    }
    case "remediate": return `Roll back of ${changesPhrase(refs.changes)}`;
    case "baseline-create": return typeof params.label === "string" && params.label ? `Creation of baseline “${params.label}”` : "Creation of a baseline";
    case "baseline-activate": return refs.baseline?.readable && refs.baseline.name
      ? `Activation of baseline “${refs.baseline.name}”`
      : `Activation of ${refs.baseline ? "a baseline that is no longer readable" : "a baseline"}`;
    default: return displayEnum("jobKind", job.kind);
  }
}

function duration(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from || !to) return null;
  const seconds = Math.round((new Date(to).valueOf() - new Date(from).valueOf()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return plural(seconds, "second");
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? plural(minutes, "minute") : plural(Math.round(minutes / 60), "hour");
}

/** "Running, started 2 minutes ago" — status as a sentence, not a chip beside a chip. */
export function jobStatusSentence(job: JobLike, now: string): string {
  switch (job.status) {
    case "queued": return `Waiting to start, queued ${ago(job.createdAt ?? null, now)}`;
    case "running": return `Running, started ${ago(job.startedAt ?? job.createdAt ?? null, now)}`;
    case "succeeded": {
      const took = duration(job.startedAt, job.finishedAt);
      return `Finished ${ago(job.finishedAt ?? null, now)}${took ? ` after ${took}` : ""}`;
    }
    case "failed": return `Failed ${ago(job.finishedAt ?? job.startedAt ?? null, now)}`;
    case "cancelled": return `Cancelled ${ago(job.finishedAt ?? job.createdAt ?? null, now)}`;
    default: return displayEnum("jobStatus", job.status);
  }
}

interface RequestLike {
  action: string;
  params: unknown;
  references?: RowReferences;
}

/** What an approval request would change, as a sentence with names. */
export function approvalSentence(request: RequestLike): string {
  const refs = request.references ?? EMPTY_REFERENCES;
  switch (request.action) {
    case "restore":
      if (refs.plan?.readable && refs.plan.undo) return `Undo a restore of ${plural(refs.plan.resources ?? 0, "resource")}`;
      return refs.plan?.readable ? `Restore ${planPhrase(refs.plan)}` : "Restore from a dry run that is no longer readable";
    case "baseline-activate":
      return refs.baseline?.readable && refs.baseline.name
        ? `Activate baseline “${refs.baseline.name}”`
        : "Activate a baseline that is no longer readable";
    case "remediate": return `Roll back ${changesPhrase(refs.changes)}`;
    default: return displayEnum("jobKind", request.action);
  }
}

const IMPACT_ORDER = ["tenant-lockout", "access-affecting", "cosmetic"];

/** The worst impact of what a request would change, in words, when it is known. */
export function approvalImpact(request: RequestLike): string | null {
  const radii = (request.references?.changes ?? []).map((change) => change?.blastRadius).filter((value): value is string => Boolean(value));
  const worst = IMPACT_ORDER.find((radius) => radii.includes(radius));
  return worst ? displayEnum("blastRadius", worst) : null;
}

interface EvidenceLike {
  kind: string;
  actor: string;
  subject: unknown;
}

/** An audit-record entry as a sentence: who did what. */
export function evidenceSentence(entry: EvidenceLike, actorName: string): string {
  const subject = (entry.subject ?? {}) as Record<string, unknown>;
  const actionWords = (value: unknown) => (typeof value === "string" ? displayEnum("jobKind", value.replace(/:.*/, "")).toLowerCase() : "an action");
  switch (entry.kind) {
    case "approval-request": return `${actorName} asked for approval: ${actionWords(subject.action)}`;
    case "approval-decision": return `${actorName} ${subject.decision === "reject" || subject.status === "rejected" ? "rejected" : "approved"} a request`;
    case "approval.decided": return `${actorName} decided an approval`;
    case "action-attempt": return subject.decision === "denied"
      ? `${actorName} was refused: ${actionWords(subject.action)}`
      : `${actorName} started ${actionWords(subject.action)}`;
    case "policy-evaluation": return typeof subject.naturalKey === "string"
      ? `Policies checked a change to ${resourceLabel(subject.naturalKey)}${subject.matched ? ", and one applied" : ""}`
      : "Policies checked a change";
    case "automation-execution": return `Automation ${subject.outcome === "executed" ? "rolled back a change" : "tried to roll back a change"}`;
    case "content-effect-approval": return `${actorName} approved a restore that changes how content is kept or shared`;
    case "recovery-completion": return `${actorName} updated the follow-up work of a restore`;
    case "incident-recovery": return `${actorName} updated incident recovery: ${typeof subject.transition === "string" ? words(subject.transition).toLowerCase() : "a change"}`;
    case "incident-recovery-check": return "KEEL checked a restore for malicious items left behind";
    case "fidelity-drill": return typeof subject.resourceType === "string"
      ? `A test restore of a ${resourceTypeLabel(subject.resourceType)} was measured`
      : "A test restore was measured";
    case "job.started": return `${actorName} started ${actionWords(subject.kind)}`;
    case "collection.completed": return typeof subject.items === "number"
      ? `A backup of ${plural(Number(subject.types ?? 0), "type")} finished with ${plural(subject.items, "item")}`
      : "A backup finished";
    default: return `${actorName}: ${displayEnum("eventKind", entry.kind).toLowerCase()}`;
  }
}

export function timeAgo(value: string | null | undefined, now: string): string {
  return ago(value ?? null, now);
}
