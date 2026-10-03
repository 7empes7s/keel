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
  if (channel.kind === "teams") return "Microsoft Teams";
  if (channel.kind === "slack") return "Slack";
  if (channel.kind === "pagerduty") return channel.config?.region === "eu" ? "PagerDuty (EU)" : "PagerDuty";
  if (channel.kind === "sms") return typeof channel.config?.to === "string" ? `Text message to ${channel.config.to}` : "Text message";
  return displayEnum("jobKind", channel.kind);
}

/** Task 84: what the channel does, in one sentence. Credential references are named, never resolved. */
export function channelSentence(channel: Pick<Channel, "kind" | "config">): string {
  // "env:KEEL_SLACK_WEBHOOK" reads as "the server setting KEEL_SLACK_WEBHOOK".
  const ref = (key: string) => {
    const value = channel.config?.[key];
    return typeof value === "string" && value.startsWith("env:") ? `the server setting ${value.slice(4)}` : "a server setting";
  };
  switch (channel.kind) {
    case "email": return `Sends email to ${String(channel.config?.to ?? "nobody")} from ${String(channel.config?.from ?? "an unknown sender")}.`;
    case "teams": return `Posts each alert as a card through the Teams workflow whose address is stored in ${ref("endpointRef")}.`;
    case "slack": return `Posts each alert through the Slack webhook whose address is stored in ${ref("endpointRef")}.`;
    case "pagerduty": return `Opens a PagerDuty incident with the integration key stored in ${ref("routingKeyRef")}. Repeats of the same alert join that incident.`;
    case "sms": return `Texts ${String(channel.config?.to ?? "nobody")} through Twilio. KEEL learns that Twilio accepted the text, not that the phone received it.`;
    default: return `Posts each alert to ${String(channel.config?.url ?? "an unknown address")}.`;
  }
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
  const targets = enabled.map((channel) => {
    if (channel.kind === "email" && typeof channel.config?.to === "string") return channel.config.to;
    if (channel.kind === "webhook") return `the ${hostOf(channel.config?.url) ?? "webhook"} webhook`;
    if (channel.kind === "sms" && typeof channel.config?.to === "string") return `a text to ${channel.config.to}`;
    return channelName(channel);
  });
  const list = targets.length === 1 ? targets[0] : `${targets.slice(0, -1).join(", ")} and ${targets.at(-1)}`;
  return `Alerts go to ${list}.`;
}

export function patternWords(glob: string): string {
  if (glob === "*") return "all events";
  const exact = displayEnum("eventKind", glob);
  return exact.startsWith("A ") ? `“${exact.toLowerCase()}” events` : `events matching “${glob}”`;
}

