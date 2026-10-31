"use client";

import { useMemo, useState } from "react";

import { PickSummary } from "@/components/list/pick-summary";
import { DatePicker } from "@/components/pickers/date-picker";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { decisionWords, type Decision } from "@/lib/baselines-view";
import { changeLabel, changeName, plannedActionWords, refusalSentence } from "@/lib/changes-view";
import { addDays, type Day, type DayRange } from "@/lib/date-range";
import { remediationParams } from "@/lib/drift-actions";
import { changePick } from "@/lib/pick-items";
import type { DriftRecord } from "@/lib/types";

interface UndoPreview {
  driftIds: string[];
  resources: { naturalKey: string; resourceType: string; verb: string; verbReason: string }[];
  waves: string[][];
  deletionWaves: string[][];
  patches: { naturalKey: string; field: string; symbol: string }[];
  guardRefusals: { naturalKey: string; reason: string }[];
}

// A change whose setting holds the same values as the approved setup: the server says
// so (409 no_change), and that sentence is shown instead of a generic failure.
class NoChangeError extends Error {}

async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (response.status === 409 && payload?.error === "no_change") {
      throw new NoChangeError(payload.message || "Nothing changed: the setting holds the same values as the approved setup.");
    }
    // A refused ignore end date says why (for example, more than 90 days away).
    if (response.status === 400 && payload?.message) throw new NoChangeError(`${payload.message[0].toUpperCase()}${payload.message.slice(1)}.`);
    throw new Error(`Action request failed (${response.status})`);
  }
  return response.json();
}

const failure = (error: unknown, fallback: string) => (error instanceof NoChangeError ? error.message : fallback);

// The engine refuses a longer ignore (dispositionReview.mjs MAX_IGNORE_DAYS).
const MAX_IGNORE_DAYS = 90;

/** "Accepted 2 changes. 1 change to sign-in or admin access was sent to a second person." */
export function decisionMessage(action: "accept" | "ignore", results: { sent: boolean }[]): string {
  const count = (n: number) => `${n} ${n === 1 ? "change" : "changes"}`;
  const sent = results.filter((result) => result.sent).length;
  const done = results.length - sent;
  const parts: string[] = [];
  if (done) parts.push(`${action === "accept" ? "Accepted" : "Ignored"} ${count(done)}.`);
  if (sent) parts.push(`${count(sent)} to sign-in or admin access ${sent === 1 ? "was" : "were"} sent to a second person to approve. Nothing changes until they do.`);
  return parts.join(" ");
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
  // The plan names resources by key; the chosen changes carry their names. A resource
  // the plan adds (a dependency) is named from its key, never by its id.
  const byKey = new Map(items.map((item) => [item.naturalKey, item]));
  const nameOf = (resource: { naturalKey: string; resourceType?: string }) => {
    const item = byKey.get(resource.naturalKey);
    return item ? changeName(item) : changeName({ naturalKey: resource.naturalKey, resourceType: resource.resourceType ?? resource.naturalKey.split(":")[0] });
  };
  const labelOf = (resource: { naturalKey: string; resourceType?: string }) => {
    const item = byKey.get(resource.naturalKey);
    return item ? changeLabel(item) : changeLabel({ naturalKey: resource.naturalKey, resourceType: resource.resourceType ?? resource.naturalKey.split(":")[0] });
  };
  const words = decisionWords(decision, items.length);
  const picks = useMemo(() => items.map(changePick), [items]);
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
      // The day ends at 23:59 UTC, so the last day allowed is the one before day 90.
      if (until.from >= addDays(today, MAX_IGNORE_DAYS)) {
        setError(`Ignore for at most ${MAX_IGNORE_DAYS} days. Choose an earlier date.`);
        return;
      }
      expiresAt = new Date(`${until.from}T23:59:59Z`).toISOString();
    }
    setSubmitting(true);
    setError(null);
    try {
      // A service setting change is accepted into its service's approved setup. A change
      // to sign-in or admin access goes to a second person instead (202 with a request).
      const results = await Promise.all(items.map(async (item) => {
        const result = await post("/api/actions/dispose", item.serviceRead
          ? { serviceChangeId: item.id, action, reason: justification }
          : { driftId: item.id, action, reason: justification, ...(expiresAt ? { expiresAt } : {}) }) as { approvalRequest?: unknown } | null;
        return { id: item.id, sent: Boolean(result?.approvalRequest) };
      }));
      onDone(results.filter((result) => !result.sent).map((result) => result.id), decisionMessage(action, results));
    } catch (error) {
      setError(failure(error, "Keel could not save the decision. No further changes were sent."));
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
    } catch (error) {
      setError(failure(error, "Keel could not work out what undoing would do. Nothing was requested."));
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
    } catch (error) {
      setError(failure(error, "Keel could not send the undo for approval. Try again in a minute."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bl-decision">
      <p className="bl-decision-what">{words.detail}</p>
      <PickSummary items={picks} noun={{ one: "change", many: "changes" }} />
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
        <div className="picker-field">
          <DatePicker label="Ignore until" mode="single" onChange={setUntil} today={addDays(today, 1)} value={until} />
          <small>Up to {MAX_IGNORE_DAYS} days. Keel shows the change again after that.</small>
        </div>
      ) : null}

      {decision === "undo" && currentPreview ? (
        <section aria-labelledby="undo-preview-heading" aria-live="polite" className="bl-undo-preview remediation-preview">
          <h3 id="undo-preview-heading">What undoing would do</h3>
          <p className="bl-help">Worked out from the tenant as it is now. Keel checks again before it changes anything.</p>
          <ul className="bl-undo-list">
            {currentPreview.resources.map((resource) => (
              <li key={resource.naturalKey}><b>{nameOf(resource)}</b><span>{plannedActionWords(resource.verb)}</span></li>
            ))}
          </ul>
          {refused ? (
            <div className="data-error" role="alert">
              <p className="severity-label">Cannot undo</p>
              <ul>{currentPreview.guardRefusals.map((refusal, index) => <li key={index}>{refusalSentence(refusal, labelOf(refusal))}</li>)}</ul>
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
