// Types and plain words for the Restore page's other Microsoft 365 services. No
// database here, so the client UI harness can render the cards from fixtures.

export interface RestoreWorkloadWrite {
  verb: string;
  name: string;
  // Restores that must be proven on the tenant before this one is switched on.
  after: string[];
}

export interface RestoreWorkload {
  workload: string;
  name: string;
  // The taxonomy's service code (Exchange, SharePoint, ...), or null when unclassified.
  service: string | null;
  reads: string[];
  writes: RestoreWorkloadWrite[];
  todo: string;
  // The newest backup that holds settings, or null when there is none yet.
  backup: { collectionId: string; takenAt: string | null; items: number; partial: boolean } | null;
  // The newest run, when it is newer than the backup and did not hold settings.
  lastRun: { collectionId: string; outcome: string; at: string | null; reasons: string[] } | null;
}

// Plain words for each workload card. Pure, so tests drive them directly.

export type WorkloadTone = "fine" | "soon" | "urgent" | "muted";

function count(value: number, one: string, many = `${one}s`): string {
  return `${value.toLocaleString("en-GB")} ${value === 1 ? one : many}`;
}

function agoWords(value: string | null, now: string): string {
  if (!value) return "at an unknown time";
  const minutes = Math.floor((Date.parse(now) - Date.parse(value)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return "at an unknown time";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${count(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${count(hours, "hour")} ago`;
  return `${count(Math.floor(hours / 24), "day")} ago`;
}

/** Whether there is a backup, how old, and what it holds; or why there is none. */
export function workloadBackupLine(workload: Pick<RestoreWorkload, "backup" | "lastRun">, now: string): { tone: WorkloadTone; text: string } {
  const { backup, lastRun } = workload;
  if (backup) {
    const holds = backup.items === 0 ? "nothing to hold yet" : count(backup.items, "item");
    const part = backup.partial ? ", read in part" : "";
    const failed = lastRun?.outcome === "failed" ? ". The newest backup failed, so this is the one before" : "";
    return { tone: lastRun?.outcome === "failed" || backup.partial ? "soon" : "fine", text: `Backed up ${agoWords(backup.takenAt, now)} · ${holds}${part}${failed}` };
  }
  if (lastRun?.outcome === "failed") return { tone: "urgent", text: "The last backup failed, so there is nothing to put back yet" };
  if (lastRun?.outcome === "disabled") return { tone: "muted", text: "Not switched on for this tenant yet. It starts once a live read from your tenant is checked" };
  return { tone: "muted", text: "Not backed up yet" };
}

/** The chip on a card: is there a backup, and can KEEL put any of it back? */
export function workloadRestoreChip(workload: Pick<RestoreWorkload, "writes" | "backup">): { tone: WorkloadTone; text: string } {
  if (!workload.backup) return { tone: "muted", text: "No backup yet" };
  return workload.writes.length ? { tone: "fine", text: "KEEL can put back" } : { tone: "soon", text: "By hand only" };
}

/** "Switched on once SharePoint tenant sharing and site settings is proven." */
export function workloadWriteNote(write: RestoreWorkloadWrite): string | null {
  if (!write.after.length) return null;
  const names = write.after.length === 1 ? write.after[0] : `${write.after.slice(0, -1).join(", ")} and ${write.after.at(-1)}`;
  return `Switched on once the restore of ${names} is proven on this tenant.`;
}

export interface WorkloadServiceGroup {
  service: string | null;
  workloads: RestoreWorkload[];
}

/** Workloads under their Microsoft service, services in the portal's order. */
export function groupWorkloadsByService(workloads: RestoreWorkload[], order: (service: string | null) => number): WorkloadServiceGroup[] {
  const groups = new Map<string, WorkloadServiceGroup>();
  for (const workload of workloads) {
    const key = workload.service ?? "";
    if (!groups.has(key)) groups.set(key, { service: workload.service, workloads: [] });
    groups.get(key)!.workloads.push(workload);
  }
  return [...groups.values()].sort((a, b) => order(a.service) - order(b.service));
}

/** The section's one-line summary. */
export function workloadSummary(workloads: RestoreWorkload[]): string {
  const services = new Set(workloads.map((workload) => workload.service ?? "other")).size;
  const backedUp = workloads.filter((workload) => workload.backup).length;
  const restorable = workloads.filter((workload) => workload.writes.length).length;
  return `${count(services, "service")}, ${count(workloads.length, "kind", "kinds")} of settings: ${backedUp} backed up on this tenant, ${restorable} KEEL can put back at least in part.`;
}

// Starting a restore for one of these services from the Restore page.

// The same list as engine/restore/workloads/restoreChoices.mjs PAGE_RESTORE_WORKLOADS
// (a test keeps them equal); kept here so the client bundle needs no engine module.
export const PAGE_RESTORE_WORKLOADS: readonly string[] = [
  "exchange-mail-flow", "exchange-extended", "teams-org-policies", "teams-voice-policies",
  "purview-retention-dlp", "purview-governance", "purview-labels",
];

/** True when the page offers "Choose what to put back" for this kind of setting. */
export function startsFromPage(workload: Pick<RestoreWorkload, "workload" | "writes" | "backup">): boolean {
  return PAGE_RESTORE_WORKLOADS.includes(workload.workload) && workload.writes.length > 0 && workload.backup !== null;
}

export interface WorkloadChoiceItem {
  key: string;
  name: string;
  // Against the newest backup; null when the chosen backup is the newest.
  change: "changed" | "deleted" | "same" | null;
  restorable: boolean;
  reason: string | null;
  tenantWide: boolean;
}

export interface WorkloadChoiceGroup {
  kind: string;
  name: string;
  restorable: boolean;
  reason: string | null;
  items: WorkloadChoiceItem[];
}

export interface WorkloadBackupPoint {
  collectionId: string;
  takenAt: string | null;
  items: number;
}

export interface WorkloadChoices {
  workload: string;
  // Newest first.
  backups: WorkloadBackupPoint[];
  chosen: WorkloadBackupPoint;
  groups: WorkloadChoiceGroup[];
}

/** "Changed since this backup", in the words the list shows under a name. */
export function choiceChangeWords(item: Pick<WorkloadChoiceItem, "change" | "tenantWide">): string | null {
  const words = item.change === "changed" ? "Changed since this backup" : item.change === "same" ? "Same as the newest backup" : item.change === "deleted" ? "Deleted since this backup" : null;
  const wide = item.tenantWide ? "Affects the whole tenant" : null;
  return [words, wide].filter(Boolean).join(" · ") || null;
}

/** "2 Oct, 06:12": how a backup is named on the page (UTC, as the rest of Restore). */
export function backupPointWords(takenAt: string | null): string {
  if (!takenAt) return "a backup at an unknown time";
  const date = new Date(takenAt);
  if (Number.isNaN(date.getTime())) return "a backup at an unknown time";
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${day}, ${time}`;
}
