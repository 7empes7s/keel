import Link from "next/link";

import { JobStatusBadge } from "@/components/job-status-badge";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import type { JobRecord } from "@/lib/portal-jobs";
import { formatTimestamp } from "@/lib/presentation";
import { jobName, jobStatusSentence, refLabel } from "@/lib/sentences";

// Recent jobs on the backups, baselines and restore surfaces (plan task 16), named by
// what they do (roadmap task-130): the job as a sentence, its status as a sentence,
// who asked for it; the job id, kind code and raw times in the record.
export function JobRecordFields({ job }: { job: JobRecord }) {
  return (
    <>
      <RecordField label="Job ID" usage={<>use with <code>GET /api/jobs/&lt;id&gt;</code></>} value={job.id} />
      <RecordField copy={false} label="Kind and status" value={`${job.kind} · ${job.status}`} />
      <RecordField label="Requested by (principal ID)" value={job.requestedBy} />
      <RecordField copy={false} label="Times" value={`created ${job.createdAt ?? "never"} · started ${job.startedAt ?? "never"} · finished ${job.finishedAt ?? "never"}`} />
    </>
  );
}

export function JobTable({
  headingId,
  jobs,
  kicker,
  title,
  now = new Date().toISOString(),
}: {
  headingId: string;
  jobs: JobRecord[];
  kicker: string;
  title: string;
  now?: string;
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
        <ul className="activity-list">
          {jobs.map((job) => (
            <li className={`activity-item job-row job-row-${job.status}`} key={job.id}>
              <div className="activity-main">
                <Link className="activity-title" href={`/jobs/${encodeURIComponent(job.id)}`}>{jobName(job)}</Link>
                <p className="activity-meta">
                  <JobStatusBadge status={job.status} />{" "}
                  <time dateTime={job.finishedAt ?? job.startedAt ?? job.createdAt ?? undefined} title={formatTimestamp(job.finishedAt ?? job.createdAt)}>{jobStatusSentence(job, now)}</time>
                  {" · asked by "}{refLabel(job.references?.people.requested_by, "an unknown account")}
                </p>
                {job.status === "failed" && job.error ? <p className="job-error-line">{String(job.error).split("\n")[0]}</p> : null}
              </div>
              <TechnicalDetails>
                <JobRecordFields job={job} />
              </TechnicalDetails>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">No jobs of this kind have run yet.</p>
      )}
    </section>
  );
}
