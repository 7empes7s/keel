import Link from "next/link";
import type { ReactNode } from "react";

import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { formatTimestamp } from "@/lib/presentation";
import {
  FINDING_STATE_LABELS,
  FINDING_STATE_ORDER,
  NO_COMPLIANCE_CLAIM,
  OUTCOME_STATE_LABELS,
  OUTCOME_STATE_ORDER,
  PERIODS,
  estimateNote,
  findingSentence,
  freshnessSentence,
  hoursRow,
  hoursSentence,
  isWithheld,
  outcomeName,
  outcomeReason,
  outcomeSentence,
  percentText,
  recoverySentence,
  scopeSentence,
  type PeriodKey,
  type ValueReportData,
} from "@/lib/value-report-view";

// Roadmap task-100: the value report's explanation and record layers. Counts are shown
// with what they are made of; hours appear only from a configured estimate, next to its
// assumptions; identifiers and codes stay under "Technical details".

const CSS = `
.value-report { display: grid; gap: var(--space-lg); }
.value-controls { display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: center; justify-content: space-between; }
.value-periods, .value-exports { display: flex; flex-wrap: wrap; gap: var(--space-xs); margin: 0; padding: 0; list-style: none; }
.value-sentence { margin: 0; }
.value-table-wrap { max-width: 100%; overflow-x: auto; }
.value-table { max-width: 48rem; }
.value-table td.value-number, .value-table th.value-number { text-align: right; font-variant-numeric: tabular-nums; }
.value-table tfoot th, .value-table tfoot td { font-weight: 600; border-top: 1px solid var(--line-strong); }
.value-list { margin: 0; padding-left: var(--space-lg); display: grid; gap: var(--space-2xs); }
.value-capped { margin: 0; color: var(--text-soft); }
`;

type Tone = "ok" | "warn" | "bad";

function Card({ id, title, pill, children }: { id: string; title: string; pill?: { tone: Tone; label: string }; children: ReactNode }) {
  return (
    <section aria-labelledby={`value-${id}-heading`} className={`item-card value-card value-card-${id}`}>
      <div className="item-card-head">
        <h2 id={`value-${id}-heading`}>{title}</h2>
        {pill ? <span className={`pill pill-${pill.tone}`}>{pill.label}</span> : null}
      </div>
      {children}
    </section>
  );
}

function query(period: PeriodKey, entity: string | null, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ period, ...(entity ? { entity } : {}), ...extra });
  return params.toString();
}

const CLI = "node cli/keel-value-report.mjs";

