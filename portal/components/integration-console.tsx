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
    {error ? <p className="action-error" role="alert">{error}</p> : null}
    <section aria-labelledby="integrations-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div><p className="section-kicker">SIEM and webhooks</p><h2 id="integrations-heading">Destinations</h2></div>
        <span className="result-count">{destinations.length} registered</span>
      </div>
      {destinations.length === 0 ? <p className="empty-state">No webhook or CEF destinations configured.</p> : <ul className="item-list">{destinations.map((destination) => {
        const status = statusFor(statuses, destination.id);
        const paused = !destination.enabled || destination.revoked_at !== null;
        const events = quarantined[destination.id];
        return <li className="item-card" key={destination.id}>
          <div className="item-card-head">
            <strong>{destination.name}</strong>
            <span className={paused ? "inactive-indicator" : "active-indicator"}>{paused ? "Paused" : "Enabled"}</span>
            <code className="item-id">{destination.kind}</code>
          </div>
          <pre className="config-block">{JSON.stringify(destination.config, null, 2)}</pre>
          {status ? <dl className="stat-strip">
            <div><dt>Pending</dt><dd>{status.pending}</dd></div>
            <div><dt>Delivering</dt><dd>{status.delivering}</dd></div>
            <div><dt>Acknowledged</dt><dd>{status.acknowledged}</dd></div>
            <div className={status.quarantined > 0 ? "stat-warn" : undefined}><dt>Quarantined</dt><dd>{status.quarantined}</dd></div>
            <div><dt>Lag</dt><dd>{status.lagMs === null ? "—" : `${Math.round(status.lagMs / 1000)}s`}</dd></div>
          </dl> : null}
          <div className="form-actions">
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void loadQuarantined(destination.id)} type="button">Show quarantined events</button>
            {canConfiguration ? (paused
              ? <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void write(`/api/integrations/${destination.id}/resume`, "POST")} type="button">Resume destination</button>
              : <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void write(`/api/integrations/${destination.id}/revoke`, "POST")} type="button">Pause destination</button>) : null}
          </div>
          {events ? (events.length === 0 ? <p className="field-help">No quarantined events.</p> : <ul className="quarantine-list">{events.map((quarantinedEvent) => <li key={quarantinedEvent.id}>
            {quarantinedEvent.event_id} · {quarantinedEvent.quarantine_reason ?? "—"} · {quarantinedEvent.quarantined_at}
          </li>)}</ul>) : null}
          {canConfiguration ? <form className="inline-form" onSubmit={(event) => replay(destination.id, event)}><fieldset disabled={busy}><legend>Replay</legend>
            <label className="filter-field"><span>From sequence</span><input name="fromSeq" type="number" min={0} defaultValue={0} /></label>
            <button className="btn btn-secondary" type="submit">Request replay</button>
          </fieldset></form> : null}
        </li>;
      })}</ul>}
    </section>
    {canConfiguration ? <section aria-labelledby="register-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div><p className="section-kicker">Configuration</p><h2 id="register-heading">Register a destination</h2></div>
      </div>
      <form className="form-card" onSubmit={register}><fieldset disabled={busy}><legend>New destination</legend>
        <div className="form-grid">
          <label className="filter-field"><span>Name</span><input name="name" required /></label>
          <label className="filter-field"><span>Kind</span><select name="kind"><option value="webhook">Webhook</option><option value="cef">CEF</option></select></label>
          <label className="filter-field form-grid-wide"><span>Config (JSON)</span><textarea name="config" required defaultValue={'{"url":"https://example.com/ingest"}'} /></label>
        </div>
        <p className="field-help">Webhook: url, optional auth (bearer/hmac-sha256 with a credential reference). CEF: transport (https or udp), url or host/port, acknowledgement (none or http-response).</p>
        <div className="form-actions"><button aria-busy={busy || undefined} className="btn btn-primary" type="submit">Register destination</button></div>
      </fieldset></form>
    </section> : null}
  </>;
}
