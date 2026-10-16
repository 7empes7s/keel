import Link from "next/link";

import { RiskChip, SectionHead } from "@/components/baselines/parts";
import { JobRecordFields } from "@/components/job-table";
import { Icon } from "@/components/shell/icons";
import { TechnicalDetails } from "@/components/technical-details";
import type { RiskTone } from "@/lib/menu-status";
import type { JobRecord } from "@/lib/portal-jobs";
import { formatTimestamp } from "@/lib/presentation";
import { jobName, jobStatusSentence, refLabel } from "@/lib/sentences";

function statusChip(status: string): { tone: RiskTone | null; label: string } {
  if (status === "succeeded" || status === "finished" || status === "completed") return { tone: "fine", label: "Finished" };
  if (status === "failed") return { tone: "urgent", label: "Failed" };
  if (status === "running") return { tone: "low", label: "Running" };
  if (status === "queued") return { tone: "low", label: "Waiting to start" };
  return { tone: null, label: status.charAt(0).toUpperCase() + status.slice(1) };
}

/** Creating or switching approved setups, newest first, as plain rows; ids in the record. */
export function RecentWork({ jobs, now }: { jobs: JobRecord[]; now: string }) {
  return (
    <section aria-labelledby="baseline-jobs-heading" className="bl-section">
      <SectionHead about="Creating a setup or switching to another one runs in the background. Each row opens its progress." id="baseline-jobs-heading" title="Recent work" />
      {jobs.length ? (
        <ul className="bl-versions">
          {jobs.map((job) => {
            const chip = statusChip(job.status);
            const at = job.finishedAt ?? job.startedAt ?? job.createdAt;
            return (
              <li className="bl-card bl-job" key={job.id}>
                <span aria-hidden="true" className="bl-kind-icon" data-tone={chip.tone ?? undefined}><Icon name="baselines" /></span>
                <span className="bl-job-name">
                  <Link className="bl-row-link" href={`/jobs/${encodeURIComponent(job.id)}`}>{jobName(job)}</Link>
                  <small>
                    <time dateTime={at ?? undefined} title={formatTimestamp(at)}>{jobStatusSentence(job, now)}</time>
                    {" · asked by "}{refLabel(job.references?.people.requested_by, "an unknown account")}
                  </small>
                </span>
                <RiskChip tone={chip.tone}>{chip.label}</RiskChip>
              </li>
            );
          })}
        </ul>
      ) : <p className="bl-help">Nothing yet. Creating an approved setup shows here while it runs.</p>}
      {jobs.length ? (
        <TechnicalDetails summary="Technical details: recent work">
          {jobs.map((job) => <JobRecordFields job={job} key={job.id} />)}
        </TechnicalDetails>
      ) : null}
    </section>
  );
}
