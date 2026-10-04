// Roadmap task-130: audit-record export destinations in words. Pure helpers shared by
// the server page and the client console.
import type { Destination, DestinationStatus } from "@/lib/integrations";
import type { ServiceNowHeldBack, ServiceNowStatus } from "@/lib/servicenow";

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

/** "The decision update was held back after 1 attempt: ServiceNow refused it." */
export function heldBackSentence(event: ServiceNowHeldBack): string {
  const what = UPDATE_KINDS[event.kind] ?? "An update";
  const why = event.reason === "rejected by adapter" ? "ServiceNow refused it" : "it failed every retry";
  return `${what} was held back after ${event.attempts} ${event.attempts === 1 ? "attempt" : "attempts"}: ${why}. KEEL's decision stands.`;
}

/** The page verdict: a ServiceNow problem outranks the audit-record destinations. */
export function integrationsPageVerdict(destinations: Destination[], statuses: DestinationStatus[], servicenow: ServiceNowStatus | null): { text: string; tone: "good" | "attention" } {
  if (servicenow && servicenow.configured && (!servicenow.enabled || servicenow.mirror.heldBack > 0)) {
    return { text: serviceNowSentence(servicenow), tone: "attention" };
  }
  return {
    text: integrationsVerdict(destinations, statuses),
    tone: statuses.some((status) => status.quarantined > 0) ? "attention" : "good",
  };
}
