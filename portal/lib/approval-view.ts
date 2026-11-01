// The Approvals page in words (portal audit, Approvals, pick B: one card per request,
// opened in place). Pure helpers, so the page's counts, tones, titles and messages are
// tested without a browser. Ids never appear in anything these return.
import type { IconName } from "@/components/shell/icons";
import type { BadgeTone } from "@/components/ui/badge";
import type { UnnamedReference } from "@/lib/app-names";
import type { ApprovalRequestRecord } from "@/lib/approval-inbox";
import type { ApprovalModeName } from "@/lib/approval-words";
import type { RiskTone } from "@/lib/menu-status";
import { formatTimestamp } from "@/lib/presentation";
import { approvalSentence, personLabel } from "@/lib/sentences";

export type ApprovalKind = "restore" | "undo" | "rollback" | "decision" | "setup" | "other";

export const KIND_WORDS: Record<ApprovalKind, { label: string; plural: string; icon: IconName; about: string; verb: string }> = {
  restore: { label: "Restore", plural: "Restores", icon: "restore", about: "Put settings back from a backup", verb: "the restore" },
  undo: { label: "Undo of a restore", plural: "Undo a restore", icon: "swap", about: "Put back what a restore changed", verb: "the undo" },
  rollback: { label: "Undo change", plural: "Undo changes", icon: "swap", about: "Put changed settings back as the approved setup holds them", verb: "the undo" },
  decision: { label: "Change decision", plural: "Change decisions", icon: "baselines", about: "Accept or ignore a change to sign-in or admin access", verb: "the decision" },
  setup: { label: "Approved-setup switch", plural: "Approved-setup switches", icon: "baselines", about: "Make another setup the one Keel checks against", verb: "the switch" },
  other: { label: "Request", plural: "Other requests", icon: "inbox", about: "Other requests", verb: "it" },
};

export function approvalKind(request: Pick<ApprovalRequestRecord, "action" | "references">): ApprovalKind {
  switch (request.action) {
    case "restore": return request.references?.plan?.readable && request.references.plan.undo ? "undo" : "restore";
    case "remediate": return "rollback";
    case "dispose": return "decision";
    case "baseline-activate": return "setup";
    default: return "other";
  }
}

export const KIND_ORDER: ApprovalKind[] = ["restore", "undo", "rollback", "decision", "setup", "other"];

/** The request's title: what approving it does, with names. */
export function approvalTitle(request: Pick<ApprovalRequestRecord, "action" | "params" | "references">): string {
  return approvalSentence(request);
}

/**
 * Each request's title, made unique: requests that would read the same get the moment
 * they were asked ("… · asked 31 Oct 2026, 17:41 UTC"), and a number if that matches too,
 * so a list never shows two identical lines.
 */
export function distinctTitles(requests: Pick<ApprovalRequestRecord, "id" | "action" | "params" | "references" | "createdAt">[]): Map<string, string> {
  const base = new Map(requests.map((request) => [request.id, approvalTitle(request)]));
  const groups = new Map<string, typeof requests>();
  for (const request of requests) {
    const title = base.get(request.id)!;
    groups.set(title, [...(groups.get(title) ?? []), request]);
  }
  const titles = new Map<string, string>();
  for (const [title, group] of groups) {
    if (group.length === 1) { titles.set(group[0].id, title); continue; }
    const timed = group.map((request) => ({ id: request.id, title: `${title} · asked ${formatTimestamp(request.createdAt)}`, at: request.createdAt ?? "" }));
    const seen = new Map<string, number>();
    for (const entry of timed) seen.set(entry.title, (seen.get(entry.title) ?? 0) + 1);
    const numbered = new Map<string, number>();
    for (const entry of [...timed].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
      if ((seen.get(entry.title) ?? 0) < 2) { titles.set(entry.id, entry.title); continue; }
      const n = (numbered.get(entry.title) ?? 0) + 1;
      numbered.set(entry.title, n);
      titles.set(entry.id, `${entry.title} (${n})`);
    }
  }
  return titles;
}

/**
 * What a request's changes point to that no backup names (a role, who holds it, where),
 * once each, so Technical details lists every ID with a link that looks it up.
 */
