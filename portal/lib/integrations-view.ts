// Roadmap task-130: audit-record export destinations in words. Pure helpers shared by
// the server page and the client console.
import type { Destination, DestinationStatus } from "@/lib/integrations";

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
