import { headers } from "next/headers";
import { connection } from "next/server";
import { GET as loadIntegrations } from "@/app/api/integrations/route";
import { PageHeader } from "@/components/page-header";
import { DataUnavailable } from "@/components/data-unavailable";
import { IntegrationConsole } from "@/components/integration-console";
import { Verdict } from "@/components/verdict";
import { integrationsVerdict } from "@/lib/integrations-view";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { Destination, DestinationStatus } from "@/lib/integrations";

const DESCRIPTION = "Where KEEL copies its audit record: SIEM and webhook destinations.";

export default async function IntegrationsPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.integrationsPage);
  const canConfiguration = access.capabilities.includes("configuration");
  const requestHeaders = await headers();
  let destinations: Destination[];
  let statuses: DestinationStatus[];
  let generatedAt: string;
  try {
    const response = await loadIntegrations(new Request("http://localhost/api/integrations", { headers: requestHeaders }));
    if (!response.ok) throw new Error("Integrations unavailable");
    ({ destinations, statuses, generatedAt } = await response.json());
  } catch {
    return <><PageHeader section="Settings" title="Integrations" description={DESCRIPTION} /><DataUnavailable surface="Integrations" /></>;
  }
  return <>
    <PageHeader section="Settings" title="Integrations" description={DESCRIPTION} generatedAt={generatedAt} />
    <Verdict text={integrationsVerdict(destinations, statuses)} tone={statuses.some((status) => status.quarantined > 0) ? "attention" : "good"} />
    <div data-layer="explanation">
      <IntegrationConsole canConfiguration={canConfiguration} destinations={destinations} statuses={statuses} />
    </div>
  </>;
}
