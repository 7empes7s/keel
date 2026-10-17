import { guarded } from "@/lib/action";
import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { getWorkloadChoices, pageRestorable } from "@/lib/restore-workload-choices";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;

// The Restore page's first step for Exchange, Teams and Purview: the backups of one
// workload and every object the chosen one holds, with what KEEL can put back.
const getWorkloadChoicesRoute = guarded(
  { action: "restore:workload-choices", capability: "restore" },
  async ({ client, tenantRef, request }) => {
    const url = new URL(request.url);
    const workload = url.searchParams.get("workload") ?? "";
    const collection = url.searchParams.get("collection");
    if (!pageRestorable(workload)) {
      return Response.json({ error: "this service is not restored from the Restore page" }, { status: 400, headers: NO_STORE });
    }
    const choices = await getWorkloadChoices(client, tenantRef, workload, collection || null);
    if (!choices) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    return Response.json({ choices }, { headers: NO_STORE });
  },
);

export const GET = guardedRead(
  DATA_SURFACES.restoreWorkloadChoicesApi,
  getWorkloadChoicesRoute,
);
