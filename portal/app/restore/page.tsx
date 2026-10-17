import { connection } from "next/server";
import { headers } from "next/headers";

import { DataUnavailable } from "@/components/data-unavailable";
import { JobRefresher } from "@/components/job-refresher";
import { JobTable } from "@/components/job-table";
import { PageHeader } from "@/components/page-header";
import { RestoreFollowUps } from "@/components/restore-follow-ups";
import { RestoreSelection } from "@/components/restore-selection";
import { Verdict } from "@/components/verdict";
import { WorkloadServices } from "@/components/restore/workload-services";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import {
  getIncidentSummary,
  getRestoreFollowUps,
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
import { getRestoreChanges, type RestoreChangesData } from "@/lib/restore-changes";
import { lastRestoreTile } from "@/lib/restore-view";
import { getRestoreWorkloads, type RestoreWorkload } from "@/lib/restore-workloads";
import type { RestoreFollowUp } from "@/lib/types";

const RESTORE_JOB_KINDS = ["restore"];
const DESCRIPTION = "Put settings back as they were in a backup. Pick the day, choose what to undo, and someone else approves before anything changes.";

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
          description={DESCRIPTION}
          section="Restore"
          marker={canRestore ? "Actionable" : "Read-only"}
          title="Restore"
        />
        <DataUnavailable surface="Restore data" />
      </>
    );
  }

  // Secondary: what changed since the chosen backup. Without it the page still lists
  // the backup's settings and says it could not compare.
  let changes: RestoreChangesData | null = null;
  if (snapshotId) {
    try {
      changes = await getRestoreChanges(snapshotId);
    } catch {
      changes = null;
    }
  }

  // Secondary: the other Microsoft 365 services (Exchange, SharePoint, Teams, Purview,
  // Power Platform) are backed up as workload collections, not in the snapshot.
  let workloads: RestoreWorkload[] | null;
  try {
    workloads = await getRestoreWorkloads();
  } catch {
    workloads = null;
  }

  // Secondary: if it cannot be read, the page still works and says so.
  let followUps: RestoreFollowUp[] | null;
  try {
    followUps = await getRestoreFollowUps();
  } catch {
    followUps = null;
  }

  const jobsActive = jobs.some(
    (job) => job.status === "queued" || job.status === "running",
  );

  const now = resourceData?.generatedAt ?? new Date().toISOString();
  const changeCount = changes ? changes.changes.length + changes.more : 0;
  const status = !snapshotId
    ? { tone: "urgent" as const, label: "No backup yet" }
    : changeCount
      ? { tone: "soon" as const, label: "Changes to review" }
      : { tone: "fine" as const, label: "Backups ready" };

  return (
    <>
      <PageHeader
        description={DESCRIPTION}
        section="Restore"
        generatedAt={now}
        marker={canRestore ? undefined : "Read-only"}
        status={status}
        title="Restore"
      />

      {/* Roadmap task-71: incident recovery belongs to Restore in the portal map. */}
      {incident ? null : (
        <p className="restore-incident-link" data-layer="explanation">
          Recovering from a security incident? <a href="/incidents">Choose a backup an investigator has checked</a>.
        </p>
      )}

      {snapshotId && resourceData ? (
        <RestoreSelection
          canApprove={capabilities.includes("approve")}
          canRestore={canRestore}
          changes={changes}
          incident={incident}
          key={`${snapshotId}:${incident?.id ?? ""}`}
          lastRestore={lastRestoreTile(jobs, now)}
          now={now}
          resources={resourceData.resources}
          snapshotId={snapshotId}
          snapshots={snapshots}
        />
      ) : (
        <>
          <Verdict
            action={{ label: "Back up now", href: "/protect" }}
            text="Nothing to restore from yet: KEEL holds no backup of this tenant."
            tone="attention"
          />
          <section className="report-section" data-layer="explanation">
            <p className="empty-state">
              No finished backups yet. Run a backup before planning a restore.
            </p>
          </section>
        </>
      )}

      <WorkloadServices canApprove={capabilities.includes("approve")} canRestore={canRestore} now={now} workloads={workloads} />

      <div data-layer="explanation">
        {followUps === null
          ? <p className="action-error">KEEL could not read the follow-up steps restores left open. Reload in a minute.</p>
          : <RestoreFollowUps followUps={followUps} now={resourceData?.generatedAt ?? new Date().toISOString()} />}
        <JobTable
          headingId="restore-jobs-heading"
          jobs={jobs}
          kicker="Recent"
          now={now}
          title="Restores and checks"
        />
      </div>
      <JobRefresher active={jobsActive} />
    </>
  );
}
