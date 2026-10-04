import Link from "next/link";
import type { ReactNode } from "react";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
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
          {outcomes.rows.map((row) => (
            <RecordField
              key={row.id}
              label={`Outcome · ${row.state}`}
              value={`${row.id} · attempts ${row.attemptEventIds.join(", ")}`}
              usage={<><code>GET /api/jobs/&lt;id&gt;</code></>}
            />
          ))}
          {outcomes.undoRunsExcluded !== null ? <RecordField copy={false} label="Undo runs not counted" value={String(outcomes.undoRunsExcluded)} /> : null}
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
              {shownFindings.rows.map((row) => (
                <RecordField
                  key={row.id}
                  label={`Control ${row.controlId} · ${row.state}${row.reopened ? " · reopened" : ""}`}
                  value={`${row.framework} ${row.edition} ${row.profile} · last ${row.lastVerdict} ${row.lastEvaluatedAt ?? "unknown"}${row.resolvedBy ? ` · fixed by evaluation ${row.resolvedBy.evaluationId}${row.resolvedBy.evidenceSeq ? ` (evidence ${row.resolvedBy.evidenceSeq})` : ""}` : ""}`}
                />
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
              <RecordField copy={false} label="Recovery time samples" value={`${shownRecovery.recoveryTime.samples} (drills ${shownRecovery.recoveryTime.drills}, restores ${shownRecovery.recoveryTime.restores})`} />
              <RecordField copy={false} label="Median (ms)" value={shownRecovery.recoveryTime.medianMs === null ? "unmeasured" : String(shownRecovery.recoveryTime.medianMs)} />
              <RecordField copy={false} label="Achieved recovery point age (ms)" value={shownRecovery.freshness.achievedRpoMs === null ? "unmeasured" : String(shownRecovery.freshness.achievedRpoMs)} usage={<>from <code>node cli/keel-recovery-metrics.mjs report</code></>} />
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
          <RecordField label="Evidence chain head" value={report.provenance.evidenceHead ? `${report.provenance.evidenceHead.seq} · ${report.provenance.evidenceHead.hash}` : null} usage={<><code>GET /api/evidence/verify</code></>} />
          <RecordField copy={false} label="Period" value={`${report.period.from} to ${report.period.to}`} />
          <RecordField copy={false} label="Scope" value={report.scope.central ? "tenant-wide" : `entities ${report.scope.entities.join(" ") || "none"}`} />
          <RecordField copy={false} label="Rows read" value={`restore jobs ${report.provenance.sources.restoreJobsRead}, remediate jobs ${report.provenance.sources.remediateJobsRead}, backups checked ${report.provenance.sources.collectionsChecked}, evaluations ${report.provenance.sources.evaluationsRead}`} />
          <RecordField copy={false} label="Counting rules" value={report.provenance.countingRules.join(" ")} />
          <RecordField label="Tenant reference" value={report.tenantRef} />
        </TechnicalDetails>
      </Card>
    </div>
  );
}
