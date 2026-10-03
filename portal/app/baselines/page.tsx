import { connection } from "next/server";
import { headers } from "next/headers";

import { ActivateBaseline } from "@/components/activate-baseline";
import { BaselineCreateForm } from "@/components/baseline-create-form";
import { DataUnavailable } from "@/components/data-unavailable";
import { JobRefresher } from "@/components/job-refresher";
import { JobTable } from "@/components/job-table";
import { PageHeader } from "@/components/page-header";
import { formatAge, formatTimestamp } from "@/lib/presentation";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { getBaselinesData } from "@/lib/portal-data";
import {
  getRecentJobs,
  getSnapshotOptions,
  hasCompletedSnapshots,
  type JobRecord,
  type SnapshotOption,
} from "@/lib/portal-jobs";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { BaselinesData } from "@/lib/types";

const BASELINE_JOB_KINDS = ["baseline-create", "baseline-activate"];

export default async function BaselinesPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.baselinesPage);
  const capabilities = ((await headers()).get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);
  // UI gating is a convenience only — the action API re-checks this capability on
  // every request. Both create and activate sit behind baseline-create (see
  // engine/authz/jobCapabilities.mjs).
  const canBaseline = capabilities.includes("baseline-create");

  let data: BaselinesData;
  let snapshots: SnapshotOption[];
  let completedSnapshotsExist: boolean;
  let jobs: JobRecord[];
  try {
    [data, snapshots, completedSnapshotsExist, jobs] = await Promise.all([
      getBaselinesData(),
      getSnapshotOptions(),
      hasCompletedSnapshots(),
      getRecentJobs(BASELINE_JOB_KINDS),
    ]);
  } catch {
    return (
      <>
        <PageHeader
          description="Named recovery reference points and their captured resource counts."
          section="Changes"
          marker={canBaseline ? "Actionable" : "Read-only"}
          title="Baselines"
        />
        <DataUnavailable surface="Baseline data" />
      </>
    );
  }

  const maxResources = Math.max(1, ...data.baselines.map((baseline) => baseline.resourceCount));
  const jobsActive = jobs.some(
    (job) => job.status === "queued" || job.status === "running",
  );

  return (
    <>
      <PageHeader
        description="Named recovery reference points and their captured resource counts."
        section="Changes"
        generatedAt={data.generatedAt}
        marker={canBaseline ? "Actionable" : "Read-only"}
        title="Baselines"
      />

      <section aria-labelledby="baseline-list-heading" className="report-section">
        <div className="section-heading-row report-heading">
          <div>
            <p className="section-kicker">Newest first</p>
            <h2 id="baseline-list-heading">Baseline register</h2>
          </div>
          <span className="result-count">
            {data.baselines.length} {data.baselines.length === 1 ? "baseline" : "baselines"}
          </span>
        </div>

        {data.baselines.length ? (
          <div className="table-scroll">
            <table className="data-table baselines-table">
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">Set at</th>
                  <th scope="col">Age</th>
                  <th scope="col">Set by</th>
                  <th scope="col">State</th>
                  <th className="number-column" scope="col">Resources</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.baselines.map((baseline) => (
                  <tr className={baseline.active ? "active-row" : undefined} key={baseline.id}>
                    <th data-label="Label" scope="row">
                      <span className="baseline-table-label">
                        <strong>{baseline.label ?? "Unnamed baseline"}</strong>
                        {baseline.description ? <small>{baseline.description}</small> : null}
                      </span>
                    </th>
                    <td data-label="Set at">
                      <time dateTime={baseline.setAt}>{formatTimestamp(baseline.setAt)}</time>
                    </td>
                    <td data-label="Age">
                      {formatAge(baseline.setAt, new Date(data.generatedAt))}
                    </td>
                    <td className="wrap-value" data-label="Set by">{baseline.setBy}</td>
                    <td data-label="State">
                      {baseline.active ? (
                        <span className="active-indicator">Active</span>
                      ) : (
                        <span className="inactive-indicator">Inactive</span>
                      )}
                    </td>
                    <td className="number-column" data-label="Resources">
                      <span className="resource-bar-cell">
                        {baseline.resourceCount.toLocaleString("en-GB")}
                        <span aria-hidden="true" className="resource-bar">
                          <span style={{ width: `${(baseline.resourceCount / maxResources) * 100}%` }} />
                        </span>
                      </span>
                    </td>
                    <td data-label="Actions">
                      {baseline.active ? null : (
                        <ActivateBaseline
                          baselineId={baseline.id}
                          disabled={!canBaseline}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">No baselines are recorded for this tenant.</p>
        )}
      </section>

      <BaselineCreateForm
        completedSnapshotsExist={completedSnapshotsExist}
        disabled={!canBaseline}
        snapshots={snapshots}
      />

      <JobTable
        headingId="baseline-jobs-heading"
        jobs={jobs}
        kicker="Queue"
        title="Baseline jobs"
      />
      <JobRefresher active={jobsActive} />
    </>
  );
}
