import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ErrorNotice } from "@/components/ui/error-notice";
import { Badge } from "@/components/ui/badge";
import { formatTimestamp } from "@/lib/presentation";
import { heldBackSentence, serviceNowBadge, serviceNowSentence, stateValueWords } from "@/lib/integrations-view";
import type { ServiceNowStatus } from "@/lib/servicenow";

// Roadmap task-97: the ServiceNow approval mirror on the Integrations page. Whether it is
// on, every missing setting, how a ServiceNow decision counts, and updates held back
// after a failed write (the raw error behind "Show details"); table, field names, raw
// state values, secret names and record ids are in the record.

export const SERVICENOW_FIELD_LABELS: Record<string, string> = {
  state: "Field holding the approval state",
  approver: "Field naming who decided",
  planVersion: "Field KEEL writes the plan version to",
  planDigest: "Field KEEL writes the plan digest to",
  keelRequest: "Field KEEL writes its request ID to",
  keelDecision: "Field KEEL writes its decision to",
};

export function ServiceNowPanel({ status }: { status: ServiceNowStatus }) {
  const mapping = status.mapping;
  const badge = serviceNowBadge(status);
  return <section aria-labelledby="servicenow-heading" className="pg-panel" id="ig-servicenow">
    <div className="rs-section-head">
      <div>
        <h2 id="servicenow-heading"><Icon name="inbox" />ServiceNow change approvals</h2>
        <p className="rs-sub">Approvals can also be decided in ServiceNow.</p>
      </div>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </div>
    <div className="pg-card" data-tone={badge.tone}>
      <p className="servicenow-sentence">{serviceNowSentence(status)}</p>
      {status.configured && !status.enabled ? (
        <ul aria-label="Missing settings" className="pg-rows">
          {status.problems.map((problem) => <li key={problem.code}><Badge tone="soon">Missing</Badge><span>{problem.message}</span></li>)}
        </ul>
      ) : null}
      {status.enabled && mapping ? <>
        <dl className="pg-stats">
          <div><dt>Records linked</dt><dd>{status.mirror.records}</dd></div>
          <div data-tone={status.mirror.waiting ? "low" : undefined}><dt>Waiting for a decision</dt><dd>{status.mirror.waiting}</dd></div>
          <div><dt>Updates to send</dt><dd>{status.mirror.pendingUpdates}</dd></div>
          <div data-tone={status.mirror.heldBack > 0 ? "urgent" : "fine"}><dt>Held back</dt><dd>{status.mirror.heldBack}</dd></div>
          <div data-tone={status.mirror.conflicts > 0 ? "soon" : "fine"}><dt>Disagreements</dt><dd>{status.mirror.conflicts}</dd></div>
        </dl>
        <dl className="pg-facts">
          <div><dt>Instance</dt><dd>{mapping.instanceHost}</dd></div>
          <div><dt>Counts as approved</dt><dd className="pg-chips">{mapping.approvedValues.map((value) => <Badge key={value} tone="fine">{stateValueWords(value)}</Badge>)}</dd></div>
          <div><dt>Counts as rejected</dt><dd className="pg-chips">{mapping.rejectedValues.map((value) => <Badge key={value} tone="urgent">{stateValueWords(value)}</Badge>)}</dd></div>
          <div><dt>How KEEL hears back</dt><dd>{mapping.callbacks === "signed" ? "Signed calls, plus its own checks" : "Its own checks of each record"}</dd></div>
        </dl>
        <p className="pg-help"><Icon name="info" />Other states decide nothing. A decision counts only from someone who may approve it in KEEL, for the latest plan.</p>
      </> : null}
      {status.heldBack.length > 0 ? <div className="ui-alerts">{status.heldBack.map((event) => <ErrorNotice
        error={[`${formatTimestamp(event.createdAt)} · after ${event.attempts} ${event.attempts === 1 ? "attempt" : "attempts"}`, event.lastError ?? event.reason ?? null].filter(Boolean).join("\n")}
        id={`held-${event.eventId}`}
        key={event.eventId}
        service="ServiceNow"
        title={heldBackSentence(event)}
        todo="Nothing to do now: KEEL's decision stands. If more are held back, check the ServiceNow connection."
        tone="soon"
      />)}</div> : null}
      {status.configured ? <p className="pg-chips"><Badge tone="low">Not yet tested on a real ServiceNow</Badge></p> : null}
      <TechnicalDetails>
        <RecordField copy={false} label="Mapping API" usage={<>set with <code>PUT /api/integrations/servicenow</code>; check with <code>node tools/qualification/servicenow.mjs check --config &lt;file&gt;</code></>} value="GET /api/integrations/servicenow" />
        {mapping ? <>
          <RecordField copy={false} label="Instance" value={mapping.instanceHost} />
          <RecordField label="Table" value={mapping.table} />
          {Object.entries(SERVICENOW_FIELD_LABELS).map(([role, label]) => <RecordField key={role} label={label} value={mapping.fields[role] || "not set"} />)}
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
