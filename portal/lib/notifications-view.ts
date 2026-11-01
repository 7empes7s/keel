// The Notifications page in words (portal audit, Notifications, pick A: three tabs).
// Pure helpers shared by the server page, the client page and the tests: channel names
// and kinds, each channel's health from what was last sent through it, plain sentences
// for provider errors, rule and escalation titles, the counts behind the tiles, the
// status pill and the verdict. Ids never appear in anything these return.
import type { IconName } from "@/components/shell/icons";
import type { BadgeTone } from "@/components/ui/badge";
import { plainLabel } from "@/lib/baselines-view";
import type { RiskTone } from "@/lib/menu-status";
import type { Channel, Delivery, EscalationRule, Subscription } from "@/lib/notifications";
import { DISPLAY_ENUMS, ago, displayEnum } from "@/lib/presentation";
import { personLabel } from "@/lib/sentences";

export function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export type ChannelKind = "webhook" | "email" | "teams" | "slack" | "pagerduty" | "sms";

/** Each kind of channel in plain words, with its icon and the one-line explanation the
 * row shows under the name. "Webhook" stays where it is the admin's own word. */
export const CHANNEL_KINDS: Record<ChannelKind, { label: string; icon: IconName; about: string; help: string }> = {
  webhook: { label: "Web address", icon: "link", about: "Keel posts each alert to it", help: "A web address (webhook) that Keel posts each alert to." },
  email: { label: "Email", icon: "inbox", about: "Email to a mailbox", help: "Keel sends each alert as an email." },
  teams: { label: "Microsoft Teams", icon: "service-teams", about: "A card in a Teams channel", help: "Keel posts each alert as a card through a Teams workflow." },
  slack: { label: "Slack", icon: "bell", about: "A message in a Slack channel", help: "Keel posts each alert to a Slack channel." },
  pagerduty: { label: "PagerDuty", icon: "alert", about: "Opens an incident", help: "Keel opens a PagerDuty incident; repeats of the same alert join it." },
  sms: { label: "Text message", icon: "monitor", about: "A text through Twilio", help: "Keel texts a phone number through Twilio." },
};
export const CHANNEL_KIND_ORDER: ChannelKind[] = ["email", "teams", "slack", "pagerduty", "webhook", "sms"];

export function channelKind(kind: string): ChannelKind | null {
  return kind in CHANNEL_KINDS ? (kind as ChannelKind) : null;
}

export function channelKindLabel(kind: string): string {
  return channelKind(kind) ? CHANNEL_KINDS[kind as ChannelKind].label : displayEnum("jobKind", kind);
}

export function channelIcon(kind: string): IconName {
  return channelKind(kind) ? CHANNEL_KINDS[kind as ChannelKind].icon : "bell";
}

/** "Email to secops@contoso.com" / "Web address hooks.contoso.com" / "PagerDuty (EU)". */
export function channelName(channel: Pick<Channel, "kind" | "config">): string {
  if (channel.kind === "email") return typeof channel.config?.to === "string" ? `Email to ${channel.config.to}` : "Email";
  if (channel.kind === "webhook") return hostOf(channel.config?.url) ? `Web address ${hostOf(channel.config?.url)}` : "Web address";
  if (channel.kind === "teams") return "Microsoft Teams";
  if (channel.kind === "slack") return "Slack";
  if (channel.kind === "pagerduty") return channel.config?.region === "eu" ? "PagerDuty (EU)" : "PagerDuty";
  if (channel.kind === "sms") return typeof channel.config?.to === "string" ? `Text message to ${channel.config.to}` : "Text message";
  return channelKindLabel(channel.kind);
}

/** The short word for a channel in a sentence: "Slack", "the email to secops@contoso.com". */
export function channelShort(channel: Pick<Channel, "kind" | "config">): string {
  if (channel.kind === "email" && typeof channel.config?.to === "string") return `the email to ${channel.config.to}`;
  if (channel.kind === "webhook") return `the web address ${hostOf(channel.config?.url) ?? ""}`.trim();
  if (channel.kind === "sms" && typeof channel.config?.to === "string") return `the text to ${channel.config.to}`;
  return channelName(channel);
}

