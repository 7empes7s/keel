import { listCompletionItems, summarizeCompletion } from "../../../../../../../engine/restore/completion.mjs";

import { guarded } from "@/lib/action";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Roadmap task-65: the completion items an enforced restore left open, grouped by
// resource with its configuration-restored / service-validation-pending /
// verified-complete state. Read-only and tenant-scoped; items hold metadata and
// evidence references only, never a secret.
const getCompletionRoute = guarded(
  { action: "restore:completion-show", capability: "read" },
  async ({ client, tenantRef, request }) => {
    const ref = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
    if (!REF_PATTERN.test(ref)) {
      return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    }
    const items = await listCompletionItems(client, { tenantRef, restoreRef: ref });
    return Response.json({ restoreRef: ref, resources: summarizeCompletion(items) }, { headers: NO_STORE });
  },
);

export const GET = guardedRead(DATA_SURFACES.restoreCompletionApi, getCompletionRoute);
