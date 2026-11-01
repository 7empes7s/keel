import { getChangeAttribution } from "@/lib/portal-data";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Who made one open change, read from the audit log when a person opens it on Changes.
// GET /api/drift/attribution?id=<change id>. 404 for a change that is not open or is
// outside the reader's entities; { attribution: null } when the audit read failed.
export const GET = guardedRead(DATA_SURFACES.driftAttributionApi, async (request, access) => {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  try {
    const found = await getChangeAttribution(id, access.scope);
    if (!found) return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
    return Response.json(found, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[keel-portal] change attribution lookup failed", error);
    return Response.json({ error: "data_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
});
