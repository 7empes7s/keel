import { dataResponse } from "@/lib/api-response";
import { getMenuStatusData } from "@/lib/portal-data";
import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { singleFlight } from "@/lib/single-flight";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The menu's badges, polled by every open tab: only the figures they read. Reads that
// overlap share one database read.
const readMenuStatus = singleFlight(getMenuStatusData);

export const GET = guardedRead(
  DATA_SURFACES.menuStatusApi,
  async () => dataResponse(readMenuStatus),
);
