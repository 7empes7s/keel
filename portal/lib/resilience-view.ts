import type { VerdictTone } from "@/components/verdict";
import { ago, formatTimestamp, resourceTypeLabel, words } from "@/lib/presentation";
import type { StorageResidency } from "@/lib/types";

// Roadmap task-73: the Resilience page in words. The numbers come from
// engine/coverage/recoveryMetrics.mjs; this file only turns them into sentences.
// "Not measured" is a state of its own and is never shown as zero, as good, or
// replaced by the configured schedule.

export type MeasuredState = "measured" | "gaps" | "unmeasured";

export interface DependencyRef {
  key: string;
  // type and relationship: the Entra ID and Intune settings backup. workload: a service
  // settings read (Exchange, SharePoint, Teams, Purview, Power Platform). content: a
  // content backup (mail, files, sites, Teams, Planner).
  kind: "type" | "relationship" | "workload" | "content";
  type: string | null;
  parentType: string | null;
  family: string | null;
  workload?: string | null;
}

/** One service-settings or content workload's backups (engine/coverage/serviceBackups.mjs). */
export interface ServiceBackup {
  kind: "service-settings" | "content";
  workload: string;
  name: string;
  service: string | null;
  switchedOn: boolean;
  latest: { id: string; outcome: string; at: string | null; reasons?: string[]; namePrefix?: string | null } | null;
  lastGood: { id: string; from: string | null; at: string | null; settings?: number; items?: number; bytes?: number; outcome?: string } | null;
  stored?: { items: number; versions: number; containers: number; bytes: number; storedBytes: number; newestAt: string | null } | null;
}

export interface OffsiteCopy {
  recordedAt: string | null;
  shippedAt: string | null;
  dumpSha256: string | null;
  manifestGeneratedAt: string | null;
  seq: string | null;
  counts: boolean;
  reason: string;
  point: string | null;
  missing: string[];
}

export interface RecoveryAttempt {
  source: "drill" | "restore";
  ref: string | null;
  at: string | null;
  counts: boolean;
  reason: string;
  elapsedMs: number | null;
  outcome: string | null;
}

export interface RecoveryMetrics {
  version: number;
  tenantRef: string;
  generatedAt: string;
  freshness: {
    state: MeasuredState;
    achievedRpoMs: number | null;
    oldestDependency: (DependencyRef & { ageMs: number; since: string }) | null;
    gaps: (DependencyRef & { lastAttempt: { at: string | null; outcome: string | null } | null })[];
    latestFailures: (DependencyRef & { failedAt: string | null; outcome: string | null; lastSuccessAt: string })[];
    /** Types the tenant has no licence or feature for; absent on reports before it existed. */
    notUsed?: (DependencyRef & { checkedAt: string | null })[];
    required: number;
  };
  recoverablePoint: {
    state: "measured" | "unmeasured";
    point: string | null;
    ageMs: number | null;
    fromCopy: OffsiteCopy | null;
    latestCopy: OffsiteCopy | null;
    copies: OffsiteCopy[];
    // The settings an off-site copy is checked for: the Entra ID and Intune backup only.
    scope?: string;
  };
  services?: { settings: ServiceBackup[]; content: ServiceBackup[] };
  recoveryTime: {
    state: "measured" | "unmeasured";
    samples: number;
    latestMs: number | null;
    latestAt: string | null;
    worstMs: number | null;
    medianMs: number | null;
    lastAttempt: RecoveryAttempt | null;
    attempts: RecoveryAttempt[];
  };
  readiness: {
    state: "unmeasured" | "drilled" | "attention";
    countedDrills: number;
    lastCountedDrill: { at: string; elapsedMs: number; objects: string[] } | null;
    notCounted: { at: string; reason: string }[];
    cleanupFailures: { at: string; objects: string[]; residuals: unknown[] }[];
    scope: string;
  };
  configured: {
    cadence: { id: string; jobKind: string; tier: string | null; cadence: { every?: string; n?: number; atTime?: string | null } | null; cron: string | null; enabled: boolean }[];
    objectives: null;
  };
}