export function approvalUnnamedRefs(request: Pick<ApprovalRequestRecord, "references" | "preview">): UnnamedReference[] {
  const out = new Map<string, UnnamedReference>();
  const lists = [...(request.references?.changes ?? []).map((change) => change?.unnamedRefs), ...(request.preview?.changes ?? []).map((change) => change.unnamedRefs)];
  for (const refs of lists) for (const ref of refs ?? []) if (!out.has(ref.id)) out.set(ref.id, ref);
  return [...out.values()];
}

const HOUR = 3_600_000;
export const EXPIRING_SOON_HOURS = 4;

export function hoursLeft(request: Pick<ApprovalRequestRecord, "expiresAt">, now: string): number | null {
  if (!request.expiresAt) return null;
  const left = (new Date(request.expiresAt).valueOf() - new Date(now).valueOf()) / HOUR;
  return Number.isFinite(left) ? left : null;
}

export function expiringSoon(request: Pick<ApprovalRequestRecord, "expiresAt">, now: string): boolean {
  const left = hoursLeft(request, now);
  return left !== null && left > 0 && left <= EXPIRING_SOON_HOURS;
}

/** "3 h left", "22 h left", "2 days left", "Expired". */
export function timeLeft(request: Pick<ApprovalRequestRecord, "expiresAt">, now: string): string {
  const left = hoursLeft(request, now);
  if (left === null) return "No expiry";
  if (left <= 0) return "Expired";
  const minutes = Math.ceil(left * 60);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.round(left);
  if (hours < 48) return `${hours} h left`;
  return `${Math.round(hours / 24)} days left`;
}

const IMPACT: Record<string, { tone: BadgeTone; label: string; icon: IconName }> = {
  "tenant-lockout": { tone: "urgent", label: "Could lock out admins", icon: "alert" },
  "access-affecting": { tone: "soon", label: "Changes who can sign in", icon: "alert" },
  cosmetic: { tone: "low", label: "Cosmetic only", icon: "info" },
};
const IMPACT_ORDER = ["tenant-lockout", "access-affecting", "cosmetic"];

/** The worst impact of the changes a request would undo, as a badge; null when unknown. */
export function impactBadge(request: Pick<ApprovalRequestRecord, "references">): { tone: BadgeTone; label: string; icon: IconName } | null {
  const radii = (request.references?.changes ?? []).map((change) => change?.blastRadius).filter((value): value is string => Boolean(value));
  const worst = IMPACT_ORDER.find((radius) => radii.includes(radius));
  return worst ? IMPACT[worst] : null;
}

/** The row's risk stripe: urgent when it expires within 4 hours or could lock admins
 * out, soon when it changes access or is a restore, low otherwise. */
export function requestTone(request: Pick<ApprovalRequestRecord, "expiresAt" | "references" | "status" | "action">, now: string): RiskTone {
  if (request.status !== "pending") return "fine";
  if (expiringSoon(request, now)) return "urgent";
  const impact = impactBadge(request);
  if (impact?.tone === "urgent") return "urgent";
  if (impact?.tone === "soon") return "soon";
  return approvalKind(request) === "setup" ? "low" : "soon";
}

export function outcomeBadge(request: Pick<ApprovalRequestRecord, "status">): { tone: BadgeTone; label: string; icon: IconName } {
  switch (request.status) {
    case "approved": return { tone: "fine", label: "Approved", icon: "check-circle" };
    case "rejected": return { tone: "urgent", label: "Rejected", icon: "x-circle" };
    case "expired": return { tone: "neutral", label: "Expired", icon: "clock" };
    default: return { tone: "soon", label: "Waiting", icon: "clock" };
  }
}

export interface ApprovalCounts {
  // Requests this viewer can decide now: the "waiting for you" number everywhere.
  waiting: number;
  // Requests that wait on someone else: the viewer already signed them, or asked for
  // them while approvals need two people.
  waitingOnOthers: number;
  expiringSoon: number;
  contentEffects: number;
  decidedThisWeek: { approved: number; rejected: number; expired: number };
}

const WEEK = 7 * 24 * HOUR;

