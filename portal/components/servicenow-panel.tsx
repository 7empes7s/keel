import { RiskChip } from "@/components/baselines/parts";
import { BaselinesStyles } from "@/components/baselines/styles";
import { Icon } from "@/components/shell/icons";
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
  const tone = !status.configured ? null : !status.enabled || status.mirror.heldBack > 0 || status.mirror.conflicts > 0 ? "soon" : "fine";
  return <section aria-labelledby="servicenow-section-heading" className="pt-section">
    <BaselinesStyles />
    <div className="pt-section-head">
      <div><h2 id="servicenow-section-heading">Change approvals</h2><p>Where approvals can also be decided, besides KEEL.</p></div>
    </div>
    <div className="bl-card bl-current st-card">
      <div className="bl-current-head">
        <span aria-hidden="true" className="bl-kind-icon" data-tone={tone ?? undefined}><Icon name="link" /></span>
        <div className="bl-current-name">
          <h3 id="servicenow-heading">ServiceNow change approvals</h3>
          <p>{serviceNowSentence(status)}</p>
        </div>
        <RiskChip tone={status.enabled ? "fine" : null}>{status.enabled ? "On" : "Off"}</RiskChip>
      </div>
      {status.configured && !status.enabled ? <div className="st-card-part">
        <p className="bl-help">KEEL neither sends to nor reads from ServiceNow until these are filled in:</p>
        <ul className="st-problems">{status.problems.map((problem) => <li key={problem.code}><Icon name="clock" />{problem.message}</li>)}</ul>
      </div> : null}
      {status.enabled && mapping ? <>
        <dl className="bl-facts st-facts">
          <div className="bl-fact"><dt>Records linked</dt><dd>{status.mirror.records}</dd></div>
          <div className="bl-fact"><dt>Waiting for a decision</dt><dd>{status.mirror.waiting}</dd></div>
          <div className="bl-fact"><dt>Updates waiting to send</dt><dd>{status.mirror.pendingUpdates}</dd></div>
          <div className="bl-fact" data-tone={status.mirror.heldBack > 0 ? "soon" : undefined}><dt>Held back</dt><dd>{status.mirror.heldBack}</dd></div>
          <div className="bl-fact" data-tone={status.mirror.conflicts > 0 ? "soon" : undefined}><dt>Disagreements</dt><dd>{status.mirror.conflicts}</dd></div>
        </dl>
        <ul className="st-rules">
          <li><b>How a decision counts</b><span>Counts as approved: {mapping.approvedValues.map(stateValueWords).join(", ")}. Counts as rejected: {mapping.rejectedValues.map(stateValueWords).join(", ")}. Any other state decides nothing.</span></li>
          <li><b>Who can decide</b><span>A ServiceNow decision counts only from a person linked to KEEL who may approve that request in KEEL now, and only for the plan KEEL last sent.</span></li>
          <li><b>How KEEL hears back</b><span>{mapping.callbacks === "signed"
            ? "ServiceNow calls KEEL with a signed message; KEEL reads the record back before it counts. KEEL also checks each waiting record, so a lost call is caught."
            : "ServiceNow does not call KEEL; KEEL checks each waiting record instead."}</span></li>
        </ul>
      </> : null}
      {status.heldBack.length > 0 ? <ul className="st-problems">{status.heldBack.map((event) => <li key={event.eventId}>
        <Icon name="clock" /><span>{heldBackSentence(event)} <time dateTime={event.createdAt} title={event.createdAt}>{formatTimestamp(event.createdAt)}</time></span>
      </li>)}</ul> : null}
      {status.configured ? <p className="bl-help">Not yet proven against a real ServiceNow instance.</p> : null}
    </div>
    <TechnicalDetails summary="Technical details for ServiceNow">
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
  </section>;
}