export interface IncidentPointSummary {
  incident: { id: string; title: string; status: string; openedAt: string | null };
  recommended: { snapshotId: string; collectedAt: string | null } | null;
  pins: number;
}

export interface ResilienceData {
  generatedAt: string;
  metrics: RecoveryMetrics;
  incidents: IncidentPointSummary[];
  storage: StorageResidency;
}

/** A duration in words: "8 minutes", "2 hours 5 minutes", "3 days". */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "not measured";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

function capitalize(text: string): string {
  return text.replace(/^./, (character) => character.toUpperCase());
}

/** A required item by name: "Conditional Access policy", "Members of each group". */
export function dependencyName(dependency: DependencyRef | string): string {
  const ref = typeof dependency === "string" ? parseDependencyKey(dependency) : dependency;
  if (ref.kind === "relationship") {
    return `${capitalize(words(ref.family).toLowerCase())} of each ${resourceTypeLabel(ref.parentType ?? "")}`;
  }
  if (ref.kind === "workload") return `${capitalize(resourceTypeLabel(ref.workload ?? ""))} settings`;
  if (ref.kind === "content") return `${CONTENT_NAMES[ref.workload ?? ""] ?? capitalize(words(ref.workload ?? "").toLowerCase())} (content)`;
  return capitalize(resourceTypeLabel(ref.type ?? ""));
}

// Content workloads as Microsoft names them (engine/coverage/serviceBackups.mjs).
const CONTENT_NAMES: Record<string, string> = {
  "exchange-mail": "Mail, calendars and contacts",
  "group-conversations": "Group conversations",
  onedrive: "OneDrive files",
  sharepoint: "SharePoint document libraries",
  "sharepoint-sites": "SharePoint sites, lists and files",
  teams: "Teams, channels and tabs",
  planner: "Planner plans and tasks",
};

function parseDependencyKey(key: string): DependencyRef {
  if (key.startsWith("workload:") || key.startsWith("content:")) {
    const kind = key.startsWith("workload:") ? "workload" : "content";
    return { key, kind, type: null, parentType: null, family: null, workload: key.slice(kind.length + 1) };
  }
  if (key.startsWith("relationship:")) {
    const [parentType, family] = key.slice("relationship:".length).split("/");
    return { key, kind: "relationship", type: null, parentType: parentType ?? null, family: family ?? null };
  }
  return { key, kind: "type", type: key.replace(/^type:/, ""), parentType: null, family: null };
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length > 3) return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const OFFSITE_REASONS: Record<string, string> = {
  "manifest-not-verified": "its files did not match its recovery manifest",
  "remote-checksum-mismatch": "the copy on the off-site host did not match the original",
  "shipped-at-missing": "its record does not say when it was sent",
  "no-observations": "its record lists no backups",
  malformed: "its record is unreadable",
  "nothing-required": "nothing was required of it",
};

/** Why an off-site copy does not count, as a sentence fragment. */
export function offsiteReason(copy: OffsiteCopy): string {
  if (copy.reason === "missing-required-observation") {
    return `it holds no good backup of ${list(copy.missing.map((key) => dependencyName(key)))}`;
  }
  return OFFSITE_REASONS[copy.reason] ?? "its check did not pass";
}

const ATTEMPT_REASONS: Record<string, string> = {
  "outcome-failed": "it failed",
  "outcome-exceeded-bound": "it ran past its time limit",
  "outcome-cleanup-failed": "it left test objects behind",
  "exceeded-bound": "it ran past its time limit",
  "offline-validation": "it was a plan check, not a drill",
  "cleanup-failed": "it left test objects behind",
  "unbounded-scope": "it was not limited to test objects",
  "elapsed-not-observed": "its timing was not observed",
  "timing-not-observed": "its timing was not observed",
  "restore-failed": "it failed",
  "restore-cancelled": "it was cancelled",
  "awaiting-verification": "its follow-up checks are still open",
  malformed: "its record is unreadable",
};

export function attemptName(attempt: RecoveryAttempt): string {
  return attempt.source === "drill" ? "Recovery drill" : "Restore";
}

