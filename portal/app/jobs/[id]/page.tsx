import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { GET as loadJob } from "@/app/api/jobs/[id]/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { JobDetail } from "@/components/job-detail";
import { JobRefresher } from "@/components/job-refresher";
import { PageHeader } from "@/components/page-header";
import type { JobRecord } from "@/lib/portal-jobs";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  await requireReadAccess(DATA_SURFACES.jobPage);
  const { id } = await params;
  let job: JobRecord | null = null;
  try {
    const response = await loadJob(new Request(`http://localhost/api/jobs/${encodeURIComponent(id)}`, {
      headers: await headers(),
    }));
    if (response.status !== 404) {
      if (!response.ok) throw new Error("Job unavailable");
      job = (await response.json() as { job: JobRecord }).job;
    }
  } catch {
    return <><PageHeader eyebrow="Operations" title="Job details" description="Job execution and outcome." /><DataUnavailable surface="Job details" /></>;
  }
  if (!job) notFound();
  return (
    <>
      <PageHeader eyebrow="Operations" title="Job details" description={job.id} />
      <Link className="text-link back-link" href="/jobs"><span aria-hidden="true">←</span> All jobs</Link>
      <JobDetail job={job} />
      <JobRefresher active={job.status === "queued" || job.status === "running"} />
    </>
  );
}
