import { guardedAction } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Run now on the Schedules page. Read-only for the tenant; the capability comes from
// engine/authz/jobCapabilities.mjs.
export const POST = guardedAction({
  action: "content-collect",
  jobKind: "content-collect",
  requiresApproval: false,
});
