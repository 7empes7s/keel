import { guardedAction } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// §3.3: restore requires approval by default.
export const POST = guardedAction({
  action: "restore",
  capability: "restore",
  jobKind: "restore",
  requiresApproval: true,
});
