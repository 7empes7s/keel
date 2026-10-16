import { connection } from "next/server";
import { headers } from "next/headers";

import { ApprovedSetup } from "@/components/baselines/approved-setup";
import { RecentWork } from "@/components/baselines/recent-work";
import { DataUnavailable } from "@/components/data-unavailable";
import { JobRefresher } from "@/components/job-refresher";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { setupStatus, setupVerdict } from "@/lib/baselines-view";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { getBaselinesData, getCoverageData, getDriftData } from "@/lib/portal-data";
import {
  getRecentJobs,
  getSnapshotOptions,
  type JobRecord,
  type SnapshotOption,
} from "@/lib/portal-jobs";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { BaselinesData, DriftRecord } from "@/lib/types";

const BASELINE_JOB_KINDS = ["baseline-create", "baseline-activate"];
const DESCRIPTION = "How the tenant should look. Keel compares the tenant with it after every backup and lists what changed.";

export default async function BaselinesPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.baselinesPage);
  const capabilities = ((await headers()).get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);
  // UI gating is a convenience only: the action API re-checks this capability on every
  // request. Create and activate both sit behind baseline-create (engine/authz/jobCapabilities.mjs).
  const canBaseline = capabilities.includes("baseline-create");

  let data: BaselinesData;
  let snapshots: SnapshotOption[];
  let jobs: JobRecord[];
  try {
    [data, snapshots, jobs] = await Promise.all([
      getBaselinesData(),
      getSnapshotOptions(),
      getRecentJobs(BASELINE_JOB_KINDS),
    ]);
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Baselines" title="Approved setup" />
        <DataUnavailable surface="Baselines" />
      </>
    );
  }
  // The per-service summary is a convenience on top of the page: if the changes or the
  // backup inventory cannot be read, the page still shows the approved setup.
  const [items, backedUp] = await Promise.all([
    getDriftData(access.scope).then((drift) => drift.items as DriftRecord[], () => null),
    getCoverageData().then((coverage) => coverage.types.filter((type) => type.reportStatus === "covered").map((type) => type.type), () => [] as string[]),
  ]);

  const active = data.baselines.find((baseline) => baseline.active) ?? null;
  const verdict = setupVerdict(active, items, data.generatedAt);
  const jobsActive = jobs.some((job) => job.status === "queued" || job.status === "running");

  return (
    <>
      <PageHeader
        description={DESCRIPTION}
        generatedAt={data.generatedAt}
        section="Baselines"
        status={setupStatus(active, items ?? [])}
        title="Approved setup"
      />
      <Verdict
        action={active ? (items?.length ? { label: "Review changes", href: "/drift" } : null) : { label: "Create an approved setup", href: "/baselines/new" }}
        text={verdict.text}
        tone={verdict.tone}
      />
      <div data-layer="explanation">
        <ApprovedSetup backedUp={backedUp} baselines={data.baselines} canBaseline={canBaseline} items={items} now={data.generatedAt} sources={snapshots} />
        <RecentWork jobs={jobs} now={data.generatedAt} />
        <JobRefresher active={jobsActive} />
      </div>
    </>
  );
}
