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
