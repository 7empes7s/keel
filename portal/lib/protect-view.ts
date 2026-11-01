// Roadmap task-131: the Protect page in words. Pure helpers shared by the server page,
// the client components and the UI harness, so every surface words a type, a tier and
// a schedule the same way. Codes stay in the record layer (components/coverage-report).
import { ago, displayEnum, formatTimestamp, fromNow, resourceTypeLabel } from "@/lib/presentation";
import type { Schedule } from "@/lib/schedules";
import type { CoverageData, CoverageSummary, CoverageType, RestoreProofSummary, WriteOperationCapability } from "@/lib/types";
import {
  hasRestoreWriter as engineHasRestoreWriter,
  provenAt as engineProvenAt,
  restoreProof as engineRestoreProof,
  restoreProofSummary,
} from "../../engine/coverage/restoreProof.mjs";

export type RestoreProof = "proven" | "tested" | "untested" | "none";

/** When a live test restore last proved the kind; null when it is not proven. */
export function provenAt(item: CoverageType): string | null {
  return engineProvenAt(item);
}

export const TIERS = [
  { id: "tier1", label: "Tier 1", description: "the critical settings, backed up most often" },
  { id: "tier2", label: "Tier 2", description: "important settings on a slower cadence" },
  { id: "tier3", label: "Tier 3", description: "rarely changing reference data" },
] as const;

export function tierLabel(tier: string | null | undefined): string {
  return TIERS.find((entry) => entry.id === tier)?.label ?? "Every tier";
}

