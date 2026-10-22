import Link from "next/link";

import { JobStatusBadge } from "@/components/job-status-badge";
import { JobRecordFields } from "@/components/job-table";
import { Icon } from "@/components/shell/icons";
import { TechnicalDetails } from "@/components/technical-details";
import { AlertList } from "@/components/ui/alert-list";
import { Person } from "@/components/ui/person";
import { StatTiles } from "@/components/ui/stat-tiles";
import { jobDisplayStatus } from "@/lib/job-names";
import { jobAlerts, jobTiles } from "@/lib/job-view";
import type { JobRecord } from "@/lib/portal-jobs";
import { jobName, jobStatusSentence } from "@/lib/sentences";

/** The job page's one sentence: what it is and how it ended. */
export function jobVerdict(job: JobRecord, now: string): string {
  return `${jobName(job)}: ${jobStatusSentence(job, now).replace(/^./, (character) => character.toLowerCase())}.`;
}

// One job (roadmap task-130, then the Job page redesign): what needs the reader first,
// as alert rows with a plain cause and one next step (the engine's error text behind
// "Show details"); then what the job is, who asked for it and three timing tiles. The
// worker, heartbeat, params, result and full error stay in the record.
export function JobDetail({ job, now = new Date().toISOString() }: { job: JobRecord; now?: string }) {
  const plan = job.references?.plan;
  const undoes = job.references?.undoes;
  const alerts = jobAlerts(job);
  return (
    <div className="job-page" data-layer="explanation">
      {alerts.length ? (
        <section aria-labelledby="job-attention-heading" className="job-attention">
          <h2 className="job-section-head" id="job-attention-heading"><Icon name="alert" />Needs your attention</h2>
          <AlertList items={alerts} />
        </section>
      ) : null}

      <section aria-labelledby="job-heading" className={`job-summary job-summary-${jobDisplayStatus(job)}`}>
        <div className="job-summary-main">
          <h2 id="job-heading">{jobName(job)}</h2>
          <JobStatusBadge status={jobDisplayStatus(job)} />
        </div>
        <p className="job-requester"><span>Asked for by</span><Person fallback="an unknown account" person={job.references?.people.requested_by} /></p>
        {(plan?.readable && plan.dryRunJobId && plan.dryRunJobId !== job.id) || (undoes?.readable && undoes.dryRunJobId) ? (
          <div className="job-links">
            {plan?.readable && plan.dryRunJobId && plan.dryRunJobId !== job.id ? (
              <Link className="btn btn-sm" data-ref="dry-run" href={`/jobs/${plan.dryRunJobId}`}><Icon name="show" />Open the dry run it promoted</Link>
            ) : null}
            {undoes?.readable && undoes.dryRunJobId ? (
              <Link className="btn btn-sm" data-ref="dry-run" href={`/jobs/${undoes.dryRunJobId}`}><Icon name="show" />Open the dry run of the restore being undone</Link>
            ) : null}
          </div>
        ) : null}
      </section>

      <StatTiles label="Timing" tiles={jobTiles(job, now)} />

      <TechnicalDetails>
        <JobRecordFields job={job} />
      </TechnicalDetails>
    </div>
  );
}
