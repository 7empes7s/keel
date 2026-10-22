"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ErrorNotice } from "@/components/ui/error-notice";
import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { AlertRow } from "@/components/ui/alert-list";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { formatTimestamp } from "@/lib/presentation";
import { plainError } from "@/lib/error-words";
import { toast } from "@/lib/toast";
import type { Destination, DestinationStatus, QuarantinedEvent } from "@/lib/integrations";
import { LAG_WARN_MS, destinationBadge, destinationKind, destinationTarget, isPaused, lagWords } from "@/lib/integrations-view";

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
    {error ? <AlertRow as="div" item={{ key: "write-error", tone: "urgent", icon: "x-circle", title: "That did not work", todo: "Check the details below, then try again.", more: [error] }} /> : null}
    <section aria-labelledby="integrations-heading" className="pg-panel" id="ig-destinations">
      <div className="rs-section-head">
        <div>
          <h2 id="integrations-heading"><Icon name="audit" />Audit record copies</h2>
          <p className="rs-sub">Where KEEL sends a copy of every audit entry.</p>
        </div>
        <Badge tone="neutral">{`${destinations.length} set up`}</Badge>
      </div>
      {destinations.length === 0 ? <p className="pg-empty"><Icon name="info" />No destination is set up.</p> : <ul className="pg-cards">{destinations.map((destination) => {
        const status = statusFor(statuses, destination.id);
        const paused = isPaused(destination);
        const badge = destinationBadge(destination, status);
        const events = quarantined[destination.id];
        return <li className="pg-card" data-tone={badge.tone} id={`destination-${destination.id}`} key={destination.id}>
          <div className="pg-card-head">
            <h3>{destination.name}</h3>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
          <p className="pg-card-sub">{destinationKind(destination)} to {destinationTarget(destination)}</p>
          {status ? <dl className="pg-stats">
            <div><dt>Waiting to send</dt><dd>{status.pending.toLocaleString("en-GB")}</dd></div>
            <div><dt>Sending</dt><dd>{status.delivering.toLocaleString("en-GB")}</dd></div>
            <div data-tone="fine"><dt>Received</dt><dd>{status.acknowledged.toLocaleString("en-GB")}</dd></div>
            <div data-tone={status.quarantined > 0 ? "urgent" : "fine"}><dt>Held back</dt><dd>{status.quarantined.toLocaleString("en-GB")}</dd></div>
            <div data-tone={(status.lagMs ?? 0) > LAG_WARN_MS ? "soon" : undefined}><dt>Behind by</dt><dd>{lagWords(status.lagMs)}</dd></div>
          </dl> : null}
          <div className="form-actions">
            <button className="btn btn-sm" disabled={busy} onClick={() => void loadQuarantined(destination.id)} type="button">Show held-back entries</button>
            {canConfiguration ? (paused
              ? <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void write(`/api/integrations/${destination.id}/resume`, "POST", undefined, "resume")} type="button">Resume</button>
              : <ConfirmButton confirmLabel="Pause" description={<p>{destination.name} stops receiving audit entries until it is resumed. New entries wait, so it falls behind while paused.</p>} disabled={busy} onConfirm={() => write(`/api/integrations/${destination.id}/revoke`, "POST", undefined, "pause")} size="sm" title={`Pause ${destination.name}?`}>Pause</ConfirmButton>) : null}
          </div>
          {events ? (events.length === 0 ? <p className="pg-help"><Icon name="check-circle" />Nothing is held back.</p> : <div className="ui-alerts">{events.map((quarantinedEvent) => <ErrorNotice
            error={quarantinedEvent.quarantine_reason}
            id={`quarantined-${quarantinedEvent.id}`}
            key={quarantinedEvent.id}
            service={destination.name}
            title={`Held back ${formatTimestamp(quarantinedEvent.quarantined_at)} after ${quarantinedEvent.attempts} ${quarantinedEvent.attempts === 1 ? "attempt" : "attempts"}: ${plainError(quarantinedEvent.quarantine_reason, { service: destination.name }).cause}`}
            tone="soon"
          />)}</div>) : null}
          {canConfiguration ? <form className="pg-resend" onSubmit={(event) => replay(destination.id, event)}><fieldset disabled={busy}>
            <label className="filter-field"><span>Send again from audit entry number</span><input name="fromSeq" type="number" min={0} defaultValue={0} /></label>
            <button className="btn btn-sm" type="submit">Send again</button>
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
    {canConfiguration ? <section aria-labelledby="register-heading" className="pg-panel" id="ig-add">
      <div className="rs-section-head">
        <div>
          <h2 id="register-heading"><Icon name="plus" />Add a destination</h2>
          <p className="rs-sub">A webhook or a SIEM that reads CEF.</p>
        </div>
      </div>
      <form aria-label="New destination" className="pg-form" onSubmit={register}>
        <label className="filter-field"><span>Name</span><input autoComplete="off" disabled={busy} name="name" required /></label>
        <label className="filter-field"><span>Kind</span><select disabled={busy} name="kind" onChange={(event) => setKind(event.target.value)} value={kind}><option value="webhook">Webhook</option><option value="cef">CEF (SIEM)</option></select></label>
        {kind === "cef" ? <>
          <label className="filter-field"><span>Transport</span><select disabled={busy} onChange={(event) => setTransport(event.target.value)} value={transport}><option value="https">HTTPS</option><option value="udp">UDP (syslog)</option></select></label>
          {transport === "udp" ? <>
            <label className="filter-field"><span>Host</span><input autoComplete="off" disabled={busy} name="host" placeholder="siem.contoso.com" required /></label>
            <label className="filter-field"><span>Port</span><input disabled={busy} max={65535} min={1} name="port" placeholder="514" required type="number" /></label>
            <p className="pg-help pg-wide"><Icon name="info" />UDP cannot confirm delivery, so entries stay waiting until another destination confirms them.</p>
          </> : <>
            <label className="filter-field pg-wide"><span>Address</span><input autoComplete="off" disabled={busy} name="url" placeholder="https://siem.contoso.com/cef" required type="url" /></label>
            <label className="filter-field"><span>Delivery confirmation</span><select disabled={busy} name="acknowledgement"><option value="http-response">From the HTTP response</option><option value="none">None</option></select></label>
          </>}
        </> : <>
          <label className="filter-field"><span>Sign-in</span><select disabled={busy} onChange={(event) => setAuth(event.target.value)} value={auth}><option value="none">None</option><option value="bearer">Bearer token</option><option value="hmac-sha256">HMAC signature</option></select></label>
          <label className="filter-field pg-wide"><span>Address</span><input autoComplete="off" disabled={busy} name="url" placeholder="https://hooks.contoso.com/keel" required type="url" /></label>
          {auth !== "none" ? <label className="filter-field pg-wide"><span>Name of the stored secret (never the secret itself)</span><input autoComplete="off" disabled={busy} name="credentialRef" placeholder="env:KEEL_WEBHOOK_TOKEN" required /></label> : null}
        </>}
        <div className="pg-wide pg-form-foot"><span /><button aria-busy={busyAction === "register" || undefined} className="btn btn-secondary" disabled={busy} type="submit">Add destination</button></div>
      </form>
    </section> : null}
  </>;
}
