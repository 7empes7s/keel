"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Segmented, type ChoiceOption } from "@/components/pickers/segmented";
import { Icon } from "@/components/shell/icons";
import { incidentAction, loadBackupItems, type BackupItem } from "@/lib/incident-calls";
import { backupName, itemLabel } from "@/lib/incidents-view";
import type { IncidentRecoveryPoint } from "@/lib/portal-data";
import { reasonMessage } from "@/lib/written-reason";

interface Chosen { naturalKey: string; label: string; kind: string; reason: string; field: string }

// Record an investigator's check on one backup: clean or unsafe, why, and for a clean
// one the harmful items a restore must leave out, picked by name from what the backup
// holds. The engine checks each item is in this backup and keeps every version.
export function CheckSheet({ incidentId, point, onSaved, onClose }: {
  incidentId: string;
  point: IncidentRecoveryPoint;
  onSaved: (verdict: "clean" | "compromised") => void;
  onClose: () => void;
}) {
  const [verdict, setVerdict] = useState<"clean" | "compromised">("clean");
  const [rationale, setRationale] = useState("");
  const [items, setItems] = useState<BackupItem[] | null | "unavailable">(null);
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadBackupItems(point.snapshotId).then((list) => { if (!cancelled) setItems(list ?? "unavailable"); });
    return () => { cancelled = true; };
  }, [point.snapshotId]);

  const options = useMemo<ChoiceOption<string>[]>(() => (Array.isArray(items) ? items : [])
    .filter((item) => !chosen.some((entry) => entry.naturalKey === item.naturalKey))
    .map((item) => { const words = itemLabel(item); return { value: item.naturalKey, label: words.label, hint: words.kind }; }), [items, chosen]);

  function add(naturalKey: string) {
    const item = Array.isArray(items) ? items.find((entry) => entry.naturalKey === naturalKey) : null;
    if (!item) return;
    const words = itemLabel(item);
    setChosen((current) => [...current, { naturalKey, label: words.label, kind: words.kind, reason: "", field: "" }]);
  }

  function change(naturalKey: string, patch: Partial<Chosen>) {
    setChosen((current) => current.map((entry) => (entry.naturalKey === naturalKey ? { ...entry, ...patch } : entry)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!rationale.trim()) { setError("Say why: what you checked and what you found."); return; }
    const weak = reasonMessage(rationale);
    if (weak) { setError(weak); return; }
    const leftOut = verdict === "clean" ? chosen : [];
    const missing = leftOut.find((entry) => !entry.reason.trim());
    if (missing) { setError(`Say why ${missing.label} is harmful.`); return; }
    const weakEntry = leftOut.find((entry) => reasonMessage(entry.reason) !== null);
    if (weakEntry) { setError(`${weakEntry.label}: ${reasonMessage(weakEntry.reason)}`); return; }
    setBusy(true);
    try {
      const saved = await incidentAction("assess", {
        incidentId,
        snapshotId: point.snapshotId,
        verdict,
        rationale: rationale.trim(),
        exclusions: leftOut.map((entry) => ({ naturalKey: entry.naturalKey, field: entry.field.trim() || null, reason: entry.reason.trim() })),
      });
      if (!saved.ok) { setError(saved.reason); return; }
      onSaved(verdict);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailsSheet
      footer={<>
        <button aria-busy={busy || undefined} className="btn" disabled={busy} form="ir-check" type="submit">Save check</button>
        <button className="btn btn-ghost" onClick={onClose} type="button">Cancel</button>
        <p className="bl-help">Each check is kept as a new version. A restore planned before it changes is blocked.</p>
      </>}
      kicker={<span className="ir-kicker"><Icon name="backup" />Backup of {backupName(point)}</span>}
      onClose={onClose}
      title={point.assessment ? "Record a new check" : "Record your check"}
    >
      <form className="ir-form" id="ir-check" onSubmit={submit}>
        <fieldset disabled={busy}>
          <legend>Result</legend>
          <Segmented hideLabel label="Result" onChange={setVerdict} options={[{ value: "clean", label: "Clean", icon: "check-circle" }, { value: "compromised", label: "Unsafe", icon: "x-circle" }]} value={verdict} />
          <p className="ir-muted">
            {verdict === "clean"
              ? "Clean: a restore may use this backup, leaving out the harmful items you list below."
              : "Unsafe: a restore from this backup is refused as a whole, so nothing is left out."}
          </p>
        </fieldset>
        <label className="filter-field">
          <span>Why</span>
          <textarea disabled={busy} maxLength={1000} name="rationale" onChange={(event) => setRationale(event.target.value)} placeholder="App list matches the day before; no new mail rules." rows={3} value={rationale} />
        </label>
        {verdict === "clean" ? (
          <fieldset disabled={busy}>
            <legend>Harmful items to leave out</legend>
            {items === null ? <p className="ir-muted">Reading what this backup holds…</p> : items === "unavailable" ? (
              <p className="ir-muted">What this backup holds could not be read. Save the check without leaving anything out, or close and try again.</p>
            ) : (
              <OptionPicker label="Add a harmful item" onChange={add} options={options} placeholder={options.length ? "Find an item by name" : "Nothing more to add"} value={null} />
            )}
            {chosen.length ? (
              <ul className="ir-picked">
                {chosen.map((entry) => (
                  <li key={entry.naturalKey}>
                    <div className="ir-picked-head">
                      <span><b>{entry.label}</b><small>{entry.kind}</small></span>
                      <button aria-label={`Remove ${entry.label}`} className="icon-button" onClick={() => setChosen((current) => current.filter((item) => item.naturalKey !== entry.naturalKey))} type="button"><Icon name="close" /></button>
                    </div>
                    <label className="filter-field">
                      <span>Why it is harmful</span>
                      <input autoComplete="off" maxLength={500} onChange={(event) => change(entry.naturalKey, { reason: event.target.value })} placeholder="Consent granted by the attacker" value={entry.reason} />
                    </label>
                    <details className="ir-advanced">
                      <summary>Leave out one setting only</summary>
                      <label className="filter-field">
                        <span>Setting (as named in the backup)</span>
                        <input autoComplete="off" maxLength={200} onChange={(event) => change(entry.naturalKey, { field: event.target.value })} placeholder="description" value={entry.field} />
                      </label>
                    </details>
                  </li>
                ))}
              </ul>
            ) : <p className="ir-muted">Nothing is left out yet.</p>}
          </fieldset>
        ) : null}
        {error ? <p className="ir-error" role="alert">{error}</p> : null}
      </form>
    </DetailsSheet>
  );
}
