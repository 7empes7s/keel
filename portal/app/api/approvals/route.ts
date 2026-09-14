import {
  getApprovalInboxData,
  guardedApprovalInbox,
} from "@/lib/approval-inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The inbox deliberately declares approve rather than read: a pure approver must be
// able to review and decide requests without gaining the rest of the portal's data.
export const GET = guardedApprovalInbox(async () =>
  Response.json(await getApprovalInboxData(), {
    headers: { "cache-control": "no-store" },
  }),
);
