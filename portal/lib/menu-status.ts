import type { NavSection } from "@/components/nav-links";
import { AUDIT_CHECK_WORDS, dashboardAuditCheck } from "@/lib/audit-check";
import { overviewVerdict } from "@/lib/overview-view";
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
export function menuStatuses(data: Pick<DashboardData, "headline" | "coverage" | "openDriftByBlastRadius" | "openDriftTotal" | "evidence" | "waiting"> & Partial<Pick<DashboardData, "alerts">>, pendingApprovals: number | null = null): MenuStatuses {
  const statuses: MenuStatuses = {};

  // The same verdict, and colour, as the Overview's own banner.
  if (data.headline) {
    const verdict = overviewVerdict(data.headline, data.alerts ?? []);
    if (verdict.tone === "critical") statuses.Dashboards = { tone: "urgent", note: verdict.headline };
    else if (verdict.tone === "attention") statuses.Dashboards = { tone: "soon", note: verdict.headline };
  }

  const failed = data.coverage.failed;
  const late = data.coverage.stale + data.coverage.neverCollected;
  // The number counts only what its colour says: failures when it is red.
  if (failed > 0) statuses.Backup = { tone: "urgent", count: failed, note: `${plural(failed, "kind of setting", "kinds of settings")} failed to back up${late ? `, and ${late} more ${late === 1 ? "is" : "are"} out of date` : ""}` };
  else if (late > 0) statuses.Backup = { tone: "soon", count: late, note: `${plural(late, "kind of setting is", "kinds of settings are")} not backed up recently` };

  if (data.openDriftTotal > 0) {
    const radius = new Map(data.openDriftByBlastRadius.map((entry) => [entry.blastRadius, entry.count]));
    const lockout = radius.get("tenant-lockout") ?? 0;
    const access = radius.get("access-affecting") ?? 0;
    const all = `${plural(data.openDriftTotal, "change", "changes")} since your approved setup`;
    // As with Backup, the number is the changes at the badge's own risk level.
    if (lockout > 0) statuses.Baselines = { tone: "urgent", count: lockout, note: `${plural(lockout, "change", "changes")} could lock out admins, of ${all}` };
    else if (access > 0) statuses.Baselines = { tone: "soon", count: access, note: `${plural(access, "change affects", "changes affect")} access, of ${all}` };
    else statuses.Baselines = { tone: "low", count: data.openDriftTotal, note: all };
  }

  const recovery = (data.waiting?.openIncidents ?? 0) + (data.waiting?.restoreFollowUps ?? 0);
  if (recovery > 0) statuses.Restore = { tone: "soon", count: recovery, note: `${plural(recovery, "incident or restore step needs", "incidents or restore steps need")} someone` };

  // The Overview's audit record states, in its words.
  const audit = dashboardAuditCheck(data.evidence);
  if (audit === "failed") statuses["Audit log"] = { tone: "urgent", note: AUDIT_CHECK_WORDS.failed.title };
  else if (audit === "known") statuses["Audit log"] = { tone: "soon", note: AUDIT_CHECK_WORDS.known.title };
  else if (audit === "unchecked") statuses["Audit log"] = { tone: "soon", note: AUDIT_CHECK_WORDS.unchecked.title };

  const inbox = (pendingApprovals ?? 0) + (data.waiting?.openAlerts ?? 0);
  if (inbox > 0) statuses.Inbox = { tone: "soon", count: inbox, note: inboxNote(pendingApprovals ?? 0, data.waiting?.openAlerts ?? 0) };
  return statuses;
}

export function inboxNote(approvals: number, alerts: number): string {
  const parts = [approvals ? plural(approvals, "approval", "approvals") : "", alerts ? plural(alerts, "alert", "alerts") : ""].filter(Boolean);
  return parts.length ? `${parts.join(" and ")} waiting` : "Nothing waiting";
}

/**
 * Settings' status: urgent when nobody active can approve, check soon when an alert
 * channel's latest finished delivery failed. Deliveries come newest first, as the
 * deliveries route lists them. A list that could not be read (null) says nothing.
 */
export function settingsStatus({ principals, deliveries }: {
  principals: { capabilities: string[]; entity_capabilities?: Record<string, string[]>; disabled_at: string | null; system_kind?: string | null }[] | null;
  deliveries: { channel_id: string; status: string }[] | null;
}): SectionStatus | undefined {
  if (principals && principals.length > 0) {
    const approvers = principals.filter((principal) => !principal.disabled_at && !principal.system_kind && (principal.capabilities.includes("approve")
      // An approver for one entity's resources still works their part of the inbox.
      || Object.values(principal.entity_capabilities ?? {}).some((held) => held.includes("approve"))));
    if (approvers.length === 0) return { tone: "urgent", note: "Nobody can approve restores and changes" };
  }
  if (deliveries) {
    const latest = new Map<string, string>();
    for (const delivery of deliveries) {
      // Turning a channel off cancels what it still had queued, so a cancel ends a failure too.
      if (["delivered", "failed", "cancelled"].includes(delivery.status) && !latest.has(delivery.channel_id)) latest.set(delivery.channel_id, delivery.status);
    }
    const failing = [...latest.values()].filter((status) => status === "failed").length;
    if (failing > 0) return { tone: "soon", count: failing, note: `${plural(failing, "alert channel is", "alert channels are")} failing to send` };
  }
  return undefined;
}
