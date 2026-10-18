"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BaselinesStyles } from "@/components/baselines/styles";
import { Segmented } from "@/components/pickers/segmented";
import { SettingsGroup, SettingsRow, SettingsSection } from "@/components/settings/parts";
import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
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

/** "120 received · 3 waiting · 1 held back · behind by 4 seconds". */
function statusLine(status: DestinationStatus): string {
  const parts = [`${status.acknowledged} received`];
  if (status.pending + status.delivering > 0) parts.push(`${status.pending + status.delivering} waiting`);
  if (status.quarantined > 0) parts.push(`${status.quarantined} held back`);
  parts.push(status.lagMs === null ? "up to date" : `behind by ${Math.round(status.lagMs / 1000)} seconds`);
  return parts.join(" · ");
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
  const [panel, setPanel] = useState<"add" | "details" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [kind, setKind] = useState<"webhook" | "cef">("webhook");
  const [transport, setTransport] = useState<"https" | "udp">("https");
  const [acknowledgement, setAcknowledgement] = useState<"http-response" | "none">("http-response");
  const [auth, setAuth] = useState<"none" | "bearer" | "hmac-sha256">("none");

  async function write(url: string, method: string, body?: unknown, action = `${method} ${url}`): Promise<boolean> {
    if (!canConfiguration || busy) return false;
    setBusy(true); setBusyAction(action); setError(null);
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? "Integration update failed"); }
      toast({ title: TOAST_TITLES[action] ?? "Integration updated" });
      router.refresh();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Integration update failed"); return false; }
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

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    let config: Record<string, unknown>;
    if (kind === "cef") {
      config = transport === "udp"
        ? { transport, host: text("host"), port: Number(text("port")), acknowledgement: "none" }
        : { transport, url: text("url"), acknowledgement };
    } else {
      config = { url: text("url") };
      if (auth === "bearer") config.auth = { type: "bearer", tokenRef: text("credentialRef") };
      if (auth === "hmac-sha256") config.auth = { type: "hmac-sha256", secretRef: text("credentialRef") };
    }
    if (await write("/api/integrations", "POST", { name: text("name"), kind, config }, "register")) setPanel(null);
  }

  function replay(id: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void write(`/api/integrations/${id}/replay`, "POST", { fromSeq: Number(form.get("fromSeq") ?? 0) }, "replay");
  }

  const field = (label: string, input: ReactNode) => <label className="picker-field"><span className="picker-label">{label}</span>{input}</label>;
  const opened = destinations.find((destination) => destination.id === openId) ?? null;
  const openedStatus = opened ? statusFor(statuses, opened.id) : null;
  const openedEvents = opened ? quarantined[opened.id] : undefined;
  return <>
    {error && panel === null ? <p className="action-error" role="alert">{error}</p> : null}
    <SettingsSection
      about="Where KEEL copies its audit record, such as a SIEM or a webhook."
      extra={canConfiguration ? <button className="btn btn-sm" onClick={() => { setError(null); setPanel("add"); }} type="button"><Icon name="plus" />Add destination</button> : null}
      id="integrations-heading"
      title="Audit copies"
    >
      {destinations.length === 0 ? <p className="sel-empty">No destination is set up, so the audit record stays in KEEL only.</p> : <>
        <SettingsGroup about="Each one receives every audit entry in order." count={`${destinations.length} registered`} icon="link" title="Destinations">
          {destinations.map((destination) => {
            const status = statusFor(statuses, destination.id);
            const paused = isPaused(destination);
            const held = status?.quarantined ?? 0;
            const tone = held > 0 || paused ? "soon" : null;
            return <SettingsRow
              actions={<>
                <button className="btn btn-sm" onClick={() => { setError(null); setOpenId(destination.id); setPanel("details"); void loadQuarantined(destination.id); }} type="button">Details</button>
                {canConfiguration ? (paused
                  ? <button className="btn btn-sm" disabled={busy} onClick={() => void write(`/api/integrations/${destination.id}/resume`, "POST", undefined, "resume")} type="button">Resume</button>
                  : <ConfirmButton confirmLabel="Pause" description={<p>{destination.name} stops receiving audit entries until it is resumed. New entries wait, so it falls behind while paused.</p>} disabled={busy} onConfirm={async () => { await write(`/api/integrations/${destination.id}/revoke`, "POST", undefined, "pause"); }} size="sm" title={`Pause ${destination.name}?`}>Pause</ConfirmButton>) : null}
              </>}
              icon={destination.kind === "cef" ? "audit" : "link"}
              iconTone={tone}
              key={destination.id}
              line={status ? statusLine(status) : null}
              meta={`${destinationKind(destination)} to ${destinationTarget(destination)}`}
              name={destination.name}
              status={<Badge tone={paused ? "soon" : "fine"}>{paused ? "Paused" : "Sending"}</Badge>}
              tone={tone}
            />;
          })}
        </SettingsGroup>
        <TechnicalDetails summary="Technical details for these destinations">
          {destinations.map((destination) => {
            const status = statusFor(statuses, destination.id);
            return <div className="st-record" key={destination.id}>
              <RecordField label={`Destination ID (${destination.name})`} usage={<>use with <code>POST /api/integrations/&lt;id&gt;/replay</code></>} value={destination.id} />
              <RecordField copy={false} label="Kind code" value={destination.kind} />
              <RecordField copy={false} label="Config" value={JSON.stringify(destination.config, null, 2)} />
              {status ? <RecordField copy={false} label="Delivery checkpoint" value={JSON.stringify(status.checkpoint ?? null)} /> : null}
              <RecordField copy={false} label="Created" value={`${destination.created_at} by ${destination.created_by}`} />
            </div>;
          })}
        </TechnicalDetails>
      </>}
    </SettingsSection>

    {panel ? <BaselinesStyles /> : null}
    {panel === "details" && opened ? <DetailsSheet kicker={`${destinationKind(opened)} to ${destinationTarget(opened)}`} onClose={() => setPanel(null)} title={opened.name}>
      {openedStatus ? <dl className="st-sheet-facts">
        <div><dt>Waiting to send</dt><dd>{openedStatus.pending}</dd></div>
        <div><dt>Sending</dt><dd>{openedStatus.delivering}</dd></div>
        <div><dt>Received</dt><dd>{openedStatus.acknowledged}</dd></div>
        <div data-tone={openedStatus.quarantined > 0 ? "soon" : undefined}><dt>Held back</dt><dd>{openedStatus.quarantined}</dd></div>
        <div><dt>Behind by</dt><dd>{openedStatus.lagMs === null ? "Nothing" : `${Math.round(openedStatus.lagMs / 1000)} seconds`}</dd></div>
      </dl> : null}
      <div className="st-sheet-part">
        <h3>Held-back entries</h3>
        {openedEvents === undefined ? <p className="bl-help">Reading held-back entries…</p> : openedEvents.length === 0 ? <p className="bl-help">Nothing is held back.</p> : <ul className="st-problems">{openedEvents.map((quarantinedEvent) => <li key={quarantinedEvent.id}>
          <Icon name="clock" /><span>Held back <time dateTime={quarantinedEvent.quarantined_at}>{formatTimestamp(quarantinedEvent.quarantined_at)}</time> after {quarantinedEvent.attempts} {quarantinedEvent.attempts === 1 ? "attempt" : "attempts"}: {quarantinedEvent.quarantine_reason ?? "no reason recorded"}</span>
        </li>)}</ul>}
      </div>
      {canConfiguration ? <form className="st-sheet-part st-form" onSubmit={(event) => replay(opened.id, event)}>
        <h3>Send again</h3>
        <p className="bl-help">Sends every audit entry from this number on again, in order.</p>
        <div className="st-inline">
          {field("From audit entry number", <input className="bl-input" defaultValue={0} min={0} name="fromSeq" type="number" />)}
          <button aria-busy={busyAction === "replay" || undefined} className="btn" disabled={busy} type="submit">Send again</button>
        </div>
      </form> : null}
      {error ? <p className="action-error" role="alert">{error}</p> : null}
      {openedEvents?.length ? <TechnicalDetails>
        {openedEvents.map((quarantinedEvent) => <RecordField key={quarantinedEvent.id} label="Held-back event ID" value={quarantinedEvent.event_id} />)}
      </TechnicalDetails> : null}
    </DetailsSheet> : null}
    {panel === "add" ? <DetailsSheet
      footer={<>
        <button className="btn" onClick={() => setPanel(null)} type="button">Cancel</button>
        <button aria-busy={busyAction === "register" || undefined} className="btn btn-primary" disabled={busy} form="add-destination-form" type="submit">Add destination</button>
      </>}
      kicker="Integrations"
      onClose={() => setPanel(null)}
      title="Add a destination"
    >
      <form className="st-form" id="add-destination-form" onSubmit={(event) => void register(event)}>
        {field("Name", <input autoComplete="off" className="bl-input" name="name" required />)}
        <Segmented label="Kind" onChange={(value: "webhook" | "cef") => setKind(value)} options={[{ value: "webhook", label: "Webhook" }, { value: "cef", label: "CEF (SIEM)" }]} value={kind} />
        {kind === "cef" ? <>
          <Segmented label="Transport" onChange={(value: "https" | "udp") => setTransport(value)} options={[{ value: "https", label: "HTTPS" }, { value: "udp", label: "UDP (syslog)" }]} value={transport} />
          {transport === "udp" ? <>
            {field("Host", <input autoComplete="off" className="bl-input" name="host" placeholder="siem.contoso.com" required />)}
            {field("Port", <input className="bl-input" max={65535} min={1} name="port" placeholder="514" required type="number" />)}
            <p className="bl-help">UDP syslog cannot confirm delivery, so entries sent that way stay waiting until another destination confirms them.</p>
          </> : <>
            {field("Address", <input autoComplete="off" className="bl-input" name="url" placeholder="https://siem.contoso.com/cef" required type="url" />)}
            <Segmented label="Delivery confirmation" onChange={(value: "http-response" | "none") => setAcknowledgement(value)} options={[{ value: "http-response", label: "From the HTTP response" }, { value: "none", label: "None" }]} value={acknowledgement} />
          </>}
        </> : <>
          {field("Address", <input autoComplete="off" className="bl-input" name="url" placeholder="https://hooks.contoso.com/keel" required type="url" />)}
          <Segmented label="Sign-in" onChange={(value: "none" | "bearer" | "hmac-sha256") => setAuth(value)} options={[{ value: "none", label: "None" }, { value: "bearer", label: "Bearer token" }, { value: "hmac-sha256", label: "HMAC signature" }]} value={auth} />
          {auth !== "none" ? field("Name of the stored secret (never the secret itself)", <input autoComplete="off" className="bl-input" name="credentialRef" placeholder="env:KEEL_WEBHOOK_TOKEN" required />) : null}
        </>}
        {error ? <p className="action-error" role="alert">{error}</p> : null}
      </form>
    </DetailsSheet> : null}
  </>;
}
