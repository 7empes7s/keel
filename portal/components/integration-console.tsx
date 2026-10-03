"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { formatTimestamp } from "@/lib/presentation";
import { toast } from "@/lib/toast";
import type { Destination, DestinationStatus, QuarantinedEvent } from "@/lib/integrations";
import { destinationKind, destinationTarget, isPaused } from "@/lib/integrations-view";

// Roadmap task-130: destinations by name and kind in words, delivery health in words,
// a register form with labelled fields; raw config, ids and sequence numbers in the record.

function statusFor(statuses: DestinationStatus[], id: string): DestinationStatus | null {
  return statuses.find((status) => status.destinationId === id) ?? null;
}

const TOAST_TITLES: Record<string, string> = {
  register: "Destination added",
  replay: "Sending again",
  resume: "Destination resumed",
  pause: "Destination paused",
};

export function IntegrationConsole({ canConfiguration, destinations, statuses }: {
  canConfiguration: boolean; destinations: Destination[]; statuses: DestinationStatus[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The write in flight, so only the control that started it shows a spinner.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [quarantined, setQuarantined] = useState<Record<string, QuarantinedEvent[]>>({});
  const [kind, setKind] = useState("webhook");
  const [transport, setTransport] = useState("https");
  const [auth, setAuth] = useState("none");

  async function write(url: string, method: string, body?: unknown, action = `${method} ${url}`) {
    if (!canConfiguration || busy) return;
    setBusy(true); setBusyAction(action); setError(null);
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? "Integration update failed"); }
      toast({ title: TOAST_TITLES[action] ?? "Integration updated" });
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Integration update failed"); }
    finally { setBusy(false); setBusyAction(null); }
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
    const text = (key: string) => String(form.get(key) ?? "").trim();
    let config: Record<string, unknown>;
    if (kind === "cef") {
      config = transport === "udp"
        ? { transport, host: text("host"), port: Number(text("port")), acknowledgement: "none" }
        : { transport, url: text("url"), acknowledgement: text("acknowledgement") || "none" };
    } else {
      config = { url: text("url") };
      if (auth === "bearer") config.auth = { type: "bearer", tokenRef: text("credentialRef") };
      if (auth === "hmac-sha256") config.auth = { type: "hmac-sha256", secretRef: text("credentialRef") };
    }
    void write("/api/integrations", "POST", { name: text("name"), kind, config }, "register");
  }

  function replay(id: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void write(`/api/integrations/${id}/replay`, "POST", { fromSeq: Number(form.get("fromSeq") ?? 0) }, "replay");
  }

  return <>
    {error ? <p className="action-error" role="alert">{error}</p> : null}
    <section aria-labelledby="integrations-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div><p className="section-kicker">Where the audit record is copied</p><h2 id="integrations-heading">Destinations</h2></div>
        <span className="result-count">{destinations.length} registered</span>
      </div>
      {destinations.length === 0 ? <p className="empty-state">No destination is set up.</p> : <ul className="item-list">{destinations.map((destination) => {
        const status = statusFor(statuses, destination.id);
        const paused = isPaused(destination);
        const events = quarantined[destination.id];
        return <li className="item-card" key={destination.id}>
          <div className="item-card-head">
            <strong>{destination.name}</strong>
            <span className={paused ? "inactive-indicator" : "active-indicator"}>{paused ? "Paused" : "Sending"}</span>
          </div>
          <p>{destinationKind(destination)} to {destinationTarget(destination)}.</p>
          {status ? <dl className="stat-strip">
            <div><dt>Waiting to send</dt><dd>{status.pending}</dd></div>
            <div><dt>Sending</dt><dd>{status.delivering}</dd></div>
            <div><dt>Received</dt><dd>{status.acknowledged}</dd></div>
            <div className={status.quarantined > 0 ? "stat-warn" : undefined}><dt>Held back</dt><dd>{status.quarantined}</dd></div>
            <div><dt>Behind by</dt><dd>{status.lagMs === null ? "nothing" : `${Math.round(status.lagMs / 1000)} seconds`}</dd></div>
          </dl> : null}
          <div className="form-actions">
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void loadQuarantined(destination.id)} type="button">Show held-back entries</button>
            {canConfiguration ? (paused
              ? <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void write(`/api/integrations/${destination.id}/resume`, "POST", undefined, "resume")} type="button">Resume</button>
              : <ConfirmButton confirmLabel="Pause" description={<p>{destination.name} stops receiving audit entries until it is resumed. New entries wait, so it falls behind while paused.</p>} disabled={busy} onConfirm={() => write(`/api/integrations/${destination.id}/revoke`, "POST", undefined, "pause")} size="sm" title={`Pause ${destination.name}?`}>Pause</ConfirmButton>) : null}
          </div>
          {events ? (events.length === 0 ? <p className="field-help">Nothing is held back.</p> : <ul className="quarantine-list">{events.map((quarantinedEvent) => <li key={quarantinedEvent.id}>
            Held back <time dateTime={quarantinedEvent.quarantined_at}>{formatTimestamp(quarantinedEvent.quarantined_at)}</time> after {quarantinedEvent.attempts} {quarantinedEvent.attempts === 1 ? "attempt" : "attempts"}: {quarantinedEvent.quarantine_reason ?? "no reason recorded"}
          </li>)}</ul>) : null}
          {canConfiguration ? <form className="inline-form" onSubmit={(event) => replay(destination.id, event)}><fieldset disabled={busy}><legend>Send again</legend>
            <label className="filter-field"><span>From audit entry number</span><input name="fromSeq" type="number" min={0} defaultValue={0} /></label>
            <button className="btn btn-secondary" type="submit">Send again</button>
          </fieldset></form> : null}
          <TechnicalDetails>
            <RecordField label="Destination ID" usage={<>use with <code>POST /api/integrations/&lt;id&gt;/replay</code></>} value={destination.id} />
            <RecordField copy={false} label="Kind code" value={destination.kind} />
            <RecordField copy={false} label="Config" value={JSON.stringify(destination.config, null, 2)} />
            {status ? <RecordField copy={false} label="Delivery checkpoint" value={JSON.stringify(status.checkpoint ?? null)} /> : null}
            {(events ?? []).map((quarantinedEvent) => <RecordField key={quarantinedEvent.id} label="Held-back event ID" value={quarantinedEvent.event_id} />)}
            <RecordField copy={false} label="Created" value={`${destination.created_at} by ${destination.created_by}`} />
          </TechnicalDetails>
        </li>;
      })}</ul>}
    </section>
    {canConfiguration ? <section aria-labelledby="register-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div><p className="section-kicker">New</p><h2 id="register-heading">Add a destination</h2></div>
      </div>
      <form className="form-card" onSubmit={register}><fieldset disabled={busy}><legend>New destination</legend>
        <div className="form-grid">
          <label className="filter-field"><span>Name</span><input autoComplete="off" name="name" required /></label>
          <label className="filter-field"><span>Kind</span><select name="kind" onChange={(event) => setKind(event.target.value)} value={kind}><option value="webhook">Webhook</option><option value="cef">CEF (SIEM)</option></select></label>
          {kind === "cef" ? <>
            <label className="filter-field"><span>Transport</span><select onChange={(event) => setTransport(event.target.value)} value={transport}><option value="https">HTTPS</option><option value="udp">UDP (syslog)</option></select></label>
            {transport === "udp" ? <>
              <label className="filter-field"><span>Host</span><input autoComplete="off" name="host" placeholder="siem.contoso.com" required /></label>
              <label className="filter-field"><span>Port</span><input max={65535} min={1} name="port" placeholder="514" required type="number" /></label>
            </> : <>
              <label className="filter-field form-grid-wide"><span>Address</span><input autoComplete="off" name="url" placeholder="https://siem.contoso.com/cef" required type="url" /></label>
              <label className="filter-field"><span>Delivery confirmation</span><select name="acknowledgement"><option value="http-response">From the HTTP response</option><option value="none">None</option></select></label>
            </>}
          </> : <>
            <label className="filter-field form-grid-wide"><span>Address</span><input autoComplete="off" name="url" placeholder="https://hooks.contoso.com/keel" required type="url" /></label>
            <label className="filter-field"><span>Sign-in</span><select onChange={(event) => setAuth(event.target.value)} value={auth}><option value="none">None</option><option value="bearer">Bearer token</option><option value="hmac-sha256">HMAC signature</option></select></label>
            {auth !== "none" ? <label className="filter-field"><span>Name of the stored secret (never the secret itself)</span><input autoComplete="off" name="credentialRef" placeholder="env:KEEL_WEBHOOK_TOKEN" required /></label> : null}
          </>}
        </div>
        <p className="field-help">UDP syslog cannot confirm delivery, so entries sent that way stay waiting until another destination confirms them.</p>
        <div className="form-actions"><button aria-busy={busyAction === "register" || undefined} className="btn btn-primary" type="submit">Add destination</button></div>
      </fieldset></form>
    </section> : null}
  </>;
}
