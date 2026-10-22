import Link from "next/link";

import { JobStatusBadge } from "@/components/job-status-badge";
import { JobRecordFields } from "@/components/job-table";
import { Icon } from "@/components/shell/icons";
import { TechnicalDetails } from "@/components/technical-details";
import { AlertList, ShowDetails } from "@/components/ui/alert-list";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import { StatTiles } from "@/components/ui/stat-tiles";
import { jobDisplayStatus } from "@/lib/job-names";
import { jobAlerts, jobProgressPercent, jobProgressTiles, jobResultTiles, jobTiles, jobTypeGroups, jobTypeRows, type TypeRow } from "@/lib/job-view";
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
  const rows = jobTypeRows(job, now);
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

      {rows.length ? <>
        <StatTiles label="Progress" tiles={jobProgressTiles(job, rows, now)} />
        <JobTypes job={job} rows={rows} />
      </> : <StatTiles label="Timing and result" tiles={summaryTiles(job, now)} />}

      <TechnicalDetails>
        <JobRecordFields job={job} />
      </TechnicalDetails>
    </div>
  );
}

/** A restore's result tiles first, then timing; four at most, dropping "Asked for". */
function summaryTiles(job: JobRecord, now: string) {
  const result = jobResultTiles(job);
  const timing = jobTiles(job, now);
  return [...result, ...(result.length > 1 ? timing.filter((tile) => tile.key !== "asked") : timing)];
}

// Every kind the backup reads, by service and kind: a coloured state, the count saved,
// how long it took, and a plain cause for a problem with the raw error behind a click.
function JobTypes({ job, rows }: { job: JobRecord; rows: TypeRow[] }) {
  const groups = jobTypeGroups(rows);
  const percent = jobProgressPercent(rows);
  const running = job.status === "running" || job.status === "queued";
  const problems = groups.reduce((sum, group) => sum + group.problems, 0);
  return (
    <section aria-labelledby="job-types-heading" className="job-types" id="job-types">
      <div className="job-types-head">
        <h2 className="job-section-head" id="job-types-heading"><Icon name="backup" />What it backs up</h2>
        <Badge tone={rows.some((row) => row.tone === "urgent") ? "urgent" : rows.some((row) => row.tone === "soon") ? "soon" : running ? "low" : "fine"}>
          {running ? `${percent}% done` : problems ? `${problems} with problems` : "All read"}
        </Badge>
      </div>
      {running ? (
        <div aria-label={`${percent}% of kinds read`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={percent} className="job-progress-bar" role="progressbar">
          <i style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      <div className="rs-table-wrap">
        <table className="rs-table job-types-table">
          <caption className="visually-hidden">Each kind this backup reads, with its state</caption>
          <thead>
            <tr><th scope="col">Kind</th><th scope="col">State</th><th scope="col">Items</th><th scope="col">Took</th><th scope="col">Problem</th></tr>
          </thead>
          {groups.map((group) => (
            <tbody data-service={group.key} key={group.key}>
              <tr className="rs-group">
                <th colSpan={5} scope="colgroup">
                  <span><Icon name={group.icon} />{group.name}<small className="job-group-count">{`${group.done} of ${group.rows.length} read${group.problems ? ` · ${group.problems} with problems` : ""}`}</small></span>
                </th>
              </tr>
              {group.parts.map((part) => [
                group.parts.length > 1 ? (
                  <tr className="job-kind-part" key={`part-${part.key}`}><th colSpan={5} scope="colgroup">{part.label}</th></tr>
                ) : null,
                ...part.items.map((row) => (
                  <tr data-state={row.state} data-tone={row.tone} key={row.type}>
                    <th scope="row"><span className="rs-row-name">{row.name}</span></th>
                    <td data-label="State"><Badge icon={row.state === "reading" ? "refresh" : undefined} tone={row.tone}>{row.label}</Badge></td>
                    <td data-empty={row.count === null ? "" : undefined} data-label="Items">{row.count === null ? "—" : row.count.toLocaleString("en-GB")}</td>
                    <td data-empty={row.took ? undefined : ""} data-label="Took">{row.took ?? "—"}</td>
                    <td data-empty={row.problem ? undefined : ""} data-label="Problem">
                      {row.problem ? <>
                        <span className="job-problem">{row.problem}</span>
                        {row.raw ? <ShowDetails lines={[row.raw]} /> : null}
                      </> : "—"}
                    </td>
                  </tr>
                )),
              ])}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}
