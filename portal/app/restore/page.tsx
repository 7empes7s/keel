import { connection } from "next/server";
import { headers } from "next/headers";

import { DataUnavailable } from "@/components/data-unavailable";
import { JobRefresher } from "@/components/job-refresher";
import { JobTable } from "@/components/job-table";
import { PageHeader } from "@/components/page-header";
import { RestoreSelection } from "@/components/restore-selection";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import {
  getIncidentSummary,
  getRestoreResources,
  type RestoreResourcesData,
} from "@/lib/portal-data";
import {
  getRecentJobs,
  getRestoreSnapshotOptions,
  type JobRecord,
  type SnapshotOption,
} from "@/lib/portal-jobs";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const RESTORE_JOB_KINDS = ["restore"];

// Plan task 17 (portal-design §4.1): the restore surface. Selection here is
// dependency-closed — the page lists a snapshot's resources, the client component
// previews every change against /api/actions/restore/selection, and the submit goes
// to the approval-gated /api/actions/restore. UI gating is a convenience only; both
// endpoints re-check the restore capability server-side.
export default async function RestorePage({
  searchParams,
}: {
  searchParams: Promise<{ snapshot?: string; incident?: string }>;
}) {
  await connection();
  await requireReadAccess(DATA_SURFACES.restorePage);
  const capabilities = ((await headers()).get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);
  const canRestore = capabilities.includes("restore");
  const { snapshot: requestedSnapshot, incident: requestedIncident } = await searchParams;

  let snapshots: SnapshotOption[];
  let jobs: JobRecord[];
  let resourceData: RestoreResourcesData | null = null;
  let snapshotId: string | null = null;
  let incident: { id: string; title: string } | null = null;
  try {
    [snapshots, jobs] = await Promise.all([
      getRestoreSnapshotOptions(),
      getRecentJobs(RESTORE_JOB_KINDS),
    ]);
    snapshotId = requestedSnapshot !== undefined
      && snapshots.some((snapshot) => snapshot.id === requestedSnapshot)
      ? requestedSnapshot
      : snapshots[0]?.id ?? null;
    if (snapshotId) {
      resourceData = await getRestoreResources(snapshotId);
    }
    // Roadmap task-71: a restore planned from the Incidents page carries its incident.
    if (requestedIncident) incident = await getIncidentSummary(requestedIncident);
  } catch {
    return (
      <>
        <PageHeader
          description="Dependency-closed restore from a snapshot, requiring approval before anything runs."
          section="Restore"
          marker={canRestore ? "Actionable" : "Read-only"}
          title="Restore"
        />
        <DataUnavailable surface="Restore data" />
      </>
    );
  }

  const jobsActive = jobs.some(
    (job) => job.status === "queued" || job.status === "running",
  );

  return (
    <>
      <PageHeader
        description="Dependency-closed restore from a snapshot. Selecting a resource also selects everything it references — the closure is shown, never hidden — and a restore only runs after approval."
        section="Restore"
        generatedAt={resourceData?.generatedAt ?? new Date().toISOString()}
        marker={canRestore ? "Actionable" : "Read-only"}
        title="Restore"
      />

      {/* Roadmap task-71: incident recovery belongs to Restore in the portal map. */}
      {incident ? null : (
        <p className="restore-incident-link" data-layer="explanation">
          Recovering from a security incident? <a href="/incidents">Choose a snapshot an investigator has checked</a>.
        </p>
      )}

      {snapshotId && resourceData ? (
        <RestoreSelection
          canApprove={capabilities.includes("approve")}
          canRestore={canRestore}
          incident={incident}
          key={`${snapshotId}:${incident?.id ?? ""}`}
          resources={resourceData.resources}
          snapshotId={snapshotId}
          snapshots={snapshots}
        />
      ) : (
        <section className="report-section">
          <p className="empty-state">
            No completed snapshots are available. Run a collection before planning a restore.
          </p>
        </section>
      )}

      <JobTable
        headingId="restore-jobs-heading"
        jobs={jobs}
        kicker="Queue"
        title="Restore jobs"
      />
      <JobRefresher active={jobsActive} />
    </>
  );
}
