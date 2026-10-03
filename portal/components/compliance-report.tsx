import Link from "next/link";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import {
  captureSentence,
  changeLinkSentence,
  changesSentence,
  controlName,
  evidenceSentence,
  exceptionSentence,
  findingStatus,
  findingTone,
  findingTypes,
  immutabilitySentence,
  NOT_A_CERTIFICATION,
  orderFindings,
  planLinkSentence,
  storageSentence,
} from "@/lib/compliance-view";
import { ago, formatTimestamp } from "@/lib/presentation";
import type { ComplianceData, ComplianceFinding } from "@/lib/types";

// Roadmap task-87: control findings measured against the baseline, each linked to the
// changes, backup and pending restore that rest on the same collection (or shown as a
// mismatch), with its exception's owner, reason and expiry; and where backups are kept.
function FindingRecord({ finding }: { finding: ComplianceFinding }) {
  const { links } = finding;
  return (
    <TechnicalDetails>
      <RecordField label="Evaluation ID" value={finding.id} />
      <RecordField copy={false} label="Control ID" value={finding.controlId} />
      <RecordField copy={false} label="Verdict code" value={`${finding.verdict}${finding.reason ? ` · ${finding.reason}` : ""}`} />
      <RecordField copy={false} label="Framework" value={`${finding.framework} · edition ${finding.edition} · profile ${finding.profile} · evaluator v${finding.evaluatorVersion}`} />
      <RecordField copy={false} label="Evaluated at" value={finding.evaluatedAt} />
      {finding.evidenceSeq ? <RecordField label="Evidence sequence" usage={<>use with <code>GET /api/evidence</code></>} value={finding.evidenceSeq} /> : null}
      {finding.evidence.map((entry) => (
        <RecordField
          copy={false}
          key={`${entry.resourceType}-${entry.window.startedAt}`}
          label={`Observation window · ${entry.resourceType}`}
          value={`${entry.window.startedAt ?? "unknown"} → ${entry.window.endedAt ?? "unknown"} · snapshot ${entry.snapshotId ?? "no match"}`}
        />
      ))}
      {links.change.linked.map((change) => (
        <RecordField key={change.id} label="Linked drift ID" value={`${change.id} · ${change.naturalKey} · snapshot ${change.snapshotId}`} />
      ))}
      {links.change.mismatched.map((change) => (
        <RecordField key={change.id} label="Mismatched drift ID" value={`${change.id} · ${change.naturalKey} · snapshot ${change.snapshotId}`} />
      ))}
      {[...links.restorePlan.linked.map((plan) => ["Linked", plan] as const), ...links.restorePlan.mismatched.map((plan) => ["Mismatched", plan] as const)].map(([kind, plan]) => (
        <RecordField
          key={plan.requestId}
          label={`${kind} restore dry run ID`}
          usage={<>approval request {plan.requestId} · snapshot {plan.snapshotId}</>}
          value={plan.dryRunId}
        />
      ))}
      {finding.exception ? (
        <>
          <RecordField label="Exception ID" value={finding.exception.id} />
          <RecordField copy={false} label="Exception" value={`state ${finding.exceptionState} · owner ${finding.exception.owner ?? "none"} · granted by ${finding.exception.grantedBy ?? "unknown"} at ${finding.exception.grantedAt ?? "unknown"} · expires ${finding.exception.expiresAt ?? "never set"}`} />
        </>
      ) : null}
    </TechnicalDetails>
  );
}

export function ComplianceReport({ data, now }: { data: ComplianceData; now: string }) {
  const findings = orderFindings(data.findings);
  const baseline = data.activeBaseline;
  const { storage } = data;
  return (
    <>
      <section aria-labelledby="compliance-baseline-heading" className="report-section">
        <div className="section-heading-row report-heading">
          <div>
            <p className="section-kicker">Measured against</p>
            <h2 id="compliance-baseline-heading">
              {baseline ? `Baseline “${baseline.label ?? "Unnamed baseline"}”` : "No active baseline"}
            </h2>
          </div>
          <Link className="text-link" href="/baselines">All baselines</Link>
        </div>
        {baseline ? (
          <p>
            {captureSentence(baseline.capture, now)} {changesSentence(baseline.changesSinceCapture)}
          </p>
        ) : (
          <p className="empty-state">No baseline is active, so findings cannot be compared with how the tenant should look.</p>
        )}
      </section>

      <section aria-labelledby="compliance-findings-heading" className="report-section">
        <div className="section-heading-row report-heading">
          <div>
            <p className="section-kicker">Newest check of each control</p>
            <h2 id="compliance-findings-heading">Findings</h2>
          </div>
          <span className="result-count">
            {findings.length} {findings.length === 1 ? "control" : "controls"}
          </span>
        </div>
        {findings.length ? (
          <ul className="item-list finding-list">
            {findings.map((finding) => {
              const exception = exceptionSentence(finding, now);
              const change = changeLinkSentence(finding);
              const plan = planLinkSentence(finding);
              return (
                <li className={`item-card finding-card${finding.exposed ? " finding-open" : ""}`} key={finding.id}>
                  <div className="item-card-head">
                    <h3>{controlName(finding)}</h3>
                    <span className={`pill ${findingTone(finding)}`}>{findingStatus(finding)}</span>
                  </div>
                  <p>
                    Checks {findingTypes(finding)}.{" "}
                    Checked <time dateTime={finding.evaluatedAt ?? undefined} title={formatTimestamp(finding.evaluatedAt)}>{ago(finding.evaluatedAt, now)}</time>.
                  </p>
                  {exception ? <p className={finding.exposed ? "finding-exception finding-exception-open" : "finding-exception"}>{exception}</p> : null}
                  <p>{evidenceSentence(finding, now)}</p>
                  {change ? <p>{change} <Link className="text-link" href="/drift">Review changes</Link></p> : null}
                  {plan ? <p>{plan} <Link className="text-link" href="/approvals">Open approvals</Link></p> : null}
                  <FindingRecord finding={finding} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="empty-state">No control has been checked on this tenant yet.</p>
        )}
      </section>

      <section aria-labelledby="compliance-storage-heading" className="report-section">
        <div className="section-heading-row report-heading">
          <div>
            <p className="section-kicker">Where backups are kept</p>
            <h2 id="compliance-storage-heading">Storage location</h2>
          </div>
        </div>
        <p>{storageSentence(storage)} {storage.configured ? immutabilitySentence(storage) : null}</p>
        <p className="capture-note">{NOT_A_CERTIFICATION}</p>
        <TechnicalDetails>
          <RecordField copy={false} label="Provider code" value={storage.provider} />
          <RecordField copy={false} label="Region" value={storage.region} />
          <RecordField copy={false} label="Boundary" value={storage.boundary} />
          <RecordField copy={false} label="Immutability claim" value={storage.immutability} />
          <RecordField copy={false} label="Recovery manifest" usage={<>set with <code>KEEL_RECOVERY_MANIFEST_PATH</code></>} value={storage.source} />
          <RecordField copy={false} label="Manifest generated at" value={storage.generatedAt} />
          <RecordField copy={false} label="Certifies" value="nothing: configuration statement only" />
        </TechnicalDetails>
      </section>
    </>
  );
}
