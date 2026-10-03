// Roadmap task-130: notification channels, rules and deliveries in words. Pure helpers
// shared by the server page and the client console.
import { displayEnum } from "@/lib/presentation";
import type { Channel, Delivery } from "@/lib/notifications";

export function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** "Email to secops@contoso.com" / "Webhook to hooks.contoso.com". */
export function channelName(channel: Pick<Channel, "kind" | "config">): string {
  if (channel.kind === "email") return typeof channel.config?.to === "string" ? `Email to ${channel.config.to}` : "Email";
  if (channel.kind === "webhook") return hostOf(channel.config?.url) ? `Webhook to ${hostOf(channel.config?.url)}` : "Webhook";
  return displayEnum("jobKind", channel.kind);
}

/** "Alerts go to secops@contoso.com and the hooks.contoso.com webhook." */
export function notificationsVerdict(channels: Channel[] | null, deliveries: Delivery[]): string {
  if (channels === null) {
    const failed = deliveries.filter((delivery) => delivery.status === "failed").length;
    return deliveries.length === 0
      ? "No alerts have been sent recently."
      : `${deliveries.length} ${deliveries.length === 1 ? "alert was" : "alerts were"} sent recently${failed ? `; ${failed} failed` : ""}.`;
  }
  const enabled = channels.filter((channel) => channel.enabled);
  if (enabled.length === 0) return "No alert channel is on, so nobody is notified.";
  const targets = enabled.map((channel) => channel.kind === "email" && typeof channel.config?.to === "string"
    ? channel.config.to
    : `the ${hostOf(channel.config?.url) ?? channel.kind} ${channel.kind}`);
  const list = targets.length === 1 ? targets[0] : `${targets.slice(0, -1).join(", ")} and ${targets.at(-1)}`;
  return `Alerts go to ${list}.`;
}

export function patternWords(glob: string): string {
  if (glob === "*") return "all events";
  const exact = displayEnum("eventKind", glob);
  return exact.startsWith("A ") ? `“${exact.toLowerCase()}” events` : `events matching “${glob}”`;
}

