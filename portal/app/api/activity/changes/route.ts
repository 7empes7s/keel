import { dataResponse } from "@/lib/api-response";
import { changesRequestFrom, getActivityChanges } from "@/lib/activity-changes";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/activity/changes?job=<job id>, ?drift=<change id> or ?record=<audit entry
// number of a rule edit or delete>: the settings one
// Activity row changed, before and after. Read-only; null when the row changed none
// Keel can show.
export const GET = guardedRead(
  DATA_SURFACES.activityChangesApi,
  async (request) => {
    const wanted = changesRequestFrom(new URL(request.url).searchParams);
    if (!wanted) return Response.json({ error: "job_or_drift_required" }, { status: 400, headers: { "cache-control": "no-store" } });
    return dataResponse(async () => ({ changes: await getActivityChanges(wanted) }));
  },
);
