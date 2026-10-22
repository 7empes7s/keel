import type { IconName } from "@/components/shell/icons";
import type { VerdictTone } from "@/components/verdict";
import { ago, formatTimestamp, resourceTypeLabel, words } from "@/lib/presentation";
import { serviceFor, serviceOrder, type CloudService } from "@/lib/services";
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

// Tiers in plain words; the tier number stays in brackets so it matches Schedules.
const TIER_WORDS: Record<string, string> = {
  tier1: "Critical settings (tier 1)",
  tier2: "Important settings (tier 2)",
  tier3: "Rarely changing settings (tier 3)",
};

const EVERY_WORDS: Record<string, string> = { hour: "hour", day: "day", week: "week" };

/** Configured cadence in words, labelled as a plan by the caller. */
export function cadenceSentence(entry: RecoveryMetrics["configured"]["cadence"][number]): string {
  const what = entry.jobKind === "offsite"
    ? "Off-site copy"
    : TIER_WORDS[entry.tier ?? ""] ?? "Settings backup";
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
    return `Not measured: ${count} setting type${count === 1 ? " has" : "s have"} never been backed up.`;
  }
  return "Not measured: no backup has finished yet.";
}

export function recoverablePointSentence(metrics: RecoveryMetrics, now: string): string {
  const point = metrics.recoverablePoint;
  if (point.state === "measured" && point.point) {
    return `The newest checked off-site copy holds settings from ${ago(point.point, now)}.`;
  }
  if (point.copies.length === 0) return "Not measured: no off-site copy has been checked yet.";
  return "Not measured: no off-site copy holds a good backup of everything.";
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
  if (time.state !== "measured") return "Not measured: no restore or drill has been timed yet.";
  const from = `${time.samples} checked recover${time.samples === 1 ? "y" : "ies"}`;
  if (time.samples === 1) return `The one checked recovery took ${formatDuration(time.latestMs)}.`;
  return `Last checked recovery: ${formatDuration(time.latestMs)}. Slowest of ${from}: ${formatDuration(time.worstMs)}.`;
}

export function readinessSentence(metrics: RecoveryMetrics, now: string): string {
  const readiness = metrics.readiness;
  if (readiness.state === "attention") {
    return `${readiness.cleanupFailures.length} drill${readiness.cleanupFailures.length === 1 ? "" : "s"} left test objects in the tenant.`;
  }
  if (readiness.state === "drilled" && readiness.lastCountedDrill) {
    return `Passed ${ago(readiness.lastCountedDrill.at, now)} and cleaned up after itself.`;
  }
  return "Not measured: no drill has run on this tenant yet.";
}

export function incidentSentence(summary: IncidentPointSummary, now: string): string {
  const pins = summary.pins ? ` ${summary.pins} snapshot${summary.pins === 1 ? " is" : "s are"} kept from clean-up.` : "";
  if (!summary.recommended) return `No snapshot has been cleared for this incident yet.${pins}`;
  return `Restore from the snapshot collected ${ago(summary.recommended.collectedAt, now)}, which an investigator cleared.${pins}`;
}

export { formatTimestamp };

// --- The page at a glance (Resilience redesign) ---------------------------------
// What needs the reader first, as alerts with one line on what to do; four tiles;
// and one row per service backup. Words only: the component lays them out.

export type ResilienceTone = "urgent" | "soon" | "low" | "fine" | "neutral";

export interface ResilienceAlert {
  key: string;
  tone: "urgent" | "soon" | "low";
  icon: IconName;
  title: string;
  todo: string;
  // Error specifics, shown only when the reader asks for them.
  more: string[];
  action: { label: string; href: string } | null;
}

const TONE_RANK: Record<ResilienceAlert["tone"], number> = { urgent: 0, soon: 1, low: 2 };

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One row per service backup beyond Entra ID and Intune, with a plain state. */
export interface ServiceRow {
  key: string;
  name: string;
  what: "Settings" | "Content";
  tone: ResilienceTone;
  status: string;
  last: string;
  holds: string;
}

export interface ServiceGroup {
  key: string;
  name: string;
  icon: IconName;
  rows: ServiceRow[];
}

const STALE_MS = 48 * 3_600_000;

