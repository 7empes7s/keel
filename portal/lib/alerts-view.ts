// Roadmap task-83: the alerts inbox's types and words. Client-safe: no engine or
// server imports, so the inbox component and the UI harness can use it.
import type { IconName } from "@/components/shell/icons";
import type { BadgeTone } from "@/components/ui/badge";
import { itemService, typeService } from "@/lib/baselines-view";
import { workloadLabel, WORKLOAD_LABELS } from "@/lib/compare-view";
import { holdsObjectId, namedResource } from "@/lib/job-names";
import type { RiskTone } from "@/lib/menu-status";
import type { ObjectFacts } from "@/lib/object-label";
import { resourceTypeLabel } from "@/lib/presentation";
import type { CloudService } from "@/lib/services";

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
  // The note or reason the person wrote with it (acknowledge, resolve, mute), if any.
  note?: string | null;
}

export interface AlertItem {
  id: string;
  resourceKey: string;
  // The name the newest backup or workload read holds for the resource, or null.
  // Looked up by the server (lib/alerts.ts); the key itself stays in Technical details.
  name: string | null;
  // Whether the newest backup still holds it, and when it went (engine/insights/names.mjs).
  // Null for service settings read outside backups, and when the lookup failed.
  object?: ObjectFacts | null;
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
  // pseudonym: "Hide people's names" is on and name is a code name.
  owner: { id: string; name: string; pseudonym?: boolean } | null;
  escalated: boolean;
  escalationError: string | null;
  cause: { changeType: string | null; resourceType: string | null; snapshotId: string | null };
  // The settings catalog template family the newest backup holds for the resource, when
  // it has one: an endpoint security policy made in Intune is a Defender setting.
  templateFamily?: string | null;
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

// "Approved setup" is the reader's word for a baseline (redesign rule 3).
const CHANGE_WORDS: Record<string, string> = {
  modified: "differs from the approved setup",
  added: "is new since the approved setup was saved",
  removed: "was removed since the approved setup was saved",
};

// Service settings (Exchange, SharePoint, Teams, ...) are compared with the service's
// own approved setup (engine/govern/workloadDrift.mjs).
const WORKLOAD_CHANGE_WORDS: Record<string, string> = {
  modified: "Its settings differ from the approved setup.",
  added: "It is new since the approved setup.",
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
  const index = key.indexOf(":");
  const typeFromKey = index > 0 && !holdsObjectId(key.slice(0, index)) ? key.slice(0, index) : null;
  const title = name
    ? namedResource(key, { [key]: { name, resourceType: resourceType ?? typeFromKey ?? "setting" } })
    : namedResource(key, {}, resourceType);
  // Plain kind words for the Microsoft terms: "(sign-in rule)", not "(Conditional Access policy)".
  const type = resourceType ?? typeFromKey;
  const plain = type ? PLAIN_KIND_WORDS[type] : undefined;
  return plain ? title.replace(resourceTypeLabel(type!), plain) : title;
}

const PLAIN_KIND_WORDS: Record<string, string> = {
  conditionalAccessPolicy: "sign-in rule",
  namedLocation: "trusted location",
};

/** The current cause in one plain sentence. */
export function causeSentence(alert: AlertItem): string {
  if (alert.control === "baseline" && alert.condition === "drift") {
    if (alertWorkload(alert.resourceKey)) {
      return WORKLOAD_CHANGE_WORDS[alert.cause.changeType ?? ""] ?? "Its settings differ from the approved setup.";
    }
    const change = CHANGE_WORDS[alert.cause.changeType ?? ""] ?? "differs from the approved setup";
    return alert.conditionActive ? `It ${change}.` : "It matches the approved setup again.";
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

/**
 * The note left when this occurrence was acknowledged, or null. It lives in the
 * alert's history; an earlier occurrence's note does not carry over.
 */
export function acknowledgeNote(alert: Pick<AlertItem, "state" | "occurrence" | "history">): string | null {
  if (alert.state !== "acknowledged") return null;
  for (let index = alert.history.length - 1; index >= 0; index -= 1) {
    const entry = alert.history[index];
    if (entry.toState === "acknowledged" && entry.reason === "acknowledged") return entry.occurrence === alert.occurrence ? entry.note ?? null : null;
  }
  return null;
}

/**
 * What the page shows right after its own acknowledge, resolve or mute, until the
 * server's next read: the new state, the acknowledger as owner and the note in the
 * history. The banner, tiles and header pill all count this one list.
 */
// `acknowledged` marks the page's own acknowledge; an unmute that lands on "acknowledged" changes the state only.
export interface LocalChange { state: AlertState; acknowledged?: boolean; owner?: AlertItem["owner"]; note?: string | null; at: string; by: string }

export function withLocalChanges(alerts: AlertItem[], changes: Record<string, LocalChange>): AlertItem[] {
  return alerts.map((alert) => {
    const change = changes[alert.id];
    if (!change || change.state === alert.state) return alert;
    if (change.state !== "acknowledged" || !change.acknowledged) return { ...alert, state: change.state };
    return {
      ...alert,
      state: change.state,
      acknowledgedAt: alert.acknowledgedAt ?? change.at,
      acknowledgedByName: alert.acknowledgedByName ?? change.by,
      owner: change.owner ?? alert.owner,
      history: [...alert.history, {
        id: `local-${alert.id}`, occurrence: alert.occurrence, fromState: alert.state, toState: "acknowledged", reason: "acknowledged",
        actor: "", actorName: change.by, at: change.at, eventId: null, note: change.note?.trim() || null,
      }],
    };
  });
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

// ---- The Alerts page (portal audit, one design): words, counts, filters and links.

export const SEVERITY: Record<AlertItem["severity"], { label: string; tone: RiskTone; icon: IconName }> = {
  critical: { label: "Critical", tone: "urgent", icon: "alert" },
  warning: { label: "Warning", tone: "soon", icon: "clock" },
  notice: { label: "Notice", tone: "low", icon: "info" },
};
export const SEVERITY_ORDER: AlertItem["severity"][] = ["critical", "warning", "notice"];

// The state as a plain word with an icon. Colour means risk only (rule 1), so the
// state badge is neutral; the severity carries the colour.
export const STATE_WORDS: Record<AlertState, { label: string; plural: string; icon: IconName; tone: BadgeTone }> = {
  open: { label: "Waiting", plural: "Needs someone", icon: "clock", tone: "neutral" },
  reopened: { label: "Back again", plural: "Needs someone", icon: "refresh", tone: "neutral" },
  acknowledged: { label: "Acknowledged", plural: "Acknowledged", icon: "check", tone: "neutral" },
  resolved: { label: "Resolved", plural: "Resolved", icon: "check-circle", tone: "neutral" },
  suppressed: { label: "Muted", plural: "Muted", icon: "pause", tone: "neutral" },
};

export type StateGroup = "waiting" | "acknowledged" | "resolved" | "muted";
export const STATE_GROUP_ORDER: StateGroup[] = ["waiting", "acknowledged", "resolved", "muted"];
export const STATE_GROUPS: Record<StateGroup, { label: string; icon: IconName; about: string }> = {
  waiting: { label: "Needs someone", icon: "bell", about: "Nobody has acknowledged these yet" },
  acknowledged: { label: "Acknowledged", icon: "check", about: "Someone is on it; they close when the change goes away" },
  resolved: { label: "Resolved", icon: "check-circle", about: "Closed by Keel or by hand; history is kept" },
  muted: { label: "Muted", icon: "pause", about: "Recorded, but nobody is told" },
};

export function stateGroup(alert: Pick<AlertItem, "state">): StateGroup {
  if (alert.state === "open" || alert.state === "reopened") return "waiting";
  if (alert.state === "suppressed") return "muted";
  return alert.state;
}

export function isWaiting(alert: Pick<AlertItem, "state">): boolean {
  return alert.state === "open" || alert.state === "reopened";
}

export function isActive(alert: Pick<AlertItem, "state">): boolean {
  return ACTIVE_STATES.includes(alert.state);
}

/** Row colour: the severity while someone still has to act, nothing once it is closed. */
export function alertTone(alert: AlertItem): RiskTone | null {
  return isActive(alert) ? SEVERITY[alert.severity].tone : null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** When it was last resolved, from its history. */
export function resolvedAt(alert: Pick<AlertItem, "history">): string | null {
  for (let index = alert.history.length - 1; index >= 0; index -= 1) {
    if (alert.history[index].toState === "resolved") return alert.history[index].at;
  }
  return null;
}

export interface AlertCounts { waiting: number; overdue: number; acknowledged: number; resolvedWeek: number; muted: number; total: number }

export function alertCounts(alerts: AlertItem[], now: string): AlertCounts {
  const counts: AlertCounts = { waiting: 0, overdue: 0, acknowledged: 0, resolvedWeek: 0, muted: 0, total: alerts.length };
  const since = new Date(now).valueOf() - WEEK_MS;
  for (const alert of alerts) {
    if (isWaiting(alert)) counts.waiting += 1;
    if (isOverdue(alert, now)) counts.overdue += 1;
    if (alert.state === "acknowledged") counts.acknowledged += 1;
    if (alert.state === "suppressed") counts.muted += 1;
    const resolved = alert.state === "resolved" ? resolvedAt(alert) : null;
    if (resolved && new Date(resolved).valueOf() >= since) counts.resolvedWeek += 1;
  }
  return counts;
}

/** The header pill: urgent when one is past its deadline, soon while one waits. */
export function alertsStatus(counts: AlertCounts): { tone: RiskTone; label: string } {
  if (counts.overdue) return { tone: "urgent", label: `${counts.overdue} overdue` };
  if (counts.waiting) return { tone: "soon", label: `${counts.waiting} waiting` };
  if (counts.acknowledged) return { tone: "low", label: `${counts.acknowledged} in hand` };
  return { tone: "fine", label: "All clear" };
}

export type AlertFilter = "waiting" | "overdue" | "acknowledged" | "resolved" | "muted";
export const ALERT_FILTERS: AlertFilter[] = ["waiting", "overdue", "acknowledged", "resolved", "muted"];

export function parseAlertFilter(value: string | null | undefined): AlertFilter | null {
  return ALERT_FILTERS.includes(value as AlertFilter) ? (value as AlertFilter) : null;
}

export function alertMatches(alert: AlertItem, filter: AlertFilter | null, now: string): boolean {
  if (!filter) return true;
  if (filter === "overdue") return isOverdue(alert, now);
  return stateGroup(alert) === filter;
}

export const FILTER_WORDS: Record<AlertFilter, string> = {
  waiting: "alerts that need someone",
  overdue: "alerts past their deadline",
  acknowledged: "acknowledged alerts",
  resolved: "resolved alerts",
  muted: "muted alerts",
};

/** "3 h", "25 min", "2 days": a short span for a row. */
export function shortSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** The row's time column: a countdown while it waits, else when it last moved. */
export function deadlineWords(alert: AlertItem, now: string): { text: string; tone: RiskTone | null } {
  const at = (value: string) => new Date(value).valueOf() - new Date(now).valueOf();
  if (isWaiting(alert)) {
    if (!alert.ackDeadlineAt) return { text: "No deadline", tone: null };
    const left = at(alert.ackDeadlineAt);
    return left <= 0 ? { text: `Overdue ${shortSpan(left)}`, tone: "urgent" } : { text: `Due in ${shortSpan(left)}`, tone: left < 60 * 60 * 1000 ? "soon" : null };
  }
  if (alert.state === "acknowledged" && alert.acknowledgedAt) return { text: `Acknowledged ${shortSpan(at(alert.acknowledgedAt))} ago`, tone: null };
  if (alert.state === "resolved") {
    const when = resolvedAt(alert);
    return { text: when ? `Resolved ${shortSpan(at(when))} ago` : "Resolved", tone: null };
  }
  return { text: "Nobody is told", tone: null };
}

/** The panel's deadline sentence. */
export function deadlineSentence(alert: AlertItem, now: string, ago: (value: string, now: string) => string, fromNow: (value: string, now: string) => string): string | null {
  if (!isWaiting(alert)) return null;
  if (!alert.ackDeadlineAt) return "No acknowledgement deadline is set for alerts like this one.";
  if (isOverdue(alert, now)) {
    return alert.escalated
      ? `It missed its acknowledgement deadline ${ago(alert.ackDeadlineAt, now)} and was escalated.`
      : `It missed its acknowledgement deadline ${ago(alert.ackDeadlineAt, now)}.`;
  }
  return `Acknowledge it ${fromNow(alert.ackDeadlineAt, now)}.`;
}

/** The service an alert belongs to, for grouping. */
export function alertService(alert: AlertItem): CloudService {
  if (alert.control === "break-glass") return typeService("user");
  const workload = alertWorkload(alert.resourceKey);
  if (workload) return typeService(workload);
  const index = alert.resourceKey.indexOf(":");
  const type = alert.cause.resourceType ?? (index > 0 ? alert.resourceKey.slice(0, index) : alert.resourceKey);
  return itemService({ resourceType: type, name: alert.name, templateFamily: alert.templateFamily ?? null });
}

/** Where to see the change behind the alert. Never a write: undo starts on Changes. */
export function changeLink(alert: AlertItem): { href: string; label: string } {
  if (alert.control === "break-glass") return { href: "/readiness", label: "Open emergency access" };
  const workload = alertWorkload(alert.resourceKey);
  if (workload === SHAREPOINT_SITES) {
    const rest = alert.resourceKey.slice(workload.length + 1);
    if (rest.startsWith("site:") && rest.length > 5) return { href: `/sites/${encodeURIComponent(rest.slice(5))}`, label: "Open the site" };
  }
  const name = usable(alert.name) ?? alertTitle(alert).replace(/ \([^()]*\)$/, "");
  return { href: `/drift?q=${encodeURIComponent(name)}`, label: "Open the change" };
}

/** The engine's escalation error in words, never its code. */
export function escalationWords(error: string | null): string | null {
  if (!error) return null;
  return error === "escalation-failed-no-recipient" || /recipient|channel/i.test(error)
    ? "Keel could not escalate it: no channel is set to tell anyone."
    : "Keel could not escalate it. Check the channels on Notifications.";
}

export const HISTORY_ICONS: Record<string, IconName> = {
  "condition-firing": "bell",
  "condition-recurred": "refresh",
  "condition-recurred-flapping": "refresh",
  "condition-resolved": "check-circle",
  "resolution-held-flapping": "pause",
  acknowledged: "check",
  "resolved-by-operator": "check-circle",
  suppressed: "pause",
  unsuppressed: "play",
  "escalated-ack-deadline-missed": "alert",
  "escalation-failed-no-recipient": "x-circle",
};

/** What a bulk action will do, before it runs. */
export function bulkDetail(action: "acknowledge" | "resolve" | "mute", chosen: AlertItem[]): string {
  const can = chosen.filter((alert) => (action === "acknowledge" ? isWaiting(alert) : action === "resolve" ? isActive(alert) : alert.state !== "suppressed")).length;
  const skip = chosen.length - can;
  const lead = action === "acknowledge"
    ? `${can === 1 ? "1 alert is" : `${can} alerts are`} marked as seen by you; ${can === 1 ? "it stays" : "they stay"} open until the change goes away.`
    : action === "resolve"
      ? `${can === 1 ? "1 alert closes" : `${can} alerts close`} now. If a change is still there, the next check opens it again.`
      : `${can === 1 ? "1 alert is" : `${can} alerts are`} muted: still recorded, but nobody is told.`;
  if (!skip) return lead;
  const why = action === "acknowledge" ? "already acknowledged or closed" : action === "resolve" ? "already closed" : "already muted";
  return `${lead} ${skip === 1 ? "1 is" : `${skip} are`} ${why} and ${skip === 1 ? "stays" : "stay"} as ${skip === 1 ? "it is" : "they are"}.`;
}

/** Which alerts an action applies to. */
export function actionable(action: "acknowledge" | "resolve" | "mute" | "unmute", alert: AlertItem): boolean {
  if (action === "acknowledge") return isWaiting(alert);
  if (action === "resolve") return isActive(alert);
  if (action === "mute") return alert.state !== "suppressed";
  return alert.state === "suppressed";
}
