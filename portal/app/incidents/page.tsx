import { connection } from "next/server";
import { headers } from "next/headers";

import { DataUnavailable } from "@/components/data-unavailable";
import { IncidentRecovery } from "@/components/incident-recovery";
import { PageHeader } from "@/components/page-header";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { getIncidentRecoveryData, type IncidentRecoveryData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

// Roadmap task-71: incident-qualified recovery points and retention pins. Reading
// needs `read`; every change goes through /api/actions/incidents, which requires the
// investigator's `investigate` capability and is re-checked in the engine.
export default async function IncidentsPage({
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
  const description = "During a security incident, restore from a snapshot an investigator has checked, not simply the newest one.";

  let data: IncidentRecoveryData;
  try {
    data = await getIncidentRecoveryData((await searchParams).incident);
  } catch {
    return (
      <>
        <PageHeader description={description} eyebrow="Recovery" marker={canInvestigate ? "Actionable" : "Read-only"} title="Incidents" />
        <DataUnavailable surface="Incident data" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        description={description}
        eyebrow="Recovery"
        generatedAt={data.generatedAt}
        marker={canInvestigate ? "Actionable" : "Read-only"}
        title="Incidents"
      />
      <IncidentRecovery canInvestigate={canInvestigate} incidents={data.incidents} now={data.generatedAt} selected={data.selected} />
    </>
  );
}
