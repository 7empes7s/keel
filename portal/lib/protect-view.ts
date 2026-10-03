// Roadmap task-131: the Protect page in words. Pure helpers shared by the server page,
// the client components and the UI harness, so every surface words a type, a tier and
// a schedule the same way. Codes stay in the record layer (components/coverage-report).
import { ago, displayEnum, formatTimestamp, fromNow, resourceTypeLabel } from "@/lib/presentation";
import type { Schedule } from "@/lib/schedules";
import type { CoverageData, CoverageType, WriteOperationCapability } from "@/lib/types";

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

// The four answers the contract allows for "can KEEL put this type back?".
export type RestoreStanding = "protected" | "partial" | "cannot-restore" | "unproven";

export function restoreStanding(item: CoverageType): RestoreStanding {
  const declared = item.fidelity.declared;
  if (item.protectionState === "not-covered" || item.protectionState === "unprotectable"
    || item.protectionState === "read-only" || declared === "read-only" || declared === "unprotectable" || !declared) {
    return "cannot-restore";
  }
  if (!item.fidelity.measured) return "unproven";
  return item.fidelity.measured === "full" && declared === "full" ? "protected" : "partial";
}

export const STANDING_LABEL: Record<RestoreStanding, string> = {
  protected: "Protected",
  partial: "Partially protected",
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
      return `Partially protected: some fields Microsoft sets itself and KEEL cannot restore${proven ? `; restore proven on ${proven}` : ""}.`;
    case "unproven":
      return item.fidelity.declared === "partial"
        ? "Backed up, but some fields cannot be restored, and no restore has been proven on this tenant yet."
        : "Backed up, but no restore has been proven on this tenant yet.";
    case "cannot-restore":
      if (item.protectionState === "not-covered" || !item.adapter) return "KEEL has no collector for this type, so it is neither backed up nor restorable.";
      if (item.protectionState === "unprotectable" || item.fidelity.declared === "unprotectable") return "KEEL cannot restore this type: Microsoft manages it, so it is kept for reference only.";
      return "KEEL backs this type up for reference but cannot restore it.";
  }
}

export type BackupHealth = "ok" | "empty" | "failed" | "stale" | "never" | "not-collected";

export function backupHealth(item: CoverageType): BackupHealth {
  if (item.protectionState === "not-covered" || !item.adapter) return "not-collected";
  if (item.protectionState === "failed" || item.outcome === "failed" || item.outcome === "partial") return "failed";
  if (item.reportStatus === "never-collected" || !item.lastCollectedAt) return "never";
  if (item.stale) return "stale";
  return item.outcome === "complete-empty" || item.itemCount === 0 ? "empty" : "ok";
}

function items(count: number | null): string {
  if (count === null) return "";
  return `, ${count.toLocaleString("en-GB")} ${count === 1 ? "item" : "items"}`;
}

/** The last backup of one type, in words. */
export function backupSentence(item: CoverageType, now: string): string {
  switch (backupHealth(item)) {
    case "not-collected": return "Not backed up: no collector exists for this type yet.";
    case "never": return item.outcome === "not-requested" ? "Not part of the latest backup run." : "Never backed up yet.";
    case "failed":
      return item.outcome === "partial"
        ? `The last backup read only part of this type${item.itemCount === null ? "" : ` (${item.itemCount.toLocaleString("en-GB")} items seen)`}, so it counts as failed.`
        : `The last backup failed${item.lastCollectedAt ? ` ${ago(item.lastCollectedAt, now)}` : ""}.`;
    case "stale": return `Out of date: last backed up ${ago(item.lastCollectedAt, now)}, longer ago than its tier allows.`;
    case "empty": return `Backed up ${ago(item.lastCollectedAt, now)} with no items; an empty result counts as a successful backup.`;
    case "ok": return `Backed up ${ago(item.lastCollectedAt, now)}${items(item.itemCount)}.`;
  }
}

const OPERATION_WORDS: Record<string, string> = {
  update: "update in place",
  create: "recreate when deleted",
  delete: "remove what was added",
  "restore-soft-deleted": "bring back from deleted items",
};

