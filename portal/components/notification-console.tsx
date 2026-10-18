"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BaselinesStyles } from "@/components/baselines/styles";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Segmented } from "@/components/pickers/segmented";
import { SettingsEmptyRow, SettingsGroup, SettingsRow, SettingsSection } from "@/components/settings/parts";
import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import type { RiskTone } from "@/lib/menu-status";
import { displayEnum, fromNow } from "@/lib/presentation";
import { toast } from "@/lib/toast";
import type { Channel, Subscription, Delivery } from "@/lib/notifications";
import { channelName, channelSentence, patternWords } from "@/lib/notifications-view";

// Roadmap task-130: channels, routing rules and deliveries by name and in words;
// forms with labelled fields instead of a JSON text box; raw config and ids in the record.
// Each channel is a group holding the rules that send to it, so "which alerts go where"
// reads in one place; adding a channel or a rule opens the side panel.

// A delivery's status as the portal's one badge: colour for risk only.
const DELIVERY_TONES: Record<string, BadgeTone> = {
  queued: "neutral", delivering: "low", retrying: "soon", delivered: "fine", failed: "urgent", cancelled: "neutral",
};

const KINDS = [
  { value: "webhook", label: "Webhook", icon: "link", hint: "Posts each alert to an address" },
  { value: "email", label: "Email", icon: "inbox", hint: "Sends each alert to a mailbox" },
  { value: "teams", label: "Microsoft Teams", icon: "service-teams", hint: "Posts a card through a Teams workflow" },
  { value: "slack", label: "Slack", icon: "bell", hint: "Posts through a Slack webhook" },
  { value: "pagerduty", label: "PagerDuty", icon: "alert", hint: "Opens an incident" },
  { value: "sms", label: "Text message (SMS)", icon: "bell", hint: "Texts a phone through Twilio" },
] as const satisfies readonly { value: string; label: string; icon: IconName; hint: string }[];
type Kind = (typeof KINDS)[number]["value"];

function kindIcon(kind: string): IconName {
  return KINDS.find((entry) => entry.value === kind)?.icon ?? "bell";
}

function capitalise(text: string): string {
  return text.replace(/^./, (letter) => letter.toUpperCase());
}

function deliveryRisk(status: string): RiskTone | null {
  return status === "failed" ? "urgent" : status === "retrying" ? "soon" : null;
}

export function DeliveryTable({ deliveries, channels = null, now = new Date().toISOString() }: { deliveries: Delivery[]; channels?: Channel[] | null; now?: string }) {
  const channelById = new Map((channels ?? []).map((channel) => [channel.id, channel]));
  const failed = deliveries.filter((delivery) => delivery.status === "failed").length;
  return <SettingsSection about="What KEEL sent, newest first." id="deliveries-heading" title="Recent alerts">
    {deliveries.length === 0 ? <p className="sel-empty">No alerts have been sent yet.</p> : <>
      <SettingsGroup about={failed ? `${failed} could not be delivered` : "Every alert reached its channel"} count={`${deliveries.length} shown`} icon="bell" title="Sent alerts">
        {deliveries.map((delivery) => {
          const channel = channelById.get(delivery.channel_id);
          const to = channel ? channelName(channel) : delivery.channel_kind === "email" ? "an email channel" : delivery.channel_kind === "webhook" ? "a webhook" : channelName({ kind: delivery.channel_kind, config: {} });
          const receipt = delivery.provider_receipt ?? null;
          const risk = deliveryRisk(delivery.status);
          const line = [
            delivery.attempts > 1 ? `After ${delivery.attempts} attempts.` : null,
            delivery.next_attempt_at ? `Next try ${fromNow(delivery.next_attempt_at, now)}.` : null,
            delivery.last_error ? `Last error: ${delivery.last_error}.` : null,
            receipt?.semantics && delivery.status === "delivered" ? receipt.semantics : null,
          ].filter(Boolean).join(" ");
          return <SettingsRow
            icon={kindIcon(delivery.channel_kind)}
            iconTone={risk}
            key={delivery.id}
            line={line || null}
            meta={<>{displayEnum("severity", delivery.event.severity)} · to {to}</>}
            name={displayEnum("eventKind", delivery.event.kind)}
            status={<Badge tone={DELIVERY_TONES[delivery.status] ?? "neutral"}>{displayEnum("deliveryStatus", delivery.status)}</Badge>}
            tone={risk}
          />;
        })}
      </SettingsGroup>
      <TechnicalDetails summary="Technical details for these alerts">
        {deliveries.map((delivery) => {
          const receipt = delivery.provider_receipt ?? null;
          return <div className="st-record" key={delivery.id}>
            <RecordField label="Delivery ID" value={delivery.id} />
            <RecordField label="Channel ID" value={delivery.channel_id} />
            <RecordField copy={false} label="Event and status codes" value={`${delivery.event.kind} · ${delivery.event.severity} · ${delivery.status} · ${delivery.attempts} attempts`} />
            <RecordField copy={false} label="Next attempt" value={delivery.next_attempt_at} />
            {receipt ? <RecordField copy={false} label="Provider reply" value={JSON.stringify(receipt, null, 2)} /> : null}
          </div>;
        })}
      </TechnicalDetails>
    </>}
  </SettingsSection>;
}

