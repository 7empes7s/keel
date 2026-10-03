"use client";

import { useState } from "react";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  STATE_LABELS,
  STATE_TONES,
  alertTitle,
  causeSentence,
  historyLabel,
  inboxOrder,
  isOverdue,
  type AlertItem,
} from "@/lib/alerts-view";
import { ago, formatTimestamp, fromNow } from "@/lib/presentation";
import { toast } from "@/lib/toast";

// Roadmap task-83: the alerts inbox. Each alert shows its owner, its acknowledgement
// deadline, its state and history, and the change that raised it. Acknowledging and
// resolving post to the guarded alert action; a viewer without the right sees neither.

function deadlineSentence(alert: AlertItem, now: string): string | null {
  if (alert.state !== "open" && alert.state !== "reopened") return null;
  if (!alert.ackDeadlineAt) return "No acknowledgement deadline is set for alerts like this one.";
  if (isOverdue(alert, now)) {
    return alert.escalated
      ? `Missed its acknowledgement deadline ${ago(alert.ackDeadlineAt, now)} and was escalated.`
      : `Missed its acknowledgement deadline ${ago(alert.ackDeadlineAt, now)}.`;
  }
  return `Acknowledge ${fromNow(alert.ackDeadlineAt, now)}, by ${formatTimestamp(alert.ackDeadlineAt)}.`;
}

function AlertCard({ alert, now, canRespond }: { alert: AlertItem; now: string; canRespond: boolean }) {
  const [busy, setBusy] = useState(false);
  const headingId = `alert-${alert.id}`;
  const deadline = deadlineSentence(alert, now);
  const active = alert.state === "open" || alert.state === "reopened" || alert.state === "acknowledged";

  async function respond(action: "acknowledge" | "resolve") {
    setBusy(true);
    try {
      const response = await fetch("/api/actions/alerts", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ alertId: alert.id, action }),
      });
      if (response.status === 403) {
        toast({ tone: "warning", title: "Not changed", detail: "You need the operator role, or your sign-in has ended." });
        return;
      }
      if (response.status === 409) {
        toast({ tone: "warning", title: "Already changed", detail: "Someone else changed this alert first. The list now shows where it stands." });
      } else if (!response.ok) {
        toast({ tone: "warning", title: "Not changed", detail: "KEEL could not record that. Try again." });
        return;
      } else {
        toast({ title: action === "acknowledge" ? "Alert acknowledged" : "Alert resolved" });
      }
      // Read the alert back from what KEEL recorded, never from this response.
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="item-card alert-card">
      <div className="item-card-head">
        <h2 id={headingId}>{alertTitle(alert)}</h2>
        <span className={`pill pill-${STATE_TONES[alert.state]}`}>{STATE_LABELS[alert.state]}</span>
      </div>
      <p>{causeSentence(alert)}</p>
      <p className="field-help">
        {alert.owner
          ? `Owner: ${alert.owner.name}.`
          : "Unassigned: no owner is set for alerts like this one, so it waits for whoever acknowledges it."}
        {" "}
        {alert.occurrence > 1
          ? `It has come back ${alert.occurrence - 1 === 1 ? "once" : `${alert.occurrence - 1} times`} since it first opened ${ago(alert.firstOpenedAt, now)}.`
          : `Opened ${ago(alert.firstOpenedAt, now)}.`}
        {alert.state === "acknowledged" && alert.acknowledgedAt
          ? ` Acknowledged by ${alert.acknowledgedByName ?? "someone"} ${ago(alert.acknowledgedAt, now)}; it stays open until the change goes away or someone resolves it.`
          : ""}
      </p>
      {deadline ? <p className={isOverdue(alert, now) ? "alert-deadline alert-deadline-missed" : "alert-deadline"}>{deadline}</p> : null}
      {alert.escalationError ? <p className="field-help" role="note">{alert.escalationError}</p> : null}

      <details className="alert-history">
        <summary>History ({alert.history.length})</summary>
        <ol>
          {alert.history.map((entry) => (
            <li key={entry.id}>
              <time dateTime={entry.at} title={formatTimestamp(entry.at)}>{ago(entry.at, now)}</time>
              {": "}
              {historyLabel(entry)}
              {entry.actorName ? `, by ${entry.actorName}` : ""}
            </li>
          ))}
        </ol>
      </details>

      {canRespond && active ? (
        <div className="form-actions">
          {alert.state !== "acknowledged" ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => respond("acknowledge")} type="button">
              Acknowledge
            </button>
          ) : null}
          <ConfirmButton
            confirmLabel="Resolve alert"
            description="The alert closes now. If the change is still there, the next check opens it again and its history is kept."
            disabled={busy}
            onConfirm={() => respond("resolve")}
            title={`Resolve the alert for ${alertTitle(alert)}?`}
          >
            Resolve
          </ConfirmButton>
        </div>
      ) : null}

      <TechnicalDetails>
        <RecordField label="Alert ID" usage="the alert's history and actions" value={alert.id} />
        <RecordField label="Resource" usage="the object the alert is about" value={alert.resourceKey} />
        <RecordField label="Condition" usage="what raised it" value={`${alert.control} / ${alert.condition}`} />
        <RecordField label="Occurrence" copy={false} value={String(alert.occurrence)} />
        <RecordField label="Latest event" usage="the check that last reported it" value={alert.lastEventId} />
        {alert.cause.snapshotId ? <RecordField label="Snapshot ID" usage="the backup the check compared" value={alert.cause.snapshotId} /> : null}
        {alert.ackDeadlineAt ? <RecordField label="Deadline" copy={false} value={alert.ackDeadlineAt} /> : null}
      </TechnicalDetails>
    </section>
  );
}

export function AlertInbox({ alerts, now, canRespond }: { alerts: AlertItem[]; now: string; canRespond: boolean }) {
  if (alerts.length === 0) {
    return <p className="empty-state">No alerts yet. When a check finds a change from the baseline, it shows here.</p>;
  }
  return (
    <div className="item-list">
      {inboxOrder(alerts).map((alert) => <AlertCard alert={alert} canRespond={canRespond} key={alert.id} now={now} />)}
    </div>
  );
}
