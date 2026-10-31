// Roadmap task-130: audit-record export destinations in words. Pure helpers shared by
// the server page and the client console.
import type { AlertItem } from "@/components/ui/alert-list";
import type { StatTile } from "@/components/ui/stat-tiles";
import type { Destination, DestinationStatus } from "@/lib/integrations";
import type { ServiceNowHeldBack, ServiceNowStatus } from "@/lib/servicenow";
import { AUDIT_CHECK_WORDS, AUDIT_RECORD_HREF, type AuditCheck } from "@/lib/audit-check";

/** "Webhook" / "CEF over HTTPS" / "CEF over UDP (syslog)". */
export function destinationKind(destination: Pick<Destination, "kind" | "config">): string {
  if (destination.kind === "webhook") return "Webhook";
  if (destination.kind === "cef") return destination.config?.transport === "udp" ? "CEF over UDP (syslog)" : "CEF over HTTPS";
  if (destination.kind === "azure-monitor" || destination.kind === "sentinel") return "Microsoft Sentinel";
  return "Export destination";
}

/** Where it sends, without a host:port token ("host siem.contoso.com, port 514"). */
export function destinationTarget(destination: Pick<Destination, "config">): string {
  const config = destination.config ?? {};
  if (typeof config.url === "string") return config.url;
  if (typeof config.host === "string") return `host ${config.host}${config.port ? `, port ${String(config.port)}` : ""}`;
  return "an address that is not set";
}

export function isPaused(destination: Pick<Destination, "enabled" | "revoked_at">): boolean {
  return !destination.enabled || destination.revoked_at !== null;
}

/** "The audit record goes to 2 destinations; 3 entries are held back." */
export function integrationsVerdict(destinations: Destination[], statuses: DestinationStatus[]): string {
  const active = destinations.filter((destination) => !isPaused(destination));
  if (destinations.length === 0) return "No export destination is set up; the audit record stays only in KEEL.";
  if (active.length === 0) return `All ${destinations.length} export ${destinations.length === 1 ? "destination is" : "destinations are"} paused.`;
  const held = statuses.reduce((sum, status) => sum + status.quarantined, 0);
  return `The audit record goes to ${active.length} ${active.length === 1 ? "destination" : "destinations"}${held ? `; ${held} ${held === 1 ? "entry is" : "entries are"} held back` : ""}.`;
}

// Roadmap task-97: the ServiceNow approval mirror in words.

/** A stored state value in words ("gate_passed" → "gate passed"); the raw value is in the record. */
export function stateValueWords(value: string): string {
  return value.replace(/[_-]+/g, " ").trim() || "empty";
}

/** "ServiceNow approvals are off until 2 missing settings are filled in." and friends. */
export function serviceNowSentence(status: ServiceNowStatus): string {
  if (!status.configured) return "ServiceNow is not set up. Approvals are decided only in KEEL.";
  if (!status.enabled) {
    const count = status.problems.length;
    return `ServiceNow approvals are off until ${count} missing ${count === 1 ? "setting is" : "settings are"} filled in.`;
  }
  if (status.mirror.heldBack > 0) {
    return `${status.mirror.heldBack} ServiceNow ${status.mirror.heldBack === 1 ? "update is" : "updates are"} held back; KEEL's decisions stand.`;
  }
  return `ServiceNow approvals are on for ${status.mapping?.instanceHost ?? "the configured instance"}.`;
}

const UPDATE_KINDS: Record<string, string> = {
  record: "The plan update",
  decision: "The decision update",
  conflict: "The disagreement notice",
};

/** "The decision update was held back: ServiceNow refused it." Attempts and the raw error go behind "Show details". */
export function heldBackSentence(event: ServiceNowHeldBack): string {
  const what = UPDATE_KINDS[event.kind] ?? "An update";
  const why = event.reason === "rejected by adapter" ? "ServiceNow refused it" : "it failed every retry";
  return `${what} was held back: ${why}.`;
}