/** Why a drill or restore is not a recovery time sample, as a sentence fragment. */
export function attemptReason(attempt: RecoveryAttempt): string {
  return ATTEMPT_REASONS[attempt.reason] ?? "it was not completed and checked";
}

const STORAGE_SENTENCES: Record<string, string> = {
  unsupported: "Backups are kept where they can be deleted; this storage cannot lock them.",
  unknown: "Storage that cannot be deleted is not yet proven on this tenant.",
  "fixture-tested": "Storage that cannot be deleted is not yet proven on this tenant.",
  "live-qualified": "Backups are in storage proven on this tenant to refuse deletion.",
};

export function storageSentence(storage: StorageResidency): string {
  if (!storage.configured) return "KEEL does not know where backups are stored, so it cannot say whether they can be deleted.";
  return STORAGE_SENTENCES[storage.immutability] ?? STORAGE_SENTENCES.unknown;
}

const EVERY_WORDS: Record<string, string> = { hour: "hour", day: "day", week: "week" };

/** Configured cadence in words, labelled as a plan by the caller. */
export function cadenceSentence(entry: RecoveryMetrics["configured"]["cadence"][number]): string {
  const what = entry.jobKind === "offsite"
    ? "Off-site copy"
    : `${entry.tier ? `Tier ${entry.tier.replace(/^tier/, "")} ` : ""}backup`;
  if (!entry.enabled) return `${what}: turned off`;
  if (entry.cron) return `${what}: on a custom timetable`;
  const every = EVERY_WORDS[entry.cadence?.every ?? ""];
  if (!every) return `${what}: timetable unknown`;
  const n = entry.cadence?.n ?? 1;
  const at = entry.cadence?.atTime ? ` at ${entry.cadence.atTime} UTC` : "";
  return `${what}: every ${n === 1 ? every : `${n} ${every}s`}${at}`;
}

export interface ResilienceVerdict {
  text: string;
  tone: VerdictTone;
  headline: string;
}

/** The page's one sentence. An unmeasured value is said to be unmeasured. */
export function resilienceVerdict(metrics: RecoveryMetrics, now: string): ResilienceVerdict {
  if (metrics.readiness.state === "attention") {
    return {
      tone: "critical",
      headline: "Test objects left behind",
      text: "A recovery drill left test objects in the tenant. Remove them before trusting the next drill.",
    };
  }
  const point = metrics.recoverablePoint;
  const time = metrics.recoveryTime;
  if (point.state !== "measured" || point.point === null) {
    return {
      tone: "attention",
      headline: "Recovery point not measured",
      text: time.state === "measured"
        ? "No checked off-site copy holds every backed-up type, so the recovery point is not measured."
        : "Recovery is not measured yet: no checked off-site copy holds every backed-up type, and no recovery has been timed.",
    };
  }
  if (time.state !== "measured") {
    return {
      tone: "attention",
      headline: `Recoverable to ${ago(point.point, now)}`,
      text: `If this server were lost, KEEL could recover settings as of ${ago(point.point, now)}. Recovery time is not measured yet.`,
    };
  }
  return {
    tone: "good",
    headline: `Recoverable to ${ago(point.point, now)}`,
    text: `If this server were lost, KEEL could recover settings as of ${ago(point.point, now)}. The last proven recovery took ${formatDuration(time.latestMs)}.`,
  };
}

/** The freshness card's sentence. */
export function freshnessSentence(metrics: RecoveryMetrics): string {
  const freshness = metrics.freshness;
  if (freshness.state === "measured" && freshness.oldestDependency) {
    return `The oldest good backup KEEL relies on is ${formatDuration(freshness.achievedRpoMs)} old: ${dependencyName(freshness.oldestDependency)}.`;
  }
  if (freshness.state === "gaps") {
    const count = freshness.gaps.length;
    return `Not measured: ${count} required item${count === 1 ? " has" : "s have"} never been backed up successfully.`;
  }
  return "Not measured: KEEL has no successful backup to measure from yet.";
}

/** The lead-in to the types left out because this tenant does not use them. */
export function notUsedSentence(metrics: RecoveryMetrics): string | null {
  const notUsed = metrics.freshness.notUsed ?? [];
  if (!notUsed.length) return null;
  return notUsed.length === 1
    ? "1 type is not used in this tenant, which has no licence or feature for it, so it is not counted:"
    : `${notUsed.length} types are not used in this tenant, which has no licence or feature for them, so they are not counted:`;
}

