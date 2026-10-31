// The Overview in words (portal audit, Overview, one design). Pure helpers shared by the
// page, the UI harness and the tests: the verdict and its status pill, the four count
// tiles, the "Needs attention" rows and the chart legends, each with the link behind it.
// Ids stay in the record layer; the components only lay these out.
import type { IconName } from "@/components/shell/icons";
import type { BadgeTone } from "@/components/ui/badge";
import { ago } from "@/lib/presentation";
import type { CoverageSummary, DashboardAlert, DashboardData, DashboardWaiting, ProtectionHeadline } from "@/lib/types";

// Portal experience contract, Overview verdict: one headline, one sentence (the memorable
// number from the engine), one tone and at most one primary action. Alerts can only make
// the tone worse; they never replace the number.
export type VerdictTone = "good" | "attention" | "critical";

const TONE_RANK: Record<VerdictTone, number> = { good: 0, attention: 1, critical: 2 };

export function overviewVerdict(headline: ProtectionHeadline, alerts: DashboardAlert[]): {
  tone: VerdictTone; headline: string; sentence: string; action: ProtectionHeadline["action"];
} {
  const critical = alerts.some((alert) => alert.severity === "critical");
  const warning = alerts.some((alert) => alert.severity === "warning");
  const alertTone: VerdictTone = critical ? "critical" : warning ? "attention" : "good";
  const tone = TONE_RANK[alertTone] > TONE_RANK[headline.tone] ? alertTone : headline.tone;
  return {
    tone,
    headline: critical && headline.state !== "collection" ? "Action needed" : headline.headline,
    sentence: headline.sentence,
    action: headline.action,
  };
}

export type RiskWord = "urgent" | "soon" | "low" | "fine";

const VERDICT_RISK: Record<VerdictTone, RiskWord> = { critical: "urgent", attention: "soon", good: "fine" };

/** The verdict's tone as the risk word the page frame uses. */
export const verdictRisk = (tone: VerdictTone): RiskWord => VERDICT_RISK[tone];

/** The status pill beside the title: what the verdict says, in two words. */
export function overviewStatus(tone: VerdictTone): { tone: RiskWord; label: string } {
  if (tone === "critical") return { tone: "urgent", label: "Action needed" };
  if (tone === "attention") return { tone: "soon", label: "Needs attention" };
  return { tone: "fine", label: "Protected" };
}

