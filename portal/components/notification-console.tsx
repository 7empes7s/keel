"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Channel, Subscription, Delivery } from "@/lib/notifications";

export function DeliveryTable({ deliveries }: { deliveries: Delivery[] }) {
  return <section aria-labelledby="deliveries-heading"><h2 id="deliveries-heading">Recent deliveries</h2>
    {deliveries.length === 0 ? <p>No deliveries yet.</p> : <div className="table-scroll"><table><thead><tr>
      {["Event kind", "Severity", "Channel", "Status", "Attempts", "Last error", "Next attempt"].map((title) => <th key={title} scope="col">{title}</th>)}
    </tr></thead><tbody>{deliveries.map((delivery) => <tr key={delivery.id}>
      <td>{delivery.event.kind}</td><td>{delivery.event.severity}</td><td>{delivery.channel_kind} · {delivery.channel_id}</td>
      <td>{delivery.status}</td><td>{delivery.attempts}</td><td>{delivery.last_error ?? "—"}</td><td>{delivery.next_attempt_at ?? "—"}</td>
    </tr>)}</tbody></table></div>}
  </section>;
}

export function NotificationConsole({ canConfiguration, channels, subscriptions }: {
  canConfiguration: boolean; channels: Channel[]; subscriptions: Subscription[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!canConfiguration) return null;
  async function write(url: string, method: string, body?: unknown) {
    if (!canConfiguration || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? "Notification update failed"); }
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Notification update failed"); }
    finally { setBusy(false); }
  }
  function createChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try { const config: unknown = JSON.parse(String(form.get("config"))); void write("/api/channels", "POST", { kind: form.get("kind"), config }); }
    catch { setError("Channel config must be valid JSON."); }
  }
  function createSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void write("/api/subscriptions", "POST", { channelId: form.get("channelId"), eventGlob: form.get("eventGlob"), minSeverity: form.get("minSeverity") });
  }
  return <>
    {error ? <p role="alert">{error}</p> : null}
    <section aria-labelledby="channels-heading"><h2 id="channels-heading">Channels</h2>
      {channels.length === 0 ? <p>No channels configured.</p> : <ul>{channels.map((channel) => <li key={channel.id}>
        <strong>{channel.kind}</strong> · {channel.id} · {channel.enabled ? "Enabled" : "Disabled"}
        <pre>{JSON.stringify(channel.config, null, 2)}</pre>
        {channel.enabled ? <button disabled={busy} onClick={() => void write(`/api/channels/${channel.id}/disable`, "POST")}>Disable channel</button> : null}
      </li>)}</ul>}
      <form onSubmit={createChannel}><fieldset disabled={busy}><legend>Create channel</legend>
        <label>Kind <select name="kind"><option value="webhook">Webhook</option><option value="email">Email</option></select></label>
        <label>Config (JSON) <textarea name="config" required defaultValue={'{"url":"https://example.com/webhook"}'} /></label>
        <p>Webhook: url. Email: to, from, and optional subject.</p><button type="submit">Create channel</button>
      </fieldset></form>
    </section>
    <section aria-labelledby="subscriptions-heading"><h2 id="subscriptions-heading">Subscriptions</h2>
      {subscriptions.length === 0 ? <p>No subscriptions configured.</p> : <ul>{subscriptions.map((subscription) => <li key={subscription.id}>
        {subscription.event_glob} · {subscription.min_severity} · {subscription.channel_id} <button disabled={busy} onClick={() => void write(`/api/subscriptions/${subscription.id}`, "DELETE")}>Delete subscription</button>
      </li>)}</ul>}
      <form onSubmit={createSubscription}><fieldset disabled={busy || channels.length === 0}><legend>Create subscription</legend>
        <label>Channel <select name="channelId" required>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.kind} · {channel.id}</option>)}</select></label>
        <label>Event glob <input name="eventGlob" required defaultValue="*" /></label>
        <label>Minimum severity <select name="minSeverity">{["notice", "warning", "critical"].map((severity) => <option key={severity}>{severity}</option>)}</select></label>
        <button type="submit">Create subscription</button>
      </fieldset></form>
    </section>
  </>;
}
