import type { AlertItem } from "@/components/ui/alert-list";
import type { StatTile } from "@/components/ui/stat-tiles";
import { namedResource } from "@/lib/job-names";
import { formatTimestamp, fromNow } from "@/lib/presentation";

// Roadmap task-93: the approved emergency change as the portal reads it. Client-safe:
// no server or engine imports, so components can share the types and the verdict.
export const WINDOW_HOURS = [1, 4, 8, 24, 72, 168] as const;

export interface IntentSide { present: boolean; value: unknown }
export interface IntentTransition {
  field: string;
  before: IntentSide;
  after: IntentSide;
  /** Only an empty value against a missing one, or only list order, differs: not shown. */
  noChange?: boolean;
}

/** The transitions a person reads: no-change ones are left out. */
export const shownTransitions = (transitions: IntentTransition[]) => transitions.filter((transition) => !transition.noChange);
export interface IntentPerson { id: string; email: string | null; name: string | null; readable: boolean }
export interface ChangeIntent {
  id: string;
  naturalKey: string;
  resourceType: string;
  /** The resource's saved name, filled in by the page's loader; never shown as an id. */
  name?: string | null;
  transitions: IntentTransition[];
  transitionDigest: string;
  owner: IntentPerson;
  approver: IntentPerson;
  /** The owner approved it themselves, under solo approval mode. */
  selfApproved?: boolean;
  reason: string;
  externalChangeId: string | null;
  sourceDriftId: string | null;
  windowStart: string;
  windowEnd: string;
  approvedAt: string;
  decisionDigest: string;
  revokedAt: string | null;
  revokedBy: IntentPerson | null;
  revokeReason: string | null;
  settledAt: string | null;
  settlement: { endedAt: string; currentState: string; snapshotId: string | null; observedAt: string | null; driftId: string | null } | null;
  state: "scheduled" | "active" | "revoked" | "ended";
}
export interface IntentCandidate { driftId: string; naturalKey: string; resourceType: string; name?: string | null; detectedAt: string | null; transitions: IntentTransition[] }
export interface ChangeIntentsData {
  intents: ChangeIntent[];
  changes: IntentCandidate[];
  people: { id: string; name: string }[];
  generatedAt: string;
}

/** What an approval or an open change is about, by name: "Finance (group)", never an id. */
export function intentResource(item: { naturalKey: string; resourceType: string; name?: string | null }): string {
  return namedResource(item.naturalKey, { [item.naturalKey]: { name: item.name ?? null, resourceType: item.resourceType } }, item.resourceType);
}

/** The page's one sentence. Under 25 words, no codes. */
export function changeIntentsVerdict(intents: ChangeIntent[], now: string): { text: string; tone: "good" | "attention" } {
  const active = intents.filter((intent) => intent.state === "active");
  if (active.length === 0) return { text: "No emergency change is approved right now. KEEL rolls changes back as its policies say.", tone: "good" };
  const next = active.map((intent) => intent.revokedAt && intent.revokedAt < intent.windowEnd ? intent.revokedAt : intent.windowEnd).sort()[0];
  const count = active.length === 1 ? "One emergency change is" : `${active.length} emergency changes are`;
  return { text: `${count} approved right now; KEEL will not roll ${active.length === 1 ? "it" : "them"} back. The next approval ends ${fromNow(next, now)}.`, tone: "attention" };
}


// The redesigned page: alerts first, four tiles, live approvals as cards with each
// approved setting before and after, and ended approvals in one compact table.

export type IntentTone = "urgent" | "soon" | "low" | "fine" | "neutral";

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

/** When an approval stops holding back the roll back: its end, or its revoke if earlier. */
export function intentEnd(intent: ChangeIntent): string {
  return intent.revokedAt && intent.revokedAt < intent.windowEnd ? intent.revokedAt : intent.windowEnd;
}

/** The approval's state as a badge. Amber while KEEL is holding a roll back off. */
export function intentBadge(intent: ChangeIntent): { tone: IntentTone; label: string } {
  switch (intent.state) {
    case "active": return { tone: "soon", label: "In force" };
    case "scheduled": return { tone: "low", label: "Starts later" };
    case "revoked": return { tone: "neutral", label: "Revoked" };
    default: return { tone: "neutral", label: "Ended" };
  }
}

/** What KEEL found when it checked the resource again after the approval ended. */
export const SETTLED_BADGES: Record<string, { tone: IntentTone; label: string; about: string }> = {
  "matches-baseline": { tone: "fine", label: "Back to baseline", about: "Nothing was rolled back." },
  drifted: { tone: "soon", label: "Still changed", about: "Its policies acted on it as usual." },
  ignored: { tone: "neutral", label: "Change ignored", about: "Nothing was rolled back." },
  "awaiting-detection": { tone: "low", label: "Not checked yet", about: "The next check decides." },
  unknown: { tone: "neutral", label: "Nothing to compare", about: "No baseline or backup of this kind." },
};