function proofWords(capability: WriteOperationCapability): string {
  if (capability.claim === "live-qualified") return "proven on this tenant";
  if (capability.claim === "fixture-tested") return "tested, not yet proven on this tenant";
  if (capability.claim === "declared") return "declared, not yet tested";
  if (capability.claim === "unsupported") return "not supported";
  return "unknown";
}

/** What KEEL can do to put a type back, one line per supported operation. */
export function restoreOperations(item: CoverageType): string[] {
  if (!item.writeCapability) return [];
  return Object.entries(item.writeCapability.operations)
    .filter(([, capability]) => capability.claim !== "unsupported")
    .map(([operation, capability]) => `Can ${OPERATION_WORDS[operation] ?? operation.replaceAll("-", " ")}: ${proofWords(capability)}.`);
}

/** The recovery decision and whether references are rewritten when an ID changes. */
export function recoveryDecisionSentence(item: CoverageType): string | null {
  const decision = item.qualification;
  if (!decision) return null;
  const remaps = Object.entries(decision.remapping);
  const remapping = remaps.length === 0 ? ""
    : remaps.every(([, proven]) => proven) ? " If it comes back with a new ID, KEEL updates what refers to it."
      : " If it would come back with a new ID, KEEL stops rather than leave broken references.";
  if (decision.decision === "automated") return `KEEL restores this type on its own.${remapping}`;
  if (decision.decision === "manual") return "Restoring this type is a manual step; KEEL lists it for you to do by hand.";
  return "Whether KEEL can restore this type on its own is not yet decided.";
}

export interface ProtectProblem {
  type: string;
  name: string;
  health: BackupHealth;
  sentence: string;
  tier: string | null;
}

/** Failed, out-of-date and never-backed-up types, by name, worst first. */
export function protectProblems(data: CoverageData, now: string): ProtectProblem[] {
  const order: BackupHealth[] = ["failed", "stale", "never"];
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
  const stale = health.filter((value) => value === "stale").length;
  const never = health.filter((value) => value === "never").length;
  if (failed) return { text: `${plural(failed, "type", "types")} failed ${failed === 1 ? "its" : "their"} last backup.`, tone: "critical" };
  if (stale) return { text: `${plural(stale, "type has", "types have")} not been backed up recently enough.`, tone: "attention" };
  if (never) return { text: `${plural(never, "type has", "types have")} never been backed up.`, tone: "attention" };
  const collected = data.types.filter((item) => item.lastCollectedAt);
  if (collected.length === 0) return { text: "Nothing has been backed up yet.", tone: "attention" };
  const oldest = Math.min(...collected.map((item) => new Date(item.lastCollectedAt!).valueOf()));
  const hours = Math.max(1, Math.ceil((new Date(now).valueOf() - oldest) / 3_600_000));
  const window = hours < 48 ? plural(hours, "hour", "hours") : plural(Math.ceil(hours / 24), "day", "days");
  const subject = collected.length === 1 ? "The one configuration type was" : `All ${collected.length} configuration types were`;
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
  if (schedule.last_status === "running" || schedule.last_status === "queued") return `Running now, started ${ago(schedule.last_run_at, now)}.`;
  return `Last run ${displayEnum("jobStatus", schedule.last_status).toLowerCase()} ${ago(schedule.last_run_at, now)}.`;
}

export function nextRunSentence(schedule: Pick<Schedule, "enabled" | "next_due_at">, now: string): string {
  if (!schedule.enabled) return "Turned off.";
  const due = fromNow(schedule.next_due_at, now);
  return due === "already passed" ? "Next run is due now." : `Next run ${due}.`;
}

export interface TierSummary {
  id: string;
  label: string;
  description: string;
  schedule: Schedule | null;
  next: string;
  last: string;
  failed: boolean;
}

/** One card per tier: when it runs next and how its last run ended. */
export function tierSummaries(schedules: Schedule[], now: string): TierSummary[] {
  return TIERS.map((tier) => {
    const schedule = schedules.find((entry) => (entry.job_kind === "collect" || entry.job_kind === "backup") && entry.tier === tier.id) ?? null;
    return {
      id: tier.id, label: tier.label, description: tier.description, schedule,
      next: schedule ? nextRunSentence(schedule, now) : "No schedule; back it up on demand.",
      last: schedule ? lastRunSentence(schedule, now) : "",
      failed: schedule?.last_status === "failed",
    };
  });
}