/** A credential reference ("env:KEEL_INTEGRATION_SLACK_WEBHOOK") as words: the setting's name, never the value. */
export function settingName(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("env:") ? value.slice(4) : null;
}

/** Task 84: what the channel does, in one sentence. Credential references are named, never resolved. */
export function channelSentence(channel: Pick<Channel, "kind" | "config">): string {
  const ref = (key: string) => {
    const name = settingName(channel.config?.[key]);
    return name ? `the server setting ${name}` : "a server setting";
  };
  switch (channel.kind) {
    case "email": return `Sends email to ${String(channel.config?.to ?? "nobody")} from ${String(channel.config?.from ?? "an unknown sender")}.`;
    case "teams": return `Posts each alert as a card through the Teams workflow whose address is stored in ${ref("endpointRef")}.`;
    case "slack": return `Posts each alert through the Slack webhook whose address is stored in ${ref("endpointRef")}.`;
    case "pagerduty": return `Opens a PagerDuty incident with the integration key stored in ${ref("routingKeyRef")}. Repeats of the same alert join that incident.`;
    case "sms": return `Texts ${String(channel.config?.to ?? "nobody")} through Twilio. Keel learns that Twilio accepted the text, not that the phone received it.`;
    default: return `Posts each alert to ${String(channel.config?.url ?? "an unknown address")}.`;
  }
}

/** The second line under a channel's name: the address or sender, in plain words. */
export function channelAbout(channel: Pick<Channel, "kind" | "config">): string {
  if (channel.kind === "email") return `Email from ${String(channel.config?.from ?? "an unknown sender")}`;
  const kind = channelKind(channel.kind);
  return kind ? CHANNEL_KINDS[kind].about : "Channel";
}

export type DeliveryState = "delivered" | "failed" | "pending" | "cancelled";

export function deliveryState(status: string): DeliveryState {
  if (status === "delivered") return "delivered";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "pending";
}

export function deliveryBadge(delivery: Pick<Delivery, "status">): { tone: BadgeTone; label: string; icon: IconName } {
  switch (deliveryState(delivery.status)) {
    case "delivered": return { tone: "fine", label: "Delivered", icon: "check-circle" };
    case "failed": return { tone: "urgent", label: "Failed", icon: "x-circle" };
    case "cancelled": return { tone: "neutral", label: "Cancelled", icon: "pause" };
    default: return { tone: "soon", label: delivery.status === "retrying" ? "Trying again" : displayEnum("deliveryStatus", delivery.status), icon: "refresh" };
  }
}

/** When a delivery happened: the moment it was delivered, else when it was queued. */
export function deliveryTime(delivery: Pick<Delivery, "created_at" | "delivered_at">): string | null {
  return delivery.delivered_at ?? delivery.created_at ?? null;
}

function newestFirst(deliveries: Delivery[]): Delivery[] {
  return [...deliveries].sort((a, b) => new Date(b.created_at ?? 0).valueOf() - new Date(a.created_at ?? 0).valueOf());
}

export interface DeliveryProblem { sentence: string; whatToDo: string }

/** A failed or retrying send as two plain sentences: what happened and what to do.
 * HTTP codes, provider status words and the raw error stay in Technical details. */
