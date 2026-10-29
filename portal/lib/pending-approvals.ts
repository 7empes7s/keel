import { cache } from "react";

import { approvalInboxScope, getPendingApprovalCount } from "@/lib/approval-inbox";
import type { EntityScope } from "@/lib/principal";

type HeaderSource = Parameters<typeof approvalInboxScope>[0];

// The menu (app/layout.tsx) and the Overview both show how many requests wait on this
// approver. React's request cache makes them share one read per page load instead of
// counting twice. The key is the scope as text, because each caller builds its own
// scope object from the request headers.
const countForScope = cache((scopeKey: string) => getPendingApprovalCount(JSON.parse(scopeKey) as EntityScope));

/** The approver's waiting count, or null when the viewer is not an approver or the read fails. */
export async function pendingApprovalCountFor(requestHeaders: HeaderSource): Promise<number | null> {
  const scope = approvalInboxScope(requestHeaders);
  if (!scope) return null;
  try {
    return await countForScope(JSON.stringify(scope));
  } catch {
    return null;
  }
}
