import { guardedAction } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Live gate #148 (Q43): put a superseded baseline version back. It is an activation
// (a new latest version holding the superseded version's resources is activated), so it
// takes the same capability and the same approval as /api/actions/baseline/activate and
// mints the same job kind. Body: { baselineId, version?, reason?, justification? }.
export const POST = guardedAction({
  action: "baseline-reinstate",
  jobKind: "baseline-activate",
  requiresApproval: true,
});