/**
 * Whether this viewer can decide a waiting request. One rule for the page, the badge
 * and the Overview, so "waiting for you" means the same everywhere. It follows the
 * tenant's approval mode (engine/govern/approvalMode.mjs): while approvals need two
 * people the engine refuses an approver's own request, and in Solo the requester may
 * approve it. In either mode, an approver who already signed a request that needs more
 * than one approver waits for the next one. With no viewer known, every request counts.
 */
export function viewerCanDecide(
  request: { requestedBy: string; status?: string; signoffs?: { id: string }[] },
  viewerId: string | null,
  approvalMode: ApprovalModeName = "two-person",
): boolean {
  if (viewerId === null) return true;
  if (request.requestedBy === viewerId) return approvalMode === "solo";
  if (request.status === "pending" && (request.signoffs ?? []).some((person) => person.id === viewerId)) return false;
  return true;
}

/** Waiting requests split into the ones this viewer decides and the ones others do. */
export function splitWaiting<T extends { requestedBy: string; status?: string; signoffs?: { id: string }[] }>(requests: readonly T[], viewerId: string | null, approvalMode: ApprovalModeName = "two-person"): { forYou: T[]; onOthers: T[] } {
  const forYou: T[] = [];
  const onOthers: T[] = [];
  for (const request of requests) (viewerCanDecide(request, viewerId, approvalMode) ? forYou : onOthers).push(request);
  return { forYou, onOthers };
}

export function approvalCounts(data: { pending: ApprovalRequestRecord[]; awaitingContentEffects: ApprovalRequestRecord[]; history: ApprovalRequestRecord[] }, now: string, viewerId: string | null = null, approvalMode: ApprovalModeName = "two-person"): ApprovalCounts {
  const since = new Date(now).valueOf() - WEEK;
  const decidedAt = (request: ApprovalRequestRecord) => new Date(request.decidedAt ?? request.expiresAt ?? 0).valueOf();
  const week = data.history.filter((request) => decidedAt(request) >= since);
  const pending = splitWaiting(data.pending, viewerId, approvalMode);
  const effects = splitWaiting(data.awaitingContentEffects, viewerId, approvalMode);
  return {
    waiting: pending.forYou.length + effects.forYou.length,
    waitingOnOthers: pending.onOthers.length + effects.onOthers.length,
    expiringSoon: pending.forYou.filter((request) => expiringSoon(request, now)).length,
    contentEffects: effects.forYou.length,
    decidedThisWeek: {
      approved: week.filter((request) => request.status === "approved").length,
      rejected: week.filter((request) => request.status === "rejected").length,
      expired: week.filter((request) => request.status === "expired").length,
    },
  };
}

export type WaitingSort = "expiring" | "newest";

export function sortWaiting<T extends Pick<ApprovalRequestRecord, "expiresAt" | "createdAt">>(items: readonly T[], sort: WaitingSort): T[] {
  const time = (value: string | null) => (value ? Date.parse(value) : Number.NaN);
  return [...items].sort((a, b) => sort === "expiring"
    ? (time(a.expiresAt) || Infinity) - (time(b.expiresAt) || Infinity)
    : (time(b.createdAt) || 0) - (time(a.createdAt) || 0));
}

/** The verdict, in at most 25 words. */
export function approvalsVerdict(counts: ApprovalCounts, oldest: ApprovalRequestRecord | null, now: string, approvalMode: ApprovalModeName = "two-person"): { text: string; tone: "soon" | "urgent" | "fine"; detail: string } {
  if (counts.waiting === 0) {
    const others = counts.waitingOnOthers;
    const it = others === 1 ? "it" : "them";
    const why = approvalMode === "solo" ? `you already approved ${it}, and another approver must too` : `you asked for ${it}, or already approved`;
    return others
      ? { text: "Nothing is waiting for your decision.", tone: "fine", detail: `${others === 1 ? "1 request waits" : `${others} requests wait`} on someone else: ${why}. See Waiting on others.` }
      : { text: "Nothing is waiting for your decision.", tone: "fine", detail: "Restores, undo changes and approved-setup switches will appear here when someone asks for one." };
  }
  const count = counts.waiting === 1 ? "1 request is" : `${counts.waiting} requests are`;
  const left = oldest ? hoursLeft(oldest, now) : null;
  const inWords = left === null ? "soon" : left < 1 ? `in ${Math.max(1, Math.ceil(left * 60))} minutes` : `in ${Math.round(left)} ${Math.round(left) === 1 ? "hour" : "hours"}`;
  const soon = counts.expiringSoon === 0 ? "" : counts.expiringSoon === 1 ? ` One expires ${inWords}.` : ` ${counts.expiringSoon} expire within ${EXPIRING_SOON_HOURS} hours.`;
  return {
    text: `${count} waiting for you.${soon}`,
    tone: counts.expiringSoon ? "urgent" : "soon",
    detail: approvalMode === "solo"
      ? "Nothing changes until it is approved. Approval mode is Solo, so you can approve your own requests; each is marked self-approved."
      : "Nothing changes until someone other than the person who asked approves.",
  };
}

