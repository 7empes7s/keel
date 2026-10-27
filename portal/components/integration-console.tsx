"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { BaselinesStyles } from "@/components/baselines/styles";
import { DetailsSheet } from "@/components/baselines/details-sheet";
import { Segmented } from "@/components/pickers/segmented";
import { ErrorNotice } from "@/components/ui/error-notice";
import { Icon } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { AlertRow } from "@/components/ui/alert-list";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { formatTimestamp } from "@/lib/presentation";
import { plainError } from "@/lib/error-words";
import { toast } from "@/lib/toast";
import type { Destination, DestinationStatus, QuarantinedEvent } from "@/lib/integrations";
import { LAG_WARN_MS, destinationBadge, destinationGroups, destinationKind, destinationLine, destinationTarget, isPaused, lagWords } from "@/lib/integrations-view";

// Roadmap task-130, settings restyle: destinations as grouped rows (one group per kind,
// the worst first) with a red or amber stripe when one needs someone. A destination's
// counts, held-back entries and actions open in the shared side panel, and so does
// "Add destination". Raw config, ids and sequence numbers sit in one record per section.

function statusFor(statuses: DestinationStatus[], id: string): DestinationStatus | null {
  return statuses.find((status) => status.destinationId === id) ?? null;
}

const TOAST_TITLES: Record<string, string> = {
  register: "Destination added",
  replay: "Sending again",
  resume: "Destination resumed",
  pause: "Destination paused",
};

const ROW_TONES = new Set(["urgent", "soon", "low"]);

