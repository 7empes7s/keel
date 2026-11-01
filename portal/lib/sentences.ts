// Roadmap task-130 (portal experience contract, identification rules): the generated
// names and status sentences of objects that have no name column of their own — jobs,
// approval requests, audit-record entries — built from their own fields and the
// references the engine resolved. One module, so every page says the same thing the
// same way. Raw codes and ids never appear in these strings; they live in the record.
import type { UnnamedReference } from "@/lib/app-names";
import { ago, displayEnum, formatTimestamp, resourceLabel, resourceTypeLabel, words } from "@/lib/presentation";
import { WORKLOAD_LABELS, workloadLabel } from "@/lib/compare-view";
import { holdsObjectId, jobIncompleteTypes, type NamedKeys, namedResource } from "@/lib/job-names";
import { RESTORE_APPROVAL_RULE_INFO, isRestoreApprovalRule } from "@/lib/restore-approval-rules";
import { serviceFor } from "@/lib/services";

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
  // What it points to that no backup names, each with a lookup link (filled in by the page).
  unnamedRefs?: UnnamedReference[];
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
  // A restore approved as it was made, because restore approvals are off for its services.
  "restore-approval-setting": "Keel (restore approvals are off)",
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
  ["onedrive", "OneDrive"], ["power-platform", "Power Platform"], ["defender", "Defender"],
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
  if (first?.naturalKey) return `${count}, including ${resourceLabel(first.naturalKey)}`;
  // No name and no readable key: say what kind of setting it is, so two such requests
  // do not read the same.
  const typed = known.find((change) => change.resourceType && !holdsObjectId(change.resourceType));
  return typed?.resourceType ? `${count}, including an unnamed ${resourceTypeLabel(typed.resourceType)}` : count;
}

// A service setting change by its setting's name and service, never by an id.
function serviceChangePhrase(params: Record<string, unknown>): string {
  const key = typeof params.resourceKey === "string" && !holdsObjectId(params.resourceKey) ? resourceLabel(params.resourceKey) : null;
  const service = typeof params.workload === "string" ? WORKLOAD_LABELS[params.workload] ?? null : null;
  const verb = params.changeType === "added" ? "new" : params.changeType === "removed" ? "removed" : "changed";
  if (key) return `the ${verb} setting ${key}${service ? ` in ${service}` : ""}`;
  return service ? `a ${verb} ${service} setting` : "a service setting change";
}

// Audit run 2, finding 3: an accept or ignore that needs approval, as what it does:
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

