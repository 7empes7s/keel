"use client";

import { RecordField, UnnamedRefFields } from "@/components/technical-details";
import type { AlertItem } from "@/lib/alerts-view";
import { deletedSinceWords } from "@/lib/object-label";

// One alert's ids and codes, for Technical details only.
export function AlertRecord({ alert }: { alert: AlertItem }) {
  return (
    <>
      <RecordField label="Alert ID" usage="the alert's history and actions" value={alert.id} />
      <RecordField label="Setting" usage="the setting the alert is about" value={alert.resourceKey} />
      {alert.object?.objectId ? <RecordField label="Object ID" usage="the setting's id in Microsoft 365" value={alert.object.objectId} /> : null}
      <UnnamedRefFields refs={alert.unnamedRefs} />
      {alert.object ? <RecordField copy={false} label="In the newest backup" value={alert.object.status === "found" ? "Yes" : alert.object.status === "deleted" ? `No. ${deletedSinceWords(alert.object.deletedSince)}` : "Never backed up"} /> : null}
      <RecordField copy={false} label="Condition" usage="what raised it" value={`${alert.control} / ${alert.condition}`} />
      <RecordField copy={false} label="Severity" value={alert.severity} />
      <RecordField copy={false} label="State" value={alert.state} />
      <RecordField copy={false} label="Occurrence" value={String(alert.occurrence)} />
      <RecordField label="Latest event" usage="the check that last reported it" value={alert.lastEventId} />
      {alert.cause.snapshotId ? <RecordField label="Backup ID" usage="the backup the check compared" value={alert.cause.snapshotId} /> : null}
      {alert.ackDeadlineAt ? <RecordField copy={false} label="Deadline" value={alert.ackDeadlineAt} /> : null}
      {alert.escalationError ? <RecordField copy={false} label="Escalation error" value={alert.escalationError} /> : null}
    </>
  );
}
