"use client";

import { RecordField } from "@/components/technical-details";
import type { AlertItem } from "@/lib/alerts-view";

// One alert's ids and codes, for Technical details only.
export function AlertRecord({ alert }: { alert: AlertItem }) {
  return (
    <>
      <RecordField label="Alert ID" usage="the alert's history and actions" value={alert.id} />
      <RecordField label="Resource" usage="the object the alert is about" value={alert.resourceKey} />
      <RecordField copy={false} label="Condition" usage="what raised it" value={`${alert.control} / ${alert.condition}`} />
      <RecordField copy={false} label="Severity" value={alert.severity} />
      <RecordField copy={false} label="State" value={alert.state} />
      <RecordField copy={false} label="Occurrence" value={String(alert.occurrence)} />
      <RecordField label="Latest event" usage="the check that last reported it" value={alert.lastEventId} />
      {alert.cause.snapshotId ? <RecordField label="Snapshot ID" usage="the backup the check compared" value={alert.cause.snapshotId} /> : null}
      {alert.ackDeadlineAt ? <RecordField copy={false} label="Deadline" value={alert.ackDeadlineAt} /> : null}
      {alert.escalationError ? <RecordField copy={false} label="Escalation error" value={alert.escalationError} /> : null}
    </>
  );
}
