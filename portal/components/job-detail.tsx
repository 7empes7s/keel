import Link from "next/link";

import { JobStatusBadge } from "@/components/job-status-badge";
import { JobRecordFields } from "@/components/job-table";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ErrorNotice } from "@/components/ui/error-notice";
import type { JobRecord } from "@/lib/portal-jobs";
import { jobDisplayStatus, jobIncompleteTypes } from "@/lib/job-names";
import { ago, formatTimestamp, resourceTypeLabel } from "@/lib/presentation";
import { jobName, jobStatusSentence, personLabel } from "@/lib/sentences";

function gap(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const seconds = Math.round((new Date(to).valueOf() - new Date(from).valueOf()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(minutes / 60)} hours`;
}

/** The job page's one sentence: what it is and how it ended. */
export function jobVerdict(job: JobRecord, now: string): string {
  return `${jobName(job)}: ${jobStatusSentence(job, now).replace(/^./, (character) => character.toLowerCase())}.`;
}

// One job (roadmap task-130): what it did and how it ended in words, the error only
// when there is one, links to what it acted on; worker, heartbeat, params, result and
// the full error text in the record.
export function JobDetail({ job, now = new Date().toISOString() }: { job: JobRecord; now?: string }) {
  const failed = job.status === "failed" && job.error !== null && job.error !== undefined;
  const gaps = jobIncompleteTypes(job);
  const plan = job.references?.plan;
  const undoes = job.references?.undoes;
  return (
    <div data-layer="explanation">
      <section aria-labelledby="job-heading" className={`job-summary job-summary-${jobDisplayStatus(job)}`}>
        <div className="job-summary-main">
          <h2 id="job-heading">{jobName(job)}</h2>
          <JobStatusBadge status={jobDisplayStatus(job)} />
        </div>
        <p>
          Asked for by {personLabel(job.references?.people.requested_by, "an unknown account")}{" "}
          <time dateTime={job.createdAt ?? undefined} title={formatTimestamp(job.createdAt)}>{ago(job.createdAt, now)}</time>.
          {job.startedAt ? <> Started {gap(job.createdAt, job.startedAt) ? `${gap(job.createdAt, job.startedAt)} later` : "right away"}.</> : " Not started yet."}
          {job.finishedAt ? <> Ended after {gap(job.startedAt, job.finishedAt) ?? "an unknown time"}.</> : job.startedAt ? " Still running." : null}
        </p>
        {plan?.readable && plan.dryRunJobId && plan.dryRunJobId !== job.id ? (
          <p><Link data-ref="dry-run" href={`/jobs/${plan.dryRunJobId}`}>Open the dry run this restore promoted</Link></p>
        ) : null}
        {undoes?.readable && undoes.dryRunJobId ? (
          <p><Link data-ref="dry-run" href={`/jobs/${undoes.dryRunJobId}`}>Open the dry run of the restore being undone</Link></p>
        ) : null}
      </section>

      {gaps.length ? (
        <section aria-labelledby="gaps-heading" className="report-section job-gaps-block">
          <h2 id="gaps-heading">What was not backed up</h2>
          <p>The backup was saved, but {gaps.length === 1 ? "this type" : "these types"} could not be read in full. The next backup tries again.</p>
          <ul>{gaps.map((type) => <li key={type}>{resourceTypeLabel(type).replace(/^./, (letter) => letter.toUpperCase())}</li>)}</ul>
        </section>
      ) : null}

      {failed ? (
        <section aria-labelledby="error-heading" className="report-section job-error-block">
          <h2 id="error-heading">What went wrong</h2>
          <ErrorNotice error={job.error} id="job-error" />
        </section>
      ) : null}

      <TechnicalDetails>
        <JobRecordFields job={job} />
      </TechnicalDetails>
    </div>
  );
}