export function settledBadge(intent: ChangeIntent): { tone: IntentTone; label: string; about: string } | null {
  if (!intent.settlement) return null;
  return SETTLED_BADGES[intent.settlement.currentState] ?? SETTLED_BADGES.unknown;
}

function settings(count: number): string {
  return `${count} setting${count === 1 ? "" : "s"}`;
}

/** What needs the reader, worst first: an approval about to end, a change still there
 *  after its approval ended, then approvals in force and approvals waiting to start. */
export function intentAlerts(data: Pick<ChangeIntentsData, "intents" | "generatedAt">): AlertItem[] {
  const now = data.generatedAt;
  const nowMs = Date.parse(now);
  const soon: AlertItem[] = [];
  const low: AlertItem[] = [];
  for (const intent of data.intents) {
    const resource = intentResource(intent);
    const href = `#intent-${intent.id}`;
    if (intent.state === "active") {
      const endsSoon = Date.parse(intent.windowEnd) - nowMs <= HOUR;
      (endsSoon ? soon : low).push({
        key: `active-${intent.id}`, tone: endsSoon ? "soon" : "low", icon: "pause",
        title: `${resource} is not rolled back until ${formatTimestamp(intent.windowEnd)} (${fromNow(intent.windowEnd, now)})`,
        todo: endsSoon ? "Finish the work now, or approve it again if it needs longer." : "Revoke the approval as soon as the work is done.",
        action: { label: "Review", href },
      });
    } else if (intent.state === "scheduled") {
      low.push({
        key: `scheduled-${intent.id}`, tone: "low", icon: "calendar",
        title: `An approval for ${resource} starts ${fromNow(intent.windowStart, now)}`,
        todo: "Nothing yet. Revoke it if the work is cancelled.",
        action: { label: "Review", href },
      });
    } else if (intent.settlement && nowMs - Date.parse(intent.settledAt ?? intent.settlement.endedAt) <= WEEK) {
      if (intent.settlement.currentState === "drifted") {
        soon.push({
          key: `still-changed-${intent.id}`, tone: "soon", icon: "alert",
          title: `${resource} is still changed after its approval ended`,
          todo: "Review it on Changes, then restore it or accept it.",
          action: { label: "Open Changes", href: "/drift" },
        });
      } else if (intent.settlement.currentState === "awaiting-detection") {
        low.push({
          key: `unchecked-${intent.id}`, tone: "low", icon: "clock",
          title: `${resource} has not been checked since its approval ended`,
          todo: "Nothing yet. The next check decides what happens to it.",
          action: null,
        });
      }
    }
  }
  return [...soon, ...low];
}

/** Four tiles: in force, next to end, waiting to start, and open changes to approve. */
export function intentTiles(data: ChangeIntentsData): StatTile[] {
  const now = data.generatedAt;
  const active = data.intents.filter((intent) => intent.state === "active");
  const scheduled = data.intents.filter((intent) => intent.state === "scheduled");
  const ended = data.intents.filter((intent) => intent.state === "revoked" || intent.state === "ended");
  const next = active.map(intentEnd).sort()[0] ?? null;
  return [
    { key: "active", label: "In force", icon: "pause", value: String(active.length), tone: active.length ? "soon" : "fine",
      about: active.length ? `${settings(active.reduce((sum, intent) => sum + shownTransitions(intent.transitions).length, 0))} not rolled back` : "Changes roll back as usual", href: "#ec-approved" },
    { key: "next", label: "Next to end", icon: "clock", value: next ? fromNow(next, now) : "None", tone: next ? (Date.parse(next) - Date.parse(now) <= HOUR ? "soon" : "low") : "neutral",
      about: next ? formatTimestamp(next) : "Nothing is approved", href: "#ec-approved" },
    { key: "scheduled", label: "Starts later", icon: "calendar", value: String(scheduled.length), tone: scheduled.length ? "low" : "neutral",
      about: scheduled.length ? "Approved ahead of time" : "None approved ahead", href: "#ec-approved" },
    { key: "open", label: "Open changes", icon: "swap", value: String(data.changes.length), tone: "neutral",
      about: data.changes.length ? "Can be approved below" : `${ended.length} ended approval${ended.length === 1 ? "" : "s"} kept`, href: data.changes.length ? "#ec-approve" : "#ec-ended" },
  ];
}

/** The header pill. */
export function intentsStatus(intents: ChangeIntent[]): { tone: "soon" | "fine"; label: string } {
  const active = intents.filter((intent) => intent.state === "active").length;
  return active ? { tone: "soon", label: `${active} in force` } : { tone: "fine", label: "None in force" };
}
