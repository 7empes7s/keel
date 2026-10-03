import {
  CompletionAuthorizationError, CompletionEvidenceError, CompletionItemNotFoundError, completeItem, reopenItem,
} from "../../../../../../engine/restore/completion.mjs";

import { guarded, readActionParams } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;

// Roadmap task-65: close a completion item with linked evidence, or reopen it.
// The route checks the downstreamed restore capability; completeItem/reopenItem
// re-check the actor's CURRENT grants in the database, so a grant revoked after
// the page loaded still cannot close an item. Evidence is a reference only — a
// payload carrying any other field (such as a pasted secret) is refused, never stored.
export const POST = guarded(
  { action: "restore-completion", capability: "restore", recordAttempt: true },
  async ({ client, principalId, tenantRef, request }) => {
    const { itemId, action, evidence, reason } = await readActionParams(request);
    if (typeof itemId !== "string" || (action !== "complete" && action !== "reopen")) {
      return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
    }
    try {
      const result = action === "complete"
        ? await completeItem(client, { tenantRef, itemId, actorId: principalId, evidence })
        : await reopenItem(client, { tenantRef, itemId, actorId: principalId, reason });
      return Response.json(result, { headers: NO_STORE });
    } catch (error) {
      if (error instanceof CompletionAuthorizationError) {
        return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
      }
      if (error instanceof CompletionItemNotFoundError) {
        return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
      }
      if (error instanceof CompletionEvidenceError) {
        return Response.json({ error: "invalid_evidence", message: error.message }, { status: 400, headers: NO_STORE });
      }
      throw error;
    }
  },
);