function age(at: string | null | undefined, now: string): number {
  if (!at) return Number.POSITIVE_INFINITY;
  const ms = new Date(now).valueOf() - new Date(at).valueOf();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** A service backup's state in two words and a tone. */
export function serviceState(entry: ServiceBackup, now: string): { tone: ResilienceTone; status: string } {
  if (!entry.switchedOn) return { tone: "neutral", status: "Switched off" };
  if (!entry.lastGood) return entry.latest ? { tone: "urgent", status: "Never worked" } : { tone: "soon", status: "Not run yet" };
  if (entry.latest && entry.latest.id !== entry.lastGood.id) {
    return { tone: "soon", status: entry.latest.outcome === "partial" ? "Last try incomplete" : "Last try failed" };
  }
  if (age(entry.lastGood.at, now) > STALE_MS) return { tone: "soon", status: "Out of date" };
  return { tone: "fine", status: "Backed up" };
}

function holdsWords(entry: ServiceBackup): string {
  if (entry.kind === "content") {
    return entry.stored ? `${entry.stored.items.toLocaleString("en-GB")} item${entry.stored.items === 1 ? "" : "s"}, ${formatBytes(entry.stored.bytes)}` : "";
  }
  return typeof entry.lastGood?.settings === "number" ? plural(entry.lastGood.settings, "setting") : "";
}

/** The Entra ID and Intune settings backup as one row, from the freshness numbers. */
function entraRow(metrics: RecoveryMetrics, now: string): ServiceRow {
  const freshness = metrics.freshness;
  const base = { key: "entra-intune", name: "Users, groups, sign-in rules, devices and apps", what: "Settings" as const, holds: plural(freshness.required, "setting type") };
  if (freshness.gaps.length) {
    return { ...base, tone: "urgent", status: `${freshness.gaps.length} never backed up`, last: freshness.oldestDependency ? ago(freshness.oldestDependency.since, now) : "Never" };
  }
  if (freshness.latestFailures.length) {
    return { ...base, tone: "soon", status: `${freshness.latestFailures.length} failed last time`, last: freshness.oldestDependency ? ago(freshness.oldestDependency.since, now) : "Never" };
  }
  if (freshness.state === "measured" && freshness.oldestDependency) {
    const stale = (freshness.achievedRpoMs ?? 0) > STALE_MS;
    return { ...base, tone: stale ? "soon" : "fine", status: stale ? "Out of date" : "Backed up", last: ago(freshness.oldestDependency.since, now) };
  }
  return { ...base, tone: "soon", status: "Not run yet", last: "Never" };
}

/** Every backup by Microsoft service, in the portal's service order; settings before content. */
export function serviceGroups(metrics: RecoveryMetrics, now: string): ServiceGroup[] {
  const groups: ServiceGroup[] = [{ key: "entra-intune", name: "Entra ID and Intune", icon: "service-entra", rows: [entraRow(metrics, now)] }];
  const entries = [...(metrics.services?.settings ?? []), ...(metrics.services?.content ?? [])];
  const byService = new Map<string, { service: CloudService; entries: ServiceBackup[] }>();
  for (const entry of entries) {
    const service = serviceFor(entry.service);
    const bucket = byService.get(service.code) ?? { service, entries: [] };
    bucket.entries.push(entry);
    byService.set(service.code, bucket);
  }
  const ordered = [...byService.values()].sort((a, b) => serviceOrder(a.service.code) - serviceOrder(b.service.code));
  for (const { service, entries: rows } of ordered) {
    rows.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "service-settings" ? -1 : 1));
    groups.push({
      key: service.code,
      name: service.name,
      icon: service.icon,
      rows: rows.map((entry) => ({
        key: `${entry.kind}:${entry.workload}`,
        name: entry.name,
        what: entry.kind === "content" ? "Content" : "Settings",
        ...serviceState(entry, now),
        last: entry.lastGood ? ago(entry.lastGood.at, now) : "Never",
        holds: holdsWords(entry),
      })),
    });
  }
  return groups;
}

/** How many backups are good, need attention, or are switched off. */
export function serviceCounts(groups: ServiceGroup[]): { good: number; on: number; attention: number; off: number; worst: ResilienceTone } {
  const rows = groups.flatMap((group) => group.rows);
  const on = rows.filter((row) => row.tone !== "neutral");
  const worst: ResilienceTone = on.some((row) => row.tone === "urgent") ? "urgent" : on.some((row) => row.tone === "soon") ? "soon" : on.length ? "fine" : "neutral";
  return { good: on.filter((row) => row.tone === "fine").length, on: on.length, attention: on.filter((row) => row.tone !== "fine").length, off: rows.length - on.length, worst };
}