export function approvalsStatus(counts: ApprovalCounts): { tone: RiskTone; label: string } {
  if (counts.waiting === 0) return { tone: "fine", label: "Nothing waiting" };
  return { tone: counts.expiringSoon ? "urgent" : "soon", label: `${counts.waiting} waiting` };
}

/** Why a decision was refused, in words next to the button. */
export function decisionError(status: number, payload: { error?: string; handoff?: string } | null): string {
  if (status === 403) return payload?.handoff ? "This request is outside the areas you approve for. A tenant-wide approver must decide it." : "You asked for this, so someone else must decide it: approvals need two people.";
  if (status === 409 && payload?.error === "no_change") return "Nothing to roll back: the setting already holds the same values as the approved setup. Reject this request.";
  if (status === 409) return "Someone else decided it first, or it expired. The list will refresh.";
  if (status === 404) return "This request no longer exists. The list will refresh.";
  if (status === 400 && payload?.error === "reason_required") return "Approving your own request needs a reason that says why, in a few words.";
  if (status === 400) return "Write a reason to reject.";
  return "Keel could not record the decision. Try again in a moment.";
}

export interface ApproveOutcome {
  title: string;
  detail?: string;
  href?: string;
  hrefLabel?: string;
  // True when the request still waits for another approver.
  pending: boolean;
}

/** What the approve answer means for the person: started, recorded or handed over. */
export function approveOutcome(
  request: Pick<ApprovalRequestRecord, "action" | "params" | "references" | "executor">,
  payload: { job?: { id?: string } | null; signoffs?: number | null; requiredApprovals?: number | null },
): ApproveOutcome {
  const kind = approvalKind(request);
  const required = payload.requiredApprovals ?? 1;
  const recorded = payload.signoffs ?? 0;
  if (!payload.job && required > 1 && recorded < required) {
    return { title: `${recorded} of ${required} approvals recorded`, detail: `${required - recorded === 1 ? "One more approver" : `${required - recorded} more approvers`} must approve before ${KIND_WORDS[kind].verb} runs.`, pending: true };
  }
  if (payload.job?.id) {
    const started = kind === "setup" ? "Switch started" : kind === "rollback" ? "Undo started" : kind === "undo" ? "Undo started" : "Restore started";
    return { title: started, detail: approvalTitle(request), href: `/jobs/${payload.job.id}`, hrefLabel: "Watch it", pending: false };
  }
  if (request.executor === "cli") return { title: "Approved", detail: "An operator runs it from the command line; nothing starts here.", pending: false };
  return { title: "Approved", detail: approvalTitle(request), pending: false };
}

/** Where the request leads: the full preview, the approved setup, the changes. */
export function subjectLinks(request: ApprovalRequestRecord): { href: string; label: string; icon: IconName }[] {
  const refs = request.references;
  const links: { href: string; label: string; icon: IconName }[] = [];
  if (refs?.plan?.readable && refs.plan.dryRunJobId) links.push({ href: `/jobs/${refs.plan.dryRunJobId}`, label: "Open the full preview", icon: "show" });
  if (refs?.baseline?.readable) links.push({ href: `/baselines?q=${encodeURIComponent(refs.baseline.name ?? "")}`, label: "View the approved setup", icon: "baselines" });
  if (refs?.changes?.length) links.push({ href: "/drift", label: "Review the changes", icon: "swap" });
  return links;
}

/** "Lee Chen and Sam Ortiz" */
export function peopleList(people: { name: string | null; readable: boolean; id: string; kind: string }[]): string {
  const names = people.map((person) => personLabel(person));
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
