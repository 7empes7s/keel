import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { formatTimestamp } from "@/lib/presentation";
import { heldBackSentence, serviceNowSentence, stateValueWords } from "@/lib/integrations-view";
import type { ServiceNowStatus } from "@/lib/servicenow";

// Roadmap task-97: the ServiceNow approval mirror on the Integrations page. Whether it is
// on, every missing setting in words, how a ServiceNow decision counts, and updates held
// back after a failed write; table, field names, raw state values, secret names and
// record ids are in the record.

const FIELD_LABELS: Record<string, string> = {
  state: "Field holding the approval state",
  approver: "Field naming who decided",
  planVersion: "Field KEEL writes the plan version to",
  planDigest: "Field KEEL writes the plan digest to",
  keelRequest: "Field KEEL writes its request ID to",
  keelDecision: "Field KEEL writes its decision to",
};

export function ServiceNowPanel({ status }: { status: ServiceNowStatus }) {
  const mapping = status.mapping;
  return <section aria-labelledby="servicenow-heading" className="report-section">
    <div className="section-heading-row report-heading">
      <div><p className="section-kicker">Where approvals can also be decided</p><h2 id="servicenow-heading">ServiceNow change approvals</h2></div>
      <span className={status.enabled ? "active-indicator" : "inactive-indicator"}>{status.enabled ? "On" : "Off"}</span>
    </div>
    <div className="item-card">
      <p>{serviceNowSentence(status)}</p>
      {status.configured && !status.enabled ? <>
        <p>KEEL neither sends to nor reads from ServiceNow until these are filled in:</p>
        <ul className="quarantine-list">{status.problems.map((problem) => <li key={problem.code}>{problem.message}</li>)}</ul>
      </> : null}
      {status.enabled && mapping ? <>
        <p>Counts as approved: {mapping.approvedValues.map(stateValueWords).join(", ")}. Counts as rejected: {mapping.rejectedValues.map(stateValueWords).join(", ")}. Any other state decides nothing.</p>
        <p>A ServiceNow decision counts only from a person linked to KEEL who may approve that request in KEEL now, and only for the plan KEEL last sent.</p>
        <p>{mapping.callbacks === "signed"
          ? "ServiceNow calls KEEL with a signed message; KEEL reads the record back before it counts. KEEL also checks each waiting record, so a lost call is caught."
          : "ServiceNow does not call KEEL; KEEL checks each waiting record instead."}</p>
        <dl className="stat-strip">
          <div><dt>Records linked</dt><dd>{status.mirror.records}</dd></div>
          <div><dt>Waiting for a decision</dt><dd>{status.mirror.waiting}</dd></div>
          <div><dt>Updates waiting to send</dt><dd>{status.mirror.pendingUpdates}</dd></div>
          <div className={status.mirror.heldBack > 0 ? "stat-warn" : undefined}><dt>Held back</dt><dd>{status.mirror.heldBack}</dd></div>
          <div className={status.mirror.conflicts > 0 ? "stat-warn" : undefined}><dt>Disagreements</dt><dd>{status.mirror.conflicts}</dd></div>
        </dl>
      </> : null}
      {status.heldBack.length > 0 ? <ul className="quarantine-list">{status.heldBack.map((event) => <li key={event.eventId}>
        {heldBackSentence(event)} <time dateTime={event.createdAt} title={event.createdAt}>{formatTimestamp(event.createdAt)}</time>
      </li>)}</ul> : null}
      {status.configured ? <p className="field-help">Not yet proven against a real ServiceNow instance.</p> : null}
      <TechnicalDetails>
        <RecordField copy={false} label="Mapping API" usage={<>set with <code>PUT /api/integrations/servicenow</code>; check with <code>node tools/qualification/servicenow.mjs check --config &lt;file&gt;</code></>} value="GET /api/integrations/servicenow" />
        {mapping ? <>
          <RecordField copy={false} label="Instance" value={mapping.instanceHost} />
          <RecordField label="Table" value={mapping.table} />
          {Object.entries(FIELD_LABELS).map(([role, label]) => <RecordField key={role} label={label} value={mapping.fields[role] || "not set"} />)}
          <RecordField copy={false} label="Approved state values" value={JSON.stringify(mapping.approvedValues)} />
          <RecordField copy={false} label="Rejected state values" value={JSON.stringify(mapping.rejectedValues)} />
          <RecordField label="Access token (stored secret name)" value={mapping.tokenRef} />
          <RecordField label="Callback signing secret (stored secret name)" value={mapping.callbackSecretRef} />
        </> : null}
        {status.problems.map((problem) => <RecordField copy={false} key={problem.code} label="Missing setting code" value={problem.code} />)}
        {status.heldBack.map((event) => <RecordField copy={false} key={event.eventId} label="Held-back event" value={`${event.eventId} · record sys_id ${event.externalRef} · ${event.reason ?? "no reason"} · ${event.lastError ?? "no error text"}`} />)}
        <RecordField copy={false} label="Proof" value={`fixture-tested against a simulated instance; live qualification is task-118. API contract: ${status.docSource.url} (retrieved ${status.docSource.retrievedAt})`} />
        {status.updatedAt ? <RecordField copy={false} label="Mapping saved" value={`${status.updatedAt} by ${status.updatedBy ?? "unknown"}`} /> : null}
      </TechnicalDetails>
    </div>
  </section>;
}
