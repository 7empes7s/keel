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

// The four answers the contract allows for "can Keel put this type back?".
export type RestoreStanding = "protected" | "partial" | "cannot-restore" | "unproven";

/**
 * Whether Keel has a tested writer for the type: an automated recovery decision and at
 * least one write operation tested on fixtures or proven live. Most types declare
 * "read-only" fidelity only because no restore drill has measured them; the writer, not
 * that declaration, is what says Keel can put the type back.
 */
export function hasRestoreWriter(item: CoverageType): boolean {
  if (item.qualification?.decision !== "automated" || !item.writeCapability) return false;
  return Object.values(item.writeCapability.operations)
    .some((capability) => capability.claim === "fixture-tested" || capability.claim === "live-qualified");
}

function provenLive(item: CoverageType): boolean {
  return Object.values(item.writeCapability?.operations ?? {})
    .some((capability) => capability.claim === "live-qualified" && capability.liveRecord?.live !== false);
}

export function restoreStanding(item: CoverageType): RestoreStanding {
  const declared = item.fidelity.declared;
  if (item.protectionState === "not-covered" || item.protectionState === "unprotectable"
    || declared === "unprotectable" || !item.adapter || item.outcome === "unavailable") {
    return "cannot-restore";
  }
  const readOnly = item.protectionState === "read-only" || declared === "read-only" || !declared;
  if (readOnly && !hasRestoreWriter(item)) return "cannot-restore";
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
      return `Partially protected: some fields Microsoft sets itself and Keel cannot restore${proven ? `; restore proven on ${proven}` : ""}.`;
    case "unproven":
      if (provenLive(item)) return "Backed up. Keel's writes for this type are proven on this tenant, but no restore drill has yet measured what comes back.";
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

export type BackupHealth = "ok" | "empty" | "failed" | "stale" | "never" | "not-collected" | "unavailable";

export function backupHealth(item: CoverageType): BackupHealth {
  if (item.protectionState === "not-covered" || !item.adapter) return "not-collected";
  // Microsoft refused the read for a missing licence or tenant feature (#309): not a failure.
  if (item.outcome === "unavailable") return "unavailable";
  if (item.protectionState === "failed" || item.outcome === "failed" || item.outcome === "partial") return "failed";
  if (item.reportStatus === "never-collected" || !item.lastCollectedAt) return "never";
  if (item.stale) return "stale";
  return item.outcome === "complete-empty" || item.itemCount === 0 ? "empty" : "ok";
}

function items(count: number | null): string {
  if (count === null) return "";
  return `, ${count.toLocaleString("en-GB")} ${count === 1 ? "item" : "items"}`;
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
  const collected = data.types.filter((item) => item.lastCollectedAt && backupHealth(item) !== "unavailable");
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
  if (schedule.last_status === "partial") return `Last run partly done ${ago(schedule.last_run_at, now)}: some types were not backed up.`;
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

// The What's protected page (portal audit: grouped list on a desktop, service cards on a phone).
// Health in four words a tile and a badge can share; tones are risk colours only.
export type HealthFilter = "backed-up" | "failed" | "out-of-date" | "proven";

export const HEALTH_FILTERS: HealthFilter[] = ["backed-up", "failed", "out-of-date", "proven"];

export function isHealthFilter(value: string): value is HealthFilter {
  return (HEALTH_FILTERS as string[]).includes(value);
}

export function matchesHealth(item: CoverageType, filter: HealthFilter): boolean {
  const health = backupHealth(item);
  switch (filter) {
    case "backed-up": return health === "ok" || health === "empty";
    case "failed": return health === "failed";
    case "out-of-date": return health === "stale" || health === "never";
    case "proven": return restoreStanding(item) === "protected" || restoreStanding(item) === "partial";
  }
}

export type HealthTone = "urgent" | "soon" | "fine" | "neutral";

export const HEALTH_BADGE: Record<BackupHealth, { label: string; tone: HealthTone }> = {
  ok: { label: "Backed up", tone: "fine" },
  empty: { label: "Backed up", tone: "fine" },
  failed: { label: "Failed", tone: "urgent" },
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

export interface ProtectCounts {
  total: number;
  backedUp: number;
  failed: number;
  stale: number;
  never: number;
  proven: number;
  restorable: number;
}

export function protectCounts(types: CoverageType[]): ProtectCounts {
  const health = types.map(backupHealth);
  const standing = types.map(restoreStanding);
  return {
    total: types.length,
    backedUp: health.filter((value) => value === "ok" || value === "empty").length,
    failed: health.filter((value) => value === "failed").length,
    stale: health.filter((value) => value === "stale").length,
    never: health.filter((value) => value === "never").length,
    proven: standing.filter((value) => value === "protected" || value === "partial").length,
    restorable: standing.filter((value) => value !== "cannot-restore").length,
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
  if (plan.tiers.length === 0) return "None of these kinds is in a backup tier, so there is nothing to run.";
  const runs = `Runs ${listWords(plan.tiers.map(tierLabel))} in full. It only reads your tenant.`;
  if (!plan.untiered) return runs;
  return `${runs} ${plan.untiered === 1 ? "1 kind has" : `${plan.untiered} kinds have`} no tier and ${plan.untiered === 1 ? "is" : "are"} left out.`;
}

/** The verdict's second line: where the problems are, or when everything last ran. */
export function protectVerdictDetail(types: CoverageType[], serviceOf: (type: string) => string, now: string): string | undefined {
  const problems = types.filter((item) => ["failed", "stale", "never"].includes(backupHealth(item)));
  if (problems.length === 0) return undefined;
  const services = [...new Set(problems.map((item) => serviceOf(item.type)))];
  const fine = types.filter((item) => backupHealth(item) === "ok" || backupHealth(item) === "empty");
  const newest = fine.map((item) => item.lastCollectedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  return `In ${listWords(services)}.${newest ? ` Everything else was backed up ${ago(newest, now)}.` : ""}`;
}

/** Under a filtered verdict: which filters it counts, and every service's totals, so a
 * filter never hides failures elsewhere.
 * "Counts follow your filter: In Intune. Across all services: 11 of 15 kinds backed up, 2 failed, 2 out of date or never." */
export function protectScopeDetail(filters: string[], types: CoverageType[]): string {
  const counts = protectCounts(types);
  const late = counts.stale + counts.never;
  const parts = [
    `${counts.backedUp} of ${plural(counts.total, "kind", "kinds")} backed up`,
    ...(counts.failed ? [`${counts.failed} failed`] : []),
    ...(late ? [`${late} out of date or never`] : []),
  ];
  return `Counts follow your ${filters.length === 1 ? "filter" : "filters"}: ${filters.join(", ")}. Across all services: ${parts.join(", ")}.`;
}

/** The header's status pill: failures first, then out of date, else backed up. */
export function protectStatus(data: CoverageData): { tone: "urgent" | "soon" | "fine"; label: string } {
  const counts = protectCounts(data.types);
  if (counts.failed) return { tone: "urgent", label: `${counts.failed} failed` };
  if (counts.stale + counts.never) return { tone: "soon", label: `${counts.stale + counts.never} out of date` };
  return { tone: "fine", label: "Backed up" };
}
