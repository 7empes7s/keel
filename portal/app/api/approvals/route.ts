import {
  getApprovalInboxData,
  guardedApprovalInbox,
} from "@/lib/approval-inbox";
import { splitWaiting } from "@/lib/approval-view";
import { PRINCIPAL_ID_HEADER } from "@/lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The inbox deliberately declares approve rather than read: a pure approver must be
// able to review and decide requests without gaining the rest of the portal's data.
// `waitingForYou` is the menu's count: what this viewer can decide, without the
// requests they already signed, or asked for while approvals need two people.
export const GET = guardedApprovalInbox(async (request, scope) => {
  const data = await getApprovalInboxData(scope);
  const viewerId = request.headers.get(PRINCIPAL_ID_HEADER);
  const waitingForYou = splitWaiting([...data.pending, ...data.awaitingContentEffects], viewerId, data.approvalMode).forYou.length;
  return Response.json({ ...data, waitingForYou }, {
    headers: { "cache-control": "no-store" },
  });
});
