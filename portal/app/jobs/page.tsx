import { headers } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";

import { GET as loadJobs } from "@/app/api/jobs/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { JobRefresher } from "@/components/job-refresher";
import { JobTable } from "@/components/job-table";
import { PageHeader } from "@/components/page-header";
import type { JobsData } from "@/lib/portal-jobs";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

export default async function JobsPage({ searchParams }: {
  searchParams: Promise<{ limit?: string }>;
}) {
  await connection();
  await requireReadAccess(DATA_SURFACES.jobsPage);
  const requestedLimit = Number((await searchParams).limit ?? 50);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit : 50;
  let data: JobsData;
  try {
    // Invoke the existing API handler with verified downstream headers, without an
    // HTTP round trip or a second, unguarded database loader.
    const response = await loadJobs(new Request(`http://localhost/api/jobs?limit=${limit}`, {
      headers: await headers(),
    }));
    if (!response.ok) throw new Error("Job history unavailable");
    data = await response.json() as JobsData;
  } catch {
    return <><PageHeader section="Activity" title="Jobs" description="Job history and outcomes, newest first." /><DataUnavailable surface="Job history" /></>;
  }
  return (
    <>
      <PageHeader section="Activity" title="Jobs" description="Job history and outcomes, newest first." generatedAt={data.generatedAt} />
      <JobTable headingId="jobs-heading" jobs={data.jobs} kicker="Queue" title="Recent jobs" />
      {data.jobs.length === limit ? <Link className="secondary-action" href={`/jobs?limit=${limit + 50}`}>Load 50 more jobs</Link> : null}
      <JobRefresher active={data.jobs.some((job) => job.status === "queued" || job.status === "running")} />
    </>
  );
}
