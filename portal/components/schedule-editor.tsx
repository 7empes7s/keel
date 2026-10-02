"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { localTimeToUTC, utcTimeToLocal } from "../../engine/schedules/timeOfDay.mjs";
import type { Schedule } from "@/lib/schedules";
import { toast } from "@/lib/toast";

export function ScheduleEditor({ schedule }: { schedule: Schedule }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [n, setN] = useState(String(schedule.cadence.n));
  const [every, setEvery] = useState(schedule.cadence.every);
  const [time, setTime] = useState("");
  const [timeChanged, setTimeChanged] = useState(false);
  const [raw, setRaw] = useState(schedule.cron_override !== null);
  const [cron, setCron] = useState(schedule.cron_override ?? "");
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const formId = `schedule-${schedule.id}`;

  function open() {
    setN(String(schedule.cadence.n));
    setEvery(schedule.cadence.every);
    // Convert on opening in the browser, never in the server's timezone at SSR.
    setTime(schedule.cadence.atTime ? utcTimeToLocal(schedule.cadence.atTime) : "");
    setTimeChanged(false);
    setRaw(schedule.cron_override !== null);
    setCron(schedule.cron_override ?? "");
    setEnabled(schedule.enabled);
    setError(null);
    setMessage(null);
    setEditing(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: schedule.id,
          cadence: {
            every, n: Number(n),
            // Preserve the saved UTC value unless the operator changes the time.
            atTime: timeChanged ? (time ? localTimeToUTC(time) : null) : schedule.cadence.atTime,
          },
          cron_override: raw ? cron.trim() : null,
          enabled,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Schedule could not be saved.");
      setEditing(false);
      setMessage("Schedule saved.");
      toast({ title: `${schedule.job_kind}${schedule.tier ? ` ${schedule.tier}` : ""} schedule saved` });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Schedule could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="schedule-editor">
    <button className="btn btn-secondary btn-sm" type="button" aria-expanded={editing} aria-controls={formId} onClick={open} disabled={saving}>Edit {schedule.job_kind}{schedule.tier ? ` ${schedule.tier}` : ""}</button>
    {editing ? <form className="form-card" id={formId} onSubmit={save} aria-label={`Edit ${schedule.job_kind} ${schedule.tier ?? "schedule"}`}>
      <fieldset disabled={saving}>
        <legend>Cadence</legend>
        <label className="check-field"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled</label>
        <label className="check-field"><input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} /> Use raw cron expression</label>
        {raw ? <label className="filter-field"><span>Cron expression (UTC)</span>
          <input required value={cron} onChange={(event) => setCron(event.target.value)} aria-describedby={`${formId}-cron-help`} />
          <small className="field-help" id={`${formId}-cron-help`}>Five fields: minute, hour, day of month, month, day of week.</small>
        </label> : <div className="filter-bar">
          <label className="filter-field"><span>Every</span><input type="number" required min="1" max="10000" step="1" value={n} onChange={(event) => setN(event.target.value)} /></label>
          <label className="filter-field"><span>Unit</span><select value={every} onChange={(event) => setEvery(event.target.value as Schedule["cadence"]["every"])}>
            <option value="hour">Hours</option><option value="day">Days</option><option value="week">Weeks</option>
          </select></label>
          <label className="filter-field"><span>Time of day (local, optional)</span><input type="time" value={time} onChange={(event) => { setTime(event.target.value); setTimeChanged(true); }} /></label>
          <p className="field-help">Local time is converted to UTC when saved. Stored UTC times stay fixed through daylight saving changes.{every === "hour" ? " Hourly schedules use the minute of the selected time." : ""}</p>
        </div>}
        <div className="form-actions">
          <button className="btn btn-primary" aria-busy={saving || undefined} disabled={saving} type="submit">{saving ? "Saving…" : "Save schedule"}</button>
          <button className="btn btn-ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </fieldset>
    </form> : null}
    {message ? <p className="action-message" role="status">{message}</p> : null}
    {error ? <p className="action-error" role="alert">{error}</p> : null}
  </div>;
}
