import { headers } from "next/headers";
import { connection } from "next/server";
import { GET as loadIntegrations } from "@/app/api/integrations/route";
import { GET as loadServiceNow } from "@/app/api/integrations/servicenow/route";
import { PageHeader } from "@/components/page-header";
import { DataUnavailable } from "@/components/data-unavailable";
import { IntegrationConsole } from "@/components/integration-console";
import { ServiceNowPanel } from "@/components/servicenow-panel";
import { Verdict } from "@/components/verdict";
import { integrationsPageVerdict } from "@/lib/integrations-view";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { Destination, DestinationStatus } from "@/lib/integrations";
import type { ServiceNowStatus } from "@/lib/servicenow";

const DESCRIPTION = "Where KEEL copies its audit record, and where approvals can also be decided.";

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
  // ServiceNow is a second, independent reader: if it fails, the destinations still show.
  let servicenow: ServiceNowStatus | null = null;
  try {
    const response = await loadServiceNow(new Request("http://localhost/api/integrations/servicenow", { headers: requestHeaders }));
    if (response.ok) ({ servicenow } = await response.json());
  } catch {
    servicenow = null;
  }
  const verdict = integrationsPageVerdict(destinations, statuses, servicenow);
  return <>
    <PageHeader section="Settings" title="Integrations" description={DESCRIPTION} generatedAt={generatedAt} />
    <Verdict text={verdict.text} tone={verdict.tone} />
    <div data-layer="explanation">
      {servicenow ? <ServiceNowPanel status={servicenow} /> : <DataUnavailable surface="ServiceNow approvals" />}
      <IntegrationConsole canConfiguration={canConfiguration} destinations={destinations} statuses={statuses} />
    </div>
  </>;
}
