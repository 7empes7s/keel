"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Destination, DestinationStatus, QuarantinedEvent } from "@/lib/integrations";

function statusFor(statuses: DestinationStatus[], id: string): DestinationStatus | null {
  return statuses.find((status) => status.destinationId === id) ?? null;
}

export function IntegrationConsole({ canConfiguration, destinations, statuses }: {
  canConfiguration: boolean; destinations: Destination[]; statuses: DestinationStatus[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quarantined, setQuarantined] = useState<Record<string, QuarantinedEvent[]>>({});

  async function write(url: string, method: string, body?: unknown) {
    if (!canConfiguration || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? "Integration update failed"); }
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Integration update failed"); }
    finally { setBusy(false); }
  }

  async function loadQuarantined(id: string) {
    setError(null);
    try {
      const response = await fetch(`/api/integrations/${id}/quarantined`);
      if (!response.ok) throw new Error("Quarantined events unavailable");
      const data = await response.json();
      setQuarantined((current) => ({ ...current, [id]: data.quarantined }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Quarantined events unavailable"); }
  }

  function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const config: unknown = JSON.parse(String(form.get("config")));
      void write("/api/integrations", "POST", { name: form.get("name"), kind: form.get("kind"), config });
    } catch { setError("Destination config must be valid JSON."); }
  }

  function replay(id: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void write(`/api/integrations/${id}/replay`, "POST", { fromSeq: Number(form.get("fromSeq") ?? 0) });
  }

  return <>
    {error ? <p role="alert">{error}</p> : null}
    <section aria-labelledby="integrations-heading"><h2 id="integrations-heading">Destinations</h2>
      {destinations.length === 0 ? <p>No webhook or CEF destinations configured.</p> : <ul>{destinations.map((destination) => {
        const status = statusFor(statuses, destination.id);
        const paused = !destination.enabled || destination.revoked_at !== null;
        const events = quarantined[destination.id];
        return <li key={destination.id}>
          <strong>{destination.name}</strong> · {destination.kind} · {paused ? "Paused" : "Enabled"}
          <pre>{JSON.stringify(destination.config, null, 2)}</pre>
          {status ? <dl>
            <dt>Pending</dt><dd>{status.pending}</dd>
            <dt>Delivering</dt><dd>{status.delivering}</dd>
            <dt>Acknowledged</dt><dd>{status.acknowledged}</dd>
            <dt>Quarantined</dt><dd>{status.quarantined}</dd>
            <dt>Lag</dt><dd>{status.lagMs === null ? "—" : `${Math.round(status.lagMs / 1000)}s`}</dd>
          </dl> : null}
          <button disabled={busy} onClick={() => void loadQuarantined(destination.id)}>Show quarantined events</button>
          {events ? (events.length === 0 ? <p>No quarantined events.</p> : <ul>{events.map((quarantinedEvent) => <li key={quarantinedEvent.id}>
            {quarantinedEvent.event_id} · {quarantinedEvent.quarantine_reason ?? "—"} · {quarantinedEvent.quarantined_at}
          </li>)}</ul>) : null}
          {canConfiguration ? <>
            {paused
              ? <button disabled={busy} onClick={() => void write(`/api/integrations/${destination.id}/resume`, "POST")}>Resume destination</button>
              : <button disabled={busy} onClick={() => void write(`/api/integrations/${destination.id}/revoke`, "POST")}>Pause destination</button>}
            <form onSubmit={(event) => replay(destination.id, event)}><fieldset disabled={busy}><legend>Replay</legend>
              <label>From sequence <input name="fromSeq" type="number" min={0} defaultValue={0} /></label>
              <button type="submit">Request replay</button>
            </fieldset></form>
          </> : null}
        </li>;
      })}</ul>}
    </section>
    {canConfiguration ? <section aria-labelledby="register-heading"><h2 id="register-heading">Register a destination</h2>
      <form onSubmit={register}><fieldset disabled={busy}><legend>New destination</legend>
        <label>Name <input name="name" required /></label>
        <label>Kind <select name="kind"><option value="webhook">Webhook</option><option value="cef">CEF</option></select></label>
        <label>Config (JSON) <textarea name="config" required defaultValue={'{"url":"https://example.com/ingest"}'} /></label>
        <p>Webhook: url, optional auth (bearer/hmac-sha256 with a credential reference). CEF: transport (https or udp), url or host/port, acknowledgement (none or http-response).</p>
        <button type="submit">Register destination</button>
      </fieldset></form>
    </section> : null}
  </>;
}
