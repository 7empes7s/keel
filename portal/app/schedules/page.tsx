import { headers } from "next/headers";
import { connection } from "next/server";
import { GET as loadSchedules } from "@/app/api/schedules/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { SchedulesPage as SchedulesBody } from "@/components/schedules/schedules-page";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { businessTimeZone } from "@/lib/runtime-config";
import type { SchedulesData } from "@/lib/schedules";
import { scheduleCounts, schedulesStatus } from "@/lib/schedules-view";

const DESCRIPTION = "When Keel backs up and tidies up, and how hard each backup works Microsoft.";

// Schedules (portal audit, one design). Viewing needs read; editing, turning on or off
// and accepting a load warning show only with `configuration`, Run now only with
// `collect`, and each route checks again.
export default async function SchedulesPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.schedulesPage);
  let data: SchedulesData;
  try {
    const response = await loadSchedules(new Request("http://localhost/api/schedules", { headers: await headers() }));
    if (!response.ok) throw new Error("Schedules unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader section="Backup" title="Schedules" description={DESCRIPTION} /><DataUnavailable surface="Schedules" /></>;
  }
  return <>
    <PageHeader section="Backup" title="Schedules" description={DESCRIPTION} generatedAt={data.generatedAt} status={schedulesStatus(scheduleCounts(data.schedules, data.forecasts))} />
    <SchedulesBody
      canEdit={access.capabilities.includes("configuration")}
      canRun={access.capabilities.includes("collect")}
      deferrals={data.deferrals}
      forecasts={data.forecasts}
      now={data.generatedAt}
      schedules={data.schedules}
      timeZone={businessTimeZone()}
    />
  </>;
}
