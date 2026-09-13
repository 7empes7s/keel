import { getJobData } from "@/lib/portal-jobs";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedRead(DATA_SURFACES.jobApi, async (request) => {
  try {
    const id = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
    const job = await getJobData(id);
    if (!job) {
      return Response.json(
        { error: "not_found" },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json({ job }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[keel-portal] job data request failed", error);
    return Response.json(
      { error: "data_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
});