/** The engine's sentence in the portal's words: "Keel", and kinds of settings, not configuration types. */
export function plainWords(sentence: string): string {
  return sentence
    .replace(/\bKEEL\b/g, "Keel")
    .replace(/\bconfiguration type\b/g, "kind of setting")
    .replace(/\bconfiguration types\b/g, "kinds of settings");
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

/**
 * The verdict's one amber action, pointed at the list behind the sentence: failed
 * backups open What's protected filtered to the failed ones.
 */
export function verdictAction(headline: ProtectionHeadline): { label: string; href: string } | null {
  const action = headline.action;
  if (!action) return null;
  if (action.href === "/protect" && headline.state === "collection") {
    const { failed, stale, neverCollected } = headline.counts;
    if (failed > 0) return { label: failed === 1 ? "See the failed one" : `See the ${failed} failed`, href: "/protect?health=failed" };
    if (stale + neverCollected > 0) return { label: "See the out-of-date ones", href: "/protect?health=out-of-date" };
  }
  return action;
}

/** Where a coverage state's list lives on What's protected. */
export const COVERAGE_LINKS = {
  covered: "/protect?health=backed-up",
  failed: "/protect?health=failed",
  uncovered: "/protect",
} as const;

export interface CoverageSegment { key: keyof typeof COVERAGE_LINKS; label: string; value: number; href: string }

/** The ring's three parts, each a link to its list. */
export function coverageSegments(coverage: CoverageSummary): { segments: CoverageSegment[]; total: number; percent: number } {
  const uncovered = coverage.notCovered + coverage.neverCollected;
  const total = Math.max(coverage.total, coverage.covered + coverage.failed + uncovered, 1);
  return {
    segments: [
      { key: "covered", label: "Backed up", value: coverage.covered, href: COVERAGE_LINKS.covered },
      { key: "failed", label: "Failed", value: coverage.failed, href: COVERAGE_LINKS.failed },
      { key: "uncovered", label: "Not backed up", value: uncovered, href: COVERAGE_LINKS.uncovered },
    ],
    total,
    percent: Math.round((coverage.covered / total) * 100),
  };
}

const RISK_ORDER = ["tenant-lockout", "access-affecting", "cosmetic"];
const RISK_TONES: Record<string, RiskWord> = { "tenant-lockout": "urgent", "access-affecting": "soon", cosmetic: "low" };

/** Open changes by risk, worst first, each a link to the Changes page filtered to it. */
export function riskRows(items: DashboardData["openDriftByBlastRadius"]): { key: string; tone: RiskWord; count: number; href: string }[] {
  const counts = new Map(items.map((item) => [item.blastRadius, item.count]));
  const keys = [...RISK_ORDER, ...items.map((item) => item.blastRadius).filter((key) => !RISK_ORDER.includes(key))];
  return keys.map((key) => ({ key, tone: RISK_TONES[key] ?? "low", count: counts.get(key) ?? 0, href: `/drift?risk=${encodeURIComponent(key)}` }));
}

// Work outside the approvals inbox that waits on a person, each linked to where it is done.
export const WAITING_ROWS: { key: keyof DashboardWaiting; href: string; icon: IconName; one: string; many: string; detail: string }[] = [
  { key: "openAlerts", href: "/alerts", icon: "bell", one: "alert is not acknowledged", many: "alerts are not acknowledged", detail: "Each one needs an owner to acknowledge it." },
  { key: "openIncidents", href: "/incidents", icon: "alert", one: "incident is open", many: "incidents are open", detail: "Recovery from each one is still in progress." },
  { key: "restoreFollowUps", href: "/restore#follow-up", icon: "restore", one: "restore step is still open", many: "restore steps are still open", detail: "Restores left work Keel cannot do itself, such as new secrets or a service check." },
];

export interface AttentionRow { key: string; tone: BadgeTone; icon: IconName; title: string; detail: string; href: string }

const SEVERITY_TONE: Record<DashboardAlert["severity"], BadgeTone> = { critical: "urgent", warning: "soon", notice: "low" };
const ALERT_ICONS: Record<string, IconName> = {
  "no-baseline": "baselines", "empty-baseline": "baselines", "nothing-backed-up": "backup", "backup-unfinished": "backup",
  failed: "x-circle", stale: "clock", uncovered: "info", audit: "audit",
};

/** The word on a row's badge. */
export const TONE_WORDS: Record<BadgeTone, string> = { urgent: "Urgent", soon: "Check soon", low: "Low risk", fine: "Fine", neutral: "Note" };

/**
 * Alerts the verdict already states. In the backup state the verdict names the failing
 * kinds, so the "N failed" row (and "N out of date" when that is all that fails) would
 * say it twice; with nothing backed up, the verdict says so.
 */
function repeatsVerdict(alert: DashboardAlert, headline: ProtectionHeadline): boolean {
  if (headline.state !== "collection") return false;
  const { failed, stale, neverCollected, backedUp } = headline.counts;
  if (alert.key === "failed") return true;
  if (alert.key === "stale") return failed === 0 && neverCollected === 0 && stale > 0;
  if (alert.key === "nothing-backed-up") return backedUp === 0;
  return false;
}

/**
 * Alerts that reach nobody: no enabled channel, or no rule that sends alerts to one.
 * Urgent, because every alert, Critical ones too, then goes unseen until someone opens
 * the portal. Null while there is a route, or when the count could not be read.
 */
export function notifyNobodyRow(notify: DashboardData["notify"], openAlerts: number): AttentionRow | null {
  if (!notify || notify.routed > 0) return null;
  const open = openAlerts > 0 ? `${plural(openAlerts, "open alert reaches", "open alerts reach")} nobody. ` : "";
  return {
    key: "no-notify-channel", tone: "urgent", icon: "bell",
    title: notify.channels === 0 ? "No notification channel" : "No rule sends alerts to a channel",
    detail: notify.channels === 0
      ? `${open}Add an email or webhook channel so alerts reach someone.`
      : `${open}Add a rule that sends alerts to one of your channels.`,
    href: "/notifications",
  };
}

/**
 * "Needs attention": the computed problems that the verdict does not already state, the
 * changes that could lock out admins, and the work that waits on a person. Urgent first.
 * Each row opens the list behind it. pendingApprovals is null for viewers who cannot approve.
 */
export function attentionRows(data: Pick<DashboardData, "alerts" | "headline" | "openDriftByBlastRadius" | "waiting"> & Partial<Pick<DashboardData, "notify">>, pendingApprovals: number | null): AttentionRow[] {
  const rows: AttentionRow[] = [];
  const unrouted = notifyNobodyRow(data.notify, data.waiting?.openAlerts ?? 0);
  if (unrouted) rows.push(unrouted);
  for (const alert of data.alerts) {
    if (repeatsVerdict(alert, data.headline)) continue;
    rows.push({
      key: alert.key ?? alert.title,
      tone: SEVERITY_TONE[alert.severity],
      icon: ALERT_ICONS[alert.key ?? ""] ?? "alert",
      title: alert.title,
      detail: alert.detail,
      href: alert.href ?? "/protect",
    });
  }
  const lockout = data.openDriftByBlastRadius.find((item) => item.blastRadius === "tenant-lockout")?.count ?? 0;
  if (lockout > 0) {
    rows.push({
      key: "lockout", tone: "urgent", icon: "baselines",
      title: `${plural(lockout, "change", "changes")} could lock out admins`,
      detail: "They could block sign-in for admins. Review them first.",
      href: "/drift?risk=tenant-lockout",
    });
  }
  if (pendingApprovals) {
    rows.push({
      key: "approvals", tone: "soon", icon: "inbox",
      title: `${plural(pendingApprovals, "request waits", "requests wait")} for a decision`,
      detail: "Restores, undo changes and approved-setup changes wait for a second person.",
      href: "/approvals",
    });
  }
  for (const item of WAITING_ROWS) {
    const count = data.waiting?.[item.key] ?? 0;
    if (count > 0) rows.push({ key: item.key, tone: "soon", icon: item.icon, title: `${plural(count, item.one, item.many)}`, detail: item.detail, href: item.href });
  }
  const rank: Record<BadgeTone, number> = { urgent: 0, soon: 1, low: 2, neutral: 3, fine: 4 };
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank[a.row.tone] - rank[b.row.tone] || a.index - b.index).map(({ row }) => row);
}

