import { headers } from "next/headers";
import { connection } from "next/server";

import { GET as loadSchedules } from "@/app/api/schedules/route";
import { BackupControls, ProblemList } from "@/components/backup-controls";
import { CoverageReport } from "@/components/coverage-report";
import { DataUnavailable } from "@/components/data-unavailable";
import { JobRefresher } from "@/components/job-refresher";
import { JobTable } from "@/components/job-table";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { getCoverageData } from "@/lib/portal-data";
import { getRecentJobs, type JobRecord } from "@/lib/portal-jobs";
import { protectProblems, protectVerdict, tierSummaries } from "@/lib/protect-view";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { Schedule } from "@/lib/schedules";
import type { CoverageData } from "@/lib/types";

export const BACKUP_JOB_KINDS = ["backup"];
const DESCRIPTION = "Whether every configuration type is being backed up, how often, and whether KEEL can put it back.";

// Roadmap task-131: Protect merges Backups and the per-type coverage report. The
// verdict comes from the coverage reader, the tier cards from the schedule reader.
// Schedules and backup jobs are secondary: if either cannot be read, the page still
// answers from coverage and says what is missing.
export default async function ProtectPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.protectPage);
  const canBackup = access.capabilities.includes("backup");
  const canEditSchedules = access.capabilities.includes("configuration");

  let data: CoverageData;
  try {
    data = await getCoverageData();
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Protect" title="Protect" />
        <DataUnavailable surface="Backup coverage" />
      </>
    );
  }

  const requestHeaders = await headers();
  const [schedulesResult, jobsResult] = await Promise.allSettled([
    loadSchedules(new Request("http://localhost/api/schedules", { headers: requestHeaders }))
      .then(async (response) => {
        if (!response.ok) throw new Error("Schedules unavailable");
        return ((await response.json()) as { schedules: Schedule[] }).schedules;
      }),
    getRecentJobs(BACKUP_JOB_KINDS, 10),
  ]);
  const schedules = schedulesResult.status === "fulfilled" ? schedulesResult.value : null;
  const jobs: JobRecord[] = jobsResult.status === "fulfilled" ? jobsResult.value : [];
  const now = data.generatedAt;
  const verdict = protectVerdict(data, now);
  const jobsActive = jobs.some((job) => job.status === "queued" || job.status === "running");

  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={now} section="Protect" title="Protect" />
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <BackupControls
          canEditSchedules={canEditSchedules}
          disabled={!canBackup}
          tiers={tierSummaries(schedules ?? [], now)}
        />
        {schedules === null ? <p className="action-error">KEEL could not read the schedules, so next run times are missing. Reload in a minute.</p> : null}
        <ProblemList disabled={!canBackup} problems={protectProblems(data, now)} />
        <CoverageReport data={data} now={now} />
        {jobsResult.status === "fulfilled" ? (
          <JobTable headingId="backup-jobs-heading" jobs={jobs} kicker="Recent" now={now} title="On-demand backups" />
        ) : <p className="action-error">KEEL could not read recent backups. Reload in a minute.</p>}
        <JobRefresher active={jobsActive} />
      </div>
    </>
  );
}