const TOAST_TITLES: Record<string, string> = {
  "create-channel": "Channel created",
  "create-subscription": "Rule created",
  "disable-channel": "Channel turned off",
  "delete-subscription": "Rule deleted",
};

type Panel = "channel" | "rule" | null;

export function NotificationConsole({ canConfiguration, channels, subscriptions }: {
  canConfiguration: boolean; channels: Channel[]; subscriptions: Subscription[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The write in flight, so only the control that started it shows a spinner.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [kind, setKind] = useState<Kind>("webhook");
  const [region, setRegion] = useState<"us" | "eu">("us");
  const [ruleChannel, setRuleChannel] = useState<string | null>(null);
  const [severity, setSeverity] = useState<"notice" | "warning" | "critical">("notice");
  if (!canConfiguration) return null;
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  async function write(url: string, method: string, body?: unknown, action = `${method} ${url}`): Promise<boolean> {
    if (!canConfiguration || busy) return false;
    setBusy(true); setBusyAction(action); setError(null);
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? "The notification settings were not saved"); }
      toast({ title: TOAST_TITLES[action] ?? "Notification settings saved" });
      router.refresh();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The notification settings were not saved"); return false; }
    finally { setBusy(false); setBusyAction(null); }
  }
  function open(next: Panel) {
    setError(null);
    if (next === "rule") setRuleChannel((current) => current ?? channels[0]?.id ?? null);
    setPanel(next);
  }
  async function createChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const config: Record<string, string> = kind === "email"
      ? { to: text("to"), from: text("from"), ...(text("subject") ? { subject: text("subject") } : {}) }
      : kind === "teams" || kind === "slack" ? { endpointRef: text("endpointRef") }
      : kind === "pagerduty" ? { routingKeyRef: text("routingKeyRef"), region }
      : kind === "sms" ? { provider: "twilio", accountSid: text("accountSid"), authTokenRef: text("authTokenRef"), from: text("from"), to: text("to") }
      : { url: text("url") };
    if (await write("/api/channels", "POST", { kind, config }, "create-channel")) setPanel(null);
  }
  async function createSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (await write("/api/subscriptions", "POST", { channelId: ruleChannel, eventGlob: form.get("eventGlob"), minSeverity: severity }, "create-subscription")) setPanel(null);
  }
  const field = (label: string, input: ReactNode, wide = false) => <label className="picker-field" data-wide={wide || undefined}><span className="picker-label">{label}</span>{input}</label>;
  const orphans = subscriptions.filter((subscription) => !channelById.has(subscription.channel_id));
  const ruleRow = (subscription: Subscription, to: string) => <SettingsRow
    actions={<ConfirmButton confirmLabel="Delete rule" description={<p>{capitalise(patternWords(subscription.event_glob))} will no longer be sent to {to}. Recreate the rule to restore it.</p>} disabled={busy} onConfirm={async () => { await write(`/api/subscriptions/${subscription.id}`, "DELETE", undefined, "delete-subscription"); }} size="sm" title="Delete this rule?" tone="danger">Delete rule</ConfirmButton>}
    icon="filter"
    key={subscription.id}
    meta={`Rule · sent to ${to}`}
    name={capitalise(patternWords(subscription.event_glob))}
    status={<Badge icon="filter" tone="neutral">{displayEnum("severity", subscription.min_severity)} and above</Badge>}
  />;
  return <>
    {error && panel === null ? <p className="action-error" role="alert">{error}</p> : null}
    <SettingsSection
      about="Each channel with the rules that send alerts to it."
      extra={<>
        <button className="btn btn-sm" disabled={channels.length === 0} onClick={() => open("rule")} type="button"><Icon name="filter" />Add rule</button>
        <button className="btn btn-sm" onClick={() => open("channel")} type="button"><Icon name="plus" />Add channel</button>
      </>}
      id="channels-heading"
      title="Where alerts go"
    >
      {channels.length === 0 ? <p className="sel-empty">No channels are set up, so no alert is sent.</p> : <div className="sel-groups">
        {channels.map((channel) => {
          const rules = subscriptions.filter((subscription) => subscription.channel_id === channel.id);
          return <SettingsGroup
            about={channelSentence(channel)}
            aside={<span className="st-group-aside">
              <Badge tone={channel.enabled ? "fine" : "neutral"}>{channel.enabled ? "On" : "Off"}</Badge>
              {channel.enabled ? <ConfirmButton confirmLabel="Turn off channel" description={<p>Alerts sent to {channelName(channel)} stop immediately, including critical ones. Rules that use it stay set up.</p>} disabled={busy} onConfirm={async () => { await write(`/api/channels/${channel.id}/disable`, "POST", undefined, "disable-channel"); }} size="sm" title={`Turn off ${channelName(channel)}?`}>Turn off</ConfirmButton> : null}
            </span>}
            count={`${rules.length} ${rules.length === 1 ? "rule" : "rules"}`}
            icon={kindIcon(channel.kind)}
            key={channel.id}
            title={channelName(channel)}
          >
            {rules.length === 0 ? <SettingsEmptyRow>No rule sends alerts here yet.</SettingsEmptyRow> : rules.map((subscription) => ruleRow(subscription, channelName(channel)))}
          </SettingsGroup>;
        })}
        {orphans.length ? <SettingsGroup about="These rules point at a channel KEEL can no longer read." count={`${orphans.length} ${orphans.length === 1 ? "rule" : "rules"}`} icon="alert" title="Channel not readable">
          {orphans.map((subscription) => ruleRow(subscription, "a channel that is no longer readable"))}
        </SettingsGroup> : null}
      </div>}
      {channels.length || subscriptions.length ? <TechnicalDetails summary="Technical details for channels and rules">
        {channels.map((channel) => <div className="st-record" key={channel.id}>
          <RecordField label={`Channel ID (${channelName(channel)})`} value={channel.id} />
          <RecordField copy={false} label="Config" value={JSON.stringify(channel.config, null, 2)} />
        </div>)}
        {subscriptions.map((subscription) => <div className="st-record" key={subscription.id}>
          <RecordField label="Subscription ID" value={subscription.id} />
          <RecordField label="Channel ID" value={subscription.channel_id} />
          <RecordField copy={false} label="Event pattern and minimum severity" value={`${subscription.event_glob} · ${subscription.min_severity}`} />
        </div>)}
      </TechnicalDetails> : null}
    </SettingsSection>

    {panel ? <BaselinesStyles /> : null}
    {panel === "channel" ? <DetailsSheet
      footer={<>
        <button className="btn" onClick={() => setPanel(null)} type="button">Cancel</button>
        <button aria-busy={busyAction === "create-channel" || undefined} className="btn btn-primary" disabled={busy} form="add-channel-form" type="submit">Add channel</button>
      </>}
      kicker="Notifications"
      onClose={() => setPanel(null)}
      title="Add a channel"
    >
      <form className="st-form" id="add-channel-form" onSubmit={(event) => void createChannel(event)}>
        <OptionPicker label="Kind" onChange={(value: Kind) => setKind(value)} options={KINDS} value={kind} />
        {kind === "teams" || kind === "slack" ? <>
          {field("Server setting that holds the webhook address", <input autoComplete="off" className="bl-input" name="endpointRef" pattern="env:[A-Za-z_][A-Za-z0-9_]*" placeholder={kind === "teams" ? "env:KEEL_TEAMS_WEBHOOK" : "env:KEEL_SLACK_WEBHOOK"} required />)}
          <p className="bl-help">The address works as a password, so KEEL keeps only the name of the setting and reads the address when it sends.{kind === "teams" ? " Use a Teams Workflows webhook; old Office 365 connector addresses are not supported." : ""}</p>
        </> : kind === "pagerduty" ? <>
          {field("Server setting that holds the integration key", <input autoComplete="off" className="bl-input" name="routingKeyRef" pattern="env:[A-Za-z_][A-Za-z0-9_]*" placeholder="env:KEEL_PAGERDUTY_KEY" required />)}
          <Segmented label="PagerDuty region" onChange={(value: "us" | "eu") => setRegion(value)} options={[{ value: "us", label: "United States" }, { value: "eu", label: "Europe" }]} value={region} />
        </> : kind === "sms" ? <>
          {field("Twilio account SID", <input autoComplete="off" className="bl-input" name="accountSid" pattern="AC[0-9a-fA-F]{32}" required />)}
          {field("Server setting that holds the auth token", <input autoComplete="off" className="bl-input" name="authTokenRef" pattern="env:[A-Za-z_][A-Za-z0-9_]*" placeholder="env:KEEL_TWILIO_TOKEN" required />)}
          {field("Send from", <input autoComplete="off" className="bl-input" name="from" placeholder="+15551230000" required type="tel" />)}
          {field("Send to", <input autoComplete="off" className="bl-input" name="to" placeholder="+15551239999" required type="tel" />)}
        </> : kind === "email" ? <>
          {field("Send to", <input autoComplete="off" className="bl-input" name="to" placeholder="secops@contoso.com" required type="email" />)}
          {field("Send from", <input autoComplete="off" className="bl-input" name="from" placeholder="keel@contoso.com" required type="email" />)}
          {field("Subject (optional)", <input autoComplete="off" className="bl-input" name="subject" />)}
        </> : field("Webhook address", <input autoComplete="off" className="bl-input" name="url" placeholder="https://hooks.contoso.com/keel" required type="url" />)}
        {error ? <p className="action-error" role="alert">{error}</p> : null}
      </form>
    </DetailsSheet> : null}
    {panel === "rule" ? <DetailsSheet
      footer={<>
        <button className="btn" onClick={() => setPanel(null)} type="button">Cancel</button>
        <button aria-busy={busyAction === "create-subscription" || undefined} className="btn btn-primary" disabled={busy || !ruleChannel} form="add-rule-form" type="submit">Add rule</button>
      </>}
      kicker="Notifications"
      onClose={() => setPanel(null)}
      title="Add a rule"
    >
      <form className="st-form" id="add-rule-form" onSubmit={(event) => void createSubscription(event)}>
        <OptionPicker label="Send to" onChange={(value: string) => setRuleChannel(value)} options={channels.map((channel) => ({ value: channel.id, label: channelName(channel), icon: kindIcon(channel.kind) }))} value={ruleChannel} />
        {field("Which events (* for all)", <input className="bl-input" defaultValue="*" name="eventGlob" required />)}
        <Segmented label="Rated at least" onChange={(value: "notice" | "warning" | "critical") => setSeverity(value)} options={(["notice", "warning", "critical"] as const).map((value) => ({ value, label: displayEnum("severity", value) }))} value={severity} />
        {error ? <p className="action-error" role="alert">{error}</p> : null}
      </form>
    </DetailsSheet> : null}
  </>;
}