export function deliveryProblem(delivery: Pick<Delivery, "status" | "last_error" | "provider_receipt" | "channel_kind" | "attempts">): DeliveryProblem | null {
  if (deliveryState(delivery.status) === "delivered" || deliveryState(delivery.status) === "cancelled") return null;
  if (!delivery.last_error && !delivery.provider_receipt) return null;
  const who = channelKindLabel(delivery.channel_kind);
  const receipt = delivery.provider_receipt ?? null;
  const status = receipt?.httpStatus ?? null;
  const raw = (delivery.last_error ?? "").toLowerCase();
  const retrying = delivery.status !== "failed";
  const later = retrying ? "Keel tries again on its own." : "Send a test once it is fixed.";
  if (status === 404 || status === 410 || receipt?.providerStatus === "no_service" || /removed|turned off|not found|no longer exists/.test(raw)) {
    return { sentence: `${who} refused it: the address was removed.`, whatToDo: `Make a new address in ${who}, add it here as a new channel, then turn this one off.` };
  }
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid key|invalid token/.test(raw)) {
    return { sentence: `${who} refused it: the key or address is no longer accepted.`, whatToDo: `Check the server setting that holds it, then send a test.` };
  }
  if (status === 429 || /slow down|rate limit|too many/.test(raw)) {
    return { sentence: `${who} asked Keel to slow down.`, whatToDo: later };
  }
  if ((status !== null && status >= 500) || /unavailable|on its side|server error/.test(raw)) {
    return { sentence: `${who} had a problem on its side.`, whatToDo: later };
  }
  if (/did not answer|time ?out|timed out|in time/.test(raw)) {
    return { sentence: "It did not answer in time.", whatToDo: retrying ? "Keel tries again on its own." : "Check that the address is reachable from the Keel server, then send a test." };
  }
  if (/public addresses|address refused/.test(raw)) {
    return { sentence: "Keel does not send to private or internal addresses.", whatToDo: "Use a public web address, add it as a new channel, then turn this one off." };
  }
  if (/not configured|setting .* is not set|is unset|missing/.test(raw)) {
    return { sentence: "The server setting that holds its address is not set.", whatToDo: "Ask a Keel admin to add the setting on the Keel server, then send a test." };
  }
  // Anything else: a plain sentence only. The provider's own words stay behind "Show details".
  return { sentence: `${who} refused the message.`, whatToDo: retrying ? "Keel tries again on its own." : "Check the address, then send a test." };
}

export type HealthState = "failing" | "retrying" | "working" | "untested" | "off";
export const HEALTH_ORDER: HealthState[] = ["failing", "retrying", "working", "untested", "off"];
export const HEALTH_WORDS: Record<HealthState, { label: string; plural: string; icon: IconName; about: string }> = {
  failing: { label: "Failing", plural: "Failing", icon: "x-circle", about: "The last send was refused" },
  retrying: { label: "Trying again", plural: "Trying again", icon: "refresh", about: "The last send is being retried" },
  working: { label: "Working", plural: "Working", icon: "check-circle", about: "The last send arrived" },
  untested: { label: "Not tested yet", plural: "Not tested yet", icon: "info", about: "Nothing has been sent through them" },
  off: { label: "Turned off", plural: "Turned off", icon: "pause", about: "Kept for the record of what was sent" },
};

export interface ChannelHealth {
  state: HealthState;
  tone: RiskTone | "neutral";
  badge: { tone: BadgeTone; label: string; icon: IconName };
  /** "Last try 2 hours ago · Slack refused it: the address was removed." */
  line: string;
  latest: Delivery | null;
  problem: DeliveryProblem | null;
}

