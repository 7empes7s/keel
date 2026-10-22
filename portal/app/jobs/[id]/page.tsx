import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { GET as loadJob } from "@/app/api/jobs/[id]/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { JobPageBody } from "@/components/job-page-body";
import { PageHeader } from "@/components/page-header";
import { CAPABILITIES_HEADER } from "@/lib/principal";
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
    return <><PageHeader section="Audit log" title="Job" description="What this job did and how it ended." /><DataUnavailable surface="This job" /></>;
  }
  if (!job) notFound();
  const now = new Date().toISOString();
  const capabilities = ((await headers()).get(CAPABILITIES_HEADER) ?? "").split(" ");
  return (
    <>
      <PageHeader section="Audit log" title="Job" description="What this job did and how it ended." generatedAt={now} />
      <JobPageBody capabilities={capabilities} job={job} now={now} />
    </>
  );
}
