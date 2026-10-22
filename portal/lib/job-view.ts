import type { AlertItem } from "@/components/ui/alert-list";
import type { StatTile } from "@/components/ui/stat-tiles";
import { jobIncompleteTypes } from "@/lib/job-names";
import type { JobRecord } from "@/lib/portal-jobs";
import { ago, resourceTypeLabel } from "@/lib/presentation";

// The Job page as alerts and tiles. A failed job leads with a plain cause and one next
// step; the engine's own error text waits behind "Show details".

type Cause = Pick<AlertItem, "tone" | "icon"> & { title: string; todo: string; action: AlertItem["action"] };

const RESTORE_KINDS = new Set(["restore", "remediate"]);

/** The plain cause of a failed job and what to do about it, from its error text. */
export function jobErrorCause(job: Pick<JobRecord, "kind" | "error" | "params">): Cause {
  const error = String(job.error ?? "");
  const params = (job.params ?? {}) as Record<string, unknown>;
  const artifact = typeof params.artifactId === "string" ? params.artifactId : null;
  const again = RESTORE_KINDS.has(job.kind) ? "Run the restore again" : "Run it again";
  if (/blocked-content-effect/.test(error)) {
    return {
      tone: "soon", icon: "clock", title: "Waiting for approval of what it does to content",
      todo: `Someone must approve its effect on files, mail or messages. ${again} after that.`,
      action: artifact ? { label: "Review content effects", href: `/approvals/content-effects/${encodeURIComponent(artifact)}` } : null,
    };
  }
  if (/\b429\b|throttl/i.test(error)) {
    return {
      tone: "soon", icon: "clock", title: "Microsoft 365 slowed Keel down",
      todo: "The next scheduled run tries again. If this keeps happening, space the schedules further apart.",
      action: { label: "Open schedules", href: "/schedules" },
    };
  }
  if (/\b40[13]\b|Authorization_RequestDenied|Insufficient privileges|forbidden|unauthori[sz]ed/i.test(error)) {
    return {
      tone: "urgent", icon: "person", title: "Keel is missing a permission in Microsoft 365",
      todo: `Check Keel's permissions on the Setup page. ${again} once they are granted.`,
      action: { label: "Open setup", href: "/setup" },
    };
  }
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|\b50[234]\b/i.test(error)) {
    return {
      tone: "soon", icon: "cloud", title: "Keel could not reach Microsoft 365",
      todo: `${again} in a few minutes.`, action: null,
    };
  }
  if (/interrupted|shut ?down|restart|lease (?:lost|expired)|worker (?:died|lost)/i.test(error)) {
    return { tone: "soon", icon: "refresh", title: "The job was interrupted before it finished", todo: `${again}.`, action: null };
  }
  if (/\b4\d\d\b|rejected|BadRequest|invalid/i.test(error)) {
    return {
      tone: "urgent", icon: "x-circle", title: "Microsoft 365 refused the change",
      todo: RESTORE_KINDS.has(job.kind) ? "Check what was sent in the dry run, then try again or make the change by hand." : `${again}. If it fails the same way, check Show details.`,
      action: null,
    };
  }
  return { tone: "urgent", icon: "alert", title: "The job stopped with an error", todo: `${again}. If it fails the same way, check Show details.`, action: null };
}

/** What needs the reader on this job, worst first: the failure, then any gaps. */
export function jobAlerts(job: JobRecord): AlertItem[] {
  const alerts: AlertItem[] = [];
  if (job.status === "failed" && job.error !== null && job.error !== undefined) {
    const cause = jobErrorCause(job);
    const lines = String(job.error).split("\n").map((line) => line.trim()).filter(Boolean);
    alerts.push({ key: "error", ...cause, more: lines.length ? lines.slice(0, 12) : [] });
  }
  const gaps = jobIncompleteTypes(job);
  if (gaps.length) {
    alerts.push({
      key: "gaps", tone: "soon", icon: "backup",
      title: `${gaps.length === 1 ? "1 kind" : `${gaps.length} kinds`} could not be backed up in full`,
      todo: "The rest was saved. The next backup tries these again.",
      more: gaps.map((type) => resourceTypeLabel(type).replace(/^./, (letter) => letter.toUpperCase())),
      action: { label: "Open backups", href: "/protect" },
    });
  }
  const rank = { urgent: 0, soon: 1, low: 2 } as const;
  return alerts.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

/** "3 minutes", or null when either end is missing. */
export function jobGap(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from || !to) return null;
  const seconds = Math.round((new Date(to).valueOf() - new Date(from).valueOf()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(minutes / 60)} hours`;
}

/** Three timing tiles: when it was asked for, how long it waited, how long it ran. */
export function jobTiles(job: JobRecord, now: string): StatTile[] {
  const waited = jobGap(job.createdAt, job.startedAt);
  const ran = jobGap(job.startedAt, job.finishedAt ?? (job.status === "running" ? now : null));
  const status = job.status === "failed" ? "urgent" : job.status === "succeeded" ? "fine" : job.status === "running" ? "soon" : "neutral";
  return [
    { key: "asked", label: "Asked for", icon: "calendar", value: ago(job.createdAt ?? null, now), about: "when it was queued", tone: "neutral" },
    { key: "waited", label: "Waited", icon: "clock", value: job.startedAt ? (waited ?? "Unknown") : "Not started", about: job.startedAt ? "before it started" : "still in the queue", tone: job.startedAt ? "neutral" : "low" },
    {
      key: "ran", label: job.finishedAt ? "Ran for" : "Running for", icon: "play",
      value: job.startedAt ? (ran ?? "Unknown") : "—",
      about: job.finishedAt ? (job.status === "failed" ? "then it failed" : "then it ended") : job.startedAt ? "so far" : "not started yet",
      tone: job.finishedAt ? status : job.startedAt ? "soon" : "neutral",
    },
  ];
}
