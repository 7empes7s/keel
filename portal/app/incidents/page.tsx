import { connection } from "next/server";
import { headers } from "next/headers";

import { DataUnavailable } from "@/components/data-unavailable";
import { IncidentsPage } from "@/components/incidents/incidents-page";
import { PageHeader } from "@/components/page-header";
import { DESCRIPTION, incidentStatus } from "@/lib/incidents-view";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { getContacts, getIncidentRecoveryData, type IncidentRecoveryData } from "@/lib/portal-data";
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
  const access = await requireReadAccess(DATA_SURFACES.incidentsPage);
  const requestHeaders = await headers();
  const capabilities = (requestHeaders.get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);
  const canInvestigate = capabilities.includes("investigate");
  const marker = canInvestigate ? undefined : "Read-only";
  // A reader who is not an investigator is told who is (D12). People needs `users`;
  // adding a role needs `roles`, so only an admin gets "Give yourself the role".
  const me = access.principalId;
  const canPeople = capabilities.includes("users");
  const grantHref = !canInvestigate && canPeople && capabilities.includes("roles") && me ? `/principals?open=${encodeURIComponent(me)}` : null;
  const investigatorsHref = !canInvestigate && canPeople ? "/principals?role=investigator" : null;
  const contacts = canInvestigate ? null : await getContacts(me);

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
      <IncidentsPage canInvestigate={canInvestigate} contacts={contacts} grantHref={grantHref} incidents={data.incidents} investigatorsHref={investigatorsHref} now={data.generatedAt} selected={data.selected} />
    </>
  );
}
