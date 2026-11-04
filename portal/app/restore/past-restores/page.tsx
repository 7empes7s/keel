import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { JobRefresher } from "@/components/job-refresher";
import { JobTable } from "@/components/job-table";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import type { FailedRestoreCounts } from "@/lib/failed-restores";
import { getFailedRestoreCounts, getFailedRestoreJobs, getRecentJobs, type JobRecord } from "@/lib/portal-jobs";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { pastRestoresVerdict } from "@/lib/restore-view";

const TITLE = "Past restores";
const DESCRIPTION = "Every restore and every check before one, newest first, with who asked and how it ended.";

// Restore › Past restores: the restore jobs that used to sit at the foot of Restore
// settings. "?jobs=failed" lists exactly the failed restores the engine counts (audit
// metric 7), the same number Resilience and the value report link here with.
export default async function PastRestoresPage({ searchParams }: { searchParams: Promise<{ jobs?: string }> }) {
  await connection();
  await requireReadAccess(DATA_SURFACES.pastRestoresPage);
  const onlyFailed = (await searchParams).jobs === "failed";
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
  // Secondary: without the failed list the page still shows every recent restore.
  let failedRestores: FailedRestoreCounts | null = null;
  let failedJobs: JobRecord[] | null = null;
  if (onlyFailed) {
    try {
      [failedRestores, failedJobs] = await Promise.all([getFailedRestoreCounts(), getFailedRestoreJobs()]);
    } catch {
      failedJobs = null;
    }
  }
  const now = new Date().toISOString();
  const active = jobs.some((job) => job.status === "queued" || job.status === "running");
  const verdict = pastRestoresVerdict(jobs, now);

  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={now} section="Restore" title={TITLE} />
      <Verdict action={verdict.href ? { label: "Open it", href: verdict.href } : null} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        {onlyFailed && !failedJobs ? (
          <p className="action-error">KEEL could not read the failed restores. Reload in a minute; the list below shows every recent restore and check.</p>
        ) : null}
        {onlyFailed && failedJobs ? (
          <JobTable
            empty="No restore has failed."
            headingId="restore-jobs-heading"
            jobs={failedJobs}
            link={{ label: "All restores and checks", href: "/restore/past-restores#restore-jobs-heading" }}
            now={now}
            title="Failed restores"
            total={failedRestores?.total}
          />
        ) : (
          <JobTable headingId="restore-jobs-heading" jobs={jobs} now={now} title="Restores and checks" />
        )}
      </div>
      <JobRefresher active={active} />
    </>
  );
}
