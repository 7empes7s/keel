// Roadmap task-130 (portal experience contract, identification rules): the generated
// names and status sentences of objects that have no name column of their own — jobs,
// approval requests, audit-record entries — built from their own fields and the
// references the engine resolved. One module, so every page says the same thing the
// same way. Raw codes and ids never appear in these strings; they live in the record.
import { ago, displayEnum, formatTimestamp, resourceLabel, resourceTypeLabel, words } from "@/lib/presentation";
import { WORKLOAD_LABELS, workloadLabel } from "@/lib/compare-view";
import { holdsObjectId, jobIncompleteTypes, type NamedKeys, namedResource } from "@/lib/job-names";

export interface EngineRef {
  kind: string;
  id: string;
  name: string | null;
  readable: boolean;
  email?: string | null;
  system?: boolean;
  // "Hide people's names" is on: name is a stable code name (engine/insights/people.mjs).
  pseudonym?: boolean;
}

export interface PlanRef extends EngineRef {
  status?: string;
  undo?: boolean;
  resources?: number;
  snapshotAt?: string | null;
  dryRunJobId?: string | null;
  // Q45: content effects that need their own approval, whichever surface planned it.
  contentEffects?: number;
  // A restore of another Microsoft 365 service: its workload ("exchange-mail-flow").
  workload?: string | null;
  // A "Make it pass" fix for a failing compliance check.
  complianceFix?: boolean;
}