export function ValueReportView({ data }: { data: ValueReportData }) {
  const { report, period, entity } = data;
  const { outcomes, findings, recovery, hoursSaved } = report;
  const shownFindings = isWithheld(findings) ? null : findings;
  const shownRecovery = isWithheld(recovery) ? null : recovery;
  return (
    <div className="value-report">
      <style href="keel-value-report" precedence="default">{CSS}</style>
      <div className="value-controls">
        <nav aria-label="Report period">
          <ul className="value-periods">
            {(Object.keys(PERIODS) as PeriodKey[]).map((key) => (
              <li key={key}>
                <Link aria-current={key === period ? "page" : undefined} className={`btn btn-sm ${key === period ? "btn-primary" : "btn-ghost"}`} href={`/reports?${query(key, entity)}`}>
                  {PERIODS[key].label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <ul aria-label="Download this report" className="value-exports">
          <li><a className="btn btn-sm btn-ghost" download href={`/api/reports/value?${query(period, entity, { format: "csv" })}`}>Download spreadsheet (CSV)</a></li>
          <li><a className="btn btn-sm btn-ghost" download href={`/api/reports/value?${query(period, entity, { format: "json" })}`}>Download data (JSON)</a></li>
        </ul>
      </div>
      <p className="field-help value-scope">
        {formatTimestamp(report.period.from)} to {formatTimestamp(report.period.to)}. {scopeSentence(report)}
        {!report.provenance.complete ? " This period has more records than one report reads, so the counts are incomplete." : ""}
      </p>

      <Card id="outcomes" pill={outcomes.total ? { tone: outcomes.states.failed || outcomes.states.reopened ? "warn" : "ok", label: `${percentText(outcomes.percentVerified)} checked` } : { tone: "ok", label: "None" }} title="Settings put back">
        <p className="value-sentence">{outcomeSentence(outcomes)}</p>
        <div className="value-table-wrap">
          <table className="data-table value-table value-summary">
            <caption className="visually-hidden">Results by state</caption>
            <thead>
              <tr><th scope="col">Result</th><th className="value-number" scope="col">Restores</th><th className="value-number" scope="col">Undone changes</th><th className="value-number" scope="col">Total</th></tr>
            </thead>
            <tbody>
              {OUTCOME_STATE_ORDER.map((state) => (
                <tr data-state={state} key={state}>
                  <th scope="row">{OUTCOME_STATE_LABELS[state]}</th>
                  <td className="value-number">{outcomes.byFamily.restore.states[state]}</td>
                  <td className="value-number">{outcomes.byFamily.remediation.states[state]}</td>
                  <td className="value-number">{outcomes.states[state]}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">All</th>
                <td className="value-number">{outcomes.byFamily.restore.total}</td>
                <td className="value-number">{outcomes.byFamily.remediation.total}</td>
                <td className="value-number value-total">{outcomes.total}</td>
              </tr>
              <tr>
                <th scope="row">Tries</th>
                <td className="value-number">{outcomes.byFamily.restore.attempts}</td>
                <td className="value-number">{outcomes.byFamily.remediation.attempts}</td>
                <td className="value-number">{outcomes.attempts}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="field-help">Each restore or undo request counts once, however many times it was tried. Only results checked afterwards count as put back.</p>
        {outcomes.rows.length ? (
          <div className="value-table-wrap">
            <table className="data-table value-table value-outcomes">
              <caption className="visually-hidden">Each request in this period</caption>
              <thead>
                <tr><th scope="col">Request</th><th scope="col">Result</th><th className="value-number" scope="col">Tries</th><th scope="col">Last activity</th></tr>
              </thead>
              <tbody>
                {outcomes.rows.map((row) => (
                  <tr data-state={row.state} key={row.id}>
                    <td>{outcomeName(row)}</td>
                    <td>{OUTCOME_STATE_LABELS[row.state]}: {outcomeReason(row.reason)}</td>
                    <td className="value-number">{row.attempts}</td>
                    <td>{formatTimestamp(row.verifiedAt ?? row.reopenedAt ?? row.lastEventAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {outcomes.rowsShown < outcomes.total ? <p className="value-capped">Showing {outcomes.rowsShown} of {outcomes.total}. The download has the same totals.</p> : null}
        <p className="field-help"><Link href="/activity">See every job in Activity</Link></p>
        <TechnicalDetails>
          <RecordField copy={false} label="Requests" value={outcomes.total} />
          <RecordField copy={false} label="Tries" value={outcomes.attempts} />
          <RecordField copy={false} label="Retries" value={outcomes.retries} />
          <RecordField copy={false} label="Counted by state" value={outcomes.states} />
          <RecordField copy={false} label="Rows shown" usage={`of ${outcomes.total}`} value={outcomes.rowsShown} />
          {outcomes.undoRunsExcluded !== null ? <RecordField copy={false} label="Undo runs not counted" value={outcomes.undoRunsExcluded} /> : null}
          {outcomes.rows.map((row) => (
            <RecordGroup key={row.id} note={`${row.family}, ${row.state}`} title={outcomeName(row)}>
              <RecordField label="Outcome ID" value={row.id} />
              <RecordField copy={false} label="Family" value={row.family} />
              <RecordField copy={false} label="State" value={row.state} />
              <RecordField copy={false} label="Reason" value={row.reason} />
              <RecordField copy={false} label="Tries" value={row.attempts} />
              <RecordField copy={false} label="Retries" value={row.retries} />
              <RecordField copy={false} label="First requested" value={row.firstRequestedAt} />
              <RecordField copy={false} label="Last event" value={row.lastEventAt} />
              <RecordField copy={false} label="Verified" value={row.verifiedAt} />
              <RecordField copy={false} label="Reopened" value={row.reopenedAt} />
              <RecordField copy={false} label="Resources" value={row.resources} />
              <RecordField copy={false} label="Resource type" value={row.resourceType} />
              <RecordField copy={false} label="Change type" value={row.changeType} />
              <RecordField label="Plan ID" value={row.planId} />
              <RecordField label="Drift ID" value={row.driftId} />
              {row.attemptEventIds.map((eventId, index) => (
                <RecordField key={eventId} label={`Try ${index + 1} (event ID)`} usage={<><code>GET /api/jobs/&lt;id&gt;</code></>} value={eventId} />
              ))}
            </RecordGroup>
          ))}
        </TechnicalDetails>
      </Card>

      <Card id="findings" pill={shownFindings ? (shownFindings.total ? { tone: shownFindings.states.open ? "warn" : "ok", label: `${percentText(shownFindings.percentResolved)} fixed` } : { tone: "ok", label: "None failing" }) : { tone: "warn", label: "Whole tenant only" }} title="Control findings">
        <p className="value-sentence">{findingSentence(findings)}</p>
        {shownFindings && shownFindings.total ? (
          <>
            <div className="value-table-wrap">
              <table className="data-table value-table value-findings">
                <caption className="visually-hidden">Control findings by state</caption>
                <thead><tr><th scope="col">State</th><th className="value-number" scope="col">Controls</th></tr></thead>
                <tbody>
                  {FINDING_STATE_ORDER.map((state) => (
                    <tr data-state={state} key={state}><th scope="row">{FINDING_STATE_LABELS[state]}</th><td className="value-number">{shownFindings.states[state]}</td></tr>
                  ))}
                </tbody>
                <tfoot><tr><th scope="row">All</th><td className="value-number">{shownFindings.total}</td></tr></tfoot>
              </table>
            </div>
            <p className="field-help">A control counts as fixed only while its newest check passes. An exception does not fix it. <Link href="/benchmarks">Open Compliance</Link></p>
            <TechnicalDetails>
              <RecordField copy={false} label="Reopened controls" value={shownFindings.reopened} />
              <RecordField copy={false} label="Rows shown" usage={`of ${shownFindings.total}`} value={shownFindings.rowsShown} />
              {shownFindings.rows.map((row) => (
                <RecordGroup key={row.id} note={row.reopened ? `${row.state}, reopened` : row.state} title={`Control ${row.controlId}`}>
                  <RecordField label="Finding ID" value={row.id} />
                  <RecordField label="Control ID" value={row.controlId} />
                  <RecordField copy={false} label="Framework" value={row.framework} />
                  <RecordField copy={false} label="Edition" value={row.edition} />
                  <RecordField copy={false} label="Profile" value={row.profile} />
                  <RecordField copy={false} label="State" value={row.state} />
                  <RecordField copy={false} label="Reopened" value={row.reopened} />
                  <RecordField copy={false} label="Failed at" value={row.failedAt} />
                  <RecordField copy={false} label="Resolved at" value={row.resolvedAt} />
                  <RecordField label="Fixed by evaluation ID" value={row.resolvedBy?.evaluationId} />
                  <RecordField label="Fixed by evidence sequence" value={row.resolvedBy?.evidenceSeq} />
                  <RecordField copy={false} label="Newest verdict" value={row.lastVerdict} />
                  <RecordField copy={false} label="Newest check" value={row.lastEvaluatedAt} />
                  <RecordField label="Newest evaluation ID" value={row.lastEvaluationId} />
                </RecordGroup>
              ))}
            </TechnicalDetails>
          </>
        ) : null}
      </Card>

      <Card id="recovery" pill={shownRecovery ? (shownRecovery.recoveryTime.state === "measured" ? { tone: "ok", label: "Measured" } : { tone: "warn", label: "Not measured" }) : { tone: "warn", label: "Whole tenant only" }} title="Recovery measured">
        <p className="value-sentence">{recoverySentence(recovery)}</p>
        {shownRecovery ? (
          <>
            <p className="value-sentence">{freshnessSentence(shownRecovery)}</p>
            {shownRecovery.recoveryTime.notCounted ? <p className="field-help">{shownRecovery.recoveryTime.notCounted} other {shownRecovery.recoveryTime.notCounted === 1 ? "try was" : "tries were"} not counted because {shownRecovery.recoveryTime.notCounted === 1 ? "it" : "they"} failed or {shownRecovery.recoveryTime.notCounted === 1 ? "was" : "were"} not checked.</p> : null}
            <p className="field-help"><Link href="/resilience">Open Resilience</Link></p>
            <TechnicalDetails>
              <RecordGroup note={shownRecovery.recoveryTime.state} title="Recovery time">
                <RecordField copy={false} label="Samples" value={shownRecovery.recoveryTime.samples} />
                <RecordField copy={false} label="From drills" value={shownRecovery.recoveryTime.drills} />
                <RecordField copy={false} label="From restores" value={shownRecovery.recoveryTime.restores} />
                <RecordField copy={false} label="Not counted" value={shownRecovery.recoveryTime.notCounted} />
                <RecordField copy={false} label="Median (ms)" value={shownRecovery.recoveryTime.medianMs ?? "unmeasured"} />
                <RecordField copy={false} label="Slowest (ms)" value={shownRecovery.recoveryTime.worstMs ?? "unmeasured"} />
              </RecordGroup>
              <RecordGroup note={shownRecovery.freshness.state} title="Backup freshness">
                <RecordField copy={false} label="Achieved recovery point age (ms)" value={shownRecovery.freshness.achievedRpoMs ?? "unmeasured"} usage={<>from <code>node cli/keel-recovery-metrics.mjs report</code></>} />
                <RecordField copy={false} label="Never backed up" value={shownRecovery.freshness.gaps} />
                <RecordField copy={false} label="As of" value={shownRecovery.freshness.asOf} />
              </RecordGroup>
              <RecordGroup note={shownRecovery.recoverablePoint.state} title="Off-site recoverable point">
                <RecordField copy={false} label="Age (ms)" value={shownRecovery.recoverablePoint.ageMs ?? "unmeasured"} />
                <RecordField copy={false} label="As of" value={shownRecovery.recoverablePoint.asOf} />
              </RecordGroup>
            </TechnicalDetails>
          </>
        ) : null}
      </Card>

      <Card id="hours" pill={hoursSaved ? { tone: "ok", label: "Estimate" } : { tone: "warn", label: "No estimate set" }} title="Time saved">
        {hoursSaved ? (
          <>
            <p className="value-sentence">{hoursSentence(hoursSaved)}</p>
            <ul className="value-list value-hours-list">
              {hoursSaved.byFamily.map((row) => <li key={row.family}>{hoursRow(row)}</li>)}
            </ul>
            <h3>Assumptions</h3>
            <ul className="value-list value-assumptions">
              {hoursSaved.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
            </ul>
            <p className="field-help">This is an estimate set by {hoursSaved.owner}{hoursSaved.setAt ? ` on ${formatTimestamp(hoursSaved.setAt)}` : ""}, not a measurement.</p>
          </>
        ) : <p className="value-sentence">{estimateNote(report)}</p>}
        <TechnicalDetails>
          <RecordField copy={false} label="Estimate state" value={report.estimate.state} />
          <RecordField label="Estimate file" value={report.estimate.source} usage={<>set with <code>KEEL_VALUE_ESTIMATE_PATH</code></>} />
          {(report.estimate.problems ?? []).map((problem, index) => <RecordField copy={false} key={`${index}:${problem}`} label="Estimate problem" value={problem} />)}
          {hoursSaved ? (
            <>
              <RecordField copy={false} label="Hours" value={hoursSaved.hours} />
              <RecordField copy={false} label="Basis" value={hoursSaved.basis} />
              <RecordField copy={false} label="Set by" value={hoursSaved.owner} />
              <RecordField copy={false} label="Set at" value={hoursSaved.setAt} />
              <RecordField copy={false} label="Not estimated" value={hoursSaved.notEstimated} />
              {hoursSaved.byFamily.map((row) => (
                <RecordGroup key={row.family} title={row.family}>
                  <RecordField copy={false} label="Verified" value={row.verified} />
                  <RecordField copy={false} label="Minutes each" value={row.minutesEach} />
                  <RecordField copy={false} label="Hours" value={row.hours} />
                </RecordGroup>
              ))}
            </>
          ) : null}
        </TechnicalDetails>
      </Card>

      <Card id="method" title="How this was counted">
        <p className="value-sentence">{NO_COMPLIANCE_CLAIM}</p>
        <ul className="value-list">
          <li>A restore or undo request counts once, however many times it was tried.</li>
          <li>Waiting, running, failed and cancelled tries never count as put back.</li>
          <li>Put back means checked afterwards: each setting read back and follow-up tasks closed, or a later backup showing the approved value.</li>
          <li>Something that changed again, or a control that failed again, is not counted as fixed.</li>
        </ul>
        <TechnicalDetails>
          <RecordField label="Report digest" value={report.provenance.digest} usage={<>reproduce with <code>{CLI} --from {report.period.from} --to {report.period.to}</code></>} />
          <RecordField copy={false} label="Report version" value={report.provenance.reportVersion} />
          <RecordField copy={false} label="Generated" value={report.generatedAt} />
          <RecordField copy={false} label="Every source read" value={report.provenance.complete} />
          <RecordField label="Tenant reference" value={report.tenantRef} />
          <RecordGroup title="Evidence chain head">
            <RecordField label="Sequence" usage={<><code>GET /api/evidence/verify</code></>} value={report.provenance.evidenceHead?.seq} />
            <RecordField label="Hash" value={report.provenance.evidenceHead?.hash} />
            <RecordField copy={false} label="Records" value={report.provenance.evidenceHead?.records} />
          </RecordGroup>
          <RecordGroup note={`${report.period.days} days`} title="Period">
            <RecordField copy={false} label="From" value={report.period.from} />
            <RecordField copy={false} label="To" value={report.period.to} />
          </RecordGroup>
          <RecordGroup title="Scope">
            <RecordField copy={false} label="Tenant-wide" value={report.scope.central} />
            {report.scope.central ? null : report.scope.entities.map((entity) => <RecordField key={entity} label="Entity" value={entity} />)}
          </RecordGroup>
          <RecordGroup title="Rows read">
            <RecordField copy={false} label="Restore jobs" value={report.provenance.sources.restoreJobsRead} />
            <RecordField copy={false} label="Remediate jobs" value={report.provenance.sources.remediateJobsRead} />
            <RecordField copy={false} label="Backups checked" value={report.provenance.sources.collectionsChecked} />
            <RecordField copy={false} label="Evaluations" value={report.provenance.sources.evaluationsRead} />
          </RecordGroup>
          {report.provenance.countingRules.map((rule, index) => <RecordField copy={false} key={`${index}:${rule}`} label={`Counting rule ${index + 1}`} value={rule} />)}
        </TechnicalDetails>
      </Card>
    </div>
  );
}
