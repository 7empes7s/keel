import { guardedAction } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = guardedAction({
  action: "collect",
  capability: "collect",
  jobKind: "collect",
  requiresApproval: false,
});