/** "Conditional Access policy" → "Conditional Access policy"; "group" → "Group". */
export function typeName(type: string): string {
  const label = resourceTypeLabel(type);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// The answers the contract allows for "can Keel put this type back?". "proven" is a
// write that ran live on this tenant before any drill measured what comes back.
export type RestoreStanding = "protected" | "partial" | "proven" | "cannot-restore" | "unproven";

/**
 * Whether Keel has a tested writer for the type: an automated recovery decision and at
 * least one write operation tested on fixtures or proven live. Most types declare
 * "read-only" fidelity only because no restore drill has measured them; the writer, not
 * that declaration, is what says Keel can put the type back.
 */
export function hasRestoreWriter(item: CoverageType): boolean {
  return engineHasRestoreWriter(item);
}

/** Proven, tested on fixtures, untested or none: the one rule every "Restore proven" number counts. */
export function restoreProof(item: CoverageType): RestoreProof {
  return engineRestoreProof(item) as RestoreProof;
}

/** The "Restore proven" count for a set of kinds; the Overview reads the same function. */
export function restoreProofCounts(types: readonly CoverageType[]): RestoreProofSummary {
  return restoreProofSummary(types) as RestoreProofSummary;
}

export function restoreStanding(item: CoverageType): RestoreStanding {
  const proof = restoreProof(item);
  if (proof === "none") return "cannot-restore";
  if (item.fidelity.measured) return item.fidelity.measured === "full" && item.fidelity.declared === "full" ? "protected" : "partial";
  return proof === "proven" ? "proven" : "unproven";
}

export const STANDING_LABEL: Record<RestoreStanding, string> = {
  protected: "Protected",
  partial: "Partially protected",
  proven: "Restore proven",
  "cannot-restore": "Cannot be restored",
  unproven: "Restore not yet proven",
};

/** One sentence: protected, partially protected, cannot be restored, or no proven restore. */
export function standingSentence(item: CoverageType): string {
  const proven = item.fidelity.verifiedAt ? formatTimestamp(item.fidelity.verifiedAt).replace(/,.*$/, "") : null;
  switch (restoreStanding(item)) {
    case "protected":
      return `Protected: restore proven on this tenant on ${proven ?? "a recorded date"}.`;
    case "partial":
      return `Partially protected: some fields Microsoft sets itself and Keel cannot restore${proven ? `; restore proven on ${proven}` : ""}.`;
    case "proven": {
      const at = provenAt(item);
      return `Restore proven on this tenant by a live run${at ? ` on ${liveDate(at)}` : ""}. No restore drill has yet measured every field that comes back.`;
    }
    case "unproven":
      if (restoreProof(item) === "tested") {
        return item.fidelity.declared === "partial"
          ? "Backed up, but some fields cannot be restored. Keel's restore passes its tests but has not yet been proven on this tenant."
          : "Backed up. Keel's restore passes its tests but has not yet been proven on this tenant.";
      }
      return item.fidelity.declared === "partial"
        ? "Backed up, but some fields cannot be restored, and no restore has been proven on this tenant yet."
        : "Backed up, but no restore has been proven on this tenant yet.";
    case "cannot-restore":
      if (item.protectionState === "not-covered" || !item.adapter) return "Keel has no collector for this type, so it is neither backed up nor restorable.";
      if (item.outcome === "unavailable") return "Nothing to restore: this tenant does not have the licence or feature Microsoft needs for this type.";
      if (item.protectionState === "unprotectable" || item.fidelity.declared === "unprotectable") return "Keel cannot restore this type: Microsoft manages it, so it is kept for reference only.";
      return "Keel backs this type up for reference but cannot restore it.";
  }
}

export type BackupHealth = "ok" | "empty" | "partial" | "failed" | "stale" | "never" | "not-collected" | "unavailable";

export function backupHealth(item: CoverageType): BackupHealth {
  if (item.protectionState === "not-covered" || !item.adapter) return "not-collected";
  // Microsoft refused the read for a missing licence or tenant feature (#309): not a failure.
  if (item.outcome === "unavailable") return "unavailable";
  // Only part of the type could be read: its own amber "Partly done", never "Failed"
  // (decision 31 Oct 2026). Some items are backed up; the rest are missing.
  if (item.outcome === "partial") return "partial";
  if (item.protectionState === "failed" || item.outcome === "failed") return "failed";
  if (item.reportStatus === "never-collected" || !item.lastCollectedAt) return "never";
  if (item.stale) return "stale";
  return item.outcome === "complete-empty" || item.itemCount === 0 ? "empty" : "ok";
}

function items(count: number | null): string {
  if (count === null) return "";
  return `, ${count.toLocaleString("en-GB")} ${count === 1 ? "setting" : "settings"}`;
}

/** What's protected lists every service: the Microsoft 365 workloads join the Entra ID
 * and Intune types, so the tiles, the verdict, the service cards and the list agree. */
export function withWorkloadKinds(data: CoverageData): CoverageData {
  return data.workloads?.length ? { ...data, types: [...data.types, ...data.workloads] } : data;
}

/** The last backup of one type, in words. */
export function backupSentence(item: CoverageType, now: string): string {
  switch (backupHealth(item)) {
    case "not-collected": return item.type.includes("-")
      // A workload (exchange-mail-flow…) ships switched off for each tenant.
      ? "Not backed up yet: Keel switches this on for your tenant once a live read from it is checked."
      : "Not backed up: no collector exists for this type yet.";
    case "unavailable": return "Not available on this tenant: Microsoft needs a licence or tenant feature this tenant does not have.";
    case "never": return item.outcome === "not-requested" ? "Not part of the latest backup run." : "Never backed up yet.";
    case "partial":
      return `Partly done: the last backup read only part of this type${item.itemCount === null ? "" : ` (${item.itemCount.toLocaleString("en-GB")} settings seen)`}, so some settings are missing.`;
    case "failed":
      return `The last backup failed${item.lastCollectedAt ? ` ${ago(item.lastCollectedAt, now)}` : ""}.`;
    case "stale": return `Out of date: last backed up ${ago(item.lastCollectedAt, now)}, longer ago than its tier allows.`;
    case "empty": return `Backed up ${ago(item.lastCollectedAt, now)} with no settings; an empty result counts as a successful backup.`;
    case "ok": return `Backed up ${ago(item.lastCollectedAt, now)}${items(item.itemCount)}.`;
  }
}

const OPERATION_WORDS: Record<string, string> = {
  update: "update in place",
  create: "recreate when deleted",
  delete: "remove what was added",
  "restore-soft-deleted": "bring back from deleted items",
};

function liveDate(value: string | null): string {
  return value ? formatTimestamp(value).replace(/,? \d{2}:\d{2} UTC$/, "") : "";
}

function proofWords(capability: WriteOperationCapability): string {
  const record = capability.liveRecord ?? null;
  if (capability.claim === "live-qualified") {
    return record?.live && record.observedAt
      ? `proven on this tenant by a live run on ${liveDate(record.observedAt)}, valid until ${liveDate(record.expiresAt)}`
      : "proven on this tenant";
  }
  if (capability.claim === "fixture-tested") {
    // Gap P2: a committed live record that does not count says why.
    return record && !record.live && record.reason
      ? `tested, not yet proven on this tenant (a live run was recorded but does not count: ${record.reason})`
      : "tested, not yet proven on this tenant";
  }
  if (capability.claim === "declared") return "declared, not yet tested";
  if (capability.claim === "unsupported") return "not supported";
  return "unknown";
}

/** What Keel can do to put a type back, one line per supported operation. */
export function restoreOperations(item: CoverageType): string[] {
  if (!item.writeCapability) return [];
  return Object.entries(item.writeCapability.operations)
    .filter(([, capability]) => capability.claim !== "unsupported")
    .map(([operation, capability]) => `Can ${OPERATION_WORDS[operation] ?? operation.replaceAll("-", " ")}: ${proofWords(capability)}.`);
}

/** Gap P2: one line per committed workload live record, saying whether it counts here and why not. */
export function workloadLiveLines(data: CoverageData): string[] {
  return (data.liveEvidence?.workloads ?? []).map((record) => record.live
    ? `${record.label}: proven on this tenant by a live run on ${liveDate(record.observedAt)}, valid until ${liveDate(record.expiresAt)}.`
    : `${record.label}: not proven on this tenant. A live run was recorded but does not count: ${record.reason ?? "it did not pass its checks"}.`);
}

const andList = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * One note for every workload live record, so the top of the page carries one
 * "proven on this tenant" line, not one per record. `lines` (dates and reasons) sit
 * behind a click.
 */
export function workloadLiveNote(data: CoverageData): { summary: string; lines: string[] } | null {
  const records = data.liveEvidence?.workloads ?? [];
  if (!records.length) return null;
  const live = records.filter((record) => record.live).map((record) => record.label);
  const waiting = records.filter((record) => !record.live).map((record) => record.label);
  const parts: string[] = [];
  if (live.length) parts.push(`Restore proven on this tenant by a live run: ${andList(live)}.`);
  if (waiting.length) {
    parts.push(`${live.length ? "Not proven yet" : "Restore not proven on this tenant yet"}: ${andList(waiting)}. ${waiting.length === 1 ? "Its live run does" : "Their live runs do"} not count yet.`);
  }
  return { summary: parts.join(" "), lines: workloadLiveLines(data) };
}

/** The recovery decision and whether references are rewritten when an ID changes. */
export function recoveryDecisionSentence(item: CoverageType): string | null {
  const decision = item.qualification;
  if (!decision) return null;
  const remaps = Object.entries(decision.remapping);
  const remapping = remaps.length === 0 ? ""
    : remaps.every(([, proven]) => proven) ? " If it comes back with a new ID, Keel updates what refers to it."
      : " If it would come back with a new ID, Keel stops rather than leave broken references.";
  if (decision.decision === "automated") return `Keel restores this type on its own.${remapping}`;
  if (decision.decision === "manual") return "Restoring this type is a manual step; Keel lists it for you to do by hand.";
  return "Whether Keel can restore this type on its own is not yet decided.";
}

export interface ProtectProblem {
  type: string;
  name: string;
  health: BackupHealth;
  sentence: string;
  tier: string | null;
}

/** Failed, partly done, out-of-date and never-backed-up types, by name, worst first. */
export function protectProblems(data: CoverageData, now: string): ProtectProblem[] {
  const order: BackupHealth[] = ["failed", "partial", "stale", "never"];
  return data.types
    .filter((item) => order.includes(backupHealth(item)))
    .sort((a, b) => order.indexOf(backupHealth(a)) - order.indexOf(backupHealth(b)) || a.type.localeCompare(b.type))
    .map((item) => ({ type: item.type, name: typeName(item.type), health: backupHealth(item), sentence: backupSentence(item, now), tier: item.criticality }));
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The page verdict: "All 52 configuration types were backed up in the last 6 hours." */
export function protectVerdict(data: CoverageData, now: string): { text: string; tone: "good" | "attention" | "critical" } {
  const health = data.types.map(backupHealth);
  const failed = health.filter((value) => value === "failed").length;
  const partial = health.filter((value) => value === "partial").length;
  const stale = health.filter((value) => value === "stale").length;
  const never = health.filter((value) => value === "never").length;
  if (failed) {
    const also = partial ? ` ${plural(partial, "more was", "more were")} only partly backed up.` : "";
    return { text: `${plural(failed, "type", "types")} failed ${failed === 1 ? "its" : "their"} last backup.${also}`, tone: "critical" };
  }
  if (partial) return { text: `${plural(partial, "type was", "types were")} only partly backed up: some settings are missing.`, tone: "attention" };
  if (stale) return { text: `${plural(stale, "type has", "types have")} not been backed up recently enough.`, tone: "attention" };
  if (never) return { text: `${plural(never, "type has", "types have")} never been backed up.`, tone: "attention" };
  const collected = data.types.filter((item) => item.lastCollectedAt && backupHealth(item) !== "unavailable");
  if (collected.length === 0) return { text: "Nothing has been backed up yet.", tone: "attention" };
  const oldest = Math.min(...collected.map((item) => new Date(item.lastCollectedAt!).valueOf()));
  const hours = Math.max(1, Math.ceil((new Date(now).valueOf() - oldest) / 3_600_000));
  const window = hours < 48 ? plural(hours, "hour", "hours") : plural(Math.ceil(hours / 24), "day", "days");
  const subject = collected.length === 1 ? "The one setting type was" : `All ${collected.length} setting types were`;
  return { text: `${subject} backed up in the last ${window}.`, tone: "good" };
}

// Schedules, in words. The job-kind code and any cron expression stay in the record.
export function scheduleName(schedule: Pick<Schedule, "job_kind" | "tier">): string {
  if ((schedule.job_kind === "collect" || schedule.job_kind === "backup") && schedule.tier) return `Backup of ${tierLabel(schedule.tier)}`;
  return displayEnum("jobKind", schedule.job_kind);
}

export function cadenceSentence(schedule: Pick<Schedule, "cadence" | "cron_override">): string {
  if (schedule.cron_override !== null) return "On a custom timetable";
  const { n, every, atTime } = schedule.cadence;
  const unit = n === 1 ? `Every ${every}` : `Every ${n} ${every}s`;
  if (!atTime) return unit;
  return every === "hour" ? `${unit}, at ${atTime.slice(3)} minutes past (UTC)` : `${unit} at ${atTime} UTC`;
}

export function lastRunSentence(schedule: Pick<Schedule, "last_status" | "last_run_at">, now: string): string {
  if (!schedule.last_status || !schedule.last_run_at) return "Has not run yet.";
  if (schedule.last_status === "failed") return `Last run failed ${ago(schedule.last_run_at, now)}.`;
  if (schedule.last_status === "partial") return `Last run partly done ${ago(schedule.last_run_at, now)}: some types were not backed up.`;
  if (schedule.last_status === "running" || schedule.last_status === "queued") return `Running now, started ${ago(schedule.last_run_at, now)}.`;
  return `Last run ${displayEnum("jobStatus", schedule.last_status).toLowerCase()} ${ago(schedule.last_run_at, now)}.`;
}

export function nextRunSentence(schedule: Pick<Schedule, "enabled" | "next_due_at">, now: string): string {
  if (!schedule.enabled) return "Turned off.";
  const due = fromNow(schedule.next_due_at, now);
  return due === "already passed" ? "Next run is due now." : `Next run ${due}.`;
}

/** A tier's backup that is waiting for a worker or running now, on demand or scheduled. */
export interface ActiveTierRun {
  jobId: string;
  status: "queued" | "running";
  since: string | null;
}

export type ActiveTierRuns = Record<string, ActiveTierRun>;

/** Each tier's queued or running backup, from recent jobs. A running job wins over a
 *  queued one; otherwise the oldest, which is the one the server hands back to a second
 *  press. */
// Matches engine/jobs/queue.mjs ORPHANED_HEARTBEAT_STALE_MS: a running job whose worker
// has not checked in for this long died, and does not hold its tier's buttons off.
const STALE_HEARTBEAT_MS = 120_000;

export function activeTierRuns(jobs: { id: string; kind: string; status: string; params: unknown; createdAt: string | null; startedAt: string | null; heartbeatAt?: string | null }[], now?: string): ActiveTierRuns {
  const runs: ActiveTierRuns = {};
  const ordered = [...jobs].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  for (const job of ordered) {
    if (job.kind !== "backup" && job.kind !== "collect") continue;
    if (job.status !== "queued" && job.status !== "running") continue;
    if (job.status === "running" && now && (!job.heartbeatAt || new Date(now).valueOf() - new Date(job.heartbeatAt).valueOf() > STALE_HEARTBEAT_MS)) continue;
    const tier = (job.params as { tier?: unknown } | null)?.tier;
    if (typeof tier !== "string") continue;
    const current = runs[tier];
    if (current && (current.status === "running" || job.status === "queued")) continue;
    runs[tier] = { jobId: job.id, status: job.status, since: job.status === "running" ? job.startedAt ?? job.createdAt : job.createdAt };
  }
  return runs;
}

/** The card's line for a run in progress. */
export function activeRunSentence(run: ActiveTierRun, now: string): string {
  // A run queued after the page was read is "just now", never "in the future".
  const at = run.since && new Date(run.since).valueOf() > new Date(now).valueOf() ? now : run.since;
  if (!at) return run.status === "running" ? "Running now." : "Queued; it starts when a worker is free.";
  return run.status === "running"
    ? `Running now, started ${ago(at, now)}.`
    : `Queued ${ago(at, now)}; it starts when a worker is free.`;
}

export interface TierSummary {
  id: string;
  label: string;
  description: string;
  schedule: Schedule | null;
  next: string;
  last: string;
  failed: boolean;
  // The last run finished but some types were not read in full: a warning, not fine.
  partial: boolean;
  // A backup of this tier that is queued or running right now.
  active?: ActiveTierRun | null;
}

/** One card per tier: when it runs next, how its last run ended, and any run in progress. */
export function tierSummaries(schedules: Schedule[], now: string, active: ActiveTierRuns = {}): TierSummary[] {
  return TIERS.map((tier) => {
    const schedule = schedules.find((entry) => (entry.job_kind === "collect" || entry.job_kind === "backup") && entry.tier === tier.id) ?? null;
    const run = active[tier.id] ?? null;
    // While a run is in progress the schedule's own "Running now" line would repeat it.
    const scheduleRunning = schedule?.last_status === "running" || schedule?.last_status === "queued";
    return {
      id: tier.id, label: tier.label, description: tier.description, schedule,
      next: schedule ? nextRunSentence(schedule, now) : "No schedule; back it up on demand.",
      last: schedule && !(run && scheduleRunning) ? lastRunSentence(schedule, now) : "",
      failed: schedule?.last_status === "failed",
      partial: schedule?.last_status === "partial",
      active: run,
    };
  });
}

// The What's protected page (portal audit: grouped list on a desktop, service cards on a phone).
// Health in four words a tile and a badge can share; tones are risk colours only.
export type HealthTile = "backed-up" | "failed" | "partial" | "out-of-date" | "proven";
// Filters with no tile of their own: the parts the sum line under the tiles counts, which
// Overview's ring and banner link to ("Not backed up by Keel yet", "Not on this tenant").
export type HealthLink = "not-backed-up" | "not-on-tenant";
export type HealthFilter = HealthTile | HealthLink;

export const HEALTH_TILE_KEYS: HealthTile[] = ["backed-up", "failed", "partial", "out-of-date", "proven"];
export const HEALTH_LINK_KEYS: HealthLink[] = ["not-backed-up", "not-on-tenant"];
export const HEALTH_FILTERS: HealthFilter[] = [...HEALTH_TILE_KEYS, ...HEALTH_LINK_KEYS];

export function isHealthFilter(value: string): value is HealthFilter {
  return (HEALTH_FILTERS as string[]).includes(value);
}

export function matchesHealth(item: CoverageType, filter: HealthFilter): boolean {
  const health = backupHealth(item);
  switch (filter) {
    case "backed-up": return health === "ok" || health === "empty";
    case "failed": return health === "failed";
    case "partial": return health === "partial";
    case "out-of-date": return health === "stale" || health === "never";
    // The coverage buckets' notCollected and unavailable (coverageBuckets below).
    case "not-backed-up": return health === "not-collected";
    case "not-on-tenant": return health === "unavailable";
    case "proven": return restoreProof(item) === "proven";
  }
}

export type HealthTone = "urgent" | "soon" | "fine" | "neutral";

export const HEALTH_BADGE: Record<BackupHealth, { label: string; tone: HealthTone }> = {
  ok: { label: "Backed up", tone: "fine" },
  empty: { label: "Backed up", tone: "fine" },
  failed: { label: "Failed", tone: "urgent" },
  partial: { label: "Partly done", tone: "soon" },
  stale: { label: "Out of date", tone: "soon" },
  never: { label: "Never backed up", tone: "soon" },
  "not-collected": { label: "Not backed up", tone: "neutral" },
  unavailable: { label: "Not on this tenant", tone: "neutral" },
};

/** The list's risk colour for one kind: failures are urgent, out of date or never is soon. */
export function healthRisk(item: CoverageType): "urgent" | "soon" | undefined {
  const tone = HEALTH_BADGE[backupHealth(item)].tone;
  return tone === "urgent" || tone === "soon" ? tone : undefined;
}

/**
 * The one coverage count (audit 31 Oct 2026, metrics 3 and 4). Every kind lands in exactly
 * one bucket by its backupHealth, so the buckets add up to the total. A kind whose last
 * read was only partly done is its own "partial" bucket, never failed. Overview, the menu badge, What's protected
 * and Setup all count with this, from the same kinds (withWorkloadKinds).
 */
export interface CoverageBuckets {
  total: number;
  backedUp: number;
  failed: number;
  // Only part of the kind was read: amber "Partly done", never counted as failed.
  partial: number;
  stale: number;
  never: number;
  // No collector yet, or a workload not switched on for this tenant.
  notCollected: number;
  // Microsoft refused the read for a missing licence or tenant feature.
  unavailable: number;
}

export function coverageBuckets(types: readonly CoverageType[]): CoverageBuckets {
  const buckets: CoverageBuckets = { total: types.length, backedUp: 0, failed: 0, partial: 0, stale: 0, never: 0, notCollected: 0, unavailable: 0 };
  for (const item of types) {
    switch (backupHealth(item)) {
      case "ok": case "empty": buckets.backedUp += 1; break;
      case "failed": buckets.failed += 1; break;
      case "partial": buckets.partial += 1; break;
      case "stale": buckets.stale += 1; break;
      case "never": buckets.never += 1; break;
      case "not-collected": buckets.notCollected += 1; break;
      case "unavailable": buckets.unavailable += 1; break;
    }
  }
  return buckets;
}

/** The buckets in the Overview's summary shape (lib/types.ts CoverageSummary). */
export function coverageSummary(types: readonly CoverageType[]): CoverageSummary {
  const buckets = coverageBuckets(types);
  return {
    covered: buckets.backedUp,
    failed: buckets.failed,
    partial: buckets.partial,
    stale: buckets.stale,
    neverCollected: buckets.never,
    notCovered: buckets.notCollected,
    unavailable: buckets.unavailable,
    total: buckets.total,
  };
}

/** "203 kinds: 190 backed up, 2 failed, 2 partly done, 3 out of date or never, 5 not backed up by Keel yet, 1 not on this tenant." */
export function coverageSentence(summary: CoverageSummary): string {
  const late = summary.stale + summary.neverCollected;
  const parts = [
    `${summary.covered.toLocaleString("en-GB")} backed up`,
    ...(summary.failed ? [`${summary.failed.toLocaleString("en-GB")} failed`] : []),
    ...(summary.partial ? [`${summary.partial.toLocaleString("en-GB")} partly done`] : []),
    ...(late ? [`${late.toLocaleString("en-GB")} out of date or never`] : []),
    ...(summary.notCovered ? [`${summary.notCovered.toLocaleString("en-GB")} not backed up by Keel yet`] : []),
    ...(summary.unavailable ? [`${summary.unavailable.toLocaleString("en-GB")} not on this tenant`] : []),
  ];
  return `${plural(summary.total, "type", "types")}: ${listWords(parts)}.`;
}

export interface ProtectCounts extends CoverageBuckets {
  // From restoreProofCounts, so What's protected, Setup and the Overview agree.
  proven: number;
  tested: number;
  restorable: number;
}

export function protectCounts(types: CoverageType[]): ProtectCounts {
  const proof = restoreProofCounts(types);
  return {
    ...coverageBuckets(types),
    proven: proof.proven,
    tested: proof.tested,
    restorable: proof.restorable,
  };
}

export interface BackupPlan {
  tiers: string[];
  // Kinds with no tier: no tier run reads them, so the plan leaves them out and says so.
  untiered: number;
}

/** Which tier runs back up the chosen kinds: one run per distinct tier, in tier order. */
export function backupPlan(types: CoverageType[]): BackupPlan {
  const chosen = new Set(types.map((item) => item.criticality).filter((tier): tier is string => Boolean(tier)));
  return {
    tiers: TIERS.map((tier) => tier.id).filter((tier) => chosen.has(tier)),
    untiered: types.filter((item) => !item.criticality || !TIERS.some((tier) => tier.id === item.criticality)).length,
  };
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "Runs Tier 1 and Tier 2 in full. It only reads your tenant." */
export function backupPlanSentence(plan: BackupPlan): string {
  if (plan.tiers.length === 0) return "None of these types is in a backup tier, so there is nothing to run.";
  const runs = `Runs ${listWords(plan.tiers.map(tierLabel))} in full. It only reads your tenant.`;
  if (!plan.untiered) return runs;
  return `${runs} ${plan.untiered === 1 ? "1 type has" : `${plan.untiered} types have`} no tier and ${plan.untiered === 1 ? "is" : "are"} left out.`;
}

/** The verdict's second line: where the problems are, or when everything last ran. */
export function protectVerdictDetail(types: CoverageType[], serviceOf: (type: string) => string, now: string): string | undefined {
  const problems = types.filter((item) => ["failed", "partial", "stale", "never"].includes(backupHealth(item)));
  if (problems.length === 0) return undefined;
  const services = [...new Set(problems.map((item) => serviceOf(item.type)))];
  const fine = types.filter((item) => backupHealth(item) === "ok" || backupHealth(item) === "empty");
  const newest = fine.map((item) => item.lastCollectedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  return `In ${listWords(services)}.${newest ? ` Everything else was backed up ${ago(newest, now)}.` : ""}`;
}

/** Under a filtered verdict: which filters it counts, and every service's totals, so a
 * filter never hides failures elsewhere.
 * "Counts follow your filter: In Intune. Across all services: 11 of 15 kinds backed up, 2 failed, 1 partly done, 2 out of date or never." */
export function protectScopeDetail(filters: string[], types: CoverageType[]): string {
  const counts = protectCounts(types);
  const late = counts.stale + counts.never;
  const parts = [
    `${counts.backedUp} of ${plural(counts.total, "setting type", "setting types")} backed up`,
    ...(counts.failed ? [`${counts.failed} failed`] : []),
    ...(counts.partial ? [`${counts.partial} partly done`] : []),
    ...(late ? [`${late} out of date or never`] : []),
  ];
  return `Counts follow your ${filters.length === 1 ? "filter" : "filters"}: ${filters.join(", ")}. Across all services: ${parts.join(", ")}.`;
}

/** The header's status pill: failures first, then partly done, then out of date, else backed up. */
export function protectStatus(data: CoverageData): { tone: "urgent" | "soon" | "fine"; label: string } {
  const counts = protectCounts(data.types);
  if (counts.failed) return { tone: "urgent", label: `${counts.failed} failed` };
  if (counts.partial) return { tone: "soon", label: `${counts.partial} partly done` };
  if (counts.stale + counts.never) return { tone: "soon", label: `${counts.stale + counts.never} out of date` };
  return { tone: "fine", label: "Backed up" };
}