export function IntegrationConsole({ canConfiguration, destinations, statuses }: {
  canConfiguration: boolean; destinations: Destination[]; statuses: DestinationStatus[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The write in flight, so only the control that started it shows a spinner.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [quarantined, setQuarantined] = useState<Record<string, QuarantinedEvent[]>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const opened = destinations.find((destination) => destination.id === openId) ?? null;
  const groups = destinationGroups(destinations, statuses);

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

  function close() { setOpenId(null); setAdding(false); setError(null); }

  const errorRow = error ? <AlertRow as="div" item={{ key: "write-error", tone: "urgent", icon: "x-circle", title: "That did not work", todo: "Check the details below, then try again.", more: [error] }} /> : null;

  return <>
    {error && !opened && !adding ? errorRow : null}
    <section aria-labelledby="integrations-heading" className="pg-panel" id="ig-destinations">
      <div className="rs-section-head">
        <div>
          <h2 id="integrations-heading"><Icon name="audit" />Audit record copies</h2>
          <p className="rs-sub">Where KEEL sends a copy of every audit entry.</p>
        </div>
        <span className="ig-head-acts">
          <Badge tone="neutral">{`${destinations.length} set up`}</Badge>
          {canConfiguration ? <button className="btn btn-sm" onClick={() => { setError(null); setOpenId(null); setAdding(true); }} type="button"><Icon name="plus" />Add destination</button> : null}
        </span>
      </div>
      {groups.length === 0 ? (
        <div className="ig-empty">
          <p className="sel-empty">No destination is set up, so the audit record stays only in KEEL.</p>
        </div>
      ) : <div className="ig-groups">{groups.map((group) => {
        const worst = group.items.map((item) => destinationBadge(item, statusFor(statuses, item.id))).find((badge) => badge.tone === "urgent" || badge.tone === "soon");
        return <section aria-labelledby={`ig-group-${group.key}`} className="sel-group" data-group={group.key} key={group.key}>
          <div className="sel-group-head ig-group-head">
            <Icon name={group.icon} />
            <span className="sel-group-name"><b id={`ig-group-${group.key}`}>{group.label}</b><small>{group.about}</small></span>
            {worst ? <Badge tone={worst.tone}>{worst.tone === "urgent" ? "Needs you" : "Check soon"}</Badge> : null}
            <span className="sel-group-count">{group.items.length === 1 ? "1 destination" : `${group.items.length} destinations`}</span>
          </div>
          <ul className="sel-rows">{group.items.map((destination) => {
            const status = statusFor(statuses, destination.id);
            const badge = destinationBadge(destination, status);
            return <li className="sel-row" data-tone={ROW_TONES.has(badge.tone) ? badge.tone : undefined} id={`destination-${destination.id}`} key={destination.id}>
              <div className="sel-row-body"><div className="ig-row">
                <span aria-hidden="true" className="ig-kind" data-tone={badge.tone}><Icon name={group.icon} /></span>
                <span className="ig-row-name">
                  <button className="ig-row-link" onClick={() => { setError(null); setAdding(false); setOpenId(destination.id); }} type="button">{destination.name}</button>
                  <small>{destinationKind(destination)} to {destinationTarget(destination)}</small>
                </span>
                <span className="ig-row-mid">
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                  <span className="ig-row-line">{destinationLine(destination, status)}</span>
                </span>
                <span className="ig-row-acts">
                  <button aria-label={`Open ${destination.name}`} className="btn btn-sm" onClick={() => { setError(null); setAdding(false); setOpenId(destination.id); }} type="button">Open</button>
                </span>
              </div></div>
            </li>;
          })}</ul>
        </section>;
      })}</div>}
      {destinations.length ? <TechnicalDetails summary="Technical details for these destinations">
        {destinations.map((destination) => {
          const status = statusFor(statuses, destination.id);
          return <RecordGroup key={destination.id} note={`destination · ${destination.kind}`} title={destination.name}>
            <RecordField label="Destination ID" usage={<>use with <code>POST /api/integrations/&lt;id&gt;/replay</code></>} value={destination.id} />
            <RecordField copy={false} label="Kind code" value={destination.kind} />
            <RecordField copy={false} label="Config" value={JSON.stringify(destination.config, null, 2)} />
            {status ? <RecordField copy={false} label="Delivery checkpoint" value={JSON.stringify(status.checkpoint ?? null)} /> : null}
            {(quarantined[destination.id] ?? []).map((event) => <RecordField key={event.id} label="Held-back event ID" value={event.event_id} />)}
            <RecordField copy={false} label="Created" value={`${destination.created_at} by ${destination.created_by}`} />
          </RecordGroup>;
        })}
      </TechnicalDetails> : null}
    </section>

    {opened || adding ? <BaselinesStyles /> : null}
    {opened ? <DestinationSheet
      busy={busy}
      busyAction={busyAction}
      canConfiguration={canConfiguration}
      destination={opened}
      errorRow={errorRow}
      events={quarantined[opened.id]}
      onClose={close}
      onLoadHeld={() => void loadQuarantined(opened.id)}
      onPause={() => write(`/api/integrations/${opened.id}/revoke`, "POST", undefined, "pause").then(() => undefined)}
      onReplay={(fromSeq) => void write(`/api/integrations/${opened.id}/replay`, "POST", { fromSeq }, "replay")}
      onResume={() => void write(`/api/integrations/${opened.id}/resume`, "POST", undefined, "resume")}
      status={statusFor(statuses, opened.id)}
    /> : null}
    {adding && canConfiguration ? <AddDestinationSheet
      busy={busy}
      busyAction={busyAction}
      errorRow={errorRow}
      onClose={close}
      onSave={async (body) => { if (await write("/api/integrations", "POST", body, "register")) close(); }}
    /> : null}
  </>;
}

function DestinationSheet({ busy, busyAction, canConfiguration, destination, errorRow, events, onClose, onLoadHeld, onPause, onReplay, onResume, status }: {
  busy: boolean; busyAction: string | null; canConfiguration: boolean; destination: Destination; errorRow: ReactNode;
  events: QuarantinedEvent[] | undefined; onClose: () => void; onLoadHeld: () => void; onPause: () => Promise<void>;
  onReplay: (fromSeq: number) => void; onResume: () => void; status: DestinationStatus | null;
}) {
  const paused = isPaused(destination);
  const badge = destinationBadge(destination, status);
  function replay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onReplay(Number(new FormData(event.currentTarget).get("fromSeq") ?? 0));
  }
  return <DetailsSheet
    footer={canConfiguration ? (paused
      ? <button aria-busy={busyAction === "resume" || undefined} className="btn" disabled={busy} onClick={onResume} type="button"><Icon name="play" />Resume</button>
      : <ConfirmButton confirmLabel="Pause" description={<p>{destination.name} stops receiving audit entries until it is resumed. New entries wait, so it falls behind while paused.</p>} disabled={busy} onConfirm={onPause} title={`Pause ${destination.name}?`}>Pause</ConfirmButton>) : undefined}
    kicker={<span className="ig-sheet-kicker"><Icon name="audit" />Audit record copy</span>}
    onClose={onClose}
    title={destination.name}
  >
    <div className="ig-sheet">
      <p className="ig-sheet-state"><Badge tone={badge.tone}>{badge.label}</Badge><span>{destinationKind(destination)} to {destinationTarget(destination)}</span></p>
      {status ? <dl className="pg-stats">
        <div><dt>Waiting to send</dt><dd>{status.pending.toLocaleString("en-GB")}</dd></div>
        <div><dt>Sending</dt><dd>{status.delivering.toLocaleString("en-GB")}</dd></div>
        <div data-tone="fine"><dt>Received</dt><dd>{status.acknowledged.toLocaleString("en-GB")}</dd></div>
        <div data-tone={status.quarantined > 0 ? "urgent" : "fine"}><dt>Held back</dt><dd>{status.quarantined.toLocaleString("en-GB")}</dd></div>
        <div data-tone={(status.lagMs ?? 0) > LAG_WARN_MS ? "soon" : undefined}><dt>Behind by</dt><dd>{lagWords(status.lagMs)}</dd></div>
      </dl> : <p className="pg-help"><Icon name="info" />No delivery report yet.</p>}
      {errorRow}
      <section aria-labelledby="ig-held-heading" className="ig-sheet-part">
        <h3 id="ig-held-heading">Held-back entries</h3>
        {events === undefined
          ? <button className="btn btn-sm" disabled={busy} onClick={onLoadHeld} type="button">Show held-back entries</button>
          : events.length === 0 ? <p className="pg-help"><Icon name="check-circle" />Nothing is held back.</p>
          : <div className="ui-alerts">{events.map((event) => <ErrorNotice
            error={event.quarantine_reason}
            id={`quarantined-${event.id}`}
            key={event.id}
            service={destination.name}
            title={`Held back ${formatTimestamp(event.quarantined_at)} after ${event.attempts} ${event.attempts === 1 ? "attempt" : "attempts"}: ${plainError(event.quarantine_reason, { service: destination.name }).cause}`}
            tone="soon"
          />)}</div>}
      </section>
      {canConfiguration ? <section aria-labelledby="ig-resend-heading" className="ig-sheet-part">
        <h3 id="ig-resend-heading">Send again</h3>
        <p className="pg-help">Sends every audit entry from this number on, once the cause is fixed.</p>
        <form className="pg-resend" onSubmit={replay}><fieldset disabled={busy}>
          <label className="filter-field"><span>Send again from audit entry number</span><input name="fromSeq" type="number" min={0} defaultValue={0} /></label>
          <button aria-busy={busyAction === "replay" || undefined} className="btn btn-sm" type="submit">Send again</button>
        </fieldset></form>
      </section> : null}
    </div>
  </DetailsSheet>;
}

type Kind = "webhook" | "cef";
type Transport = "https" | "udp";
type Auth = "none" | "bearer" | "hmac-sha256";

const KIND_OPTIONS = [{ value: "webhook", label: "Webhook", icon: "link" }, { value: "cef", label: "SIEM (CEF)", icon: "audit" }] as const;
const TRANSPORT_OPTIONS = [{ value: "https", label: "HTTPS" }, { value: "udp", label: "UDP (syslog)" }] as const;
const AUTH_OPTIONS = [{ value: "none", label: "None" }, { value: "bearer", label: "Bearer token" }, { value: "hmac-sha256", label: "HMAC signature" }] as const;

function AddDestinationSheet({ busy, busyAction, errorRow, onClose, onSave }: {
  busy: boolean; busyAction: string | null; errorRow: ReactNode; onClose: () => void;
  onSave: (body: { name: string; kind: Kind; config: Record<string, unknown> }) => void;
}) {
  const [kind, setKind] = useState<Kind>("webhook");
  const [transport, setTransport] = useState<Transport>("https");
  const [auth, setAuth] = useState<Auth>("none");
  function submit(event: FormEvent<HTMLFormElement>) {
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
    onSave({ name: text("name"), kind, config });
  }
  return <DetailsSheet kicker={<span className="ig-sheet-kicker"><Icon name="audit" />Audit record copies</span>} onClose={onClose} title="Add a destination">
    <form aria-label="New destination" className="nf-form" onSubmit={submit}>
      <fieldset disabled={busy}>
        <Segmented label="Kind" onChange={setKind} options={KIND_OPTIONS} value={kind} />
        <p className="pg-help"><Icon name="info" />{kind === "cef" ? "A SIEM that reads CEF, over HTTPS or syslog." : "Keel posts each audit entry to a web address."}</p>
        <div className="nf-fields">
          <label className="filter-field"><span>Name</span><input autoComplete="off" name="name" required /></label>
          {kind === "cef" ? <>
            <Segmented label="Transport" onChange={setTransport} options={TRANSPORT_OPTIONS} value={transport} />
            {transport === "udp" ? <>
              <label className="filter-field"><span>Host</span><input autoComplete="off" name="host" placeholder="siem.contoso.com" required /></label>
              <label className="filter-field"><span>Port</span><input max={65535} min={1} name="port" placeholder="514" required type="number" /></label>
              <p className="field-help">UDP cannot confirm delivery, so entries stay waiting until another destination confirms them.</p>
            </> : <>
              <label className="filter-field"><span>Address</span><input autoComplete="off" name="url" placeholder="https://siem.contoso.com/cef" required type="url" /></label>
              <label className="filter-field"><span>Delivery confirmation</span><select name="acknowledgement"><option value="http-response">From the HTTP response</option><option value="none">None</option></select></label>
            </>}
          </> : <>
            <label className="filter-field"><span>Address</span><input autoComplete="off" name="url" placeholder="https://hooks.contoso.com/keel" required type="url" /></label>
            <Segmented label="Sign-in" onChange={setAuth} options={AUTH_OPTIONS} value={auth} />
            {auth !== "none" ? <>
              <label className="filter-field"><span>Name of the stored secret (never the secret itself)</span><input autoComplete="off" name="credentialRef" placeholder="env:KEEL_WEBHOOK_TOKEN" required /></label>
              <p className="field-help">The name of a setting on the Keel server that holds the secret, written as env:NAME. Keel keeps the name only.</p>
            </> : null}
          </>}
        </div>
        {errorRow}
        <div className="nf-form-actions">
          <button className="btn" onClick={onClose} type="button">Cancel</button>
          <button aria-busy={busyAction === "register" || undefined} className="btn btn-primary" type="submit">Add destination</button>
        </div>
      </fieldset>
    </form>
  </DetailsSheet>;
}