/** Everything the reader should act on or know is missing, worst first. Each says what
 * to do in one short line; error specifics wait behind a click (`more`). */
export function resilienceAlerts(data: ResilienceData): ResilienceAlert[] {
  const { metrics, generatedAt: now } = data;
  const alerts: ResilienceAlert[] = [];
  const { readiness, freshness, recoverablePoint, recoveryTime } = metrics;

  if (readiness.state === "attention") {
    const objects = readiness.cleanupFailures.flatMap((failure) => failure.objects);
    alerts.push({
      key: "drill-left-objects", tone: "urgent", icon: "alert",
      title: "A drill left test objects behind",
      todo: "Remove them before the next drill.",
      more: objects.map((key) => `Still in the tenant: ${key.split(":").slice(1).join(":") || key}`),
      action: { label: "Find them", href: "/restore" },
    });
  }

  for (const summary of data.incidents) {
    alerts.push({
      key: `incident:${summary.incident.id}`, tone: "urgent", icon: "alert",
      title: `Incident open: ${summary.incident.title}`,
      todo: summary.recommended ? `Restore only from the backup cleared ${ago(summary.recommended.collectedAt, now)}.` : "Get a backup checked before anyone restores.",
      more: [],
      action: { label: "Open incident", href: `/incidents?incident=${summary.incident.id}` },
    });
  }

  if (freshness.gaps.length) {
    const names = freshness.gaps.map((gap) => dependencyName(gap));
    alerts.push({
      key: "never-backed-up", tone: "urgent", icon: "x-circle",
      title: freshness.gaps.length === 1 ? `${names[0]} never backed up` : `${freshness.gaps.length} setting types never backed up`,
      todo: "KEEL can't restore them yet. See why on What's protected.",
      more: freshness.gaps.map((gap) => `${dependencyName(gap)}: ${gap.lastAttempt ? `last try ${gap.lastAttempt.outcome === "partial" ? "stopped part way" : "failed"} ${ago(gap.lastAttempt.at, now)}` : "never tried"}`),
      action: { label: "See failures", href: "/protect?health=failed" },
    });
  }

  if (freshness.latestFailures.length) {
    alerts.push({
      key: "latest-failed", tone: "soon", icon: "alert",
      title: freshness.latestFailures.length === 1 ? `${dependencyName(freshness.latestFailures[0])}: last backup failed` : `${freshness.latestFailures.length} setting types failed last backup`,
      todo: "Older copies are kept. Run the backup again.",
      more: freshness.latestFailures.map((failure) => `${dependencyName(failure)}: ${failure.outcome === "partial" ? "stopped part way" : "failed"} ${ago(failure.failedAt, now)}; using the copy from ${ago(failure.lastSuccessAt, now)}`),
      action: { label: "See failures", href: "/protect?health=failed" },
    });
  }

  const services = [...(metrics.services?.settings ?? []), ...(metrics.services?.content ?? [])];
  const withState = services.map((entry) => ({ entry, state: serviceState(entry, now) }));
  const pick = (status: string[]) => withState.filter(({ state }) => status.includes(state.status)).map(({ entry }) => entry);
  const broken = pick(["Never worked"]);
  if (broken.length) {
    alerts.push({
      key: "service-never-worked", tone: "urgent", icon: "x-circle",
      title: broken.length === 1 ? `${broken[0].name}: never backed up` : `${broken.length} service backups never worked`,
      todo: "No copy to restore yet. Open the failed runs.",
      more: broken.map((entry) => `${entry.name}: last try ${entry.latest?.outcome === "partial" ? "stopped part way" : "failed"} ${ago(entry.latest?.at ?? null, now)}`),
      action: { label: "See failures", href: "/activity?what=backup&outcome=failed" },
    });
  }
  const failedLast = pick(["Last try failed", "Last try incomplete"]);
  if (failedLast.length) {
    alerts.push({
      key: "service-failed-last", tone: "soon", icon: "alert",
      title: failedLast.length === 1 ? `${failedLast[0].name}: last backup failed` : `${failedLast.length} service backups failed last time`,
      todo: "Older copies are kept. Tonight's run tries again.",
      more: failedLast.map((entry) => `${entry.name}: ${entry.latest?.outcome === "partial" ? "stopped part way" : "failed"} ${ago(entry.latest?.at ?? null, now)}`),
      action: { label: "See failures", href: "/activity?what=backup&outcome=failed" },
    });
  }
  const stale = pick(["Out of date"]);
  if (stale.length) {
    alerts.push({
      key: "service-stale", tone: "soon", icon: "clock",
      title: stale.length === 1 ? `${stale[0].name}: no backup for 2+ days` : `${stale.length} backups older than 2 days`,
      todo: "Check the nightly timetable is on.",
      more: [],
      action: { label: "Timetable", href: "/schedules" },
    });
  }
  const notRun = pick(["Not run yet"]);
  if (notRun.length) {
    alerts.push({
      key: "service-not-run", tone: "low", icon: "clock",
      title: notRun.length === 1 ? `${notRun[0].name}: first backup not run yet` : `${notRun.length} backups waiting for their first run`,
      todo: "They run tonight. Nothing to do.",
      more: [],
      action: null,
    });
  }

  if (recoverablePoint.state !== "measured" || !recoverablePoint.point) {
    const newest = recoverablePoint.copies.at(-1);
    alerts.push({
      key: "no-offsite", tone: "soon", icon: "cloud",
      title: "No safe copy outside this server",
      todo: "Ask your KEEL server admin to fix the daily off-site copy.",
      more: newest ? recoverablePoint.copies.slice(-3).reverse().filter((copy) => !copy.counts).map((copy) => `Copy sent ${ago(copy.shippedAt, now)} does not count: ${offsiteReason(copy)}`) : [],
      action: { label: "Off-site copies", href: "/activity?what=copy" },
    });
  }

  const failedRestores = recoveryTime.attempts.filter((attempt) => attempt.source === "restore" && !attempt.counts && attempt.reason !== "awaiting-verification");
  const openChecks = recoveryTime.attempts.filter((attempt) => attempt.source === "restore" && attempt.reason === "awaiting-verification");
  if (failedRestores.length) {
    const newest = failedRestores.at(-1)!;
    alerts.push({
      key: "restore-failed", tone: "soon", icon: "restore",
      title: failedRestores.length === 1 ? "A restore failed" : `${failedRestores.length} restores failed`,
      todo: "Open it, see what did not go back, try again.",
      more: failedRestores.slice(-5).reverse().map((attempt) => `Restore ${ago(attempt.at, now)}: ${attemptReason(attempt)}`),
      action: newest.ref ? { label: "View restore", href: `/jobs/${newest.ref}` } : null,
    });
  }
  if (recoveryTime.state !== "measured") {
    alerts.push({
      key: "no-recovery-time", tone: "soon", icon: "clock",
      title: "Recovery time not measured",
      todo: "Restore one test setting to time it.",
      more: [],
      action: { label: "Plan a restore", href: "/restore" },
    });
  }
  if (openChecks.length) {
    const newest = openChecks.at(-1)!;
    alerts.push({
      key: "restore-checks-open", tone: "low", icon: "check-circle",
      title: openChecks.length === 1 ? "A restore needs its follow-up checks" : `${openChecks.length} restores need follow-up checks`,
      todo: "Finish the checks so they count.",
      more: [],
      action: newest.ref ? { label: "Open newest", href: `/jobs/${newest.ref}` } : null,
    });
  }

  if (readiness.state === "unmeasured") {
    alerts.push({
      key: "no-drill", tone: "soon", icon: "play",
      title: "No recovery drill yet",
      todo: "Ask your KEEL server admin to run one. It uses test objects only.",
      more: [],
      action: null,
    });
  }

  if (data.storage.immutability !== "live-qualified") {
    const unknown = !data.storage.configured;
    const unsupported = data.storage.immutability === "unsupported";
    alerts.push({
      key: "storage", tone: unknown || unsupported ? "soon" : "low", icon: "backup",
      title: unknown ? "Backup storage unknown" : unsupported ? "Backups can be deleted" : "Locked storage not proven",
      todo: unknown ? "Set the storage details on the KEEL server." : unsupported ? "Move backups to storage that blocks deletion." : "Run the locked-storage check here.",
      more: [],
      action: null,
    });
  }

  return alerts.map((alert, index) => ({ alert, index }))
    .sort((a, b) => TONE_RANK[a.alert.tone] - TONE_RANK[b.alert.tone] || a.index - b.index)
    .map(({ alert }) => alert);
}

