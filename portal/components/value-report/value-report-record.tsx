import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { isWithheld, outcomeName, type ValueReport } from "@/lib/value-report-view";

// The value report's record layer: every id, code and raw number, in one "Technical
// details" at the foot of the page.

const CLI = "node cli/keel-value-report.mjs";

export function ValueReportRecord({ report }: { report: ValueReport }) {
  const { outcomes, findings, recovery, hoursSaved } = report;
  const shownFindings = isWithheld(findings) ? null : findings;
  const shownRecovery = isWithheld(recovery) ? null : recovery;
  return (
    <TechnicalDetails summary="Technical details for this report">
      <RecordGroup title="Requests">
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
              <RecordField copy={false} label="Settings" value={row.resources} />
              <RecordField copy={false} label="Setting type" value={row.resourceType} />
              <RecordField copy={false} label="Change type" value={row.changeType} />
              <RecordField label="Plan ID" value={row.planId} />
              <RecordField label="Drift ID" value={row.driftId} />
              <RecordField label="Newest job ID" usage={<><code>GET /api/jobs/&lt;id&gt;</code></>} value={row.lastJobId ?? null} />
              {row.attemptEventIds.map((eventId, index) => (
                <RecordField key={eventId} label={`Try ${index + 1} (event ID)`} usage={<><code>GET /api/jobs/&lt;id&gt;</code></>} value={eventId} />
              ))}
            </RecordGroup>
          ))}
      </RecordGroup>
      {shownFindings ? (
        <RecordGroup title="Security checks">
              <RecordField copy={false} label="Reopened controls" value={shownFindings.reopened} />
              <RecordField copy={false} label="Rows shown" usage={`of ${shownFindings.total}`} value={shownFindings.rowsShown} />
              {shownFindings.rows.map((row) => (
                <RecordGroup key={row.id} note={row.reopened ? `${row.state}, reopened` : row.state} title={`Control ${row.controlId}`}>
                  <RecordField label="Finding ID" value={row.id} />
                  <RecordField label="Control ID" value={row.controlId} />
                  <RecordField copy={false} label="Registry title" value={row.title ?? null} />
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
        </RecordGroup>
      ) : null}
      {shownRecovery ? (
        <>
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
        </>
      ) : null}
      <RecordGroup title="Time-saving estimate">
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
      </RecordGroup>
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
  );
}
