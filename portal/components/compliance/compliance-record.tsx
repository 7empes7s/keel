import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { checkCountRecord } from "@/lib/compliance-view";
import type { ComplianceFinding, StorageResidency } from "@/lib/types";

// The record layer of one result: every id, code and window the words above rest on.
// Results are evidence: an evaluation row is never edited, an exception only added.
export function FindingRecordFields({ finding }: { finding: ComplianceFinding }) {
  const { links } = finding;
  const totals = checkCountRecord(finding);
  return (
    <>
      <RecordField label="Evaluation ID" value={finding.id} />
      <RecordField copy={false} label="Control ID" value={finding.controlId} />
      <RecordField copy={false} label="Control wording" value={finding.title} />
      {finding.description ? <RecordField copy={false} label="Control description" value={finding.description} /> : null}
      <RecordField copy={false} label="Verdict code" value={`${finding.verdict}${finding.reason ? ` · ${finding.reason}` : ""}${finding.severity ? ` · severity ${finding.severity}` : ""}`} />
      <RecordField copy={false} label="Framework" value={`${finding.framework} · edition ${finding.edition} · profile ${finding.profile} · evaluator v${finding.evaluatorVersion}`} />
      <RecordField copy={false} label="Evaluated at" value={finding.evaluatedAt} />
      {finding.evidenceSeq ? <RecordField label="Evidence sequence" usage={<>use with <code>GET /api/evidence</code></>} value={finding.evidenceSeq} /> : null}
      {finding.evidence.map((entry) => (
        <RecordField
          copy={false}
          key={`${entry.resourceType}-${entry.window.startedAt}`}
          label={`Observation window · ${entry.resourceType}`}
          value={`${entry.window.startedAt ?? "unknown"} → ${entry.window.endedAt ?? "unknown"} · ${entry.collectionId ? `service read ${entry.collectionId}` : `backup ${entry.snapshotId ?? "no match"}`}`}
        />
      ))}
      {totals ? (
        <>
          <RecordField copy={false} label="Settings checked" value={totals.checked} />
          <RecordField copy={false} label="Settings failing" value={totals.failing} />
          {totals.listed ? <RecordField copy={false} label="Settings listed" value={totals.listed} /> : null}
        </>
      ) : null}
      {(finding.details ?? []).map((line, index) => (
        <RecordField
          copy={false}
          key={`detail-${index}`}
          label={`${line.ok ? "Checked" : "Failing"} setting · ${line.subject}`}
          value={`${line.setting} = ${JSON.stringify(line.value)} (expected ${JSON.stringify(line.expected)})`}
        />
      ))}
      {links.change.linked.map((change) => (
        <RecordField key={change.id} label="Linked drift ID" value={`${change.id} · ${change.naturalKey} · backup ${change.snapshotId}`} />
      ))}
      {links.change.mismatched.map((change) => (
        <RecordField key={change.id} label="Mismatched drift ID" value={`${change.id} · ${change.naturalKey} · backup ${change.snapshotId}`} />
      ))}
      {[...links.restorePlan.linked.map((plan) => ["Linked", plan] as const), ...links.restorePlan.mismatched.map((plan) => ["Mismatched", plan] as const)].map(([kind, plan]) => (
        <RecordField
          key={plan.requestId}
          label={`${kind} restore dry run ID`}
          usage={<>approval request {plan.requestId} · backup {plan.snapshotId}</>}
          value={plan.dryRunId}
        />
      ))}
      {finding.exception ? (
        <>
          <RecordField label="Exception ID" value={finding.exception.id} />
          <RecordField copy={false} label="Exception" value={`state ${finding.exceptionState} · owner ${finding.exception.owner ?? finding.exception.ownerRef?.name ?? "none"} · granted by ${finding.exception.grantedBy ?? "unknown"} at ${finding.exception.grantedAt ?? "unknown"} · expires ${finding.exception.expiresAt ?? "never set"}`} />
        </>
      ) : null}
    </>
  );
}

export function FindingRecord({ finding }: { finding: ComplianceFinding }) {
  return (
    <TechnicalDetails>
      <FindingRecordFields finding={finding} />
      <RecordField copy={false} label="Edits" value="Results are kept as a record and cannot be edited. A new exception is added beside the old ones." />
    </TechnicalDetails>
  );
}

export function StorageRecordFields({ storage }: { storage: StorageResidency }) {
  return (
    <>
      <RecordField copy={false} label="Provider code" value={storage.provider} />
      <RecordField copy={false} label="Region" value={storage.region} />
      <RecordField copy={false} label="Boundary" value={storage.boundary} />
      <RecordField copy={false} label="Immutability claim" value={storage.immutability} />
      <RecordField copy={false} label="Recovery manifest" usage={<>set with <code>KEEL_RECOVERY_MANIFEST_PATH</code></>} value={storage.source} />
      <RecordField copy={false} label="Read from" value={storage.basis === "database-location" ? "where Keel's database runs (no recovery manifest set)" : storage.basis === "recovery-manifest" ? "the recovery manifest" : null} />
      <RecordField copy={false} label="Manifest generated at" value={storage.generatedAt} />
      <RecordField copy={false} label="Certifies" value="nothing: configuration statement only" />
    </>
  );
}
