import { headers } from "next/headers";
import { connection } from "next/server";
import { GET as loadIntegrations } from "@/app/api/integrations/route";
import { PageHeader } from "@/components/page-header";
import { DataUnavailable } from "@/components/data-unavailable";
import { IntegrationConsole } from "@/components/integration-console";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { Destination, DestinationStatus } from "@/lib/integrations";

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
    return <><PageHeader section="Settings" title="Integrations" description="Generic webhook and CEF SIEM export destinations." /><DataUnavailable surface="Integrations" /></>;
  }
  return <>
    <PageHeader section="Settings" title="Integrations" description="Generic webhook and CEF SIEM export destinations." generatedAt={generatedAt} />
    <IntegrationConsole canConfiguration={canConfiguration} destinations={destinations} statuses={statuses} />
  </>;
}
