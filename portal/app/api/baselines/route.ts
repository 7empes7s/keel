import { dataResponse } from "@/lib/api-response";
import { getBaselinesData } from "@/lib/portal-data";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedRead(
  DATA_SURFACES.baselinesApi,
  async () => dataResponse(getBaselinesData),
);
