import { ago, formatTimestamp } from "@/lib/presentation";
import { workloadSubject } from "@/lib/sentences";
import type { RestoreFollowUp } from "@/lib/types";

// Words for the Restore page's "Follow-up after restores" cards (UI audit B10, D13):
// every card names its restore and says when that restore ran. Pure, so tests drive it.

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

function backupMoment(value: string | null | undefined): string {
  return value ? formatTimestamp(value).replace(/ UTC$/, "") : "an unknown time";
}

/** "Restore of 3 settings from the backup of 2 Oct 2026, 09:12": the restore by what it
 * put back and from which backup, never by an id. */
export function followUpName(card: Pick<RestoreFollowUp, "plan">): string {
  const plan = card.plan;
  if (!plan?.readable) return "Restore whose plan is no longer readable";
  const settings = plural(plan.resources ?? 0, "setting");
  if (plan.undo) return `Undo of a restore (${settings})`;
  if (plan.complianceFix) return `Fix for a failing compliance check (${settings})`;
  if (plan.workload) return `Restore of ${workloadSubject(plan.workload)} (${settings}) from the backup of ${backupMoment(plan.snapshotAt)}`;
  return `Restore of ${settings} from the backup of ${backupMoment(plan.snapshotAt)}`;
}

/** When the card's restore ran. A restore with a job shows when it finished; one without
 * (run outside the portal) shows when its steps were opened, and says so. */
export function followUpWhen(card: Pick<RestoreFollowUp, "restoredAt" | "since" | "jobStatus">, now: string): { words: string; at: string } {
  if (card.restoredAt) {
    const verb = card.jobStatus === "failed" ? "Failed" : "Restored";
    return { words: `${verb} ${ago(card.restoredAt, now)}`, at: card.restoredAt };
  }
  return { words: `Steps opened ${ago(card.since, now)}`, at: card.since };
}

/** Where a card links: the page of the job that ran the restore, where its steps close. */
export function followUpHref(card: Pick<RestoreFollowUp, "jobId">): string | null {
  return card.jobId ? `/jobs/${encodeURIComponent(card.jobId)}` : null;
}
