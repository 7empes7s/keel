"use client";

import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import type { IncidentDetail, IncidentRecoveryPoint } from "@/lib/portal-data";

// The record layer of the Incidents page: every id, labelled, one click away. One for
// the incident at the foot of the page, one per backup inside its panel.

export function BackupRecord({ point, pin, override }: {
  point: IncidentRecoveryPoint;
  pin: IncidentDetail["pins"][number] | null;
  override: NonNullable<IncidentDetail["overrides"]>[number] | null;
}) {
  const assessment = point.assessment;
  return (
    <TechnicalDetails summary="Technical details for this backup">
      <RecordField label="Backup ID" usage={<>use with <code>keel-restore --snapshot-id &lt;id&gt;</code></>} value={point.snapshotId} />
      <RecordField copy={false} label="Collected from" value={point.observedFrom} />
      <RecordField copy={false} label="Collected to" value={point.observedTo} />
      <RecordField copy={false} label="Recovery point state" value={point.status} />
      <RecordField copy={false} label="Check is stale" value={point.stale} />
      <RecordField copy={false} label="Inside the attack window" value={point.inCompromiseWindow} />
      <RecordField copy={false} label="Kept for this incident" value={point.pinned} />
      {point.reasons.map((reason, index) => <RecordField copy={false} key={`${index}:${reason}`} label="Engine reason" value={reason} />)}
      {assessment ? (
        <RecordGroup note={`version ${assessment.version}`} title="Investigator's check">
          <RecordField copy={false} label="Assessment version" value={assessment.version} />
          <RecordField copy={false} label="Verdict" value={assessment.verdict} />
          <RecordField copy={false} label="Assessed at" value={assessment.assessedAt} />
          <RecordField label="Assessed by (principal ID)" usage={assessment.assessedBy?.name} value={assessment.assessedBy?.id} />
          <RecordField label="Assessment fingerprint" usage="bound into every restore plan made from this backup" value={assessment.fingerprint} />
        </RecordGroup>
      ) : null}
      {assessment?.exclusions.map((exclusion) => (
        <RecordGroup key={`${exclusion.naturalKey}#${exclusion.field ?? ""}`} note="left out of the restore" title={exclusion.displayName ?? exclusion.naturalKey}>
          <RecordField label="Exclusion" value={exclusion.naturalKey} />
          <RecordField copy={false} label="Field path" value={exclusion.field} />
          <RecordField copy={false} label="Reason" value={exclusion.reason} />
        </RecordGroup>
      ))}
      {pin ? (
        <RecordGroup title="Retention pin">
          <RecordField label="Retention pin ID" usage={<>release with <code>POST /api/actions/incidents</code> (op release)</>} value={pin.id} />
          <RecordField label="Pinned by (principal ID)" usage={pin.pinnedBy?.name} value={pin.pinnedBy.id} />
          <RecordField copy={false} label="Pinned at" value={pin.pinnedAt} />
          <RecordField copy={false} label="Reason" value={pin.reason} />
        </RecordGroup>
      ) : null}
      {override ? (
        <RecordGroup note="not withdrawn" title="Override">
          <RecordField label="Override ID" usage={<>withdraw with <code>POST /api/actions/incidents</code> (op revoke-override)</>} value={override.id} />
          <RecordField label="Authorized by (principal ID)" usage={override.authorizedBy?.name} value={override.authorizedBy?.id} />
          <RecordField copy={false} label="Authorized at" value={override.authorizedAt} />
          <RecordField copy={false} label="Reason" value={override.reason} />
        </RecordGroup>
      ) : null}
    </TechnicalDetails>
  );
}

export function IncidentRecord({ detail }: { detail: IncidentDetail }) {
  return (
    <TechnicalDetails summary="Technical details for this incident">
      <RecordField label="Incident ID" usage={<>use with <code>keel-restore --snapshot-id &lt;id&gt; --select &lt;key&gt; --incident &lt;id&gt;</code></>} value={detail.incident.id} />
      <RecordField label="Owner (principal ID)" usage={detail.incident.owner?.name} value={detail.incident.owner.id || null} />
      <RecordField copy={false} label="Status" value={detail.incident.status} />
      <RecordField copy={false} label="Opened" value={detail.incident.openedAt} />
      <RecordField copy={false} label="Closed" value={detail.incident.closedAt} />
      <RecordField label="Recommended backup ID" value={detail.recommended} />
      {detail.intervals.map((interval) => (
        <RecordGroup key={interval.id} note={interval.endsAt ? "ended" : "ongoing"} title="Attack window">
          <RecordField label="Interval ID" value={interval.id} />
          <RecordField copy={false} label="Access started" value={interval.startsAt} />
          <RecordField copy={false} label="Access ended" value={interval.endsAt ?? "ongoing"} />
          <RecordField copy={false} label="How it is known" value={interval.reason} />
          {interval.recordedBy ? <RecordField label="Recorded by (principal ID)" usage={interval.recordedBy?.name} value={interval.recordedBy.id} /> : null}
        </RecordGroup>
      ))}
      {detail.pins.map((pin) => (
        <RecordGroup key={pin.id} note="kept from pruning" title="Retention pin">
          <RecordField label="Retention pin ID" value={pin.id} />
          <RecordField label="Backup ID" value={pin.snapshotId} />
          <RecordField label="Pinned by (principal ID)" usage={pin.pinnedBy?.name} value={pin.pinnedBy.id} />
          <RecordField copy={false} label="Pinned at" value={pin.pinnedAt} />
          <RecordField copy={false} label="Reason" value={pin.reason} />
        </RecordGroup>
      ))}
      <RecordField copy={false} label="Changes" value="POST /api/actions/incidents (requires investigate)" />
      <RecordField copy={false} label="Settings in a backup" value="GET /api/snapshots/<id>/items" />
    </TechnicalDetails>
  );
}
