import { headers } from "next/headers";
import { connection } from "next/server";
import { GET as loadSchedules } from "@/app/api/schedules/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { ScheduleTable } from "@/components/schedule-table";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { SchedulesData } from "@/lib/schedules";

export default async function SchedulesPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.schedulesPage);
  let data: SchedulesData;
  try {
    const response = await loadSchedules(new Request("http://localhost/api/schedules", { headers: await headers() }));
    if (!response.ok) throw new Error("Schedules unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader section="Protect" title="Schedules" description="Collection and maintenance cadence." /><DataUnavailable surface="Schedules" /></>;
  }
  return <>
    <PageHeader section="Protect" title="Schedules" description="Collection and maintenance cadence. Run times are shown in UTC." generatedAt={data.generatedAt} />
    <ScheduleTable schedules={data.schedules} deferrals={data.deferrals} canEdit={access.capabilities.includes("configuration")} />
  </>;
}
