import { JobTable } from "@/components/job-table";
import type { JobRecord } from "@/lib/portal-jobs";
import { formatTimestamp } from "@/lib/presentation";

export function JobDetail({ job }: { job: JobRecord }) {
  return (
    <>
      <JobTable headingId="job-heading" jobs={[job]} kicker="Outcome" title={job.kind} />
      <section className="report-section" aria-labelledby="execution-heading">
        <h2 id="execution-heading">Execution</h2>
        <dl>
          <dt>Worker ID</dt><dd className="wrap-value">{job.workerId ?? "—"}</dd>
          <dt>Started</dt><dd>{formatTimestamp(job.startedAt)}</dd>
          <dt>Heartbeat</dt><dd>{formatTimestamp(job.heartbeatAt)}</dd>
        </dl>
      </section>
      <section className="report-section" aria-labelledby="payload-heading">
        <h2 id="payload-heading">Job data</h2>
        <h3>Params</h3><pre className="job-payload">{JSON.stringify(job.params, null, 2)}</pre>
        <h3>Result</h3><pre className="job-payload">{JSON.stringify(job.result, null, 2)}</pre>
        <h3>Error</h3><pre className="job-error job-payload">{job.error === null ? "—" : String(job.error)}</pre>
      </section>
    </>
  );
}
