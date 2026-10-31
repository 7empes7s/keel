import Link from "next/link";

import { PagedRows } from "@/components/list/paged-rows";
import { JobStatusBadge } from "@/components/job-status-badge";
import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, RecordGroup, ReferenceFields, TechnicalDetails, type RecordValue } from "@/components/technical-details";
import { displayAccount, refUsage } from "@/lib/record-refs";
import { Person } from "@/components/ui/person";
import { incompleteTypesLine, jobDisplayStatus, jobErrorLine, jobIncompleteTypes } from "@/lib/job-names";
import type { JobRecord } from "@/lib/portal-jobs";
import { ago, formatTimestamp } from "@/lib/presentation";
import { jobName, jobStatusSentence } from "@/lib/sentences";

// Recent jobs on the backups, baselines and restore surfaces (plan task 16), named by
// what they do (roadmap task-130): the job as a sentence, its status, when and who
// asked for it. Ids, codes and the raw error sit in one record under the list and in
// the job page's record (JobRecordFields), never inside a list row.
export function JobRecordFields({ job }: { job: JobRecord }) {
  return (
    <>
      <RecordField label="Job ID" usage={<>use with <code>GET /api/jobs/&lt;id&gt;</code></>} value={job.id} />
      <RecordField copy={false} label="Kind" value={job.kind} />
      <RecordField copy={false} label="Status" value={job.status} />
      <RecordField label="Requested by (account ID)" usage={refUsage(job.references?.people.requested_by)} value={displayAccount(job.requestedBy, job.references?.people.requested_by)} />
      <RecordField copy={false} label="Created" value={job.createdAt} />
      <RecordField copy={false} label="Started" value={job.startedAt} />
      <RecordField copy={false} label="Finished" value={job.finishedAt} />
      <RecordField label="Worker ID" value={job.workerId} />
      <RecordField copy={false} label="Heartbeat" value={job.heartbeatAt} />
      <RecordField label="Idempotency key" value={job.idempotencyKey} />
      <RecordField label="Params" value={job.params as RecordValue} />
      <RecordField label="Result" value={job.result as RecordValue} />
      {job.status === "failed" && job.error !== null && job.error !== undefined ? <RecordField label="Full error" value={typeof job.error === "string" ? job.error : (job.error as RecordValue)} /> : null}
      <ReferenceFields references={job.references} skipPeople={["requested_by"]} />
    </>
  );
}

const KIND_ICONS: Record<string, IconName> = {
  collect: "backup",
  backup: "backup",
  "workload-collect": "backup",
  "content-collect": "backup",
  prune: "backup",
  offsite: "cloud",
  restore: "restore",
  "restore-dry-run": "restore",
  remediate: "restore",
  "baseline-create": "baselines",
  "baseline-activate": "baselines",
  dispose: "baselines",
  "drift-detect": "baselines",
  "policy-evaluate": "automation",
  notify: "bell",
  discover: "search",
};

export function jobKindIcon(kind: string): IconName {
  return KIND_ICONS[kind] ?? "page";
}

/** One job as a shared list row (shared frame pick A): kind icon, the job's name and,
 *  when it failed, why in plain words; its status badge, when and who; no record here,
 *  the job page holds it. */
export function JobRow({ job, now }: { job: JobRecord; now: string }) {
  const at = job.finishedAt ?? job.startedAt ?? job.createdAt ?? null;
  const failed = job.status === "failed";
  const gaps = jobIncompleteTypes(job);
  return (
    <li className={`activity-item list-row job-row job-row-${jobDisplayStatus(job)}`} data-tone={failed ? "urgent" : gaps.length ? "soon" : undefined}>
      <span aria-hidden="true" className="row-kind"><Icon name={jobKindIcon(job.kind)} /></span>
      <span className="row-name">
        <Link href={`/jobs/${encodeURIComponent(job.id)}`}>{jobName(job)}</Link>
        {failed && job.error ? <small className="job-error-line">{jobErrorLine(job.error)}</small> : null}
        {gaps.length ? <small className="job-gap-line">{incompleteTypesLine(gaps)}</small> : null}
      </span>
      <span className="row-mid">
        <span className="row-status"><JobStatusBadge status={jobDisplayStatus(job)} /></span>
        <span className="row-meta">
          <time dateTime={at ?? undefined} title={`${jobStatusSentence(job, now)} · ${formatTimestamp(at)}`}>{ago(at, now)}</time>
          <span aria-hidden="true">·</span>
          <span>asked by <Person person={job.references?.people.requested_by} /></span>
        </span>
      </span>
    </li>
  );
}

/** One section-level record for the whole list (rows never carry one): each job's id,
 *  kind, status, who asked by account id, and the raw error of a failed job. */
function JobListRecord({ job }: { job: JobRecord }) {
  return (
    <RecordGroup note={`${job.kind} · ${job.status}`} title={jobName(job)}>
      <JobRecordFields job={job} />
    </RecordGroup>
  );
}

const JOB_SORTS = [
  { key: "when", label: "When", desc: true },
  { key: "name", label: "Name" },
  { key: "status", label: "Status" },
];

export function JobTable({
  headingId,
  jobs,
  title,
  now = new Date().toISOString(),
  total,
  link = { label: "All activity", href: "/activity" },
  empty = "No jobs of this kind have run yet.",
}: {
  headingId: string;
  jobs: JobRecord[];
  title: string;
  now?: string;
  /** How many jobs the list stands for, when it shows only the newest of them. */
  total?: number;
  link?: { label: string; href: string };
  empty?: string;
}) {
  const shown = total !== undefined && total > jobs.length ? `Showing ${jobs.length} of ${total} jobs` : null;
  return (
    <section aria-labelledby={headingId} className="report-section job-list">
      <div className="section-heading-row report-heading">
        <h2 id={headingId}>{title}</h2>
        <span className="section-aside">
          <span className="job-count">{shown ?? `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`}</span>
          <Link className="text-link" href={link.href}>{link.label}</Link>
        </span>
      </div>

      {jobs.length ? (
        <>
          <PagedRows
            label={title}
            listClassName="activity-list"
            noun={{ one: "job", many: "jobs" }}
            prefix="jobs-"
            rows={jobs.map((job) => ({
              id: job.id,
              node: <JobRow job={job} now={now} />,
              text: `${jobName(job)} ${job.status} ${job.status === "failed" && job.error ? jobErrorLine(job.error) : ""}`,
              values: { when: job.finishedAt ?? job.startedAt ?? job.createdAt ?? "", name: jobName(job), status: job.status },
            }))}
            sorts={JOB_SORTS}
          />
          <TechnicalDetails summary="Technical details for these jobs">
            {jobs.map((job) => (
              <JobListRecord job={job} key={job.id} />
            ))}
          </TechnicalDetails>
        </>
      ) : (
        <p className="empty-state">{empty}</p>
      )}
    </section>
  );
}