export interface OverviewTile {
  key: "backups" | "restore" | "changes" | "waiting";
  label: string;
  icon: IconName;
  value: string;
  detail: string;
  href: string;
  tone?: "urgent" | "soon";
  // Proportions for the small meter under the number: [tone, share of 1].
  meter?: { tone: RiskWord | "neutral"; share: number }[];
}

/** The four count tiles; the Waiting tile is left out for viewers with nothing that can wait on them. */
export function overviewTiles(data: DashboardData, pendingApprovals: number | null): OverviewTile[] {
  const { coverage, headline } = data;
  const { segments, total } = coverageSegments(coverage);
  const [covered, failed, uncovered] = segments.map((segment) => segment.value);
  const late = coverage.stale + coverage.neverCollected;
  const tiles: OverviewTile[] = [{
    key: "backups", label: "Backups", icon: "backup",
    value: failed ? `${failed.toLocaleString("en-GB")} failed` : late ? `${late.toLocaleString("en-GB")} out of date` : `${covered.toLocaleString("en-GB")} backed up`,
    detail: `${covered.toLocaleString("en-GB")} of ${plural(total, "kind", "kinds")} backed up`,
    href: failed ? COVERAGE_LINKS.failed : late ? "/protect?health=out-of-date" : "/protect",
    tone: failed ? "urgent" : late ? "soon" : undefined,
    meter: [{ tone: "fine", share: covered / total }, { tone: "urgent", share: failed / total }, { tone: "neutral", share: uncovered / total }],
  }];

  const { restorable, backedUp } = headline.counts;
  tiles.push({
    key: "restore", label: "Restore proven", icon: "restore",
    value: `${restorable.toLocaleString("en-GB")} of ${backedUp.toLocaleString("en-GB")}`,
    detail: headline.lastProvenRestoreAt ? `Last test restore ${ago(headline.lastProvenRestoreAt, data.generatedAt)}` : "No test restore yet",
    href: "/resilience",
    tone: headline.lastProvenRestoreAt ? undefined : "soon",
    meter: [{ tone: "fine", share: backedUp ? restorable / backedUp : 0 }],
  });

  const risks = riskRows(data.openDriftByBlastRadius);
  const lockout = risks.find((row) => row.key === "tenant-lockout")?.count ?? 0;
  const access = risks.find((row) => row.key === "access-affecting")?.count ?? 0;
  const open = Math.max(data.openDriftTotal, 1);
  tiles.push({
    key: "changes", label: "Changes to review", icon: "baselines",
    value: data.openDriftTotal.toLocaleString("en-GB"),
    detail: lockout ? `${plural(lockout, "could", "could")} lock out admins` : access ? `${plural(access, "affects", "affect")} access` : data.openDriftTotal ? "None affects access" : "Nothing changed",
    href: "/drift",
    tone: lockout ? "urgent" : access ? "soon" : undefined,
    meter: data.openDriftTotal ? risks.filter((row) => row.count > 0).map((row) => ({ tone: row.tone, share: row.count / open })) : undefined,
  });

  const others = WAITING_ROWS.map((row) => ({ row, count: data.waiting?.[row.key] ?? 0 }));
  const waiting = (pendingApprovals ?? 0) + others.reduce((sum, item) => sum + item.count, 0);
  if (pendingApprovals !== null || waiting > 0) {
    const parts = [
      pendingApprovals ? plural(pendingApprovals, "approval", "approvals") : "",
      ...others.filter((item) => item.count > 0).map((item) => plural(item.count, item.row.key === "openAlerts" ? "alert" : item.row.key === "openIncidents" ? "incident" : "restore step", item.row.key === "openAlerts" ? "alerts" : item.row.key === "openIncidents" ? "incidents" : "restore steps")),
    ].filter(Boolean);
    const first = pendingApprovals ? "/approvals" : others.find((item) => item.count > 0)?.row.href ?? "/approvals";
    tiles.push({
      key: "waiting", label: "Waiting on you", icon: "inbox",
      value: waiting.toLocaleString("en-GB"),
      detail: parts.length ? parts.join(", ") : "Nothing is waiting for you",
      href: first,
      tone: waiting ? "soon" : undefined,
    });
  }
  return tiles;
}