export interface ResilienceTile {
  key: string;
  label: string;
  icon: IconName;
  value: string;
  about: string;
  tone: ResilienceTone;
  href: string;
}

/** Four tiles that answer "could we recover, and how fast". Unmeasured never reads as zero. */
export function resilienceTiles(data: ResilienceData, groups: ServiceGroup[]): ResilienceTile[] {
  const { metrics, generatedAt: now } = data;
  const point = metrics.recoverablePoint;
  const time = metrics.recoveryTime;
  const readiness = metrics.readiness;
  const counts = serviceCounts(groups);
  return [
    point.state === "measured" && point.point
      ? { key: "point", label: "Safe copy off this server", icon: "cloud", value: ago(point.point, now), about: "Anything changed after this would be lost.", tone: "fine", href: "#rs-point" }
      : { key: "point", label: "Safe copy off this server", icon: "cloud", value: "Not measured", about: "No checked copy outside this server yet.", tone: "soon", href: "#rs-point" },
    time.state === "measured"
      ? { key: "time", label: "Time to recover", icon: "restore", value: formatDuration(time.latestMs), about: time.samples > 1 ? `Last checked recovery. Slowest: ${formatDuration(time.worstMs)}.` : "The one checked recovery.", tone: "fine", href: "#rs-time" }
      : { key: "time", label: "Time to recover", icon: "restore", value: "Not measured", about: "No restore or drill has been timed yet.", tone: "soon", href: "#rs-time" },
    {
      key: "services", label: "Backups working", icon: "backup",
      value: counts.on ? `${counts.good} of ${counts.on}` : "None yet",
      about: [counts.attention ? `${counts.attention} need${counts.attention === 1 ? "s" : ""} attention` : "All working", counts.off ? `${counts.off} switched off` : ""].filter(Boolean).join(" · ") + ".",
      tone: counts.worst, href: "#rs-services",
    },
    readiness.state === "attention"
      ? { key: "drill", label: "Last drill", icon: "play", value: "Left objects", about: "Test objects are still in the tenant.", tone: "urgent", href: "#rs-drills" }
      : readiness.lastCountedDrill
        ? { key: "drill", label: "Last drill", icon: "play", value: ago(readiness.lastCountedDrill.at, now), about: "Passed and cleaned up after itself.", tone: "fine", href: "#rs-drills" }
        : { key: "drill", label: "Last drill", icon: "play", value: "None yet", about: "No drill has run on this tenant.", tone: "soon", href: "#rs-drills" },
  ];
}

