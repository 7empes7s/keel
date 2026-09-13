import { dataResponse } from "@/lib/api-response";
import { getJobsData } from "@/lib/portal-jobs";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedRead(
  DATA_SURFACES.jobsApi,
  async () => dataResponse(getJobsData),
);
