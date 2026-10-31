"use client";

import { useState, type FormEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { DatePicker } from "@/components/pickers/date-picker";
import { Segmented } from "@/components/pickers/segmented";
import { Icon } from "@/components/shell/icons";
import { incidentAction, utcInstant } from "@/lib/incident-calls";
import { WINDOW_HELP } from "@/lib/incidents-view";
import type { DayRange } from "@/lib/date-range";
import { reasonMessage } from "@/lib/written-reason";

// Open a new incident, and add an attack window to one. Dates use the shared date
// picker and a 24-hour time, always in UTC; nothing is saved until the button.

function TimeField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <label className="filter-field ir-time">
      <span>{label}</span>
      <span className="ir-time-box">
        <input autoComplete="off" disabled={disabled} inputMode="numeric" maxLength={5} onChange={(event) => onChange(event.target.value)} pattern="([01]?[0-9]|2[0-3]):[0-5][0-9]" placeholder="22:40" value={value} />
        <span aria-hidden="true">UTC</span>
      </span>
    </label>
  );
}

export function NewIncidentSheet({ today, onOpened, onClose }: {
  today: string;
  onOpened: (incidentId: string, title: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [day, setDay] = useState<DayRange | null>(null);
  const [time, setTime] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!title.trim()) { setError("Give the incident a title."); return; }
    const startsAt = day ? utcInstant(day.from, time) : null;
    if (day && !startsAt) { setError("Write the time as hours and minutes, such as 22:40."); return; }
    if (startsAt && !reason.trim()) { setError("Say how you know when the attacker got in."); return; }
    const weakWindow = startsAt ? reasonMessage(reason) : null;
    if (weakWindow) { setError(weakWindow); return; }
    setBusy(true);
    try {
      const opened = await incidentAction("open", { title: title.trim() });
      if (!opened.ok) { setError(opened.reason); return; }
      const id = String((opened.body.incident as { id?: string } | undefined)?.id ?? "");
      if (startsAt && id) {
        const window = await incidentAction("interval", { incidentId: id, startsAt, endsAt: null, reason: reason.trim() });
        if (!window.ok) { setError(`The incident is open, but the attack window was not saved: ${window.reason}`); onOpened(id, title.trim()); return; }
      }
      onOpened(id, title.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailsSheet
      footer={<>
        <button aria-busy={busy || undefined} className="btn" disabled={busy} form="ir-new" type="submit">Open incident</button>
        <button className="btn btn-ghost" onClick={onClose} type="button">Cancel</button>
      </>}
      kicker={<span className="ir-kicker"><Icon name="alert" />Incident</span>}
      onClose={onClose}
      title="New incident"
    >
      <form className="ir-form" id="ir-new" onSubmit={submit}>
        <p className="ir-effect">While an incident is open, a restore from a backup taken during the attack needs an investigator&apos;s check first.</p>
        <label className="filter-field">
          <span>Title</span>
          <input autoComplete="off" disabled={busy} maxLength={200} name="title" onChange={(event) => setTitle(event.target.value)} placeholder="Admin consent phishing" value={title} />
        </label>
        <fieldset disabled={busy}>
          <legend>When did the attacker get in? <small>Optional, you can add it later</small></legend>
          <div className="ir-when">
            <DatePicker allowClear label="Day" mode="single" onChange={setDay} today={today} value={day} />
            <TimeField label="Time (24-hour)" onChange={setTime} value={time} />
          </div>
          <label className="filter-field">
            <span>How you know</span>
            <input autoComplete="off" maxLength={500} name="reason" onChange={(event) => setReason(event.target.value)} placeholder="First risky sign-in in the sign-in report" value={reason} />
          </label>
        </fieldset>
        {error ? <p className="ir-error" role="alert">{error}</p> : null}
      </form>
    </DetailsSheet>
  );
}

export function AttackWindowSheet({ incidentId, today, onSaved, onClose }: {
  incidentId: string;
  today: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState<DayRange | null>(null);
  const [fromTime, setFromTime] = useState("");
  const [ongoing, setOngoing] = useState<"ongoing" | "ended">("ongoing");
  const [to, setTo] = useState<DayRange | null>(null);
  const [toTime, setToTime] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const startsAt = from ? utcInstant(from.from, fromTime) : null;
    if (!from) { setError("Pick the day the attacker got in."); return; }
    if (!startsAt) { setError("Write the time as hours and minutes, such as 22:40."); return; }
    const endsAt = ongoing === "ended" ? (to ? utcInstant(to.from, toTime) : null) : null;
    if (ongoing === "ended" && !endsAt) { setError("Pick the day and time the access ended."); return; }
    if (endsAt && endsAt <= startsAt) { setError("The end must be after the start."); return; }
    if (!reason.trim()) { setError("Say how you know."); return; }
    const weak = reasonMessage(reason);
    if (weak) { setError(weak); return; }
    setBusy(true);
    try {
      const saved = await incidentAction("interval", { incidentId, startsAt, endsAt, reason: reason.trim() });
      if (!saved.ok) { setError(saved.reason); return; }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailsSheet
      footer={<>
        <button aria-busy={busy || undefined} className="btn" disabled={busy} form="ir-window" type="submit">Add attack window</button>
        <button className="btn btn-ghost" onClick={onClose} type="button">Cancel</button>
        <p className="bl-help">{WINDOW_HELP}</p>
      </>}
      kicker={<span className="ir-kicker"><Icon name="alert" />Attack window</span>}
      onClose={onClose}
      title="Add attack window"
    >
      <form className="ir-form" id="ir-window" onSubmit={submit}>
        <p className="ir-effect">Backups taken inside the window are marked as taken during the attack, and checks made before it changed need redoing.</p>
        <fieldset disabled={busy}>
          <legend>Access started</legend>
          <div className="ir-when">
            <DatePicker label="Day" mode="single" onChange={setFrom} today={today} value={from} />
            <TimeField label="Time (24-hour)" onChange={setFromTime} value={fromTime} />
          </div>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Access ended</legend>
          <Segmented hideLabel label="Access ended" onChange={setOngoing} options={[{ value: "ongoing", label: "Still ongoing" }, { value: "ended", label: "It ended" }]} value={ongoing} />
          {ongoing === "ended" ? (
            <div className="ir-when">
              <DatePicker label="Day" mode="single" onChange={setTo} today={today} value={to} />
              <TimeField label="Time (24-hour)" onChange={setToTime} value={toTime} />
            </div>
          ) : null}
        </fieldset>
        <label className="filter-field">
          <span>How you know</span>
          <input autoComplete="off" disabled={busy} maxLength={500} name="reason" onChange={(event) => setReason(event.target.value)} placeholder="First risky sign-in in the sign-in report" value={reason} />
        </label>
        {error ? <p className="ir-error" role="alert">{error}</p> : null}
      </form>
    </DetailsSheet>
  );
}
