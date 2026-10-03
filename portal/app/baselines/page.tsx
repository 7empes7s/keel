import { connection } from "next/server";
import { headers } from "next/headers";

import { BaselineRegister } from "@/components/baseline-register";
import { BaselineCreateForm } from "@/components/baseline-create-form";
import { DataUnavailable } from "@/components/data-unavailable";
import { JobRefresher } from "@/components/job-refresher";
import { JobTable } from "@/components/job-table";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { ago } from "@/lib/presentation";
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
          description="How the tenant should look: the reference every change is measured against."
          section="Changes"
          title="Baselines"
        />
        <DataUnavailable surface="Baselines" />
      </>
    );
  }

  const active = data.baselines.find((baseline) => baseline.active) ?? null;
  const jobsActive = jobs.some(
    (job) => job.status === "queued" || job.status === "running",
  );

  return (
    <>
      <PageHeader
        description="How the tenant should look: the reference every change is measured against."
        section="Changes"
        generatedAt={data.generatedAt}
        title="Baselines"
      />
      <Verdict
        text={active
          ? `The active baseline is “${active.label ?? "Unnamed baseline"}”, set ${ago(active.setAt, data.generatedAt)}.`
          : "No baseline is active, so KEEL cannot tell what changed."}
        tone={active ? "good" : "critical"}
      />

      <div data-layer="explanation">
      <BaselineRegister baselines={data.baselines} canBaseline={canBaseline} now={data.generatedAt} />

      <BaselineCreateForm
        completedSnapshotsExist={completedSnapshotsExist}
        disabled={!canBaseline}
        snapshots={snapshots}
      />

      <JobTable
        headingId="baseline-jobs-heading"
        jobs={jobs}
        kicker="Recent"
        now={data.generatedAt}
        title="Baseline jobs"
      />
      <JobRefresher active={jobsActive} />
      </div>
    </>
  );
}
