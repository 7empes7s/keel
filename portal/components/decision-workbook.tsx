import type { ReactNode } from "react";

import { attributionSummary } from "@/components/change-attribution";
import { DecisionStyles } from "@/components/decision-styles";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ago, displayEnum, formatTimestamp } from "@/lib/presentation";
import {
  approvalSentence, baselineSentence, findingSentence, ownerSentence, planSentence, seenSentence,
} from "@/lib/semantic-drift";
import type { ChangeAttribution, ChangeEvidence, DriftRecord, SemanticSummary } from "@/lib/types";

// engine/govern/semanticDrift.mjs MAX_EVIDENCE_CHANGES: changes whose records are read at once.
const MAX_LINKED = 200;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// Roadmap task-98: the Changes page's decision summary. Every open change is in exactly
// one impact row, so the rows add up to the total shown beneath them.
export function DecisionWorkbook({ summary }: { summary: SemanticSummary }) {
  if (summary.total === 0) return null;
  const notes = [
    summary.mismatched ? `${plural(summary.mismatched, "change rests", "changes rest")} on records that do not match each other. Each one says which.` : null,
    summary.unknownBefore ? `${plural(summary.unknownBefore, "change has", "changes have")} no copy in the approved setup, so earlier values are not known.` : null,
    summary.cosmeticOnly ? `${plural(summary.cosmeticOnly, "change touches", "changes touch")} only settings Microsoft manages itself.` : null,
    summary.emptyOrOrderOnly ? `${plural(summary.emptyOrOrderOnly, "change differs", "changes differ")} only in empty values or the order of a list.` : null,
  ].filter((note): note is string => note !== null);
  return (
    <section aria-labelledby="decision-workbook-heading" className="report-section decision-workbook">
      <DecisionStyles />
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Decide</p>
          <h2 id="decision-workbook-heading">What the open changes affect</h2>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table decision-table">
          <caption className="visually-hidden">Open changes by impact</caption>
          <thead>
            <tr>
              <th scope="col">Impact</th>
              <th scope="col">Changes</th>
              <th scope="col">Settings that change behaviour</th>
            </tr>
          </thead>
          <tbody>
            {summary.byImpact.map((group) => (
              <tr key={group.blastRadius}>
                <th data-label="Impact" scope="row">{displayEnum("blastRadius", group.blastRadius)}</th>
                <td data-label="Changes">{group.changes}</td>
                <td data-label="Settings that change behaviour">{group.settings}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th data-label="Impact" scope="row">All open changes</th>
              <td data-label="Changes">{summary.total}</td>
              <td data-label="Settings that change behaviour">{summary.behaviouralSettings + summary.fixedSettings}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {notes.length ? <ul className="decision-notes">{notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
    </section>
  );
}

function When({ at, now }: { at: string | null; now: string }) {
  if (!at) return null;
  return <> <time dateTime={at} title={formatTimestamp(at)}>{ago(at, now)}</time></>;
}

function Row({ label, mismatch = false, children }: { label: string; mismatch?: boolean; children: ReactNode }) {
  return (
    <div className={`decision-row${mismatch ? " decision-row-mismatch" : ""}`}>
      <dt>{label}{mismatch ? <span className="decision-mismatch"> · does not match</span> : null}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// The records one decision rests on, each with whether it matches the others.
// Why the records behind a change are missing, and what to do about it.
const GAP_WORDS: Record<NonNullable<DriftRecord["evidenceGap"]>, { why: string; next: string }> = {
  "read-failed": { why: "Keel could not read its own records just now.", next: "Reload the page to try again. The comparison above is still correct." },
  "over-limit": { why: `There are too many open changes: Keel reads the records of the ${MAX_LINKED} riskiest first, and this one is not among them.`, next: "Accept, undo or ignore the changes you have checked; this one's records show once fewer are open. The comparison above is still correct." },
  "not-found": { why: "This change was settled or replaced after the page loaded.", next: "Reload the page to see where it stands now." },
};

export function ChangeEvidencePanel({ evidence, attribution, now, gap }: { evidence: ChangeEvidence | null | undefined; attribution: ChangeAttribution | null | undefined; now: string; gap?: DriftRecord["evidenceGap"] }) {
  if (!evidence) {
    const words = GAP_WORDS[gap ?? "read-failed"];
    return (
      <section aria-label="What this decision rests on" className="decision-evidence">
        <DecisionStyles />
        <h3 className="decision-heading">What this decision rests on</h3>
        <p className="decision-gap" role="note"><strong>{words.why}</strong> {words.next}</p>
      </section>
    );
  }
  return (
    <section aria-label="What this decision rests on" className="decision-evidence">
      <DecisionStyles />
      <h3 className="decision-heading">What this decision rests on</h3>
      {evidence.mismatches > 0 ? (
        <p className="decision-mismatch-note" role="note">
          {plural(evidence.mismatches, "record does", "records do")} not match the others. Check before you decide.
        </p>
      ) : null}
      <dl className="decision-list">
        <Row label="Owner">{ownerSentence(evidence.ownership)}</Row>
        <Row label="Who made it">
          {attribution ? attributionSummary(attribution) : "Keel could not check who made this change."}
        </Row>
        <Row label="Found by" mismatch={evidence.observation.state === "mismatch"}>
          {seenSentence(evidence)}<When at={evidence.observation.at} now={now} />
        </Row>
        <Row label="Approved setup copy" mismatch={evidence.backup.state === "mismatch"}>
          {baselineSentence(evidence)}
          {evidence.backup.at ? <> Taken<When at={evidence.backup.at} now={now} />.</> : null}
        </Row>
        <Row label="Compliance" mismatch={evidence.findings.some((finding) => finding.link === "mismatch")}>
          {evidence.findings.length ? (
            <ul className="decision-items">
              {evidence.findings.map((finding) => <li key={finding.evaluationId}>{findingSentence(finding)}</li>)}
            </ul>
          ) : "No compliance check cites this change."}
          {evidence.findings.length ? <> <a className="text-link" href="/benchmarks">Open compliance</a></> : null}
        </Row>
        <Row label="Approval">
          {evidence.approvals.length ? (
            <ul className="decision-items">
              {evidence.approvals.map((approval) => <li key={approval.id}>{approvalSentence(approval)}</li>)}
            </ul>
          ) : "Nobody has asked to roll this back."}
          {evidence.approvals.length ? <> <a className="text-link" href="/approvals">Open approvals</a></> : null}
        </Row>
        <Row label="Roll-back plan and result" mismatch={evidence.plans.some((plan) => plan.link === "mismatch")}>
          {evidence.plans.length ? (
            <ul className="decision-items">
              {evidence.plans.map((plan) => (
                <li key={plan.id}>
                  {planSentence(plan)}
                  {plan.approvals.map((approval) => <span key={approval.id}> {approvalSentence(approval)}</span>)}
                </li>
              ))}
            </ul>
          ) : "No roll-back plan covers this change yet. A queued request is not a result."}
        </Row>
      </dl>
      <TechnicalDetails summary="Technical details: linked records">
        <RecordField copy={false} label="Ownership" value={`${evidence.ownership.state}${evidence.ownership.entityCode ? ` · ${evidence.ownership.entityCode}` : ""}${evidence.ownership.sharedWith.length ? ` · shared ${evidence.ownership.sharedWith.join(", ")}` : ""}${evidence.ownership.othersWithheld ? " · others withheld" : ""}`} />
        <RecordField label="Observed backup ID" usage={`${evidence.observation.state}${evidence.observation.versionId ? ` · version ${evidence.observation.versionId}` : ""}`} value={evidence.observation.snapshotId} />
        <RecordField label="Approved setup backup ID" usage={`${evidence.backup.state}${evidence.backup.versionId ? ` · version ${evidence.backup.versionId}` : ""}`} value={evidence.backup.snapshotId} />
        {evidence.findings.map((finding) => (
          <RecordField key={`finding-${finding.evaluationId}`} label={`Evaluation ID · ${finding.controlId}`} usage={`${finding.verdict} · ${finding.link}`} value={finding.evaluationId} />
        ))}
        {evidence.approvals.map((approval) => (
          <RecordField key={`approval-${approval.id}`} label={`Approval request ID · ${approval.action}`} usage={`${approval.status}${approval.job ? ` · job ${approval.job.id} ${approval.job.status}` : ""}`} value={approval.id} />
        ))}
        {evidence.plans.map((plan) => (
          <RecordField key={`plan-${plan.id}`} label="Dry-run ID" usage={`${plan.status} · ${plan.link} · backup ${plan.snapshotId}${plan.outcome ? ` · outcome ${plan.outcome.state}` : ""}${plan.approvals.map((approval) => ` · request ${approval.id} ${approval.status}`).join("")}`} value={plan.id} />
        ))}
      </TechnicalDetails>
    </section>
  );
}
