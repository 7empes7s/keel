import { connection } from "next/server";
import { headers } from "next/headers";

import { BackupControls } from "@/components/backup-controls";
import { DataUnavailable } from "@/components/data-unavailable";
import { JobRefresher } from "@/components/job-refresher";
import { JobTable } from "@/components/job-table";
import { PageHeader } from "@/components/page-header";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { getRecentJobs, type JobRecord } from "@/lib/portal-jobs";

const BACKUP_JOB_KINDS = ["backup"];

export default async function BackupsPage() {
  await connection();
  const capabilities = ((await headers()).get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);
  // UI gating is a convenience only — the action API re-checks this capability on
  // every request.
  const canBackup = capabilities.includes("backup");

  let jobs: JobRecord[];
  try {
    jobs = await getRecentJobs(BACKUP_JOB_KINDS);
  } catch {
    return (
      <>
        <PageHeader
          description="On-demand tiered backups and their job progress."
          eyebrow="Protection"
          marker={canBackup ? "Actionable" : "Read-only"}
          title="Backups"
        />
        <DataUnavailable surface="Backup job data" />
      </>
    );
  }

  const jobsActive = jobs.some(
    (job) => job.status === "queued" || job.status === "running",
  );

  return (
    <>
      <PageHeader
        description="On-demand tiered backups and their job progress. A backup runs the same tiered collection as the backup schedule."
        eyebrow="Protection"
        generatedAt={new Date().toISOString()}
        marker={canBackup ? "Actionable" : "Read-only"}
        title="Backups"
      />

      <BackupControls disabled={!canBackup} />

      <JobTable
        headingId="backup-jobs-heading"
        jobs={jobs}
        kicker="Queue"
        title="Backup jobs"
      />
      <JobRefresher active={jobsActive} />
    </>
  );
}