export function recoverablePointSentence(metrics: RecoveryMetrics, now: string): string {
  const point = metrics.recoverablePoint;
  if (point.state === "measured" && point.point) {
    return `The newest complete off-site copy recovers settings as collected ${ago(point.point, now)}.`;
  }
  if (point.copies.length === 0) return "Not measured: no off-site copy has been recorded and checked yet.";
  return "Not measured: no off-site copy has passed its check with a good backup of everything required.";
}

/** Bytes in words: "7.4 MB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "unknown size";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** One service backup's line: when it last backed up well, and what that holds. */
export function serviceBackupSentence(entry: ServiceBackup, now: string): string {
  if (!entry.switchedOn) return "Switched off until a live check on this tenant passes.";
  const holds = entry.kind === "content"
    ? (entry.stored ? ` Holds ${entry.stored.items} item${entry.stored.items === 1 ? "" : "s"} (${formatBytes(entry.stored.bytes)}).` : "")
    : (typeof entry.lastGood?.settings === "number" ? ` ${entry.lastGood.settings} setting${entry.lastGood.settings === 1 ? "" : "s"} read.` : "");
  const scope = entry.kind === "content" && entry.latest?.namePrefix ? ` Limited to names starting ${entry.latest.namePrefix}.` : "";
  if (!entry.lastGood) {
    return entry.latest ? `Never backed up successfully; the latest try ${entry.latest.outcome === "partial" ? "stopped part way" : "failed"}.${holds}${scope}` : `No backup run recorded yet.${holds}${scope}`;
  }
  const failedSince = entry.latest && entry.latest.id !== entry.lastGood.id ? " The latest try failed." : "";
  return `Last good backup ${ago(entry.lastGood.at, now)}.${failedSince}${holds}${scope}`;
}

/** The services card's sentence. */
export function servicesSentence(metrics: RecoveryMetrics): string {
  const all = [...(metrics.services?.settings ?? []), ...(metrics.services?.content ?? [])];
  if (all.length === 0) return "Only the Entra ID and Intune settings backup has run so far.";
  const on = all.filter((entry) => entry.switchedOn);
  const good = on.filter((entry) => entry.lastGood);
  return `${good.length} of ${on.length} service backups beyond Entra ID and Intune have a good copy; each counts toward the age above.`;
}

export function recoveryTimeSentence(metrics: RecoveryMetrics): string {
  const time = metrics.recoveryTime;
  if (time.state !== "measured") return "Not measured: no drill or restore has finished and been checked yet.";
  const from = `${time.samples} checked recover${time.samples === 1 ? "y" : "ies"}`;
  if (time.samples === 1) return `The one checked recovery took ${formatDuration(time.latestMs)}.`;
  return `The last checked recovery took ${formatDuration(time.latestMs)}; the slowest of ${from} took ${formatDuration(time.worstMs)}.`;
}

export function readinessSentence(metrics: RecoveryMetrics, now: string): string {
  const readiness = metrics.readiness;
  if (readiness.state === "attention") {
    return `${readiness.cleanupFailures.length} drill${readiness.cleanupFailures.length === 1 ? "" : "s"} left test objects in the tenant.`;
  }
  if (readiness.state === "drilled" && readiness.lastCountedDrill) {
    return `The last recovery drill on a test group passed ${ago(readiness.lastCountedDrill.at, now)} and cleaned up after itself.`;
  }
  return "Not measured: no recovery drill has run on this tenant yet.";
}

export function incidentSentence(summary: IncidentPointSummary, now: string): string {
  const pins = summary.pins ? ` ${summary.pins} snapshot${summary.pins === 1 ? " is" : "s are"} kept from clean-up.` : "";
  if (!summary.recommended) return `No snapshot has been cleared for this incident yet.${pins}`;
  return `Restore from the snapshot collected ${ago(summary.recommended.collectedAt, now)}, which an investigator cleared.${pins}`;
}

export { formatTimestamp };
