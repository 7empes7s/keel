import { guardedAction } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// §3.3: remediate requires approval by default.
export const POST = guardedAction({
  action: "remediate",
  jobKind: "remediate",
  requiresApproval: true,
});
