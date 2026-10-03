import { headers } from "next/headers";
import { connection } from "next/server";
import { GET as loadSchedules } from "@/app/api/schedules/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { ScheduleTable, schedulesVerdict } from "@/components/schedule-table";
import { Verdict } from "@/components/verdict";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { SchedulesData } from "@/lib/schedules";

const DESCRIPTION = "When KEEL backs up each tier and runs its upkeep. Times are in UTC.";

export default async function SchedulesPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.schedulesPage);
  let data: SchedulesData;
  try {
    const response = await loadSchedules(new Request("http://localhost/api/schedules", { headers: await headers() }));
    if (!response.ok) throw new Error("Schedules unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader section="Protect" title="Schedules" description={DESCRIPTION} /><DataUnavailable surface="Schedules" /></>;
  }
  const verdict = schedulesVerdict(data.schedules, data.generatedAt);
  return <>
    <PageHeader section="Protect" title="Schedules" description={DESCRIPTION} generatedAt={data.generatedAt} />
    <Verdict text={verdict.text} tone={verdict.tone} />
    <div data-layer="explanation">
      <ScheduleTable schedules={data.schedules} deferrals={data.deferrals} canEdit={access.capabilities.includes("configuration")} now={data.generatedAt} />
    </div>
  </>;
}
