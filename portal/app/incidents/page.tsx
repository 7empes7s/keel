import { connection } from "next/server";
import { headers } from "next/headers";

import { DataUnavailable } from "@/components/data-unavailable";
import { IncidentsPage } from "@/components/incidents/incidents-page";
import { PageHeader } from "@/components/page-header";
import { DESCRIPTION, incidentStatus } from "@/lib/incidents-view";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { getIncidentRecoveryData, type IncidentRecoveryData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

// Roadmap task-71: incident-qualified recovery points and retention pins. Reading
// needs `read`; every change goes through /api/actions/incidents, which requires the
// investigator's `investigate` capability and is re-checked in the engine.
export default async function IncidentsRoute({
  searchParams,
}: {
  searchParams: Promise<{ incident?: string }>;
}) {
  await connection();
  await requireReadAccess(DATA_SURFACES.incidentsPage);
  const capabilities = ((await headers()).get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);
  const canInvestigate = capabilities.includes("investigate");
  const marker = canInvestigate ? undefined : "Read-only";

  let data: IncidentRecoveryData;
  try {
    data = await getIncidentRecoveryData((await searchParams).incident);
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} marker={marker} section="Restore" title="Incidents" />
        <DataUnavailable surface="Incident data" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        description={DESCRIPTION}
        generatedAt={data.generatedAt}
        marker={marker}
        section="Restore"
        status={incidentStatus(data.incidents, data.selected)}
        title="Incidents"
      />
      <IncidentsPage canInvestigate={canInvestigate} incidents={data.incidents} now={data.generatedAt} selected={data.selected} />
    </>
  );
}