/** A channel's health from the newest delivery through it. */
export function channelHealth(channel: Pick<Channel, "id" | "enabled">, deliveries: Delivery[], now: string): ChannelHealth {
  const own = newestFirst(deliveries.filter((delivery) => delivery.channel_id === channel.id));
  const latest = own[0] ?? null;
  const when = latest ? deliveryTime(latest) : null;
  const at = when ? ago(when, now) : null;
  if (!channel.enabled) {
    return { state: "off", tone: "neutral", badge: { tone: "neutral", label: HEALTH_WORDS.off.label, icon: "pause" }, line: latest && at ? `Last sent ${at} · history kept` : "History kept", latest, problem: null };
  }
  if (!latest) {
    return { state: "untested", tone: "neutral", badge: { tone: "neutral", label: HEALTH_WORDS.untested.label, icon: "info" }, line: "Nothing has been sent through it yet. Send a test.", latest, problem: null };
  }
  const problem = deliveryProblem(latest);
  if (latest.status === "failed") {
    return { state: "failing", tone: "urgent", badge: { tone: "urgent", label: HEALTH_WORDS.failing.label, icon: "x-circle" }, line: [at ? `Last try ${at}` : null, problem?.sentence ?? null].filter(Boolean).join(" · "), latest, problem };
  }
  if (latest.status === "delivered") {
    const tries = latest.attempts > 1 ? ` · delivered after ${latest.attempts} tries` : "";
    return { state: "working", tone: "fine", badge: { tone: "fine", label: HEALTH_WORDS.working.label, icon: "check-circle" }, line: `${at ? `Last sent ${at}` : "Delivered"}${tries}`, latest, problem: null };
  }
  const nextTry = latest.next_attempt_at ? ` · next try ${fromNowWords(latest.next_attempt_at, now)}` : "";
  const tries = latest.attempts > 0 ? `After ${latest.attempts} ${latest.attempts === 1 ? "try" : "tries"}` : "Waiting to send";
  return { state: "retrying", tone: "soon", badge: { tone: "soon", label: HEALTH_WORDS.retrying.label, icon: "refresh" }, line: `${tries}${nextTry}`, latest, problem };
}

