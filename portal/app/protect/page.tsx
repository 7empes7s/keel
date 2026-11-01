import { headers } from "next/headers";
import { connection } from "next/server";

import { GET as loadSchedules } from "@/app/api/schedules/route";
import { BackUpNow, TierStrip } from "@/components/backup-controls";
import { ContentBackups } from "@/components/content-backups";
import { DataUnavailable } from "@/components/data-unavailable";
import { DiscoveryInventory } from "@/components/discovery-inventory";
import { JobRefresher } from "@/components/job-refresher";
import { JobTable } from "@/components/job-table";
import { PageHeader } from "@/components/page-header";
import { ProtectCoverage } from "@/components/protect-coverage";
import { getContentBackups } from "@/lib/content-backups";
import { getDiscoveryInventory } from "@/lib/discovery";
import { getCoverageData } from "@/lib/portal-data";
import { getActiveTierJobs, getRecentJobs, type JobRecord } from "@/lib/portal-jobs";
import { activeTierRuns, protectStatus, protectVerdict, tierSummaries, withWorkloadKinds } from "@/lib/protect-view";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { Schedule } from "@/lib/schedules";
import type { CoverageData } from "@/lib/types";

// On-demand backups, the scheduled tier runs and the service settings runs (Exchange,
// SharePoint, Teams, Purview, Power Platform) all read the tenant into a backup.
export const BACKUP_JOB_KINDS = ["backup", "collect", "workload-collect"];
const TITLE = "What's protected";
const DESCRIPTION = "Whether every kind of setting and content is backed up, how often, and whether Keel can put it back.";

// Roadmap task-131: Protect merges Backups and the per-type coverage report. The
// verdict comes from the coverage reader, the tier cards from the schedule reader.
// Schedules and backup jobs are secondary: if either cannot be read, the page still
// answers from coverage and says what is missing.
export default async function ProtectPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.protectPage);
  const canBackup = access.capabilities.includes("backup");
  const canCollect = access.capabilities.includes("collect");
  const canEditSchedules = access.capabilities.includes("configuration");

  let data: CoverageData;
  try {
    data = withWorkloadKinds(await getCoverageData());
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Backup" title={TITLE} />
        <DataUnavailable surface="Backup coverage" />
      </>
    );
  }

  const requestHeaders = await headers();
  const [schedulesResult, jobsResult, discoveryResult, contentResult, activeResult] = await Promise.allSettled([
    loadSchedules(new Request("http://localhost/api/schedules", { headers: requestHeaders }))
      .then(async (response) => {
        if (!response.ok) throw new Error("Schedules unavailable");
        return ((await response.json()) as { schedules: Schedule[] }).schedules;
      }),
    getRecentJobs(BACKUP_JOB_KINDS, 10),
    getDiscoveryInventory(),
    getContentBackups(new Date(data.generatedAt)),
    getActiveTierJobs(),
  ]);
  const schedules = schedulesResult.status === "fulfilled" ? schedulesResult.value : null;
  const jobs: JobRecord[] = jobsResult.status === "fulfilled" ? jobsResult.value : [];
  const now = data.generatedAt;
  const verdict = protectVerdict(data, now);
  // UI audit B1: each tier's queued or running backup, so its cards and buttons say
  // "Queued" / "Running" and a second press cannot start it again.
  const active = activeTierRuns(activeResult.status === "fulfilled" ? activeResult.value : jobs, new Date().toISOString());
  const jobsActive = Object.keys(active).length > 0 || jobs.some((job) => job.status === "queued" || job.status === "running");

  const status = protectStatus(data);
  return (
    <>
      <PageHeader
        actions={<BackUpNow active={active} disabled={!canBackup} now={now} urgent={verdict.tone !== "good"} />}
        description={DESCRIPTION}
        generatedAt={now}
        section="Backup"
        status={status}
        title={TITLE}
      />
      {/* The coverage list draws the verdict, so it follows the service filter like the tiles. */}
      <ProtectCoverage
        active={active}
        canBackup={canBackup}
        canCollect={canCollect}
        data={data}
        now={now}
        tierStrip={<>
          <TierStrip active={active} canEditSchedules={canEditSchedules} disabled={!canBackup} now={now} tiers={tierSummaries(schedules ?? [], now, active)} />
          {schedules === null ? <p className="action-error">Keel could not read the schedules, so next run times are missing. Reload in a minute.</p> : null}
        </>}
      >
        <ContentBackups data={contentResult.status === "fulfilled" ? contentResult.value : undefined} now={now} />
        <div className="pt-recent">
          {jobsResult.status === "fulfilled" ? (
            <JobTable headingId="backup-jobs-heading" jobs={jobs} now={now} title="Recent backups" />
          ) : <p className="action-error">Keel could not read recent backups. Reload in a minute.</p>}
          <DiscoveryInventory data={discoveryResult.status === "fulfilled" ? discoveryResult.value : undefined} now={now} />
        </div>
        <JobRefresher active={jobsActive} />
      </ProtectCoverage>
    </>
  );
}
