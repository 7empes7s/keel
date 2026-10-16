import type { NavSection } from "@/components/nav-links";
import type { DashboardData } from "@/lib/types";

// Each menu section's count and status, so a closed section still says whether it
// needs someone. Colour only for risk: urgent, check soon, low risk, fine.
export type RiskTone = "urgent" | "soon" | "low" | "fine";

export interface SectionStatus {
  tone: RiskTone;
  // Shown as a number beside the section; absent when the status is a state, not a count.
  count?: number;
  // One plain sentence: the tooltip and the screen reader's reading of the badge.
  note: string;
}

export type MenuStatuses = Partial<Record<NavSection, SectionStatus>>;

const TONE_ORDER: RiskTone[] = ["urgent", "soon", "low", "fine"];

/** The most serious of several tones; null for none. */
export function worstTone(tones: (RiskTone | undefined)[]): RiskTone | null {
  const present = tones.filter((tone): tone is RiskTone => Boolean(tone));
  return present.length ? TONE_ORDER.find((tone) => present.includes(tone)) ?? null : null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Statuses from the Overview's data. Sections with nothing to say are left out. */
export function menuStatuses(data: Pick<DashboardData, "headline" | "coverage" | "openDriftByBlastRadius" | "openDriftTotal" | "evidence" | "waiting">, pendingApprovals: number | null = null): MenuStatuses {
  const statuses: MenuStatuses = {};

  const headline = data.headline;
  if (headline?.tone === "critical") statuses.Dashboards = { tone: "urgent", note: headline.headline };
  else if (headline?.tone === "attention") statuses.Dashboards = { tone: "soon", note: headline.headline };

  const failed = data.coverage.failed;
  const late = data.coverage.stale + data.coverage.neverCollected;
  if (failed > 0) statuses.Backup = { tone: "urgent", count: failed + late, note: `${plural(failed, "kind of setting", "kinds of settings")} failed to back up` };
  else if (late > 0) statuses.Backup = { tone: "soon", count: late, note: `${plural(late, "kind of setting is", "kinds of settings are")} not backed up recently` };

  if (data.openDriftTotal > 0) {
    const radius = new Map(data.openDriftByBlastRadius.map((entry) => [entry.blastRadius, entry.count]));
    const tone: RiskTone = (radius.get("tenant-lockout") ?? 0) > 0 ? "urgent" : (radius.get("access-affecting") ?? 0) > 0 ? "soon" : "low";
    statuses.Baselines = { tone, count: data.openDriftTotal, note: `${plural(data.openDriftTotal, "change", "changes")} since your approved setup` };
  }

  const recovery = (data.waiting?.openIncidents ?? 0) + (data.waiting?.restoreFollowUps ?? 0);
  if (recovery > 0) statuses.Restore = { tone: "soon", count: recovery, note: `${plural(recovery, "incident or restore step needs", "incidents or restore steps need")} someone` };

  if (data.evidence && !data.evidence.ok) statuses["Audit log"] = { tone: "urgent", note: "The audit record failed its integrity check" };

  const inbox = (pendingApprovals ?? 0) + (data.waiting?.openAlerts ?? 0);
  if (inbox > 0) statuses.Inbox = { tone: "soon", count: inbox, note: inboxNote(pendingApprovals ?? 0, data.waiting?.openAlerts ?? 0) };
  return statuses;
}

export function inboxNote(approvals: number, alerts: number): string {
  const parts = [approvals ? plural(approvals, "approval", "approvals") : "", alerts ? plural(alerts, "alert", "alerts") : ""].filter(Boolean);
  return parts.length ? `${parts.join(" and ")} waiting` : "Nothing waiting";
}
