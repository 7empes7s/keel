"use client";

import { useState } from "react";

import { DatePicker } from "@/components/pickers/date-picker";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { decisionWords, type Decision } from "@/lib/baselines-view";
import { changeLabel, changeName, plannedActionWords, refusalSentence } from "@/lib/changes-view";
import { addDays, type Day, type DayRange } from "@/lib/date-range";
import { remediationParams } from "@/lib/drift-actions";
import { BusyError, sendEach } from "@/lib/send-each";
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
// No answer, or a failure after Keel may have saved it: never sent again on its own,
// since a second send could make a second approval request.
class UnsureError extends Error {}

async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new UnsureError("Keel did not answer");
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (response.status === 409 && payload?.error === "no_change") {
      throw new NoChangeError(payload.message || "Nothing changed: the setting holds the same values as the approved setup.");
    }
    // A refused ignore end date says why (for example, more than 90 days away).
    if (response.status === 400 && payload?.message) throw new NoChangeError(`${payload.message[0].toUpperCase()}${payload.message.slice(1)}.`);
    // Turned away before any work because every database connection was in use: safe
    // to send again. Any other 503 may come after a write, so it is not retried.
    if (response.status === 503 && payload?.error === "busy") throw new BusyError("Keel was busy");
    if (response.status >= 500) throw new UnsureError("Keel did not finish");
    throw new Error(`Action request failed (${response.status})`);
  }
  return response.json();
}

/** Why one change could not be saved, in a few words. */
export function whyNotSaved(error: unknown): string {
  if (error instanceof NoChangeError) return error.message.replace(/\.$/, "");
  if (error instanceof BusyError) return "Keel was busy";
  if (error instanceof UnsureError) return "Keel did not answer, so it may already be saved. Reload the page to check before trying again";
  return "Keel refused it";
}

/** Whether sending the change again can help: not when Keel said why it refused. */
export const worthRetrying = (error: unknown) => error instanceof BusyError || error instanceof UnsureError;

/** "760 of 775 changes went through. 15 could not be saved and are still chosen: A, B and 13 more. Try again to save them." */
export function notSavedMessage(total: number, failedNames: string[], retry = true): string {
  const failed = failedNames.length;
  const saved = total - failed;
  const shown = failedNames.slice(0, 3);
  const names = failed > shown.length ? `${shown.join(", ")} and ${failed - shown.length} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0];
  // "Went through": some may have gone to a second person rather than being saved.
  const lead = saved ? `${saved} of ${total} changes went through. ` : "";
  const what = failed === 1 ? "1 change could not be saved and is still chosen" : `${failed} changes could not be saved and are still chosen`;
  const next = retry ? `Try again to save ${failed === 1 ? "it" : "them"}.` : "See why below, then change or leave out what Keel refused.";
  return `${lead}${what}: ${names}. ${next}`;
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
  onBusy,
}: {
  decision: Decision;
  items: DriftRecord[];
  today: Day;
  // Called with the changes that are settled (accepted or ignored), or none for an undo
  // sent for approval, and the sentence to show. `kept` are the changes that could not
  // be saved: the panel stays open on just those, with the reason shown.
  onDone: (settled: string[], message: string, kept?: string[]) => void;
  onCancel: () => void;
  // Told while a decision is being sent, so the panel is not closed half way.
  onBusy?: (busy: boolean) => void;
}) {
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState<DayRange | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Changes that could not be saved last time, and why.
  const [notSaved, setNotSaved] = useState<{ name: string; why: string }[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
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
    onBusy?.(true);
    setError(null);
    setNotSaved([]);
    setProgress({ done: 0, total: items.length });
    // A service setting change is accepted into its service's approved setup. A change
    // to sign-in or admin access goes to a second person instead (202 with a request).
    // A few at a time: one failure never stops the rest, and is named afterwards.
    const results = await sendEach(items, async (item) => {
      const result = await post("/api/actions/dispose", item.serviceRead
        ? { serviceChangeId: item.id, action, reason: justification }
        : { driftId: item.id, action, reason: justification, ...(expiresAt ? { expiresAt } : {}) }) as { approvalRequest?: unknown } | null;
      return { id: item.id, sent: Boolean(result?.approvalRequest) };
    }, { onProgress: (done, total) => setProgress({ done, total }) });
    setSubmitting(false);
    onBusy?.(false);
    setProgress(null);
    const saved = results.flatMap((result) => (result.ok ? [result.value] : []));
    const failed = results.flatMap((result) => (result.ok ? [] : [{ item: result.item, error: result.error }]));
    const settled = saved.filter((result) => !result.sent).map((result) => result.id);
    if (!failed.length) {
      onDone(settled, decisionMessage(action, saved));
      return;
    }
    if (failed.length === 1 && items.length === 1) {
      setError(failure(failed[0].error, "Keel could not save the decision. Nothing was changed."));
      return;
    }
    setNotSaved(failed.map(({ item, error }) => ({ name: changeLabel(item), why: whyNotSaved(error) })));
    setError(notSavedMessage(items.length, failed.map(({ item }) => changeLabel(item)), failed.every(({ error }) => worthRetrying(error))));
    if (saved.length) onDone(settled, decisionMessage(action, saved), failed.map(({ item }) => item.id));
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
      <p className="bl-decision-scope">
        <b>Applies only to:</b> {items.map((item) => changeLabel(item)).join(", ")}.
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
      {notSaved.length ? (
        <details className="bl-not-saved">
          <summary>Why each one was not saved</summary>
          <ul>{notSaved.map((entry, index) => <li key={index}><b>{entry.name}</b>: {entry.why}</li>)}</ul>
        </details>
      ) : null}

      <div className="bl-decision-actions">
        {decision === "undo" ? (
          currentPreview ? (
            <button className="btn btn-primary" disabled={submitting || refused} onClick={() => void sendUndo()} type="button">Send for approval</button>
          ) : (
            <button aria-busy={submitting || undefined} className="btn btn-primary" disabled={submitting} onClick={() => void previewUndo()} type="button">Check what undoing would do</button>
          )
        ) : (
          <button aria-busy={submitting || undefined} className="btn btn-primary" disabled={submitting} onClick={() => void dispose(decision)} type="button">{progress && progress.total > 1 ? `Saving ${progress.done} of ${progress.total}…` : words.confirm}</button>
        )}
        <button className="btn" disabled={submitting} onClick={onCancel} type="button">Cancel</button>
      </div>
    </div>
  );
}
