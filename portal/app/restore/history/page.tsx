import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { JobRefresher } from "@/components/job-refresher";
import { JobTable } from "@/components/job-table";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { getRecentJobs, type JobRecord } from "@/lib/portal-jobs";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { pastRestoresVerdict } from "@/lib/restore-view";

const TITLE = "Past restores";
const DESCRIPTION = "Every restore and every check before one, newest first, with who asked and how it ended.";

// Restore › Past restores: the restore jobs that used to sit at the foot of the Restore page.
export default async function RestoreHistoryPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.restoreHistoryPage);
  let jobs: JobRecord[];
  try {
    jobs = await getRecentJobs(["restore"]);
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Restore" title={TITLE} />
        <DataUnavailable surface="Past restores" />
      </>
    );
  }
  const now = new Date().toISOString();
  const active = jobs.some((job) => job.status === "queued" || job.status === "running");
  const verdict = pastRestoresVerdict(jobs, now);

  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={now} section="Restore" title={TITLE} />
      <Verdict action={verdict.href ? { label: "Open it", href: verdict.href } : null} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <JobTable headingId="restore-jobs-heading" jobs={jobs} now={now} title="Restores and checks" />
      </div>
      <JobRefresher active={active} />
    </>
  );
}
