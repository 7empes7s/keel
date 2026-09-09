import { guardedAction } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = guardedAction({
  action: "baseline-create",
  capability: "baseline-create",
  jobKind: "baseline-create",
  requiresApproval: false,
});
