import { guardedAction } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Takes only the tier. Config paths are never read from the request: the job always
// runs on the server's own tenant config (issue #411).
export const POST = guardedAction({
  action: "backup",
  jobKind: "backup",
  requiresApproval: false,
  allowedParams: ["tier"],
});
