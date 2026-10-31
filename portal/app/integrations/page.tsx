import { headers } from "next/headers";
import { connection } from "next/server";
import { GET as loadIntegrations } from "@/app/api/integrations/route";
import { GET as loadServiceNow } from "@/app/api/integrations/servicenow/route";
import { GET as loadIntegrity } from "@/app/api/evidence/verify/route";
import { auditCheckOf, type AuditCheck } from "@/lib/audit-check";
import type { ChainIntegrity } from "@/lib/evidence";
import { PageHeader } from "@/components/page-header";
import { DataUnavailable } from "@/components/data-unavailable";
import { Verdict } from "@/components/verdict";
import { integrationAlerts, integrationsPageVerdict, integrationsStatus } from "@/lib/integrations-view";
import { IntegrationsBody } from "@/components/integrations-body";
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
  // The audit record's check, as Activity reads it; if it fails to load, the page says nothing about it.
  let record: AuditCheck = "unknown";
  try {
    const response = await loadIntegrity(new Request("http://localhost/api/evidence/verify", { headers: requestHeaders }));
    if (response.ok) record = auditCheckOf(await response.json() as ChainIntegrity);
  } catch {
    record = "unknown";
  }
  const verdict = integrationsPageVerdict(destinations, statuses, servicenow, record);
  const alerts = integrationAlerts(destinations, statuses, servicenow, record);
  return <>
    <PageHeader section="Settings" title="Integrations" description={DESCRIPTION} generatedAt={generatedAt} status={integrationsStatus(alerts)} />
    <Verdict action={alerts.some((alert) => alert.tone !== "low") ? { label: "See what to fix", href: "#ig-attention" } : null} text={verdict.text} tone={verdict.tone} />
    <div data-layer="explanation">
      <IntegrationsBody alerts={alerts} canConfiguration={canConfiguration} destinations={destinations} servicenow={servicenow} statuses={statuses} />
    </div>
  </>;
}
