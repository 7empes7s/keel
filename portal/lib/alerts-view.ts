// Roadmap task-83: the alerts inbox's types and words. Client-safe: no engine or
// server imports, so the inbox component and the UI harness can use it.
import { resourceLabel } from "@/lib/presentation";

export type AlertState = "open" | "acknowledged" | "resolved" | "reopened" | "suppressed";

export interface AlertHistoryEntry {
  id: string;
  occurrence: number;
  fromState: AlertState | null;
  toState: AlertState;
  reason: string;
  actor: string;
  actorName: string | null;
  at: string;
  eventId: string | null;
}

export interface AlertItem {
  id: string;
  resourceKey: string;
  control: string;
  condition: string;
  state: AlertState;
  conditionActive: boolean;
  severity: "notice" | "warning" | "critical";
  occurrence: number;
  firstOpenedAt: string;
  occurrenceStartedAt: string;
  lastFiringAt: string;
  ackDeadlineAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  owner: { id: string; name: string } | null;
  escalated: boolean;
  escalationError: string | null;
  cause: { changeType: string | null; resourceType: string | null; snapshotId: string | null };
  lastEventId: string;
  history: AlertHistoryEntry[];
}

export interface AlertInboxData {
  generatedAt: string;
  alerts: AlertItem[];
}

export const ACTIVE_STATES: AlertState[] = ["open", "reopened", "acknowledged"];

export const STATE_LABELS: Record<AlertState, string> = {
  open: "Open",
  reopened: "Back again",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  suppressed: "Muted",
};

export const STATE_TONES: Record<AlertState, "bad" | "warn" | "neutral" | "ok"> = {
  open: "bad",
  reopened: "bad",
  acknowledged: "warn",
  resolved: "ok",
  suppressed: "neutral",
};

const REASON_LABELS: Record<string, string> = {
  "condition-firing": "Opened when the change was found",
  "condition-recurred": "Opened again: the change came back",
  "condition-recurred-flapping": "Opened again soon after clearing",
  "condition-resolved": "Resolved: the change went away",
  "resolution-held-flapping": "Kept open: it cleared too soon after the last check found it",
  acknowledged: "Acknowledged",
  "resolved-by-operator": "Resolved by hand",
  suppressed: "Muted",
  unsuppressed: "Unmuted",
  "escalated-ack-deadline-missed": "Escalated: nobody acknowledged it in time",
  "escalation-failed-no-recipient": "Could not escalate: no channel is set",
};

export function historyLabel(entry: AlertHistoryEntry): string {
  return REASON_LABELS[entry.reason] ?? "Changed";
}

const CHANGE_WORDS: Record<string, string> = {
  modified: "was changed from the baseline",
  added: "was added since the baseline",
  removed: "was removed since the baseline",
};

export function alertTitle(alert: Pick<AlertItem, "resourceKey">): string {
  return resourceLabel(alert.resourceKey);
}

/** The current cause in one plain sentence. */
export function causeSentence(alert: AlertItem): string {
  if (alert.control === "baseline" && alert.condition === "drift") {
    const change = CHANGE_WORDS[alert.cause.changeType ?? ""] ?? "differs from the baseline";
    return alert.conditionActive ? `It ${change}.` : "It matches the baseline again.";
  }
  return alert.conditionActive ? "It needs attention." : "It is back to normal.";
}

export function isOverdue(alert: AlertItem, now: string): boolean {
  return (alert.state === "open" || alert.state === "reopened")
    && alert.ackDeadlineAt !== null && new Date(alert.ackDeadlineAt).valueOf() <= new Date(now).valueOf();
}

/** Open and unacknowledged first, soonest deadline first; then acknowledged; then the rest. */
export function inboxOrder(alerts: AlertItem[]): AlertItem[] {
  const rank = (alert: AlertItem) => (alert.state === "open" || alert.state === "reopened" ? 0 : alert.state === "acknowledged" ? 1 : 2);
  const deadline = (alert: AlertItem) => (alert.ackDeadlineAt ? new Date(alert.ackDeadlineAt).valueOf() : Number.MAX_SAFE_INTEGER);
  return [...alerts].sort((a, b) => rank(a) - rank(b) || deadline(a) - deadline(b) || b.lastFiringAt.localeCompare(a.lastFiringAt));
}

export function alertsVerdict(alerts: AlertItem[], now: string): { text: string; tone: "good" | "attention" | "critical" } {
  const waiting = alerts.filter((alert) => alert.state === "open" || alert.state === "reopened");
  const overdue = waiting.filter((alert) => isOverdue(alert, now)).length;
  const acknowledged = alerts.filter((alert) => alert.state === "acknowledged").length;
  if (waiting.length === 0 && acknowledged === 0) {
    return { text: "No open alerts. KEEL resolves an alert itself when the change it reported goes away.", tone: "good" };
  }
  if (waiting.length === 0) {
    return { text: `${acknowledged} ${acknowledged === 1 ? "alert is" : "alerts are"} acknowledged and still open; nothing is waiting for someone.`, tone: "attention" };
  }
  const head = `${waiting.length} ${waiting.length === 1 ? "alert needs" : "alerts need"} someone to acknowledge ${waiting.length === 1 ? "it" : "them"}`;
  return overdue
    ? { text: `${head}; ${overdue} ${overdue === 1 ? "is" : "are"} past the deadline.`, tone: "critical" }
    : { text: `${head}.`, tone: "attention" };
}