/** The status pill beside the title: the worst thing on the page, in two words. */
export function resilienceStatus(metrics: RecoveryMetrics, alerts: ResilienceAlert[]): { tone: "urgent" | "soon" | "low" | "fine"; label: string } {
  if (metrics.readiness.state === "attention") return { tone: "urgent", label: "Test objects left" };
  if (alerts.some((alert) => alert.tone === "urgent")) return { tone: "urgent", label: "Needs attention" };
  if (metrics.recoverablePoint.state !== "measured") return { tone: "soon", label: "Not measured" };
  if (alerts.some((alert) => alert.tone === "soon")) return { tone: "soon", label: "Check soon" };
  return { tone: "fine", label: "Recoverable" };
}

/** The verdict's one action: jump to the alerts, which each carry their own fix. */
export function verdictAction(verdict: ResilienceVerdict, alerts: ResilienceAlert[]): { label: string; href: string } | null {
  if (verdict.tone === "good" || alerts.every((alert) => alert.tone === "low")) return null;
  return { label: "See what to fix", href: "#rs-attention" };
}

/** The page's verdict: a measured recovery still reads as "attention" while anything
 * on the page needs fixing, so the band never looks green above red alerts. */
export function pageVerdict(metrics: RecoveryMetrics, now: string, alerts: ResilienceAlert[]): ResilienceVerdict {
  const verdict = resilienceVerdict(metrics, now);
  if (verdict.tone === "good" && alerts.some((alert) => alert.tone !== "low")) return { ...verdict, tone: "attention" };
  return verdict;
}
