import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { GET as loadJob } from "@/app/api/jobs/[id]/route";
import { CompensationPanel } from "@/components/compensation-panel";
import { DataUnavailable } from "@/components/data-unavailable";
import { JobDetail, jobVerdict } from "@/components/job-detail";
import { JobRefresher } from "@/components/job-refresher";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { RecoveryCompletion } from "@/components/recovery-completion";
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
    return <><PageHeader section="Activity" title="Job" description="What this job did and how it ended." /><DataUnavailable surface="This job" /></>;
  }
  if (!job) notFound();
  const now = new Date().toISOString();
  // Roadmap task-65: an enforced restore (it always promotes a dry-run artifact)
  // shows the follow-up work the restore could not do itself.
  const jobParams = (job.params ?? {}) as Record<string, unknown>;
  const restoreRef = job.kind === "restore" && typeof jobParams.artifactId === "string" ? jobParams.artifactId : null;
  const capabilities = ((await headers()).get(CAPABILITIES_HEADER) ?? "").split(" ");
  const canComplete = capabilities.includes("restore");
  // Roadmap task-70: an enforced restore (succeeded or failed) can be undone; a
  // compensation dry-run job shows the undo plan it computed.
  const compensates = restoreRef && typeof jobParams.compensates === "string" ? jobParams.compensates : null;
  const enforced = restoreRef && jobParams.mode === "enforce" && (job.status === "succeeded" || job.status === "failed");
  return (
    <>
      <PageHeader section="Activity" title="Job" description="What this job did and how it ended." generatedAt={now} />
      <Verdict text={jobVerdict(job, now)} tone={job.status === "failed" ? "critical" : job.status === "succeeded" ? "good" : "attention"} />
      <Link className="text-link back-link" href="/activity"><span aria-hidden="true">←</span> All activity</Link>
      <JobDetail job={job} now={now} />
      {restoreRef && !compensates && job.status === "succeeded" ? <RecoveryCompletion canComplete={canComplete} restoreRef={restoreRef} /> : null}
      {enforced && restoreRef ? (
        <CompensationPanel canApprove={capabilities.includes("approve")} canRestore={canComplete} failed={job.status === "failed"} restoreArtifactId={restoreRef} />
      ) : null}
      {compensates && job.status === "succeeded" ? (
        <CompensationPanel canApprove={capabilities.includes("approve")} canRestore={canComplete} compensationArtifactId={restoreRef} failed={false} restoreArtifactId={compensates} />
      ) : null}
      <JobRefresher active={job.status === "queued" || job.status === "running"} />
    </>
  );
}
