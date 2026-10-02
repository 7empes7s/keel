import { JobStatusBadge } from "@/components/job-status-badge";
import type { JobRecord } from "@/lib/portal-jobs";
import { formatTimestamp } from "@/lib/presentation";

function duration(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const ms = new Date(to).valueOf() - new Date(from).valueOf();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

// One job, summary first: what it is and how it ended, then when each phase happened,
// then the raw params, result and full error for anything the summary does not say.
export function JobDetail({ job }: { job: JobRecord }) {
  const failed = job.status === "failed" && job.error !== null;
  const steps = [
    { label: "Created", at: job.createdAt, gap: null },
    { label: "Started", at: job.startedAt, gap: duration(job.createdAt, job.startedAt) },
    { label: "Heartbeat", at: job.heartbeatAt, gap: duration(job.startedAt, job.heartbeatAt) },
    { label: "Finished", at: job.finishedAt, gap: duration(job.startedAt, job.finishedAt) },
  ];

  return (
    <>
      <section aria-labelledby="job-heading" className={`job-summary job-summary-${job.status}`}>
        <div className="job-summary-main">
          <p className="section-kicker">Outcome</p>
          <h2 id="job-heading"><code>{job.kind}</code></h2>
          <JobStatusBadge status={job.status} />
        </div>
        <dl className="kv-grid job-summary-facts">
          <dt>Requested by</dt><dd className="wrap-value">{job.requestedBy}</dd>
          <dt>Worker ID</dt><dd className="wrap-value">{job.workerId ?? "—"}</dd>
          <dt>Run time</dt><dd>{duration(job.startedAt, job.finishedAt) ?? (job.finishedAt ? "—" : "Still running")}</dd>
        </dl>
      </section>

      <section aria-labelledby="execution-heading" className="report-section">
        <h2 id="execution-heading">Execution</h2>
        <ol className="job-timeline">
          {steps.map((step) => (
            <li className={step.at ? "timeline-done" : "timeline-pending"} key={step.label}>
              <span className="timeline-label">{step.label}</span>
              <time dateTime={step.at ?? undefined}>{formatTimestamp(step.at)}</time>
              {step.gap ? <small>+{step.gap}</small> : null}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="payload-heading" className="report-section">
        <h2 id="payload-heading">Job data</h2>
        {failed ? (
          <div className="job-error-block">
            <h3>Error</h3>
            <pre className="job-error job-payload">{String(job.error)}</pre>
          </div>
        ) : null}
        <div className="job-data-grid">
          <div>
            <h3>Params</h3>
            <pre className="job-payload">{JSON.stringify(job.params, null, 2)}</pre>
          </div>
          <div>
            <h3>Result</h3>
            <pre className="job-payload">{JSON.stringify(job.result, null, 2)}</pre>
          </div>
        </div>
        {failed ? null : (
          <div className="job-error-block job-error-empty">
            <h3>Error</h3>
            <pre className="job-error job-payload">{job.error === null ? "—" : String(job.error)}</pre>
          </div>
        )}
      </section>
    </>
  );
}
