import { fromNow } from "@/lib/presentation";

// Roadmap task-93: the approved emergency change as the portal reads it. Client-safe:
// no server or engine imports, so components can share the types and the verdict.
export const WINDOW_HOURS = [1, 4, 8, 24, 72, 168] as const;

export interface IntentSide { present: boolean; value: unknown }
export interface IntentTransition { field: string; before: IntentSide; after: IntentSide }
export interface IntentPerson { id: string; email: string | null; name: string | null; readable: boolean }
export interface ChangeIntent {
  id: string;
  naturalKey: string;
  resourceType: string;
  transitions: IntentTransition[];
  transitionDigest: string;
  owner: IntentPerson;
  approver: IntentPerson;
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
export interface IntentCandidate { driftId: string; naturalKey: string; resourceType: string; detectedAt: string | null; transitions: IntentTransition[] }
export interface ChangeIntentsData {
  intents: ChangeIntent[];
  changes: IntentCandidate[];
  people: { id: string; name: string }[];
  generatedAt: string;
}

/** The page's one sentence. Under 25 words, no codes. */
export function changeIntentsVerdict(intents: ChangeIntent[], now: string): { text: string; tone: "good" | "attention" } {
  const active = intents.filter((intent) => intent.state === "active");
  if (active.length === 0) return { text: "No emergency change is approved right now. KEEL rolls changes back as its policies say.", tone: "good" };
  const next = active.map((intent) => intent.revokedAt && intent.revokedAt < intent.windowEnd ? intent.revokedAt : intent.windowEnd).sort()[0];
  const count = active.length === 1 ? "One emergency change is" : `${active.length} emergency changes are`;
  return { text: `${count} approved right now; KEEL will not roll ${active.length === 1 ? "it" : "them"} back. The next approval ends ${fromNow(next, now)}.`, tone: "attention" };
}

