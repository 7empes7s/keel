"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { toast } from "@/lib/toast";
import type { Channel, Subscription, Delivery } from "@/lib/notifications";

export function DeliveryTable({ deliveries }: { deliveries: Delivery[] }) {
  return <section aria-labelledby="deliveries-heading" className="report-section">
    <div className="section-heading-row report-heading">
      <div><p className="section-kicker">Outbound</p><h2 id="deliveries-heading">Recent deliveries</h2></div>
      <span className="result-count">{deliveries.length} shown</span>
    </div>
    {deliveries.length === 0 ? <p className="empty-state">No deliveries yet.</p> : <div className="table-scroll"><table className="data-table"><thead><tr>
      {["Event kind", "Severity", "Channel", "Status", "Attempts", "Last error", "Next attempt"].map((title) => <th key={title} scope="col">{title}</th>)}
    </tr></thead><tbody>{deliveries.map((delivery) => <tr key={delivery.id}>
      <th data-label="Event kind" scope="row"><code className="natural-key">{delivery.event.kind}</code></th>
      <td data-label="Severity"><span className={`severity-pill severity-${delivery.event.severity}`}>{delivery.event.severity}</span></td>
      <td className="wrap-value" data-label="Channel">{delivery.channel_kind} · {delivery.channel_id}</td>
      <td data-label="Status"><span className={`delivery-status delivery-${delivery.status}`}>{delivery.status}</span></td>
      <td className="number-column" data-label="Attempts">{delivery.attempts}</td>
      <td className="wrap-value" data-label="Last error">{delivery.last_error ?? "—"}</td>
      <td data-label="Next attempt">{delivery.next_attempt_at ? <time dateTime={delivery.next_attempt_at}>{delivery.next_attempt_at}</time> : "—"}</td>
    </tr>)}</tbody></table></div>}
  </section>;
}

const TOAST_TITLES: Record<string, string> = {
  "create-channel": "Channel created",
  "create-subscription": "Subscription created",
  "disable-channel": "Channel disabled",
  "delete-subscription": "Subscription deleted",
};

export function NotificationConsole({ canConfiguration, channels, subscriptions }: {
  canConfiguration: boolean; channels: Channel[]; subscriptions: Subscription[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The write in flight, so only the control that started it shows a spinner.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  if (!canConfiguration) return null;
  async function write(url: string, method: string, body?: unknown, action = `${method} ${url}`) {
    if (!canConfiguration || busy) return;
    setBusy(true); setBusyAction(action); setError(null);
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? "Notification update failed"); }
      toast({ title: TOAST_TITLES[action] ?? "Notification settings updated" });
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Notification update failed"); }
    finally { setBusy(false); setBusyAction(null); }
  }
  function createChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try { const config: unknown = JSON.parse(String(form.get("config"))); void write("/api/channels", "POST", { kind: form.get("kind"), config }, "create-channel"); }
    catch { setError("Channel config must be valid JSON."); }
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
        <span className="result-count">{channels.length} configured</span>
      </div>
      {channels.length === 0 ? <p className="empty-state">No channels configured.</p> : <ul className="item-list">{channels.map((channel) => <li className="item-card" key={channel.id}>
        <div className="item-card-head">
          <strong>{channel.kind}</strong>
          <span className={channel.enabled ? "active-indicator" : "inactive-indicator"}>{channel.enabled ? "Enabled" : "Disabled"}</span>
          <code className="item-id">{channel.id}</code>
        </div>
        <pre className="config-block">{JSON.stringify(channel.config, null, 2)}</pre>
        {channel.enabled ? <div className="form-actions"><ConfirmButton confirmLabel="Disable channel" description={<p>Alerts routed to this {channel.kind} channel stop being delivered immediately, including critical drift alerts. Subscriptions that use it stay configured.</p>} disabled={busy} onConfirm={() => write(`/api/channels/${channel.id}/disable`, "POST", undefined, "disable-channel")} size="sm" title={`Disable ${channel.kind} channel ${channel.id}?`}>Disable channel</ConfirmButton></div> : null}
      </li>)}</ul>}
      <form className="form-card" onSubmit={createChannel}><fieldset disabled={busy}><legend>Create channel</legend>
        <div className="form-grid">
          <label className="filter-field"><span>Kind</span><select name="kind"><option value="webhook">Webhook</option><option value="email">Email</option></select></label>
          <label className="filter-field form-grid-wide"><span>Config (JSON)</span><textarea name="config" required defaultValue={'{"url":"https://example.com/webhook"}'} /></label>
        </div>
        <p className="field-help">Webhook: url. Email: to, from, and optional subject.</p>
        <div className="form-actions"><button aria-busy={busyAction === "create-channel" || undefined} className="btn btn-primary" type="submit">Create channel</button></div>
      </fieldset></form>
    </section>
    <section aria-labelledby="subscriptions-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div><p className="section-kicker">Routing rules</p><h2 id="subscriptions-heading">Subscriptions</h2></div>
        <span className="result-count">{subscriptions.length} active</span>
      </div>
      {subscriptions.length === 0 ? <p className="empty-state">No subscriptions configured.</p> : <ul className="item-list">{subscriptions.map((subscription) => <li className="item-card item-card-row" key={subscription.id}>
        <code className="natural-key">{subscription.event_glob}</code>
        <span className={`severity-pill severity-${subscription.min_severity}`}>≥ {subscription.min_severity}</span>
        <code className="item-id">{subscription.channel_id}</code>
        <ConfirmButton confirmLabel="Delete subscription" description={<p>Events matching <code>{subscription.event_glob}</code> at {subscription.min_severity} or above will no longer be sent to {subscription.channel_id}. This cannot be undone; recreate the subscription to restore it.</p>} disabled={busy} onConfirm={() => write(`/api/subscriptions/${subscription.id}`, "DELETE", undefined, "delete-subscription")} size="sm" title="Delete this subscription?">Delete subscription</ConfirmButton>
      </li>)}</ul>}
      <form className="form-card" onSubmit={createSubscription}><fieldset disabled={busy || channels.length === 0}><legend>Create subscription</legend>
        <div className="form-grid">
          <label className="filter-field"><span>Channel</span><select name="channelId" required>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.kind} · {channel.id}</option>)}</select></label>
          <label className="filter-field"><span>Event glob</span><input name="eventGlob" required defaultValue="*" /></label>
          <label className="filter-field"><span>Minimum severity</span><select name="minSeverity">{["notice", "warning", "critical"].map((severity) => <option key={severity}>{severity}</option>)}</select></label>
        </div>
        <div className="form-actions"><button aria-busy={busyAction === "create-subscription" || undefined} className="btn btn-primary" type="submit">Create subscription</button></div>
      </fieldset></form>
    </section>
  </>;
}