// What each guarded action does, as a verb phrase that follows "to": "started to run a
// backup", "was not allowed to view the audit log", "a request to roll back changes".
// Keyed by the action name the portal records (lib/action.ts GuardSpec.action) and the
// job kind an approval request names. Every one must be here (test/audit-sentences.test.ts).
export const ACTION_PHRASES: Record<string, string> = {
  // Backups
  collect: "back up every configuration type",
  backup: "run a backup",
  "content-collect": "back up mail, files and Teams content",
  "workload-collect": "back up Exchange, SharePoint, OneDrive, Teams, Purview and Power Platform settings",
  discover: "check what the tenant holds",
  prune: "clean up old backups",
  offsite: "copy the backups off-site",
  "schedules:list": "view backup schedules",
  "schedules:update": "change a backup schedule",
  "jobs:list": "view jobs",
  "jobs:show": "open a job",
  // Restores
  restore: "restore from a backup",
  "restore-dry-run": "preview a restore",
  "restore:dry-run": "preview a restore",
  "restore:dry-run-show": "open a restore preview",
  "restore:selection-preview": "preview what a restore would include",
  "restore:workload-choices": "view what can be restored in another Microsoft 365 service",
  "restore:workload-dry-run": "preview a restore of another Microsoft 365 service",
  "restore:compensate": "undo a restore",
  "restore-completion": "update the follow-up steps of a restore",
  "restore:completion-show": "view the follow-up steps of a restore",
  "restore-content-effects-approve": "approve a restore that changes how content is kept or shared",
  "incident-recovery": "update incident recovery",
  // Changes and roll backs
  remediate: "roll back changes",
  "remediate:selection-preview": "preview a roll back",
  dispose: "accept or ignore a change",
  "drift-detect": "check for changes",
  "api-drift": "check Microsoft's APIs for changes",
  "change-intents:list": "view emergency changes",
  "change-intents:approve": "approve an emergency change",
  "change-intents:revoke": "end an emergency change",
  // Approved setups
  "baseline-create": "create an approved setup",
  "baseline-activate": "switch to another approved setup",
  "baseline-reinstate": "put back an earlier approved setup",
  // Approvals
  "approvals:approve": "approve a request",
  "approvals:reject": "reject a request",
  "approval-mode:read": "view the approval mode",
  "approval-mode:update": "change the approval mode",
  "restore-approvals:read": "view the restore approval settings",
  "restore-approvals:update": "change the restore approval settings",
  // Automatic rules
  "policy-evaluate": "run the automatic rules",
  "policies:list": "view automatic rules",
  "policies:show": "open an automatic rule",
  "policies:create": "create an automatic rule",
  "policies:edit": "edit an automatic rule",
  "policies:delete": "delete an automatic rule",
  "policies:enabled": "turn an automatic rule on or off",
  "policies:clear-pause": "resume a paused automatic rule",
  "policies:activation-preview": "preview turning on an automatic rule",
  "policies:activate": "turn on an automatic rule",
  // Compliance
  "compliance:check": "run the compliance checks",
  "compliance:fix": "fix a failing compliance check",
  "compliance:exception": "grant or withdraw an exception to a control",
  "compliance:own-check": "add a compliance check of their own",
  "compliance:own-check-remove": "remove a compliance check of their own",
  "compliance:scuba-list": "change a ScubaGear list",
  // Alerts and notifications
  "alerts:list": "view alerts",
  "alert-respond": "respond to an alert",
  "alert-mute": "mute an alert",
  notify: "send a notification",
  "channels:list": "view notification channels",
  "channels:create": "add a notification channel",
  "channels:test": "send a test notification",
  "channels:enable": "turn on a notification channel",
  "channels:disable": "turn off a notification channel",
  "subscriptions:list": "view notification subscriptions",
  "subscriptions:create": "add a notification subscription",
  "subscriptions:update": "change a notification subscription",
  "subscriptions:delete": "remove a notification subscription",
  "deliveries:list": "view sent notifications",
  "escalation-rules:list": "view escalation rules",
  "escalation-rules:create": "add an escalation rule",
  "escalation-rules:enable": "turn on an escalation rule",
  "escalation-rules:disable": "turn off an escalation rule",
  // Integrations
  "integrations:list": "view integrations",
  "integrations:register": "connect an integration",
  "integrations:revoke": "disconnect an integration",
  "integrations:resume": "reconnect an integration",
  "integrations:replay": "send held integration messages again",
  "integrations:quarantined": "view held integration messages",
  "integrations:servicenow": "view the ServiceNow connection",
  "integrations:servicenow:configure": "change the ServiceNow connection",
  // People, access and Keel itself
  "principals:list": "view people",
  "principals:create": "add a person",
  "principals:grant": "give a person a role",
  "principals:revoke": "take a role away from a person",
  "principals:disable": "turn off a person's Keel account",
  "principals:enable": "turn on a person's Keel account",
  "anonymity:read": "view the \"Hide people's names\" setting",
  "anonymity:update": "change the \"Hide people's names\" setting",
  breakglass: "update an emergency access account",
  "evidence:list": "view the audit log",
  "evidence:verify": "check that the audit log has not been changed",
  setup: "change Keel's setup",
  "setup:show": "view Keel's setup",
};

/** "run a backup": what an action does, never its code. */
export function actionPhrase(action: unknown): string {
  if (typeof action !== "string" || !action) return "take an action";
  return ACTION_PHRASES[action] ?? ACTION_PHRASES[action.replace(/:.*/, "")] ?? "take an action";
}

interface EvidenceLike {
  kind: string;
  actor: string;
  subject: unknown;
}

type Subject = Record<string, unknown>;
type SentenceOf = (subject: Subject, actorName: string, names: NamedKeys) => string;

