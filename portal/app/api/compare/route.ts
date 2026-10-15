import { dataResponse } from "@/lib/api-response";
import { getCompareData } from "@/lib/compare";
import { compareInputFrom } from "@/lib/compare-view";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Wave 2 CMP: GET /api/compare?from=<snapshot id>&to=<snapshot id>. Without both, the
// two newest snapshots of this tenant. Read-only.
export const GET = guardedRead(
  DATA_SURFACES.compareApi,
  async (request) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    return dataResponse(() => getCompareData(compareInputFrom(params)));
  },
);
