import Link from "next/link";

import { formatTimestamp } from "@/lib/presentation";
import type { JobRecord } from "@/lib/portal-jobs";

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Recent-job listing shared by the baselines and backups surfaces (plan task 16):
// kind, status, created/finished times, and the error when a job failed.
export function JobTable({
  headingId,
  jobs,
  kicker,
  title,
}: {
  headingId: string;
  jobs: JobRecord[];
  kicker: string;
  title: string;
}) {
  return (
    <section aria-labelledby={headingId} className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">{kicker}</p>
          <h2 id={headingId}>{title}</h2>
        </div>
        <span className="result-count">
          {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
        </span>
      </div>

      {jobs.length ? (
        <div className="table-scroll">
          <table className="data-table jobs-table">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Finished</th>
                <th scope="col">Requested by</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <th data-label="Kind" scope="row">
                    <Link href={`/jobs/${encodeURIComponent(job.id)}`}><code className="natural-key">{job.kind}</code></Link>
                  </th>
                  <td data-label="Status">
                    <span className={`job-status job-status-${job.status}`}>
                      {STATUS_LABEL[job.status] ?? job.status}
                    </span>
                  </td>
                  <td data-label="Created">
                    <time dateTime={job.createdAt ?? undefined}>
                      {formatTimestamp(job.createdAt)}
                    </time>
                  </td>
                  <td data-label="Finished">
                    <time dateTime={job.finishedAt ?? undefined}>
                      {formatTimestamp(job.finishedAt)}
                    </time>
                  </td>
                  <td className="wrap-value" data-label="Requested by">
                    {job.requestedBy}
                  </td>
                  <td className="wrap-value" data-label="Error">
                    {job.status === "failed" && job.error ? (
                      <pre className="job-error job-payload">{String(job.error)}</pre>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-state">No jobs of this kind have been queued yet.</p>
      )}
    </section>
  );
}
