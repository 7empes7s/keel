import { getDryRunArtifact } from "../../../../../../../engine/restore/dryRunArtifact.mjs";

import { guarded } from "@/lib/action";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Plan task 8, step 2: lets the portal render a dry run's actual planned changes and
// refusals once the worker has computed it, so confirmation reviews the SAME artifact
// that promotion will later reference — never a client-side guess at what the dry run
// found. Read-only and tenant-scoped: an artifact from another tenant is
// indistinguishable from one that does not exist.
const getDryRunArtifactRoute = guarded(
  { action: "restore:dry-run-show", capability: "restore" },
  async ({ client, tenantRef, request }) => {
    const id = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
    if (!UUID_PATTERN.test(id)) return notFound();

    const artifact = await getDryRunArtifact(client, { id, tenantRef });
    if (!artifact) return notFound();

    return Response.json({ artifact }, { headers: NO_STORE });
  },
);

export const GET = guardedRead(
  DATA_SURFACES.restoreDryRunArtifactApi,
  getDryRunArtifactRoute,
);
