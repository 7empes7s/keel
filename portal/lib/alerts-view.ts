// Roadmap task-83: the alerts inbox's types and words. Client-safe: no engine or
// server imports, so the inbox component and the UI harness can use it.
import { workloadLabel, WORKLOAD_LABELS } from "@/lib/compare-view";
import { holdsObjectId, namedResource } from "@/lib/job-names";

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
  // The name the newest backup or workload read holds for the resource, or null.
  // Looked up by the server (lib/alerts.ts); the key itself stays in Technical details.
  name: string | null;
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

// Workload settings (SharePoint) have no baseline: each read is compared with the
// read before it (engine/govern/workloadDrift.mjs).
const WORKLOAD_CHANGE_WORDS: Record<string, string> = {
  modified: "Its settings changed since the previous read.",
  added: "It is new since the previous read.",
  removed: "It was missing from the latest read.",
};

const SHAREPOINT_SITES = "sharepoint-site-settings";

/** The workload a key belongs to ("sharepoint-site-settings:site:<id>"), or null for
 * a key from a backup. Workload drift alerts are keyed `<workload>:<resource key>`. */
export function alertWorkload(resourceKey: string): string | null {
  const index = resourceKey.indexOf(":");
  const prefix = index === -1 ? resourceKey : resourceKey.slice(0, index);
  return Object.hasOwn(WORKLOAD_LABELS, prefix) ? prefix : null;
}

function usable(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed && !holdsObjectId(trimmed) ? trimmed : null;
}

/** What an alert is about, by name: "Finance (SharePoint site)", "Block legacy auth
 * (Conditional Access policy)" or "Unnamed group". Never an object id. */
export function alertTitle(alert: Pick<AlertItem, "resourceKey"> & Partial<Pick<AlertItem, "name" | "cause">>): string {
  const key = alert.resourceKey;
  const name = usable(alert.name);
  const workload = alertWorkload(key);
  if (workload) {
    const rest = key.slice(workload.length + 1);
    if (workload === SHAREPOINT_SITES) {
      if (rest === "tenant") return "SharePoint sharing settings";
      return name ? `${name} (SharePoint site)` : "Unnamed SharePoint site";
    }
    const label = workloadLabel(workload);
    if (name) return `${name} (${label})`;
    if (!rest || rest === "tenant" || rest === "organization") return label;
    const fromKey = rest.replaceAll(":", " · ");
    return holdsObjectId(fromKey) ? `Unnamed item in ${label}` : `${fromKey} (${label})`;
  }
  const resourceType = alert.cause?.resourceType ?? null;
  if (!name) return namedResource(key, {}, resourceType);
  const index = key.indexOf(":");
  const typeFromKey = index > 0 && !holdsObjectId(key.slice(0, index)) ? key.slice(0, index) : null;
  return namedResource(key, { [key]: { name, resourceType: resourceType ?? typeFromKey ?? "setting" } });
}

/** The current cause in one plain sentence. */
export function causeSentence(alert: AlertItem): string {
  if (alert.control === "baseline" && alert.condition === "drift") {
    if (alertWorkload(alert.resourceKey)) {
      return WORKLOAD_CHANGE_WORDS[alert.cause.changeType ?? ""] ?? "Its settings changed since the previous read.";
    }
    const change = CHANGE_WORDS[alert.cause.changeType ?? ""] ?? "differs from the baseline";
    return alert.conditionActive ? `It ${change}.` : "It matches the baseline again.";
  }
  // Task 94: emergency account alerts, resolved by a person after review.
  if (alert.control === "break-glass") {
    if (!alert.conditionActive) return "It was reviewed and closed.";
    if (alert.condition === "emergency-account-used") return "This emergency account was used. Check that it was planned.";
    if (alert.condition === "validation-due") return "Its emergency sign-in test is due.";
    if (alert.condition === "rotation-due") return "Its credential review is due.";
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