function fromNowWords(value: string, now: string): string {
  const milliseconds = new Date(value).valueOf() - new Date(now).valueOf();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "any moment";
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** Which alerts a rule sends, in words: "All alerts", "An alert opened". */
export function eventWords(glob: string): string {
  if (glob === "*") return "All alerts";
  if (glob in DISPLAY_ENUMS.eventKind) return displayEnum("eventKind", glob);
  return `Events matching “${glob}”`;
}

export function patternWords(glob: string): string {
  if (glob === "*") return "all alerts";
  const exact = eventWords(glob);
  return exact.startsWith("Events") ? `events matching “${glob}”` : `“${exact.toLowerCase()}” alerts`;
}

/** The alerts Keel really sends; the only choices the rule form offers. */
export const RULE_EVENTS: { value: string; label: string; hint: string }[] = [
  { value: "*", label: "All alerts", hint: "Every alert Keel raises, and tests" },
  { value: "alert.opened", label: "An alert opened", hint: "The first time a check fails" },
  { value: "alert.reopened", label: "An alert came back", hint: "A resolved alert fails again" },
];

export function severityWords(minSeverity: string): string {
  if (minSeverity === "critical") return "Critical only";
  if (minSeverity === "warning") return "Warning or above";
  return "All severities";
}

export function ruleSentence(rule: Pick<Subscription, "event_glob" | "min_severity">, channel: Pick<Channel, "kind" | "config"> | null): string {
  const to = channel ? channelName(channel) : "a channel that is no longer readable";
  const what = rule.event_glob === "*" ? "every alert" : patternWords(rule.event_glob);
  const rated = rule.min_severity === "notice" ? "" : ` rated ${displayEnum("severity", rule.min_severity).toLowerCase()} or above`;
  return `Sends ${what}${rated} to ${to}.`;
}

/** "30 minutes", "1 hour", "4 hours", "2 days". */
export function durationWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours % 1 === 0 ? `${hours} ${hours === 1 ? "hour" : "hours"}` : `${minutes} minutes`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export const WAIT_PRESETS: { value: string; label: string }[] = [
  { value: String(15 * 60_000), label: "15 min" },
  { value: String(30 * 60_000), label: "30 min" },
  { value: String(60 * 60_000), label: "1 h" },
  { value: String(4 * 60 * 60_000), label: "4 h" },
];

export function escalationTitle(rule: Pick<EscalationRule, "min_severity" | "ack_within_ms">): string {
  const what = rule.min_severity === "critical" ? "A critical alert" : rule.min_severity === "warning" ? "A warning or critical alert" : "Any alert";
  return `${what} not acknowledged in ${durationWords(rule.ack_within_ms)}`;
}

export function escalationOwner(rule: Pick<EscalationRule, "owner_principal_id" | "owner_name" | "owner_email" | "owner_disabled_at">): string | null {
  if (!rule.owner_principal_id) return null;
  return personLabel({ kind: "principal", id: rule.owner_principal_id, name: rule.owner_name ?? null, email: rule.owner_email ?? null, readable: !rule.owner_disabled_at }, "an unknown person");
}

export function escalationTarget(rule: Pick<EscalationRule, "escalate_channel_id">, channels: Channel[]): Channel | null {
  return channels.find((channel) => channel.id === rule.escalate_channel_id) ?? null;
}

/** The sent list's title for one delivery: what it was about, with the resource named. */
export function deliveryTitle(delivery: Pick<Delivery, "event">): string {
  const { kind, resourceKey } = delivery.event;
  const subject = typeof resourceKey === "string" && resourceKey.includes(":") ? plainLabel(resourceKey) : typeof resourceKey === "string" && resourceKey ? resourceKey : null;
  const lead = kind === "alert.opened" ? "Alert opened" : kind === "alert.reopened" ? "Alert came back" : kind === "alert.escalated" ? "Nobody responded" : kind === "test" ? "Test alert" : displayEnum("eventKind", kind);
  return subject && kind !== "test" ? `${lead}: ${subject}` : lead;
}

/** Where a sent row leads: the alert it was about, when the event names one. */
export function deliveryHref(delivery: Pick<Delivery, "event">): string | null {
  const id = delivery.event.alertId;
  return typeof id === "string" && id ? `/alerts?open=${encodeURIComponent(id)}` : null;
}

const DAY = 24 * 3_600_000;

export interface NotificationCounts {
  channelsOn: number;
  channelsTotal: number;
  offNames: string[];
  failingNames: string[];
  retryingNames: string[];
  rules: number;
  escalationsOn: number;
  sentDay: number;
  failedDay: number;
  /** Eight 3-hour buckets over the last 24 hours, oldest first. */
  buckets: number[];
}

export function notificationCounts(data: { channels: Channel[]; subscriptions: Subscription[]; escalationRules: EscalationRule[]; deliveries: Delivery[] }, now: string): NotificationCounts {
  const since = new Date(now).valueOf() - DAY;
  const inDay = data.deliveries.filter((delivery) => {
    const at = new Date(delivery.created_at ?? now).valueOf();
    return Number.isFinite(at) ? at >= since : true;
  });
  const buckets = Array.from({ length: 8 }, () => 0);
  for (const delivery of inDay) {
    const at = new Date(delivery.created_at ?? now).valueOf();
    const index = Math.min(7, Math.max(0, Math.floor((at - since) / (3 * 3_600_000))));
    buckets[index] += 1;
  }
  const health = data.channels.map((channel) => ({ channel, health: channelHealth(channel, data.deliveries, now) }));
  return {
    channelsOn: data.channels.filter((channel) => channel.enabled).length,
    channelsTotal: data.channels.length,
    offNames: health.filter((entry) => entry.health.state === "off").map((entry) => channelName(entry.channel)),
    failingNames: health.filter((entry) => entry.health.state === "failing").map((entry) => channelName(entry.channel)),
    retryingNames: health.filter((entry) => entry.health.state === "retrying").map((entry) => channelName(entry.channel)),
    rules: data.subscriptions.length,
    escalationsOn: data.escalationRules.filter((rule) => rule.enabled).length,
    sentDay: inDay.length,
    failedDay: inDay.filter((delivery) => delivery.status === "failed").length,
    buckets,
  };
}

/** "secops@contoso.com, PagerDuty (EU) and Slack". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Does any rule send critical alerts to a channel that is on? */
export function criticalCovered(subscriptions: Subscription[], channels: Channel[]): boolean {
  const on = new Set(channels.filter((channel) => channel.enabled).map((channel) => channel.id));
  return subscriptions.some((rule) => on.has(rule.channel_id) && (rule.event_glob === "*" || rule.event_glob.startsWith("alert.")));
}

export function notificationsStatus(counts: NotificationCounts, data: { channels: Channel[]; subscriptions: Subscription[] }): { tone: RiskTone; label: string } {
  if (counts.failingNames.length === 1) return { tone: "urgent", label: `${counts.failingNames[0]} is failing` };
  if (counts.failingNames.length > 1) return { tone: "urgent", label: `${counts.failingNames.length} channels are failing` };
  if (counts.channelsTotal === 0) return { tone: "soon", label: "No channel yet" };
  if (counts.channelsOn === 0) return { tone: "urgent", label: "No channel is on" };
  if (counts.rules === 0) return { tone: "soon", label: "No rule yet" };
  if (!criticalCovered(data.subscriptions, data.channels)) return { tone: "soon", label: "No rule sends critical alerts" };
  if (counts.retryingNames.length) return { tone: "soon", label: "Keel is trying again" };
  return { tone: "fine", label: counts.sentDay ? "Alerts are arriving" : "Ready" };
}

export type VerdictAction = "test" | "add-channel" | "add-rule" | "turn-on" | null;

export interface NotificationsVerdict {
  text: string;
  detail?: string;
  tone: "good" | "attention" | "soon";
  action: VerdictAction;
  /** The channel the action is about, when it is one. */
  channelId: string | null;
}

/** The one sentence at the top. The failing channel comes first; "Alerts go to…" only
 * when everything works. A viewer without configuration (channels null) sees counts. */
export function notificationsVerdict(data: { channels: Channel[] | null; subscriptions: Subscription[]; deliveries: Delivery[] }, now: string): NotificationsVerdict {
  const { channels, subscriptions, deliveries } = data;
  if (channels === null) {
    const failed = deliveries.filter((delivery) => delivery.status === "failed").length;
    const text = deliveries.length === 0
      ? "No alerts have been sent recently."
      : `${deliveries.length} ${deliveries.length === 1 ? "alert was" : "alerts were"} sent recently${failed ? `; ${failed} failed` : ""}.`;
    return { text, tone: failed ? "attention" : "good", action: null, channelId: null };
  }
  const health = channels.map((channel) => ({ channel, health: channelHealth(channel, deliveries, now) }));
  const enabled = health.filter((entry) => entry.channel.enabled);
  if (channels.length === 0) return { text: "No alert channel is set up, so nobody is notified.", detail: "Add where alerts should go first, then a rule for which alerts go there.", tone: "attention", action: "add-channel", channelId: null };
  if (enabled.length === 0) return { text: "Every alert channel is turned off, so nobody is notified.", detail: "Turn a channel back on, or add a new one.", tone: "attention", action: "turn-on", channelId: channels[0].id };
  const failing = enabled.filter((entry) => entry.health.state === "failing");
  if (failing.length) {
    const first = failing[0];
    const others = enabled.length - failing.length;
    const since = first.health.latest ? deliveryTime(first.health.latest) : null;
    const sinceWords = since ? ago(since, now) : "";
    const lead = failing.length === 1
      ? sinceWords && sinceWords !== "just now" && sinceWords.endsWith(" ago")
        ? `${channelName(first.channel)} has been failing for ${sinceWords.replace(/ ago$/, "")}`
        : `${channelName(first.channel)} has just failed`
      : `${listWords(failing.map((entry) => channelName(entry.channel)))} are failing`;
    const rest = others === 0 ? "no other channel is on" : others === 1 ? "the other channel works" : `the other ${others} channels work`;
    const problem = first.health.problem;
    return { text: `${lead}; ${rest}.`, detail: problem ? problem.sentence : undefined, tone: "attention", action: "test", channelId: first.channel.id };
  }
  if (subscriptions.length === 0) return { text: "Channels are set up, but no rule sends anything to them.", detail: "Add a rule so alerts reach someone.", tone: "attention", action: "add-rule", channelId: null };
  const retrying = enabled.filter((entry) => entry.health.state === "retrying");
  const targets = listWords(enabled.map((entry) => channelShort(entry.channel)));
  if (retrying.length) {
    return { text: `Keel is trying again to reach ${listWords(retrying.map((entry) => channelName(entry.channel)))}; the other channels work.`, detail: retrying[0].health.line + ".", tone: "soon", action: null, channelId: null };
  }
  if (!criticalCovered(subscriptions, channels)) {
    return { text: `Alerts go to ${targets}, but no rule sends critical alerts.`, detail: "Add a rule for all alerts or for alerts that open.", tone: "soon", action: "add-rule", channelId: null };
  }
  const delivered = deliveries.filter((delivery) => delivery.status === "delivered").length;
  return { text: `Alerts go to ${targets}.`, detail: deliveries.length ? `${delivered} of the last ${deliveries.length} ${deliveries.length === 1 ? "send" : "sends"} arrived.` : "Nothing has been sent yet. Send a test to prove a channel works.", tone: "good", action: null, channelId: null };
}

/** Channels in the order the list shows them: failing first, then retrying, working,
 * untested, off; newest first inside each. */
export function orderChannels(channels: Channel[], deliveries: Delivery[], now: string): Channel[] {
  return [...channels].sort((a, b) => {
    const rank = HEALTH_ORDER.indexOf(channelHealth(a, deliveries, now).state) - HEALTH_ORDER.indexOf(channelHealth(b, deliveries, now).state);
    if (rank) return rank;
    return new Date(b.created_at ?? 0).valueOf() - new Date(a.created_at ?? 0).valueOf();
  });
}

/** A day heading for the sent list: "Today", "Yesterday", else the date. */
export function dayLabel(value: string | null, now: string): string {
  if (!value) return "Unknown day";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown day";
  const today = new Date(now);
  const days = Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(date);
}

export function dayKey(value: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "unknown" : date.toISOString().slice(0, 10);
}

/** "09:40" in UTC, the portal's one clock. */
export function clockWords(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date);
}

