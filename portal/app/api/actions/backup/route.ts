import { guardedAction } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = guardedAction({
  action: "backup",
  capability: "backup",
  jobKind: "backup",
  requiresApproval: false,
});
