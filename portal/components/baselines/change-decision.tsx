"use client";

import { useState } from "react";

import { DatePicker } from "@/components/pickers/date-picker";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { decisionWords, plainLabel, type Decision } from "@/lib/baselines-view";
import { plannedActionWords, refusalSentence, resourceName } from "@/lib/changes-view";
import { addDays, type Day, type DayRange } from "@/lib/date-range";
import { remediationParams } from "@/lib/drift-actions";
import type { DriftRecord } from "@/lib/types";

interface UndoPreview {
  driftIds: string[];
  resources: { naturalKey: string; resourceType: string; verb: string; verbReason: string }[];
  waves: string[][];
  deletionWaves: string[][];
  patches: { naturalKey: string; field: string; symbol: string }[];
  guardRefusals: { naturalKey: string; reason: string }[];
}

async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Action request failed (${response.status})`);
  return response.json();
}

const sameIds = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** One decision on chosen changes: accept them into the approved setup, ignore them for a
 * while, or undo them. It says what it will do before it does it, asks why, and an undo
 * shows Keel's plan first and goes to someone else for approval. */
export function ChangeDecision({
  decision,
  items,
  today,
  onDone,
  onCancel,
}: {
  decision: Decision;
  items: DriftRecord[];
  today: Day;
  // Called with the changes that are settled (accepted or ignored), or none for an undo
  // sent for approval, and the sentence to show.
  onDone: (settled: string[], message: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState<DayRange | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<UndoPreview | null>(null);

  const ids = items.map((item) => item.id);
  const words = decisionWords(decision, items.length);
  // A preview counts only for exactly the changes it was made for.
  const currentPreview = preview && sameIds(preview.driftIds, ids) ? preview : null;
  const refused = Boolean(currentPreview?.guardRefusals.length);

  function requireReason(): string | null {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Say why: a reason is required, and it is kept with the decision.");
      return null;
    }
    return trimmed;
  }

  async function dispose(action: "accept" | "ignore") {
    const justification = requireReason();
    if (!justification) return;
    let expiresAt: string | undefined;
    if (action === "ignore") {
      if (!until) {
        setError("Choose until when to ignore these changes.");
        return;
      }
      expiresAt = new Date(`${until.from}T23:59:59Z`).toISOString();
    }
    setSubmitting(true);
    setError(null);
    try {
      const settled = await Promise.all(ids.map(async (driftId) => {
        await post("/api/actions/dispose", { driftId, action, reason: justification, ...(expiresAt ? { expiresAt } : {}) });
        return driftId;
      }));
      onDone(settled, `${action === "accept" ? "Accepted" : "Ignored"} ${settled.length} ${settled.length === 1 ? "change" : "changes"}.`);
    } catch {
      setError("Keel could not save the decision. No further changes were sent.");
    } finally {
      setSubmitting(false);
    }
  }

  async function previewUndo() {
    setSubmitting(true);
    setPreview(null);
    setError(null);
    try {
      setPreview(await post("/api/actions/remediate/selection", { driftIds: ids }) as UndoPreview);
    } catch {
      setError("Keel could not work out what undoing would do. Nothing was requested.");
    } finally {
      setSubmitting(false);
    }
  }

  async function sendUndo() {
    if (!currentPreview || currentPreview.guardRefusals.length > 0) return;
    const justification = requireReason();
    if (!justification) return;
    setSubmitting(true);
    setError(null);
    try {
      await post("/api/actions/remediate", remediationParams({ selectedDriftIds: ids, visibleDriftIds: ids, justification }));
      setPreview(null);
      onDone([], "Sent to approvers. Nothing changes until one of them approves.");
    } catch {
      setError("Keel could not send the undo for approval. Try again in a minute.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bl-decision">
      <p className="bl-decision-what">{words.detail}</p>
      <p className="bl-decision-scope">
        <b>Applies only to:</b> {items.map((item) => plainLabel(item.naturalKey)).join(", ")}.
      </p>
      <label className="picker-field bl-reason">
        <span className="picker-label">Why</span>
        <input
          className="bl-input"
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why is this decision right?"
          value={reason}
        />
        <small>Kept with the decision, so anyone can see later why it was made.</small>
      </label>
      {decision === "ignore" ? (
        <DatePicker label="Ignore until" mode="single" onChange={setUntil} today={addDays(today, 1)} value={until} />
      ) : null}

      {decision === "undo" && currentPreview ? (
        <section aria-labelledby="undo-preview-heading" aria-live="polite" className="bl-undo-preview remediation-preview">
          <h3 id="undo-preview-heading">What undoing would do</h3>
          <p className="bl-help">Worked out from the tenant as it is now. Keel checks again before it changes anything.</p>
          <ul className="bl-undo-list">
            {currentPreview.resources.map((resource) => (
              <li key={resource.naturalKey}><b>{resourceName(resource.naturalKey)}</b><span>{plannedActionWords(resource.verb)}</span></li>
            ))}
          </ul>
          {refused ? (
            <div className="data-error" role="alert">
              <p className="severity-label">Cannot undo</p>
              <ul>{currentPreview.guardRefusals.map((refusal, index) => <li key={index}>{refusalSentence(refusal)}</li>)}</ul>
            </div>
          ) : <p className="action-message">Keel found nothing it would refuse to change.</p>}
          <TechnicalDetails>
            {currentPreview.resources.map((resource) => (
              <RecordField copy={false} key={resource.naturalKey} label={`Planned verb · ${resource.naturalKey}`} value={`${resource.verb} · ${resource.verbReason}`} />
            ))}
            {currentPreview.waves.map((keys, index) => <RecordField copy={false} key={`write-${index}`} label={`Write wave ${index + 1}`} value={keys.join(", ")} />)}
            {currentPreview.patches.length ? (
              <RecordField copy={false} label="Deferred references" value={currentPreview.patches.map((patch) => `${patch.naturalKey} at ${patch.field} → ${patch.symbol}`).join(", ")} />
            ) : null}
            {currentPreview.deletionWaves.map((keys, index) => <RecordField copy={false} key={`delete-${index}`} label={`Delete wave ${index + 1}`} value={keys.join(", ")} />)}
            {currentPreview.guardRefusals.map((refusal, index) => (
              <RecordField copy={false} key={`refusal-${index}`} label={`Guard refusal · ${refusal.naturalKey}`} value={refusal.reason} />
            ))}
            <RecordField copy={false} label="Drift IDs" value={currentPreview.driftIds.join(", ")} />
          </TechnicalDetails>
        </section>
      ) : null}

      {error ? <p className="action-error" role="alert">{error}</p> : null}

      <div className="bl-decision-actions">
        {decision === "undo" ? (
          currentPreview ? (
            <button className="btn btn-primary" disabled={submitting || refused} onClick={() => void sendUndo()} type="button">Send for approval</button>
          ) : (
            <button aria-busy={submitting || undefined} className="btn btn-primary" disabled={submitting} onClick={() => void previewUndo()} type="button">Check what undoing would do</button>
          )
        ) : (
          <button aria-busy={submitting || undefined} className="btn btn-primary" disabled={submitting} onClick={() => void dispose(decision)} type="button">{words.confirm}</button>
        )}
        <button className="btn" disabled={submitting} onClick={onCancel} type="button">Cancel</button>
      </div>
    </div>
  );
}
