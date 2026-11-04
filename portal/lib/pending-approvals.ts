import { cache } from "react";

import { getPendingApprovalCount } from "@/lib/approval-inbox";
import type { EntityScope } from "@/lib/principal";

// The menu (app/layout.tsx) and the Overview (app/page.tsx) both show how many requests
// wait on this approver. React's request cache makes them share one read per page load
// instead of counting twice. The key is the scope as text, because each caller builds
// its own scope object from the request headers.
const countFor = cache((scopeKey: string, viewerId: string | null) =>
  getPendingApprovalCount(JSON.parse(scopeKey) as EntityScope, viewerId));

/** The number of requests `viewerId` can decide in `scope`, read once per request. */
export function pendingApprovalCount(scope: EntityScope, viewerId: string | null): Promise<number> {
  return countFor(JSON.stringify(scope), viewerId);
}