/** The approved-setup card's line: how many settings, when and by whom. */
export function setupLine(baseline: NonNullable<DashboardData["activeBaseline"]>, now: string): string {
  const by = baseline.setByRef?.name ? ` by ${baseline.setByRef.name}` : "";
  return `${plural(baseline.resourceCount, "setting", "settings")} · approved ${ago(baseline.setAt, now)}${by}`;
}

/** The last-backup card: when, and how the newest backup ended. */
export function backupLine(data: Pick<DashboardData, "lastCollection" | "lastCompletedCollectionAt" | "generatedAt">): { when: string; state: { tone: BadgeTone; label: string } | null } {
  const when = data.lastCompletedCollectionAt ? ago(data.lastCompletedCollectionAt, data.generatedAt).replace(/^./, (c) => c.toUpperCase()) : "Never";
  const status = data.lastCollection?.status;
  const state = !data.lastCollection ? null
    : status === "complete" ? { tone: "fine" as const, label: "Finished" }
      : status === "running" ? { tone: "low" as const, label: "Running now" }
        : { tone: "urgent" as const, label: "Did not finish" };
  return { when, state };
}

/** A day as "3 Sept", in UTC like the trend itself. */
export function trendDay(day: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

/** The trend's sentence and its peak, for the chart card and the full-screen view. */
export function trendSummary(points: DashboardData["driftTrend"]): { total: number; peak: { day: string; count: number } | null } {
  if (!points.length) return { total: 0, peak: null };
  const total = points.reduce((sum, point) => sum + point.count, 0);
  const peak = points.reduce((best, point) => (point.count > best.count ? point : best), points[0]);
  return { total, peak };
}
