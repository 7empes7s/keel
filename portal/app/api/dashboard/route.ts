import { dataResponse } from "@/lib/api-response";
import { getDashboardData } from "@/lib/portal-data";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedRead(
  DATA_SURFACES.dashboardApi,
  async () => dataResponse(getDashboardData),
);
