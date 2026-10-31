import Link from "next/link";

import { RiskChip, SectionHead } from "@/components/baselines/parts";
import { JobRecordFields } from "@/components/job-table";
import { PagedRows } from "@/components/list/paged-rows";
import { Icon } from "@/components/shell/icons";
import { RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { jobDisplayStatus } from "@/lib/job-names";
import type { RiskTone } from "@/lib/menu-status";
import type { JobRecord } from "@/lib/portal-jobs";
import { formatTimestamp } from "@/lib/presentation";
import { jobName, jobStatusSentence, personLabel } from "@/lib/sentences";

function statusChip(status: string): { tone: RiskTone | null; label: string } {
  if (status === "partial") return { tone: "soon", label: "Partly done" };
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
        <PagedRows
          label="Recent work"
          listClassName="bl-versions"
          noun={{ one: "job", many: "jobs" }}
          prefix="work-"
          rows={jobs.map((job) => {
            const chip = statusChip(jobDisplayStatus(job));
            const at = job.finishedAt ?? job.startedAt ?? job.createdAt;
            return { id: job.id, text: `${jobName(job)} ${chip.label}`, values: { when: at ?? "", name: jobName(job), status: chip.label }, node: (
              <li className="bl-card bl-job">
                <span aria-hidden="true" className="bl-kind-icon" data-tone={chip.tone ?? undefined}><Icon name="baselines" /></span>
                <span className="bl-job-name">
                  <Link className="bl-row-link" href={`/jobs/${encodeURIComponent(job.id)}`}>{jobName(job)}</Link>
                  <small>
                    <time dateTime={at ?? undefined} title={formatTimestamp(at)}>{jobStatusSentence(job, now)}</time>
                    {" · asked by "}{personLabel(job.references?.people.requested_by)}
                  </small>
                </span>
                <RiskChip tone={chip.tone}>{chip.label}</RiskChip>
              </li>
            ) };
          })}
          sorts={[{ key: "when", label: "When", desc: true }, { key: "name", label: "Name" }, { key: "status", label: "Status" }]}
        />
      ) : <p className="bl-help">Nothing yet. Creating an approved setup shows here while it runs.</p>}
      {jobs.length ? (
        <TechnicalDetails summary="Technical details: recent work">
          {jobs.map((job) => <RecordGroup key={job.id} note={`${job.kind} · ${jobDisplayStatus(job)}`} title={jobName(job)}><JobRecordFields job={job} /></RecordGroup>)}
        </TechnicalDetails>
      ) : null}
    </section>
  );
}
