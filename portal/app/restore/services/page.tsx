import { connection } from "next/server";
import { headers } from "next/headers";

import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { WorkloadServices } from "@/components/restore/workload-services";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { getRestoreWorkloads, type RestoreWorkload } from "@/lib/restore-workloads";
import { servicesVerdict } from "@/lib/restore-workloads-view";

const SERVICES_TITLE = "Exchange, Teams and more";
const SERVICES_DESCRIPTION = "Put back Exchange, SharePoint, OneDrive, Teams, Purview and Power Platform settings. Each service is backed up on its own, and someone else approves before anything changes.";

// Restore › Exchange, Teams and more: the services backed up as their own collections,
// not in the tenant backup that Restore configurations lists.
export default async function RestoreServicesPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.restoreServicesPage);
  const capabilities = ((await headers()).get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);
  const canRestore = capabilities.includes("restore");

  // If they cannot be read, the section says so in one line.
  let workloads: RestoreWorkload[] | null;
  try {
    workloads = await getRestoreWorkloads();
  } catch {
    workloads = null;
  }
  const now = new Date().toISOString();
  const verdict = workloads ? servicesVerdict(workloads) : null;

  return (
    <>
      <PageHeader
        description={SERVICES_DESCRIPTION}
        generatedAt={now}
        marker={canRestore ? undefined : "Read-only"}
        section="Restore"
        title={SERVICES_TITLE}
      />
      {verdict ? <Verdict text={verdict.text} tone={verdict.tone} /> : null}
      <WorkloadServices canApprove={capabilities.includes("approve")} canRestore={canRestore} now={now} workloads={workloads} />
    </>
  );
}
