import { guardedAction } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// §3.3: baseline-activate requires approval by default, so this route never enqueues
// directly; task 14's approval_request path is how it becomes a job.
export const POST = guardedAction({
  action: "baseline-activate",
  capability: "baseline-create",
  jobKind: "baseline-activate",
  requiresApproval: true,
});