export interface ChangeRef extends EngineRef {
  naturalKey?: string;
  resourceType?: string;
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

// Accounts Keel itself acts as, named in words rather than by their code.
const SYSTEM_ACTORS: Record<string, string> = {
  scheduler: "Keel's scheduler",
  "policy-automation": "Keel's policy automation",
};

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/**
 * A person as a name: their display name, else a name read from their email address
 * ("maro.defili@…" reads "Maro Defili"). Keel's own accounts are named in words. Never
 * an email, a system code or an account id; those stay in Technical details.
 */
export function personLabel(ref: EngineRef | null | undefined, fallback = "an unknown person"): string {
  if (!ref) return fallback;
  if (!ref.readable) return "an account that no longer exists";
  const name = ref.name?.trim() ?? "";
  const readableName = Boolean(name) && !EMAIL.test(name) && !holdsObjectId(name);
  if (ref.system) {
    const code = (readableName && !ref.email ? name : (ref.email ?? name).split("@")[0]).toLowerCase();
    if (SYSTEM_ACTORS[code]) return SYSTEM_ACTORS[code];
    if (readableName && ref.email) return name;
    return code && !holdsObjectId(code) ? `Keel (${words(code).toLowerCase()})` : "Keel";
  }
  if (readableName) return name;
  const local = (ref.email ?? name).split("@")[0];
  const fromEmail = local.split(/[^A-Za-z]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase()).join(" ");
  return fromEmail && !holdsObjectId(local) ? fromEmail : fallback;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

function when(value: string | null | undefined): string {
  return value ? formatTimestamp(value) : "an unknown time";
}

// The Microsoft service each workload sits under, by the start of its code.
const WORKLOAD_SERVICES: [string, string][] = [
  ["exchange", "Exchange"], ["teams", "Teams"], ["purview", "Purview"], ["sharepoint", "SharePoint"],
  ["onedrive", "OneDrive"], ["power-platform", "Power Platform"],
];

// Restores the Restore page does not list as a backup of their own.
const RESTORE_ONLY_LABELS: Record<string, string> = {
  "sharepoint-site-permissions": "SharePoint site permissions",
  "sharepoint-site-grants": "SharePoint site app access",
};

/** "Exchange mail flow", "Purview sensitivity labels": a workload as its service and what it covers. */
export function workloadSubject(workload: string): string {
  const label = RESTORE_ONLY_LABELS[workload] ?? workloadLabel(workload);
  const service = WORKLOAD_SERVICES.find(([prefix]) => workload === prefix || workload.startsWith(`${prefix}-`))?.[1];
  if (!service || label.toLowerCase().startsWith(service.toLowerCase())) return label;
  return `${service} ${label[0].toLowerCase()}${label.slice(1)}`;
}

function planPhrase(plan: PlanRef | null | undefined): string {
  if (!plan || !plan.readable) return "a dry run that is no longer readable";
  if (plan.complianceFix) return `a fix for a failing compliance check (${plural(plan.resources ?? 0, "setting")})`;
  if (plan.workload) return `${workloadSubject(plan.workload)} (${plural(plan.resources ?? 0, "setting")}) from the backup of ${when(plan.snapshotAt)}`;
  return `${plural(plan.resources ?? 0, "resource")} from the snapshot of ${when(plan.snapshotAt)}`;
}

/** A dry run of another Microsoft 365 service's restore, named by its service and what was chosen. */
function workloadDryRunName(request: Record<string, unknown>): string {
  const workload = typeof request.workload === "string" && request.workload ? request.workload : null;
  if (!workload) return "Dry run of a restore of another Microsoft 365 service";
  const subject = workloadSubject(workload);
  if (typeof request.mailbox === "string") {
    const organization = request.includeOrganization === true ? " and the organization-wide settings" : "";
    return `Dry run of a restore of ${subject} for one mailbox${organization}`;
  }
  if (typeof request.teamId === "string") return `Dry run of a restore of ${subject} for one team`;
  if (typeof request.site === "string" || typeof request.siteId === "string") return `Dry run of a restore of ${subject} for one site`;
  const targets = Array.isArray(request.targets) ? request.targets.length : 0;
  return targets > 0 ? `Dry run of a restore of ${subject} (${plural(targets, "chosen setting")})` : `Dry run of a restore of ${subject}`;
}

/** "2 Oct 2026, 09:12": the backup's moment without the zone word of a full timestamp. */
function backupMoment(value: string | null | undefined): string {
  return value ? formatTimestamp(value).replace(/ UTC$/, "") : "an unknown time";
}

function changesPhrase(changes: (ChangeRef | undefined)[]): string {
  const known = changes.filter((change): change is ChangeRef => Boolean(change));
  const count = plural(known.length, "change");
  // The saved name first (filled in by the page that loads it), then a key that holds
  // no object id. A name or key that is or holds an id is never shown.
  const named = known.find((change) => change.readable && change.name && !holdsObjectId(change.name));
  if (named?.name) return `${count}, including ${named.name}`;
  const first = known.find((change) => change.readable && change.naturalKey && !holdsObjectId(change.naturalKey));
  return first?.naturalKey ? `${count}, including ${resourceLabel(first.naturalKey)}` : count;
}

// A service setting change by its setting's name and service, never by an id.
function serviceChangePhrase(params: Record<string, unknown>): string {
  const key = typeof params.resourceKey === "string" && !holdsObjectId(params.resourceKey) ? resourceLabel(params.resourceKey) : null;
  const service = typeof params.workload === "string" ? WORKLOAD_LABELS[params.workload] ?? null : null;
  const verb = params.changeType === "added" ? "new" : params.changeType === "removed" ? "removed" : "changed";
  if (key) return `the ${verb} setting ${key}${service ? ` in ${service}` : ""}`;
  return service ? `a ${verb} ${service} setting` : "a service setting change";
}

// Audit run 2, finding 3: an accept or ignore a second person approves, as what it does:
// "Accept into the approved setup: 1 change, including …".
function decisionPhrase(params: Record<string, unknown>, refs: RowReferences): string {
  const what = typeof params.serviceChangeId === "string" ? serviceChangePhrase(params) : changesPhrase(refs.changes);
  if (params.action === "ignore") {
    return typeof params.expiresAt === "string" ? `Ignore until ${formatTimestamp(params.expiresAt)}: ${what}` : `Ignore: ${what}`;
  }
  return `Accept into the approved setup: ${what}`;
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
  result?: unknown;
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
      if (params.mode === "enforce") {
        if (refs.plan?.undo) return "Undo of a restore";
        if (refs.plan?.readable && refs.plan.complianceFix) return `Fix for a failing compliance check (${plural(refs.plan.resources ?? 0, "setting")})`;
        return `Restore of ${planPhrase(refs.plan)}`;
      }
      if (params.workloadRestore && typeof params.workloadRestore === "object") return workloadDryRunName(params.workloadRestore as Record<string, unknown>);
      if (params.complianceFix && typeof params.complianceFix === "object") {
        const key = (params.complianceFix as { naturalKey?: unknown }).naturalKey;
        return typeof key === "string" && key ? `Dry run of a fix for a failing compliance check on ${namedResource(key)}` : "Dry run of a fix for a failing compliance check";
      }
      const selected = Array.isArray(params.selection) ? params.selection.length : 0;
      return `Dry run of a restore of ${plural(selected, "selected resource")} from the snapshot of ${when(refs.snapshot?.readable ? refs.snapshot.takenAt : null)}`;
    }
    case "remediate": return `Roll back of ${changesPhrase(refs.changes)}`;
    case "dispose": return decisionPhrase(params, refs);
    case "baseline-create": return typeof params.label === "string" && params.label ? `New approved setup “${params.label}”` : "New approved setup";
    case "baseline-activate": return refs.baseline?.readable && refs.baseline.name
      ? `Switch to approved setup “${refs.baseline.name}”`
      : `Switch to ${refs.baseline ? "an approved setup that is no longer readable" : "another approved setup"}`;
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
      const gaps = jobIncompleteTypes(job).length;
      const done = `${ago(job.finishedAt ?? null, now)}${took ? ` after ${took}` : ""}`;
      if (!gaps) return `Finished ${done}`;
      if (job.kind === "content-collect") return `Partly done ${done}: ${plural(gaps, "kind")} of content not backed up in full`;
      if (job.kind === "workload-collect") return `Partly done ${done}: ${plural(gaps, "kind")} incomplete`;
      return `Partly done ${done}: ${plural(gaps, "type")} not backed up`;
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

/** What an approval request would change, as a sentence with names, in the portal's
 * plain words: settings and backups, undo changes, approved setups. */
export function approvalSentence(request: RequestLike): string {
  const refs = request.references ?? EMPTY_REFERENCES;
  switch (request.action) {
    case "restore":
      if (refs.plan?.readable && refs.plan.undo) return `Undo a restore of ${plural(refs.plan.resources ?? 0, "setting")}`;
      if (refs.plan?.readable && refs.plan.complianceFix) return `Fix a failing compliance check (${plural(refs.plan.resources ?? 0, "setting")})`;
      if (refs.plan?.readable && refs.plan.workload) {
        return `Restore ${workloadSubject(refs.plan.workload)} (${plural(refs.plan.resources ?? 0, "setting")}) from the backup of ${backupMoment(refs.plan.snapshotAt)}`;
      }
      return refs.plan?.readable
        ? `Restore ${plural(refs.plan.resources ?? 0, "setting")} from the backup of ${backupMoment(refs.plan.snapshotAt)}`
        : "Restore from a preview that is no longer readable";
    case "baseline-activate":
      return refs.baseline?.readable && refs.baseline.name
        ? `Switch to the approved setup “${refs.baseline.name}”`
        : "Switch to an approved setup that is no longer readable";
    case "remediate": return `Undo ${changesPhrase(refs.changes)}`;
    case "dispose": return decisionPhrase((request.params ?? {}) as Record<string, unknown>, refs);
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

/** An audit-record entry as a sentence: who did what, naming objects by their saved name. */
export function evidenceSentence(entry: EvidenceLike, actorName: string, names: NamedKeys = {}): string {
  const subject = (entry.subject ?? {}) as Record<string, unknown>;
  const actionWords = (value: unknown) => (typeof value === "string" ? displayEnum("jobKind", value.replace(/:.*/, "")).toLowerCase() : "an action");
  // "a backup", "an undo of changes": the action with its article, for a sentence.
  const anAction = (value: unknown) => {
    const text = actionWords(value);
    return `${/^[aeiou]/.test(text) ? "an" : "a"} ${text}`;
  };
  const refusalWords: Record<string, string> = { "no-principal": "no account was signed in", capability: "that account is not allowed to" };
  switch (entry.kind) {
    case "approval-request": return `${actorName} asked for approval: ${actionWords(subject.action)}`;
    case "approval-decision": {
      const verb = /^reject/.test(String(subject.decision ?? "")) || subject.status === "rejected" ? "rejected" : "approved";
      return typeof subject.action === "string" ? `${actorName} ${verb} ${anAction(subject.action)}` : `${actorName} ${verb} a request`;
    }
    case "approval-signoff": return typeof subject.action === "string" ? `${actorName} signed off ${anAction(subject.action)}; another approval is still needed` : `${actorName} signed off a request; another approval is still needed`;
    case "approval.decided": return `${actorName} decided an approval`;
    case "action-attempt": return subject.decision === "denied"
      ? `${actorName} was refused ${anAction(subject.action)}${typeof subject.reason === "string" && refusalWords[subject.reason] ? `: ${refusalWords[subject.reason]}` : ""}`
      : `${actorName} started ${anAction(subject.action)}`;
    case "policy-evaluation": return typeof subject.naturalKey === "string"
      ? `Policies checked a change to ${namedResource(subject.naturalKey, names)}${subject.matched ? ", and one applied" : ""}`
      : "Policies checked a change";
    case "automation-execution": return `Automation ${subject.outcome === "executed" ? "rolled back a change" : "tried to roll back a change"}`;
    case "content-effect-approval": return `${actorName} approved a restore that changes how content is kept or shared`;
    case "recovery-completion": return `${actorName} updated the follow-up work of a restore`;
    case "incident-recovery": return `${actorName} updated incident recovery: ${typeof subject.transition === "string" ? words(subject.transition).toLowerCase() : "a change"}`;
    case "incident-recovery-check": return "KEEL checked a restore for malicious items left behind";
    case "fidelity-drill": return typeof subject.resourceType === "string"
      ? `A test restore of a ${resourceTypeLabel(subject.resourceType)} was measured`
      : "A test restore was measured";
    case "recovery-drill": return subject.mode === "live"
      ? `A recovery drill on a test group ${subject.outcome === "passed" ? "passed" : "did not pass"}${subject.cleanup && (subject.cleanup as { status?: unknown }).status !== "complete" ? ", and its clean-up failed" : ""}`
      : "A recovery drill plan was checked; this is not a drill";
    case "offsite-copy": return (subject.verification as { ok?: unknown } | undefined)?.ok === true && subject.remoteSha256 === subject.dumpSha256
      ? "An off-site copy of the backups was checked byte for byte"
      : "An off-site copy of the backups failed its check and does not count";
    case "job.started": return `${actorName} started ${anAction(subject.kind)}`;
    case "collection.completed": return typeof subject.items === "number"
      ? `A backup of ${plural(Number(subject.types ?? 0), "type")} finished with ${plural(subject.items, "item")}`
      : "A backup finished";
    case "baseline-resnapshot": return `${actorName} re-captured an approved setup from a newer backup`;
    case "benchmark-evaluation": return typeof subject.verdict === "string"
      ? `A control check ${subject.verdict === "pass" ? "passed" : subject.verdict === "fail" ? "failed" : "could not decide"}`
      : "A control check ran";
    case "people-anonymity": return subject.enabled === true
      ? `${actorName} turned on "Hide people's names"`
      : `${actorName} turned off "Hide people's names", so names show again`;
    case "benchmark-exception": return `${actorName} ${subject.action === "revoke" || subject.revokedAt ? "withdrew" : "granted"} an exception to a control`;
    default: return `${actorName}: ${displayEnum("eventKind", entry.kind).toLowerCase()}`;
  }
}

export function timeAgo(value: string | null | undefined, now: string): string {
  return ago(value ?? null, now);
}