const SELF_APPROVED = " they asked for themselves (self-approved: approval mode is Solo)";

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const quoted = (value: unknown): string => {
  const note = text(value);
  return note ? `: “${note.length > 140 ? `${note.slice(0, 139)}…` : note}”` : "";
};
const resourceOf = (subject: Subject, names: NamedKeys): string | null => {
  const key = text(subject.naturalKey);
  return key ? namedResource(key, names, text(subject.resourceType)) : null;
};
const adapterName = (value: unknown): string => (value === "servicenow" || value == null ? "ServiceNow" : words(String(value)));
const accountLabel = (subject: Subject): string | null => {
  const label = text(subject.label);
  return label && !holdsObjectId(label) && !EMAIL.test(label) ? label : null;
};

const REFUSAL_WORDS: Record<string, string> = {
  "no-principal": "no account was signed in",
  capability: "their role does not allow it",
};

// What became of a restore of another Microsoft 365 service, after "which".
const WORKLOAD_RESTORE_OUTCOMES: Record<string, string> = {
  verified: "finished and was checked afterwards",
  applied: "finished",
  partial: "finished in part",
  "no-change": "found nothing to change",
  refused: "was refused",
  failed: "failed",
  "verification-failed": "was sent but could not be checked afterwards",
  stale: "stopped because the settings changed since the preview",
  disabled: "was skipped because writing to it is turned off",
  "blocked-content-effect": "is waiting for approval because it changes how content is kept or shared",
};

const WORKLOAD_SERVICE_NAMES: Record<string, string> = {
  exchange: "Exchange mailbox settings", teams: "Teams settings", sharepoint: "SharePoint organization settings",
};

function workloadRestoreSubject(subject: Subject): string {
  const workload = text(subject.workload) ?? text(subject.operationId)?.split(".")[0] ?? null;
  if (!workload) return "another Microsoft 365 service";
  return WORKLOAD_SERVICE_NAMES[workload] ?? workloadSubject(workload);
}

// The ServiceNow bridge's answer to a callback, after "Keel".
const ITSM_CALLBACK_OUTCOMES: Record<string, string> = {
  applied: "applied the decision",
  "already-decided": "ignored it because the request was already decided",
  conflict: "kept its own decision because the two disagree",
  "ignored-status": "ignored it because it was not a decision",
  "not-decidable": "could not apply it because the request cannot be decided that way",
  "stale-plan": "refused it because the restore plan changed since it was sent",
  "stale-version": "refused it because a newer version of the request was sent",
  "unknown-record": "refused it because it does not match any request Keel sent",
  "unmapped-identity": "refused it because the ServiceNow user is not linked to a Keel account",
  "refused-expired": "refused it because the request had expired",
  "refused-invalidated": "refused it because the request was no longer valid",
  "refused-job-conflict": "refused it because the same work is already running",
  "refused-not-eligible": "refused it because that person may not decide this request",
  "refused-promotion": "refused it because the preview could not be turned into a restore",
  "refused-reason-required": "refused it because a rejection needs a reason",
  "refused-self-approval": "refused it because people cannot approve their own requests",
};

const ACTIVATION_REFUSALS: Record<string, string> = {
  "preview-not-found": "its preview was not found",
  "preview-expired": "its preview had expired",
  "preview-blocked": "something blocks it",
};

const CHANGE_INTENT_ENDINGS: Record<string, string> = {
  "matches-baseline": "; it matches the approved setup again",
  drifted: "; it still differs from the approved setup",
  ignored: "; it still differs, and that difference is ignored",
  "awaiting-detection": "; the next change check will compare it with the approved setup",
};

const APPROVAL_CLASS_WORDS: Record<string, string> = {
  "content-restore-other-location": "restores of content to another location",
  "bulk-restore": "large restores",
  delete: "restores that delete items",
  "retention-shortening": "restores that shorten how long content is kept",
  "legal-hold-release": "restores that release a legal hold",
};

const BREAKGLASS_SENTENCES: Record<string, SentenceOf> = {
  "breakglass.registered": (s, actor) => {
    const label = accountLabel(s);
    return label ? `${actor} added “${label}” as an emergency access account` : `${actor} added an emergency access account`;
  },
  "breakglass.retired": (s, actor) => `${actor} stopped treating an account as an emergency access account${quoted(s.reason)}`,
  "breakglass.validated": (s, actor) => `${actor} recorded a sign-in test of an emergency access account`,
  "breakglass.credential-rotated": (s, actor) => `${actor} recorded a password change of an emergency access account`,
  "breakglass.methods-attested": (s, actor) => `${actor} confirmed the sign-in methods of an emergency access account`,
};

