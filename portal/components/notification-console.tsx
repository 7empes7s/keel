"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { displayEnum, fromNow } from "@/lib/presentation";
import { toast } from "@/lib/toast";
import type { Channel, Subscription, Delivery } from "@/lib/notifications";
import { channelName, channelSentence, patternWords } from "@/lib/notifications-view";

// Roadmap task-130: channels, routing rules and deliveries by name and in words;
// forms with labelled fields instead of a JSON text box; raw config and ids in the record.

export function DeliveryTable({ deliveries, channels = null, now = new Date().toISOString() }: { deliveries: Delivery[]; channels?: Channel[] | null; now?: string }) {
  const channelById = new Map((channels ?? []).map((channel) => [channel.id, channel]));
  return <section aria-labelledby="deliveries-heading" className="report-section">
    <div className="section-heading-row report-heading">
      <div><p className="section-kicker">Sent</p><h2 id="deliveries-heading">Recent alerts</h2></div>
      <span className="result-count">{deliveries.length} shown</span>
    </div>
    {deliveries.length === 0 ? <p className="empty-state">No alerts have been sent yet.</p> : <ul className="activity-list">{deliveries.map((delivery) => {
      const channel = channelById.get(delivery.channel_id);
      const to = channel ? channelName(channel) : delivery.channel_kind === "email" ? "an email channel" : delivery.channel_kind === "webhook" ? "a webhook" : channelName({ kind: delivery.channel_kind, config: {} });
      const receipt = delivery.provider_receipt ?? null;
      return <li className="activity-item" key={delivery.id}>
        <div className="activity-main">
          <p className="activity-title">{displayEnum("eventKind", delivery.event.kind)} ({displayEnum("severity", delivery.event.severity).toLowerCase()}), sent to {to}</p>
          <p className="activity-meta">
            <span className={`delivery-status delivery-${delivery.status}`}>{displayEnum("deliveryStatus", delivery.status)}</span>
            {delivery.attempts > 1 ? ` after ${delivery.attempts} attempts` : null}
            {delivery.next_attempt_at ? <> · next try <time dateTime={delivery.next_attempt_at}>{fromNow(delivery.next_attempt_at, now)}</time></> : null}
            {delivery.last_error ? <> · last error: {delivery.last_error}</> : null}
          </p>
          {receipt?.semantics && delivery.status === "delivered" ? <p className="field-help">{receipt.semantics}</p> : null}
        </div>
        <TechnicalDetails>
          <RecordField label="Delivery ID" value={delivery.id} />
          <RecordField label="Channel ID" value={delivery.channel_id} />
          <RecordField copy={false} label="Event and status codes" value={`${delivery.event.kind} · ${delivery.event.severity} · ${delivery.status} · ${delivery.attempts} attempts`} />
          <RecordField copy={false} label="Next attempt" value={delivery.next_attempt_at} />
          {receipt ? <RecordField copy={false} label="Provider reply" value={JSON.stringify(receipt, null, 2)} /> : null}
        </TechnicalDetails>
      </li>;
    })}</ul>}
  </section>;
}

const TOAST_TITLES: Record<string, string> = {
  "create-channel": "Channel created",
  "create-subscription": "Rule created",
  "disable-channel": "Channel turned off",
  "delete-subscription": "Rule deleted",
};

