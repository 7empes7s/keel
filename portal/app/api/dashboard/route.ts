import { dataResponse } from "@/lib/api-response";
import { getDashboardData } from "@/lib/portal-data";
import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { singleFlight } from "@/lib/single-flight";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Every open tab's menu polls this; reads that overlap share one database read.
const readDashboard = singleFlight(getDashboardData);

export const GET = guardedRead(
  DATA_SURFACES.dashboardApi,
  async () => dataResponse(readDashboard),
);
