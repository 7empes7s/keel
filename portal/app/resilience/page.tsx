import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { ResilienceView } from "@/components/resilience-view";
import { Verdict } from "@/components/verdict";
import { getResilienceData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { pageVerdict, resilienceAlerts, resilienceStatus, verdictAction, type ResilienceData } from "@/lib/resilience-view";

const DESCRIPTION = "Could KEEL get your Microsoft 365 setup back if its server were lost, and how fast.";

// Roadmap task-73: measured recovery point and recovery time. Reading needs `read`;
// the guard runs before any loader, and the engine reader is pinned to this tenant.
export default async function ResiliencePage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.resiliencePage);
  let data: ResilienceData;
  try {
    data = await getResilienceData();
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Restore" title="Resilience" /><DataUnavailable surface="Recovery measurements" /></>;
  }
  const alerts = resilienceAlerts(data);
  const verdict = pageVerdict(data.metrics, data.generatedAt, alerts);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Restore" status={resilienceStatus(data.metrics, alerts)} title="Resilience" />
      <Verdict action={verdictAction(verdict, alerts)} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <ResilienceView data={data} />
      </div>
    </>
  );
}