/** Toast wording after each write. */
export const OUTCOME_WORDS = {
  testQueued: (name: string) => ({ title: `Test alert queued for ${name}`, detail: "It appears under Sent as soon as Keel has tried it." }),
  channelAdded: (name: string) => ({ title: `${name} added` }),
  channelOff: (name: string) => ({ title: `${name} turned off`, detail: "Its history is kept. Rules that use it stop sending until you pick another channel." }),
  channelOn: (name: string) => ({ title: `${name} turned back on` }),
  ruleAdded: { title: "Rule added" },
  ruleChanged: { title: "Rule changed" },
  ruleDeleted: { title: "Rule deleted" },
  escalationAdded: { title: "Escalation rule added" },
  escalationOff: { title: "Escalation rule turned off" },
  escalationOn: { title: "Escalation rule turned back on" },
};

/** What a refused write means, in words. */
export function writeError(status: number, payload: { error?: string } | null): string {
  if (status === 403) return "Your access does not allow changing notification settings.";
  if (status === 404) return "That is no longer there. The page will refresh.";
  if (status === 409 && payload?.error === "channel_off") return "This channel is turned off. Turn it back on to send a test.";
  if (status === 400 && payload?.error && payload.error !== "invalid_request") return payload.error;
  if (status === 400) return "Keel could not read the form. Check the fields and try again.";
  if (status === 0) return "Keel could not be reached. Check the connection and try again.";
  return "The notification settings were not saved. Try again.";
}