/** The page verdict: a ServiceNow problem outranks the audit-record destinations. */
export function integrationsPageVerdict(destinations: Destination[], statuses: DestinationStatus[], servicenow: ServiceNowStatus | null, record: AuditCheck = "unknown"): { text: string; tone: "good" | "attention" } {
  // A failed audit record check outranks everything: the copies sent out are of a record
  // that cannot be trusted.
  if (record === "failed") return { text: `${AUDIT_CHECK_WORDS.failed.title}. Investigate before trusting the copies sent out.`, tone: "attention" };
  if (servicenow && servicenow.configured && (!servicenow.enabled || servicenow.mirror.heldBack > 0)) {
    return { text: serviceNowSentence(servicenow), tone: "attention" };
  }
  return {
    text: integrationsVerdict(destinations, statuses),
    tone: statuses.some((status) => status.quarantined > 0) || record === "unchecked" ? "attention" : "good",
  };
}

// The redesigned page: alerts first, four tiles, then ServiceNow and each destination
// with coloured counts. Raw error text waits behind "Show details".

export type IntegrationTone = "urgent" | "soon" | "low" | "fine" | "neutral";

/** Behind by more than this reads as amber. */
export const LAG_WARN_MS = 5 * 60_000;

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}

/** "41 seconds", "6 minutes", "2 hours"; null reads "Nothing". */
export function lagWords(ms: number | null): string {
  if (ms === null || ms <= 0) return "Nothing";
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return count(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return count(minutes, "minute");
  return count(Math.round(minutes / 60), "hour");
}

/** A destination's state as a badge: held back outranks paused, paused outranks behind. */
export function destinationBadge(destination: Pick<Destination, "enabled" | "revoked_at">, status: DestinationStatus | null): { tone: IntegrationTone; label: string } {
  if (status && status.quarantined > 0) return { tone: "urgent", label: `${status.quarantined} held back` };
  if (isPaused(destination)) return { tone: "soon", label: "Paused" };
  if (status && (status.lagMs ?? 0) > LAG_WARN_MS) return { tone: "soon", label: "Falling behind" };
  return { tone: "fine", label: "Sending" };
}

/** ServiceNow's state as a badge. */
export function serviceNowBadge(status: ServiceNowStatus | null): { tone: IntegrationTone; label: string } {
  if (!status) return { tone: "neutral", label: "Not known" };
  if (!status.configured) return { tone: "neutral", label: "Not set up" };
  if (!status.enabled) return { tone: "soon", label: "Off" };
  if (status.mirror.heldBack > 0) return { tone: "urgent", label: "On, updates held back" };
  return { tone: "fine", label: "On" };
}

/** What needs the reader, worst first. */
export function integrationAlerts(destinations: Destination[], statuses: DestinationStatus[], servicenow: ServiceNowStatus | null, record: AuditCheck = "unknown"): AlertItem[] {
  const urgent: AlertItem[] = [];
  const soon: AlertItem[] = [];
  const low: AlertItem[] = [];
  // The audit record these destinations copy, in the same words and colour as Activity
  // and the Overview, so the page never says "Working" over a record nobody checked.
  if (record === "failed") {
    urgent.push({
      key: "audit-failed", tone: "urgent", icon: "x-circle",
      title: AUDIT_CHECK_WORDS.failed.title,
      todo: AUDIT_CHECK_WORDS.failed.detail,
      action: { label: "Open the audit record", href: AUDIT_RECORD_HREF },
    });
  } else if (record === "unchecked") {
    soon.push({
      key: "audit-unchecked", tone: "soon", icon: "alert",
      title: AUDIT_CHECK_WORDS.unchecked.title,
      todo: AUDIT_CHECK_WORDS.unchecked.detail,
      action: { label: "Open the audit record", href: AUDIT_RECORD_HREF },
    });
  }
  if (servicenow && servicenow.mirror.heldBack > 0) {
    urgent.push({
      key: "servicenow-held", tone: "urgent", icon: "x-circle",
      title: `${count(servicenow.mirror.heldBack, "ServiceNow update was", "ServiceNow updates were")} held back`,
      todo: "Check that KEEL may still write to ServiceNow. KEEL's own decisions stand.",
      more: servicenow.heldBack.flatMap((event) => [heldBackSentence(event), ...(event.lastError ? [`ServiceNow said: ${event.lastError}`] : [])]),
      action: { label: "Open ServiceNow", href: "#ig-servicenow" },
    });
  }
  for (const destination of destinations) {
    const status = statuses.find((entry) => entry.destinationId === destination.id) ?? null;
    const href = `#destination-${destination.id}`;
    if (status && status.quarantined > 0) {
      urgent.push({
        key: `held-${destination.id}`, tone: "urgent", icon: "x-circle",
        title: `${count(status.quarantined, "audit entry", "audit entries")} could not be sent to ${destination.name}`,
        todo: "Open the held-back entries, fix the cause, then send them again.",
        action: { label: "Open", href },
      });
    }
    if (isPaused(destination)) {
      soon.push({
        key: `paused-${destination.id}`, tone: "soon", icon: "pause",
        title: `${destination.name} is paused`,
        todo: "Resume it, or remove it if it is no longer used. New entries wait meanwhile.",
        action: { label: "Open", href },
      });
    } else if (status && (status.lagMs ?? 0) > LAG_WARN_MS) {
      soon.push({
        key: `behind-${destination.id}`, tone: "soon", icon: "clock",
        title: `${destination.name} is ${lagWords(status.lagMs)} behind`,
        todo: "Check that it is reachable and accepting entries.",
        action: { label: "Open", href },
      });
    }
  }
  if (servicenow && servicenow.configured && !servicenow.enabled) {
    soon.push({
      key: "servicenow-off", tone: "soon", icon: "alert",
      title: `ServiceNow approvals are off: ${count(servicenow.problems.length, "setting is", "settings are")} missing`,
      todo: "Fill in the missing settings. Until then, approvals are decided only in KEEL.",
      action: { label: "See what is missing", href: "#ig-servicenow" },
    });
  }
  if (servicenow && servicenow.mirror.conflicts > 0) {
    soon.push({
      key: "servicenow-conflicts", tone: "soon", icon: "swap",
      title: `${count(servicenow.mirror.conflicts, "ServiceNow record disagrees", "ServiceNow records disagree")} with KEEL`,
      todo: "Check those records in ServiceNow. KEEL's decision stands.",
      action: { label: "Open ServiceNow", href: "#ig-servicenow" },
    });
  }
  if (destinations.length === 0) {
    low.push({
      key: "no-destination", tone: "low", icon: "info",
      title: "The audit record stays only in KEEL",
      todo: "Add a destination to copy it to your SIEM or another system.",
      action: null,
    });
  }
  return [...urgent, ...soon, ...low];
}

/** Four tiles: audit copies, waiting to send, held back, and ServiceNow. */
export function integrationTiles(destinations: Destination[], statuses: DestinationStatus[], servicenow: ServiceNowStatus | null): StatTile[] {
  const sending = destinations.filter((destination) => !isPaused(destination)).length;
  const pending = statuses.reduce((sum, status) => sum + status.pending + status.delivering, 0);
  const lag = statuses.reduce((worst, status) => Math.max(worst, status.lagMs ?? 0), 0);
  const held = statuses.reduce((sum, status) => sum + status.quarantined, 0) + (servicenow?.mirror.heldBack ?? 0);
  const snow = serviceNowBadge(servicenow);
  return [
    { key: "destinations", label: "Audit copies", icon: "audit", value: destinations.length ? `${sending} of ${destinations.length}` : "None",
      about: destinations.length ? (sending === destinations.length ? "All destinations sending" : "Some are paused") : "Stays only in KEEL",
      tone: !destinations.length ? "low" : sending === destinations.length ? "fine" : "soon", href: "#ig-destinations" },
    { key: "pending", label: "Waiting to send", icon: "clock", value: pending.toLocaleString("en-GB"),
      about: lag ? `Behind by ${lagWords(lag).toLowerCase()}` : "Nothing waiting", tone: lag > LAG_WARN_MS ? "soon" : "neutral", href: "#ig-destinations" },
    { key: "held", label: "Held back", icon: "x-circle", value: held.toLocaleString("en-GB"),
      about: held ? "Could not be sent" : "Everything went through", tone: held ? "urgent" : "fine", href: "#ig-attention" },
    { key: "servicenow", label: "ServiceNow approvals", icon: "inbox", value: snow.label.split(",")[0],
      about: servicenow?.enabled ? `${count(servicenow.mirror.waiting, "record")} waiting` : servicenow?.configured ? "Settings missing" : "Decided only in KEEL",
      tone: snow.tone === "urgent" ? "fine" : snow.tone, href: "#ig-servicenow" },
  ];
}

/** The header pill. */
export function integrationsStatus(alerts: AlertItem[]): { tone: "urgent" | "soon" | "low" | "fine"; label: string } {
  if (alerts.some((alert) => alert.tone === "urgent")) return { tone: "urgent", label: "Needs attention" };
  if (alerts.some((alert) => alert.tone === "soon")) return { tone: "soon", label: "Check soon" };
  return { tone: "fine", label: "Working" };
}

// Destinations as grouped rows (settings restyle): one group per kind in a fixed
// order, the worst row first inside each group, then by name.

export interface DestinationGroup {
  key: "webhook" | "cef" | "sentinel" | "other";
  label: string;
  about: string;
  icon: "link" | "audit" | "monitor" | "info";
  items: Destination[];
}

const GROUPS: Omit<DestinationGroup, "items">[] = [
  { key: "webhook", label: "Webhooks", about: "Each audit entry is posted to a web address.", icon: "link" },
  { key: "cef", label: "SIEM (CEF)", about: "Each audit entry is sent to a SIEM in CEF format.", icon: "audit" },
  { key: "sentinel", label: "Microsoft Sentinel", about: "Each audit entry is sent to a Sentinel workspace.", icon: "monitor" },
  { key: "other", label: "Other destinations", about: "Destinations of a kind this page does not name.", icon: "info" },
];

const TONE_RANK: Record<IntegrationTone, number> = { urgent: 0, soon: 1, low: 2, neutral: 3, fine: 4 };

function groupKey(destination: Pick<Destination, "kind">): DestinationGroup["key"] {
  if (destination.kind === "webhook") return "webhook";
  if (destination.kind === "cef") return "cef";
  if (destination.kind === "azure-monitor" || destination.kind === "sentinel") return "sentinel";
  return "other";
}

export function destinationGroups(destinations: Destination[], statuses: DestinationStatus[]): DestinationGroup[] {
  const statusOf = (id: string) => statuses.find((status) => status.destinationId === id) ?? null;
  const rank = (destination: Destination) => TONE_RANK[destinationBadge(destination, statusOf(destination.id)).tone];
  return GROUPS.map((group) => ({
    ...group,
    items: destinations
      .filter((destination) => groupKey(destination) === group.key)
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "en-GB")),
  })).filter((group) => group.items.length > 0);
}

/** The row's short line: "14 waiting, behind by 41 seconds" or "Nothing waiting". */
export function destinationLine(destination: Pick<Destination, "enabled" | "revoked_at">, status: DestinationStatus | null): string {
  if (!status) return isPaused(destination) ? "Paused: new entries wait" : "No delivery report yet";
  const waiting = status.pending + status.delivering;
  const parts = [waiting ? `${waiting.toLocaleString("en-GB")} waiting` : "Nothing waiting"];
  if ((status.lagMs ?? 0) > 0) parts.push(`behind by ${lagWords(status.lagMs).toLowerCase()}`);
  return parts.join(", ");
}
