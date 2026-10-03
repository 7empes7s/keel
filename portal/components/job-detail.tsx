import Link from "next/link";

import { JobStatusBadge } from "@/components/job-status-badge";
import { JobRecordFields } from "@/components/job-table";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import type { JobRecord } from "@/lib/portal-jobs";
import { ago, formatTimestamp } from "@/lib/presentation";
import { jobName, jobStatusSentence, refLabel } from "@/lib/sentences";

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
  const plan = job.references?.plan;
  const undoes = job.references?.undoes;
  return (
    <div data-layer="explanation">
      <section aria-labelledby="job-heading" className={`job-summary job-summary-${job.status}`}>
        <div className="job-summary-main">
          <h2 id="job-heading">{jobName(job)}</h2>
          <JobStatusBadge status={job.status} />
        </div>
        <p>
          Asked for by {refLabel(job.references?.people.requested_by, "an unknown account")}{" "}
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

      {failed ? (
        <section aria-labelledby="error-heading" className="report-section job-error-block">
          <h2 id="error-heading">What went wrong</h2>
          <p className="job-error-line">{String(job.error).split("\n")[0]}</p>
        </section>
      ) : null}

      <TechnicalDetails>
        <JobRecordFields job={job} />
        <RecordField label="Worker ID" value={job.workerId ?? null} />
        <RecordField copy={false} label="Heartbeat" value={job.heartbeatAt} />
        <RecordField label="Idempotency key" value={job.idempotencyKey ?? null} />
        <RecordField copy={false} label="Params" value={JSON.stringify(job.params, null, 2)} />
        <RecordField copy={false} label="Result" value={JSON.stringify(job.result, null, 2)} />
        {failed ? <RecordField copy={false} label="Full error" value={String(job.error)} /> : null}
        {plan ? <RecordField label="Dry run ID" usage={plan.readable ? "the plan this job acts on" : "no longer readable"} value={plan.id} /> : null}
      </TechnicalDetails>
    </div>
  );
}