export function NotificationConsole({ canConfiguration, channels, subscriptions }: {
  canConfiguration: boolean; channels: Channel[]; subscriptions: Subscription[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The write in flight, so only the control that started it shows a spinner.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [kind, setKind] = useState("webhook");
  if (!canConfiguration) return null;
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  async function write(url: string, method: string, body?: unknown, action = `${method} ${url}`) {
    if (!canConfiguration || busy) return;
    setBusy(true); setBusyAction(action); setError(null);
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? "The notification settings were not saved"); }
      toast({ title: TOAST_TITLES[action] ?? "Notification settings saved" });
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The notification settings were not saved"); }
    finally { setBusy(false); setBusyAction(null); }
  }
  function createChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const config: Record<string, string> = kind === "email"
      ? { to: text("to"), from: text("from"), ...(text("subject") ? { subject: text("subject") } : {}) }
      : kind === "teams" || kind === "slack" ? { endpointRef: text("endpointRef") }
      : kind === "pagerduty" ? { routingKeyRef: text("routingKeyRef"), region: text("region") || "us" }
      : kind === "sms" ? { provider: text("provider"), accountSid: text("accountSid"), authTokenRef: text("authTokenRef"), from: text("from"), to: text("to") }
      : { url: text("url") };
    void write("/api/channels", "POST", { kind, config }, "create-channel");
  }
  function createSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void write("/api/subscriptions", "POST", { channelId: form.get("channelId"), eventGlob: form.get("eventGlob"), minSeverity: form.get("minSeverity") }, "create-subscription");
  }
  return <>
    {error ? <p className="action-error" role="alert">{error}</p> : null}
    <section aria-labelledby="channels-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div><p className="section-kicker">Where alerts go</p><h2 id="channels-heading">Channels</h2></div>
        <span className="result-count">{channels.length} set up</span>
      </div>
      {channels.length === 0 ? <p className="empty-state">No channels are set up.</p> : <ul className="item-list">{channels.map((channel) => <li className="item-card" key={channel.id}>
        <div className="item-card-head">
          <strong>{channelName(channel)}</strong>
          <span className={channel.enabled ? "active-indicator" : "inactive-indicator"}>{channel.enabled ? "On" : "Off"}</span>
        </div>
        <p>{channelSentence(channel)}</p>
        {channel.enabled ? <div className="form-actions"><ConfirmButton confirmLabel="Turn off channel" description={<p>Alerts sent to {channelName(channel)} stop immediately, including critical ones. Rules that use it stay set up.</p>} disabled={busy} onConfirm={() => write(`/api/channels/${channel.id}/disable`, "POST", undefined, "disable-channel")} size="sm" title={`Turn off ${channelName(channel)}?`}>Turn off</ConfirmButton></div> : null}
        <TechnicalDetails>
          <RecordField label="Channel ID" value={channel.id} />
          <RecordField copy={false} label="Config" value={JSON.stringify(channel.config, null, 2)} />
        </TechnicalDetails>
      </li>)}</ul>}
      <form className="form-card" onSubmit={createChannel}><fieldset disabled={busy}><legend>Add a channel</legend>
        <div className="form-grid">
          <label className="filter-field"><span>Kind</span><select name="kind" onChange={(event) => setKind(event.target.value)} value={kind}><option value="webhook">Webhook</option><option value="email">Email</option><option value="teams">Microsoft Teams</option><option value="slack">Slack</option><option value="pagerduty">PagerDuty</option><option value="sms">Text message (SMS)</option></select></label>
          {kind === "teams" || kind === "slack" ? <>
            <label className="filter-field form-grid-wide"><span>Server setting that holds the webhook address</span><input autoComplete="off" name="endpointRef" pattern="env:[A-Za-z_][A-Za-z0-9_]*" placeholder={kind === "teams" ? "env:KEEL_TEAMS_WEBHOOK" : "env:KEEL_SLACK_WEBHOOK"} required /></label>
            <p className="field-help form-grid-wide">The address works as a password, so KEEL keeps only the name of the setting and reads the address when it sends.{kind === "teams" ? " Use a Teams Workflows webhook; old Office 365 connector addresses are not supported." : ""}</p>
          </> : kind === "pagerduty" ? <>
            <label className="filter-field"><span>Server setting that holds the integration key</span><input autoComplete="off" name="routingKeyRef" pattern="env:[A-Za-z_][A-Za-z0-9_]*" placeholder="env:KEEL_PAGERDUTY_KEY" required /></label>
            <label className="filter-field"><span>PagerDuty region</span><select name="region" defaultValue="us"><option value="us">United States</option><option value="eu">Europe</option></select></label>
          </> : kind === "sms" ? <>
            <label className="filter-field"><span>Provider</span><select name="provider" defaultValue="twilio"><option value="twilio">Twilio</option></select></label>
            <label className="filter-field"><span>Twilio account SID</span><input autoComplete="off" name="accountSid" pattern="AC[0-9a-fA-F]{32}" required /></label>
            <label className="filter-field"><span>Server setting that holds the auth token</span><input autoComplete="off" name="authTokenRef" pattern="env:[A-Za-z_][A-Za-z0-9_]*" placeholder="env:KEEL_TWILIO_TOKEN" required /></label>
            <label className="filter-field"><span>Send from</span><input autoComplete="off" name="from" placeholder="+15551230000" required type="tel" /></label>
            <label className="filter-field"><span>Send to</span><input autoComplete="off" name="to" placeholder="+15551239999" required type="tel" /></label>
          </> : kind === "email" ? <>
            <label className="filter-field"><span>Send to</span><input autoComplete="off" name="to" placeholder="secops@contoso.com" required type="email" /></label>
            <label className="filter-field"><span>Send from</span><input autoComplete="off" name="from" placeholder="keel@contoso.com" required type="email" /></label>
            <label className="filter-field"><span>Subject (optional)</span><input autoComplete="off" name="subject" /></label>
          </> : (
            <label className="filter-field form-grid-wide"><span>Webhook address</span><input autoComplete="off" name="url" placeholder="https://hooks.contoso.com/keel" required type="url" /></label>
          )}
        </div>
        <div className="form-actions"><button aria-busy={busyAction === "create-channel" || undefined} className="btn btn-primary" type="submit">Add channel</button></div>
      </fieldset></form>
    </section>
    <section aria-labelledby="subscriptions-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div><p className="section-kicker">Which alerts go where</p><h2 id="subscriptions-heading">Rules</h2></div>
        <span className="result-count">{subscriptions.length} active</span>
      </div>
      {subscriptions.length === 0 ? <p className="empty-state">No rules are set up, so no alert is sent.</p> : <ul className="item-list">{subscriptions.map((subscription) => {
        const channel = channelById.get(subscription.channel_id);
        const to = channel ? channelName(channel) : "a channel that is no longer readable";
        return <li className="item-card" key={subscription.id}>
          <p>Sends {patternWords(subscription.event_glob)} rated {displayEnum("severity", subscription.min_severity).toLowerCase()} or above to {to}.</p>
          <div className="form-actions">
            <ConfirmButton confirmLabel="Delete rule" description={<p>{patternWords(subscription.event_glob).replace(/^./, (c) => c.toUpperCase())} will no longer be sent to {to}. Recreate the rule to restore it.</p>} disabled={busy} onConfirm={() => write(`/api/subscriptions/${subscription.id}`, "DELETE", undefined, "delete-subscription")} size="sm" title="Delete this rule?">Delete rule</ConfirmButton>
          </div>
          <TechnicalDetails>
            <RecordField label="Subscription ID" value={subscription.id} />
            <RecordField label="Channel ID" value={subscription.channel_id} />
            <RecordField copy={false} label="Event pattern and minimum severity" value={`${subscription.event_glob} · ${subscription.min_severity}`} />
          </TechnicalDetails>
        </li>;
      })}</ul>}
      <form className="form-card" onSubmit={createSubscription}><fieldset disabled={busy || channels.length === 0}><legend>Add a rule</legend>
        <div className="form-grid">
          <label className="filter-field"><span>Send to</span><select name="channelId" required>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channelName(channel)}</option>)}</select></label>
          <label className="filter-field"><span>Which events (* for all)</span><input name="eventGlob" required defaultValue="*" /></label>
          <label className="filter-field"><span>Rated at least</span><select name="minSeverity">{["notice", "warning", "critical"].map((severity) => <option key={severity} value={severity}>{displayEnum("severity", severity)}</option>)}</select></label>
        </div>
        <div className="form-actions"><button aria-busy={busyAction === "create-subscription" || undefined} className="btn btn-primary" type="submit">Add rule</button></div>
      </fieldset></form>
    </section>
  </>;
}
