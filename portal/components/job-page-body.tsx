import Link from "next/link";

import { CompensationPanel } from "@/components/compensation-panel";
import { JobDetail, jobVerdict } from "@/components/job-detail";
import { JobRefresher } from "@/components/job-refresher";
import { RecoveryCompletion } from "@/components/recovery-completion";
import { Verdict } from "@/components/verdict";
import type { JobRecord } from "@/lib/portal-jobs";

// The Job page below its header, shared by the route and the UI harness: the verdict,
// the job itself (alerts first), then a restore's follow-ups and its undo.
export function JobPageBody({ job, now, capabilities }: { job: JobRecord; now: string; capabilities: string[] }) {
  // Roadmap task-65: an enforced restore (it always promotes a dry-run artifact)
  // shows the follow-up work the restore could not do itself.
  const params = (job.params ?? {}) as Record<string, unknown>;
  const restoreRef = job.kind === "restore" && typeof params.artifactId === "string" ? params.artifactId : null;
  const canRestore = capabilities.includes("restore");
  // Roadmap task-70: an enforced restore (succeeded or failed) can be undone; a
  // compensation dry-run job shows the undo plan it computed.
  const compensates = restoreRef && typeof params.compensates === "string" ? params.compensates : null;
  const enforced = restoreRef && params.mode === "enforce" && (job.status === "succeeded" || job.status === "failed");
  return (
    <>
      <Verdict text={jobVerdict(job, now)} tone={job.status === "failed" ? "critical" : job.status === "succeeded" ? "good" : "attention"} />
      <Link className="text-link back-link" href="/activity"><span aria-hidden="true">←</span> All activity</Link>
      <JobDetail job={job} now={now} />
      {restoreRef && !compensates && job.status === "succeeded" ? <RecoveryCompletion canComplete={canRestore} restoreRef={restoreRef} /> : null}
      {enforced && restoreRef ? (
        <CompensationPanel canApprove={capabilities.includes("approve")} canRestore={canRestore} failed={job.status === "failed"} restoreArtifactId={restoreRef} />
      ) : null}
      {compensates && job.status === "succeeded" ? (
        <CompensationPanel canApprove={capabilities.includes("approve")} canRestore={canRestore} compensationArtifactId={restoreRef} failed={false} restoreArtifactId={compensates} />
      ) : null}
      <JobRefresher active={job.status === "queued" || job.status === "running"} />
    </>
  );
}