/**
 * One plain sentence for each kind of audit-record entry the engine, the portal and the
 * tools write. A new kind needs a line here; test/audit-sentences.test.ts fails on any
 * kind written anywhere that has none.
 */
const EVIDENCE_SENTENCES: Record<string, SentenceOf> = {
  // Approvals
  "approval-request": (s, actor) => `${actor} asked for approval to ${actionPhrase(s.action)}`,
  "approval-decision": (s, actor) => {
    const request = `a request to ${actionPhrase(s.action)}`;
    if (s.decision === "superseded") return `A newer request replaced ${request}, so it was closed`;
    const rejected = /^reject/.test(String(s.decision ?? "")) || s.status === "rejected";
    const own = !rejected && s.selfApproved === true ? SELF_APPROVED : "";
    return `${actor} ${rejected ? "rejected" : "approved"} ${typeof s.action === "string" ? request : "a request"}${own}${rejected ? quoted(s.reason) : ""}`;
  },
  "approval-signoff": (s, actor) => `${actor} signed off ${typeof s.action === "string" ? `a request to ${actionPhrase(s.action)}` : "a request"}; another approval is still needed`,
  "approval.decided": (_s, actor) => `${actor} decided an approval`,
  "approval-mode": (s, actor) => s.mode === "solo"
    ? `${actor} switched approval mode to Solo, so the person who asks can approve their own requests. They confirmed the risk warning`
    : `${actor} switched approval mode to Two people, so someone other than the person who asked approves`,
  "approval-policy": (s, actor) => {
    const what = APPROVAL_CLASS_WORDS[String(s.actionClass)] ?? "a kind of restore";
    return s.twoPerson === true ? `${actor} made ${what} need two approvers` : `${actor} made ${what} need one approver`;
  },
  "action-attempt": (s, actor) => {
    const what = actionPhrase(s.action);
    if (s.decision !== "denied") return `${actor} started to ${what}`;
    const reason = typeof s.reason === "string" ? REFUSAL_WORDS[s.reason] : undefined;
    return `${actor} was not allowed to ${what}${reason ? `: ${reason}` : ""}`;
  },
  "restore-approval-setting": (s, actor) => {
    if (isRestoreApprovalRule(s.rule)) {
      const kind = RESTORE_APPROVAL_RULE_INFO[s.rule].phrase;
      return s.approvalRequired === false
        ? `${actor} turned off restore approvals for ${kind}, so they no longer wait for a person${s.highRisk === true ? ". This is high risk; they confirmed the risk warning" : ""}`
        : `${actor} turned on restore approvals for ${kind}`;
    }
    const service = typeof s.service === "string" ? serviceFor(s.service).name : "a service";
    return s.approvalRequired === false
      ? `${actor} turned off restore approvals for ${service}, so its high-impact restore changes no longer wait for approval`
      : `${actor} turned on restore approvals for ${service}`;
  },
  "content-effect-approval": (s, actor) => `${actor} approved a restore that changes how content is kept or shared${s.selfApproved === true ? SELF_APPROVED : ""}`,
  // ServiceNow
  "itsm-mirror": (s, actor) => {
    const service = adapterName(s.adapter);
    switch (s.outcome) {
      case "identity-mapped": return `${actor} linked a ${service} user to a Keel account`;
      case "replanned": return `An updated approval request was sent to ${service}, replacing the earlier one`;
      case "intent-mirrored": return `An emergency change was sent to ${service} for approval`;
      case "decision-recorded": return `Keel sent the decision (${s.decision === "rejected" ? "rejected" : "approved"}) back to ${service}`;
      default: return `An approval request was sent to ${service}`;
    }
  },
  "itsm-callback": (s) => `${adapterName(s.adapter)} sent an approval update, and Keel ${ITSM_CALLBACK_OUTCOMES[String(s.outcome)] ?? "recorded it"}`,
  "itsm-decision-conflict": (s) => `${adapterName(s.adapter)} sent a decision that differs from the one already made in Keel; Keel kept its own (${s.canonicalOutcome === "rejected" ? "rejected" : "approved"})`,
  "itsm-adapter-config": (s, actor) => {
    const problems = Array.isArray(s.problems) ? s.problems.length : 0;
    return s.enabled === true || problems === 0
      ? `${actor} saved the ${adapterName(s.adapter)} connection settings`
      : `${actor} saved the ${adapterName(s.adapter)} connection settings; ${problems === 1 ? "1 problem stops" : `${problems} problems stop`} it working`;
  },
  // Changes, approved setups and roll backs
  disposition: (s, actor, names) => {
    const verb = s.action === "ignore" ? "ignored" : "accepted";
    const into = s.action === "ignore" ? "" : " into the approved setup";
    if (typeof s.serviceChangeId === "string" || typeof s.workload === "string") return `${actor} ${verb} ${serviceChangePhrase(s)}${into}${quoted(s.reason)}`;
    const resource = resourceOf(s, names);
    return `${actor} ${verb} ${resource ? `a change to ${resource}` : "a change"}${into}${quoted(s.reason)}`;
  },
  "baseline-resnapshot": (_s, actor) => `${actor} re-captured an approved setup from a newer backup`,
  "baseline-reinstate": (s, actor) => typeof s.reinstatedVersion === "number"
    ? `${actor} put back version ${s.reinstatedVersion} of the approved setup${typeof s.version === "number" ? `; it is now in use as version ${s.version}` : ""}${quoted(s.reason)}`
    : `${actor} put back an earlier version of the approved setup${quoted(s.reason)}`,
  "change-intent": (s, actor, names) => {
    const resource = resourceOf(s, names);
    const change = `an emergency change${resource ? ` to ${resource}` : ""}`;
    if (s.outcome === "revoked") return `${actor} ended ${change} early${quoted(s.reason)}`;
    if (s.outcome === "settled") return `${capitalFirst(change)} ended${CHANGE_INTENT_ENDINGS[String(s.currentState)] ?? ""}`;
    return `${actor} approved ${change}${s.selfApproved === true ? SELF_APPROVED : ""}`;
  },
  "automation-execution": (s) => `Automation ${s.outcome === "executed" ? "rolled back a change" : "tried to roll back a change"}`,
  // Automatic rules
  "policy-evaluation": (s, _actor, names) => {
    const resource = resourceOf(s, names);
    return resource ? `Policies checked a change to ${resource}${s.matched ? ", and one applied" : ""}` : "Policies checked a change";
  },
  "policy-change": (s, actor) => {
    const rule = text(s.name) ? `the automatic rule “${text(s.name)}”` : "an automatic rule";
    if (s.change === "deleted") return `${actor} deleted ${rule}`;
    const fields = Array.isArray(s.fields) ? s.fields as { field?: unknown }[] : [];
    const turnedOff = fields.some((entry) => entry?.field === "enabled");
    // Counted as the panel lists them: the limit's count and window are one setting.
    const changed = new Set(fields.map((entry) => (entry?.field === "windowSeconds" ? "maxActionsPerWindow" : entry?.field))).size;
    return `${actor} edited ${rule}: ${changed} ${changed === 1 ? "setting" : "settings"} changed${turnedOff ? "; it stays off until it is previewed again" : ""}`;
  },
  "policy-activation-preview": (s, actor) => {
    const matched = typeof s.matched === "number" ? `; it would act on ${plural(s.matched, "open change")}` : "";
    const blockers = Array.isArray(s.blockers) ? s.blockers.length : 0;
    return `${actor} previewed turning on an automatic rule${matched}${s.verdict === "blocked" || blockers > 0 ? `, but ${blockers === 1 ? "1 thing blocks" : `${Math.max(blockers, 1)} things block`} it` : ""}`;
  },
  "policy-activation": (s, actor) => s.outcome === "refused"
    ? `${actor} could not turn on an automatic rule: ${ACTIVATION_REFUSALS[String(s.code)] ?? "Keel refused it"}`
    : `${actor} turned on an automatic rule; each roll back it queues is checked again before it runs`,
  // Compliance
  "benchmark-evaluation": (s) => typeof s.verdict === "string"
    ? `A control check ${s.verdict === "pass" ? "passed" : s.verdict === "fail" ? "failed" : "could not decide"}`
    : "A control check ran",
  "benchmark-exception": (s, actor) => `${actor} ${s.action === "revoke" || s.revokedAt ? "withdrew" : "granted"} an exception to a control`,
  "compliance-own-check": (s, actor) => {
    const name = text(s.name) ? `the compliance check “${text(s.name)}”` : "a compliance check of their own";
    return `${actor} ${s.action === "removed" ? "removed" : "added"} ${name}`;
  },
  "scuba-config-list": (s, actor) => {
    const list = s.list === "sensitive-users" ? "sensitive users" : s.list === "partner-domains" ? "partner domains" : "a ScubaGear list";
    const count = typeof s.count === "number" ? s.count : null;
    if (count === 0) return `${actor} cleared the ScubaGear list of ${list}`;
    return `${actor} set the ScubaGear list of ${list}${count === null ? "" : ` to ${count} ${count === 1 ? "entry" : "entries"}`}`;
  },
  // Restores and recovery
  "workload-restore": (s, actor) => `${actor} ran a restore of ${workloadRestoreSubject(s)}, which ${WORKLOAD_RESTORE_OUTCOMES[String(s.outcome)] ?? "ended"}`,
  "recovery-completion": (_s, actor) => `${actor} updated the follow-up steps of a restore`,
  "incident-recovery": (s, actor) => `${actor} updated incident recovery: ${typeof s.transition === "string" ? words(s.transition).toLowerCase() : "a change"}`,
  "incident-recovery-check": () => "Keel checked a restore for harmful items left behind",
  "fidelity-drill": (s) => typeof s.resourceType === "string"
    ? `A test restore of a ${resourceTypeLabel(s.resourceType)} was measured`
    : "A test restore was measured",
  "recovery-drill": (s) => s.mode === "live"
    ? `A recovery drill on a test group ${s.outcome === "passed" ? "passed" : "did not pass"}${s.cleanup && (s.cleanup as { status?: unknown }).status !== "complete" ? ", and its clean-up failed" : ""}`
    : "A recovery drill plan was checked; this is not a drill",
  // Backups and copies
  "job.started": (s, actor) => `${actor} started to ${actionPhrase(s.kind)}`,
  "collection.completed": (s) => typeof s.items === "number"
    ? `A backup of ${plural(Number(s.types ?? 0), "type")} finished with ${plural(s.items, "item")}`
    : "A backup finished",
  "backup-complete": () => "A backup finished",
  "offsite-copy": (s) => (s.verification as { ok?: unknown } | undefined)?.ok === true && s.remoteSha256 === s.dumpSha256
    ? "An off-site copy of the backups was checked byte for byte"
    : "An off-site copy of the backups failed its check and does not count",
  // Alerts, people and emergency access
  "alert-action": (s, actor, names) => {
    const verb = { acknowledged: "acknowledged", resolved: "resolved", muted: "muted", unmuted: "unmuted" }[String(s.action)] ?? "changed";
    const about = text(s.naturalKey) ? ` about ${namedResource(String(s.naturalKey), names)}` : "";
    return `${actor} ${verb} an alert${about}${quoted(s.note)}`;
  },
  "people-anonymity": (s, actor) => s.enabled === true
    ? `${actor} turned on "Hide people's names"`
    : `${actor} turned off "Hide people's names", so names show again`,
  ...BREAKGLASS_SENTENCES,
};

/** Every audit-record kind that has a sentence of its own. */
export const EVIDENCE_SENTENCE_KINDS: readonly string[] = Object.keys(EVIDENCE_SENTENCES);

function capitalFirst(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/** An audit-record entry as a sentence: who did what, naming objects by their saved name. */
export function evidenceSentence(entry: EvidenceLike, actorName: string, names: NamedKeys = {}): string {
  const subject = (entry.subject && typeof entry.subject === "object" ? entry.subject : {}) as Subject;
  const sentence = EVIDENCE_SENTENCES[entry.kind];
  // A kind with no sentence yet (the test stops one from shipping) still reads as words.
  return sentence ? sentence(subject, actorName, names) : `${actorName} recorded an entry of a kind Keel does not describe yet`;
}

export function timeAgo(value: string | null | undefined, now: string): string {
  return ago(value ?? null, now);
}
